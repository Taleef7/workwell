export function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-md border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div className="space-y-1.5">
          <div className="h-4 w-36 rounded bg-slate-200" />
          <div className="h-3 w-24 rounded bg-slate-100" />
        </div>
        <div className="h-7 w-14 rounded bg-slate-200" />
      </div>
      <div className="flex gap-2">
        {[40, 56, 48, 64, 44].map((w, i) => (
          <div key={i} className="h-5 rounded-full bg-slate-100" style={{ width: w }} />
        ))}
      </div>
      <div className="h-[90px] rounded bg-slate-100" />
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <div className="h-3 w-16 rounded bg-slate-200" />
          <div className="h-3 w-24 rounded bg-slate-100" />
          <div className="h-3 w-20 rounded bg-slate-100" />
        </div>
        <div className="space-y-1">
          <div className="h-3 w-16 rounded bg-slate-200" />
          <div className="h-3 w-24 rounded bg-slate-100" />
          <div className="h-3 w-20 rounded bg-slate-100" />
        </div>
      </div>
    </div>
  );
}

export function SkeletonRow({ cols = 6 }: { cols?: number }) {
  const widths = [120, 80, 60, 72, 96, 56, 80, 64];
  return (
    <tr className="animate-pulse border-t border-slate-200">
      {Array.from({ length: cols }, (_, i) => (
        <td key={i} className="px-3 py-3">
          <div className="h-3.5 rounded bg-slate-200" style={{ width: widths[i % widths.length] }} />
        </td>
      ))}
    </tr>
  );
}
