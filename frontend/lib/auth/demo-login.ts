const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "")
  .trim()
  .replace(/\/+$/, "");

export const DEMO_EMAIL = "admin@workwell.dev";
export const DEMO_PASSWORD = "Workwell123!";

// The public sandbox auto-signs in as a read-only viewer (ROLE_VIEWER): visitors can browse every
// read surface, but the backend blocks all non-GET requests for this role — so anonymous traffic can't
// mutate the shared demo state or trigger compute. Kept distinct from the admin demo account used on
// the login form.
export const SANDBOX_EMAIL = "viewer@workwell.dev";
export const SANDBOX_PASSWORD = DEMO_PASSWORD;

export type LoginResponse = {
  token: string;
  email: string;
  role: string;
};

/** How long sign-in waits for the server before saying it did not answer (#663). */
export const LOGIN_TIMEOUT_MS = 20_000;

export const SERVER_DID_NOT_RESPOND =
  "The WorkWell server did not respond. It may be restarting — try again in a minute. If this keeps happening, tell your WorkWell contact.";

export async function signInWithCredentials(email: string, password: string): Promise<LoginResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
  } catch {
    // A network failure, a CORS failure (a gateway error page carries no CORS headers) or the timeout.
    // All three mean the server did not answer; the browser's own text ("Failed to fetch") says none of
    // that, and on 2026-09-22 it was all a pilot user saw during a half-hour outage (#663).
    throw new Error(SERVER_DID_NOT_RESPOND);
  }

  if (!response.ok) {
    // A 5xx is the server's problem, never the user's password. The default below used to apply to
    // every status, so a gateway 502/504 with a non-JSON body told the user their password was wrong.
    let message =
      response.status >= 500
        ? `The WorkWell server is having trouble (error ${response.status}). Try again in a minute.`
        : "Invalid email or password.";
    try {
      const json = (await response.json()) as { message?: string; error?: string };
      if (json.message) message = json.message;
      else if (response.status === 401 || response.status === 403) message = "Invalid email or password.";
      else if (response.status === 400) message = "Please enter a valid email and password.";
    } catch {
      // non-JSON body — use the default message above
    }
    throw new Error(message);
  }

  const payload = (await response.json()) as Partial<LoginResponse>;
  if (!payload.token || !payload.email || !payload.role) {
    throw new Error("Login response was incomplete.");
  }

  return {
    token: payload.token,
    email: payload.email,
    role: payload.role
  };
}
