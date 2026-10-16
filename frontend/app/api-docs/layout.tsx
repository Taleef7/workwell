import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("API") };

export default function ApiLayout({ children }: { children: React.ReactNode }) {
  return children;
}
