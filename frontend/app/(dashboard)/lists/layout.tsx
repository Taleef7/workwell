import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Lists") };

export default function ListsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
