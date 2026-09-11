/**
 * Evidence-bucket reachability probe tests (#473 follow-on):
 *   node --import tsx --test src/case/bucket-health.test.ts
 *
 * The probe exists because a configured-but-dead bucket booted clean for eighteen days. So the
 * tests that matter are the ones that pin it CANNOT go quiet again: a throw must surface as
 * `unreachable`, and the probe itself must never throw into its caller.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CloudBucket } from "@mieweb/cloud";
import {
  probeEvidenceBucket,
  bucketAlertLine,
  BUCKET_PROBE_KEY,
  type BucketEnvForProbe,
} from "./bucket-health.ts";

const fsBucket = { kind: "fs-binding" } as unknown as CloudBucket;

const CONFIGURED = {
  WORKWELL_BUCKET_S3_BUCKET: "workwell-evidence-twh",
  WORKWELL_BUCKET_S3_ACCESS_KEY_ID: "key",
  WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY: "secret",
};

function env(extra: Record<string, unknown> = {}): BucketEnvForProbe {
  return { BUCKET: fsBucket, ...CONFIGURED, ...extra } as BucketEnvForProbe;
}

/** A bucket whose `get` does whatever the test says. */
function bucketGetting(get: (key: string) => Promise<unknown>): CloudBucket {
  return { get } as unknown as CloudBucket;
}

test("seam off: reports not-configured and never resolves a bucket", async () => {
  let resolved = false;
  const result = await probeEvidenceBucket({ BUCKET: fsBucket } as BucketEnvForProbe, async () => {
    resolved = true;
    return fsBucket;
  });
  assert.deepEqual(result, { kind: "not-configured" });
  assert.equal(resolved, false, "an unconfigured seam must cost nothing at boot");
});

test("a missing probe key is a SUCCESSFUL round trip — that is the whole point", async () => {
  const result = await probeEvidenceBucket(env(), async () =>
    bucketGetting(async () => null),
  );
  assert.deepEqual(result, { kind: "reachable", found: false });
});

test("reads the probe key, and writes nothing", async () => {
  const keys: string[] = [];
  await probeEvidenceBucket(env(), async () =>
    bucketGetting(async (key) => {
      keys.push(key);
      return null;
    }),
  );
  assert.deepEqual(keys, [BUCKET_PROBE_KEY]);
});

test("an existing probe key is equally reachable", async () => {
  const result = await probeEvidenceBucket(env(), async () =>
    bucketGetting(async () => ({ body: "x" })),
  );
  assert.deepEqual(result, { kind: "reachable", found: true });
});

test("a throwing get is unreachable, carrying bucket and message", async () => {
  const result = await probeEvidenceBucket(env(), async () =>
    bucketGetting(async () => {
      throw new Error("AllAccessDisabled: All access to this object has been disabled");
    }),
  );
  assert.equal(result.kind, "unreachable");
  assert.equal(result.kind === "unreachable" && result.bucket, "workwell-evidence-twh");
  assert.match(
    result.kind === "unreachable" ? result.message : "",
    /AllAccessDisabled/,
    "the adapter's own diagnosis is what an operator needs",
  );
});

test("a failed CONSTRUCTION is unreachable too, not an exception", async () => {
  const result = await probeEvidenceBucket(env(), async () => {
    throw new Error("credentials rejected");
  });
  assert.equal(result.kind, "unreachable");
});

test("the probe never throws, whatever the adapter does", async () => {
  await assert.doesNotReject(() =>
    probeEvidenceBucket(env(), () => Promise.reject(new Error("boom"))),
  );
  await assert.doesNotReject(() =>
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    probeEvidenceBucket(env(), async () =>
      bucketGetting(async () => {
        throw "a string, not an Error";
      }),
    ),
  );
});

test("a non-Error throw still yields a readable message", async () => {
  const result = await probeEvidenceBucket(env(), async () =>
    bucketGetting(async () => {
      throw "plain string failure";
    }),
  );
  assert.equal(result.kind === "unreachable" && result.message, "plain string failure");
});

test("a multi-line SDK dump is collapsed and capped for the log line", async () => {
  const result = await probeEvidenceBucket(env(), async () =>
    bucketGetting(async () => {
      throw new Error(`line one\n   line two\n${"x".repeat(500)}`);
    }),
  );
  const message = result.kind === "unreachable" ? result.message : "";
  assert.ok(message.length <= 300, `message was ${message.length} chars`);
  assert.ok(!message.includes("\n"), "a log line must stay one line");
  assert.match(message, /^line one line two/);
});

test("the endpoint is carried when set and absent when not", async () => {
  const withEndpoint = await probeEvidenceBucket(
    env({ WORKWELL_BUCKET_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com" }),
    async () =>
      bucketGetting(async () => {
        throw new Error("nope");
      }),
  );
  assert.equal(
    withEndpoint.kind === "unreachable" && withEndpoint.endpoint,
    "https://acct.r2.cloudflarestorage.com",
  );
  const without = await probeEvidenceBucket(env(), async () =>
    bucketGetting(async () => {
      throw new Error("nope");
    }),
  );
  assert.equal(without.kind === "unreachable" && without.endpoint, undefined);
});

test("bucketAlertLine: only an unreachable result produces a line", async () => {
  assert.equal(bucketAlertLine({ kind: "not-configured" }), null);
  assert.equal(bucketAlertLine({ kind: "reachable", found: false }), null);
});

test("bucketAlertLine: greppable token plus machine-readable payload", () => {
  const line = bucketAlertLine({
    kind: "unreachable",
    bucket: "workwell-evidence-twh",
    endpoint: "https://acct.r2.cloudflarestorage.com",
    message: "AllAccessDisabled",
  });
  assert.ok(line);
  assert.ok(line!.startsWith("WORKWELL_ALERT "), "operators grep for the token");
  const payload = JSON.parse(line!.slice("WORKWELL_ALERT ".length));
  assert.equal(payload.kind, "EVIDENCE_BUCKET_UNREACHABLE");
  assert.equal(payload.bucket, "workwell-evidence-twh");
  assert.equal(payload.endpoint, "https://acct.r2.cloudflarestorage.com");
  assert.match(payload.consequence, /no fallback/);
});

test("bucketAlertLine: the endpoint key is omitted rather than null on AWS", () => {
  const line = bucketAlertLine({
    kind: "unreachable",
    bucket: "b",
    message: "m",
  })!;
  assert.ok(!Object.hasOwn(JSON.parse(line.slice("WORKWELL_ALERT ".length)), "endpoint"));
});
