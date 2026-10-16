/**
 * Every page names itself in the browser tab (WCAG 2.4.2, Level A). Only the root title existed, so every
 * tab read "WorkWell Maui" and a screen reader announced nothing on navigation. A route's own `layout.tsx`
 * sets its title with `pageTitle`, which carries the root layout's template down to nested routes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(__dirname, "..");
// The landing page is the app itself; the two shell layouts own no title of their own.
const UNTITLED_PAGES = new Set(["page.tsx"]);
const SHELL_LAYOUTS = new Set(["layout.tsx", join("(dashboard)", "layout.tsx")]);

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "__tests__" || name === "node_modules") return [];
    if (statSync(path).isDirectory()) return pages(path);
    return name === "page.tsx" ? [path] : [];
  });
}

// Through `pageTitle`, never a plain string: a plain title stops the root template at its segment, so a
// nested page's tab ("Case") would lose the app name.
const titleIn = (layout: string): string | null =>
  readFileSync(layout, "utf8").match(/export const metadata: Metadata = \{[^}]*?\btitle: pageTitle\("([^"]+)"\)/)?.[1] ?? null;

/** The title the nearest route layout gives a page, or null when only the shell layouts are above it. */
function titleFor(page: string): string | null {
  for (let dir = dirname(page); relative(APP, dir) !== ".."; dir = dirname(dir)) {
    const layout = join(dir, "layout.tsx");
    if (SHELL_LAYOUTS.has(relative(APP, layout))) continue;
    try {
      return titleIn(layout) ?? `untitled layout ${relative(APP, layout)}`;
    } catch {
      /* no layout at this level */
    }
  }
  return null;
}

describe("route titles", () => {
  const all = pages(APP).filter((p) => !UNTITLED_PAGES.has(relative(APP, p)));

  it("finds the app's pages", () => {
    expect(all.length).toBeGreaterThan(15);
  });

  it.each(all.map((p) => [relative(APP, p)]))("%s has a title of its own", (page) => {
    const title = titleFor(join(APP, page));
    expect(title, `${page} shows only the app name in its tab`).not.toBeNull();
    expect(title).not.toMatch(/^untitled layout/);
  });

  it("no two sections share a title", () => {
    // A detail page (`[id]`) may share its section's name; two different sections may not.
    const sectionTitles = all.filter((p) => !relative(APP, p).includes("[")).map(titleFor);
    expect(new Set(sectionTitles).size).toBe(sectionTitles.length);
  });

  it("the root layout completes each title with the app name", () => {
    const root = readFileSync(join(APP, "layout.tsx"), "utf8");
    expect(root).toMatch(/title: \{ default: APP_NAME, template: `%s · \$\{APP_NAME\}` \}/);
  });
});
