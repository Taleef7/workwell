import { request } from "@playwright/test";
import { ensureCompletedRun } from "./tests/maui/helpers";

export default async function globalSetup() {
  if (process.env.PLAYWRIGHT_PROFILE !== "maui") return;

  const api = await request.newContext();
  try {
    await ensureCompletedRun(api);
  } finally {
    await api.dispose();
  }
}
