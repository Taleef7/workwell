import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces } from "next/font/google";
import {
  ArrowRight,
  BadgeCheck,
  ExternalLink,
  Layers3,
  LayoutDashboard,
  LogIn,
  PlayCircle,
  ShieldCheck,
  Sparkles,
  Video,
} from "lucide-react";

const fraunces = Fraunces({ subsets: ["latin"], weight: ["600", "700"] });

const repoUrl = "https://github.com/Taleef7/workwell";
const videoUrl = "https://www.youtube.com/shorts/SgzDt4TBd9k?si=vHE9vppgxeGO6OM8";

const stats = [
  { value: "4", label: "Compliance measures" },
  { value: "50+", label: "Employees tracked" },
  { value: "5", label: "Outcome types" },
  { value: "1 click", label: "Sandbox entry" },
];

const featureCards = [
  {
    icon: LayoutDashboard,
    title: "Monday-morning dashboard",
    body: "KPI row, measure cards, trend lines, and run-all — one operating view.",
  },
  {
    icon: ShieldCheck,
    title: "Auditable case flow",
    body: "Worklist, outreach, evidence, and audit packets stay connected.",
  },
  {
    icon: Layers3,
    title: "Measure Studio",
    body: "Spec, CQL, value sets, traceability, and activation in one place.",
  },
  {
    icon: Sparkles,
    title: "AI-assisted authoring",
    body: "Draft specs and explain flagged cases — compliance stays with CQL.",
  },
];

const sandboxSections = [
  "Programs & outcome trends",
  "Case worklist & outreach",
  "CQL Measure Studio",
  "Audit trail & exports",
];

const operatingNotes = [
  "No login required",
  "Opens to Programs dashboard",
  "Full source on GitHub",
];

export const metadata: Metadata = {
  title: "WorkWell Measure Studio",
  description: "Occupational-health compliance operations for modern programs.",
};

