"use client";

import { Skeleton } from "@mieweb/ui";

export function SkeletonCard() {
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-4 space-y-3 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-start justify-between">
        <div className="space-y-1.5">
          <Skeleton width={144} height={16} />
          <Skeleton width={96} height={12} />
        </div>
        <Skeleton width={56} height={28} />
      </div>
      <div className="flex gap-2">
        {[40, 56, 48, 64, 44].map((w, i) => (
          <Skeleton key={i} width={w} height={20} className="rounded-full" />
        ))}
      </div>
      <Skeleton height={90} className="w-full" />
      <div className="grid grid-cols-2 gap-2">
        {[0, 1].map((col) => (
          <div key={col} className="space-y-1">
            <Skeleton width={64} height={12} />
            <Skeleton width={96} height={12} />
            <Skeleton width={80} height={12} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonRow({ cols = 6 }: { cols?: number }) {
  const widths = [120, 80, 60, 72, 96, 56, 80, 64];
  return (
    <tr className="border-t border-neutral-200 dark:border-neutral-800">
      {Array.from({ length: cols }, (_, i) => (
        <td key={i} className="px-3 py-3">
          <Skeleton variant="text" height={14} width={widths[i % widths.length]} />
        </td>
      ))}
    </tr>
  );
}
