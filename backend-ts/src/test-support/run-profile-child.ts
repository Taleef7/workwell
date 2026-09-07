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
 */
export function runProfileChild(
  instance: string | undefined,
  source: string,
  extraEnv: Record<string, string | undefined> = {},
): Record<string, unknown> {
  const env = { ...process.env };
  if (instance === undefined) delete env.WORKWELL_INSTANCE;
  else env.WORKWELL_INSTANCE = instance;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    { cwd: backendRoot, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return { ...(JSON.parse(result.stdout.trim()) as Record<string, unknown>), stderr: result.stderr };
}
