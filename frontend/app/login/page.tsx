"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Fraunces } from "next/font/google";
import {
  ArrowRight,
  BadgeCheck,
  Eye,
  EyeOff,
  KeyRound,
  Layers3,
  LayoutDashboard,
  Lock,
  Mail,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { DEMO_EMAIL, DEMO_PASSWORD, signInWithCredentials } from "@/lib/auth/demo-login";

const fraunces = Fraunces({ subsets: ["latin"], weight: ["600", "700"] });

const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "WorkWell Measure Studio";
const [APP_BADGE, ...appRest] = APP_NAME.split(" ");
const APP_SUBTITLE = appRest.join(" ") || "Measure Studio";

const highlights = [
  { icon: LayoutDashboard, label: "Programs & outcome trends" },
  { icon: ShieldCheck, label: "Case worklist & audit trail" },
  { icon: Layers3, label: "CQL Measure Studio" },
  { icon: Sparkles, label: "AI-assisted drafting" },
];

export default function LoginPage() {
  const router = useRouter();
  const { token, user, login } = useAuth();
  const [email, setEmail] = useState(() => (demoMode ? DEMO_EMAIL : ""));
  const [password, setPassword] = useState(() => (demoMode ? DEMO_PASSWORD : ""));
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!token || !user) return;
    router.replace("/programs");
  }, [router, token, user]);

  function fillDemoCredentials() {
    setEmail(DEMO_EMAIL);
    setPassword(DEMO_PASSWORD);
    setError(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError("Enter your email and password.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const payload = await signInWithCredentials(email, password);
      login(payload.token, payload.email, payload.role);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="relative flex min-h-dvh items-stretch overflow-hidden bg-slate-950">
      {/* Background texture */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:48px_48px]" />
      <div className="pointer-events-none absolute left-[-12rem] top-[-8rem] h-96 w-96 rounded-full bg-sky-500/10 blur-3xl" />
      <div className="pointer-events-none absolute bottom-[-8rem] right-[-8rem] h-80 w-80 rounded-full bg-white/5 blur-3xl" />

      {/* ── Left panel: brand ───────────────────────────────────────────── */}
      <section className="relative hidden flex-col justify-between gap-10 p-10 text-white lg:flex lg:w-[52%] xl:p-14">
        {/* Logo */}
        <Link
          href="/"
          className="flex w-fit items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-3.5 py-2.5 backdrop-blur transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/30"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-xs font-bold tracking-[0.2em] text-slate-950">
            WW
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-xs font-semibold uppercase tracking-[0.26em] text-slate-400">{APP_BADGE}</span>
            <span className="text-sm font-medium text-white">{APP_SUBTITLE}</span>
          </span>
        </Link>

        {/* Headline */}
        <div className="max-w-md space-y-5">
          <h1 className={`${fraunces.className} text-5xl leading-[0.95] tracking-tight text-white xl:text-6xl`}>
            Compliance ops, fully in view.
          </h1>
          <p className="text-base leading-7 text-slate-400">
            Four OSHA measures, deterministic CQL evaluation, and a complete audit trail — one reviewable workspace.
          </p>

          {/* Feature list */}
          <ul className="mt-6 space-y-3">
            {highlights.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-3 text-sm text-slate-300">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/8 text-slate-400 ring-1 ring-white/10">
                  <Icon className="h-4 w-4" />
                </span>
                {label}
              </li>
            ))}
          </ul>
        </div>

        {/* Sandbox shortcut */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">No login?</p>
              <p className="mt-2 text-sm font-medium text-white">Try the public sandbox</p>
              <p className="mt-1 text-xs text-slate-400">Auto-signs in and opens the Programs dashboard.</p>
            </div>
            <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-400 ring-1 ring-emerald-500/20">
              No login
            </span>
          </div>
          <Link
            href="/sandbox"
            className="mt-4 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/8 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/12 focus:outline-none focus:ring-2 focus:ring-white/30"
          >
            Open sandbox
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </section>

      {/* ── Right panel: form ───────────────────────────────────────────── */}
      <div className="flex flex-1 items-center justify-center bg-[linear-gradient(135deg,_#f8fafc_0%,_#eef2ff_45%,_#ffffff_100%)] p-6 sm:p-10">
        {/* Mobile logo */}
        <div className="absolute left-6 top-6 flex items-center gap-2 lg:hidden">
          <Link href="/" className="flex items-center gap-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-400">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-950 text-[10px] font-bold tracking-[0.2em] text-white">
              WW
            </span>
            <span className="text-sm font-semibold text-slate-950">WorkWell</span>
          </Link>
        </div>

        <div className="w-full max-w-[400px] pt-16 lg:pt-0">
          <div className="mb-8">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500 lg:text-slate-500">
              Secure sign in
            </p>
            <h2 className={`${fraunces.className} mt-2 text-3xl text-slate-950 lg:text-slate-950`}>
              Access the dashboard
            </h2>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            {/* Email */}
            <div>
              <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-slate-700">
                Email
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-12 w-full rounded-xl border border-slate-300 bg-white pl-10 pr-4 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                  placeholder="you@example.com"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-slate-700">
                Password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-12 w-full rounded-xl border border-slate-300 bg-white pl-10 pr-11 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-slate-400 transition hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Error */}
            {error ? (
              <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
                {error}
              </p>
            ) : null}

            {/* Sign in */}
            <button
              type="submit"
              disabled={pending}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-slate-950 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
            >
              {pending ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>

            {/* Demo fill */}
            <button
              type="button"
              onClick={fillDemoCredentials}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300"
            >
              <Zap className="h-3.5 w-3.5 text-amber-500" />
              Fill demo credentials
            </button>
          </form>

          {/* Divider + sandbox link */}
          <div className="mt-6 flex items-center gap-3 text-xs text-slate-400">
            <div className="h-px flex-1 bg-slate-200" />
            or
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          <Link
            href="/sandbox"
            className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white/80 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:bg-white hover:text-slate-950 focus:outline-none focus:ring-2 focus:ring-slate-300"
          >
            <BadgeCheck className="h-4 w-4 text-emerald-600" />
            Skip login — open public sandbox
          </Link>

          <div className="mt-6 flex items-center justify-between gap-2 text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5" />
              Demo: <span className="text-slate-600">{DEMO_EMAIL}</span>
            </span>
            <Link href="/" className="text-slate-500 transition hover:text-slate-950">
              ← Home
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
