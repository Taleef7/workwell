"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { DEMO_EMAIL, DEMO_PASSWORD, signInWithCredentials } from "@/lib/auth/demo-login";

const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

export default function LoginPage() {
  const router = useRouter();
  const { token, user, login } = useAuth();
  const [email, setEmail] = useState(() => (demoMode ? DEMO_EMAIL : ""));
  const [password, setPassword] = useState(() => (demoMode ? DEMO_PASSWORD : ""));
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
      setError("Please enter your email and password.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const payload = await signInWithCredentials(email, password);
      login(payload.token, payload.email, payload.role);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(15,23,42,0.12),_transparent_35%),linear-gradient(135deg,_#f8fafc_0%,_#eef2ff_45%,_#ffffff_100%)] px-4 py-10">
      <div className="absolute inset-0 opacity-40">
        <div className="absolute left-[-6rem] top-[-4rem] h-64 w-64 rounded-full bg-slate-900/10 blur-3xl" />
        <div className="absolute right-[-5rem] bottom-[-6rem] h-72 w-72 rounded-full bg-cyan-500/10 blur-3xl" />
      </div>

      <div className="relative grid w-full max-w-5xl overflow-hidden rounded-3xl border border-slate-200 bg-white/90 shadow-[0_30px_80px_-30px_rgba(15,23,42,0.35)] backdrop-blur lg:grid-cols-[1.05fr_0.95fr]">
        <section className="flex flex-col justify-between gap-10 bg-slate-950 p-8 text-white sm:p-10">
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-sm font-bold text-slate-950">
                WW
              </div>
              <div>
                <p className="text-sm uppercase tracking-[0.28em] text-slate-400">WorkWell Measure Studio</p>
                <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Sign in to the demo workspace</h1>
              </div>
            </div>

            <p className="max-w-lg text-sm leading-6 text-slate-300 sm:text-base">
              OSHA surveillance intelligence, compliance ops, and audit-ready workflows, all in one place for review.
            </p>

            <div className="grid gap-3 text-sm text-slate-200 sm:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Demo access</p>
                <p className="mt-2 font-medium">One-click credentials fill</p>
                <p className="mt-1 text-slate-400">Use the shared demo account to jump straight into the dashboard.</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Product angle</p>
                <p className="mt-2 font-medium">Policy-to-CQL operations</p>
                <p className="mt-1 text-slate-400">Deterministic compliance decisions, clean audit trails, and visible controls.</p>
              </div>
            </div>
          </div>

          <p className="text-xs leading-5 text-slate-400">
            Demo credentials: <span className="font-medium text-slate-200">{DEMO_EMAIL}</span> /{" "}
            <span className="font-medium text-slate-200">{DEMO_PASSWORD}</span>
          </p>
        </section>

        <form onSubmit={onSubmit} className="flex flex-col justify-center gap-5 p-8 sm:p-10">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Secure sign in</p>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Access the dashboard</h2>
            <p className="text-sm text-slate-600">Use your assigned credentials or fill the shared demo account below.</p>
          </div>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Email</span>
            <input
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Password</span>
            <input
              type="password"
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>

          {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

          <button
            type="button"
            onClick={fillDemoCredentials}
            className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:border-slate-400 hover:bg-slate-50"
          >
            Use demo credentials
          </button>

          <button
            disabled={pending}
            className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            {pending ? "Signing in..." : "Sign in"}
          </button>

          <p className="text-xs leading-5 text-slate-500">
            The demo account is prefilled when demo mode is enabled, but you can also fill it manually with the button above.
          </p>
          <p className="text-xs leading-5 text-slate-500">
            Prefer a no-login demo entry? Use the public sandbox from the landing page.
          </p>
        </form>
      </div>
    </main>
  );
}
