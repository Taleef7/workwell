import Link from "next/link";

export default function ProgramsPage() {
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-semibold">Programs</h2>
      <p className="text-slate-600">
        Program administration is out of scope for D16, but the live demo paths are available below.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Link href="/measures" className="rounded-lg border border-slate-200 bg-white p-4 hover:bg-slate-50">
          <h3 className="font-medium text-slate-900">Measure Catalog</h3>
          <p className="mt-1 text-sm text-slate-600">View active measures and create a new draft.</p>
        </Link>
        <Link href="/runs" className="rounded-lg border border-slate-200 bg-white p-4 hover:bg-slate-50">
          <h3 className="font-medium text-slate-900">Test Runs</h3>
          <p className="mt-1 text-sm text-slate-600">Trigger Audiogram and TB runs with persisted outcomes.</p>
        </Link>
      </div>
    </section>
  );
}
