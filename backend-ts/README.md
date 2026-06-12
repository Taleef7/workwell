# `backend-ts/` — WorkWell TypeScript backend on `@mieweb/cloud`

Phase 0 skeleton for **issue #96** (de-Java re-platform). See **ADR-008**
(`../docs/DECISIONS.md`), the execution plan
(`../docs/superpowers/plans/2026-06-12-issue-96-dejava-replatform.md`), and the
companion analysis (`../docs/MIEWEB_CLOUD_REFACTOR_MEMO.md`).

This worker-style TypeScript app replaces the Java/Spring `backend/` **incrementally**
(strangler-fig). The Java `backend/` and the `frontend/` stay untouched as the reference
until each surface reaches parity.

## Layout

```
backend-ts/
├─ wrangler.jsonc      # Cloudflare reference config — WHICH bindings exist (DB/BUCKET/CACHE/JOBS)
├─ mieweb.jsonc        # per-target driver map (local→sqlite/fs/memory/inproc; mieweb→libsql/s3/valkey)
├─ pnpm-workspace.yaml # self-contained workspace; pulls @mieweb/cloud-* from the submodule
├─ tsconfig.json
└─ src/
   ├─ worker.ts        # HTTP entry (export default { fetch }) — health/version wired, rest 501
   ├─ stores/          # storage CONTRACTS (RunStore…) — adapters land Phase 2 (#104)
   └─ engine/          # EvaluateMeasure compute binding — real impls land Phase 3 (#106)
```

## How `@mieweb/cloud` is consumed (no repo-root workspace)

`@mieweb/cloud` is **not on npm yet** (v0.0.0) and is co-developed via the git submodule at
`../external/mieweb-cloud`. Its packages use `workspace:*` internally, so they can't be
consumed by a plain `file:` link. Instead, **`backend-ts/` is its own pnpm workspace** whose
`pnpm-workspace.yaml` includes `../external/mieweb-cloud/packages/*` as members — resolving the
whole graph from source **without** turning the WorkWell repo root into a workspace
(`frontend/` and `backend/` keep their own setups).

```bash
git submodule update --init --recursive          # fetch external/mieweb-cloud
corepack pnpm@10 -C backend-ts install            # link the @mieweb/cloud graph
corepack pnpm@10 -C backend-ts typecheck          # tsc --noEmit (Phase 0 green gate)
```

## Run (Phase 1, #103)

The reference runner is MIE's own CLI, which assembles config from `wrangler.jsonc` +
`mieweb.jsonc` and runs the **same** worker on any target:

```bash
corepack pnpm@10 -C backend-ts dev                # → mieweb --target local dev (port 8080)
```

> Phase-0 status: the worker, the binding shapes, and the contracts are in place and
> typecheck; running the worker end-to-end under the local host (TS-loader wiring + the
> SQLite `DB` driver) is the first task of the **Phase-1 vertical-slice spike (#103)**, which
> also proves one measure at golden parity against the Java engine — the GO/NO-GO gate.

## Mapping to the phased plan

| Dir / file | Becomes | Issue |
|---|---|---|
| `src/stores/*` | SQLite-floor + Postgres adapters (`@mieweb/cloud-postgres`) | #104 |
| auth/audit | JWT + refresh cookie + `audit_event` invariant in TS | #105 |
| `src/engine/*` | Node-ELM (preferred) / JVM-sidecar (fallback) binding; headless `evaluate(patient, yaml)` | #106 |
| `src/worker.ts` | ported endpoint groups behind the unchanged frontend contract | #107, #108 |
| `wrangler.jsonc` / `mieweb.jsonc` | Node container deploy on MIE; JVM retired | #109 |

Phase 2 (#104) graduates the reusable parts (`cloud-postgres`, `measure-engine`) into
top-level `packages/*` here.
