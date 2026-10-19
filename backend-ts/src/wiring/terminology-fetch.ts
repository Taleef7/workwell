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

export interface FetchReport {
  present: string[];
  fetched: string[];
  /** Misses of required sidecars. */
  problems: string[];
  /** Misses of the others. */
  notes: string[];
}

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
 * that hash to the pin. Never throws: each failure becomes a sentence in `problems`.
 */
export async function fetchSidecars(targets: readonly SidecarTarget[], deps: FetchDeps): Promise<FetchReport> {
  const report: FetchReport = { present: [], fetched: [], problems: [], notes: [] };
  const miss = (target: SidecarTarget, text: string) => (target.required ? report.problems : report.notes).push(`${label(target)}: ${text}`);
  const redact = deps.redact ?? ((text: string) => text);
  const message = (err: unknown): string => redact((err instanceof Error ? err.message : String(err)).split("\n")[0]!);
  const missing = targets.filter((t) => !(deps.exists(t.path) && sha256Of(deps.read(t.path)) === t.sha256));
  report.present = targets.filter((t) => !missing.includes(t)).map(label);
  if (missing.length === 0) return report;

  let bucket: Pick<CloudBucket, "get">;
  try {
    bucket = await deps.bucket();
  } catch (err) {
    const why = `the terminology bucket could not be opened: ${message(err)}`;
    if (missing.some((t) => t.required)) report.problems.push(why);
    else report.notes.push(why);
    return report;
  }
  for (const target of missing) {
    const key = `${TERMINOLOGY_PREFIX}${PIN.exec(target.sha256)![1]}.json`;
    try {
      const object = await bucket.get(key);
      if (!object) {
        miss(target, `${key} is not in the bucket`);
        continue;
      }
      const text = Buffer.from(await object.arrayBuffer()).toString("utf8");
      if (sha256Of(text) !== target.sha256) {
        miss(target, `${key} does not hash to the committed pin`);
        continue;
      }
      deps.write(target.path, text);
      report.fetched.push(label(target));
    } catch (err) {
      miss(target, `${key} could not be read: ${message(err)}`);
    }
  }
  return report;
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

/**
 * The boot step (`server.ts`, before the host listens). Logs what it did; a problem is a WORKWELL_ALERT
 * line, and the boot routing check then reports the measure on `/health` as it reports any missing file.
 */
export async function fetchRoutedTerminologyAtBoot(env: Record<string, string | undefined> = process.env): Promise<FetchReport | null> {
  const targets = bootSidecars(env);
  if (targets.length === 0) return null;
  const deps = bootFetchDeps(env);
  if (!deps) {
    // No bucket configured (local development, tests): the files are where `pnpm vendor:official` put them.
    return null;
  }
  const report = await fetchSidecars(targets, deps);
  if (report.fetched.length > 0) console.log(`[workwell] terminology fetched from the bucket: ${report.fetched.join(", ")}`);
  if (report.notes.length > 0) console.log(`[workwell] terminology not fetched (not routed here): ${report.notes.join("; ")}`);
  if (report.problems.length > 0) {
    console.error(`WORKWELL_ALERT ${JSON.stringify({ kind: "TERMINOLOGY_FETCH_FAILED", problems: report.problems })}`);
  }
  return report;
}
