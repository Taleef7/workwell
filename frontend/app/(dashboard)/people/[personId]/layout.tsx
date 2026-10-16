import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Person") };

export default function PersonLayout({ children }: { children: React.ReactNode }) {
  return children;
}
