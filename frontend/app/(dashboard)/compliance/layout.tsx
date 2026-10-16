import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Compliance") };

export default function ComplianceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
