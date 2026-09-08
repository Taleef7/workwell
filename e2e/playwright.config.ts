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
    {
      name: "maui",
      testDir: "./tests/maui",
      testMatch: "tests/maui/**/*.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
