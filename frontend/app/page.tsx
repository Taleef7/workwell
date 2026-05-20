import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces } from "next/font/google";
import { ArrowRight, ExternalLink } from "lucide-react";

const fraunces = Fraunces({ subsets: ["latin"], weight: ["600", "700"] });

const repoUrl = "https://github.com/Taleef7/workwell";
const videoUrl = "https://www.youtube.com/shorts/SgzDt4TBd9k?si=vHE9vppgxeGO6OM8";

const capabilities = [
  "Programs & outcomes",
  "Case worklist",
  "CQL Measure Studio",
  "Audit trail & exports",
];

export const metadata: Metadata = {
  title: "WorkWell Measure Studio",
  description: "Occupational-health compliance operations for modern programs.",
};

export default function HomePage() {
  return (
    <main className="flex min-h-dvh flex-col bg-slate-50 text-slate-950">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 pb-12 pt-6 sm:px-8">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className="flex items-center justify-between gap-4">
          <Link
            href="/"
            className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-[10px] font-bold tracking-[0.2em] text-white">
              WW
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-semibold text-slate-950">WorkWell</span>
              <span className="text-xs text-slate-500">Measure Studio</span>
            </span>
          </Link>

          <nav className="flex items-center gap-5 text-sm" aria-label="Primary">
            <a
              href={videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Watch product walkthrough video"
              className="text-slate-600 transition-colors hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
            >
              Walkthrough
            </a>
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View source on GitHub"
              className="text-slate-600 transition-colors hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
            >
              GitHub
            </a>
          </nav>
        </header>

        {/* ── Hero ───────────────────────────────────────────────────── */}
        <section className="flex flex-1 flex-col justify-center py-12">
          <p className="text-xs font-semibold uppercase tracking-[0.26em] text-slate-500">
            Public sandbox · No login required
          </p>

          <h1
            className={`${fraunces.className} mt-5 max-w-3xl text-4xl leading-[1.05] tracking-tight text-slate-950 sm:text-5xl lg:text-6xl`}
          >
            A clean operating surface for occupational-health compliance.
          </h1>

          <p className="mt-5 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
            Four measures, complete case management, and a full audit trail —
            one reviewable dashboard.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Link
              href="/sandbox"
              className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
            >
              Open sandbox
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700 transition-colors hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
            >
              Sign in
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          <a
            href={videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 inline-flex w-fit items-center gap-1.5 text-sm text-slate-500 underline-offset-4 transition-colors hover:text-slate-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
          >
            Watch the 5-min walkthrough
            <ExternalLink className="h-3.5 w-3.5" />
          </a>

          <div className="mt-10 border-t border-slate-200 pt-6">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
              {capabilities.map((item, index) => (
                <span key={item} className="flex items-center gap-x-3">
                  {index > 0 && <span aria-hidden="true" className="text-slate-300">·</span>}
                  <span>{item}</span>
                </span>
              ))}
            </p>
          </div>
        </section>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <footer className="border-t border-slate-200 pt-6 text-xs text-slate-500">
          © WorkWell Measure Studio — compliance operations for occupational health.
        </footer>
      </div>
    </main>
  );
}
