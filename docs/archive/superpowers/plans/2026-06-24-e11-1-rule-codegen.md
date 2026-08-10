# E11.1 — Rule-params → CQL codegen Implementation Plan (#183)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic codegen that turns a measure's structured `rule:` params into CQL behaviorally equivalent (same `Outcome Status`) to the hand-written CQL, proven at parity, for two rule shapes (series-completion + windowed-recency) — plus ADR-015 recording CQL as canonical.

**Architecture:** A pure TS module emits canonical CQL text from `{rule, bindings, library}`. A `gen-cql` script writes `measures/generated/<id>.cql` for the 6 migrated measures (hand-written `.cql` stays the build source — no cutover). A parity test translates each generated CQL → ELM in-process (`compileCql`) and evaluates it over the existing synthetic scenarios, asserting its `Outcome Status` equals the hand-written measure's for every scenario.

**Tech Stack:** backend-ts; `@cqframework/cql` (in-process CQL→ELM via the existing `compileCql`), `cql-execution` (via the existing `CqlExecutionEngine`), `node --test`.

---

## File Structure

**Create:**
- `backend-ts/src/engine/cql/codegen/generate-cql.ts` — `generateCql(input)` + the two shape templates.
- `backend-ts/src/engine/cql/codegen/generate-cql.test.ts` — unit tests (exact output per shape).
- `backend-ts/src/engine/cql/codegen/codegen-parity.test.ts` — generated-vs-hand-written `Outcome Status` parity.
- `backend-ts/scripts/gen-cql.mjs` — writes `measures/generated/<id>.cql` from each YAML's `rule:` block.
- `backend-ts/measures/generated/{mmr,varicella,hepatitis_b,audiogram,hypertension,cholesterol_ldl}.cql` — committed generated output (6).

**Modify:**
- `backend-ts/measures/{mmr,varicella,hepatitis_b,audiogram,hypertension,cholesterol_ldl}.yaml` — add a `rule:` block (6).
- `backend-ts/src/engine/cql/cql-execution-engine.ts` — add an optional `elm` override to `evaluate()`.
- `backend-ts/package.json` — add a `gen-cql` script.
- `docs/DECISIONS.md` (ADR-015), `docs/ARCHITECTURE.md` (engine §3 codegen note), `docs/JOURNAL.md`.

---

## Task 1: The codegen module (`generateCql`) + unit tests

