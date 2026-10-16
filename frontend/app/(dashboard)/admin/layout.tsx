import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Admin") };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
