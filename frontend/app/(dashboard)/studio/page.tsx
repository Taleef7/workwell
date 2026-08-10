/**
 * Studio landing page.
 *
 * This route used to `redirect("/measures")`, which made the sidebar's Studio entry indistinguishable
 * from Measures and left `/studio/elm` reachable only by typing the URL — nothing anywhere in the app
 * linked to it. The ELM Explorer is the one screen that shows compiled ELM beside its CQL source, so
 * an unlinked route meant the answer to "where can I see the compiled logic?" was "you can't, unless
 * you already know the path".
 *
 * Both authoring entry points now live here. Per-measure authoring still happens at `/studio/{id}`,
 * reached by picking a measure — the Studio needs a measure in hand, so the list stays the way in.
 */
import Link from "next/link";
import { FileClock, ListTree } from "lucide-react";

const ENTRIES = [
  {
    href: "/measures",
    icon: FileClock,
    title: "Browse measures",
    body:
      "Pick a measure to open its Studio: spec, CQL source, rule builder, value sets, test fixtures, " +
      "release approval, traceability and standards claims.",
    cta: "Open the measure list",
  },
  {
    href: "/studio/elm",
    icon: ListTree,
    title: "ELM Explorer",
    body:
      "Compiled ELM beside the CQL it came from. Edit the CQL and the tree rebuilds live — the " +
      "translator runs in Node with no JVM in the path. Click a node to highlight its CQL span.",
    cta: "Open the ELM Explorer",
  },
] as const;

export default function StudioPage() {
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Studio</h2>
        <p className="mt-1 max-w-3xl text-sm text-neutral-600 dark:text-neutral-400">
          Where measures are authored, compiled and released. CQL is the human-authored source of
          truth; the translator compiles it to ELM at build time, and the engine executes that ELM to
          compute compliance.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {ENTRIES.map(({ href, icon: Icon, title, body, cta }) => (
          <Link
            key={href}
            href={href}
            className="group flex flex-col rounded-lg border border-neutral-200 bg-white p-5 transition-colors hover:border-neutral-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-600"
          >
            <Icon aria-hidden className="h-5 w-5 text-neutral-500 dark:text-neutral-400" />
            <h3 className="mt-3 text-base font-semibold text-neutral-900 dark:text-neutral-100">{title}</h3>
            <p className="mt-1 flex-1 text-sm text-neutral-600 dark:text-neutral-400">{body}</p>
            <span className="mt-3 text-sm font-medium text-neutral-900 group-hover:underline dark:text-neutral-100">
              {cta} →
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
