import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces } from "next/font/google";
import {
  ArrowRight,
  BadgeCheck,
  Layers3,
  LayoutDashboard,
  ExternalLink,
  PlayCircle,
  ShieldCheck,
  Sparkles,
  Video
} from "lucide-react";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["600", "700"]
});

const repoUrl = "https://github.com/Taleef7/workwell";
const videoUrl = "https://www.youtube.com/shorts/SgzDt4TBd9k?si=vHE9vppgxeGO6OM8";

const stats = [
  { value: "4", label: "Compliance programs" },
  { value: "50+", label: "Employees tracked" },
  { value: "5", label: "Outcome types" },
  { value: "1 click", label: "Sandbox entry" },
];

const featureCards = [
  {
    icon: LayoutDashboard,
    title: "Monday-morning dashboard",
    body: "KPI row, measure cards, trend lines, and the run-all control are all surfaced as one clean operating view."
  },
  {
    icon: ShieldCheck,
    title: "Auditable case flow",
    body: "Worklists, outreach, evidence, and packets stay connected instead of disappearing into a maze of side screens."
  },
  {
    icon: Layers3,
    title: "Measure Studio",
    body: "Spec, CQL, value sets, traceability, tests, and activation are visible in one place for review and iteration."
  },
  {
    icon: Sparkles,
    title: "Polished demo surfaces",
    body: "Minimal enough to feel credible, rich enough to show the product story without a guided tour."
  }
];

const portalPills = [
  { name: "workwell.os.mieweb.org", tone: "Live sandbox" },
  { name: "ecqm.os.mieweb.org", tone: "Planned portal" },
  { name: "twh.os.mieweb.org", tone: "Planned portal" }
];

const operatingNotes = [
  "No manual login required.",
  "Opens straight to the Programs dashboard.",
  "Full source on GitHub.",
  "Walkthrough video on this page.",
];

const sandboxSections = [
  "Programs & outcome trends",
  "Case worklist & outreach",
  "CQL Measure Studio",
  "Audit trail & exports",
];

export const metadata: Metadata = {
  title: "WorkWell Measure Studio",
  description: "Occupational-health compliance operations for modern programs."
};

