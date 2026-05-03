import Link from "next/link";

export default function WorklistPage() {
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-semibold">Worklist</h2>
      <p className="text-slate-600">
        Use the live case worklist to filter open items, review Why Flagged evidence, and run outreach plus rerun-to-verify.
      </p>
      <Link href="/cases" className="inline-flex rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
        Open Live Cases
      </Link>
    </section>
  );
}
