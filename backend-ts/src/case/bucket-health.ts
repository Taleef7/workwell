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
 * This is the app's equivalent. It is read-only, creates nothing, and needs no write permission.
 *
 * **It LISTS rather than GETS, and that is the whole correctness of it.** The obvious probe —
 * `get` a key that should not exist, and treat the miss as a successful round trip — is wrong
 * here, and wrong in the exact way this module exists to prevent. The adapter swallows *any* 404
 * into `null` (`cloud-os/src/adapters/r2-s3.mjs`: `isNotFound` matches `httpStatusCode === 404`),
 * and **`NoSuchBucket` is a 404 on both S3 and R2**. So a misspelled bucket name would come back
 * as "reachable, object absent" — a control that is present, looks green, and cannot fire on the
 * most likely misconfiguration there is. `list` has no such catch, so a bad bucket throws.
 * Found in review of the very PR that renames this bucket.
 */
import type { CloudBucket } from "@mieweb/cloud";
import { isS3BucketConfigured, resolveBucket, type BucketEnv } from "./resolve-bucket.ts";
import type { AlertEnv, RunAlert } from "../run/alert-channel.ts";

/** The env the probe needs — the seam vars, the injected binding, and the alert webhook knob. */
export type BucketEnvForProbe = BucketEnv & AlertEnv;

/**
 * A prefix chosen to match nothing, so the list is as cheap as a list can be. It is never written.
 */
export const BUCKET_PROBE_PREFIX = ".workwell-reachability-probe";

/**
 * Hard cap on the probe, mirroring `WEBHOOK_TIMEOUT_MS`'s reasoning in `alert-channel.ts`. The AWS
 * SDK ships no default request timeout and retries three times, so a blackholed endpoint would
 * otherwise hold the probe open for minutes — and "the endpoint is a black hole" is precisely the
 * outage this exists to announce. Late news is the failure mode being fixed, so the probe reports
 * `unreachable` on timeout rather than waiting to be sure.
 */
export const PROBE_TIMEOUT_MS = 8_000;

export type BucketProbeResult =
  /** The seam is off — the injected binding serves, and there is nothing to probe. */
  | { kind: "not-configured" }
  /** A round trip completed: credentials, endpoint AND bucket name all resolve. */
  | { kind: "reachable" }
  /** The round trip threw or timed out. `message` is the adapter's, trimmed for a log line. */
  | { kind: "unreachable"; bucket: string; endpoint?: string; message: string };

/** Keep an adapter's error legible on one log line without leaking a multi-KB SDK dump. */
function briefly(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 297)}...` : oneLine;
}

/**
 * Probes the configured evidence bucket. Never throws — every failure path is a returned result,
 * because the only caller is a boot hook on the request path, and an alerting probe that can itself
 * take down a request would be worse than the silence it exists to fix.
 */
export async function probeEvidenceBucket(
  env: BucketEnvForProbe,
  resolve: (env: BucketEnv) => Promise<CloudBucket> = resolveBucket,
): Promise<BucketProbeResult> {
  if (!isS3BucketConfigured(env)) return { kind: "not-configured" };
  const bucket = (env.WORKWELL_BUCKET_S3_BUCKET ?? "").trim();
  const endpoint = (env.WORKWELL_BUCKET_S3_ENDPOINT ?? "").trim() || undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const roundTrip = resolve(env).then((b) => b.list({ prefix: BUCKET_PROBE_PREFIX }));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
        PROBE_TIMEOUT_MS,
      );
      // Never hold the process open for the probe's own timer.
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    await Promise.race([roundTrip, timeout]);
    return { kind: "reachable" };
  } catch (err) {
    return { kind: "unreachable", bucket, endpoint, message: briefly(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * An endpoint with its account identifier removed.
 *
 * The R2 endpoint is `https://<account-id>.r2.cloudflarestorage.com`, and it is held as a GitHub
 * SECRET precisely because that account id should not be public. Putting it verbatim into an alert
 * would print it into container logs and into whatever the webhook channel forwards to — a quieter
 * version of the same exposure, undone by the same reasoning that made it a secret. The host's shape
 * is what diagnoses a misconfiguration; the account id adds nothing an operator needs.
 */
export function redactEndpoint(endpoint: string): string {
  try {
    const { protocol, host } = new URL(endpoint);
    const parts = host.split(".");
    return parts.length > 2 ? `${protocol}//<account>.${parts.slice(1).join(".")}` : `${protocol}//${host}`;
  } catch {
    return "<unparseable endpoint>";
  }
}

/**
 * The alert for an unreachable bucket, in the shared `RunAlert` shape so it travels the SAME
 * channels every other alert does — console AND the optional `WORKWELL_ALERT_WEBHOOK_URL`.
 *
 * Hand-rolling `console.error("WORKWELL_ALERT …")` here (as two other call sites still do) would
 * have shipped, as the remedy for "this was silent for eighteen days because nobody reads logs", a
 * log line nobody reads.
 */
export function bucketAlert(result: BucketProbeResult, now: () => Date = () => new Date()): RunAlert | null {
  if (result.kind !== "unreachable") return null;
  return {
    kind: "EVIDENCE_BUCKET_UNREACHABLE",
    at: now().toISOString(),
    status: "EVIDENCE_BUCKET_UNREACHABLE",
    message:
      `evidence bucket "${result.bucket}" is configured but unreachable: ${result.message}. ` +
      "Every evidence upload and download is failing, and the seam is configured so there is no fallback.",
    detail: {
      bucket: result.bucket,
      ...(result.endpoint ? { endpoint: redactEndpoint(result.endpoint) } : {}),
    },
  };
}

/**
 * A configuration that NAMES a bucket but cannot authenticate to one.
 *
 * `isS3BucketConfigured` requires all three of bucket + key id + secret, so a half-set config is
 * simply "off" — the injected `fs` binding serves and evidence is lost on the next container
 * recreate. That is the correct behaviour and must not change: a deploy that fails closed to durable
 * storage would be worse. But it is ALSO indistinguishable, from the outside, from a deployment that
 * never wanted a bucket — which is the precise shape of failure this module exists to end. An
 * operator who sets the bucket name and mistypes one secret gets silence today.
 *
 * So: naming a bucket is read as intent, and intent that did not take effect is said out loud.
 */
export function partialBucketConfigAlert(
  env: BucketEnvForProbe,
  now: () => Date = () => new Date(),
): RunAlert | null {
  const bucket = (env.WORKWELL_BUCKET_S3_BUCKET ?? "").trim();
  if (!bucket || isS3BucketConfigured(env)) return null;
  const missing = [
    (env.WORKWELL_BUCKET_S3_ACCESS_KEY_ID ?? "").trim() ? null : "WORKWELL_BUCKET_S3_ACCESS_KEY_ID",
    (env.WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY ?? "").trim() ? null : "WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY",
  ].filter((v): v is string => v !== null);
  return {
    kind: "EVIDENCE_BUCKET_UNREACHABLE",
    at: now().toISOString(),
    status: "EVIDENCE_BUCKET_NOT_CONFIGURED",
    message:
      `evidence bucket "${bucket}" is named but ${missing.join(" and ")} ` +
      `${missing.length === 1 ? "is" : "are"} empty, so durable storage is OFF and evidence is being ` +
      "written to the container filesystem, where it is lost on the next deploy or self-heal.",
    detail: { bucket, missing },
  };
}
