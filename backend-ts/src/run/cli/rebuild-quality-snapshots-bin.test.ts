import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// The command the Maui workflow runs, run for real (#676). Its first dispatch died before writing
// anything: a shebang made tsx's import scanner reject the file's top-level await ("Parse error").
// Unit tests of `rebuildSnapshotHistory` could not see that, because they never load this file.
test("pnpm rebuild:quality-snapshots loads and completes against an empty store", () => {
  const dbPath = join(tmpdir(), `workwell-rebuild-cli-${crypto.randomUUID()}.sqlite`);
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/run/cli/rebuild-quality-snapshots-bin.ts"], {
      cwd: backendRoot,
      env: { ...process.env, DATABASE_URL: "", WORKWELL_SQLITE_PATH: dbPath },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /rebuild:quality-snapshots — 0 run\(s\) replayed, 0 skipped/);
  } finally {
    rmSync(dbPath, { force: true });
  }
});
