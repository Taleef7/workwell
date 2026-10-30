"use client";

/**
 * The provider a clinician's sign-in is linked to (#870), read once per signed-in account.
 *
 * The link is a field on the hardcoded account (`backend-ts/src/auth/demo-users.ts`) and only a read-only
 * VIEWER seat on the patient deployment carries one, so nobody else asks: a case manager's "mine" is their
 * panels, not this, and the occupational deployment's providers are clinicians assigned round-robin. The
 * answer comes from `GET /api/providers/mine` rather than the login response, so a stale `ww_user` in
 * local storage can never carry a stale link.
 *
 * One provider above the dashboard shell, keyed by the signed-in email, so the nav and the pages share one
 * request and a sign-out and back in as another seat never reuses the old answer. Only a successful answer
 * is kept: a failed read (a deploy restarting the server) reports `error`, so a clinician is never told
 * their sign-in "isn't linked" because the server blinked. It is asked again by the scorecard's Retry, or
 * when the session's token is refreshed; until then the nav and the "My patients" buttons stay hidden.
 * Anything that is not the expected shape counts as not linked.
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { useApi } from "@/lib/api/hooks";
import { normRole, ROLES } from "@/lib/rbac";
import { SUBJECT } from "@/lib/terminology";

export type MyProvider = { id: string; name: string; location: string };

export type MyProviderState = {
  /** The linked provider, or null: not linked, not a VIEWER, not loaded yet, or the read failed. */
  provider: MyProvider | null;
  /** True once the answer is known, including a failed read. */
  loaded: boolean;
  /** The read failed; `provider` says nothing about the link until `retry` succeeds. */
  error: boolean;
  retry: () => void;
};

const MyProviderContext = createContext<MyProviderState>({ provider: null, loaded: false, error: false, retry: () => {} });

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** `{ provider: {id,name,location} | null }`, or null for anything else. */
export function parseMyProvider(body: unknown): MyProvider | null {
  if (!body || typeof body !== "object" || !("provider" in body)) return null;
  const p = (body as { provider: unknown }).provider;
  if (!p || typeof p !== "object") return null;
  const { id, name, location } = p as Record<string, unknown>;
  return isText(id) && isText(name) && isText(location) ? { id, name, location } : null;
}

export function MyProviderProvider({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuth();
  const api = useApi();
  const email = user?.email ?? null;
  const linkable = normRole(user?.role) === ROLES.VIEWER && SUBJECT.singular === "patient";
  const [answer, setAnswer] = useState<{ email: string; provider: MyProvider | null } | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const cached = answer !== null && answer.email === email;
  useEffect(() => {
    if (!token || !email || !linkable || cached) return;
    let cancelled = false;
    api
      .get<unknown>("/api/providers/mine")
      .then((body) => {
        if (cancelled) return;
        setAnswer({ email, provider: parseMyProvider(body) });
        setFailedFor(null);
      })
      .catch(() => {
        if (!cancelled) setFailedFor(email);
      });
    return () => {
      cancelled = true;
    };
  }, [api, token, email, linkable, cached, attempt]);

  const value = useMemo<MyProviderState>(() => {
    const retry = () => {
      setFailedFor(null);
      setAttempt((n) => n + 1);
    };
    if (!email) return { provider: null, loaded: false, error: false, retry };
    if (!linkable) return { provider: null, loaded: true, error: false, retry };
    if (answer && answer.email === email) return { provider: answer.provider, loaded: true, error: false, retry };
    if (failedFor === email) return { provider: null, loaded: true, error: true, retry };
    return { provider: null, loaded: false, error: false, retry };
  }, [email, linkable, answer, failedFor]);

  return <MyProviderContext.Provider value={value}>{children}</MyProviderContext.Provider>;
}

/** The signed-in account's linked provider. Outside `MyProviderProvider` it is never loaded. */
export function useMyProvider(): MyProviderState {
  return useContext(MyProviderContext);
}
