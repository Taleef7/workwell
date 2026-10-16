import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Hierarchy") };

export default function HierarchyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
