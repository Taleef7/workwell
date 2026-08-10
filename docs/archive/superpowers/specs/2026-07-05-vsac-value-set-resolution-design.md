# Live VSAC value-set resolution — design

Date: 2026-07-05
Status: Draft — pending owner review
Author: Taleef (with Claude)
Related: E3.2 (#90, the `ValueSetResolver` seam), E14 (#186, standards fidelity), ADR-008 (CQL is the
sole compliance authority), ADR-011/ADR-012/ADR-017 (inert-unless-configured adapter pattern)

## 1. Motivation

VSAC/UMLS credentials are now available (a UMLS Terminology Services license + API key, org "Medical
Informatics Engineering (MIE)"). This unblocks the long-deferred **live VSAC adapter behind the existing
`ValueSetResolver` port** (`backend-ts/src/engine/cql/value-set-resolver.ts`), whose docstring already
names it: *"a live VSAC adapter is a future drop-in behind the same port (no engine change)."*

This is the foundation the rest of E14 PR-3 (official-CQL execution/outcome diff) sits on. It is **not**
that full PR-3 — see §9 Out of scope.

## 2. Goals

1. A live `VsacValueSetResolver` that expands a real VSAC value-set OID → member codes via the NLM FHIR
   terminology service, authenticated with the UMLS API key.
2. A **composite** resolver that routes real OIDs to VSAC and local `urn:workwell:*` / canonical URLs to
   the existing store resolver — so enabling VSAC at runtime never breaks the local-coded measures.
3. An owner-run CLI (`pnpm resolve-valuesets`) that imports/persists real VSAC expansions into the
   `value_sets` table, audited and idempotent.
4. Zero compliance drift: the live evaluation path is unchanged for every current runnable measure
   (guarded by a cross-mode parity test).

## 3. Non-negotiable constraint (ADR-008)

Value-set expansion feeds the CQL engine; it never *decides* compliance. Turning VSAC on must not change
any current measure's `Outcome Status`. The design achieves this structurally (composite resolver +
local fallback) and proves it with a parity test, not by policy alone.

## 4. Key finding that shapes the design

Only `audiogram` runs in "expansion mode" today (`measure-registry.ts` — it is the sole measure with an
`expansionLibrary` + `valueSets`), and it references a **local** value set,
`urn:workwell:vs:audiogram-procedures` — **not** a real VSAC OID. VSAC's `$expand` cannot resolve that
URN; a naive "engine uses VSAC when the key is set" would expand it to an **empty** set → audiogram
matches nothing → every subject flips to `MISSING_DATA`. Additionally, the synthetic FHIR bundles are
stamped with WorkWell-local codes, so no current measure has real-coded data for VSAC members to match.

Therefore runtime VSAC wiring is only safe as a **tiered/composite** resolver, not a straight swap.

## 5. Architecture

### 5.1 Ports & implementations

The `ValueSetResolver` interface (`expand(valueSetUrl): Promise<CqlCode[]>`) and `buildCodeService(...)`
and the engine's expansion gate are **unchanged**. Three implementations, composed:

- **`StoreValueSetResolver`** (existing, unchanged) — reads the local `ValueSetStore`. The fallback tier.
- **`VsacValueSetResolver`** (new) — `expand(oid)` calls VSAC FHIR `ValueSet/$expand` through an injected
  `VsacClient` transport, memoized per-OID in-process (value sets are stable within a process lifetime).
- **`CompositeValueSetResolver`** (new) — routes by URL shape:
  - a real VSAC OID (matches `/^\d+(\.\d+)+$/`, e.g. `2.16.840.1.113883…`) → the VSAC tier;
  - anything else (`urn:workwell:*`, `http(s)://…` canonical URLs) → the store tier.
  This is the resolver the live engine receives when VSAC is configured.

### 5.2 Transport seam (mirrors `WebChartClient`)

