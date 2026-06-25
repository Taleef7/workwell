# E11.2b — Rule Builder UI Implementation Plan (#183)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Studio "Rule Builder" tab — a structured form whose output is the codegen's `{rule, bindings}` — with a live generated-CQL preview and an atomic save that persists the params + generated CQL to the measure version.

**Architecture:** Backend adds a spec extension (`MeasureSpec.rule?/ruleBindings?`, additive JSONB) + a stateless `POST /api/measures/:id/rule/preview` and an atomic `PUT /api/measures/:id/rule` (generate → persist spec params + cql_text → compile → audit), reusing `generateCql` + `toCompileResponse`. Frontend adds a `RuleBuilderTab` (mirrors `SpecTab`) registered as a new Studio tab. RBAC AUTHOR/ADMIN; CQL stays canonical (ADR-015); no schema, no new deps.

**Tech Stack:** backend-ts (`@mieweb/cloud` worker, `node --test`); frontend (Next.js, React, Vitest + RTL).

---

## Task 1: Backend — spec extension + preview/save endpoints

**Files:**
- Modify: `backend-ts/src/measure/measure-catalog.ts`, `backend-ts/src/measure/measure-read-models.ts`, `backend-ts/src/measure/measure-authoring.ts`, `backend-ts/src/routes/measures.ts`, `backend-ts/src/auth/authorize.ts`
- Test: `backend-ts/src/routes/measures.test.ts`

- [ ] **Step 1: Extend `MeasureSpec` (`backend-ts/src/measure/measure-catalog.ts`)**

Add the import at the top and the two optional fields. After the existing imports add:
```typescript
import type { Rule, CodegenBindings } from "../engine/cql/codegen/generate-cql.ts";
```
In the `MeasureSpec` interface, add after `testFixtures: TestFixture[];`:
```typescript
  rule?: Rule;
  ruleBindings?: CodegenBindings;
```

- [ ] **Step 2: Surface `rule`/`ruleBindings` in `toMeasureDetail` (`backend-ts/src/measure/measure-read-models.ts`)**

