# E11.2a — Codegen: titer + grace + declination Implementation Plan (#183)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three additive, back-compatible codegen capabilities — **grace** (windowed), **titer** (series), **declination** (both) — extending E11.1's `generate-cql.ts`, each proven by behavioral golden scenarios (asserted `Outcome Status`).

**Architecture:** Extend the `Rule` union + `CodegenBindings` with optional fields (absent ⇒ E11.1 output byte-for-byte). The two existing shape functions gain: a `Has Positive Titer` define OR'd into `Series Complete` (series, when `allowPositiveTiter` + a titer binding), an `overdueThreshold = windowDays + gracePeriodDays` (windowed), and a `Refused` define when a refusal binding is present (windowed — series already has it). Behavioral tests translate generated CQL → ELM in-process (`compileCql`) and evaluate inline synthetic bundles.

**Tech Stack:** backend-ts; `@cqframework/cql` (`compileCql`), `cql-execution` (via `CqlExecutionEngine` + its E11.1 `elm?` override), `node --test`.

---

## File Structure

**Modify:** `backend-ts/src/engine/cql/codegen/generate-cql.ts` (schema + 3 capabilities); `backend-ts/src/engine/cql/codegen/generate-cql.test.ts` (unit additions).
**Create:** `backend-ts/src/engine/cql/codegen/generate-cql-extensions.test.ts` (behavioral goldens).
**Docs:** `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `docs/JOURNAL.md`.

---

## Task 1: Extend the codegen (schema + grace + titer + declination)

**Files:**
- Modify: `backend-ts/src/engine/cql/codegen/generate-cql.ts`, `backend-ts/src/engine/cql/codegen/generate-cql.test.ts`

- [ ] **Step 1: Add the failing unit tests**

Append to `backend-ts/src/engine/cql/codegen/generate-cql.test.ts` (after the existing tests; keep the existing `SERIES_CODES` const + tests):

```typescript
test("titer: when allowPositiveTiter + a titer binding, Series Complete ORs in Has Positive Titer", () => {
  const cql = generateCql({
    library: "MmrSeries", version: "1.0.0",
    rule: { type: "series-completion", requiredDoses: 2, allowPositiveTiter: true },
    bindings: { ...SERIES_CODES, titer: { code: "mmr-titer", valueSet: "urn:workwell:vs:mmr-titer", minValue: 10 } },
  });
  assert.match(cql, /define "Has Positive Titer":/);
  assert.match(cql, /C\.system = 'urn:workwell:vs:mmr-titer' and C\.code = 'mmr-titer'/);
  assert.match(cql, /\(O\.value as FHIR\.Quantity\)\.value >= 10/);
  assert.match(cql, /"Dose Count" >= 2 or "Has Positive Titer"/);
});

test("titer: disabled (default) reproduces the E11.1 series output — no titer define, plain Series Complete", () => {
  const cql = generateCql({
    library: "MmrSeries", version: "1.0.0",
    rule: { type: "series-completion", requiredDoses: 2 },
    bindings: SERIES_CODES,
  });
  assert.doesNotMatch(cql, /Has Positive Titer/);
  assert.match(cql, /"Enrolled" and not "Has Contraindication" and "Dose Count" >= 2\n/);
});

test("grace: overdueThreshold = windowDays + gracePeriodDays shifts the OVERDUE boundary", () => {
  const cql = generateCql({
    library: "AnnualAudiogramCompleted", version: "1.0.0",
    rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30, gracePeriodDays: 30 },
    bindings: {
      enrollment: { code: "hearing-enrollment", valueSet: "urn:workwell:vs:hearing-enrollment" },
      waiver: { code: "audiogram-waiver", valueSet: "urn:workwell:vs:audiogram-waiver" },
      event: { code: "audiogram-procedure", valueSet: "urn:workwell:vs:audiogram-procedures", type: "procedure" },
    },
  });
  assert.match(cql, /"Days Since Last Event" > 335 and "Days Since Last Event" <= 395/); // band extends to 365+30
  assert.match(cql, /define "Overdue":\n  "Enrolled" and not "Has Waiver" and "Days Since Last Event" > 395/);
});

