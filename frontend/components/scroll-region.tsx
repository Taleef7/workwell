import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A wide table's horizontal scroller that says it scrolls (#700). A bare `overflow-x-auto` hid columns
 * behind a sideways scroll nobody could see: on a phone the Work list showed Patient and PCP, and Open
 * gaps, Owner and selection sat off screen with no hint. Here the edge that has more content casts a
 * shadow (`.scroll-cue` in globals.css; pure CSS, the shadows follow the scroll position), and the
 * region is labelled and focusable so a keyboard user can scroll it with the arrow keys.
 *
 * Pass the container's look (border, radius, background) through `className`; a background other than
 * the page's default card colour should also set `--scroll-cue-bg` so the fades match it.
 */
export function ScrollRegion({
  label,
  className,
  children,
}: {
  /** Names the region for assistive tech, e.g. "Work list table". */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        "scroll-cue overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500",
        className,
      )}
    >
      {children}
    </div>
  );
}
