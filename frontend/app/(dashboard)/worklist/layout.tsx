import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Work list") };

export default function WorkListLayout({ children }: { children: React.ReactNode }) {
  return children;
}
