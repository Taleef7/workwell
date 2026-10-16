import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Patient") };

export default function PatientLayout({ children }: { children: React.ReactNode }) {
  return children;
}
