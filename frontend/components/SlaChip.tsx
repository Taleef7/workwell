type Props = {
  slaRemainingDays: number | null | undefined;
  slaBreached?: boolean;
};

export function SlaChip({ slaRemainingDays, slaBreached }: Props) {
  if (slaRemainingDays == null) return null;

  // Treat negative days as breached — sla_breached is set asynchronously by the
  // scheduler every 6 hours, so the UI can receive a negative count before the
  // flag is flipped on the backend.
  const effectivelyBreached = slaBreached || slaRemainingDays < 0;

  const colorClass = effectivelyBreached
    ? "font-semibold text-red-700 dark:text-red-400"
    : slaRemainingDays <= 2
      ? "font-medium text-red-600 dark:text-red-400"
      : slaRemainingDays <= 7
        ? "text-yellow-600 dark:text-yellow-400"
        : "text-neutral-500 dark:text-neutral-400";

  return (
    <span className={colorClass} data-testid="sla-chip">
      {effectivelyBreached ? "Breached" : `${slaRemainingDays}d`}
    </span>
  );
}
