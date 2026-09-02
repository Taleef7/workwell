/**
 * Per-request authorization tests under the Maui deployment profile.
 * Verifies that a validly signed access token for a non-Maui account (e.g. viewer@workwell.dev)
 * is rejected with 401 on Maui, while accepted on the default profile.
 *
 *   node --import tsx --test src/auth/authorize.maui.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function runProfileChild(instance: string | undefined, source: string): Record<string, unknown> {
  const env = { ...process.env };
  if (instance === undefined) delete env.WORKWELL_INSTANCE;
  else env.WORKWELL_INSTANCE = instance;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    { cwd: backendRoot, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "{}";
  return JSON.parse(lastLine) as Record<string, unknown>;
}

const testScript = `
  import worker from "./src/worker.ts";
  import { createJwt } from "./src/auth/jwt.ts";
  import { createSqliteD1 } from "@mieweb/cloud-local";

  const secret = "x".repeat(40);
  const jwt = createJwt({ secret });
  const token = jwt.issueAccessToken("viewer@workwell.dev", "ROLE_VIEWER");
  const db = await createSqliteD1(":memory:");
  const env = { DB: db, WORKWELL_AUTH_JWT_SECRET: secret };
  const res = await worker.fetch(
    new Request("http://x/api/runs", { headers: { authorization: "Bearer " + token } }),
    env,
    {},
  );
  console.log(JSON.stringify({ status: res.status }));
`;

test("on maui, a validly signed access token for viewer@workwell.dev gets 401 from protected GET", () => {
  const output = runProfileChild("maui", testScript);
  assert.equal(output.status, 401, "viewer@workwell.dev must be refused with 401 on maui");
});

test("on default, a validly signed access token for viewer@workwell.dev is accepted", () => {
  const output = runProfileChild(undefined, testScript);
  assert.equal(output.status, 200, "viewer@workwell.dev must be accepted with 200 on default");
});
