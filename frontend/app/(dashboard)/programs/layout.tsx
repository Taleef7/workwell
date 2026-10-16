import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Programs") };

export default function ProgramsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
