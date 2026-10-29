import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Scorecard") };

export default function ScorecardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
