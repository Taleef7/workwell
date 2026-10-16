import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = { title: pageTitle("Campaigns") };

export default function CampaignsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
