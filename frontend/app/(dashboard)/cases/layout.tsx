import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Cases") };

export default function CasesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
