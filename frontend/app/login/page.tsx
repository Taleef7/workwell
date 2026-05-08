"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";
const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState(() => (demoMode ? "author@workwell.dev" : ""));
  const [password, setPassword] = useState(() => (demoMode ? "Workwell123!" : ""));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || "Invalid credentials");
      }
      const payload = (await response.json()) as { token: string; email: string; role: string };
      login(payload.token, payload.email, payload.role);
      router.replace("/programs");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <form onSubmit={onSubmit} className="w-full max-w-md space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">WorkWell Login</h1>
        {demoMode ? (
          <p className="text-sm text-slate-600">Demo users share password: <code>Workwell123!</code></p>
        ) : (
          <p className="text-sm text-slate-600">Use your assigned credentials to sign in.</p>
        )}
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">Email</span>
          <input className="w-full rounded border border-slate-300 px-3 py-2" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-700">Password</span>
          <input type="password" className="w-full rounded border border-slate-300 px-3 py-2" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error ? <p className="text-sm text-rose-600">{error}</p> : null}
        <button disabled={pending} className="w-full rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
          {pending ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
