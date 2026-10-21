import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";

export const metadata: Metadata = {
  title: pageTitle("Connect an MCP client"),
  description: "Approve or decline an MCP client's request to read WorkWell data as you.",
  robots: { index: false, follow: false },
};

export default function ConsentLayout({ children }: { children: React.ReactNode }) {
  return children;
}
