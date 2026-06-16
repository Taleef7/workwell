"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Circle, Loader2 } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { SANDBOX_EMAIL, SANDBOX_PASSWORD, signInWithCredentials } from "@/lib/auth/demo-login";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "WorkWell Measure Studio";

type SandboxStatus = "loading" | "error";

const steps = [
  "Connecting to workspace",
  "Authenticating demo session",
  "Opening Programs dashboard",
];

export default function SandboxPage() {
  const router = useRouter();
  const { token, login } = useAuth();
  const [status, setStatus] = useState<SandboxStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function enterSandbox() {
      if (token) {
        router.replace("/programs");
        return;
      }

      setStatus("loading");
      setError(null);

      try {
        const payload = await signInWithCredentials(SANDBOX_EMAIL, SANDBOX_PASSWORD);
        if (!active) return;
        login(payload.token, payload.email, payload.role);
        router.replace("/programs");
      } catch (err) {
        if (!active) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : "Sandbox entry failed. Please try again.");
      }
    }

    void enterSandbox();

    return () => {
      active = false;
    };
  }, [login, router, token]);

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-slate-950">
      {/* Subtle grid texture */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:56px_56px]" />
      {/* Depth orbs */}
      <div className="absolute left-[-12rem] top-[-10rem] h-[28rem] w-[28rem] rounded-full bg-sky-600/10 blur-3xl" />
      <div className="absolute right-[-10rem] bottom-[-8rem] h-96 w-96 rounded-full bg-indigo-900/25 blur-3xl" />

      <div className="relative mx-auto w-full max-w-sm px-6 py-16">

        {/* Brand mark */}
        <div className="flex flex-col items-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-white shadow-[0_0_48px_-8px_rgba(255,255,255,0.3)]">
            <span className="text-base font-bold tracking-[0.18em] text-slate-950">WW</span>
          </div>
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">
            {APP_NAME}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">
            Opening the sandbox
          </h1>
          <p className="mt-2 max-w-xs text-sm leading-6 text-slate-400">
            No credentials required. Signing you in automatically with the shared demo account.
          </p>
        </div>

        {/* Status panel */}
        <div className="mt-10 rounded-[1.5rem] border border-white/10 bg-white/5 p-5 backdrop-blur-sm">
          {status === "loading" ? (
            <div className="flex items-start gap-4">
              <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-sky-400" />
              <div>
                <p className="text-sm font-semibold text-white">Signing in automatically…</p>
                <p className="mt-1 text-sm leading-5 text-slate-400">
                  You will be dropped straight into the Programs dashboard.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-semibold text-white">Sandbox entry failed</p>
                <p className="mt-1 text-sm leading-5 text-slate-400">{error}</p>
              </div>
              <div className="flex flex-wrap gap-3 pt-1">
                <Link
                  href="/"
                  className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10"
                >
                  Back to landing
                </Link>
                <Link
                  href="/login"
                  className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-slate-100"
                >
                  Sign in manually
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* Step indicators — only while loading */}
        {status === "loading" && (
          <div className="mt-6 space-y-3 px-1">
            {steps.map((step, i) => (
              <div key={step} className="flex items-center gap-3">
                {i === 0 ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-400" />
                ) : (
                  <Circle className="h-3.5 w-3.5 shrink-0 text-slate-700" />
                )}
                <span className={`text-sm ${i === 0 ? "text-slate-200" : "text-slate-600"}`}>
                  {step}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Footer links */}
        <p className="mt-10 text-center text-xs text-slate-600">
          Prefer a manual login?{" "}
          <Link
            href="/login"
            className="text-slate-400 underline underline-offset-4 transition hover:text-slate-200"
          >
            Sign in here
          </Link>
          {" · "}
          <Link
            href="/"
            className="text-slate-400 underline underline-offset-4 transition hover:text-slate-200"
          >
            Back to landing
          </Link>
        </p>
      </div>
    </main>
  );
}
