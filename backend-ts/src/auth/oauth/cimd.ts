/**
 * Client ID Metadata Documents (CIMD, MCP 2026-07-28 authorization): a client whose `client_id` is an https
 * URL is described by the JSON document at that URL, which the authorization server fetches.
 *
 * The URL arrives on an unauthenticated request (`GET /oauth/authorize`), so the fetch is fenced:
 * - **only from an accepted publisher**: the host must be one of `WORKWELL_OAUTH_CIMD_HOSTS` (default
 *   `claude.ai`, which publishes the documents of Claude's connector and of Claude Code). Without this, any
 *   caller could make the API fetch any public URL, and any host could be shown on the consent page as a
 *   verified publisher;
 * - **https on port 443 only**, a host name rather than an IP literal, no credentials, no fragment, and the URL
 *   exactly as `new URL()` normalizes it (no dot segments or other spellings);
 * - **every address DNS returns is checked at connect time** (`ip-guard.ts`), inside the connection's own
 *   lookup, so a name cannot resolve one way for a check and another for the connection; the request uses its
 *   own agent, so a proxy configured in the environment cannot resolve the name instead;
 * - **no redirects** (any 3xx is a failure), **64 KB** at most, counted as the body streams in, and **5 s** for
 *   the whole exchange;
 * - **bounded work**: one fetch per URL at a time (concurrent requests share it), at most 4 in flight and 20 a
 *   minute in all; documents and failures are cached apart (`max-age` up to an hour; failures a minute), so a
 *   stream of failing URLs never pushes a good document out. When a refresh fails for a reason that may pass
 *   (a timeout, a 5xx or 429, the limits above), the last good document is used for up to a day, so a sign-in
 *   does not depend on the publisher answering at that moment.
 *
 * The document must name itself (`client_id` equal to the URL, compared as the raw string the client sent),
 * and give a `client_name` and `redirect_uris` (https or loopback http). Only public clients
 * (`token_endpoint_auth_method` absent or `none`) are accepted.
 */
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions } from "node:https";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import type { ClientRequest, IncomingMessage } from "node:http";
import { isBlockedAddress } from "./ip-guard.ts";
import { redirectProblem } from "./redirect-uris.ts";

export interface ClientMetadata {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  /** The host the document came from: the client's verified identity, shown on the consent page. */
  host: string;
}

/** `transient`: the failure may pass (a timeout, a 5xx or 429, this server's own limits), so it is not the answer. */
export class CimdError extends Error {
  constructor(
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;
const MAX_TTL_MS = 3_600_000;
const DEFAULT_TTL_MS = 300_000;
const NEGATIVE_TTL_MS = 60_000;
const STALE_MS = 86_400_000;
const DOCUMENT_LIMIT = 64;
const FAILURE_LIMIT = 256;
const MAX_IN_FLIGHT = 4;
const FETCHES_PER_MINUTE = 20;
const USER_AGENT = "WorkWell-MCP-authorization-server";

/** The publishers whose client metadata documents are fetched when nothing is configured. */
export const DEFAULT_CIMD_HOSTS: readonly string[] = ["claude.ai"];

/** `WORKWELL_OAUTH_CIMD_HOSTS`: comma-separated host names; empty or unset means the default. */
export function cimdHostsFrom(value: string | undefined): string[] {
  const hosts = (value ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return hosts.length ? hosts : [...DEFAULT_CIMD_HOSTS];
}

/** Why `raw` cannot be a CIMD client id, or null. */
export function cimdUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "client_id is not a URL";
  }
  if (url.protocol !== "https:") return "client_id must be an https URL";
  if (url.port !== "" && url.port !== "443") return "client_id must use port 443";
  if (url.username || url.password) return "client_id may not carry credentials";
  if (url.hash || raw.includes("#")) return "client_id may not have a fragment";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return "client_id must name a host, not an IP address";
  if (url.pathname === "/") return "client_id must have a path";
  if (url.href !== raw) return "client_id must be a normalized URL";
  return null;
}

/** Strip control and bidirectional-override characters and cap the length, for display. */
export function cleanClientName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "").trim();
  return cleaned ? cleaned.slice(0, 64) : null;
}

type Lookup = typeof dnsLookup;
type RequestFn = (url: URL, options: RequestOptions, onResponse: (res: IncomingMessage) => void) => ClientRequest;

export interface CimdDeps {
  /** The accepted publishers (`cimdHostsFrom`); `DEFAULT_CIMD_HOSTS` when absent. */
  allowedHosts?: readonly string[];
  request?: RequestFn;
  lookup?: Lookup;
  now?: () => number;
  /** Tests only; the limit is 5 s. */
  timeoutMs?: number;
}

/** A lookup that refuses the connection when any resolved address is internal. */
export function guardedLookup(lookup: Lookup = dnsLookup): RequestOptions["lookup"] {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    lookup(hostname, { ...options, all: true }, (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      if (err) return callback(err);
      if (!addresses?.length || addresses.some((a) => isBlockedAddress(a.address))) {
        return callback(new CimdError(`client_id host ${hostname} resolves to a refused address`));
      }
      if (options?.all) return callback(null, addresses);
      return callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  }) as RequestOptions["lookup"];
}

/** Its own agent: the global one may send requests through an environment proxy, which resolves names itself. */
const AGENT = new HttpsAgent({ keepAlive: false });