The generator is pure: `generateCql(input) → cqlText`. It dispatches on `input.rule.type`. The output uses **canonical define names** and the inline-code pattern (the hand-written measures' `valueset` declarations are unused vestiges — the defines use inline `system`/`code` literals — so the generated CQL omits them; identical `Outcome Status`).

**Files:**
- Create: `backend-ts/src/engine/cql/codegen/generate-cql.ts`, `backend-ts/src/engine/cql/codegen/generate-cql.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend-ts/src/engine/cql/codegen/generate-cql.test.ts`:

```typescript
/** generateCql — deterministic CQL from rule-params, per shape.
 *   node --import tsx --test src/engine/cql/codegen/generate-cql.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCql } from "./generate-cql.ts";

const SERIES_CODES = {
  enrollment: { code: "immz-enrolled", valueSet: "urn:workwell:vs:immz-enrollment" },
  waiver: { code: "mmr-contraindication", valueSet: "urn:workwell:vs:mmr-contraindication" },
  event: { code: "mmr-vaccine", valueSet: "urn:workwell:vs:mmr-vaccines", type: "immunization" as const },
  refusal: { code: "mmr-refusal", valueSet: "urn:workwell:vs:mmr-refusal" },
};

test("series-completion emits the dose-count CQL with the required-doses threshold", () => {
  const cql = generateCql({
    library: "MmrSeries", version: "1.0.0",
    rule: { type: "series-completion", requiredDoses: 2 },
    bindings: SERIES_CODES,
  });
  assert.match(cql, /^library MmrSeries version '1\.0\.0'/);
  assert.match(cql, /define "Dose Count":/);
  assert.match(cql, /\[Immunization\] I\s+where I\.status = 'completed'/);
  assert.match(cql, /C\.system = 'urn:workwell:vs:mmr-vaccines' and C\.code = 'mmr-vaccine'/);
  assert.match(cql, /"Dose Count" >= 2/);
  assert.match(cql, /define "Outcome Status":/);
  assert.match(cql, /if "Excluded" then 'EXCLUDED'/);
  assert.match(cql, /else if "Series Complete" then 'COMPLIANT'/);
  // canonical names the roster needs
  assert.match(cql, /define "Has Contraindication":/);
  assert.match(cql, /define "Refused":/);
});

test("windowed-recency emits the days-since ladder with the compliant/due-soon bands", () => {
  const cql = generateCql({
    library: "AnnualAudiogramCompleted", version: "1.0.0",
    rule: { type: "windowed-recency", windowDays: 365, dueSoonDays: 30 },
    bindings: {
      enrollment: { code: "hearing-enrollment", valueSet: "urn:workwell:vs:hearing-enrollment" },
      waiver: { code: "audiogram-waiver", valueSet: "urn:workwell:vs:audiogram-waiver" },
      event: { code: "audiogram-procedure", valueSet: "urn:workwell:vs:audiogram-procedures", type: "procedure" },
    },
  });
  assert.match(cql, /^library AnnualAudiogramCompleted version '1\.0\.0'/);
  assert.match(cql, /define "Most Recent Event Date":/);  // satisfies deriveWhyFlagged /^most recent .*date$/i
  assert.match(cql, /define "Days Since Last Event":/);   // satisfies /^days since/i
  assert.match(cql, /\[Procedure\] P/);
  assert.match(cql, /"Days Since Last Event" <= 335/);    // windowDays - dueSoonDays
  assert.match(cql, /"Days Since Last Event" > 335 and "Days Since Last Event" <= 365/);
  assert.match(cql, /"Days Since Last Event" > 365/);
  assert.match(cql, /else if "Compliant" then 'COMPLIANT'/);
});

test("an unknown rule type throws", () => {
  // @ts-expect-error — deliberate bad type
  assert.throws(() => generateCql({ library: "X", version: "1.0.0", rule: { type: "nope" }, bindings: SERIES_CODES }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/engine/cql/codegen/generate-cql.test.ts`
Expected: FAIL — `./generate-cql.ts` not found.

- [ ] **Step 3: Create `backend-ts/src/engine/cql/codegen/generate-cql.ts`**

```typescript
/**
 * Rule-params → CQL codegen (E11.1, ADR-015). Emits canonical CQL (inline-code pattern) for two rule
 * shapes; behaviorally equivalent (same `Outcome Status`) to the hand-written CQL, proven by
 * codegen-parity.test.ts. CQL stays the sole execution + standards layer (ADR-008); this only *produces*
 * CQL. Define names are chosen to satisfy the roster's deriveWhyFlagged regexes
 * (/^most recent .*date$/i, /^days since/i, waiver/contraindication, "Dose Count").
 */
export interface CodeBinding {
  code: string;
  valueSet: string;
}
export interface CodegenBindings {
  enrollment: CodeBinding;
  waiver: CodeBinding;
  event: CodeBinding & { type: "procedure" | "immunization" | "observation" };
  refusal?: CodeBinding;
}
export type Rule =
  | { type: "series-completion"; requiredDoses: number }
  | { type: "windowed-recency"; windowDays: number; dueSoonDays: number };

export interface GenerateCqlInput {
  library: string;
  version: string;
  rule: Rule;
  bindings: CodegenBindings;
}

const header = (library: string, version: string): string =>
  `library ${library} version '${version}'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

parameter "Measurement Period" Interval<DateTime>
context Patient
`;

/** `exists([Condition] … inline system/code)` — the enrollment/waiver/refusal pattern. */
const conditionDefine = (name: string, b: CodeBinding): string =>
  `
define "${name}":
  exists([Condition] C
    where exists(C.code.coding x where x.system = '${b.valueSet}' and x.code = '${b.code}'))
`;

function seriesCompletion(input: GenerateCqlInput): string {
  const b = input.bindings;
  if (b.event.type !== "immunization") throw new Error("series-completion requires event.type=immunization");
  const n = (input.rule as { requiredDoses: number }).requiredDoses;
  return (
    header(input.library, input.version) +
    conditionDefine("Enrolled", b.enrollment) +
    conditionDefine("Has Contraindication", b.waiver) +
    (b.refusal ? conditionDefine("Refused", b.refusal) : "") +
    `
define "Dose Count":
  Count([Immunization] I
    where I.status = 'completed'
      and exists(I.vaccineCode.coding C where C.system = '${b.event.valueSet}' and C.code = '${b.event.code}'))

define "Series Complete":
  "Enrolled" and not "Has Contraindication" and "Dose Count" >= ${n}

define "Excluded": "Has Contraindication"

define "Initial Population": "Enrolled" or "Has Contraindication"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Series Complete" then 'COMPLIANT'
  else 'MISSING_DATA'
`
  );
}

function windowedRecency(input: GenerateCqlInput): string {
  const b = input.bindings;
  if (b.event.type !== "procedure") throw new Error("windowed-recency (E11.1) requires event.type=procedure");
  const { windowDays, dueSoonDays } = input.rule as { windowDays: number; dueSoonDays: number };
  const compliantMax = windowDays - dueSoonDays;
  return (
    header(input.library, input.version) +
    conditionDefine("Enrolled", b.enrollment) +
    conditionDefine("Has Waiver", b.waiver) +
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
  "Enrolled" and not "Has Waiver" and "Days Since Last Event" > ${compliantMax} and "Days Since Last Event" <= ${windowDays}

define "Overdue":
  "Enrolled" and not "Has Waiver" and "Days Since Last Event" > ${windowDays}

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

export function generateCql(input: GenerateCqlInput): string {
  switch (input.rule.type) {
    case "series-completion":
      return seriesCompletion(input);
    case "windowed-recency":
      return windowedRecency(input);
    default:
      throw new Error(`unknown rule.type '${(input.rule as { type: string }).type}'`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/engine/cql/codegen/generate-cql.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `cd backend-ts && node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend-ts/src/engine/cql/codegen/generate-cql.ts backend-ts/src/engine/cql/codegen/generate-cql.test.ts
git commit -m "feat(codegen): rule-params → CQL generator for series + windowed shapes (E11.1, #183)"
```

Append to the commit body:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vj9GhN5vxoENWrwrU56GZz
```

---

## Task 2: `rule:` blocks in the 6 YAMLs + `gen-cql` script + committed generated CQL

**Files:**
- Modify: the 6 `backend-ts/measures/<id>.yaml`; `backend-ts/package.json`
- Create: `backend-ts/scripts/gen-cql.mjs`; `backend-ts/measures/generated/<id>.cql` ×6
- Test: `backend-ts/src/engine/cql/codegen/generated-files.test.ts`

- [ ] **Step 1: Add a `rule:` block to each of the 6 measure YAMLs**

Append (top-level, sibling to `bindings:`) the matching block:
- `mmr.yaml`, `varicella.yaml`, `hepatitis_b.yaml`:
  ```yaml
  rule:
    type: series-completion
    requiredDoses: 2
  ```
- `audiogram.yaml`, `hypertension.yaml`, `cholesterol_ldl.yaml`:
  ```yaml
  rule:
    type: windowed-recency
    windowDays: 365
    dueSoonDays: 30
  ```

- [ ] **Step 2: Create `backend-ts/scripts/gen-cql.mjs`**

This reads each YAML's `rule:` + `bindings:`, calls the TS generator via tsx, and writes `measures/generated/<id>.cql`. It mirrors `gen-measure-bindings.mjs`'s regex YAML reading and imports the generator through tsx (the npm script runs it with `node --import tsx`).

```javascript
// Generates measures/generated/<id>.cql from each measure YAML's `rule:` block (E11.1). The hand-written
// measures/<id>.cql remains the build source — this generated output is the parity-proof artifact.
//   node --import tsx scripts/gen-cql.mjs
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateCql } from "../src/engine/cql/codegen/generate-cql.ts";
import { MEASURES } from "../src/engine/cql/measure-registry.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const measuresDir = path.join(root, "measures");
const outDir = path.join(measuresDir, "generated");
mkdirSync(outDir, { recursive: true });

const line = (s, key) => s.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"))?.[1].trim();
const inField = (block, k) => block?.match(new RegExp(`${k}:\\s*"?([^,"}]+?)"?\\s*[,}]`))?.[1].trim() ?? null;
const codeOf = (s, key) => { const b = line(s, key); return b ? { code: inField(b, "code"), valueSet: inField(b, "valueSet"), type: inField(b, "type") ?? undefined } : null; };

