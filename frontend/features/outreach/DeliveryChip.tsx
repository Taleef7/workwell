import React from "react";
import { formatStatusLabel, metaChipClass } from "@/lib/status";

/**
 * UX-14: outreach-delivery status (NOT SENT / SIMULATED / SENT / QUEUED / FAILED) is passive delivery
 * metadata, not an actionable worklist state — so it renders in the lighter `meta` chip tier
 * (`metaChipClass`), a subtle outline + muted fill + normal weight instead of the saturated fill +
 * semibold of an actionable status chip. Label + color are preserved (WCAG); only the visual weight
 * changes. Pass `label` to keep a specific casing (e.g. the admin delivery log's raw uppercase value);
 * otherwise the status is title-cased.
 */
export function DeliveryChip({
  status,
  label,
  size = "sm",
  className = ""
}: {
  status: string | null | undefined;
  label?: React.ReactNode;
  size?: "sm" | "xs";
  className?: string;
}) {
  const sizeClass = size === "xs" ? "text-[10px]" : "text-xs";
  return (
    <span className={`${metaChipClass(status)} ${sizeClass} ${className}`.trim()}>
      {label ?? formatStatusLabel(status ?? "NOT_SENT")}
    </span>
  );
}
