/**
 * Licensed terminology comes from the stack's private bucket at boot, never from the image (D17).
 *
 * The `terminology.json` sidecars carry licensed AMA CPT and SNOMED CT codes. They were vendored at
 * deploy and COPIED INTO THE IMAGE, and the image package is anonymously pullable, so every deploy
 * republished them. The deploy now uploads each sidecar to its stack's evidence bucket under
 * `terminology/<sha256>.json` and builds the image without it; this fetches the routed measures' sidecars
 * back before the host starts listening.
 *
 * It decides nothing. A fetched file is written where `loadOfficialTerminology` already reads, and that
 * function's SHA-256 check against the committed manifest stays the only judge. A sidecar that cannot be
 * fetched stays absent, which the boot routing check already reports (`/health` problems, every
 * evaluating route refused), so a failed fetch can never score with missing codes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudBucket } from "@mieweb/cloud";
import { loadDerivedManifest, loadOfficialManifest, type OfficialManifest } from "./official-artifacts.ts";
import { derivedMeasureIds, officialMeasureIds } from "./official-routing.ts";
import { officialRoutingProblems } from "./executor-router.ts";
import { recordRoutingHealth, recordTerminologyHealth } from "../admin/runtime-health.ts";

/** The bucket folder, shared with the deploy step that uploads (`.github/workflows/deploy-*.yml`). */
export const TERMINOLOGY_PREFIX = "terminology/";

const VALID_CATALOG_ID = /^[a-z0-9]+$/;
const PIN = /^sha256:([0-9a-f]{64})$/;

export interface SidecarTarget {
  kind: "official" | "derived";
  catalogId: string;
  /** The committed pin, `sha256:<hex>`. */
  sha256: string;
  /** Where `loadOfficialTerminology` reads it. */
  path: string;
  /**
   * A routed measure's sidecar: without it the router refuses, so a miss is an alert. The others feed only
   * the fidelity diff's literal tier, whose absence it already shows (`mode`), so a miss is a note.
   */
  required: boolean;
}

export interface FetchDeps {
  bucket: () => Promise<Pick<CloudBucket, "get">>;
  exists: (path: string) => boolean;
  read: (path: string) => string;
  write: (path: string, text: string) => void;
  /** Strips anything secret from an error message before it is logged. */
  redact?: (text: string) => string;
}

export type FailureKind = "bucketUnavailable" | "notInBucket" | "hashMismatch" | "timedOut" | "readFailed";

export interface FetchReport {
  present: string[];
  fetched: string[];
  /** Misses of required sidecars. */
  problems: string[];
  /** Misses of the others. */
  notes: string[];
  /** Every miss by kind, required or not: what `/health` publishes (counts only). */
  failures: Record<FailureKind, number>;
  durationMs: number;
}

/** Sidecars fetched at once, and how long one may take: a slow first connection must not serialise them all. */
export const FETCH_CONCURRENCY = 4;
export const PER_OBJECT_TIMEOUT_MS = 30_000;

const sha256Of = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/**
 * The sidecars a boot fetches: every vendored CMS artifact's (the image held them all, and the fidelity
 * diff's literal tier reads unrouted ones too), required for a routed measure; and each routed
 * translation's, required. An unrouted translation is never scored, so it is not fetched.
 */
export function bootSidecars(
  env: Record<string, unknown>,
  manifests: { official: (id: string) => OfficialManifest | null; derived: (id: string) => OfficialManifest | null } = {
    official: loadOfficialManifest,
    derived: loadDerivedManifest,
  },
  measuresRoot: URL = new URL("../../measures/", import.meta.url),
  vendoredOfficialIds: () => string[] = () => listDirs(new URL("official/", measuresRoot)),
): SidecarTarget[] {
  const routed = officialMeasureIds(env);
  const derived = derivedMeasureIds(env);
  const targets: SidecarTarget[] = [];
  const add = (kind: "official" | "derived", catalogId: string, required: boolean) => {
    if (!VALID_CATALOG_ID.test(catalogId)) return;
    const pin = manifests[kind](catalogId)?.terminology as { file?: string; sha256?: string } | undefined;
    // An unpinned or unreadable manifest is the routing check's to report; nothing here can be verified.
    if (!pin?.sha256 || !PIN.test(pin.sha256)) return;
    const file = pin.file && /^[a-z0-9.-]+$/i.test(pin.file) ? pin.file : "terminology.json";
    targets.push({ kind, catalogId, sha256: pin.sha256, path: fileURLToPath(new URL(`${kind}/${catalogId}/${file}`, measuresRoot)), required });
  };
  for (const catalogId of [...new Set([...vendoredOfficialIds(), ...routed])].sort()) {
    add("official", catalogId, routed.has(catalogId));
    if (routed.has(catalogId) && derived.has(catalogId)) add("derived", catalogId, true);
  }
  return targets;
}