Read the file and find `toMeasureDetail` (it builds the `GET /api/measures/:id` payload from a `MeasureRecord`'s `spec`). In the returned object, add these two fields (so the frontend can hydrate the form on re-open) — place them next to the other spec-derived fields:
```typescript
    rule: measure.spec.rule,
    ruleBindings: measure.spec.ruleBindings,
```
(They're `undefined` when absent — JSON omits them. If the file uses a typed return that rejects extra fields, add `rule?`/`ruleBindings?` to that local type.)

- [ ] **Step 3: Write the failing route tests**

Append to `backend-ts/src/routes/measures.test.ts` (it already has `get`/`put`/`post` helpers + a seeded SQLite `env`, actor `"author@workwell.dev"`):

```typescript
test("POST /api/measures/:id/rule/preview generates CQL from series params", async () => {
  const res = await post("/api/measures/mmr/rule/preview", {
    rule: { type: "series-completion", requiredDoses: 2 },
    bindings: {
      enrollment: { code: "immz-enrolled", valueSet: "urn:workwell:vs:immz-enrollment" },
      waiver: { code: "mmr-contraindication", valueSet: "urn:workwell:vs:mmr-contraindication" },
      event: { code: "mmr-vaccine", valueSet: "urn:workwell:vs:mmr-vaccines", type: "immunization" },
    },
  });
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { cql: string };
  assert.match(body.cql, /define "Dose Count":/);
  assert.match(body.cql, /"Dose Count" >= 2/);
});

test("POST /rule/preview returns 400 when the params are invalid for the shape", async () => {
  const res = await post("/api/measures/audiogram/rule/preview", {
    rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 },
    bindings: {
      enrollment: { code: "e", valueSet: "urn:vs:e" }, waiver: { code: "w", valueSet: "urn:vs:w" },
      event: { code: "ev", valueSet: "urn:vs:ev", type: "immunization" }, // wrong type for windowed
    },
  });
  assert.equal(res?.status, 400);
});

test("POST /rule/preview returns 404 for an unknown measure", async () => {
  const res = await post("/api/measures/nope-xyz/rule/preview", {
    rule: { type: "series-completion", requiredDoses: 2 },
    bindings: { enrollment: { code: "a", valueSet: "b" }, waiver: { code: "a", valueSet: "b" }, event: { code: "a", valueSet: "b", type: "immunization" } },
  });
  assert.equal(res?.status, 404);
});

test("PUT /api/measures/:id/rule persists rule + generated CQL + compile status, round-trips on GET", async () => {
  const save = await put("/api/measures/mmr/rule", {
    rule: { type: "series-completion", requiredDoses: 3 },
    bindings: {
      enrollment: { code: "immz-enrolled", valueSet: "urn:workwell:vs:immz-enrollment" },
      waiver: { code: "mmr-contraindication", valueSet: "urn:workwell:vs:mmr-contraindication" },
      event: { code: "mmr-vaccine", valueSet: "urn:workwell:vs:mmr-vaccines", type: "immunization" },
    },
  });
  assert.equal(save?.status, 200);
  const saved = (await save!.json()) as { cql: string; status: string };
  assert.match(saved.cql, /"Dose Count" >= 3/);
  assert.ok(["COMPILED", "WARNINGS", "ERROR"].includes(saved.status));

  const detail = (await get("/api/measures/mmr").then((r) => r!.json())) as { rule?: { requiredDoses?: number }; cqlText: string };
  assert.equal(detail.rule?.requiredDoses, 3, "rule params round-trip via spec_json");
  assert.match(detail.cqlText, /"Dose Count" >= 3/, "generated CQL persisted to cql_text");
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd backend-ts && node --import tsx --test src/routes/measures.test.ts`
Expected: the 4 new tests FAIL (routes not implemented).

- [ ] **Step 5: Add the rule helpers to `backend-ts/src/measure/measure-authoring.ts`**

Add the imports at the top (next to the existing ones):
```typescript
import { generateCql, type Rule, type CodegenBindings } from "../engine/cql/codegen/generate-cql.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
```
Add these three functions at the end of the file:
```typescript
/** Resolve the generated CQL's `library X version 'Y'` header. Prefer the runnable registry
 *  (MEASURES[id].library = "Name-1.2.3"); fall back to a sanitized measure name + version for measures
 *  not yet in the registry. The name only labels the CQL header — it doesn't affect evaluation. */
function resolveLibrary(measureId: string, record: MeasureRecord): { library: string; version: string } {
  const meta = MEASURES[measureId];
  if (meta) {
    const m = meta.library.match(/^(.*)-(\d[\d.]*)$/);
    if (m) return { library: m[1]!, version: m[2]! };
    return { library: meta.library, version: record.version };
  }
  const lib = record.name.replace(/[^A-Za-z0-9]/g, "") || "Measure";
  return { library: lib, version: record.version };
}

/** Stateless: generate CQL from rule params for a live preview. null = unknown measure; {error} = a
 *  generate failure (e.g. wrong event.type for the shape). */
export async function previewRule(
  deps: MeasureAuthoringDeps, measureId: string, rule: Rule, bindings: CodegenBindings,
): Promise<{ cql: string } | { error: string; message: string } | null> {
  const current = await deps.measures.getLatest(measureId);
  if (!current) return null;
  const { library, version } = resolveLibrary(measureId, current);
  try {
    return { cql: generateCql({ library, version, rule, bindings }) };
  } catch (e) {
    return { error: "preview_failed", message: (e as Error).message };
  }
}

/** Atomic save: generate CQL, persist rule+ruleBindings into spec_json AND the generated CQL into
 *  cql_text (+ compile status), audit once. null = unknown measure; {error} = a generate failure. */
export async function saveRule(
  deps: MeasureAuthoringDeps, measureId: string, rule: Rule, bindings: CodegenBindings, actor: string,
): Promise<(CompileResponse & { cql: string }) | { error: string; message: string } | null> {
  const current = await deps.measures.getLatest(measureId);
  if (!current) return null;
  const { library, version } = resolveLibrary(measureId, current);
  let cql: string;
  try {
    cql = generateCql({ library, version, rule, bindings });
  } catch (e) {
    return { error: "generate_failed", message: (e as Error).message };
  }
  const spec: MeasureSpec = { ...current.spec, rule, ruleBindings: bindings };
  await deps.measures.updateSpec(measureId, spec);
  const compile = toCompileResponse(cql);
  const updated = await deps.measures.updateCql(measureId, cql, compile.status);
  if (!updated) return null;
  await auditDraftSaved(deps, updated, actor, { field: "rule", measureId });
  return { cql, ...compile };
}
```

- [ ] **Step 6: Wire the two route blocks in `backend-ts/src/routes/measures.ts`**

Add to the authoring imports block (where `updateMeasureSpec, …, type SpecUpdate` are imported):
```typescript
  previewRule,
  saveRule,
```
Add the codegen types import near the top imports:
```typescript
import type { Rule, CodegenBindings } from "../engine/cql/codegen/generate-cql.ts";
```
In the **PUT** block, immediately after the `tests` block and before `return null;`, add:
```typescript
    const ruleId = pathname.match(/^\/api\/measures\/([^/]+)\/rule$/)?.[1];
    if (ruleId) {
      const body = (await req.json().catch(() => ({}))) as { rule?: unknown; bindings?: unknown };
      if (!body.rule || typeof body.rule !== "object" || !body.bindings || typeof body.bindings !== "object")
        return json({ error: "invalid_request", message: "rule and bindings are required" }, 400);
      const res = await saveRule(await lifecycleDeps(env), ruleId, body.rule as Rule, body.bindings as CodegenBindings, actor);
      if (res === null) return json({ error: "not_found", measureId: ruleId }, 404);
      if ("error" in res) return json(res, 400);
      return json(res);
    }
```
In the **POST** block, immediately after the `cql/compile` block, add:
```typescript
    const rulePreviewId = pathname.match(/^\/api\/measures\/([^/]+)\/rule\/preview$/)?.[1];
    if (rulePreviewId) {
      const body = (await req.json().catch(() => ({}))) as { rule?: unknown; bindings?: unknown };
      if (!body.rule || typeof body.rule !== "object" || !body.bindings || typeof body.bindings !== "object")
        return json({ error: "invalid_request", message: "rule and bindings are required" }, 400);
      const res = await previewRule(await lifecycleDeps(env), rulePreviewId, body.rule as Rule, body.bindings as CodegenBindings);
      if (res === null) return json({ error: "not_found", measureId: rulePreviewId }, 404);
      if ("error" in res) return json(res, 400);
      return json(res);
    }
```

- [ ] **Step 7: Add the `PUT /rule` auth rule in `backend-ts/src/auth/authorize.ts`**

Next to the `{ method: "PUT", pattern: rx("/api/measures/*/cql"), … }` line, add:
```typescript
  { method: "PUT", pattern: rx("/api/measures/*/rule"), access: [AUTHOR, A] },
```
(The `POST /api/measures/**` catch-all already covers `…/rule/preview`.)

- [ ] **Step 8: Run the route tests — all pass**

Run: `cd backend-ts && node --import tsx --test src/routes/measures.test.ts`
Expected: PASS (the 4 new tests + the existing ones).

- [ ] **Step 9: Typecheck**

Run: `cd backend-ts && node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add backend-ts/src/measure/measure-catalog.ts backend-ts/src/measure/measure-read-models.ts backend-ts/src/measure/measure-authoring.ts backend-ts/src/routes/measures.ts backend-ts/src/auth/authorize.ts backend-ts/src/routes/measures.test.ts
git commit -m "feat(measure): rule preview + atomic rule save endpoints (E11.2b, #183)"
```
Append:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vj9GhN5vxoENWrwrU56GZz
```

---

## Task 2: Frontend — the RuleBuilderTab + tab registration

**Files:**
- Modify: `frontend/features/studio/types.ts`, `frontend/app/(dashboard)/studio/[id]/page.tsx`
- Create: `frontend/features/studio/components/RuleBuilderTab.tsx`, `frontend/features/studio/components/__tests__/RuleBuilderTab.test.tsx`

- [ ] **Step 1: Add the rule types + extend `MeasureDetail` (`frontend/features/studio/types.ts`)**

Add (the frontend mirror of the codegen input types — the frontend can't import backend-ts):
```typescript
export type RuleParams =
  | { type: "series-completion"; requiredDoses: number; allowPositiveTiter?: boolean }
  | { type: "windowed-recency"; windowDays: number; dueSoonDays: number; gracePeriodDays?: number };
export interface RuleCodeBinding { code: string; valueSet: string }
export interface RuleBindings {
  enrollment: RuleCodeBinding;
  waiver: RuleCodeBinding;
  event: RuleCodeBinding & { type: "procedure" | "immunization" | "observation" };
  refusal?: RuleCodeBinding;
  titer?: { code: string; valueSet: string; minValue: number };
}
```
In `MeasureDetail`, add:
```typescript
  rule?: RuleParams;
  ruleBindings?: RuleBindings;
```

- [ ] **Step 2: Write the failing test**

Create `frontend/features/studio/components/__tests__/RuleBuilderTab.test.tsx`:

```tsx
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RuleBuilderTab } from "../RuleBuilderTab";
import type { MeasureDetail } from "../../types";
import type { ApiClient } from "@/lib/api/client";

const base: MeasureDetail = {
  id: "mmr", name: "MMR", policyRef: "x", oshaReferenceId: null, version: "1.0.0", status: "Draft",
  owner: "o", description: "", eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" },
  exclusions: [], complianceWindow: "", requiredDataElements: [], cqlText: "", compileStatus: "COMPILED",
  valueSets: [], testFixtures: [],
  rule: { type: "series-completion", requiredDoses: 2 },
  ruleBindings: {
    enrollment: { code: "immz-enrolled", valueSet: "urn:vs:e" },
    waiver: { code: "mmr-contra", valueSet: "urn:vs:w" },
    event: { code: "mmr-vaccine", valueSet: "urn:vs:ev", type: "immunization" },
  },
};

function renderTab(api: Partial<ApiClient>, measure = base) {
  return render(<RuleBuilderTab measure={measure} measureId="mmr" api={api as ApiClient} onSaved={() => {}} onError={() => {}} />);
}

describe("RuleBuilderTab", () => {
  it("hydrates from measure.rule and previews the generated CQL", async () => {
    const post = vi.fn().mockResolvedValue({ cql: "library MmrSeries version '1.0.0'\n…define \"Dose Count\":" });
    renderTab({ post, put: vi.fn() });
    // mounted with requiredDoses=2 → a debounced preview fires
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/measures/mmr/rule/preview", expect.objectContaining({
      rule: expect.objectContaining({ type: "series-completion", requiredDoses: 2 }),
    })));
    expect(await screen.findByText(/Dose Count/)).toBeInTheDocument();
  });

  it("Save posts the rule to PUT /rule", async () => {
    const put = vi.fn().mockResolvedValue({ cql: "x", status: "COMPILED", errors: [], warnings: [] });
    renderTab({ post: vi.fn().mockResolvedValue({ cql: "x" }), put });
    fireEvent.click(screen.getByRole("button", { name: /save rule/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/measures/mmr/rule", expect.objectContaining({
      rule: expect.any(Object), bindings: expect.any(Object),
    })));
  });

  it("switching to windowed-recency reveals the window fields", async () => {
    renderTab({ post: vi.fn().mockResolvedValue({ cql: "" }), put: vi.fn() });
    fireEvent.change(screen.getByLabelText(/rule shape/i), { target: { value: "windowed-recency" } });
    expect(screen.getByLabelText(/window \(days\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/due-soon \(days\)/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it, confirm it FAILS** (`../RuleBuilderTab` missing):

Run: `cd frontend && npx vitest run features/studio/components/__tests__/RuleBuilderTab.test.tsx`

- [ ] **Step 4: Create `frontend/features/studio/components/RuleBuilderTab.tsx`**

```tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { ApiClient } from "@/lib/api/client";
import { emitToast } from "@/lib/toast";
import type { MeasureDetail, RuleParams, RuleBindings, RuleCodeBinding } from "../types";

type Props = {
  measure: MeasureDetail;
  measureId: string;
  api: ApiClient;
  onSaved: () => void;
  onError: (msg: string) => void;
};

type Shape = "series-completion" | "windowed-recency";

const emptyCode = (): RuleCodeBinding => ({ code: "", valueSet: "" });

export function RuleBuilderTab({ measure, measureId, api, onSaved, onError }: Props) {
  const r = measure.rule;
  const rb = measure.ruleBindings;
  const [shape, setShape] = useState<Shape>(r?.type ?? "series-completion");
  // series
  const [requiredDoses, setRequiredDoses] = useState<number>(r?.type === "series-completion" ? r.requiredDoses : 2);
  const [allowTiter, setAllowTiter] = useState<boolean>(r?.type === "series-completion" ? !!r.allowPositiveTiter : false);
  const [titer, setTiter] = useState<{ code: string; valueSet: string; minValue: number }>(rb?.titer ?? { code: "", valueSet: "", minValue: 1 });
  // windowed
  const [windowDays, setWindowDays] = useState<number>(r?.type === "windowed-recency" ? r.windowDays : 365);
  const [dueSoonDays, setDueSoonDays] = useState<number>(r?.type === "windowed-recency" ? r.dueSoonDays : 30);
  const [gracePeriodDays, setGracePeriodDays] = useState<number>(r?.type === "windowed-recency" ? (r.gracePeriodDays ?? 0) : 0);
  // bindings
  const [enrollment, setEnrollment] = useState<RuleCodeBinding>(rb?.enrollment ?? emptyCode());
  const [waiver, setWaiver] = useState<RuleCodeBinding>(rb?.waiver ?? emptyCode());
  const [eventCode, setEventCode] = useState<RuleCodeBinding>(rb?.event ? { code: rb.event.code, valueSet: rb.event.valueSet } : emptyCode());
  const [allowDeclination, setAllowDeclination] = useState<boolean>(!!rb?.refusal);
  const [refusal, setRefusal] = useState<RuleCodeBinding>(rb?.refusal ?? emptyCode());

  const [cql, setCql] = useState<string>("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const eventType: "procedure" | "immunization" | "observation" = shape === "series-completion" ? "immunization" : "procedure";

  const rule: RuleParams = useMemo(
    () =>
      shape === "series-completion"
        ? { type: "series-completion", requiredDoses, ...(allowTiter ? { allowPositiveTiter: true } : {}) }
        : { type: "windowed-recency", windowDays, dueSoonDays, ...(gracePeriodDays ? { gracePeriodDays } : {}) },
    [shape, requiredDoses, allowTiter, windowDays, dueSoonDays, gracePeriodDays]
  );
  const bindings: RuleBindings = useMemo(
    () => ({
      enrollment, waiver,
      event: { ...eventCode, type: eventType },
      ...(allowDeclination ? { refusal } : {}),
      ...(shape === "series-completion" && allowTiter ? { titer } : {}),
    }),
    [enrollment, waiver, eventCode, eventType, allowDeclination, refusal, shape, allowTiter, titer]
  );

  // Debounced live preview.
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const res = await api.post<{ rule: RuleParams; bindings: RuleBindings }, { cql: string }>(
          `/api/measures/${measureId}/rule/preview`, { rule, bindings }
        );
        setCql(res.cql);
        setPreviewError(null);
      } catch (e) {
        setPreviewError(e instanceof Error ? e.message : "Preview failed");
      }
    }, 400);
    return () => clearTimeout(t);
  }, [api, measureId, rule, bindings]);

  async function save() {
    onError("");
    setSaving(true);
    try {
      const res = await api.put<{ rule: RuleParams; bindings: RuleBindings }, { status: string; errors: string[] }>(
        `/api/measures/${measureId}/rule`, { rule, bindings }
      );
      emitToast(res.errors?.length ? `Saved with compile errors (${res.status})` : "Rule saved");
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Rule save failed");
    } finally {
      setSaving(false);
    }
  }

  const codeFields = (label: string, b: RuleCodeBinding, set: (v: RuleCodeBinding) => void, prefix: string) => (
    <div className="grid grid-cols-2 gap-2">
      <label className="flex flex-col text-xs">
        <span className="mb-1">{label} code</span>
        <input aria-label={`${label} code`} value={b.code} onChange={(e) => set({ ...b, code: e.target.value })}
          className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" />
      </label>
      <label className="flex flex-col text-xs">
        <span className="mb-1">{label} value set</span>
        <input aria-label={`${label} value set`} value={b.valueSet} onChange={(e) => set({ ...b, valueSet: e.target.value })}
          className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" />
      </label>
    </div>
  );

  return (
    <div className="grid gap-4 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 lg:grid-cols-2">
      <div className="grid gap-3">
        <label className="flex flex-col text-xs font-medium">
          <span className="mb-1">Rule shape</span>
          <select aria-label="Rule shape" value={shape} onChange={(e) => setShape(e.target.value as Shape)}
            className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700">
            <option value="series-completion">Series completion (dose count)</option>
            <option value="windowed-recency">Windowed recency (days since)</option>
          </select>
        </label>

        {shape === "series-completion" ? (
          <>
            <label className="flex flex-col text-xs">
              <span className="mb-1">Required doses</span>
              <input aria-label="Required doses" type="number" min={1} value={requiredDoses}
                onChange={(e) => setRequiredDoses(Number(e.target.value))}
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={allowTiter} onChange={(e) => setAllowTiter(e.target.checked)} />
              Allow positive titer
            </label>
            {allowTiter ? (
              <div className="grid grid-cols-3 gap-2">
                <label className="flex flex-col text-xs"><span className="mb-1">Titer code</span>
                  <input aria-label="Titer code" value={titer.code} onChange={(e) => setTiter({ ...titer, code: e.target.value })}
                    className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
                <label className="flex flex-col text-xs"><span className="mb-1">Titer value set</span>
                  <input aria-label="Titer value set" value={titer.valueSet} onChange={(e) => setTiter({ ...titer, valueSet: e.target.value })}
                    className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
                <label className="flex flex-col text-xs"><span className="mb-1">Min value</span>
                  <input aria-label="Titer min value" type="number" value={titer.minValue} onChange={(e) => setTiter({ ...titer, minValue: Number(e.target.value) })}
                    className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
              </div>
            ) : null}
          </>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col text-xs"><span className="mb-1">Window (days)</span>
              <input aria-label="Window (days)" type="number" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
            <label className="flex flex-col text-xs"><span className="mb-1">Due-soon (days)</span>
              <input aria-label="Due-soon (days)" type="number" value={dueSoonDays} onChange={(e) => setDueSoonDays(Number(e.target.value))}
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
            <label className="flex flex-col text-xs"><span className="mb-1">Grace (days)</span>
              <input aria-label="Grace (days)" type="number" value={gracePeriodDays} onChange={(e) => setGracePeriodDays(Number(e.target.value))}
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
          </div>
        )}

        <div className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <p className="mb-2 text-xs font-semibold uppercase text-neutral-500">Bindings (code + value set)</p>
          {codeFields("Enrollment", enrollment, setEnrollment, "enr")}
          {codeFields("Waiver", waiver, setWaiver, "wai")}
          {codeFields(shape === "series-completion" ? "Vaccine" : "Event", eventCode, setEventCode, "evt")}
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={allowDeclination} onChange={(e) => setAllowDeclination(e.target.checked)} />
            Allow patient declination
          </label>
          {allowDeclination ? codeFields("Refusal", refusal, setRefusal, "ref") : null}
        </div>

        <div>
          <button type="button" onClick={save} disabled={saving || previewError != null}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {saving ? "Saving…" : "Save Rule"}
          </button>
        </div>
      </div>

      <div className="grid gap-2">
        <p className="text-xs font-semibold uppercase text-neutral-500">Generated CQL (preview)</p>
        {previewError ? (
          <p role="alert" className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">{previewError}</p>
        ) : null}
        <pre className="max-h-[28rem] overflow-auto rounded border border-neutral-200 bg-neutral-50 p-3 text-[11px] leading-snug dark:border-neutral-800 dark:bg-neutral-950">{cql || "…"}</pre>
        <p className="text-[11px] text-neutral-400">CQL stays canonical (ADR-015) — this generated CQL is saved to the version and compiled on save.</p>
      </div>
    </div>
  );
}
```

> Note for the implementer: confirm the toast import — the SpecTab uses `emitToast` from a module (grep SpecTab's import; it's likely `@/lib/toast` or a `@mieweb/ui` re-export). Use the SAME import SpecTab uses. If `ApiClient` import path differs, match SpecTab's (`@/lib/api/client`).

- [ ] **Step 5: Register the tab in `frontend/app/(dashboard)/studio/[id]/page.tsx`**

1. Add the import next to the other tab imports: `import { RuleBuilderTab } from "@/features/studio/components/RuleBuilderTab";`
2. Extend the `Tab` union: add `| "rules"` → `type Tab = "spec" | "cql" | "rules" | "valuesets" | "tests" | "release" | "traceability";`
3. Add `"rules"` to the `tabs` array (after `"cql"`) and `tabLabels` (`rules: "Rule Builder"`).
4. Add the conditional render after the CQL tab block:
```tsx
      {measure && tab === "rules" ? (
        <RuleBuilderTab measure={measure} measureId={measureId} api={api} onSaved={load} onError={(msg) => setError(msg || null)} />
      ) : null}
```

- [ ] **Step 6: Run the tab tests + typecheck**

Run: `cd frontend && npx vitest run features/studio/components/__tests__/RuleBuilderTab.test.tsx && npx tsc --noEmit`
Expected: PASS (3 tests); no type errors. If the test's `screen.getByLabelText(/window \(days\)/i)` doesn't match, align the `aria-label` exactly.

- [ ] **Step 7: Commit**

```bash
git add frontend/features/studio/types.ts frontend/features/studio/components/RuleBuilderTab.tsx frontend/features/studio/components/__tests__/RuleBuilderTab.test.tsx "frontend/app/(dashboard)/studio/[id]/page.tsx"
git commit -m "feat(studio): Rule Builder tab — form → live CQL preview → atomic save (E11.2b, #183)"
```
Append the two trailer lines.

---

## Task 3: Docs + full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `docs/JOURNAL.md`

- [ ] **Step 1: `docs/ARCHITECTURE.md` — §4 `/studio` tab + §7 the endpoints**

In the `/studio/[id]` route bullet, append: `+ a **Rule Builder** tab (E11.2b / #183): a structured form (shape + params + binding codes + titer/grace/declination toggles) → a live generated-CQL preview → an atomic save; emits the codegen `rule:` params.`

In §7, add:
```markdown
- Rule Builder (#183 / E11.2b): `POST /api/measures/:id/rule/preview` → `{ cql }` (stateless codegen preview)
  and `PUT /api/measures/:id/rule` (atomic: generate CQL → persist `spec_json.rule`/`ruleBindings` +
  `cql_text` + compile status, audited → `{ cql, status, errors, warnings }`). AUTHOR/ADMIN. Reuses the
  E11.1/E11.2a codegen + `toCompileResponse`; the params round-trip via `spec_json` (additive, no DDL).
  CQL stays canonical (ADR-015).
```

- [ ] **Step 2: `docs/JOURNAL.md` entry on top**

```markdown
## 2026-06-24 — E11.2b: Rule Builder UI (Studio tab)

Put a UI in front of the E11.1/E11.2a codegen: a **Rule Builder** tab in Studio (`/studio/[id]`). A
structured form (shape = series-completion | windowed-recency; params requiredDoses / windowDays·dueSoon·
grace; the Compliance-paths toggles allow-positive-titer + allow-declination; binding codes) emits the
codegen `{rule, bindings}`, shows a debounced **live generated-CQL preview** (`POST …/rule/preview`), and
**atomically saves** (`PUT …/rule`: generate → persist `spec_json.rule`/`ruleBindings` + `cql_text` +
compile status, audited). Params round-trip on re-open via `spec_json` (additive — no schema). AUTHOR/ADMIN;
CQL stays canonical (ADR-015) — the builder authors params + the generated CQL, no new eval path (and, like
the CQL tab, runtime-edited CQL isn't evaluated until a build — pre-existing). Hep B multi-series/intervals/
multi-CVX deferred. Built subagent-driven; backend + frontend suites + lint + build green.
```

- [ ] **Step 3: Full verification**

Run (backend): `cd backend-ts && node_modules/.bin/tsc --noEmit && node --import tsx --test "src/**/*.test.ts"`
Run (frontend): `cd frontend && npx vitest run && npm run lint && npm run build`
Expected: backend typecheck clean + all tests pass; frontend all green (the pre-existing `next-font` lint warning is fine); build compiles. Fix anything red.

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md docs/JOURNAL.md
git commit -m "docs(studio): Rule Builder tab + rule preview/save endpoints (E11.2b, #183)"
```
Append the two trailer lines.

---

## Self-Review

**1. Spec coverage:** spec extension + round-trip (§3.1) → Task 1.1–1.2. Preview endpoint (§3.1) → Task 1.5–1.6. Atomic save (§3.1) → Task 1.5–1.6. Auth (§7) → Task 1.7. The tab + form + preview + save + hydrate (§3.2) → Task 2. Error/edge (§5: invalid→400, unknown→404, save-on-compile-error) → Task 1 helpers + tests. Testing (§6) → Tasks 1.3, 2.2. Guardrails (§7) → honored; docs Task 3.

**2. Placeholder scan:** none — full code for the new endpoints, helpers, and the RuleBuilderTab. The two implementer notes (Task 1.2 read-and-add-two-fields to `toMeasureDetail`; Task 2.4 confirm the `emitToast`/`ApiClient` import paths match SpecTab) are precise verification steps, not missing logic.

**3. Type consistency:** `Rule`/`CodegenBindings` (backend) are imported into `measure-catalog.ts`, `measure-authoring.ts`, and `measures.ts` from `generate-cql.ts`; `previewRule`/`saveRule` signatures match between the helper (1.5) and the route consumers (1.6). The frontend `RuleParams`/`RuleBindings` mirror them and are produced by the form's `rule`/`bindings` memos and consumed by the preview/save calls + the test assertions. `RuleBuilderTab` props `{measure, measureId, api, onSaved, onError}` match the page's render (2.5) and the test's `renderTab` (2.2). The save endpoint returns `{cql, status, errors, warnings}` (1.5) — the frontend reads `.status`/`.errors` (2.4) and the backend test asserts the same (1.3).
