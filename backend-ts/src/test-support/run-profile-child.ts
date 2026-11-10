import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Runs `source` in a FRESH process with `WORKWELL_INSTANCE` set, so module-load behaviour is really
 * observed rather than simulated. `extraEnv` sets further variables before any import — which is the
 * only way to test something read at first access, since an in-process test has already imported the
 * module by the time it could set the variable.
 *
 * `opts.now` starts the child's clock at that instant (`shift-now.ts`, loaded right after tsx, before the script's imports), so a
 * suite can run where the practice's date and the UTC date differ (#882).
 */
export function runProfileChild(
  instance: string | undefined,
  source: string,
  extraEnv: Record<string, string | undefined> = {},
  opts: { now?: string } = {},
): Record<string, unknown> {
  const env = { ...process.env };
  if (instance === undefined) delete env.WORKWELL_INSTANCE;
  else env.WORKWELL_INSTANCE = instance;
  // The pilot password hash in a developer's shell would silently change which password the pilot
  // accounts accept, so a child never inherits it; a test that wants it passes it explicitly.
  if (!("WORKWELL_PILOT_PASSWORD_HASH" in extraEnv)) delete env.WORKWELL_PILOT_PASSWORD_HASH;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", ...(opts.now ? ["--import", "./src/test-support/shift-now.ts"] : []), "--input-type=module", "-e", source],
    { cwd: backendRoot, env: opts.now ? { ...env, WORKWELL_TEST_NOW: opts.now } : env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return { ...(JSON.parse(result.stdout.trim()) as Record<string, unknown>), stderr: result.stderr };
}