test("grace: absent (default) reproduces the E11.1 windowed output (overdueThreshold = windowDays)", () => {
  const cql = generateCql({
    library: "AnnualAudiogramCompleted", version: "1.0.0",
    rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 },
    bindings: {
      enrollment: { code: "hearing-enrollment", valueSet: "urn:workwell:vs:hearing-enrollment" },
      waiver: { code: "audiogram-waiver", valueSet: "urn:workwell:vs:audiogram-waiver" },
      event: { code: "audiogram-procedure", valueSet: "urn:workwell:vs:audiogram-procedures", type: "procedure" },
    },
  });
  assert.match(cql, /"Days Since Last Event" > 335 and "Days Since Last Event" <= 365/);
  assert.match(cql, /"Days Since Last Event" > 365\n/);
  assert.doesNotMatch(cql, /<= 395|> 395/);
});

test("declination: a windowed rule with a refusal binding emits the Refused define", () => {
  const cql = generateCql({
    library: "AnnualAudiogramCompleted", version: "1.0.0",
    rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 },
    bindings: {
      enrollment: { code: "hearing-enrollment", valueSet: "urn:workwell:vs:hearing-enrollment" },
      waiver: { code: "audiogram-waiver", valueSet: "urn:workwell:vs:audiogram-waiver" },
      event: { code: "audiogram-procedure", valueSet: "urn:workwell:vs:audiogram-procedures", type: "procedure" },
      refusal: { code: "audiogram-refusal", valueSet: "urn:workwell:vs:audiogram-refusal" },
    },
  });
  assert.match(cql, /define "Refused":/);
  assert.match(cql, /x\.system = 'urn:workwell:vs:audiogram-refusal' and x\.code = 'audiogram-refusal'/);
});
```

- [ ] **Step 2: Run the unit tests to verify the NEW ones fail**

Run: `cd backend-ts && node --import tsx --test src/engine/cql/codegen/generate-cql.test.ts`
Expected: the 5 new tests FAIL (titer/grace/refusal-on-windowed not implemented); the original 4 still pass.

- [ ] **Step 3: Update the types + `seriesCompletion` + `windowedRecency` in `generate-cql.ts`**

Replace the `CodegenBindings` interface + `Rule` type (lines 12-20) with:

```typescript
export interface CodegenBindings {
  enrollment: CodeBinding;
  waiver: CodeBinding;
  event: CodeBinding & { type: "procedure" | "immunization" | "observation" };
  refusal?: CodeBinding;
  titer?: { code: string; valueSet: string; minValue: number };
}
export type Rule =
  | { type: "series-completion"; requiredDoses: number; allowPositiveTiter?: boolean }
  | { type: "windowed-recency"; windowDays: number; dueSoonDays: number; gracePeriodDays?: number };
