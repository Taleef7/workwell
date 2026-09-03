import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  timeout: 60_000,
  retries: 1,
  workers: 1,
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