let count = 0;
for (const f of readdirSync(measuresDir).filter((x) => x.endsWith(".yaml")).sort()) {
  const s = readFileSync(path.join(measuresDir, f), "utf8");
  const ruleType = line(s, "type"); // the `rule:` block's type is the file's only top-level `type:`
  if (ruleType !== "series-completion" && ruleType !== "windowed-recency") continue; // opt-in
  const id = line(s, "id");
  const meta = MEASURES[id];
  if (!meta) throw new Error(`measure '${id}' has a rule: block but no registry entry`);
  const [library, version] = meta.library.split(/-(?=[0-9])/); // "MmrSeries-1.0.0" → ["MmrSeries","1.0.0"]

  const enrollment = codeOf(s, "enrollment");
  const waiver = codeOf(s, "waiver");
  const event = codeOf(s, "event");
  const refusal = codeOf(s, "refusal");
  const bindings = { enrollment, waiver, event, ...(refusal ? { refusal } : {}) };

  const rule = ruleType === "series-completion"
    ? { type: "series-completion", requiredDoses: Number(line(s, "requiredDoses") ?? 2) }
    : { type: "windowed-recency", windowDays: Number(line(s, "windowDays") ?? 365), dueSoonDays: Number(line(s, "dueSoonDays") ?? 30) };

  const cql = generateCql({ library, version, rule, bindings });
  writeFileSync(path.join(outDir, `${id}.cql`), cql, "utf8");
  count++;
}
console.log(`gen-cql: wrote ${count} generated CQL file(s) to measures/generated/`);
```

> Note: the `rule:` block's `type:` is the only top-level `type:` line in a measure YAML (the `event:` has `type` but it's inline on the event line, matched by `inField`, not the `^\s*type:` line). Confirm by inspection; if any YAML has another top-level `type:`, scope the match to lines after a `rule:` marker.

- [ ] **Step 3: Add the npm script to `backend-ts/package.json`**

In `"scripts"`, add:
```json
"gen-cql": "node --import tsx scripts/gen-cql.mjs",
```

- [ ] **Step 4: Run it to produce the generated CQL**

Run: `cd backend-ts && npm run gen-cql`
Expected: `gen-cql: wrote 6 generated CQL file(s) to measures/generated/`. Inspect `measures/generated/mmr.cql` and `measures/generated/audiogram.cql` — they should match the Task-1 templates with the real codes.

- [ ] **Step 5: Write the drift-guard test**

Create `backend-ts/src/engine/cql/codegen/generated-files.test.ts`:

```typescript
/** The committed measures/generated/<id>.cql must equal what generateCql produces from the YAML — so a
 * rule-param edit that wasn't re-generated fails CI. node --import tsx --test src/engine/cql/codegen/generated-files.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const genDir = fileURLToPath(new URL("../../../../measures/generated", import.meta.url));

test("generated/ contains the 6 migrated measures", () => {
  const files = readdirSync(genDir).filter((f) => f.endsWith(".cql")).sort();
  assert.deepEqual(files, [
    "audiogram.cql", "cholesterol_ldl.cql", "hepatitis_b_vaccination_series.cql", "hypertension.cql", "mmr.cql", "varicella.cql",
  ]);
});

test("each generated CQL has a library header + an Outcome Status define", () => {
  for (const f of readdirSync(genDir).filter((x) => x.endsWith(".cql"))) {
    const cql = readFileSync(path.join(genDir, f), "utf8");
    assert.match(cql, /^library \S+ version '/, `${f} library header`);
    assert.match(cql, /define "Outcome Status":/, `${f} Outcome Status`);
  }
});
```

> The strong "generated === generateCql(YAML params)" equivalence is enforced behaviorally by the parity test in Task 3 (which evaluates the committed generated CQL). This file guards presence/shape and the file set. If you want exact-text drift detection, re-run `npm run gen-cql` in CI and `git diff --exit-code measures/generated` — note that as a follow-up; do not add a flaky text-snapshot here.

- [ ] **Step 6: Run the test + commit**

Run: `cd backend-ts && node --import tsx --test src/engine/cql/codegen/generated-files.test.ts`
Expected: PASS (2 tests).

```bash
git add backend-ts/measures/*.yaml backend-ts/measures/generated/ backend-ts/scripts/gen-cql.mjs backend-ts/package.json backend-ts/src/engine/cql/codegen/generated-files.test.ts
git commit -m "feat(codegen): rule: blocks for 6 measures + gen-cql script + generated CQL (E11.1, #183)"
```
Append the two trailer lines.

---

## Task 3: Engine ELM-override + Outcome-Status parity test

**Files:**
- Modify: `backend-ts/src/engine/cql/cql-execution-engine.ts`
- Test: `backend-ts/src/engine/cql/codegen/codegen-parity.test.ts`

- [ ] **Step 1: Add an optional `elm` override to `evaluate()`**

In `backend-ts/src/engine/cql/cql-execution-engine.ts`, change the `evaluate` signature + the one line that loads the library so a caller can supply a pre-translated ELM object (everything else — the measurement period derived from `meta`, the executor, the extraction — stays). Find:

```typescript
  async evaluate(input: EvaluateMeasureInput): Promise<MeasureOutcome> {
```
Change to:
```typescript
  async evaluate(input: EvaluateMeasureInput & { elm?: unknown }): Promise<MeasureOutcome> {
```
And find the library-construction line:
```typescript
    const library = new cql.Library(this.loadElm(libraryName), new cql.Repository({ FHIRHelpers: this.fhirHelpers }));
```
Change to:
```typescript
    // E11.1: an optional pre-translated ELM (e.g. generated CQL) overrides the bundled library — same
    // measurement period / executor / extraction, so it proves codegen parity through the real engine path.
    const library = new cql.Library(input.elm ?? this.loadElm(libraryName), new cql.Repository({ FHIRHelpers: this.fhirHelpers }));
```

> Do not change `EvaluateMeasureInput` itself (keep the override local to `evaluate`'s param). The `meta`/`expand`/`measurementPeriod`/`codeService`/`executor`/extraction code is unchanged.

- [ ] **Step 2: Write the parity test**

Create `backend-ts/src/engine/cql/codegen/codegen-parity.test.ts`:

```typescript
/** Outcome-Status parity (E11.1): for each migrated measure × synthetic scenario, the GENERATED CQL's
 * Outcome Status equals the HAND-WRITTEN measure's — proving codegen ≡ hand-written on the compliance
 * authority (ADR-008). Self-contained (both evaluated in Node).
 *   node --import tsx --test src/engine/cql/codegen/codegen-parity.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CqlExecutionEngine } from "../cql-execution-engine.ts";
import { compileCql } from "../cql-translator.ts";

const MIGRATED = ["mmr", "varicella", "hepatitis_b_vaccination_series", "audiogram", "hypertension", "cholesterol_ldl"];
// gen-cql writes by measure id, so the generated file is `<measureId>.cql` (no remap).
const SCENARIOS = ["present_recent", "present_old", "missing", "excluded"];
const EVAL = "2026-06-12";

const synthRoot = fileURLToPath(new URL("../../../../spike/synthetic", import.meta.url));
const genRoot = fileURLToPath(new URL("../../../../measures/generated", import.meta.url));
const engine = new CqlExecutionEngine();

for (const measureId of MIGRATED) {
  test(`generated CQL matches hand-written Outcome Status for ${measureId}`, async () => {
    const generatedCql = readFileSync(path.join(genRoot, `${measureId}.cql`), "utf8");
    const compiled = compileCql(generatedCql);
    assert.ok(compiled.ok, `generated ${measureId} CQL must translate: ${JSON.stringify(compiled.diagnostics)}`);

    for (const scenario of SCENARIOS) {
      const bundle = JSON.parse(readFileSync(path.join(synthRoot, measureId, `${scenario}.json`), "utf8"));
      const handWritten = await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: EVAL });
      const generated = await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: EVAL, elm: compiled.elm });
      assert.equal(generated.outcome, handWritten.outcome, `${measureId}/${scenario}`);
    }
  });
}
```

- [ ] **Step 3: Run the parity test to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/engine/cql/codegen/codegen-parity.test.ts`
Expected: PASS (6 tests — one per measure, each asserting 4 scenarios). If any scenario mismatches, the generated CQL diverges — fix the Task-1 template (do NOT relax the assertion) until generated ≡ hand-written.

- [ ] **Step 4: Typecheck + confirm the existing engine tests still pass**

Run: `cd backend-ts && node_modules/.bin/tsc --noEmit && node --import tsx --test src/engine/cql/cql-execution-engine.test.ts`
Expected: typecheck clean; the existing per-measure golden test still passes (the `elm?` param is optional/back-compatible).

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/engine/cql/cql-execution-engine.ts backend-ts/src/engine/cql/codegen/codegen-parity.test.ts
git commit -m "feat(codegen): Outcome-Status parity proof — generated CQL == hand-written (E11.1, #183)"
```
Append the two trailer lines.

---

## Task 4: ADR-015 + docs + full verification

**Files:**
- Modify: `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `docs/JOURNAL.md`

- [ ] **Step 1: Record ADR-015 in `docs/DECISIONS.md`**

Append after ADR-014:

```markdown
## ADR-015: CQL is canonical; rule-params compile to CQL (codegen) — E11.1 (#183)

**Decision.** Answering Doug's "is CQL or YAML canonical?": **CQL/ELM is the sole execution + standards-
fidelity layer** (ADR-008 holds — `Outcome Status` is the only compliance authority). Structured
**rule-params** (a new `rule:` block in a measure's YAML) are the canonical *authoring* surface for
parametric measures; a deterministic **codegen** (`backend-ts/src/engine/cql/codegen/generate-cql.ts`)
compiles `rule:` (+ the existing `bindings:` codes) → CQL → ELM via the existing pipeline. **One execution
path — no second evaluator.** Codegen is **opt-in per measure**: a measure with no `rule:` block keeps its
hand-written `.cql` (eCQM/complex measures stay hand-authored; E14 import/diff unaffected).

**Scope (E11.1).** Two rule shapes: `series-completion` (mmr/varicella/hepatitis_b) and `windowed-recency`
(audiogram/hypertension/cholesterol_ldl — the code-scoped uniform windowed measures). The generated CQL
uses canonical define names and is proven **`Outcome Status`-equivalent** to the hand-written CQL across the
synthetic scenarios (`codegen-parity.test.ts`). **No cutover** — the hand-written `.cql` remains the build
source; `measures/generated/<id>.cql` is the parity artifact. Legacy non-code-scoped measures (hazwoper,
tb_surveillance) are excluded pending a code-scope migration. The Rule Builder UI (E11.2) emits the `rule:`
params; segments/risk-groups (E11.3) are separate.

**Consequences.** Non-CQL authors can change a rule's thresholds via params (E11.2 builds the form); CQL
remains the standards layer; no schema/DDL (rule-params are build-time YAML); no new runtime deps.
```

- [ ] **Step 2: Note the codegen in `docs/ARCHITECTURE.md` (§3 engine)**

In the `engine` module bullet, append:

```markdown
`engine.cql.codegen` hosts the **rule→CQL codegen** (E11.1 / ADR-015): `generateCql({rule, bindings,
library})` emits canonical CQL for the `series-completion` + `windowed-recency` shapes; the `rule:` block in
a measure's YAML is the canonical authoring input, compiled to CQL→ELM via the existing pipeline (opt-in per
measure; hand-written `.cql` stays the build source — `measures/generated/<id>.cql` is the parity artifact,
proven `Outcome Status`-equivalent to the hand-written CQL). CQL remains the sole execution authority.
```

- [ ] **Step 3: Add a `docs/JOURNAL.md` entry on top**

```markdown
## 2026-06-24 — E11.1: rule-params → CQL codegen + ADR-015 (canonical decision)

Started epic E11 (#183) with the linchpin decision: **CQL is canonical; rule-params compile to CQL**
(ADR-015) — answering Doug's CQL-vs-YAML question without a second execution path. New
`engine/cql/codegen/generate-cql.ts` emits canonical CQL for two rule shapes — `series-completion`
(mmr/varicella/hepatitis_b) and `windowed-recency` (audiogram/hypertension/cholesterol_ldl) — from each
measure's new YAML `rule:` block (via `pnpm gen-cql` → `measures/generated/<id>.cql`). Proven
**`Outcome Status`-equivalent** to the hand-written CQL across all synthetic scenarios
(`codegen-parity.test.ts`, translating generated CQL → ELM in-process via `compileCql` and evaluating
through the real engine with an optional `elm` override). **No cutover** (hand-written `.cql` stays the
build source), **no schema, no new deps**; legacy non-code-scoped measures (hazwoper/tb) excluded pending a
code-scope migration. Next: E11.2 Rule Builder UI (form → `rule:`), E11.3 segments/risk-groups. Built
subagent-driven; backend suite + typecheck green.
```

- [ ] **Step 4: Full backend verification**

Run: `cd backend-ts && node_modules/.bin/tsc --noEmit && node --import tsx --test "src/**/*.test.ts"`
Expected: typecheck clean; all tests pass (incl. the existing engine golden + the new codegen + parity; 1 pre-existing Pg-ceiling skip is fine).

