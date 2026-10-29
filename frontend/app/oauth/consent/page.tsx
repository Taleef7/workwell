"use client";

import { useEffect, useState } from "react";
import { Button } from "@mieweb/ui";
import { useAuth } from "@/components/auth-provider";
import { useApi } from "@/lib/api/hooks";
import { leaveTo } from "@/lib/navigate";

/**
 * The MCP OAuth consent page. The API's /oauth/authorize sends the browser here with a signed request; the
 * page is behind login like the rest of the app (the auth provider returns here after sign-in). The details
 * shown come from the API, which verified the request, never from decoding it in the browser. Approving sends
 * the browser on to the client's registered redirect with a one-time code.
 */

export interface ConsentDetails {
  clientName: string;
  verified: boolean;
  clientHost: string | null;
  redirectOrigin: string;
  /** The code goes to a program on this computer (`http://localhost:…`), which no metadata document vouches for. */
  loopback: boolean;
  scope: string;
  resource: string;
  user: { email: string; role: string | null };
  canApprove: boolean;
  /** The client's redirect with `error=access_denied`: declining writes nothing, so anyone signed in can. */
  declineRedirect: string;
}

const ROLE_LABEL: Record<string, string> = { ROLE_CASE_MANAGER: "Case Manager", ROLE_ADMIN: "Admin", ROLE_VIEWER: "Viewer" };

export default function ConsentPage() {
  const { token } = useAuth();
  const api = useApi();
  const [request, setRequest] = useState<string | null>(null);
  const [details, setDetails] = useState<ConsentDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setRequest(new URLSearchParams(window.location.search).get("request") ?? ""), 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!token || request === null) return;
    if (!request) {
      const t = setTimeout(() => setError("This page needs a sign-in request from an MCP client."), 0);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    api
      .get<ConsentDetails>(`/api/oauth/consent?request=${encodeURIComponent(request)}`, { cache: "no-store" })
      .then((d) => !cancelled && setDetails(d))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : "This sign-in request could not be read."));
    return () => {
      cancelled = true;
    };
  }, [api, token, request]);

  async function approve() {
    if (!request) return;
    setSending(true);
    setError(null);
    try {
      const { redirect } = await api.post<{ request: string; decision: string }, { redirect: string }>("/api/oauth/consent", { request, decision: "approve" });
      leaveTo(redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The answer could not be sent.");
      setSending(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 px-4 py-10 dark:bg-neutral-950">
      <section className="w-full max-w-lg rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900" data-testid="mcp-consent">
        <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">WorkWell · MCP access</p>
        {error ? (
          <>
            <h1 className="mt-2 text-xl font-semibold text-neutral-900 dark:text-neutral-100">This request cannot be completed</h1>
            <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p>
          </>
        ) : !details ? (
          <p className="mt-2 text-sm text-neutral-500">Loading the request…</p>
        ) : (
          <>
            <h1 className="mt-2 text-xl font-semibold text-neutral-900 dark:text-neutral-100">Connect {details.clientName} to WorkWell?</h1>
            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="font-medium text-neutral-700 dark:text-neutral-300">Who is asking</dt>
                <dd className="text-neutral-600 dark:text-neutral-400" data-testid="consent-identity">
                  {/* A metadata document proves who published the client, not who receives a loopback redirect. */}
                  {details.verified && details.clientHost && !details.loopback ? (
                    <>A client published by <strong>{details.clientHost}</strong> (verified from its metadata document).</>
                  ) : details.verified && details.clientHost ? (
                    <>A program on your computer that describes itself with <strong>{details.clientHost}</strong>&apos;s client metadata.</>
                  ) : (
                    <>A self-registered client. Its name is not verified.</>
                  )}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-neutral-700 dark:text-neutral-300">Where the approval goes</dt>
                <dd className="font-mono text-xs text-neutral-800 dark:text-neutral-200" data-testid="consent-redirect">{details.redirectOrigin}</dd>
              </div>
              {details.loopback ? (
                <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100" data-testid="consent-loopback-warning">
                  The approval goes to a program running on this computer, and any program on it could be listening there. Approve only if you started this
                  connection yourself, just now, on this computer.
                </p>
              ) : null}
              <div>
                <dt className="font-medium text-neutral-700 dark:text-neutral-300">What it can do</dt>
                <dd className="text-neutral-600 dark:text-neutral-400">
                  Use WorkWell&apos;s read-only MCP tools as {details.user.email} ({ROLE_LABEL[details.user.role ?? ""] ?? details.user.role}), for up to
                  90 days, until you or an admin disconnect it in Admin → MCP access. Every tool call is in the audit log.
                </dd>
              </div>
            </dl>
            {!details.canApprove ? (
              <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                Only a Case Manager or Admin can connect an MCP client.
              </p>
            ) : null}
            <div className="mt-6 flex flex-wrap gap-2">
              {details.canApprove ? (
                <Button type="button" disabled={sending} onClick={() => void approve()}>
                  Approve
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={sending}
                onClick={() => {
                  setSending(true);
                  leaveTo(details.declineRedirect);
                }}
              >
                Decline
              </Button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
