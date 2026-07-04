/**
 * A single, consistent "you don't have access" state (UX-16): a titled section + an amber explanatory
 * card. Replaces the ad-hoc per-page treatments (purpose-built cards on /campaigns and /orders, a raw
 * error string on /people, silent empty states elsewhere) so RBAC-gated surfaces read the same way.
 */
export function AccessDenied({ title, message }: { title: string; message: string }) {
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
      {/* No aria-live role: this renders at mount (an early return), where live regions aren't announced;
          the <h2> already conveys the state to assistive tech. */}
      <div className="rounded-md border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        {message}
      </div>
    </section>
  );
}
