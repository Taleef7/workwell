import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Measure results") };

export default function MeasureResultsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
