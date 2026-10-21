# WorkWell MCP

WorkWell exposes a read-only MCP surface for programmatic inspection of cases, runs, measures, measure versions, structured outcome explanations, employee compliance status, and data quality gaps.

## Transport

`POST /mcp`: Streamable HTTP, served by the official TypeScript SDK v2 (`@modelcontextprotocol/server`
2.3.1, owner-approved 2026-10-20; `backend-ts/src/routes/mcp.ts`).

- **Protocol versions:** 2026-07-28 (stateless: `_meta` on every request, `server/discover`, the
  `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` headers) and the 2025 versions most clients still send
  (`initialize` first), both answered statelessly on the same endpoint.
- **One answer per request:** plain JSON for 2026-07-28, a single-message event stream (closed at once) for the
  2025 versions. GET and DELETE answer 405; there are no sessions.
- **Retired 2026-10-20:** the 2024-11-05 HTTP+SSE transport (`GET /sse` + `POST /mcp/message`). The spec
  deprecates it and the SDK does not serve it; point a client at `/mcp` instead.
- **Browser pages:** a request with an `Origin` header must come from one of `WORKWELL_CORS_ALLOWED_ORIGINS`
  exactly (else 403). Native clients send no `Origin`.

## Security boundary

**Transport access.** `POST /mcp` accepts only an **MCP token** (#704), never the login token:
- An MCP token is signed with a key for its kind, never the login key, and its audience is this endpoint
  (`<WORKWELL_PUBLIC_API_URL>/mcp`), as the 2026-07-28 spec requires.
- It is refused on every other route (`/api/**`, `/api/auth/*`, `/cds-services/**`, `/$cql`).
- **Revocable one by one:** revoking takes effect on the next request.
- **Tied to its owner's current password:** it carries the account's credential version, so a password change
  ends it.
- Its role is `ROLE_CASE_MANAGER` or `ROLE_ADMIN`, never above its owner's.
- The account must still exist and be allowed on this deployment (Maui refuses another deployment's demo
  accounts).
- **Fails closed:** if the token store cannot be read, the answer is 503, never a pass.
- **Behaviour change 2026-10-20:** a `ROLE_MCP_CLIENT` login token no longer opens `/mcp`. It still opens CDS
  invoke and `$cql`; no real account has that role.

**Tool execution.** Each tool enforces its own application-role policy (the matrix below) before running any
query.

- There is no public MCP mode in production.
- MCP tool calls are audited as `MCP_TOOL_CALLED` regardless of outcome (including access-denied), with the
  calling credential (`pat:<token id>`); the actor is the token's owner.
- Invalid arguments reach the tool, which refuses them, so they are audited too (the SDK's own schema check is
  deliberately a pass-through).
- Denied tool calls return a structured `ACCESS_DENIED` safe error and are audited with `success=false`.

## MCP tokens (Admin → MCP access)

An admin mints a token for themselves:
- **Where:** on the Admin page, or `POST /api/admin/mcp-tokens` `{ label, role?, days? }`.
- **Role:** Case Manager by default, or Admin.
- **Lifetime:** 30 days by default, at most 90.
- **Shown once:** the token appears only in the mint response. The issued and revoked events
  (`MCP_TOKEN_ISSUED`, `MCP_TOKEN_REVOKED`, both audited before the change) never hold it.
- **Listing:** `GET /api/admin/mcp-tokens` lists tokens as active, revoked or expired, and
  `DELETE /api/admin/mcp-tokens/{id}` revokes one.

No new table: each token is one row in `auth_refresh_families` (`mcp-pat:<id>`).

## Connecting a client

Paste the token where the examples say `<token>`. The URL is your stack's API plus `/mcp`.

**Claude Code** (set `WORKWELL_MCP_TOKEN` first with `read -rs WORKWELL_MCP_TOKEN; export WORKWELL_MCP_TOKEN`, so
the token stays out of shell history):

```bash
claude mcp add --transport http workwell https://twh-api-ts.os.mieweb.org/mcp --header "Authorization: Bearer $WORKWELL_MCP_TOKEN"
```

**Claude Desktop**, through `mcp-remote` (`claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "workwell": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://twh-api-ts.os.mieweb.org/mcp", "--transport", "http-only", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <token>" }
    }
  }
}
```

- **Windows:** write `Authorization:${AUTH_HEADER}` rather than putting `Authorization: Bearer …` in `args`,
  because Windows can split the argument at the space. On Windows, `"command": "cmd"` with
  `"/c", "npx", …` also works.
- **Errors:**
  - a 401 means the token is revoked, expired or no longer valid for the account: mint a new one. The 401
    names the OAuth metadata, so a client that supports sign-in may offer to sign in instead (below);
  - a 503 `mcp_unavailable` means either the stack's `WORKWELL_PUBLIC_API_URL` is unset or invalid, or the
    token store could not be read (try again).
- **Status in the list:** "active" means not revoked and not expired. A token minted before its owner's password
  changed lists as active but is refused.

## OAuth sign-in (no token to copy)

WorkWell is also an OAuth 2.1 authorization server for its MCP endpoint, as MCP 2026-07-28 describes
(`backend-ts/src/routes/oauth.ts`), so a client can connect by signing in rather than with a pasted token.

**Connecting a client:**
- **claude.ai** (custom connector, also used by Claude Desktop and mobile): add the connector with the URL
  `https://twh-api-ts.os.mieweb.org/mcp` and nothing else.
- **Claude Code:** `claude mcp add --transport http workwell https://twh-api-ts.os.mieweb.org/mcp`, with no
  header.
- **mcp-remote:** the URL with `--transport http-only` and no header.

**What happens:**
1. The client reads the metadata the 401 points to and opens WorkWell in the browser.
2. The user signs in as usual, sees the consent page, and approves.
3. The client gets tokens that refresh themselves.
4. The connection appears in Admin → MCP access as a *connected client*, where an admin can disconnect it.

**Endpoints:**
- `/.well-known/oauth-protected-resource/mcp` (and at the root): `resource` is the `/mcp` URL, and
  `authorization_servers` is this API.
- `/.well-known/oauth-authorization-server`: issuer is this API; `S256`; public clients only
  (`token_endpoint_auth_methods_supported: ["none"]`); `client_id_metadata_document_supported`; `iss` in
  responses.
- `/oauth/register` (Dynamic Client Registration), `/oauth/authorize`, `/oauth/token`, and the consent API
  `/api/oauth/consent`.

**Rules:**
- **Clients.** A client whose `client_id` is an https URL is described by the metadata document at that URL
  (CIMD; Claude's own clients):
  - it is fetched only from an accepted publisher, `WORKWELL_OAUTH_CIMD_HOSTS` (default `claude.ai`, which
    publishes both the connector's and Claude Code's documents); any other host is refused before a request;
  - over https on port 443 only, with every resolved address checked at connect time (no private, loopback
    or link-local address), no redirects, 64 KB and 5 s at most;
  - at most 4 fetches in flight and 20 a minute, one per URL at a time, documents and failures cached apart;
    the last good document stands in for up to a day while the publisher cannot answer (a timeout, 5xx or
    429), never when it answers no;
  - its identity is that host, shown on the consent page, except when the code goes to a loopback address
    (Claude Code): a document proves who published the client, not which program listens on the port, so
    the page warns instead of calling it verified.

  A self-registered client (DCR, what `mcp-remote` uses) may use loopback redirects only
  (`http://localhost`, `127.0.0.1` or `[::1]`, any port; 2,048 characters in all), and the consent page
  marks it unverified. Nothing about a client is stored.
- **Authorize.**
  - PKCE `S256` and `resource` naming the `/mcp` URL are required (compared as URLs: host case, `:443` and a
    trailing slash do not matter); unknown scopes (e.g. `offline_access`) are ignored.
  - `redirect_uri` may be left out when the client registered exactly one; the token request then may leave
    it out too.
  - An unknown client or redirect gets an error page that never redirects. Later errors go back to the
    client with `error`, `state` and `iss`.
- **Consent.** The page is in the web app, behind sign-in. Only a Case Manager or Admin may approve, and the
  grant carries their role and credential version. Anyone signed in may decline: the details the page reads
  carry the `access_denied` redirect, so declining needs no write (a viewer may never POST). It may not be
  framed.
- **Tokens.**
  - The access token lasts 15 minutes; its audience is the `/mcp` URL, and it works there only.
  - The refresh token lasts 30 days, sliding, up to 90 days for the grant, and rotates on every use. A refresh
    token used again revokes the grant, except within 5 seconds of a concurrent refresh, which is refused
    without revoking and audited (`OAUTH_REFRESH_RACE_REFUSED`): a thief who refreshed first looks the same.
  - The user is re-checked on every refresh.
  - The code is single use (60 seconds); a second redemption revokes what the first produced.
- **Revocation.** An admin disconnects a client in Admin → MCP access, and its access tokens stop at once. A
  password change also ends every grant.
- **Audited first:** `OAUTH_CONSENT_GRANTED`, `OAUTH_TOKEN_ISSUED`, `OAUTH_REFRESH_REUSE_DETECTED`,
  `OAUTH_CODE_REUSE_DETECTED`, `OAUTH_GRANT_REVOKED`; `OAUTH_REFRESH_RACE_REFUSED` records a refused race.
  None holds a token.
- **No new table:** codes and grants are `auth_refresh_families` rows (`oauth-code:<id>`, `oauth:<id>`).

**Not yet:**
- per-caller rate limits on the authorize, register, token and consent endpoints
  (`PRODUCTION_READINESS_2026-07.md` gap 13; the CIMD fetch has its own global limits, above);
- an opaque authorization code: the code is a signed token whose claims (the user's email and role, the
  client, the PKCE challenge) can be read by anyone who sees the redirect URL, such as browser history. It is
  single use, lasts 60 seconds and is useless without the PKCE verifier;
- CORS on the token endpoint for browser-based clients.

## Tool posture

- MCP tools are read-only.
- Tool arguments are sanitized before audit persistence.
- Invalid tool arguments return safe structured errors and still generate audit records.
- MCP tools never decide compliance; CQL remains the source of truth.
- `check_compliance` derives status from persisted CQL outcomes only — AI is never consulted.
- `check_compliance` and `get_employee` serve only outcomes from FINALIZED runs (`COMPLETED`/
  `PARTIAL_FAILURE`) — the same rule as the compliance API (ADR-061). A row written by a run still in
  progress is never an answer; with no finalized outcome, `check_compliance` returns `NO_OUTCOME`
  and says so (#491).
- `explain_rule` returns deterministic metadata from measure spec and CQL; no AI is used.

## Which logic a response names (#769)

- **Measure tools describe the catalog record.** On `list_measures`, `get_measure_version` and
  `explain_rule`, `policyRef` is the catalog's QDM lineage (`CMS125v14`), **not what runs**, and `version`
  is the record's own (`v1.0`). Each adds `executed` (the CMS FHIR artifact this deployment routes the
  measure to: `ecqmId` `CMS125FHIR`, `version` `1.0.000`, `derivedFrom`, `status`, `statusNote`) and
  `translation` (a routed WorkWell translation: `label`, `version`, `url`, `derivedFrom`, `year`), computed
  exactly as `/api/measures` computes `identity.executed`/`identity.translation`; both `null` when nothing
  official is routed. The executed version appears only inside those objects, beside its own id: no
  response pairs a QDM id with it (LOCKED §4.3).
- **`explain_rule` on a measure routed to CMS's artifact returns `cqlDefines: []`** and a `logicNote`
  naming the logic that runs: the record's authored CQL is not what the deployment executes, so its
  defines are omitted rather than offered as the rule.
- **Case and outcome tools name the row's logic.** `get_case`, `list_cases`, `list_noncompliant`,
  `check_compliance`, `explain_outcome` and each `get_employee` `latestOutcomes[]` entry carry `logic`,
  read from the evidence of the outcome the answer is about (a case's cited outcome: `lastRunId`, subject,
  measure), never from today's routing: `{ kind: "cms-artifact", ecqmId, version, derivedFrom, status,
  statusNote }`, `{ kind: "workwell-translation", label, version, url, derivedFrom }` (never an eCQM id),
  or `null` for authored CQL, an errored row or no row. Their `measureVersion` / `measure_version` /
  `version` is that row's version: `""` for an errored or missing row, never the authored library's for a
  row CMS's artifact scored. On a `staff_closed` row `logic` describes the frozen status, not `live_*`.
- `list_runs` `measure_version` is the run read model's, as on the run detail and the runs CSV.

## Tool inventory (server 3.0.0)

Every tool has a `title` and the annotations `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: true`, `openWorldHint: false`. An object result is also returned as `structuredContent`,
beside the JSON text block.

### Tool role matrix

The table below shows **tool-execution** roles (transport access is separate — see above).

| Tool | Required application roles | Data sensitivity |
|------|---------------------------|-----------------|
| `get_case` | CASE_MANAGER, ADMIN | Restricted — employee/case data |
| `list_cases` | CASE_MANAGER, ADMIN | Restricted — employee/case data |
| `get_run_summary` | CASE_MANAGER, ADMIN | Restricted — run/outcome data. `pass_rate` is `null` and `data_insufficient` names the measures when the run's data was too thin to trust (#853) |
| `list_runs` | CASE_MANAGER, ADMIN | Restricted — run/outcome data. `compliance_rate` is `null` when nobody is in the workflow denominator (e.g. a queued run, or the first days of a measurement year), and when `data_insufficient` names a measure whose data was too thin to trust (#853) |
| `explain_outcome` | CASE_MANAGER, ADMIN | Restricted — employee/case evidence |
| `get_employee` | CASE_MANAGER, ADMIN | Restricted — employee/compliance data |
| `check_compliance` | CASE_MANAGER, ADMIN | Restricted — employee/compliance data |
| `list_noncompliant` | CASE_MANAGER, ADMIN | Restricted — employee/case data |
| `list_measures` | AUTHOR, APPROVER, CASE_MANAGER, ADMIN | Internal — measure catalog |
| `get_measure_version` | AUTHOR, APPROVER, CASE_MANAGER, ADMIN | Internal — measure spec/CQL |
| `explain_rule` | AUTHOR, APPROVER, CASE_MANAGER, ADMIN | Internal — deterministic metadata |
| `get_measure_traceability` | AUTHOR, APPROVER, CASE_MANAGER, ADMIN | Internal — traceability matrix |
| `list_data_quality_gaps` | AUTHOR, APPROVER, CASE_MANAGER, ADMIN | Internal — data readiness |

An MCP token carries `ROLE_CASE_MANAGER` or `ROLE_ADMIN`, so it reaches every tool its role is listed for.

## Tool schema examples

### `get_employee`
```json
{ "employeeExternalId": "emp-006" }
```
Returns: `employeeExternalId`, `name`, `role`, `site`, `active`, `latestOutcomes[]` (each with the row's `version` and `logic`)

### `check_compliance`
```json
{
  "employeeExternalId": "emp-006",
  "measureName": "Annual Audiogram",
  "evaluationDate": "2026-05-09",
  "mode": "latest"
}
```
`mode` values: `latest` (persisted outcome), `preview` (same data, labeled preview — no new records). `complianceDecisionSource` is always `cql_outcome`. `decisionAvailable` is `true` when a **finalized** outcome row exists and `false` when the status is `NO_OUTCOME` — a row written by a run still in progress does not count (#491). `evaluationDate` is reserved and currently ignored; the latest finalized outcome is served regardless. An unresolved `measureName` returns `MEASURE_NOT_FOUND`, and the returned `caseId` is only ever a case whose own outcome status matches the served status (a case reshaped mid-run by a newer, unfinished evaluation is not attached).

### `list_noncompliant`
```json
{
  "measureName": "Annual Audiogram",
  "site": "Plant A",
  "status": "OVERDUE",
  "providerId": "maui-prov-012",
  "ageBand": "65+",
  "sex": "F",
  "payer": ["1", "11"],
  "listId": "9f1c2b3a-0000-4000-8000-000000000001",
  "limit": 25
}
```
Valid `status` values: `DUE_SOON`, `OVERDUE`, `MISSING_DATA`. Default limit 25, max 100. Each result
row carries `providerId` and `payer` alongside the case fields.

`listId` (ADR-082) restricts the answer to an attributed list's MATCHED members — the patients an ACO
says are this group's. It **exposes nothing this tool's role gate did not already expose**: the tool is
CASE_MANAGER/ADMIN-restricted and already returns these cases; the argument only narrows which. An
unknown id is `LIST_NOT_FOUND`, never an unfiltered list, and a list none of whose identifiers
resolved returns nothing rather than everyone. The resolution goes through the same helper the HTTP
surfaces use, so a client and a screen cannot disagree about who is in a list.

The panel filters are the same ones the roster and the CSV exports apply, through one predicate
(`compliance/subject-filters.ts`), so a client and a screen cannot disagree about what a panel is.
`providerId` is the PCP's **external id**, never a display name. An unrecognised `ageBand` or `sex`
returns `INVALID_ARGUMENT` rather than the unfiltered worklist — a tool that silently ignores a filter
looks exactly like one that applied it.

**`payer` is a SET, and asking for one Medicare code is the trap.** It takes one or more Source of
Payment Typology codes, as a comma list or an array, and matches a subject whose code equals ANY of
them. The typology is hierarchical: `1` is Medicare and `11` is its managed-care child (Medicare
Advantage) — on the pilot corpus 3,927 and 2,900 patients — so a client asking for `"1"` alone gets
the smaller set under a heading that says Medicare. Send both. Unlike `ageBand` and `sex`, payer
terminology is OPEN: an unknown code is accepted and matches nobody, rather than erroring on a real
Coverage code the display table has not been taught.

### `explain_rule`
```json
{ "measureName": "Annual Audiogram" }
```
Returns: `measureName`, `policyRef`, `description`, `eligibility`, `complianceWindow`, `requiredDataElements`, `cqlDefines[]`, `executed`, `translation`, `logicNote` (official-routed only), `attachedValueSets[]`, `source: "deterministic_metadata"`

### `get_measure_traceability`
```json
{ "measureName": "Annual Audiogram" }
```

### `list_data_quality_gaps`
```json
{ "measureName": "Annual Audiogram" }
```

## Safe error format

Invalid arguments or missing records return a structured error — no stack traces:
```json
{
  "error": true,
  "code": "EMPLOYEE_NOT_FOUND",
  "message": "Employee not found: emp-ghost"
}
```

Error codes used: `ACCESS_DENIED`, `EMPLOYEE_NOT_FOUND`, `MEASURE_NOT_FOUND`, `CASE_NOT_FOUND`, `INVALID_ARGUMENT`

## Audit record (MCP_TOOL_CALLED)

Every tool call writes an audit event regardless of success or failure:

```json
{
  "toolName": "list_noncompliant",
  "sanitizedArguments": { "measureName": "Annual Audiogram", "limit": 25 },
  "argumentHash": "<sha256>",
  "resultSize": 12,
  "success": true,
  "sensitivityLabel": "restricted",
  "timestamp": "2026-05-10T12:00:00Z"
}
```

## Operational notes

- `list_cases` and `get_case` are the primary case inspection tools. `list_cases` takes
  `status: open | closed | staff_closed | all`; **`staff_closed`** is every terminal case a PERSON
  closed (#569, ADR-083), and on that filter each row additionally carries `live_state`
  (`GAP | CLEAR | UNKNOWN`), `live_outcome_status` (the canonical bucket) and `live_display_status`
  (what a surface renders — an out-of-population patient is canonical `MISSING_DATA` and display
  `OUT_OF_POPULATION`, and a client given only the bucket would call them a gap). The live pair
  exists because `current_outcome_status` on such a row is frozen at the moment of closure
  (`DATA_MODEL_CONTRACTS` §4), so a client reading only that field would be handed a months-old status
  under a field name that reads as current. Every row on every filter now carries `closure`
  (`NONE | STAFF | SYSTEM`), `closed_by`, `closed_reason` and `closed_at`, so a client can tell a
  person's closure from the nightly run's. **This tool applies no period filter**, so
  `status=staff_closed` returns ALL history — each row's `live_state` is today's answer while its
  `evaluation_period` may name a closed cycle. Same as the cases CSV (`DATA_MODEL_CONTRACTS` §6.3),
  and unlike the work list's own staff-closed view, which defaults to the current cycle.
- `get_run_summary`, `list_runs`, `list_measures`, `get_measure_version`, and `explain_outcome` expose the operational read surface.
- `get_employee` and `check_compliance` are the primary employee-facing tools.
- `list_noncompliant` is equivalent to a filtered worklist query — it lists ACTIVE cases, which makes
  it **the work queue, not the non-compliant population**. A patient whose case a person closed is
  absent from it while the measure still counts them as a gap (ADR-083 d4); `list_cases` with
  `status=staff_closed` is where those are. Deliberately unchanged: widening this tool would change
  what "work" means for every existing client.
- `explain_rule` replaces ad-hoc policy lookups with deterministic spec metadata.
- Any future MCP write surface must go through a separate security review and documentation update.