```

Replace the whole `seriesCompletion` function with (adds the optional titer path; output is byte-identical to E11.1 when titer is off):

```typescript
function seriesCompletion(input: GenerateCqlInput): string {
  const b = input.bindings;
  if (b.event.type !== "immunization") throw new Error("series-completion requires event.type=immunization");
  const rule = input.rule as { requiredDoses: number; allowPositiveTiter?: boolean };
  const n = rule.requiredDoses;
  const titerEnabled = rule.allowPositiveTiter === true && b.titer != null;
  const titerDefine = titerEnabled
    ? `
define "Has Positive Titer":
  exists([Observation] O
    where exists(O.code.coding C where C.system = '${b.titer!.valueSet}' and C.code = '${b.titer!.code}')
      and (O.value as FHIR.Quantity).value >= ${b.titer!.minValue})
`
    : "";
  const seriesComplete = titerEnabled
    ? `"Enrolled" and not "Has Contraindication" and ("Dose Count" >= ${n} or "Has Positive Titer")`
    : `"Enrolled" and not "Has Contraindication" and "Dose Count" >= ${n}`;
  return (
    header(input.library, input.version) +
    conditionDefine("Enrolled", b.enrollment) +
    conditionDefine("Has Contraindication", b.waiver) +
    (b.refusal ? conditionDefine("Refused", b.refusal) : "") +
    titerDefine +
    `
define "Dose Count":
  Count([Immunization] I
    where I.status = 'completed'
      and exists(I.vaccineCode.coding C where C.system = '${b.event.valueSet}' and C.code = '${b.event.code}'))

define "Series Complete":
  ${seriesComplete}

define "Excluded": "Has Contraindication"

define "Initial Population": "Enrolled" or "Has Contraindication"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Series Complete" then 'COMPLIANT'
  else 'MISSING_DATA'
`
  );
}
```

Replace the whole `windowedRecency` function with (adds the grace `overdueThreshold` + the optional `Refused` define; byte-identical to E11.1 when both are absent):

```typescript
function windowedRecency(input: GenerateCqlInput): string {
  const b = input.bindings;
  if (b.event.type !== "procedure") throw new Error("windowed-recency (E11.1) requires event.type=procedure");
  const rule = input.rule as { windowDays: number; dueSoonDays: number; gracePeriodDays?: number };
  const { windowDays, dueSoonDays } = rule;
  const compliantMax = windowDays - dueSoonDays;
  const overdueThreshold = windowDays + (rule.gracePeriodDays ?? 0);
  return (
    header(input.library, input.version) +
    conditionDefine("Enrolled", b.enrollment) +
    conditionDefine("Has Waiver", b.waiver) +
    (b.refusal ? conditionDefine("Refused", b.refusal) : "") +
    `
define "Most Recent Event Date":
  Last(
    [Procedure] P
      where exists(P.code.coding C where C.system = '${b.event.valueSet}' and C.code = '${b.event.code}')
      sort by (performed as FHIR.dateTime)
  ).performed as FHIR.dateTime

define "Days Since Last Event":
  difference in days between
    Coalesce("Most Recent Event Date", @1900-01-01T00:00:00.0)
    and Now()

define "Compliant":
  "Enrolled" and not "Has Waiver" and "Days Since Last Event" <= ${compliantMax}

define "Due Soon":
  "Enrolled" and not "Has Waiver" and "Days Since Last Event" > ${compliantMax} and "Days Since Last Event" <= ${overdueThreshold}

define "Overdue":
  "Enrolled" and not "Has Waiver" and "Days Since Last Event" > ${overdueThreshold}

define "Missing Data":
  "Enrolled" and not "Has Waiver" and "Most Recent Event Date" is null

define "Excluded": "Has Waiver"

define "Initial Population": "Enrolled" or "Has Waiver"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Missing Data" then 'MISSING_DATA'
  else if "Overdue" then 'OVERDUE'
  else if "Due Soon" then 'DUE_SOON'
  else if "Compliant" then 'COMPLIANT'
  else 'MISSING_DATA'
`
  );
}
```

Also update the file's top doc comment (lines 1-7) to note titer/grace/declination (append a sentence): `E11.2a adds optional titer (series), grace (windowed), and a windowed Refused define — all back-compatible (absent ⇒ E11.1 output).`

- [ ] **Step 4: Run the unit tests — all pass**

Run: `cd backend-ts && node --import tsx --test src/engine/cql/codegen/generate-cql.test.ts`
Expected: PASS (9 tests — the original 4 + 5 new).

- [ ] **Step 5: Confirm E11.1 parity is untouched (back-compat)**

Run: `cd backend-ts && node --import tsx --test src/engine/cql/codegen/codegen-parity.test.ts`
Expected: PASS (the 6 migrated measures have no titer/grace/windowed-refusal, so their generated CQL is byte-identical to E11.1 — parity stays green). If anything fails here, a default path changed output — fix the template so absent fields reproduce E11.1 exactly.

- [ ] **Step 6: Typecheck**

Run: `cd backend-ts && node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend-ts/src/engine/cql/codegen/generate-cql.ts backend-ts/src/engine/cql/codegen/generate-cql.test.ts
git commit -m "feat(codegen): titer + grace + windowed declination (additive, back-compat) (E11.2a, #183)"
```

Append to the commit body:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vj9GhN5vxoENWrwrU56GZz
```

---

## Task 2: Behavioral golden scenarios (the proof)

**Files:**
- Create: `backend-ts/src/engine/cql/codegen/generate-cql-extensions.test.ts`

- [ ] **Step 1: Write the behavioral test**

Create `backend-ts/src/engine/cql/codegen/generate-cql-extensions.test.ts`:

```typescript
/** Behavioral goldens for E11.2a codegen extensions — translate generated CQL → ELM (compileCql),
 * evaluate inline synthetic bundles, assert the resulting Outcome Status (+ Refused). No hand-written
 * CQL exists for these shapes, so the asserted outcomes ARE the golden.
 *   node --import tsx --test src/engine/cql/codegen/generate-cql-extensions.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "../cql-execution-engine.ts";
import { compileCql } from "../cql-translator.ts";
import { generateCql, type GenerateCqlInput } from "./generate-cql.ts";

const EVAL = "2026-06-12";
const engine = new CqlExecutionEngine();

// Evaluate generated CQL over a bundle; return { outcome, defines }. measureId only drives the
// measurement period (periodMonths 0 here), so any series/windowed id works.
async function evalGen(measureId: string, input: GenerateCqlInput, bundle: unknown) {
  const compiled = compileCql(generateCql(input));
  assert.ok(compiled.ok, `generated CQL must translate: ${JSON.stringify(compiled.diagnostics)}`);
  const res = await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: EVAL, elm: compiled.elm });
  return res;
}

const bundle = (entries: unknown[]) => ({ resourceType: "Bundle", type: "collection", entry: entries });
const patient = (pid: string) => ({ resource: { resourceType: "Patient", id: pid } });
const condition = (pid: string, system: string, code: string) => ({
  resource: { resourceType: "Condition", id: `${pid}-c-${code}`, subject: { reference: `Patient/${pid}` }, code: { coding: [{ system, code }] } },
});
const procedure = (pid: string, system: string, code: string, performedDateTime: string) => ({
  resource: { resourceType: "Procedure", id: `${pid}-p`, status: "completed", subject: { reference: `Patient/${pid}` }, code: { coding: [{ system, code }] }, performedDateTime },
});
const immunization = (pid: string, system: string, code: string) => ({
  resource: { resourceType: "Immunization", id: `${pid}-i-${Math.round(Math.random() * 1e6)}`, status: "completed", patient: { reference: `Patient/${pid}` }, vaccineCode: { coding: [{ system, code }] }, occurrenceDateTime: "2026-04-23T00:00:00.000Z" },
});
const observation = (pid: string, system: string, code: string, value: number) => ({
  resource: { resourceType: "Observation", id: `${pid}-o`, status: "final", subject: { reference: `Patient/${pid}` }, code: { coding: [{ system, code }] }, effectiveDateTime: "2026-04-23T00:00:00.000Z", valueQuantity: { value, unit: "ratio" } },
});

const WIN = {
  enrollment: { code: "e", valueSet: "urn:vs:e" },
  waiver: { code: "w", valueSet: "urn:vs:w" },
  event: { code: "ev", valueSet: "urn:vs:ev", type: "procedure" as const },
};
const winRule = (gracePeriodDays?: number): GenerateCqlInput => ({
  library: "AnnualAudiogramCompleted", version: "1.0.0",
  rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30, ...(gracePeriodDays != null ? { gracePeriodDays } : {}) },
  bindings: WIN,
});

test("grace shifts the OVERDUE boundary: a 380-day-old exam is DUE_SOON with grace=30, OVERDUE with grace=0", async () => {
  // 2025-05-28 is ~380 days before 2026-06-12 → past windowDays(365) but within overdueThreshold(395) when grace=30.
  const b = bundle([patient("g"), condition("g", "urn:vs:e", "e"), procedure("g", "urn:vs:ev", "ev", "2025-05-28T00:00:00.000Z")]);
  assert.equal((await evalGen("audiogram", winRule(30), b)).outcome, "DUE_SOON");
  assert.equal((await evalGen("audiogram", winRule(0), b)).outcome, "OVERDUE");
});

test("grace: an exam past the grace window is OVERDUE even with grace", async () => {
  const b = bundle([patient("g2"), condition("g2", "urn:vs:e", "e"), procedure("g2", "urn:vs:ev", "ev", "2025-01-01T00:00:00.000Z")]); // ~527 days
  assert.equal((await evalGen("audiogram", winRule(30), b)).outcome, "OVERDUE");
});

const SER = {
  enrollment: { code: "ie", valueSet: "urn:vs:ie" },
  waiver: { code: "wc", valueSet: "urn:vs:wc" },
  event: { code: "vx", valueSet: "urn:vs:vx", type: "immunization" as const },
  titer: { code: "ti", valueSet: "urn:vs:ti", minValue: 10 },
};
const serRule = (allowPositiveTiter: boolean): GenerateCqlInput => ({
  library: "MmrSeries", version: "1.0.0",
  rule: { type: "series-completion", requiredDoses: 2, allowPositiveTiter },
  bindings: SER,
});

test("titer: a positive titer (>= minValue) with 0 doses is COMPLIANT", async () => {
  const b = bundle([patient("t"), condition("t", "urn:vs:ie", "ie"), observation("t", "urn:vs:ti", "ti", 12)]);
  assert.equal((await evalGen("mmr", serRule(true), b)).outcome, "COMPLIANT");
});

test("titer: a sub-threshold titer (< minValue) with 0 doses is MISSING_DATA", async () => {
  const b = bundle([patient("t2"), condition("t2", "urn:vs:ie", "ie"), observation("t2", "urn:vs:ti", "ti", 8)]);
  assert.equal((await evalGen("mmr", serRule(true), b)).outcome, "MISSING_DATA");
});

test("titer: a partial series (1 of 2 doses) with no titer is MISSING_DATA", async () => {
  const b = bundle([patient("t3"), condition("t3", "urn:vs:ie", "ie"), immunization("t3", "urn:vs:vx", "vx")]);
  assert.equal((await evalGen("mmr", serRule(true), b)).outcome, "MISSING_DATA");
});

test("titer: disabled — a positive titer is ignored (0 doses → MISSING_DATA)", async () => {
  const b = bundle([patient("t4"), condition("t4", "urn:vs:ie", "ie"), observation("t4", "urn:vs:ti", "ti", 12)]);
  assert.equal((await evalGen("mmr", serRule(false), b)).outcome, "MISSING_DATA");
});

test("declination: a refusal Condition sets Refused=true; Outcome Status is the canonical bucket (MISSING_DATA)", async () => {
  const input: GenerateCqlInput = {
    library: "AnnualAudiogramCompleted", version: "1.0.0",
    rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 },
    bindings: { ...WIN, refusal: { code: "rf", valueSet: "urn:vs:rf" } },
  };
  const b = bundle([patient("d"), condition("d", "urn:vs:e", "e"), condition("d", "urn:vs:rf", "rf")]); // enrolled, refused, no exam
  const res = await evalGen("audiogram", input, b);
  assert.equal(res.outcome, "MISSING_DATA");
  const refused = res.evidence.expressionResults.find((r) => r.define === "Refused");
  assert.ok(refused && /true/i.test(String(refused.result)), "Refused define must be true");
});
```