export default function HomePage() {
  return (
    <main className="relative min-h-dvh overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(15,23,42,0.14),_transparent_34%),radial-gradient(circle_at_top_right,_rgba(14,165,233,0.18),_transparent_28%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_44%,_#ffffff_100%)] text-slate-950">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(15,23,42,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(15,23,42,0.04)_1px,transparent_1px)] bg-[size:56px_56px] opacity-35" />
      <div className="absolute left-[-8rem] top-[-6rem] h-72 w-72 rounded-full bg-sky-400/15 blur-3xl" />
      <div className="absolute right-[-7rem] top-16 h-80 w-80 rounded-full bg-slate-900/10 blur-3xl" />

      <div className="relative mx-auto flex min-h-dvh w-full max-w-7xl flex-col px-6 pb-16 pt-6 sm:px-10 lg:px-12">

        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <Link
            href="/"
            className="flex items-center gap-3 rounded-2xl border border-slate-200/80 bg-white/70 px-3 py-2.5 shadow-[0_10px_40px_-28px_rgba(15,23,42,0.35)] backdrop-blur focus:outline-none focus:ring-2 focus:ring-slate-400"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-950 text-sm font-bold tracking-[0.22em] text-white">
              WW
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-500">WorkWell</span>
              <span className="text-base font-medium text-slate-950">Measure Studio</span>
            </span>
          </Link>

          <nav className="flex flex-wrap items-center gap-2 text-sm">
            <a
              href={videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/75 px-4 py-2 text-slate-700 transition hover:border-slate-300 hover:bg-white hover:text-slate-950"
            >
              <Video className="h-4 w-4" />
              Walkthrough
            </a>
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/75 px-4 py-2 text-slate-700 transition hover:border-slate-300 hover:bg-white hover:text-slate-950"
            >
              <ExternalLink className="h-4 w-4" />
              GitHub
            </a>
            <Link
              href="/sandbox"
              className="inline-flex items-center gap-2 rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-[0_12px_30px_-12px_rgba(15,23,42,0.55)] transition hover:-translate-y-0.5 hover:bg-slate-800"
            >
              Try the sandbox
              <ArrowRight className="h-4 w-4" />
            </Link>
          </nav>
        </header>

        {/* ── Hero ───────────────────────────────────────────────────── */}
        <section className="grid flex-1 items-center gap-12 py-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
          <div className="max-w-3xl">
            <p className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/75 px-4 py-2 text-xs font-semibold uppercase tracking-[0.26em] text-slate-600 shadow-[0_10px_24px_-20px_rgba(15,23,42,0.35)] backdrop-blur">
              <PlayCircle className="h-3.5 w-3.5" />
              Public sandbox · No login required
            </p>

            <h1 className={`${fraunces.className} mt-6 text-5xl leading-[0.96] tracking-tight text-slate-950 sm:text-6xl lg:text-7xl`}>
              A clean operating surface for occupational-health compliance.
            </h1>

            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600 sm:text-xl">
              WorkWell turns program oversight, case follow-up, and audit evidence into one reviewable
              dashboard — four compliance measures, a complete case management flow, and a full audit trail.
            </p>

            {/* Stats strip */}
            <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
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

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/sandbox"
                className="inline-flex items-center gap-2 rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-[0_14px_40px_-18px_rgba(15,23,42,0.6)] transition hover:-translate-y-0.5 hover:bg-slate-800"
              >
                Try the sandbox
                <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href={videoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-white hover:text-slate-950"
              >
                Watch the walkthrough
              </a>
              <a
                href={repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-white hover:text-slate-950"
              >
                View on GitHub
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>

            <div className="mt-6 flex flex-wrap gap-2 text-sm text-slate-500">
              {operatingNotes.map((note) => (
                <span
                  key={note}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/60 px-3 py-1.5 backdrop-blur"
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
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Sandbox preview</p>
                  <h2 className={`${fraunces.className} mt-3 text-3xl leading-tight text-slate-950`}>
                    Open the dashboard in one click.
                  </h2>
                </div>
                <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
                  No login prompt
                </span>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Primary surface</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-950">Programs</p>
                  <p className="mt-1 text-sm leading-6 text-slate-600">KPI row, measure cards, trends, and a single run-all action.</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Entry point</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-950">1 click</p>
                  <p className="mt-1 text-sm leading-6 text-slate-600">Hidden demo sign-in drops you straight into the app.</p>
                </div>
              </div>

              <div className="mt-4 rounded-[1.5rem] border border-slate-900 bg-slate-950 p-4 text-white">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-slate-400">What the sandbox shows</p>
                    <p className="mt-2 text-lg font-semibold">Programs, cases, runs, studio, admin</p>
                  </div>
                  <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-slate-200">Demo-safe</span>
                </div>
                <div className="mt-4 grid gap-2 text-sm text-slate-300 sm:grid-cols-2">
                  {sandboxSections.map((section) => (
                    <div key={section} className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
                      {section}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Feature cards ──────────────────────────────────────────── */}
        <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {featureCards.map((card) => {
            const Icon = card.icon;
            return (
              <article
                key={card.title}
                className="rounded-[1.75rem] border border-slate-200/90 bg-white/80 p-5 shadow-[0_20px_60px_-45px_rgba(15,23,42,0.45)] backdrop-blur transition hover:-translate-y-1 hover:border-slate-300 hover:bg-white"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-950 text-white">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className={`${fraunces.className} mt-4 text-2xl text-slate-950`}>{card.title}</h3>
                <p className="mt-3 text-sm leading-7 text-slate-600">{card.body}</p>
              </article>
            );
          })}
        </section>

        {/* ── Walkthrough + video ────────────────────────────────────── */}
        <section className="mt-10 grid gap-8 lg:grid-cols-[1.02fr_0.98fr]">
          <div className="rounded-[2rem] border border-slate-200/90 bg-white/80 p-6 shadow-[0_24px_80px_-55px_rgba(15,23,42,0.5)] backdrop-blur">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Walkthrough video</p>
            <h2 className={`${fraunces.className} mt-3 text-3xl leading-tight text-slate-950 sm:text-4xl`}>
              The full product story in under five minutes.
            </h2>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-600 sm:text-base">
              The walkthrough covers the end-to-end flow: author a compliance measure, run it across the
              workforce, triage open cases, and export a complete audit packet — all in one continuous demo.
            </p>

            <div className="mt-6 flex flex-wrap gap-2 text-sm text-slate-500">
              <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5">
                <Video className="h-3.5 w-3.5 text-slate-700" />
                Short-form walkthrough
              </span>
              <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5">
                <BadgeCheck className="h-3.5 w-3.5 text-emerald-600" />
                No guided tour required
              </span>
            </div>

            <div className="mt-8 rounded-[1.75rem] border border-slate-200 bg-slate-50 p-5">
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Portal plan</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {portalPills.map((portal) => (
                  <span
                    key={portal.name}
                    className={`rounded-full px-4 py-2 text-xs font-semibold ${
                      portal.tone === "Live sandbox"
                        ? "bg-slate-950 text-white"
                        : "bg-white text-slate-500 ring-1 ring-slate-200"
                    }`}
                  >
                    {portal.name}
                    <span className="ml-2 font-normal opacity-75">({portal.tone})</span>
                  </span>
                ))}
              </div>
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
              <div className="absolute inset-0 bg-[linear-gradient(120deg,_rgba(255,255,255,0.08),_transparent_38%,rgba(255,255,255,0.04)_60%,transparent)] opacity-70" />
              <div className="relative flex h-full flex-col justify-between p-6 text-white sm:p-7">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-300">Walkthrough video</p>
                    <h3 className="mt-3 max-w-md text-3xl font-semibold leading-tight text-white sm:text-[2.15rem]">
                      A short demo that tells the story fast.
                    </h3>
                  </div>
                  <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-medium text-slate-100">
                    Play
                  </span>
                </div>

                <div className="flex items-center gap-4">
                  <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-slate-950 shadow-[0_10px_30px_-10px_rgba(255,255,255,0.55)] transition group-hover:scale-105">
                    <PlayCircle className="h-6 w-6" />
                  </span>
                  <div>
                    <p className="text-sm font-medium text-white">Open on YouTube</p>
                    <p className="text-sm leading-6 text-slate-300">End-to-end product walkthrough.</p>
                  </div>
                </div>
              </div>
            </a>
            <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-4 text-sm text-slate-300">
              <p>WorkWell Measure Studio walkthrough.</p>
              <a
                href={videoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 font-medium text-white transition hover:bg-white/10"
              >
                Open in YouTube
                <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        </section>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <footer className="mt-12 flex flex-col gap-3 border-t border-slate-200/80 pt-6 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>WorkWell Measure Studio — compliance operations for occupational health.</p>
          <div className="flex flex-wrap gap-4">
            <Link href="/sandbox" className="font-medium text-slate-700 transition hover:text-slate-950">
              Try sandbox
            </Link>
            <a href={repoUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-slate-700 transition hover:text-slate-950">
              GitHub
            </a>
            <Link href="/login" className="font-medium text-slate-700 transition hover:text-slate-950">
              Sign in
            </Link>
          </div>
        </footer>
      </div>
    </main>
  );
}
