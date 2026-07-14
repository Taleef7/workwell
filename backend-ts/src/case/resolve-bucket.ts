/**
 * Evidence-bucket seam (#167 / ADR-030): durable S3-compatible evidence storage,
 * inert-unless-configured.
 *
 * The live TWH container runs the `local` mieweb target, whose `BUCKET` binding is an in-container
 * `fs` driver — evidence bytes are lost on every container recreate (deploy/heal). The mieweb.jsonc
 * bindings are literal JSON (no env substitution — see external/mieweb-cloud/packages/cli/src/config.mjs),
 * so the durable backend is selected HERE, at app level, exactly like the `DATABASE_URL` store
 * override in stores/factory.ts: when the three `WORKWELL_BUCKET_S3_*` vars below are set, evidence
 * I/O goes to a managed S3-compatible bucket via `createS3Bucket` (`@mieweb/cloud-os` — the same
 * adapter the mieweb target's BUCKET binding uses); when they are unset, the injected `env.BUCKET`
 * binding serves unchanged, byte-identical to before this seam existed.
 *
 * Selection requires ALL THREE of bucket name + access key id + secret (mirrors the both-vars-required
 * seams, ADR-011..029); region defaults to us-east-1; `endpoint` is only for non-AWS S3 APIs (R2,
 * MinIO — it also switches to path-style addressing). `createIfMissing: false` — provisioning is
 * owner-gated infra (the app's IAM policy deliberately cannot create buckets); a misconfigured bucket
 * fails on first evidence op, legibly, instead of silently self-provisioning.
 *
 * The resolved bucket is memoized per worker instance (one env per process — the aggregateScaleRun
 * memo pattern). Descriptive only (ADR-008 n/a): storage backend selection never touches compliance.
 */
import type { CloudBucket } from "@mieweb/cloud";
import { createS3Bucket } from "@mieweb/cloud-os";

/** Env-var shape for the seam inventory (all optional — assignable from the worker `Env`). */
export interface BucketSeamEnv {
  WORKWELL_BUCKET_S3_BUCKET?: string;
  WORKWELL_BUCKET_S3_ACCESS_KEY_ID?: string;
  WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY?: string;
  WORKWELL_BUCKET_S3_REGION?: string;
  WORKWELL_BUCKET_S3_ENDPOINT?: string;
}

/** Full env the resolver needs: the seam vars + the host-injected BUCKET binding fallback. */
export interface BucketEnv extends BucketSeamEnv {
  BUCKET: CloudBucket;
}

/** S3 config subset `createS3Bucket` takes (matches the mieweb.jsonc s3 driver shape). */
export interface S3BucketConfig {
  bucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  createIfMissing?: boolean;
}

export type S3BucketFactory = (cfg: S3BucketConfig) => Promise<CloudBucket>;

/** The exact predicate `resolveBucket` selects on — consumed by the seam inventory (#260). */
export function isS3BucketConfigured(env: BucketSeamEnv): boolean {
  return Boolean(
    env.WORKWELL_BUCKET_S3_BUCKET &&
      env.WORKWELL_BUCKET_S3_ACCESS_KEY_ID &&
      env.WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY,
  );
}

let cached: Promise<CloudBucket> | null = null;

/**
 * Returns the S3-backed bucket when configured, else the injected `env.BUCKET` binding.
 * The factory parameter exists for tests only.
 */
export function resolveBucket(
  env: BucketEnv,
  factory: S3BucketFactory = createS3Bucket,
): Promise<CloudBucket> {
  if (!isS3BucketConfigured(env)) return Promise.resolve(env.BUCKET);
  if (!cached) {
    cached = factory({
      bucket: env.WORKWELL_BUCKET_S3_BUCKET!,
      region: env.WORKWELL_BUCKET_S3_REGION || "us-east-1",
      endpoint: env.WORKWELL_BUCKET_S3_ENDPOINT || undefined,
      accessKeyId: env.WORKWELL_BUCKET_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY!,
      // Path-style only for non-AWS endpoints (R2/MinIO); AWS S3 uses virtual-hosted style.
      forcePathStyle: Boolean(env.WORKWELL_BUCKET_S3_ENDPOINT),
      createIfMissing: false,
    }).catch((err) => {
      cached = null; // a failed construction must not be sticky — retry on the next evidence op
      throw err;
    });
  }
  return cached;
}

/** Test hook — clears the per-process memo. */
export function resetResolveBucketForTests(): void {
  cached = null;
}
