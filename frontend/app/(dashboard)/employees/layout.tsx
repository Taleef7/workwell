import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Employee") };

export default function EmployeeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
