import type { Metadata } from "next";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "WorkWell Measure Studio";

export const metadata: Metadata = {
  title: "Opening sandbox",
  description: `Automatic demo entry for ${APP_NAME}.`,
  robots: {
    index: false,
    follow: false
  }
};

export default function SandboxLayout({ children }: { children: React.ReactNode }) {
  return children;
}
