/**
 * Client ID Metadata Documents (CIMD, MCP 2026-07-28 authorization): a client whose `client_id` is an https
 * URL is described by the JSON document at that URL, which the authorization server fetches.
 *
 * The URL is a stranger's choice, so the fetch is fenced:
 * - **https on port 443 only**, a host name rather than an IP literal, no credentials, no fragment, and the URL
 *   exactly as `new URL()` normalizes it (no dot segments or other spellings);
 * - **every address DNS returns is checked at connect time** (`ip-guard.ts`), inside the connection's own
 *   lookup, so a name cannot resolve one way for a check and another for the connection;
 * - **no redirects** (any 3xx is a failure), **64 KB** at most, counted as the body streams in, and **5 s** for
 *   the whole exchange;
 * - **a bounded cache** honouring `max-age` up to an hour, and a short negative cache, so a stream of random
 *   URLs cannot make this server fetch without limit.
 *
 * The document must name itself (`client_id` equal to the URL, compared as the raw string the client sent),
 * and give a `client_name` and `redirect_uris` (https or loopback http). Only public clients
 * (`token_endpoint_auth_method` absent or `none`) are accepted.
 */
import { request as httpsRequest, type RequestOptions } from "node:https";
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

export class CimdError extends Error {}

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;
const MAX_TTL_MS = 3_600_000;
const DEFAULT_TTL_MS = 300_000;
const NEGATIVE_TTL_MS = 60_000;
const CACHE_LIMIT = 256;

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

function fetchDocument(url: URL, deps: CimdDeps): Promise<{ body: string; maxAgeMs: number }> {
  const request = deps.request ?? ((u, o, cb) => httpsRequest(u, o, cb));
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err: Error | null, value?: { body: string; maxAgeMs: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err instanceof CimdError ? err : new CimdError(err.message));
      else resolve(value!);
    };
    const req = request(
      url,
      { method: "GET", headers: { accept: "application/json" }, lookup: guardedLookup(deps.lookup), maxRedirects: 0 } as RequestOptions,
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          req.destroy();
          return done(new CimdError(`client metadata answered ${res.statusCode}${res.statusCode && res.statusCode >= 300 && res.statusCode < 400 ? " (redirects are not followed)" : ""}`));
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
      done(new CimdError("client metadata took longer than 5 s"));
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

type CacheEntry = { expires: number; value?: ClientMetadata; error?: string };
const cache = new Map<string, CacheEntry>();

function remember(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** The metadata of a CIMD client, fetched under the guard above (cached). Throws `CimdError`. */
export async function fetchClientMetadata(clientId: string, deps: CimdDeps = {}): Promise<ClientMetadata> {
  const problem = cimdUrlProblem(clientId);
  if (problem) throw new CimdError(problem);
  const now = deps.now?.() ?? Date.now();
  const hit = cache.get(clientId);
  if (hit && hit.expires > now) {
    if (hit.error) throw new CimdError(hit.error);
    return hit.value!;
  }
  const url = new URL(clientId);
  try {
    const { body, maxAgeMs } = await fetchDocument(url, deps);
    const value = parseClientMetadata(clientId, body, url.hostname);
    remember(clientId, { expires: now + Math.min(Math.max(maxAgeMs, 0), MAX_TTL_MS), value });
    return value;
  } catch (err) {
    const message = (err as Error).message;
    remember(clientId, { expires: now + NEGATIVE_TTL_MS, error: message });
    throw err instanceof CimdError ? err : new CimdError(message);
  }
}

/** @internal test hook */
export function __clearCimdCache(): void {
  cache.clear();
}
