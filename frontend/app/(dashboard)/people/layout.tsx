import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("People") };

export default function PeopleLayout({ children }: { children: React.ReactNode }) {
  return children;
}
