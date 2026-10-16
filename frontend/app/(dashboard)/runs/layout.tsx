import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Runs") };

export default function RunsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
