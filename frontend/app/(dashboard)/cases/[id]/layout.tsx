import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Case") };

export default function CaseLayout({ children }: { children: React.ReactNode }) {
  return children;
}