- [ ] **Step 5: Commit**

```bash
git add docs/DECISIONS.md docs/ARCHITECTURE.md docs/JOURNAL.md
git commit -m "docs(codegen): ADR-015 + rule→CQL codegen architecture note (E11.1, #183)"
```
Append the two trailer lines.

---

## Self-Review

**1. Spec coverage:** ADR-015 decision → Task 4.1. Rule schema + codegen (both shapes) → Task 1. Build integration (`rule:` YAMLs + `gen-cql` + generated CQL, no cutover) → Task 2. Outcome-parity proof (translate-in-process + engine `elm` override + per-scenario `Outcome Status`) → Task 3. Measure scope (3 series + 3 code-scoped windowed; legacy excluded) → Tasks 2–3. Guardrails (ADR-008, no schema/deps, no cutover) → honored; documented Task 4.

**2. Placeholder scan:** none — every code step is complete. The two notes (Task 2 `type:` matching caveat, Task 2 exact-text drift as a follow-up) are explicit guidance, not missing logic.

**3. Type consistency:** `generateCql(input: GenerateCqlInput)` with the `Rule` union + `CodegenBindings` is defined once (Task 1.3) and consumed by the test (1.1) and `gen-cql.mjs` (2.2). The engine `evaluate` gains `& { elm?: unknown }` (3.1), used by the parity test (3.2). **Generated file naming is consistent: `gen-cql` writes `<measureId>.cql`**, so hepatitis_b's file is `hepatitis_b_vaccination_series.cql` — matched in Task 2.5's expected file list and read directly by measure id in Task 3.2 (no remap). The `library`/`version` split (`MmrSeries-1.0.0` → `["MmrSeries","1.0.0"]`) is the same in `gen-cql.mjs` and matches the Task-1 template header.
