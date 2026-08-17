/**
 * The OpenAPI document route (ADR-068).
 *
 *   GET /api/v1/openapi.json
 *
 * One canonical path. `/api/openapi.json`, `/api/swagger`, `/swagger-ui` and `/api/docs` were all probed
 * against production and staging and all returned `501 not_implemented`; the recorded complaint was that no
 * document existed, not that it sat at the wrong path, so aliases are not added to chase guesses. The human
 * entry point is the Studio's API reference page, which reads this URL.
 *
 * PERMIT, deliberately: the document describes shapes and names roles, and carries no patient data. An
 * integrator should be able to read the contract without credentials — that is most of its value.
 */
import { openApiDocument } from "../openapi/spec.ts";

export const OPENAPI_PATH = "/api/v1/openapi.json";

export function handleOpenApi(req: Request): Response | null {
  if (new URL(req.url).pathname !== OPENAPI_PATH) return null;
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(openApiDocument(), null, 2), {
    headers: {
      // `application/openapi+json` is not registered; `application/json` is what every renderer and
      // validator actually accepts, so the specific one would only break tooling.
      "content-type": "application/json",
      // The document changes only when the code does, so a short cache is safe and keeps a docs page snappy.
      "cache-control": "public, max-age=300",
    },
  });
}
