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

export async function signInWithCredentials(email: string, password: string): Promise<LoginResponse> {
  const response = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  if (!response.ok) {
    let message = "Invalid email or password.";
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
