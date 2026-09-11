/**
 * Evidence-bucket reachability probe tests (#473 follow-on):
 *   node --import tsx --test src/case/bucket-health.test.ts
 *
 * The probe exists because a configured-but-dead bucket booted clean for eighteen days. So the
 * tests that matter are the ones pinning that it CANNOT go quiet again: a throw must surface as
 * `unreachable`, a WRONG BUCKET NAME must surface as unreachable (the review finding that rewrote
 * this module — see the `list`-not-`get` note below), a hang must not wait forever, and the probe
 * itself must never throw into its caller.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CloudBucket } from "@mieweb/cloud";
import {
  probeEvidenceBucket,
  bucketAlert,
  partialBucketConfigAlert,
  redactEndpoint,
  redactAccountIn,
  BUCKET_PROBE_PREFIX,
  PROBE_TIMEOUT_MS,
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

/** A bucket whose `list` does whatever the test says; `get` is present only to prove it is unused. */
function bucketListing(list: (opts?: { prefix?: string }) => Promise<unknown>): CloudBucket {
  return {
    list,
    get: async () => {
      throw new Error("the probe must not use get() — a 404 from get() hides NoSuchBucket");
    },
  } as unknown as CloudBucket;
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

test("an empty listing is a SUCCESSFUL round trip", async () => {
  const result = await probeEvidenceBucket(env(), async () =>
    bucketListing(async () => ({ objects: [], truncated: false, delimitedPrefixes: [] })),
  );
  assert.deepEqual(result, { kind: "reachable" });
});

test("it LISTS, under a prefix chosen to match nothing, and writes nothing", async () => {
  const seen: Array<{ prefix?: string } | undefined> = [];
  await probeEvidenceBucket(env(), async () =>
    bucketListing(async (opts) => {
      seen.push(opts);
      return { objects: [], truncated: false, delimitedPrefixes: [] };
    }),
  );
  assert.deepEqual(seen, [{ prefix: BUCKET_PROBE_PREFIX }]);
});

// The finding that rewrote this module. `get` swallows ANY 404 into null
// (cloud-os/src/adapters/r2-s3.mjs → isNotFound: httpStatusCode === 404), and NoSuchBucket IS a 404,
// so a `get`-based probe reports "reachable" for a bucket that does not exist — a control that is
// present, reads green, and cannot fire on the likeliest misconfiguration there is. `list` throws.
test("A WRONG BUCKET NAME is unreachable — NoSuchBucket is a 404 and must not read as an empty bucket", async () => {
  const noSuchBucket = Object.assign(new Error("The specified bucket does not exist"), {
    name: "NoSuchBucket",
    $metadata: { httpStatusCode: 404 },
  });
  const result = await probeEvidenceBucket(env({ WORKWELL_BUCKET_S3_BUCKET: "workwell-twh-evidence" }), async () =>
    bucketListing(async () => {
      throw noSuchBucket;
    }),
  );
  assert.equal(result.kind, "unreachable");
  // The transposed name is the one this PR is most likely to get wrong; it must appear in the alert.
  assert.equal(result.kind === "unreachable" && result.bucket, "workwell-twh-evidence");
});

test("a suspended account is unreachable, carrying the adapter's own diagnosis", async () => {
  const result = await probeEvidenceBucket(env(), async () =>
    bucketListing(async () => {
      throw new Error("AllAccessDisabled: All access to this object has been disabled");
    }),
  );
  assert.equal(result.kind, "unreachable");
  assert.match(result.kind === "unreachable" ? result.message : "", /AllAccessDisabled/);
});

test("a failed CONSTRUCTION is unreachable too, not an exception", async () => {
  const result = await probeEvidenceBucket(env(), async () => {
    throw new Error("credentials rejected");
  });
  assert.equal(result.kind, "unreachable");
});

test("a hung endpoint is reported rather than awaited forever", async () => {
  const started = Date.now();
  const result = await probeEvidenceBucket(env(), async () =>
    bucketListing(() => new Promise(() => {})),
  );
  assert.equal(result.kind, "unreachable");
  assert.match(result.kind === "unreachable" ? result.message : "", /timed out/);
  assert.ok(
    Date.now() - started < PROBE_TIMEOUT_MS + 4_000,
    "the probe must not outlive its own timeout",
  );
});

test("the probe never throws, whatever the adapter does", async () => {
  await assert.doesNotReject(() =>
    probeEvidenceBucket(env(), () => Promise.reject(new Error("boom"))),
  );
  await assert.doesNotReject(() =>
    probeEvidenceBucket(env(), async () =>
      bucketListing(async () => {
        throw "a string, not an Error";
      }),
    ),
  );
});

test("a non-Error throw still yields a readable message", async () => {
  const result = await probeEvidenceBucket(env(), async () =>
    bucketListing(async () => {
      throw "plain string failure";
    }),
  );
  assert.equal(result.kind === "unreachable" && result.message, "plain string failure");
});

test("a multi-line SDK dump is collapsed and capped for the log line", async () => {
  const result = await probeEvidenceBucket(env(), async () =>
    bucketListing(async () => {
      throw new Error(`line one\n   line two\n${"x".repeat(500)}`);
    }),
  );
  const message = result.kind === "unreachable" ? result.message : "";
  assert.ok(message.length <= 300, `message was ${message.length} chars`);
  assert.ok(!message.includes("\n"), "a log line must stay one line");
  assert.match(message, /^line one line two/);
});

test("the endpoint is carried when set and absent when not", async () => {
  const thrower = async () =>
    bucketListing(async () => {
      throw new Error("nope");
    });
  const withEndpoint = await probeEvidenceBucket(
    env({ WORKWELL_BUCKET_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com" }),
    thrower,
  );
  assert.equal(
    withEndpoint.kind === "unreachable" && withEndpoint.endpoint,
    "https://acct.r2.cloudflarestorage.com",
  );
  const without = await probeEvidenceBucket(env(), thrower);
  assert.equal(without.kind === "unreachable" && without.endpoint, undefined);
});

test("bucketAlert: only an unreachable result produces an alert", () => {
  assert.equal(bucketAlert({ kind: "not-configured" }), null);
  assert.equal(bucketAlert({ kind: "reachable" }), null);
});

test("bucketAlert: a RunAlert, so it travels the webhook channel and not just the console", () => {
  const alert = bucketAlert(
    {
      kind: "unreachable",
      bucket: "workwell-evidence-twh",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      message: "AllAccessDisabled",
    },
    () => new Date("2026-09-11T16:30:00.000Z"),
  );
  assert.ok(alert);
  // The runbook tells an operator to grep for exactly this. Borrowing SCHEDULER_TICK_ERROR would
  // have routed a storage outage to the scheduler's owner and made that grep return nothing.
  assert.equal(alert!.kind, "EVIDENCE_BUCKET_UNREACHABLE");
  assert.equal(alert!.at, "2026-09-11T16:30:00.000Z");
  assert.equal(alert!.status, "EVIDENCE_BUCKET_UNREACHABLE");
  assert.equal(alert!.detail?.bucket, "workwell-evidence-twh");
  // Redacted: the account id is a GitHub secret, and a log line is not a safe place to undo that.
  assert.equal(alert!.detail?.endpoint, "https://<account>.r2.cloudflarestorage.com");
  assert.match(alert!.message, /no fallback/);
});

test("bucketAlert: the endpoint key is omitted rather than null on a plain-AWS config", () => {
  const alert = bucketAlert({ kind: "unreachable", bucket: "b", message: "m" })!;
  assert.ok(!Object.hasOwn(alert.detail!, "endpoint"));
});

// ---------------------------------------------------------------------------
// Endpoint redaction, and the half-configured bucket (both from review).
// ---------------------------------------------------------------------------

test("redactEndpoint: the R2 account id never reaches a log line", () => {
  assert.equal(
    redactEndpoint("https://26ade3362911ce551e52ea5c61178cbc.r2.cloudflarestorage.com"),
    "https://<account>.r2.cloudflarestorage.com",
  );
});

test("redactEndpoint: a two-label host has no account segment to remove", () => {
  assert.equal(redactEndpoint("https://minio.local"), "https://minio.local");
});

test("redactEndpoint: garbage in, no throw out", () => {
  assert.equal(redactEndpoint("not a url"), "<unparseable endpoint>");
});

test("a bucket NAMED but missing both credentials is alerted, not silent", () => {
  const alert = partialBucketConfigAlert({
    BUCKET: fsBucket,
    WORKWELL_BUCKET_S3_BUCKET: "workwell-evidence-maui",
    WORKWELL_BUCKET_S3_ACCESS_KEY_ID: "",
    WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY: "",
  } as BucketEnvForProbe);
  assert.ok(alert, "a named bucket with no credentials is intent that did not take effect");
  assert.equal(alert!.kind, "EVIDENCE_BUCKET_UNREACHABLE");
  assert.equal(alert!.status, "EVIDENCE_BUCKET_NOT_CONFIGURED");
  assert.deepEqual(alert!.detail?.missing, [
    "WORKWELL_BUCKET_S3_ACCESS_KEY_ID",
    "WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY",
  ]);
  assert.match(alert!.message, /lost on the next deploy or self-heal/);
});

test("...and names WHICH secret is missing when only one is", () => {
  const alert = partialBucketConfigAlert({
    BUCKET: fsBucket,
    WORKWELL_BUCKET_S3_BUCKET: "workwell-evidence-maui",
    WORKWELL_BUCKET_S3_ACCESS_KEY_ID: "present",
    WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY: "   ",
  } as BucketEnvForProbe);
  assert.deepEqual(alert!.detail?.missing, ["WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY"]);
  assert.match(alert!.message, /is empty/);
});

test("a deployment that names NO bucket is not nagged — it never asked for one", () => {
  assert.equal(partialBucketConfigAlert({ BUCKET: fsBucket } as BucketEnvForProbe), null);
});

test("a fully configured bucket produces no partial-config alert", () => {
  assert.equal(partialBucketConfigAlert(env()), null);
});

// ---------------------------------------------------------------------------
// The account id must not survive in text we did not write (Codex review, PR #549).
// ---------------------------------------------------------------------------

test("redactAccountIn: a DNS failure quoting the host does not leak the account id", () => {
  const endpoint = "https://26ade3362911ce551e52ea5c61178cbc.r2.cloudflarestorage.com";
  const message = "getaddrinfo ENOTFOUND 26ade3362911ce551e52ea5c61178cbc.r2.cloudflarestorage.com";
  assert.equal(
    redactAccountIn(message, endpoint),
    "getaddrinfo ENOTFOUND <account>.r2.cloudflarestorage.com",
  );
});

test("redactAccountIn: every occurrence, not just the first", () => {
  const endpoint = "https://acct123.r2.cloudflarestorage.com";
  assert.equal(
    redactAccountIn("host acct123 mismatched cert for acct123", endpoint),
    "host <account> mismatched cert for <account>",
  );
});

test("redactAccountIn: nothing to redact leaves the text alone", () => {
  assert.equal(redactAccountIn("AllAccessDisabled"), "AllAccessDisabled");
  assert.equal(redactAccountIn("AllAccessDisabled", "https://minio.local"), "AllAccessDisabled");
  assert.equal(redactAccountIn("AllAccessDisabled", "not a url"), "AllAccessDisabled");
});

test("bucketAlert: the account id is absent from the MESSAGE too, not only from detail.endpoint", () => {
  const endpoint = "https://26ade3362911ce551e52ea5c61178cbc.r2.cloudflarestorage.com";
  const alert = bucketAlert({
    kind: "unreachable",
    bucket: "workwell-evidence-maui",
    endpoint,
    message: "getaddrinfo ENOTFOUND 26ade3362911ce551e52ea5c61178cbc.r2.cloudflarestorage.com",
  })!;
  const serialized = JSON.stringify(alert);
  assert.ok(
    !serialized.includes("26ade3362911ce551e52ea5c61178cbc"),
    "redacting one field while interpolating the raw message into another leaks it just the same",
  );
  assert.match(alert.message, /<account>\.r2\.cloudflarestorage\.com/);
});