function fetchDocument(url: URL, deps: CimdDeps): Promise<{ body: string; maxAgeMs: number }> {
  const request = deps.request ?? ((u, o, cb) => httpsRequest(u, o, cb));
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err: Error | null, value?: { body: string; maxAgeMs: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A CimdError says what it is (the guarded lookup's refusal is one); any other error is the network's.
      if (err) reject(err instanceof CimdError ? err : new CimdError(err.message, true));
      else resolve(value!);
    };
    const req = request(
      url,
      { method: "GET", headers: { accept: "application/json", "user-agent": USER_AGENT }, agent: AGENT, lookup: guardedLookup(deps.lookup), maxRedirects: 0 } as RequestOptions,
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.resume();
          req.destroy();
          return done(new CimdError(`client metadata answered ${status}${status >= 300 && status < 400 ? " (redirects are not followed)" : ""}`, status === 429 || status >= 500));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy();
            return done(new CimdError("client metadata is larger than 64 KB"));
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const maxAge = /max-age=(\d+)/i.exec(String(res.headers["cache-control"] ?? ""))?.[1];
          done(null, { body: Buffer.concat(chunks).toString("utf8"), maxAgeMs: maxAge ? Number(maxAge) * 1000 : DEFAULT_TTL_MS });
        });
        res.on("error", (err) => done(err));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(new CimdError("client metadata took longer than 5 s", true));
    }, deps.timeoutMs ?? TIMEOUT_MS);
    req.on("error", (err) => done(err));
    req.end();
  });
}

/** Validate a fetched document for `clientId`. */
export function parseClientMetadata(clientId: string, body: string, host: string): ClientMetadata {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new CimdError("client metadata is not JSON");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new CimdError("client metadata is not a JSON object");
  if (doc.client_id !== clientId) throw new CimdError("client metadata does not name this client_id");
  const clientName = cleanClientName(doc.client_name);
  if (!clientName) throw new CimdError("client metadata has no client_name");
  const method = doc.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") throw new CimdError("only public clients (token_endpoint_auth_method none) are supported");
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 20 || !uris.every((u) => typeof u === "string")) {
    throw new CimdError("client metadata needs redirect_uris");
  }
  const bad = (uris as string[]).find((u) => redirectProblem(u, "cimd") !== null);
  if (bad) throw new CimdError(`client metadata lists a refused redirect URI: ${redirectProblem(bad, "cimd")}`);
  return { clientId, clientName, redirectUris: uris as string[], host };
}

// Good documents and failures live apart, so failures (which anyone can cause) never evict a document.
const documents = new Map<string, { expires: number; value: ClientMetadata }>();
const failures = new Map<string, { expires: number; error: string }>();
const inFlight = new Map<string, Promise<ClientMetadata>>();
let budget = { windowStart: 0, used: 0 };

function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value!);
}

/** One more fetch in this minute, if the budget allows it. */
function takeFetch(now: number): boolean {
  if (now - budget.windowStart >= 60_000) budget = { windowStart: now, used: 0 };
  if (budget.used >= FETCHES_PER_MINUTE) return false;
  budget.used += 1;
  return true;
}

/** The metadata of a CIMD client, fetched under the guard above (cached). Throws `CimdError`. */
export async function fetchClientMetadata(clientId: string, deps: CimdDeps = {}): Promise<ClientMetadata> {
  const problem = cimdUrlProblem(clientId);
  if (problem) throw new CimdError(problem);
  const url = new URL(clientId);
  const allowed = deps.allowedHosts ?? DEFAULT_CIMD_HOSTS;
  if (!allowed.includes(url.hostname)) throw new CimdError(`client metadata is accepted only from ${allowed.join(", ")}`);
  const now = deps.now?.() ?? Date.now();
  const known = documents.get(clientId);
  if (known && known.expires > now) return known.value;
  const failed = failures.get(clientId);
  if (failed && failed.expires > now) throw new CimdError(failed.error);
  const pending = inFlight.get(clientId);
  if (pending) return pending;

  // The last good document stands in while the publisher (or this server's limit) cannot answer.
  const stale = known && now - known.expires < STALE_MS ? known.value : null;
  if (inFlight.size >= MAX_IN_FLIGHT || !takeFetch(now)) {
    if (stale) return stale;
    throw new CimdError("too many client metadata fetches at once; try again in a minute", true);
  }
  const fetching = fetchDocument(url, deps)
    .then(({ body, maxAgeMs }) => {
      const value = parseClientMetadata(clientId, body, url.hostname);
      remember(documents, clientId, { expires: now + Math.min(Math.max(maxAgeMs, 0), MAX_TTL_MS), value }, DOCUMENT_LIMIT);
      failures.delete(clientId);
      return value;
    })
    .catch((err: unknown) => {
      const error = err instanceof CimdError ? err : new CimdError((err as Error).message);
      if (error.transient && stale) return stale;
      remember(failures, clientId, { expires: now + NEGATIVE_TTL_MS, error: error.message }, FAILURE_LIMIT);
      throw error;
    })
    .finally(() => inFlight.delete(clientId));
  inFlight.set(clientId, fetching);
  return fetching;
}

/** @internal test hook */
export function __clearCimdCache(): void {
  documents.clear();
  failures.clear();
  inFlight.clear();
  budget = { windowStart: 0, used: 0 };
}
