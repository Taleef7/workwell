/**
 * Evidence-bucket reachability probe (#473 follow-on).
 *
 * The bucket seam (`resolve-bucket.ts`, ADR-030) is inert-unless-configured, and when it IS
 * configured it is selected at construction and only exercised on the first evidence operation.
 * That made a whole class of outage silent: on 2026-08-24 the hosting AWS account lapsed, every
 * `WORKWELL_BUCKET_S3_*` credential stopped authenticating, and the TWH stack went on booting
 * clean, logging `bucket-s3=on` and serving `/actuator/health` 200 for eighteen days while every
 * evidence write failed. The nightly backup job noticed on night one because it opens a real
 * connection and raises an issue; the app had no equivalent, so nobody looked.
 *
 * This is the app's equivalent, and it is deliberately the CHEAPEST possible one: a single `get` of
 * a key that is not expected to exist. A missing object is a successful round trip — it proves
 * credentials, network, region/endpoint and bucket name all resolve — so the probe needs no write
 * permission, creates nothing, and cannot pollute the bucket. Only a THROW means unreachable.
 *
 * Descriptive only (ADR-008 n/a): this never selects a backend, never changes evidence behaviour,
 * and never fails a request. It reports.
 */
import type { CloudBucket } from "@mieweb/cloud";
import { isS3BucketConfigured, resolveBucket, type BucketEnv } from "./resolve-bucket.ts";

/** The env the probe needs — the seam vars plus the injected binding, i.e. exactly `BucketEnv`. */
export type BucketEnvForProbe = BucketEnv;

/**
 * A key chosen to be absent. It is read, never written; the `.probe` suffix keeps it out of the
 * `evidence/` prefix any lifecycle rule or IAM policy is written against.
 */
export const BUCKET_PROBE_KEY = ".workwell-reachability-probe";

export type BucketProbeResult =
  /** The seam is off — the injected binding serves, and there is nothing to probe. */
  | { kind: "not-configured" }
  /** A round trip completed. `found` says whether the probe key happened to exist; either proves reach. */
  | { kind: "reachable"; found: boolean }
  /** The round trip threw. `message` is the adapter's, trimmed for a log line. */
  | { kind: "unreachable"; bucket: string; endpoint?: string; message: string };

/** Keep an adapter's error legible on one log line without leaking a multi-KB SDK dump. */
function briefly(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 297)}...` : oneLine;
}

/**
 * Probes the configured evidence bucket. Never throws — every failure path is a returned result,
 * because the only caller is a boot hook on the request path and an alerting probe that can itself
 * take down a request would be worse than the silence it exists to fix.
 */
export async function probeEvidenceBucket(
  env: BucketEnv,
  resolve: (env: BucketEnv) => Promise<CloudBucket> = resolveBucket,
): Promise<BucketProbeResult> {
  if (!isS3BucketConfigured(env)) return { kind: "not-configured" };
  const bucket = (env.WORKWELL_BUCKET_S3_BUCKET ?? "").trim();
  const endpoint = (env.WORKWELL_BUCKET_S3_ENDPOINT ?? "").trim() || undefined;
  try {
    const object = await resolve(env).then((b) => b.get(BUCKET_PROBE_KEY));
    return { kind: "reachable", found: object !== null && object !== undefined };
  } catch (err) {
    return { kind: "unreachable", bucket, endpoint, message: briefly(err) };
  }
}

/**
 * The operator-facing line for an unreachable bucket, in the `WORKWELL_ALERT {json}` shape the
 * official-routing boot check already uses — one greppable token, machine-readable payload.
 */
export function bucketAlertLine(result: BucketProbeResult): string | null {
  if (result.kind !== "unreachable") return null;
  return `WORKWELL_ALERT ${JSON.stringify({
    kind: "EVIDENCE_BUCKET_UNREACHABLE",
    bucket: result.bucket,
    ...(result.endpoint ? { endpoint: result.endpoint } : {}),
    message: result.message,
    consequence: "every evidence upload and download is failing; the seam is configured, so there is no fallback",
  })}`;
}