function listDirs(root: URL): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Fetch each target whose file is absent (or does not match its pin) from the bucket, keeping only bytes
 * that hash to the pin. Never throws: each failure becomes a sentence in `problems` (required) or `notes`.
 * A few at a time, each bounded, so one slow object cannot hold back the rest.
 */
export async function fetchSidecars(
  targets: readonly SidecarTarget[],
  deps: FetchDeps,
  opts: { concurrency?: number; perObjectTimeoutMs?: number; now?: () => number } = {},
): Promise<FetchReport> {
  const now = opts.now ?? Date.now;
  const started = now();
  const report: FetchReport = {
    present: [],
    fetched: [],
    problems: [],
    notes: [],
    failures: { bucketUnavailable: 0, notInBucket: 0, hashMismatch: 0, timedOut: 0, readFailed: 0 },
    durationMs: 0,
  };
  const miss = (target: SidecarTarget, kind: FailureKind, text: string) => {
    report.failures[kind] += 1;
    (target.required ? report.problems : report.notes).push(`${label(target)}: ${text}`);
  };
  const redact = deps.redact ?? ((text: string) => text);
  const message = (err: unknown): string => redact((err instanceof Error ? err.message : String(err)).split("\n")[0]!);
  const missing = targets.filter((t) => !(deps.exists(t.path) && sha256Of(deps.read(t.path)) === t.sha256));
  report.present = targets.filter((t) => !missing.includes(t)).map(label);
  const done = () => {
    report.durationMs = now() - started;
    return report;
  };
  if (missing.length === 0) return done();

  let bucket: Pick<CloudBucket, "get">;
  try {
    bucket = await deps.bucket();
  } catch (err) {
    const why = `the terminology bucket could not be opened: ${message(err)}`;
    for (const target of missing) miss(target, "bucketUnavailable", why);
    return done();
  }
  const timeoutMs = opts.perObjectTimeoutMs ?? PER_OBJECT_TIMEOUT_MS;
  const fetchOne = async (target: SidecarTarget) => {
    const key = `${TERMINOLOGY_PREFIX}${PIN.exec(target.sha256)![1]}.json`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
    });
    try {
      const read = (async () => {
        const object = await bucket.get(key);
        return object ? Buffer.from(await object.arrayBuffer()).toString("utf8") : null;
      })();
      const text = await Promise.race([read, timedOut]);
      if (text === "timeout") {
        miss(target, "timedOut", `${key} did not arrive within ${timeoutMs} ms`);
        return;
      }
      if (text === null) {
        miss(target, "notInBucket", `${key} is not in the bucket`);
        return;
      }
      if (sha256Of(text) !== target.sha256) {
        miss(target, "hashMismatch", `${key} does not hash to the committed pin`);
        return;
      }
      deps.write(target.path, text);
      report.fetched.push(label(target));
    } catch (err) {
      miss(target, "readFailed", `${key} could not be read: ${message(err)}`);
    } finally {
      clearTimeout(timer);
    }
  };
  const queue = [...missing];
  const workers = Array.from({ length: Math.min(opts.concurrency ?? FETCH_CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await fetchOne(next);
  });
  await Promise.all(workers);
  return done();
}

/** What `/health` may publish about a fetch: counts and timings, never a key or an error text. */
export function terminologyHealthOf(targets: readonly SidecarTarget[], report: FetchReport | null, finished: boolean) {
  const required = targets.filter((t) => t.required);
  const have = new Set([...(report?.present ?? []), ...(report?.fetched ?? [])]);
  return {
    finished,
    durationMs: report?.durationMs ?? 0,
    required: required.length,
    fetched: report?.fetched.length ?? 0,
    alreadyPresent: report?.present.length ?? 0,
    missingRequired: required.filter((t) => !have.has(label(t))).length,
    missingOptional: targets.filter((t) => !t.required && !have.has(label(t))).length,
    failures: { ...(report?.failures ?? { bucketUnavailable: 0, notInBucket: 0, hashMismatch: 0, timedOut: 0, readFailed: 0 }) },
  };
}