export default function HomePage() {
  return (
    <main className="relative min-h-dvh overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(15,23,42,0.14),_transparent_34%),radial-gradient(circle_at_top_right,_rgba(14,165,233,0.18),_transparent_28%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_44%,_#ffffff_100%)] text-slate-950">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(15,23,42,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(15,23,42,0.04)_1px,transparent_1px)] bg-[size:56px_56px] opacity-35" />
      <div className="absolute left-[-8rem] top-[-6rem] h-72 w-72 rounded-full bg-sky-400/15 blur-3xl" />
      <div className="absolute right-[-7rem] top-16 h-80 w-80 rounded-full bg-slate-900/10 blur-3xl" />

      <div className="relative mx-auto flex min-h-dvh w-full max-w-7xl flex-col px-5 pb-16 pt-5 sm:px-8 lg:px-10">

        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/"
            className="flex items-center gap-3 rounded-2xl border border-slate-200/80 bg-white/70 px-3 py-2.5 shadow-[0_10px_40px_-28px_rgba(15,23,42,0.35)] backdrop-blur focus:outline-none focus:ring-2 focus:ring-slate-400"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 text-[11px] font-bold tracking-[0.22em] text-white">
              WW
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">WorkWell</span>
              <span className="text-sm font-medium text-slate-950">Measure Studio</span>
            </span>
          </Link>

          <nav className="flex flex-wrap items-center gap-2 text-sm" aria-label="Primary">
            <a
              href={videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Watch walkthrough"
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/75 px-3.5 py-2 text-slate-700 transition hover:border-slate-300 hover:bg-white hover:text-slate-950"
            >
              <Video className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Walkthrough</span>
            </a>
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub repository"
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/75 px-3.5 py-2 text-slate-700 transition hover:border-slate-300 hover:bg-white hover:text-slate-950"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">GitHub</span>
            </a>
            <Link
              href="/login"
              aria-label="Sign in"
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white/80 px-3.5 py-2 text-slate-700 transition hover:border-slate-400 hover:bg-white hover:text-slate-950"
            >
              <LogIn className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Sign in</span>
            </Link>
            <Link
              href="/sandbox"
              className="inline-flex items-center gap-1.5 rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-[0_12px_30px_-12px_rgba(15,23,42,0.55)] transition hover:-translate-y-0.5 hover:bg-slate-800"
            >
              Try sandbox
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </nav>
        </header>

        {/* ── Hero ───────────────────────────────────────────────────── */}
        <section className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
          <div className="max-w-3xl">
            <p className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/75 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.26em] text-slate-600 shadow-[0_10px_24px_-20px_rgba(15,23,42,0.35)] backdrop-blur">
              <PlayCircle className="h-3.5 w-3.5" />
              Public sandbox · No login required
            </p>

            <h1 className={`${fraunces.className} mt-5 text-5xl leading-[0.95] tracking-tight text-slate-950 sm:text-6xl lg:text-[4.25rem]`}>
              A clean operating surface for occupational-health compliance.
            </h1>

            <p className="mt-5 max-w-xl text-base leading-7 text-slate-600 sm:text-lg">
              Four compliance measures, complete case management, and a full audit trail — one reviewable dashboard.
            </p>

            {/* Stats strip */}
            <div className="mt-7 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {stats.map((stat) => (
                <div
                  key={stat.label}
                  className="rounded-2xl border border-slate-200/90 bg-white/70 p-4 backdrop-blur"
                >
                  <p className="text-2xl font-bold tabular-nums text-slate-950">{stat.value}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{stat.label}</p>
                </div>
              ))}
            </div>

            {/* CTAs */}
            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                href="/sandbox"
                className="inline-flex items-center gap-2 rounded-full bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_14px_40px_-18px_rgba(15,23,42,0.6)] transition hover:-translate-y-0.5 hover:bg-slate-800"
              >
                Try the sandbox
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white/80 px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-white hover:text-slate-950"
              >
                <LogIn className="h-4 w-4" />
                Sign in
              </Link>
              <a
                href={repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-white hover:text-slate-950"
              >
                GitHub
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>

            {/* Operating notes */}
            <div className="mt-5 flex flex-wrap gap-2">
              {operatingNotes.map((note) => (
                <span
                  key={note}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/60 px-3 py-1.5 text-xs text-slate-500 backdrop-blur"
                >
                  <BadgeCheck className="h-3.5 w-3.5 text-emerald-600" />
                  {note}
                </span>
              ))}
            </div>
          </div>

          {/* Sandbox preview card */}
          <div className="relative">
            <div className="absolute inset-0 -rotate-3 rounded-[2.5rem] border border-slate-200/80 bg-white/40 shadow-[0_24px_80px_-40px_rgba(15,23,42,0.45)]" />
            <div className="relative overflow-hidden rounded-[2rem] border border-slate-200/90 bg-white/80 p-6 shadow-[0_30px_100px_-50px_rgba(15,23,42,0.55)] backdrop-blur">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Sandbox preview</p>
                  <h2 className={`${fraunces.className} mt-3 text-3xl leading-tight text-slate-950`}>
                    Open the dashboard in one click.
                  </h2>
                </div>
                <span className="shrink-0 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
                  No login
                </span>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Opens to</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-950">Programs</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">KPI row, measure cards, and run-all.</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Entry</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-950">1 click</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">Auto sign-in, straight into the app.</p>
                </div>
              </div>

              <div className="mt-4 rounded-[1.5rem] border border-slate-900 bg-slate-950 p-4 text-white">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-400">What&apos;s inside</p>
                  <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium text-slate-200">Demo-safe</span>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-slate-300 sm:grid-cols-2">
                  {sandboxSections.map((section) => (
                    <div key={section} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                      <BadgeCheck className="h-3 w-3 shrink-0 text-emerald-400" />
                      {section}
                    </div>
                  ))}
                </div>
              </div>

              <Link
                href="/sandbox"
                className="mt-4 flex items-center justify-center gap-2 rounded-2xl bg-slate-950 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                Open sandbox
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>

        {/* ── Feature cards ──────────────────────────────────────────── */}
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {featureCards.map((card) => {
            const Icon = card.icon;
            return (
              <article
                key={card.title}
                className="rounded-[1.75rem] border border-slate-200/90 bg-white/80 p-5 shadow-[0_20px_60px_-45px_rgba(15,23,42,0.45)] backdrop-blur transition hover:-translate-y-1 hover:border-slate-300 hover:bg-white"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 text-white">
                  <Icon className="h-4 w-4" />
                </div>
                <h3 className={`${fraunces.className} mt-4 text-xl text-slate-950`}>{card.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{card.body}</p>
              </article>
            );
          })}
        </section>

        {/* ── Walkthrough + video ────────────────────────────────────── */}
        <section className="mt-8 grid gap-6 lg:grid-cols-[1.02fr_0.98fr]">
          <div className="rounded-[2rem] border border-slate-200/90 bg-white/80 p-6 shadow-[0_24px_80px_-55px_rgba(15,23,42,0.5)] backdrop-blur">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Walkthrough video</p>
            <h2 className={`${fraunces.className} mt-3 text-3xl leading-tight text-slate-950 sm:text-4xl`}>
              The full product story in under five minutes.
            </h2>
            <p className="mt-3 text-sm leading-7 text-slate-600">
              Author a measure, run it across the workforce, triage open cases, and export an audit packet.
            </p>

            <div className="mt-5 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-500">
                <Video className="h-3.5 w-3.5 text-slate-700" />
                Short-form
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-500">
                <BadgeCheck className="h-3.5 w-3.5 text-emerald-600" />
                No guided tour needed
              </span>
            </div>

            <div className="mt-6 flex gap-3">
              <Link
                href="/login"
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-slate-300 bg-white py-3 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
              >
                <LogIn className="h-4 w-4" />
                Sign in
              </Link>
              <Link
                href="/sandbox"
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-slate-950 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                Open sandbox
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>

          {/* Video click-through card */}
          <div className="overflow-hidden rounded-[2rem] border border-slate-200/90 bg-slate-950 shadow-[0_24px_80px_-40px_rgba(15,23,42,0.6)]">
            <a
              href={videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative block aspect-video overflow-hidden"
              aria-label="Open the WorkWell walkthrough video on YouTube"
            >
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.32),_transparent_36%),radial-gradient(circle_at_bottom_right,_rgba(255,255,255,0.12),_transparent_32%),linear-gradient(135deg,_rgba(15,23,42,0.95),_rgba(15,23,42,0.72)_42%,_rgba(8,47,73,0.92)_100%)]" />
              <div className="relative flex h-full flex-col justify-between p-6 text-white">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-300">Walkthrough</p>
                  <h3 className="mt-2 max-w-xs text-2xl font-semibold leading-tight text-white">
                    A short demo that tells the story fast.
                  </h3>
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-slate-950 shadow-[0_10px_30px_-10px_rgba(255,255,255,0.55)] transition group-hover:scale-105">
                    <PlayCircle className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-sm font-medium text-white">Open on YouTube</p>
                    <p className="text-xs text-slate-400">End-to-end walkthrough</p>
                  </div>
                </div>
              </div>
            </a>
            <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-3.5">
              <p className="text-xs text-slate-400">WorkWell Measure Studio walkthrough</p>
              <a
                href={videoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/10"
              >
                YouTube
                <ArrowRight className="h-3 w-3" />
              </a>
            </div>
          </div>
        </section>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <footer className="mt-10 flex flex-col gap-3 border-t border-slate-200/80 pt-6 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>WorkWell Measure Studio — compliance operations for occupational health.</p>
          <div className="flex flex-wrap gap-4">
            <Link href="/sandbox" className="font-medium text-slate-600 transition hover:text-slate-950">
              Sandbox
            </Link>
            <Link href="/login" className="font-medium text-slate-600 transition hover:text-slate-950">
              Sign in
            </Link>
            <a href={repoUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-slate-600 transition hover:text-slate-950">
              GitHub
            </a>
          </div>
        </footer>
      </div>
    </main>
  );
}
