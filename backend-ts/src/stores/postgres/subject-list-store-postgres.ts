/**
 * Postgres ceiling adapter for `SubjectListStore` (MM-2 PR 3, ADR-082).
 *
 * The import is a three-phase visible-state machine, not one transaction: a 50,000-member list is
 * not one statement on either backend, and the FLOOR cannot wrap the whole thing atomically anyway
 * (D1 caps a batch at ~90 statements and each slice commits on its own). Rather than give the two
 * backends different guarantees, both do the same thing — write the header `IMPORTING`, insert the
 * members in chunks, audit, then flip to `COMPLETE` — and every read filters `COMPLETE`. A crash at
 * any point therefore leaves an invisible partial row, never a short list masquerading as whole.
 *
 * The one thing that IS transactional here is the revision allocation, because that is the only part
 * with a real race: two imports of the same name reading `MAX(revision)` at the same moment would
 * both compute the same next number and one would lose to the unique constraint. The advisory lock is
 * `pg_advisory_xact_lock`, never the session-level form — Neon's pooled endpoint is PgBouncer in
 * transaction mode, where a session lock would be taken on one backend and released on another.
 */
import type { PgPool } from "./pg-database.ts";
import { isUuid } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
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

const S = SPIKE_SCHEMA;
const LIST_COLS = "id, name, revision, status, source, note, created_by, created_at, completed_at";
/** 500 rows x 4 binds = 2,000 parameters, comfortably under Postgres's 65,535 per statement. */
const MEMBER_CHUNK = 500;
const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

interface ListRow {
  id: string;
  name: string;
  revision: number;
  status: string;
  source: string | null;
  note: string | null;
  created_by: string;
  created_at: Date | string;
  completed_at: Date | string | null;
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
  createdAt: iso(r.created_at),
  completedAt: r.completed_at === null ? null : iso(r.completed_at),
});

const toMember = (r: MemberRow): SubjectListMember => ({
  rawIdentifier: r.raw_identifier,
  subjectId: r.subject_id,
  resolution: r.resolution as SubjectListResolution,
});

const emptyCounts = (): MemberCounts => ({ MATCHED: 0, NOT_FOUND: 0, AMBIGUOUS: 0 });

