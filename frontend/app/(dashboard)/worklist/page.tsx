import { redirect } from "next/navigation";

// UX-2: /worklist was a dead-end interstitial (a signpost telling users to go to /cases, with a
// low-contrast hero heading) occupying a first-class, badged nav slot. The real worklist IS the open-case
// queue, so this route now redirects straight to it — the nav item lands on the working cases view instead
// of a signpost, and the contrast issue is moot (the page is gone).
export default function WorklistPage() {
  redirect("/cases?status=open");
}
