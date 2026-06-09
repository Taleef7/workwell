import Link from "next/link";

export default function WorklistPage() {
  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-950 p-8 text-white shadow-lg">
        <p className="text-sm uppercase tracking-[0.3em] text-neutral-300">Worklist</p>
        <h2 className="mt-2 text-3xl font-semibold">Live cases, excluded cases, and follow-up</h2>
        <p className="mt-3 max-w-2xl text-neutral-300">
          The live worklist lives on the cases page. Use the status tabs there to jump between open items, closed items,
          and the new excluded-waiver view without leaving the dashboard.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Link
          href="/cases"
          className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm transition hover:border-neutral-300 dark:hover:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
        >
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">Open worklist</p>
          <h3 className="mt-2 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Open live cases</h3>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">Review outreach, rerun-to-verify, and bulk assign from the current case queue.</p>
        </Link>

        <Link
          href="/cases?status=excluded"
          className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm transition hover:border-neutral-300 dark:hover:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
        >
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">Waiver view</p>
          <h3 className="mt-2 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Excluded cases</h3>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">See active exclusions, waiver expiry dates, and rerun recommendations in one place.</p>
        </Link>
      </div>
    </section>
  );
}
