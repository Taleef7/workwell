import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Measures") };

export default function MeasuresLayout({ children }: { children: React.ReactNode }) {
  return children;
}
