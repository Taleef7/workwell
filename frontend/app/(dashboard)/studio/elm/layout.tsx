import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("ELM Explorer") };

export default function ElmExplorerLayout({ children }: { children: React.ReactNode }) {
  return children;
}