const label = (t: SidecarTarget): string => `${t.kind}/${t.catalogId}`;
const hostOf = (endpoint: string): string => {
  try {
    return new URL(endpoint).host || endpoint;
  } catch {
    return endpoint;
  }
};

/** The real file-system and bucket for the boot fetch. The bucket is the stack's evidence bucket. */
export function bootFetchDeps(env: Record<string, string | undefined>): FetchDeps | null {
  const v = (name: string) => (env[name] ?? "").trim();
  const bucket = v("WORKWELL_BUCKET_S3_BUCKET");
  const accessKeyId = v("WORKWELL_BUCKET_S3_ACCESS_KEY_ID");
  const secretAccessKey = v("WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY");
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const endpoint = v("WORKWELL_BUCKET_S3_ENDPOINT");
  return {
    bucket: async () => {
      // Lazily, as `resolve-bucket.ts` does: the package registers drivers on import.
      const { createS3Bucket } = await import("@mieweb/cloud-os");
      return createS3Bucket({
        bucket,
        region: v("WORKWELL_BUCKET_S3_REGION") || "us-east-1",
        endpoint: endpoint || undefined,
        accessKeyId,
        secretAccessKey,
        forcePathStyle: Boolean(endpoint),
        createIfMissing: false,
      });
    },
    exists: existsSync,
    read: (path) => readFileSync(path, "utf8"),
    // Atomic: a request that reads the file while the fetch is still writing it (after the boot bound gave
    // up waiting) sees the whole file or none, never half of one.
    write: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      const partial = `${path}.${process.pid}.partial`;
      writeFileSync(partial, text);
      renameSync(partial, path);
    },
    // An SDK error quotes the host it failed to reach, and the R2 host embeds the account id.
    redact: (text) => (endpoint ? text.split(endpoint).join("<endpoint>").split(hostOf(endpoint)).join("<endpoint>") : text),
  };
}

export interface BootHooks {
  record: (health: ReturnType<typeof terminologyHealthOf>) => void;
  /** Re-runs the routing check and records it, so a fetch that finished after the first request is not left reported as a refusal. */
  refreshRouting: (env: Record<string, unknown>) => number;
}

const defaultHooks: BootHooks = {
  record: (health) => recordTerminologyHealth(health),
  refreshRouting: (env) => {
    const problems = officialRoutingProblems(env as never).length;
    recordRoutingHealth({ official: [...officialMeasureIds(env)], derived: [...derivedMeasureIds(env)], problems });
    return problems;
  },
};

/**
 * The boot step (`server.ts`, before the host listens; it bounds the wait, and this keeps running past
 * that bound). Records its progress on `/health` (counts only), logs what it did, raises a WORKWELL_ALERT
 * for a required sidecar it could not fetch, and re-records the routing check when it finishes, so the
 * routing `/health` reports is the one the files on disk now support.
 */
export async function fetchRoutedTerminologyAtBoot(
  env: Record<string, string | undefined> = process.env,
  hooks: BootHooks = defaultHooks,
  deps: FetchDeps | null = bootFetchDeps(env),
): Promise<FetchReport | null> {
  const targets = bootSidecars(env);
  if (targets.length === 0) return null;
  if (!deps) {
    // No bucket configured (local development, tests): the files are where `pnpm vendor:official` put them.
    return null;
  }
  hooks.record(terminologyHealthOf(targets, null, false));
  const report = await fetchSidecars(targets, deps);
  hooks.record(terminologyHealthOf(targets, report, true));
  console.log(
    `[workwell] terminology fetch finished in ${report.durationMs}ms: ${report.fetched.length} fetched, ` +
      `${report.present.length} already present, ${report.problems.length} required missing`,
  );
  if (report.notes.length > 0) console.log(`[workwell] terminology not fetched (not routed here): ${report.notes.join("; ")}`);
  if (report.problems.length > 0) {
    console.error(`WORKWELL_ALERT ${JSON.stringify({ kind: "TERMINOLOGY_FETCH_FAILED", problems: report.problems })}`);
  }
  const routingProblems = hooks.refreshRouting(env);
  console.log(`[workwell] routing re-checked after the terminology fetch: ${routingProblems} problem(s)`);
  return report;
}