/** Postgres's unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;

export class PgSubjectListStore implements SubjectListStore {
  constructor(private readonly pool: PgPool) {}

  async createList(input: CreateSubjectListInput): Promise<SubjectList> {
    let header: SubjectList;
    try {
      header = await this.insertHeader(input);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost the race despite the lock — possible if a previous release inserted without it, or if a
      // caller supplied a duplicate id. Recompute once; a second failure is a real conflict.
      try {
        header = await this.insertHeader(input);
      } catch (retryErr) {
        if (!isUniqueViolation(retryErr)) throw retryErr;
        const { rows } = await this.pool.query<{ revision: number }>(
          `SELECT COALESCE(MAX(revision), 0) AS revision FROM ${S}.subject_lists WHERE name = $1`,
          [input.name],
        );
        throw new SubjectListRevisionConflictError(input.name, Number(rows[0]?.revision ?? 0));
      }
    }

    for (let start = 0; start < input.members.length; start += MEMBER_CHUNK) {
      const chunk = input.members.slice(start, start + MEMBER_CHUNK);
      const binds: unknown[] = [];
      const tuples = chunk.map((m) => {
        const o = binds.length;
        binds.push(header.id, m.rawIdentifier, m.subjectId, m.resolution);
        return `($${o + 1}::uuid, $${o + 2}, $${o + 3}, $${o + 4})`;
      });
      await this.pool.query(
        `INSERT INTO ${S}.subject_list_members (list_id, raw_identifier, subject_id, resolution) VALUES ${tuples.join(", ")}`,
        binds,
      );
    }

    // Audit BEFORE the list becomes visible (case-actions.ts's ordering). A throw here leaves the
    // import invisible and unapplied, which is the survivable direction.
    if (input.beforeComplete) await input.beforeComplete(header);

    const { rows } = await this.pool.query<ListRow>(
      `UPDATE ${S}.subject_lists SET status = 'COMPLETE', completed_at = $2::timestamptz WHERE id = $1::uuid RETURNING ${LIST_COLS}`,
      [header.id, input.now],
    );
    return toList(rows[0]!);
  }

  private async insertHeader(input: CreateSubjectListInput): Promise<SubjectList> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialises concurrent imports of the SAME name only; two different lists never wait on each
      // other. Lowercased so "ACO Q3" and "aco q3" cannot allocate the same revision in parallel.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext(lower($1))::bigint)`, [input.name]);
      const { rows: maxRows } = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM ${S}.subject_lists WHERE name = $1`,
        [input.name],
      );
      const revision = Number(maxRows[0]?.next ?? 1);
      const { rows } = await client.query<ListRow>(
        `INSERT INTO ${S}.subject_lists (id, name, revision, status, source, note, created_by, created_at, completed_at)
         VALUES ($1::uuid, $2, $3, 'IMPORTING', $4, $5, $6, $7::timestamptz, NULL)
         RETURNING ${LIST_COLS}`,
        [input.id, input.name, revision, input.source, input.note, input.createdBy, input.now],
      );
      await client.query("COMMIT");
      return toList(rows[0]!);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async getList(id: string): Promise<SubjectList | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query<ListRow>(
      `SELECT ${LIST_COLS} FROM ${S}.subject_lists WHERE id = $1::uuid AND status = 'COMPLETE'`,
      [id],
    );
    return rows[0] ? toList(rows[0]) : null;
  }

  async listLists(options?: ListListsOptions): Promise<SubjectList[]> {
    const where = options?.includeIncomplete ? "" : `WHERE status = 'COMPLETE'`;
    const { rows } = await this.pool.query<ListRow>(
      `SELECT ${LIST_COLS} FROM ${S}.subject_lists ${where} ORDER BY created_at DESC, revision DESC`,
    );
    return rows.map(toList);
  }

  async countMembers(listIds: readonly string[]): Promise<Map<string, MemberCounts>> {
    const ids = listIds.filter(isUuid);
    const out = new Map<string, MemberCounts>();
    if (ids.length === 0) return out;
    // Joined to the header, like every other read here. The route reaches this only through lists it
    // already resolved, but "safe because every caller checks first" is a claim about callers rather
    // than about the store, and the interface's own header says every read filters COMPLETE.
    const { rows } = await this.pool.query<{ list_id: string; resolution: string; n: string }>(
      `SELECT m.list_id, m.resolution, COUNT(*) AS n FROM ${S}.subject_list_members m
       JOIN ${S}.subject_lists l ON l.id = m.list_id AND l.status = 'COMPLETE'
       WHERE m.list_id = ANY($1::uuid[]) GROUP BY m.list_id, m.resolution`,
      [ids],
    );
    for (const r of rows) {
      const counts = out.get(r.list_id) ?? emptyCounts();
      counts[r.resolution as SubjectListResolution] = Number(r.n);
      out.set(r.list_id, counts);
    }
    return out;
  }

  async listMembers(listId: string, options: ListMembersOptions): Promise<MemberPage> {
    if (!isUuid(listId)) return { members: [], total: 0 };
    const binds: unknown[] = [listId];
    let filter = "";
    if (options.resolution) {
      binds.push(options.resolution);
      filter = ` AND m.resolution = $${binds.length}`;
    }
    const complete = `JOIN ${S}.subject_lists l ON l.id = m.list_id AND l.status = 'COMPLETE'`;
    const { rows: countRows } = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ${S}.subject_list_members m ${complete} WHERE m.list_id = $1::uuid${filter}`,
      binds,
    );
    const { rows } = await this.pool.query<MemberRow>(
      `SELECT m.raw_identifier, m.subject_id, m.resolution FROM ${S}.subject_list_members m ${complete}
       WHERE m.list_id = $1::uuid${filter}
       ORDER BY m.raw_identifier ASC
       LIMIT $${binds.length + 1} OFFSET $${binds.length + 2}`,
      [...binds, options.limit, options.offset],
    );
    return { members: rows.map(toMember), total: Number(countRows[0]?.n ?? 0) };
  }

  async matchedSubjectIds(listId: string): Promise<string[]> {
    if (!isUuid(listId)) return [];
    // Joined to the header so an in-flight import answers empty rather than partially — the same rule
    // getList applies, enforced here too because this is the read the filters actually use.
    const { rows } = await this.pool.query<{ subject_id: string }>(
      `SELECT m.subject_id FROM ${S}.subject_list_members m
       JOIN ${S}.subject_lists l ON l.id = m.list_id AND l.status = 'COMPLETE'
       WHERE m.list_id = $1::uuid AND m.resolution = 'MATCHED'`,
      [listId],
    );
    return rows.map((r) => r.subject_id);
  }
}
