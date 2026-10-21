/**
 * OAuth clients of the MCP authorization server, with nothing stored.
 *
 * - **CIMD** (`client_id` is an https URL): the client is what its fetched metadata document says
 *   (`cimd.ts`); its identity is the document's host, so it may use https redirects.
 * - **Dynamic Client Registration** (RFC 7591; deprecated by MCP 2026-07-28 but what `mcp-remote` uses): the
 *   `client_id` returned is itself a signed record of the registration (a `client` token, one year), so
 *   nothing is written. Anyone may register, under any name, so a registration may only use loopback
 *   redirects and is shown on the consent page as self-registered and unverified.
 */
import { CimdError, cleanClientName, fetchClientMetadata, type CimdDeps } from "./cimd.ts";
import { redirectProblem, type ClientTrust } from "./redirect-uris.ts";
import { readMcpToken, signMcpToken } from "../mcp-token.ts";

export interface ResolvedClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  trust: ClientTrust;
  /** The verified host for a CIMD client; absent for a self-registered one. */
  host?: string;
}

export class ClientError extends Error {}

const REGISTRATION_TTL_SECONDS = 365 * 86_400;

/** The client a `client_id` names, or a `ClientError`. */
export async function resolveClient(secret: string, clientId: string, cimd: CimdDeps = {}): Promise<ResolvedClient> {
  if (clientId.startsWith("https://")) {
    try {
      const meta = await fetchClientMetadata(clientId, cimd);
      return { clientId, clientName: meta.clientName, redirectUris: meta.redirectUris, trust: "cimd", host: meta.host };
    } catch (err) {
      throw new ClientError(err instanceof CimdError ? err.message : "client metadata could not be read");
    }
  }
  const claims = readMcpToken(secret, "client", clientId);
  const name = cleanClientName(claims?.client_name);
  const uris = claims?.redirect_uris;
  if (!claims || !name || !Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string" && redirectProblem(u, "dcr") === null)) {
    throw new ClientError("unknown client_id");
  }
  return { clientId, clientName: name, redirectUris: uris as string[], trust: "dcr" };
}

export interface RegistrationResult {
  status: 201 | 400;
  body: Record<string, unknown>;
}

/** `POST /oauth/register` (RFC 7591): validate, then return a signed client id. */
export function registerClient(secret: string, request: unknown): RegistrationResult {
  const invalid = (error: string, description: string): RegistrationResult => ({ status: 400, body: { error, error_description: description } });
  if (!request || typeof request !== "object" || Array.isArray(request)) return invalid("invalid_client_metadata", "the body must be a JSON object");
  const r = request as Record<string, unknown>;
  const uris = r.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string")) {
    return invalid("invalid_redirect_uri", "redirect_uris must list 1 to 10 URIs");
  }
  const refused = (uris as string[]).find((u) => redirectProblem(u, "dcr") !== null);
  if (refused) return invalid("invalid_redirect_uri", `${redirectProblem(refused, "dcr")}: ${refused.slice(0, 200)}`);
  if (r.token_endpoint_auth_method !== undefined && r.token_endpoint_auth_method !== "none") {
    return invalid("invalid_client_metadata", "only public clients (token_endpoint_auth_method none) may register");
  }
  const grants = r.grant_types ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grants) || !grants.every((g) => g === "authorization_code" || g === "refresh_token")) {
    return invalid("invalid_client_metadata", "grant_types may be authorization_code and refresh_token only");
  }
  const responseTypes = r.response_types ?? ["code"];
  if (!Array.isArray(responseTypes) || !responseTypes.every((t) => t === "code")) return invalid("invalid_client_metadata", "response_types may be code only");
  const clientName = cleanClientName(r.client_name) ?? "Unnamed MCP client";
  const clientId = signMcpToken(secret, "client", { client_name: clientName, redirect_uris: uris }, REGISTRATION_TTL_SECONDS);
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    status: 201,
    body: {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      client_name: clientName,
      redirect_uris: uris,
      grant_types: grants,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  };
}
