type Props = {
  slaRemainingDays: number | null | undefined;
  slaBreached?: boolean;
};

export function SlaChip({ slaRemainingDays, slaBreached }: Props) {
  if (slaRemainingDays == null) return null;

  const colorClass = slaBreached
    ? "font-semibold text-red-700"
    : slaRemainingDays <= 2
      ? "font-medium text-red-600"
      : slaRemainingDays <= 7
        ? "text-yellow-600"
        : "text-slate-500";

  return (
    <dd className={colorClass} data-testid="sla-chip">
      {slaBreached ? "Breached" : `${slaRemainingDays}d`}
    </dd>
  );
}
