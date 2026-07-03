import type { CSSProperties } from "react";
import type { Theme } from "@/lib/useTheme";

/**
 * Padded y-axis bounds so real variation is visible in compliance trend charts.
 *
 * A fixed [0,100] domain flattens a series that lives in (say) 74–82% into a
 * near-flat line; this zooms to the data's actual range with ~15% headroom
 * (minimum 4 points), clamped to [0,100]. A flat series gets a small ±5 window so
 * it isn't drawn as a hairline against the axis.
 */
export function niceDomain(values: number[]): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [0, 100];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) {
    return [Math.max(0, Math.floor(min - 5)), Math.min(100, Math.ceil(max + 5))];
  }
  const pad = Math.max(4, (max - min) * 0.15);
  return [Math.max(0, Math.floor(min - pad)), Math.min(100, Math.ceil(max + pad))];
}

/**
 * Theme-aware Recharts `<Tooltip>` style props. Recharts defaults its tooltip content box to a
 * hardcoded white background, so a chart's `contentStyle` that only overrides the border (the
 * pre-existing pattern across the dashboard charts) still renders a white tooltip in dark mode —
 * unreadable against the app's dark card background. Pass the current `theme` (from `useTheme()`)
 * so the tooltip box, label, and item text all follow the runtime dark-mode toggle.
 */
export function chartTooltipStyle(theme: Theme): {
  contentStyle: CSSProperties;
  labelStyle: CSSProperties;
  itemStyle: CSSProperties;
} {
  const dark = theme === "dark";
  return {
    contentStyle: {
      fontSize: 11,
      borderRadius: 6,
      border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`,
      backgroundColor: dark ? "#1e293b" : "#ffffff",
      color: dark ? "#e2e8f0" : "#0f172a",
    },
    labelStyle: { fontSize: 11, color: dark ? "#94a3b8" : "#475569" },
    itemStyle: { color: dark ? "#e2e8f0" : "#0f172a" },
  };
}
