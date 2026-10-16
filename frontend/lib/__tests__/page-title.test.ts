import { describe, expect, it } from "vitest";
import { APP_NAME, pageTitle } from "@/lib/page-title";

describe("pageTitle", () => {
  it("names the page and carries the template on, so a nested route's title keeps the app name", () => {
    expect(pageTitle("Programs")).toEqual({ default: "Programs", template: `%s · ${APP_NAME}` });
  });
});
