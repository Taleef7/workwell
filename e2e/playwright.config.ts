import { defineConfig, devices } from "@playwright/test";

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
    // STAGING by default, never production: this suite mutates (it triggers runs and POSTs outreach),
    // and those writes land in the audit log of whatever stack it points at. The previous default was
    // the decommissioned Vercel host, so every run timed out against a 404.
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "https://twh-staging.os.mieweb.org",
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
    // `runs.spec` triggers an ALL_PROGRAMS run from the UI. With four workers that run was in flight
    // while other specs read the roster, and the first parallel CI run came back "4 flaky, 22 passed" —
    // green only because retries hid it, including a roster that read "0 patients" for a full 20s.
    // Green-by-retry is how a suite starts rotting, so the ordering is a constraint here rather than a
    // hope: `dependencies` makes Playwright finish every read-only spec before the mutating one starts.
    {
      name: "maui",
      testDir: "./tests/maui",
      testMatch: "tests/maui/**/*.spec.ts",
      testIgnore: "tests/maui/runs.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "maui-writes",
      testDir: "./tests/maui",
      testMatch: "tests/maui/runs.spec.ts",
      dependencies: ["maui"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
