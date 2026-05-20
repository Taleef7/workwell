import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Opening sandbox",
  description: "Automatic demo entry for WorkWell Measure Studio.",
  robots: {
    index: false,
    follow: false
  }
};

export default function SandboxLayout({ children }: { children: React.ReactNode }) {
  return children;
}