- **`VsacClient`** interface: `expand(oid, opts?): Promise<VsacExpansion>` (transport-agnostic).
- **`httpVsacClient(cfg)`** — real transport over global `fetch`; no new dependency.
- **`fixtureVsacClient(fixtures)`** — deterministic, no network; used by every test.

### 5.3 Config-driven selection (inert-unless-configured)

`resolveValueSetResolver(env, store)`:
- `WORKWELL_VSAC_API_KEY` set → `CompositeValueSetResolver(new VsacValueSetResolver(httpVsacClient(...)),
  new StoreValueSetResolver(store))`.
- unset → the plain `StoreValueSetResolver(store)` (today's behavior).

Mirrors `resolveForecaster` / `resolveChannel` / `resolveDataSource` / `resolveStandingOrderProvider`.

## 6. VSAC transport & auth

- Base URL: `https://cts.nlm.nih.gov/fhir` (NLM FHIR terminology service), overridable via
  `WORKWELL_VSAC_BASE_URL`.
- Request: `GET {base}/ValueSet/{oid}/$expand` (`Accept: application/fhir+json`).
- Auth: HTTP Basic — username `apikey`, password = `WORKWELL_VSAC_API_KEY`.
- Response: parse `expansion.contains[]` → `{ code, system, display }`. If `expansion.total` >
  `contains.length`, page with `$expand?offset=&count=` until complete.
- The exact request/response shape and paging params will be **verified against NLM's live docs**
  (`documentation.uts.nlm.nih.gov`, the UTS `$expand` reference) during implementation — not trusted from
  memory.

## 7. The persist CLI — `pnpm resolve-valuesets`

Owner-run, on-demand; **not** run on deploy (mirrors `seed:scale` / `seed:quality-history`). Honors
`DATABASE_URL` so it targets the Neon ceiling; opens no local SQLite when set.

- **Target OIDs (default):** every OID in the `cms122v14` reference's `valueSets` list (~21).
- **Overrides (B, OID-parameterized):** `--oid <oid>` (repeatable) and/or `--measure <id>` resolve an
  arbitrary set — the genuinely reusable "resolve any VSAC value set into the store" tool.
- **Per OID:** `$expand` via VSAC → **upsert** into `value_sets` as `source="VSAC"` with the real codes,
  `resolution_status=RESOLVED`, `last_resolved_at=now`, `expansion_hash` (stable hash of the sorted
  code/system pairs). Idempotent by OID.
- **On expand failure:** write `resolution_status=ERROR` + `resolution_error`, report it, and continue
  (one bad OID never aborts the batch).
- **Audited:** one `VALUE_SETS_RESOLVED` audit event per OID (honors "every state change writes an audit
  event").

### 7.1 Store contract change (additive, no DDL)

Add `upsertResolvedValueSet(input)` to the `ValueSetStore` port (floor + ceiling adapters). It writes
**existing** `value_sets` columns (`oid`, `name`, `version`, `codes_json`, `code_systems`, `source`,
`status`, `resolution_status`, `resolution_error`, `last_resolved_at`, `expansion_hash`) — upsert on
`oid`. **No new column, no migration** — respects the schema-ownership rule (schema is owner-only).
Imported rows are **not** linked to a measure version (the resolver matches by OID, not by link — linking
is YAGNI here).

## 8. Runtime safety (the ADR-008 guard)

- **Composite = no drift.** audiogram keeps resolving `urn:workwell:vs:audiogram-procedures` via the store
  tier → byte-identical outcomes with the key on or off. Proven by a **cross-mode parity test**:
  audiogram evaluated with `resolveValueSetResolver({VSAC key set})` vs the default resolver → identical
  `Outcome Status` across the synthetic scenarios.
- **Fetch error throws; unknown-OID is empty.** A genuinely-unknown OID expands to `[]` (correct CQL
  "matches nothing"), but a VSAC **network/HTTP failure throws** rather than silently returning `[]` — so
  a run fails visibly instead of mis-evaluating compliance. (No current runtime measure hits VSAC, so this
  is forward-looking, but it is the invariant that keeps future real-OID measures safe.)
- **No CI/test network.** Fixtures only in tests; the CLI is the sole live-network path, run by the owner.

## 9. Out of scope (explicit)

Executing the **official** CMS122 CQL and diffing outcomes subject-by-subject (the remainder of E14 PR-3)
is a separate spec: it additionally needs the official CQL→ELM vendored **and** synthetic-data enrichment
(Encounter / hospice / frailty / palliative resources, absent today — see `outcome-diff.ts`
`UNVERIFIABLE_REASONS`). This spec makes VSAC real, persisted, and safely live behind the runtime port;
official-CQL execution rides on top of it later.

## 10. Testing

- `VsacValueSetResolver` — `fixtureVsacClient`: expand shape, paging (`total > contains.length`),
  fetch-error → throw, per-OID memoization (one client call for repeated `expand`).
- `CompositeValueSetResolver` — routing: real OID → VSAC tier, `urn:workwell:*` + canonical URL → store
  tier.
- `resolveValueSetResolver(env)` — inert without the key (returns `StoreValueSetResolver`); composite with
  it.
- **Audiogram cross-mode parity** — identical `Outcome Status` key-on vs key-off (the ADR-008 guard).
- CLI — fixture client + in-memory store: default CMS122 OID list, `--oid` override, idempotent re-run,
  ERROR row on expand failure, `VALUE_SETS_RESOLVED` audit event written.

## 11. Files (approximate)

New:
- `backend-ts/src/engine/cql/vsac-client.ts` (`VsacClient`, `httpVsacClient`, `fixtureVsacClient`)
- `backend-ts/src/engine/cql/vsac-value-set-resolver.ts`
- `backend-ts/src/engine/cql/composite-value-set-resolver.ts`
- `backend-ts/src/engine/cql/resolve-value-set-resolver.ts` (`resolveValueSetResolver(env, store)`)
- `backend-ts/src/run/cli/resolve-valuesets.ts` (+ a thin `cli/` entry) and tests for all of the above

Edited:
- `backend-ts/src/stores/value-set-store.ts` (+ `stores/sqlite/…`, `stores/postgres/…`) —
  `upsertResolvedValueSet`
- `backend-ts/src/stores/factory.ts` — no change expected (resolver is constructed in the worker); confirm
- `backend-ts/src/worker.ts` (or wherever the engine `valueSetResolver` is constructed) — use
  `resolveValueSetResolver(env, store)`
- `backend-ts/package.json` — `resolve-valuesets` script
- `.env.example` — `WORKWELL_VSAC_API_KEY`, `WORKWELL_VSAC_BASE_URL`
- Docs: `ARCHITECTURE.md` (engine + resolver), `DATA_MODEL.md` §3.4 (VSAC-sourced rows),
  `DEPLOY.md` (env vars + the owner-run CLI recipe + rollback), `MEASURES.md` (resolver note),
  `DECISIONS.md` (ADR — live VSAC resolver, composite + inert-unless-configured), `JOURNAL.md`

## 12. Secrets & ops

- `WORKWELL_VSAC_API_KEY` is a UMLS/VSAC secret — a **GitHub secret** (`WORKWELL_VSAC_API_KEY_TWH`,
  mapped in the deploy workflow) + a local env var for running the CLI. **Never committed.** The key
  briefly shared in chat during setup should be treated as exposed and regenerated via UTS → Edit Profile
  → Generate new API Key.
- On the demo stack the key stays **unset** (VSAC inert, current behavior) unless/until we deliberately
  enable it. Setting it does not change any current measure's outcomes (§8).

## 13. Reversibility

- Unset `WORKWELL_VSAC_API_KEY` → the resolver is the plain `StoreValueSetResolver` again (pre-change
  behavior).
- Imported VSAC rows are removable: `DELETE FROM workwell_spike.value_sets WHERE source = 'VSAC';`
  (schema-qualify on the Pg ceiling). No measure links depend on them.
