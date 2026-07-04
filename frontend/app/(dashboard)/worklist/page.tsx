import { redirect } from "next/navigation";

// UX-2: /worklist was a dead-end interstitial (a signpost telling users to go to /cases, with a
// low-contrast hero heading) occupying a first-class, badged nav slot. The real worklist IS the open-case
// queue, so this route now redirects straight to it — the nav item lands on the working cases view instead
// of a signpost, and the contrast issue is moot (the page is gone).
//
// The nav appends the shared global filters (site/date) to every item href, so forward them onto the
// redirect target — otherwise clicking Worklist would silently reset the site/date filter on /cases.
export default async function WorklistPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams({ status: "open" });
  for (const key of ["site", "from", "to"] as const) {
    const value = sp[key];
    if (typeof value === "string" && value) params.set(key, value);
  }
  redirect(`/cases?${params.toString()}`);
}
