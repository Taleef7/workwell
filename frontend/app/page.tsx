import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces } from "next/font/google";
import { ArrowRight } from "lucide-react";

const fraunces = Fraunces({ subsets: ["latin"], weight: ["600", "700"] });

const repoUrl = "https://github.com/Taleef7/workwell";
const videoUrl = "https://www.youtube.com/shorts/SgzDt4TBd9k?si=vHE9vppgxeGO6OM8";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "WorkWell Measure Studio";
const APP_TAGLINE = process.env.NEXT_PUBLIC_APP_TAGLINE ?? "A clean operating surface for occupational-health compliance.";
const APP_DESCRIPTION = process.env.NEXT_PUBLIC_APP_DESCRIPTION ?? "Four measures, complete case management, and a full audit trail — one reviewable dashboard.";
const [APP_BADGE, ...appRest] = APP_NAME.split(" ");
const APP_SUBTITLE = appRest.join(" ") || "Measure Studio";

const capabilities = [
  "Programs & outcomes",
  "Case worklist",
  "CQL Measure Studio",
  "Audit trail & exports",
];

export const metadata: Metadata = {
  title: APP_NAME,
  description: `${APP_NAME} — ${APP_TAGLINE}`,
};

export default function HomePage() {
  return (
    <main className="flex min-h-dvh flex-col bg-neutral-50 text-neutral-950 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 pb-12 pt-6 sm:px-8">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className="flex items-center justify-between gap-4">
          <Link
            href="/"
            className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-900 dark:bg-neutral-100 dark:text-neutral-900 text-[10px] font-bold tracking-[0.2em] text-white">
              WW
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-semibold text-neutral-950 dark:text-neutral-100">{APP_BADGE}</span>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">{APP_SUBTITLE}</span>
            </span>
          </Link>

          <nav className="flex items-center gap-5 text-sm" aria-label="Primary">
            <a
              href={videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Watch product walkthrough video"
              className="text-neutral-600 dark:text-neutral-400 transition-colors hover:text-neutral-950 dark:hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2"
            >
              Walkthrough
            </a>
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View source on GitHub"
              className="text-neutral-600 dark:text-neutral-400 transition-colors hover:text-neutral-950 dark:hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2"
            >
              GitHub
            </a>
          </nav>
        </header>

        {/* ── Hero ───────────────────────────────────────────────────── */}
        <section className="flex flex-1 flex-col justify-center py-12">
          <p className="text-xs font-semibold uppercase tracking-[0.26em] text-neutral-500 dark:text-neutral-400">
            Public sandbox · No login required
          </p>

          <h1
            className={`${fraunces.className} mt-5 max-w-3xl text-4xl leading-[1.05] tracking-tight text-neutral-950 dark:text-neutral-100 sm:text-5xl lg:text-6xl`}
          >
            {APP_TAGLINE}
          </h1>

          <p className="mt-5 max-w-2xl text-base leading-7 text-neutral-600 dark:text-neutral-400 sm:text-lg">
            {APP_DESCRIPTION}
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Link
              href="/sandbox"
              className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
            >
              Open sandbox
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-300 transition-colors hover:text-neutral-950 dark:hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2"
            >
              Sign in
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          <a
            href={videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 w-fit text-sm text-neutral-500 dark:text-neutral-400 underline-offset-4 transition-colors hover:text-neutral-700 dark:hover:text-neutral-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2"
          >
            Watch the 5-min walkthrough →
          </a>

          <div className="mt-10 border-t border-neutral-200 dark:border-neutral-800 pt-6">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-500 dark:text-neutral-400">
              {capabilities.map((item, index) => (
                <span key={item} className="flex items-center gap-x-3">
                  {index > 0 && <span aria-hidden="true" className="text-neutral-300 dark:text-neutral-600">·</span>}
                  <span>{item}</span>
                </span>
              ))}
            </p>
          </div>
        </section>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <footer className="border-t border-neutral-200 dark:border-neutral-800 pt-6 text-xs text-neutral-500 dark:text-neutral-400">
          © {APP_NAME} — {APP_TAGLINE}
        </footer>
      </div>
    </main>
  );
}