> Note: `Math.random()` in the immunization id is fine here (it only de-dupes resource ids within one inline bundle and never affects an outcome). If your lint forbids `Math.random`, replace with a per-call counter.

- [ ] **Step 2: Run it**

Run: `cd backend-ts && node --import tsx --test src/engine/cql/codegen/generate-cql-extensions.test.ts`
Expected: PASS (8 tests). If a grace boundary test is off by a day, adjust the exam date so it lands clearly inside/outside the band (the assertion is the spec — do not weaken it; the date math is what flexes). If titer/declination fails, the codegen has a semantic bug — fix `generate-cql.ts` (Task 1's file) and re-run.

- [ ] **Step 3: Typecheck + commit**

Run: `cd backend-ts && node_modules/.bin/tsc --noEmit`
Expected: no errors.

```bash
git add backend-ts/src/engine/cql/codegen/generate-cql-extensions.test.ts
git commit -m "test(codegen): behavioral goldens for titer + grace + declination (E11.2a, #183)"
```
Append the two trailer lines.

---

## Task 3: Docs + full verification

**Files:**
- Modify: `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `docs/JOURNAL.md`

- [ ] **Step 1: Extend ADR-015 in `docs/DECISIONS.md`**

Under the existing `## ADR-015:` section, append a paragraph (find the `**Consequences.**` line in ADR-015 and add after it):

```markdown
**E11.2a (codegen extensions).** Added three additive, back-compatible rule capabilities to the codegen:
**grace** (windowed — `overdueThreshold = windowDays + gracePeriodDays`, extends the Due-Soon band before
OVERDUE), **titer** (series — `allowPositiveTiter` + a titer Observation binding ORs `Has Positive Titer`
into `Series Complete`, a real immunity path), and **declination** (a `Refused` define wherever a refusal
binding is present — read by the roster's DECLINED display, never changes `Outcome Status`). All fields are
optional; absent ⇒ E11.1 output byte-for-byte, so the parity proof is unaffected. Proven by behavioral
goldens (`generate-cql-extensions.test.ts`). The Hep B multi-alternative-series with min-interval validation
+ multi-CVX is deferred. The E11.2b Rule Builder UI emits these params.
```

- [ ] **Step 2: Note it in `docs/ARCHITECTURE.md` (the `engine.cql.codegen` sentence)**

Find the `engine.cql.codegen` codegen sentence (added in E11.1) and append:

```markdown
E11.2a extends the codegen with optional **titer** (series `allowPositiveTiter` + Observation binding), **grace** (windowed `gracePeriodDays`), and a windowed **Refused** define (declination) — all back-compatible (absent ⇒ E11.1 output), proven by `generate-cql-extensions.test.ts`.
```

- [ ] **Step 3: Add a `docs/JOURNAL.md` entry on top**

```markdown
## 2026-06-24 — E11.2a: codegen titer + grace + declination

Extended the E11.1 rule→CQL codegen (`generate-cql.ts`) with three additive, back-compatible capabilities
toward the Rule Builder's "Compliance paths & timing" group (vamsi7): **grace** (windowed —
`overdueThreshold = windowDays + gracePeriodDays`, extends Due-Soon before OVERDUE), **titer** (series —
`allowPositiveTiter` ORs a `Has Positive Titer` Observation define into `Series Complete`, a real immunity
path), and **declination** (a `Refused` define wherever a refusal binding is present; never changes
`Outcome Status` — the roster shows DECLINED). Every new field is optional; absent ⇒ E11.1 output
byte-for-byte, so the E11.1 parity proof (6×4) stays green unchanged. Proven by behavioral goldens
(`generate-cql-extensions.test.ts`: grace shifts the OVERDUE boundary, a positive titer with 0 doses is
COMPLIANT, a refusal sets Refused=true). ADR-008 holds — codegen only emits CQL. The Hep B
multi-series/intervals/multi-CVX is deferred. Next: E11.2b Rule Builder UI (Studio tab → form → preview →
save). Built subagent-driven; backend suite + typecheck green.
```

- [ ] **Step 4: Full backend verification**

Run: `cd backend-ts && node_modules/.bin/tsc --noEmit && node --import tsx --test "src/**/*.test.ts"`
Expected: typecheck clean; all tests pass (incl. the existing codegen/parity unchanged + the new unit + behavioral; 1 pre-existing Pg-ceiling skip is fine).

- [ ] **Step 5: Commit**

```bash
git add docs/DECISIONS.md docs/ARCHITECTURE.md docs/JOURNAL.md
git commit -m "docs(codegen): ADR-015 E11.2a note — titer + grace + declination (#183)"
```
Append the two trailer lines.

---

## Self-Review

**1. Spec coverage:** schema additions (§3) → Task 1.3. Grace (§4.1) → Task 1.3 windowed `overdueThreshold` + unit (1.1) + behavioral (2.1). Titer (§4.2) → Task 1.3 series titer + unit + behavioral. Declination (§4.3) → Task 1.3 windowed `Refused` + unit + behavioral. Validation/back-compat (§5) → Task 1.5 (parity untouched) + Task 2 behavioral. Testing (§6) → Tasks 1–2. Guardrails (§7) → honored; documented Task 3.

**2. Placeholder scan:** none — every code step is complete. The two notes (Task 2 `Math.random` id, Task 2 date-math flex) are explicit guidance, not missing logic.

**3. Type consistency:** `Rule` gains `allowPositiveTiter?` (series) + `gracePeriodDays?` (windowed); `CodegenBindings` gains `titer?: {code, valueSet, minValue}`. These are defined in Task 1.3 and used identically in the unit tests (1.1) and behavioral tests (2.1, `SER.titer`, `serRule`, `winRule`). `generateCql`/`GenerateCqlInput` signatures unchanged (the new fields are optional members of the existing types). The behavioral test imports `generateCql, GenerateCqlInput` from `./generate-cql.ts` (exported) and uses the engine `elm?` override + `compileCql` exactly as E11.1's parity test does.
