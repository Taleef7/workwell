import type { Metadata } from "next";
import "./globals.css";
import { geistSans, geistMono } from "./fonts";
import { ClientProviders } from "@/components/client-providers";
import { ThemeScript } from "@/components/theme-script";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "WorkWell Measure Studio";
const APP_TAGLINE = process.env.NEXT_PUBLIC_APP_TAGLINE ?? "occupational-health compliance.";

export const metadata: Metadata = {
  title: APP_NAME,
  description: `${APP_NAME} — ${APP_TAGLINE}`,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full`}
    >
      <body className="min-h-full">
        <ThemeScript />
        <ClientProviders>{children}</ClientProviders>
      </body>
    </html>
  );
}
