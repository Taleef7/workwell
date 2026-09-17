/**
 * SQLite floor adapter for `SubjectListStore` (MM-2 PR 3, ADR-082).
 *
 * The same three-phase visible-state machine as the ceiling — header `IMPORTING`, members in chunks,
 * audit, flip to `COMPLETE` — because the floor cannot give a stronger guarantee and the two backends
 * must not differ in what a crash leaves behind. D1 caps a `batch()` at ~90 statements, so "the whole
 * import in one transaction" was never available here; rather than let the ceiling quietly be safer,
 * both rely on the flip, and every read filters `COMPLETE`.
 *
 * The revision is allocated by a single `INSERT ... SELECT MAX(revision) + 1` statement, which SQLite
 * evaluates atomically, with one retry on the unique violation. That is the floor's equivalent of the
 * ceiling's advisory lock: the same outcome (consecutive revisions, never a silent overwrite) by the
 * mechanism each backend actually has.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type {
  CreateSubjectListInput,
  ListListsOptions,
  ListMembersOptions,
  MemberCounts,
  MemberPage,
  SubjectList,
  SubjectListMember,
  SubjectListResolution,
  SubjectListStore,
} from "../subject-list-store.ts";
import { SubjectListRevisionConflictError } from "../subject-list-store.ts";

const LIST_COLS = "id, name, revision, status, source, note, created_by, created_at, completed_at";
/** 200 rows x 4 binds = 800 parameters, under SQLite's 999-variable default. */
const MEMBER_CHUNK = 200;

interface ListRow {
  id: string;
  name: string;
  revision: number;
  status: string;
  source: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
  completed_at: string | null;
}

interface MemberRow {
  raw_identifier: string;
  subject_id: string | null;
  resolution: string;
}

const toList = (r: ListRow): SubjectList => ({
  id: r.id,
  name: r.name,
  revision: Number(r.revision),
  status: r.status as SubjectList["status"],
  source: r.source,
  note: r.note,
  createdBy: r.created_by,
  createdAt: r.created_at,
  completedAt: r.completed_at,
});

const toMember = (r: MemberRow): SubjectListMember => ({
  rawIdentifier: r.raw_identifier,
  subjectId: r.subject_id,
  resolution: r.resolution as SubjectListResolution,
});

const emptyCounts = (): MemberCounts => ({ MATCHED: 0, NOT_FOUND: 0, AMBIGUOUS: 0 });

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

export class SqliteSubjectListStore implements SubjectListStore {
  constructor(private readonly db: CloudDatabase) {}

  async createList(input: CreateSubjectListInput): Promise<SubjectList> {
    let header: SubjectList;
    try {
      header = await this.insertHeader(input);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      try {
        header = await this.insertHeader(input);
      } catch (retryErr) {
        if (!isUniqueViolation(retryErr)) throw retryErr;
        const { results } = await this.db
          .prepare(`SELECT COALESCE(MAX(revision), 0) AS revision FROM subject_lists WHERE name = ?`)
          .bind(input.name)
          .all<{ revision: number }>();
        throw new SubjectListRevisionConflictError(input.name, Number((results ?? [])[0]?.revision ?? 0));
      }
    }

    for (let start = 0; start < input.members.length; start += MEMBER_CHUNK) {
      const chunk = input.members.slice(start, start + MEMBER_CHUNK);
      const binds: unknown[] = [];
      for (const m of chunk) binds.push(header.id, m.rawIdentifier, m.subjectId, m.resolution);
      const tuples = chunk.map(() => "(?, ?, ?, ?)").join(", ");
      await this.db
        .prepare(`INSERT INTO subject_list_members (list_id, raw_identifier, subject_id, resolution) VALUES ${tuples}`)
        .bind(...binds)
        .run();
    }

    if (input.beforeComplete) await input.beforeComplete(header);

    await this.db
      .prepare(`UPDATE subject_lists SET status = 'COMPLETE', completed_at = ? WHERE id = ?`)
      .bind(input.now, header.id)
      .run();
    const stored = await this.getList(header.id);
    return stored!;
  }

