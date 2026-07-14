/**
 * Evidence-bucket seam tests (#167 / ADR-030):
 *   node --import tsx --test src/case/resolve-bucket.test.ts
 *
 * The seam must be inert-unless-configured (unset ⇒ the injected BUCKET binding, byte-identical),
 * require ALL THREE selecting vars, and memoize the constructed S3 bucket per process — without a
 * failed construction becoming sticky.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { CloudBucket } from "@mieweb/cloud";
import {
  isS3BucketConfigured,
  resolveBucket,
  resetResolveBucketForTests,
  type BucketEnv,
  type S3BucketConfig,
} from "./resolve-bucket.ts";

const fsBucket = { kind: "fs-binding" } as unknown as CloudBucket;
const s3Bucket = { kind: "s3" } as unknown as CloudBucket;

const CONFIGURED = {
  WORKWELL_BUCKET_S3_BUCKET: "workwell-twh-evidence",
  WORKWELL_BUCKET_S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
  WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY: "secret",
};

function env(extra: Partial<BucketEnv> = {}): BucketEnv {
  return { BUCKET: fsBucket, ...extra };
}

beforeEach(() => resetResolveBucketForTests());

test("unconfigured: falls back to the injected BUCKET binding (inert default)", async () => {
  assert.equal(isS3BucketConfigured({}), false);
  assert.equal(await resolveBucket(env()), fsBucket);
});

test("selection requires ALL THREE vars — any partial combination stays inert", async () => {
  const partials: Partial<BucketEnv>[] = [
    { WORKWELL_BUCKET_S3_BUCKET: "b" },
    { WORKWELL_BUCKET_S3_ACCESS_KEY_ID: "k" },
    { WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY: "s" },
    { WORKWELL_BUCKET_S3_BUCKET: "b", WORKWELL_BUCKET_S3_ACCESS_KEY_ID: "k" },
    { WORKWELL_BUCKET_S3_BUCKET: "b", WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY: "s" },
    { WORKWELL_BUCKET_S3_ACCESS_KEY_ID: "k", WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY: "s" },
  ];
  for (const p of partials) {
    assert.equal(isS3BucketConfigured(p), false, `partial ${JSON.stringify(Object.keys(p))} must stay off`);
    assert.equal(await resolveBucket(env(p)), fsBucket);
  }
  // region/endpoint alone never select
  assert.equal(isS3BucketConfigured({ WORKWELL_BUCKET_S3_REGION: "us-east-1" }), false);
});

test("whitespace-only values do not select the seam; trailing whitespace is trimmed from config", async () => {
  // A blank/whitespace deploy secret must stay inert (the isVsacConfigured pattern) …
  assert.equal(
    isS3BucketConfigured({
      WORKWELL_BUCKET_S3_BUCKET: "   ",
      WORKWELL_BUCKET_S3_ACCESS_KEY_ID: "\n",
      WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY: "\t",
    }),
    false,
  );
  // … and a trailing newline on a real secret must never reach SigV4.
  const calls: S3BucketConfig[] = [];
  const fake = async (cfg: S3BucketConfig) => {
    calls.push(cfg);
    return s3Bucket;
  };
  await resolveBucket(
    env({
      WORKWELL_BUCKET_S3_BUCKET: "workwell-twh-evidence\n",
      WORKWELL_BUCKET_S3_ACCESS_KEY_ID: " AKIAEXAMPLE ",
      WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY: "secret\n",
      WORKWELL_BUCKET_S3_ENDPOINT: "   ",
    }),
    fake,
  );
  assert.deepEqual(calls[0], {
    bucket: "workwell-twh-evidence",
    region: "us-east-1",
    endpoint: undefined,
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    forcePathStyle: false,
    createIfMissing: false,
  });
});

test("configured: constructs the S3 bucket with the expected config (AWS = virtual-hosted style)", async () => {
  const calls: S3BucketConfig[] = [];
  const fake = async (cfg: S3BucketConfig) => {
    calls.push(cfg);
    return s3Bucket;
  };
  const got = await resolveBucket(env(CONFIGURED), fake);
  assert.equal(got, s3Bucket);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    bucket: "workwell-twh-evidence",
    region: "us-east-1",
    endpoint: undefined,
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    forcePathStyle: false,
    createIfMissing: false,
  });
});

test("configured with endpoint (R2/MinIO): path-style addressing + the endpoint", async () => {
  const calls: S3BucketConfig[] = [];
  const fake = async (cfg: S3BucketConfig) => {
    calls.push(cfg);
    return s3Bucket;
  };
  await resolveBucket(env({ ...CONFIGURED, WORKWELL_BUCKET_S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com" }), fake);
  assert.equal(calls[0]!.endpoint, "https://acc.r2.cloudflarestorage.com");
  assert.equal(calls[0]!.forcePathStyle, true);
});

test("memoized: repeated resolves construct once", async () => {
  let constructions = 0;
  const fake = async () => {
    constructions++;
    return s3Bucket;
  };
  await resolveBucket(env(CONFIGURED), fake);
  await resolveBucket(env(CONFIGURED), fake);
  await resolveBucket(env(CONFIGURED), fake);
  assert.equal(constructions, 1);
});

test("a failed construction is not sticky — the next resolve retries", async () => {
  let attempts = 0;
  const failingOnce = async () => {
    attempts++;
    if (attempts === 1) throw new Error("transient S3 outage");
    return s3Bucket;
  };
  await assert.rejects(() => resolveBucket(env(CONFIGURED), failingOnce), /transient S3 outage/);
  const got = await resolveBucket(env(CONFIGURED), failingOnce);
  assert.equal(got, s3Bucket);
  assert.equal(attempts, 2);
});
