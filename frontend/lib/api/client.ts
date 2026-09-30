import { ApiError } from "./errors";
import { refreshSession } from "./session-refresh";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim().replace(/\/+$/, "");

/**
 * Tiny module-level GET dedup + short-TTL cache (shared across all ApiClient instances since the
 * hook memoizes a client per component). Concurrent identical GETs are coalesced into one request,
 * and a just-resolved response is reused for GET_TTL_MS so rapid re-navigation / re-render doesn't
 * re-pay the network+DB cost. ANY mutation (POST/PUT/DELETE/form) busts the whole cache, so a read
 * never serves data a write just changed. Keyed by token so users never share cached reads.
 */
const GET_TTL_MS = 1500;
const getCache = new Map<string, { at: number; promise: Promise<unknown> }>();
function bustGetCache(): void {
  getCache.clear();
}

/**
 * What a request answers when its access token lapsed and the refresh could not reach the server (a
 * deploy, a busy pool). A 503 with a message, so the page shows a retryable error, and the session is
 * kept: the login itself is still good, and the next request refreshes again.
 */
export const SERVER_UNAVAILABLE_MESSAGE = "Can't reach the server right now. It may be restarting; try again in a moment.";
function serverUnavailable(): Response {
  return new Response(JSON.stringify({ error: "server_unavailable", message: SERVER_UNAVAILABLE_MESSAGE }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

export type ApiClientOptions = {
  token?: string | null;
  onUnauthorized?: () => void;
  /** Propagate a silently-refreshed access token back to the session store (Fable M24) so every
   *  client — not just this instance — uses the fresh token and stops re-refreshing on each request. */
  onTokenRefreshed?: (token: string) => void;
};

export class ApiClient {
  private token: string | null;
  private readonly onUnauthorized: (() => void) | undefined;
  private readonly onTokenRefreshed: ((token: string) => void) | undefined;

  constructor({ token, onUnauthorized, onTokenRefreshed }: ApiClientOptions = {}) {
    this.token = token ?? null;
    this.onUnauthorized = onUnauthorized;
    this.onTokenRefreshed = onTokenRefreshed;
  }

  private buildHeaders(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    if (this.token) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }
    return headers;
  }

  /**
   * Executes a fetch and, on a 401, attempts exactly one silent refresh + retry.
   * The `retried` boolean (NOT header inspection) guards against unbounded recursion.
   *
   * Only a REFUSED refresh signs the user out. One the server could not answer is retried for up to
   * about two minutes, then keeps the session and answers 503 (`session-refresh.ts`): signing out there
   * turned every deploy into a logout.
   */
  private async fetchWithAuth(
    url: string,
    build: () => RequestInit,
    retried = false
  ): Promise<Response> {
    const res = await fetch(url, build());
    if (res.status === 401 && !retried) {
      const refresh = await refreshSession();
      if (refresh.kind === "ok") {
        // Propagated to the session store too, so every client uses it (Fable M24).
        this.token = refresh.token;
        this.onTokenRefreshed?.(refresh.token);
        return this.fetchWithAuth(url, build, true);
      }
      if (refresh.kind === "unavailable") return serverUnavailable();
      this.onUnauthorized?.();
      return res;
    }
    if (res.status === 401) {
      this.onUnauthorized?.();
    }
    return res;
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (response.status === 401) {
      const body = await response.text().catch(() => "");
      throw new ApiError(401, body, "Session expired. Please sign in again.");
    }
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      let message = `Request failed (${response.status})`;
      try {
        const json = JSON.parse(raw) as Record<string, unknown>;
        if (typeof json.message === "string" && json.message) {
          message = json.message;
        } else if (response.status === 403) {
          message = "You don't have permission to perform this action.";
        } else if (response.status === 404) {
          message = "Resource not found.";
        } else if (raw) {
          message = raw;
        }
      } catch {
        if (raw) message = raw;
      }
      throw new ApiError(response.status, raw, message);
    }
    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return undefined as T;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return undefined as T;
    }
    return response.json() as Promise<T>;
  }

  private rawGet<T>(path: string, init?: RequestInit): Promise<T> {
    return this.fetchWithAuth(`${API_BASE}${path}`, () => ({
      ...init,
      method: "GET",
      headers: this.buildHeaders(init?.headers),
      cache: "no-store",
      credentials: "include"
    })).then((r) => this.handleResponse<T>(r));
  }

  get<T>(path: string, init?: RequestInit): Promise<T> {
    // A custom RequestInit (abort signals etc.) bypasses the dedup cache.
    if (init) return this.rawGet<T>(path, init);
    const key = `${this.token ?? "anon"}|${path}`;
    const now = Date.now();
    const cached = getCache.get(key);
    if (cached && now - cached.at < GET_TTL_MS) {
      return cached.promise as Promise<T>;
    }
    const promise = this.rawGet<T>(path);
    getCache.set(key, { at: now, promise: promise as Promise<unknown> });
    // Never cache a failure; evict once the short TTL window elapses.
    promise.catch(() => {
      if (getCache.get(key)?.promise === promise) getCache.delete(key);
    });
    setTimeout(() => {
      if (getCache.get(key)?.promise === promise) getCache.delete(key);
    }, GET_TTL_MS);
    return promise;
  }

  /**
   * Like {@link get} but also returns the response headers, so callers can read pagination
   * metadata (e.g. `X-Total-Count` on the cases worklist — #150 M10). The server must expose
   * the header via CORS `Access-Control-Expose-Headers` for cross-origin reads to succeed.
   */
  async getWithHeaders<T>(path: string, init?: RequestInit): Promise<{ data: T; headers: Headers }> {
    const response = await this.fetchWithAuth(`${API_BASE}${path}`, () => ({
      ...init,
      method: "GET",
      headers: this.buildHeaders(init?.headers),
      cache: "no-store",
      credentials: "include"
    }));
    const data = await this.handleResponse<T>(response);
    return { data, headers: response.headers };
  }

  post<TBody = unknown, TResponse = unknown>(path: string, body?: TBody, init?: RequestInit): Promise<TResponse> {
    const hasBody = body !== undefined;
    return this.fetchWithAuth(`${API_BASE}${path}`, () => {
      const headers = this.buildHeaders(init?.headers);
      if (hasBody) {
        headers.set("Content-Type", "application/json");
      }
      return {
        ...init,
        method: "POST",
        headers,
        body: hasBody ? JSON.stringify(body) : undefined,
        credentials: "include"
      };
    }).then((r) => this.handleResponse<TResponse>(r))
      .finally(bustGetCache); // bust on success OR failure — a clean 4xx didn't write, but a 5xx may have partially
  }

  postForm(path: string, formData: FormData, init?: RequestInit): Promise<unknown> {
    return this.fetchWithAuth(`${API_BASE}${path}`, () => ({
      ...init,
      method: "POST",
      headers: this.buildHeaders(init?.headers),
      body: formData,
      credentials: "include"
    }))
      .then((r) => this.handleResponse<unknown>(r))
      .finally(bustGetCache); // bust on success OR failure (a 5xx may have partially written)
  }

  put<TBody = unknown, TResponse = unknown>(path: string, body?: TBody, init?: RequestInit): Promise<TResponse> {
    const hasBody = body !== undefined;
    return this.fetchWithAuth(`${API_BASE}${path}`, () => {
      const headers = this.buildHeaders(init?.headers);
      if (hasBody) {
        headers.set("Content-Type", "application/json");
      }
      return {
        ...init,
        method: "PUT",
        headers,
        body: hasBody ? JSON.stringify(body) : undefined,
        credentials: "include"
      };
    }).then((r) => this.handleResponse<TResponse>(r))
      .finally(bustGetCache); // bust on success OR failure — a clean 4xx didn't write, but a 5xx may have partially
  }

  delete<TResponse = unknown>(path: string, init?: RequestInit): Promise<TResponse> {
    return this.fetchWithAuth(`${API_BASE}${path}`, () => ({
      ...init,
      method: "DELETE",
      headers: this.buildHeaders(init?.headers),
      credentials: "include"
    })).then((r) => this.handleResponse<TResponse>(r))
      .finally(bustGetCache); // bust on success OR failure — a clean 4xx didn't write, but a 5xx may have partially
  }

  async downloadBlob(path: string): Promise<Blob> {
    const response = await this.fetchWithAuth(`${API_BASE}${path}`, () => ({
      headers: this.buildHeaders(),
      credentials: "include"
    }));
    if (response.status === 401) {
      throw new ApiError(401, "", "Unauthorized");
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ApiError(response.status, body, `Download failed (${response.status})`);
    }
    return response.blob();
  }
}
