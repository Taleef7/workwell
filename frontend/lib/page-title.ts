import type { Metadata } from "next";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "WorkWell Measure Studio";

/**
 * A route's browser-tab title (WCAG 2.4.2): "Work list · WorkWell Maui". It passes the template on, because
 * a plain string title stops the root layout's template at that segment, and a nested route's own title
 * ("Case") would then show without the app name.
 */
export function pageTitle(name: string): NonNullable<Metadata["title"]> {
  return { default: name, template: `%s · ${APP_NAME}` };
}
