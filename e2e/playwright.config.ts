import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./base-url";

/**
 * The Maui specs that MUTATE the stack, named in ONE place because the two projects below must agree
 * about them: a file listed in `maui-writes` and not ignored by `maui` would run twice, once of them
 * in parallel with the reads it disturbs. Adding a write spec means adding it here, not in two places.
 */
const MAUI_WRITE_SPECS = [
  "tests/maui/runs.spec.ts",
  "tests/maui/worklist-writes.spec.ts",
  "tests/maui/case-workflow.spec.ts",
];

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  timeout: 60_000,
  retries: 1,
  // The Maui stack this suite boots is a single backend process on the SQLite floor, so the ceiling is
  // its event loop rather than the runner's 4 vCPUs. Four workers on a read-mostly suite measured well
  // inside that; the two specs that WRITE (a manual run, an outreach POST) are serialized by their own
  // `test.describe.configure({ mode: "serial" })` rather than by pinning the whole project to one
  // worker, which is what made the project take 8 minutes of wall clock to do 20 seconds of work.
  workers: process.env.CI ? 4 : undefined,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    // Resolved in `base-url.ts`, which the Maui write guard reads too: the two used to fall back to
    // different hosts, so a run with no environment set drove a browser against staging while the
    // guard read `http://localhost:3000` and concluded writes were safe.
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: "tests/maui/**",
    },
    // The Maui project is split by whether a spec DISTURBS the stack it reads.
    //
    // `runs.spec` triggers an ALL_PROGRAMS run from the UI and `worklist-writes.spec` maps a provider
    // panel (which reassigns every open case on it) and assigns a patient's gaps. With four workers
    // that run was in flight while other specs read the roster, and the first parallel CI run came back
    // "4 flaky, 22 passed" — green only because retries hid it, including a roster that read
    // "0 patients" for a full 20s. Green-by-retry is how a suite starts rotting, so the ordering is a
    // constraint here rather than a hope: `dependencies` makes Playwright finish every read-only spec
    // before the mutating ones start. Each write spec additionally refuses to run against a stack it
    // may not write to (`writesAllowed()` in `tests/maui/helpers.ts`).
    {
      name: "maui",
      testDir: "./tests/maui",
      testMatch: "tests/maui/**/*.spec.ts",
      testIgnore: MAUI_WRITE_SPECS,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "maui-writes",
      testDir: "./tests/maui",
      testMatch: MAUI_WRITE_SPECS,
      dependencies: ["maui"],
      // ONE worker, because `dependencies` orders PROJECTS and not the files inside one. With the
      // project's four workers these three files ran at the same time as each other: a fresh
      // ALL_PROGRAMS run creating and closing cases while the panel test snapshotted their assignees
      // and replayed them, and the two serial describes in `worklist-writes.spec.ts` racing for the
      // same account's count. A restore racing reality is exactly the incident this suite's write
      // guard exists to prevent, and it would have been reproduced inside the suite.
      workers: 1,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