  private async insertHeader(input: CreateSubjectListInput): Promise<SubjectList> {
    // One statement, so MAX() and the INSERT cannot be interleaved by another writer.
    await this.db
      .prepare(
        `INSERT INTO subject_lists (id, name, revision, status, source, note, created_by, created_at, completed_at)
         SELECT ?, ?, COALESCE(MAX(revision), 0) + 1, 'IMPORTING', ?, ?, ?, ?, NULL
         FROM subject_lists WHERE name = ?`,
      )
      .bind(input.id, input.name, input.source, input.note, input.createdBy, input.now, input.name)
      .run();
    const { results } = await this.db
      .prepare(`SELECT ${LIST_COLS} FROM subject_lists WHERE id = ?`)
      .bind(input.id)
      .all<ListRow>();
    const row = (results ?? [])[0];
    if (!row) throw new Error(`subject list header ${input.id} was not written`);
    return toList(row);
  }

  async getList(id: string): Promise<SubjectList | null> {
    const { results } = await this.db
      .prepare(`SELECT ${LIST_COLS} FROM subject_lists WHERE id = ? AND status = 'COMPLETE'`)
      .bind(id)
      .all<ListRow>();
    const row = (results ?? [])[0];
    return row ? toList(row) : null;
  }

  async listLists(options?: ListListsOptions): Promise<SubjectList[]> {
    const where = options?.includeIncomplete ? "" : `WHERE status = 'COMPLETE'`;
    const { results } = await this.db
      .prepare(`SELECT ${LIST_COLS} FROM subject_lists ${where} ORDER BY created_at DESC, revision DESC`)
      .all<ListRow>();
    return (results ?? []).map(toList);
  }

  async countMembers(listIds: readonly string[]): Promise<Map<string, MemberCounts>> {
    const out = new Map<string, MemberCounts>();
    if (listIds.length === 0) return out;
    const placeholders = listIds.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(
        `SELECT m.list_id AS list_id, m.resolution AS resolution, COUNT(*) AS n FROM subject_list_members m
         JOIN subject_lists l ON l.id = m.list_id AND l.status = 'COMPLETE'
         WHERE m.list_id IN (${placeholders}) GROUP BY m.list_id, m.resolution`,
      )
      .bind(...listIds)
      .all<{ list_id: string; resolution: string; n: number }>();
    for (const r of results ?? []) {
      const counts = out.get(r.list_id) ?? emptyCounts();
      counts[r.resolution as SubjectListResolution] = Number(r.n);
      out.set(r.list_id, counts);
    }
    return out;
  }

  async listMembers(listId: string, options: ListMembersOptions): Promise<MemberPage> {
    const binds: unknown[] = [listId];
    let filter = "";
    if (options.resolution) {
      filter = ` AND m.resolution = ?`;
      binds.push(options.resolution);
    }
    // Joined to the header, like every other read here — the interface says every read filters
    // COMPLETE, and "safe because every caller checks first" is a claim about callers.
    const complete = `JOIN subject_lists l ON l.id = m.list_id AND l.status = 'COMPLETE'`;
    const { results: countRows } = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM subject_list_members m ${complete} WHERE m.list_id = ?${filter}`)
      .bind(...binds)
      .all<{ n: number }>();
    const { results } = await this.db
      .prepare(
        `SELECT m.raw_identifier AS raw_identifier, m.subject_id AS subject_id, m.resolution AS resolution
         FROM subject_list_members m ${complete}
         WHERE m.list_id = ?${filter} ORDER BY m.raw_identifier ASC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, options.limit, options.offset)
      .all<MemberRow>();
    return { members: (results ?? []).map(toMember), total: Number((countRows ?? [])[0]?.n ?? 0) };
  }

  async matchedSubjectIds(listId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT m.subject_id AS subject_id FROM subject_list_members m
         JOIN subject_lists l ON l.id = m.list_id AND l.status = 'COMPLETE'
         WHERE m.list_id = ? AND m.resolution = 'MATCHED'`,
      )
      .bind(listId)
      .all<{ subject_id: string }>();
    return (results ?? []).map((r) => r.subject_id);
  }
}
