/**
 * `pnpm webchart:probe-auth` — one-shot SMART Backend Services probe against a real WebChart
 * instance (the teatea trial). Answers the #254 A3 residual: does a manually-registered backend
 * client get a `client_credentials` grant even though the smart-configuration advertises only
 * `authorization_code`?
 *
 *   $env:WORKWELL_WEBCHART_BASE_URL='https://teatea.webchartnow.com/webchart.cgi'
 *   $env:WORKWELL_WEBCHART_CLIENT_ID='workwell-backend'
 *   $env:WORKWELL_WEBCHART_PRIVATE_KEY=Get-Content -Raw ~\.workwell\webchart-teatea.key
 *   $env:WORKWELL_WEBCHART_SCOPE='system/*.read'
 *   pnpm webchart:probe-auth
 *
 * It reuses `smartBackendServicesAuth` UNCHANGED — the same discovery, RS384 `private_key_jwt`
 * signing, and token POST the live transport performs — observing response metadata through the
 * module's injectable `fetch`. Secrets hygiene (same posture as the auth module): the private key,
 * the signed assertion, and the access token are NEVER printed; token-response output is a
 * whitelist of non-secret fields (token_type, scope, expires_in).
 */
import { webChartConfigFromEnv, type DataSourceEnv } from "../src/engine/ingress/data-source.ts";
import { smartBackendServicesAuth } from "../src/engine/ingress/webchart/smart-backend-auth.ts";

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

/** Known OAuth error codes → what they mean for the teatea registration (the runbook's fallback map). */
const ERROR_HINTS: Record<string, string> = {
  unsupported_grant_type:
    "client_credentials is NOT enabled for this client/instance — record this in the #254 answer log and " +
    "ask MIE to enable backend services for the registered client (do not build authorization_code).",
  invalid_client:
    "the client id is unknown or the JWKS/public key does not match — re-check the registration at " +
    "webchart.cgi?f=admin&s=jwt (client id, uploaded JWK, kid).",
  invalid_scope:
    "the requested scope was refused — try WORKWELL_WEBCHART_SCOPE=system/*.read (teatea advertises the " +
    "v1 form) or check which scopes the registration granted.",
  invalid_request: "the token request shape was rejected — capture the exact registration fields and re-check.",
};

async function main(): Promise<number> {
  const cfg = webChartConfigFromEnv(process.env as DataSourceEnv);
  if (!cfg || !cfg.clientId || !cfg.privateKeyPem) {
    err("SMART pair not configured. Required env:");
    err("  WORKWELL_WEBCHART_BASE_URL   (e.g. https://teatea.webchartnow.com/webchart.cgi)");
    err("  WORKWELL_WEBCHART_CLIENT_ID + WORKWELL_WEBCHART_PRIVATE_KEY (PKCS#8 PEM)");
    err("  optional: WORKWELL_WEBCHART_SCOPE (teatea: system/*.read), WORKWELL_WEBCHART_KID, WORKWELL_WEBCHART_TOKEN_URL");
    return 2;
  }
  const fhirBase = `${cfg.baseUrl.replace(/\/+$/, "")}/fhir`;

  // 1) discovery — print the advertised (public, non-secret) auth surface
  out(`[1/3] smart-configuration @ ${fhirBase}/.well-known/smart-configuration`);
  try {
    const res = await fetch(`${fhirBase}/.well-known/smart-configuration`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const config = (await res.json()) as Record<string, unknown>;
    for (const k of [
      "token_endpoint",
      "grant_types_supported",
      "token_endpoint_auth_methods_supported",
      "token_endpoint_auth_signing_alg_values_supported",
      "scopes_supported",
    ]) {
      out(`      ${k}: ${JSON.stringify(config[k])}`);
    }
  } catch (e) {
    err(`      discovery failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // 2) the real grant — production code path, instrumented fetch observing non-secret metadata only
  out(`[2/3] client_credentials grant as ${cfg.clientId} (scope: ${cfg.scope ?? "system/*.rs (default)"})`);
  let tokenMeta: { token_type?: unknown; scope?: unknown; expires_in?: unknown } | undefined;
  const observingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (init?.method === "POST") {
      const clone = res.clone();
      try {
        const body = (await clone.json()) as Record<string, unknown>;
        tokenMeta = { token_type: body.token_type, scope: body.scope, expires_in: body.expires_in };
      } catch {
        /* non-JSON — nothing to observe */
      }
    }
    return res;
  };
  const auth = smartBackendServicesAuth(
    { fhirBase, clientId: cfg.clientId, privateKeyPem: cfg.privateKeyPem, tokenUrl: cfg.tokenUrl, scope: cfg.scope, kid: cfg.kid },
    { fetch: observingFetch },
  );
  let header: string;
  try {
    header = await auth.authorizationHeader();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err(`      GRANT FAILED: ${msg}`);
    const code = Object.keys(ERROR_HINTS).find((c) => msg.includes(`(${c})`));
    if (code) err(`      hint: ${ERROR_HINTS[code]}`);
    else err("      hint: no structured OAuth error code — check network/URL; record the status in the #254 log.");
    return 1;
  }
  out("      GRANT SUCCEEDED");
  if (tokenMeta) {
    out(`      token_type: ${JSON.stringify(tokenMeta.token_type)}  scope: ${JSON.stringify(tokenMeta.scope)}  expires_in: ${JSON.stringify(tokenMeta.expires_in)}`);
  }

  // 3) prove the token against FHIR (population read — the transport's first real call)
  out(`[3/3] GET ${fhirBase}/Patient?_count=1 with the granted token`);
  try {
    const res = await fetch(`${fhirBase}/Patient?_count=1`, {
      headers: { Accept: "application/fhir+json", Authorization: header },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    out(`      HTTP ${res.status}${typeof body.total === "number" ? ` — Patient total: ${body.total}` : ""}`);
    if (!res.ok) {
      err("      token was granted but the FHIR read was refused — likely a scope/permission gap; record it.");
      return 1;
    }
  } catch (e) {
    err(`      FHIR read failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  out("\nAll three steps green — record token lifetime + granted scope in docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md (A3).");
  return 0;
}

process.exitCode = await main();
