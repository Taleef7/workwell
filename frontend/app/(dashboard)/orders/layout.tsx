import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Orders") };

export default function OrdersLayout({ children }: { children: React.ReactNode }) {
  return children;
}
