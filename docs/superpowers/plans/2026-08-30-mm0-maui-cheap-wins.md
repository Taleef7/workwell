# MM-0 — Maui Cheap Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repo the execution mode is one Codex (Luna) lane per task, orchestrator-reviewed, cross-model review at Tier 2.

**Goal:** The four code deliverables of ROADMAP_2026-08-30 §5 MM-0 that need no external dependency: URL-backed filters + clickable status chips, "patient" terminology as deployment config, a Maui-shaped synthetic tenant, and the MIPS↔CMS crosswalk in the UI.

**Architecture:** Frontend work follows existing patterns exactly (Next.js 16 App Router client pages, `useApi()` client, vitest + RTL + MSW with the `compliance/__tests__/page.test.tsx` mocking template). Terminology is a build-time `NEXT_PUBLIC_*` env var (the deployment-config mechanism this repo actually has — the ADR-004 brand switcher is per-browser CSS and NOT deployment config), read through one new `frontend/lib/terminology.ts` module. Backend work adds a `maui` tenant to the synthetic catalog and a `mipsId` field to the measure catalog, surfaced through the existing program read models.

**Tech Stack:** Next.js 16 / React 19 / TypeScript / vitest / @testing-library/react / MSW (frontend); TypeScript + node test runner via `pnpm test` (backend-ts).

> **Review adjudications (2026-08-30, recorded after the fact — the steps below are the original
> plan; where they conflict, this note wins):**
> 1. *Task 1:* COMPLIANT/EXCLUDED chips stay **static** — the roster's status filter is
>    any-cell-per-panel, not per-measure, so no destination reproduces those counts today; a link
>    that opens the wrong population is worse than none. Actionable chips carry the active
>    `site`/`from`/`to` scope (the tenant selector has no `/api/cases` equivalent — stated residual).
>    A measure-scoped roster drill-down is MM-2 backlog.
> 2. *Task 1:* filters are **derived from the URL per render**, not useState-initialized — browser
>    back/forward correctness; tests use a reactive `next/navigation` mock.
> 3. *Task 3:* the Maui tenant is **directory-only** (`EVALUATION_EXCLUDED_TENANTS`) until MM-1
>    wires the pilot measure set: the global seeded distribution otherwise reshuffles ~20% of
>    existing twh/ihn targets (demo churn), enrolls patients in occupational measures, and the
>    pat-* ids hash-cluster into single buckets so per-tenant bucket coverage is not real under
>    the product's full-population distribution. The bucket-coverage requirement moves to MM-1,
>    where per-tenant distribution / id de-clustering is designed deliberately.

**Out of scope for this plan (tracked in ROADMAP §5/§7, done separately):** the second Create-a-Container deployment + DNS (owner/MIE step), sandbox account provisioning, anything requiring MM-1 measure onboarding (CMS2/CMS130/CMS165/CMS137 cohorts — their data lands WITH their onboarding so no dead data is generated).

**Standing rules for every task (from CLAUDE.md + owner):** no new dependencies; no Claude attribution anywhere in commits or PRs; no client-side names — "Maui" and "the pilot group" only; minimal diffs, no drive-by refactors; every commit message is conventional (`feat(scope): …`); one PR per task on a `feat/<slug>` branch; frontend gate = `pnpm lint && pnpm test && pnpm build` in `frontend/`; backend gate = `pnpm typecheck && pnpm test` in `backend-ts/`.

---

## Task 1: URL-backed case/roster filters + clickable status chips

The pilot's quality team clicks a count and lands on the pre-filtered list — no re-filtering. Today the programs-page chips are inert `<span>`s under a stretched card-overlay link, and the one deep link that exists (`/cases?measureId=…` in the card footer) is silently ignored because the cases page never reads `measureId` from the URL.

**Files:**
- Modify: `frontend/app/(dashboard)/cases/page.tsx` (URL read at :78-81, write-back pattern at :259-268, filter state at :89-103)
- Modify: `frontend/app/(dashboard)/compliance/page.tsx` (filter state at :30-38, request build at :76-85)
- Modify: `frontend/app/(dashboard)/programs/page.tsx` (chip row :269-275, `Badge` :378-389, stretched overlay :256-260)
- Test (create): `frontend/app/(dashboard)/cases/__tests__/page.urlfilters.test.tsx`
- Test (create): `frontend/app/(dashboard)/compliance/__tests__/page.urlfilters.test.tsx`
- Test (create): `frontend/app/(dashboard)/programs/__tests__/page.chips.test.tsx`

- [ ] **Step 1: Branch**

```bash
git checkout -b feat/mm0-clickable-chips main
```

- [ ] **Step 2: Write the failing cases-page URL test**

Create `frontend/app/(dashboard)/cases/__tests__/page.urlfilters.test.tsx`. Copy the mocking pattern from `frontend/app/(dashboard)/compliance/__tests__/page.test.tsx` (stable `useApi` mock object — the comment there explains why; mock `@/components/global-filter-context`, `@/components/auth-provider` as ROLE_ADMIN, `@/components/run-status-provider`). Additionally mock `next/navigation` with a mutable params holder:

```tsx
const paramsHolder = { value: new URLSearchParams() };
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => paramsHolder.value,
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => "/cases",
}));
```

Core assertions (the `get` spy is the mocked `useApi().get`):

```tsx
it("reads measureId and outcome from the URL and sends them to /api/cases", async () => {
  paramsHolder.value = new URLSearchParams("measureId=cms125&outcome=OVERDUE");
  render(<CasesPage />);
  await waitFor(() => {
    const calls = get.mock.calls.map((c) => String(c[0]));
    const caseCall = calls.find((u) => u.startsWith("/api/cases?"));
    expect(caseCall).toContain("measureId=cms125");
    expect(caseCall).toContain("outcome=OVERDUE");
  });
});

it("ignores an unknown outcome value rather than sending it", async () => {
  paramsHolder.value = new URLSearchParams("outcome=NOT_A_STATUS");
  render(<CasesPage />);
  await waitFor(() => {
    const caseCall = get.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith("/api/cases?"));
    expect(caseCall).toBeDefined();
    expect(caseCall).not.toContain("outcome=");
  });
});
```

- [ ] **Step 3: Run it — must fail**

Run: `cd frontend && pnpm vitest run app/\(dashboard\)/cases/__tests__/page.urlfilters.test.tsx`
Expected: FAIL — the request URL lacks `measureId=cms125` (page ignores the param today).

- [ ] **Step 4: Implement URL read + write-back in the cases page**

In `frontend/app/(dashboard)/cases/page.tsx`: initialize `measureId` and `outcome` state from `searchParams` (beside the existing reads at :78-81), validating `outcome` against the known outcome statuses (reuse the keys of `OUTCOME_LABELS` from `@/lib/status`; invalid → unset). Add a normalizer beside `normalizeCaseStatusFilter`:

```tsx
const OUTCOME_FILTER_VALUES = new Set(Object.keys(OUTCOME_LABELS));
function normalizeOutcomeFilter(raw: string | null): string {
  return raw && OUTCOME_FILTER_VALUES.has(raw) ? raw : "";
}
```

Write-back: extend the existing `setStatusAndUrl` pattern (:259-268) so changing the measure or outcome `<Select>` also updates the URL (delete the param when cleared). Keep `priority`/`assignee`/`site` as local state — YAGNI; saved filters are MM-2.

- [ ] **Step 5: Run the test — must pass.** Same command as Step 3. Expected: PASS.

- [ ] **Step 6: Write the failing roster-page URL test**

Create `frontend/app/(dashboard)/compliance/__tests__/page.urlfilters.test.tsx` (same template; the existing roster fixtures in `compliance/__tests__/page.test.tsx` show the `Roster` payload shape — reuse a minimal one). Assert `?status=COMPLIANT&panel=wellness` in the URL yields a `/api/compliance/roster?…status=COMPLIANT…panel=wellness…` request.

- [ ] **Step 7: Run it — must fail.** (Page's `status`/`panel` are `useState` only today.)

- [ ] **Step 8: Implement URL read + write-back for `status` and `panel` on the roster page**, mirroring Step 4 (validate `status` against `COMPLIANCE_STATUS_LABELS` keys, `panel` against the panel ids in `frontend/features/compliance/types.ts:44-48`).

- [ ] **Step 9: Run it — must pass.**

- [ ] **Step 10: Write the failing chips test**

Create `frontend/app/(dashboard)/programs/__tests__/page.chips.test.tsx`. Mock `useApi` so `GET /api/programs/overview` returns one `ProgramSummary` (shape at `programs/page.tsx:26-41`) for `cms125` with non-zero counts. Assert:

```tsx
it("renders each actionable chip as a deep link into the pre-filtered cases list", async () => {
  render(<ProgramsPage />);
  const overdue = await screen.findByRole("link", { name: /overdue/i });
  expect(overdue).toHaveAttribute("href", "/cases?measureId=cms125&outcome=OVERDUE");
  expect(screen.getByRole("link", { name: /due soon/i })).toHaveAttribute(
    "href", "/cases?measureId=cms125&outcome=DUE_SOON");
  expect(screen.getByRole("link", { name: /missing data/i })).toHaveAttribute(
    "href", "/cases?measureId=cms125&outcome=MISSING_DATA");
});

it("links compliant and excluded chips to the status-filtered roster", async () => {
  render(<ProgramsPage />);
  expect(await screen.findByRole("link", { name: /compliant/i })).toHaveAttribute(
    "href", "/compliance?status=COMPLIANT");
  expect(screen.getByRole("link", { name: /excluded/i })).toHaveAttribute(
    "href", "/compliance?status=EXCLUDED");
});
```

- [ ] **Step 11: Run it — must fail** (chips are `<span>`s).

- [ ] **Step 12: Make the chips links**

In `frontend/app/(dashboard)/programs/page.tsx`: give `Badge` an optional `href`; when present render a Next `<Link>` with the existing chip classes **plus `relative z-10`** (required — the stretched card overlay at :256-260 otherwise swallows the click; the trend block at :277 shows the pattern). Add:

```tsx
function chipHref(measureId: string, bucket: "COMPLIANT" | "DUE_SOON" | "OVERDUE" | "MISSING_DATA" | "EXCLUDED"): string {
  if (bucket === "COMPLIANT" || bucket === "EXCLUDED") return `/compliance?status=${bucket}`;
  return `/cases?measureId=${encodeURIComponent(measureId)}&outcome=${bucket}`;
}
```

Wire the five chips at :269-275. A zero-count chip still links (an empty pre-filtered list is an honest answer).

- [ ] **Step 13: Run it — must pass.**

- [ ] **Step 14: Full frontend gate**

Run: `cd frontend && pnpm lint && pnpm test && pnpm build`
Expected: all green (36 existing test files + 3 new must pass; `onUnhandledRequest: "error"` will catch any fetch you forgot to mock).

- [ ] **Step 15: Commit + PR**

```bash
git add frontend/app/\(dashboard\)/cases frontend/app/\(dashboard\)/compliance frontend/app/\(dashboard\)/programs
git commit -m "feat(frontend): status chips deep-link to pre-filtered case/roster lists; case and roster filters become URL-backed"
```

PR body: what it fixes (the silently-dead `/cases?measureId=` link included), which URL params are now contract, screenshots optional. No attribution footer.

---

## Task 2: "Patient" terminology as deployment config

**Files:**
- Create: `frontend/lib/terminology.ts`
- Test (create): `frontend/lib/__tests__/terminology.test.ts`
- Modify (display-text sites from the 2026-08-30 inventory — every user-visible "employee" string): `frontend/app/(dashboard)/compliance/page.tsx` (:187, :277, :292, :306, :334), `frontend/app/(dashboard)/cases/page.tsx` (:391, :513, :754), `frontend/components/GlobalSearch.tsx` (:98, :104, :112, :114, :148), `frontend/app/(dashboard)/runs/page.tsx` (:480, :731, :735, :762, :770, :1019), `frontend/app/(dashboard)/admin/page.tsx` (:389, :1032, :1124, :1128, :1322), `frontend/features/segments/SegmentEditorModal.tsx` (:329, :331, :385), `frontend/app/(dashboard)/campaigns/page.tsx` (:570), `frontend/app/(dashboard)/programs/page.tsx` (:356), `frontend/app/(dashboard)/programs/[measureId]/page.tsx` (:299), `frontend/app/(dashboard)/cases/[id]/page.tsx` (:508), `frontend/app/(dashboard)/people/page.tsx` (:123), `frontend/app/(dashboard)/people/[personId]/page.tsx` (:283), `frontend/features/compliance/RosterMobileCards.tsx` (:27), `frontend/features/studio/components/ImpactPreviewPanel.tsx` (:95), `frontend/features/segments/SegmentsAdmin.tsx` (:123), `frontend/lib/status.ts` (:51 `SCOPE_LABELS.EMPLOYEE`)
- Modify: `frontend/Dockerfile` (add `NEXT_PUBLIC_SUBJECT_TERM` build arg beside the existing ones), `frontend/.env.local.example`

**Mechanism decision (locked here):** `NEXT_PUBLIC_SUBJECT_TERM` ∈ `employee` (default) | `patient`, baked at build like every other deployment setting this repo has (`NEXT_PUBLIC_APP_NAME` etc.). NOT the brand switcher — that is per-browser CSS. NOT i18next — declared but unused, and a 2-noun swap does not justify wiring an i18n runtime (YAGNI).

- [ ] **Step 1: Branch** — `git checkout -b feat/mm0-subject-terminology main`

- [ ] **Step 2: Write the failing terminology-module test**

`frontend/lib/__tests__/terminology.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadWith(term: string | undefined) {
  vi.resetModules();
  if (term === undefined) vi.stubEnv("NEXT_PUBLIC_SUBJECT_TERM", "");
  else vi.stubEnv("NEXT_PUBLIC_SUBJECT_TERM", term);
  return await import("@/lib/terminology");
}
afterEach(() => vi.unstubAllEnvs());

describe("terminology", () => {
  it("defaults to employee", async () => {
    const t = await loadWith(undefined);
    expect(t.SUBJECT.singular).toBe("employee");
    expect(t.SUBJECT.Plural).toBe("Employees");
  });
  it("switches every form to patient", async () => {
    const t = await loadWith("patient");
    expect(t.SUBJECT).toEqual({
      singular: "patient", plural: "patients", Singular: "Patient", Plural: "Patients",
    });
  });
  it("falls back to employee on an unknown value", async () => {
    const t = await loadWith("astronaut");
    expect(t.SUBJECT.singular).toBe("employee");
  });
});
```

- [ ] **Step 3: Run — must fail** (module does not exist): `cd frontend && pnpm vitest run lib/__tests__/terminology.test.ts`

- [ ] **Step 4: Implement `frontend/lib/terminology.ts`**

```ts
/** Deployment-level subject noun (ROADMAP_2026-08-30 MM-0): the Maui pilot says
 *  "patient", TWH says "employee". Build-time config like every NEXT_PUBLIC_* var;
 *  default is employee so every existing deployment is byte-identical. */
export type SubjectTerm = {
  singular: string; plural: string; Singular: string; Plural: string;
};
const TERMS: Record<"employee" | "patient", SubjectTerm> = {
  employee: { singular: "employee", plural: "employees", Singular: "Employee", Plural: "Employees" },
  patient: { singular: "patient", plural: "patients", Singular: "Patient", Plural: "Patients" },
};
const raw = process.env.NEXT_PUBLIC_SUBJECT_TERM;
export const SUBJECT: SubjectTerm = TERMS[raw === "patient" ? "patient" : "employee"];
```

- [ ] **Step 5: Run — must pass.**

- [ ] **Step 6: Write the failing integration test** (extend `frontend/app/(dashboard)/compliance/__tests__/page.test.tsx` with one case, or a new file using its template): with `NEXT_PUBLIC_SUBJECT_TERM=patient` stubbed and modules reset, the roster page's empty state reads "No patients match these filters." and the sticky first column header is "Patient". (Use `vi.stubEnv` + `vi.resetModules` + dynamic `import()` of the page inside the test, since the env is read at module load.)

- [ ] **Step 7: Run — must fail.**

- [ ] **Step 8: Sweep the display-text sites.** Replace each literal listed in **Files** above with the `SUBJECT` forms (e.g. `` `No ${SUBJECT.plural} match these filters.` ``, `<th>{SUBJECT.Singular}</th>`, `placeholder={`Search ${SUBJECT.plural}…`}`). Rules: (a) only user-visible display text — never field names (`employeeExternalId` stays), never route paths, never test fixtures; (b) `SCOPE_LABELS.EMPLOYEE` value becomes `SUBJECT.Singular` but the key stays `EMPLOYEE` (it mirrors the backend enum); (c) `SqlPreviewPanel.tsx:76-78` shows literal SQL over real table names `employees`/`employee_programs` — leave it, it is code display, not prose; (d) example placeholder text like "for example emp-041" keeps the id but swaps the noun.

- [ ] **Step 9: Run the integration test — must pass. Then the full gate:** `pnpm lint && pnpm test && pnpm build`. Also grep-verify the sweep found everything user-visible:

Run: `cd frontend && grep -rn "mployee" app components features lib --include="*.tsx" --include="*.ts" | grep -v -E "employeeExternalId|employeeId|employeeName|EMPLOYEE|/employees/|employee-|test|__tests__|\.test\." `
Expected: only non-display hits (comments, type/field names). Judge each survivor.

- [ ] **Step 10: Dockerfile + env example.** Add `ARG NEXT_PUBLIC_SUBJECT_TERM=employee` / `ENV NEXT_PUBLIC_SUBJECT_TERM=$NEXT_PUBLIC_SUBJECT_TERM` beside the existing args in `frontend/Dockerfile`; add the var with a comment to `frontend/.env.local.example`.

- [ ] **Step 11: Commit + PR** — `feat(frontend): subject terminology becomes deployment config (NEXT_PUBLIC_SUBJECT_TERM; Maui says patient, default stays employee)`. Note in the PR body: backend display strings (catalog descriptions, case next-action text) are a follow-up task, deliberately excluded to keep this diff reviewable.

---

## Task 3: The Maui synthetic tenant (primary-care-shaped roster)

A patient-flavored cohort so the pilot demo doesn't show forklift operators. Covers the **runnable** primary-care measures only (cms125 + the wellness panel: `diabetes_hba1c`, `hypertension`, `cholesterol_ldl`, `obesity_bmi`); CMS2/130/165/137 cohorts land with their MM-1 onboarding, so no dead data.

**Files:**
- Modify: `backend-ts/src/engine/synthetic/employee-catalog.ts` (`TENANTS` :43-47, `ENTERPRISES` :50-54, `PROVIDERS` :60-77, base arrays :83-253, concat :254)
- Test (create or extend): `backend-ts/src/engine/synthetic/employee-catalog.maui.test.ts`

- [ ] **Step 1: Branch** — `git checkout -b feat/mm0-maui-tenant main`

- [ ] **Step 2: Write the failing test**

`backend-ts/src/engine/synthetic/employee-catalog.maui.test.ts` (match the style of neighboring backend tests — plain `describe/it` per the repo's test runner):

```ts
import { describe, expect, it } from "vitest";
import { EMPLOYEES, TENANTS, employeesForTenant } from "./employee-catalog.ts";
import { seededDistribution } from "../../run/distribution.ts";

describe("maui synthetic tenant", () => {
  it("exists as a tenant with a primary-care cohort of at least 40", () => {
    expect(TENANTS.some((t) => t.id === "maui")).toBe(true);
    expect(employeesForTenant("maui").length).toBeGreaterThanOrEqual(40);
  });

  it("every maui subject carries an attributed provider (the future PCP field)", () => {
    for (const p of employeesForTenant("maui")) {
      expect(p.providerId, p.externalId).toBeTruthy();
      expect(p.dateOfBirth, p.externalId).toBeTruthy();
    }
  });

  it("yields every outcome bucket for each runnable primary-care measure", () => {
    const maui = employeesForTenant("maui");
    for (const rateKey of ["diabetes_hba1c", "hypertension", "cholesterol_ldl", "obesity_bmi", "cms125"]) {
      const d = seededDistribution(maui, rateKey);
      const targets = new Set(d.values());
      for (const bucket of ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"]) {
        expect(targets, `${rateKey} missing ${bucket}`).toContain(bucket);
      }
    }
  });

  it("does not disturb the existing twh/ihn cohorts", () => {
    expect(employeesForTenant("twh").length + employeesForTenant("ihn").length)
      .toBe(EMPLOYEES.length - employeesForTenant("maui").length);
  });
});
```

(If `seededDistribution` returns a different shape than a Map, read `backend-ts/src/run/distribution.ts:56-77` and adapt the assertion — the invariant under test is "all five buckets appear," not the container type.)

- [ ] **Step 3: Run — must fail:** `cd backend-ts && pnpm vitest run src/engine/synthetic/employee-catalog.maui.test.ts` (use the repo's actual test command — `pnpm test` filters, check `backend-ts/package.json` — expected failure: no `maui` tenant).

- [ ] **Step 4: Implement.** In `employee-catalog.ts`: add `{ id: "maui", name: "Maui Pilot Clinic" }` to `TENANTS` and a matching `ENTERPRISES` entry; add clinic sites (e.g. `"Wailuku Clinic"`, `"Kihei Clinic"`) with 4–6 providers to `PROVIDERS` (these are the attributed PCPs — ADR-010's model); add a `MAUI_BASE` array of ≥40 personas (`pat-001`…, plausible mixed names, `role` values that read as patient panels — use `"Patient"`, sites = the clinic locations, `tenantId: "maui"`, every entry with `dateOfBirth` spanning ages ~30–75 so cms125's 42–74 IPP and the wellness cohorts are populated); concatenate into `EMPLOYEE_BASE`. **Deterministic, hand-written, synthetic — no generation at import time, matching the existing arrays. No real-person names.**

- [ ] **Step 5: Run the new test — must pass.**

- [ ] **Step 6: Full backend gate:** `cd backend-ts && pnpm typecheck && pnpm test`
Expected: 0 fail. **Watch for:** tests that assert roster counts or distribution positions over `EMPLOYEES` as a whole (the seeded-distribution ordering is per-measure over the *given* employee list, and run-pipeline runs over all tenants) — any such failure is a real behavioral question, not a flake: bring it back to the orchestrator rather than adjusting the expectation.

- [ ] **Step 7: Commit + PR** — `feat(synthetic): add the maui primary-care tenant (patient personas, attributed providers, full bucket coverage on runnable measures)`.

---

## Task 4: MIPS↔CMS crosswalk surfaced in the UI

The pilot's quality team thinks in MIPS numbers; every place a pilot measure is named shows "MIPS nnn".

**Files:**
- Modify: `backend-ts/src/measure/measure-catalog.ts` (interface :31-42; entries for cms122, cms2, cms125, cms130, cms137, cms165)
- Modify: `backend-ts/src/program/program-read-models.ts` (`:255` overview projection)
- Test (create): `backend-ts/src/measure/measure-catalog.mips.test.ts`
- Modify: `frontend/app/(dashboard)/programs/page.tsx` (`:264` card subtitle), `frontend/app/(dashboard)/programs/[measureId]/page.tsx` (`:200-202` eyebrow), `frontend/app/(dashboard)/measures/page.tsx` (`:97` column defs)
- Test (extend): `frontend/app/(dashboard)/programs/__tests__/page.chips.test.tsx` (one added assertion)

- [ ] **Step 1: Branch** — `git checkout -b feat/mm0-mips-crosswalk main`

- [ ] **Step 2: Write the failing backend test**

`backend-ts/src/measure/measure-catalog.mips.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MEASURE_CATALOG } from "./measure-catalog.ts";

const EXPECTED: Record<string, string> = {
  cms122: "001", cms2: "134", cms165: "236", cms125: "112", cms130: "113", cms137: "305",
};

describe("MIPS quality-id crosswalk", () => {
  it("carries the correct MIPS id on every pilot measure", () => {
    for (const [id, mips] of Object.entries(EXPECTED)) {
      const m = MEASURE_CATALOG.find((m) => m.id === id);
      expect(m, id).toBeDefined();
      expect(m!.mipsId, id).toBe(mips);
    }
  });
  it("uses the three-digit MIPS format wherever the field is set", () => {
    for (const m of MEASURE_CATALOG) {
      if (m.mipsId !== undefined) expect(m.mipsId, m.id).toMatch(/^\d{3}$/);
    }
  });
});
```

- [ ] **Step 3: Run — must fail** (no `mipsId` field).

- [ ] **Step 4: Implement backend.** Add `mipsId?: string` to `CatalogMeasure` (with a doc comment: MIPS Quality ID — the number the pilot's ACO paperwork uses; source: public QPP measure specifications). Set it on the six entries above (cms137's catalog row exists as a Draft). Project it: in `program-read-models.ts:255` add `mipsId: m.mipsId` to the overview summary (and add the field to whatever response type declares that projection).

- [ ] **Step 5: Backend gate:** `cd backend-ts && pnpm typecheck && pnpm test` — the new test passes, nothing else moves.

- [ ] **Step 6: Write the failing frontend assertion** — in the Task-1 chips test file (fixture gains `mipsId: "112"`):

```tsx
it("shows the MIPS id beside the measure identity", async () => {
  render(<ProgramsPage />);
  expect(await screen.findByText(/MIPS 112/)).toBeInTheDocument();
});
```

- [ ] **Step 7: Run — must fail. Then implement frontend:** add `mipsId?: string` to the frontend `ProgramSummary` type (`programs/page.tsx:26-41`); render `{program.policyRef} • {program.mipsId ? `MIPS ${program.mipsId} • ` : ""}{program.version}` at `:264`; same conditional in the measure-detail eyebrow (`[measureId]/page.tsx:200-202` — the detail page's own summary type at `:81/:92` needs the field too); add a `MIPS` column to the measures grid (`measures/page.tsx:97` column defs — blank when unset).

- [ ] **Step 8: Run — must pass. Full frontend gate:** `pnpm lint && pnpm test && pnpm build`.

- [ ] **Step 9: Commit + PR** — `feat(measures): MIPS quality-id crosswalk on the catalog and every measure-identity surface`.

---

## Verification map (ROADMAP §5 MM-0 gate ↔ tasks)

| Roadmap gate | Where satisfied |
|---|---|
| deep-link tests (chip → filtered list, filter state pinned) | Task 1 Steps 2, 6, 10 |
| terminology-config test (no "employee" renders in patient mode) | Task 2 Steps 2, 6, 9 (grep audit) |
| backend tests for config surfaces added | Task 3 Step 2, Task 4 Step 2 |
| frontend lint+build green | every task's closing gate |
| idempotency/audit invariants on anything touched | no store/run mutation is touched by any task — asserted by each task's full backend suite run |

## Execution notes (orchestrator)

- One Luna (`gpt-5.6-luna`, `xhigh`) lane per task, sequential, each on its own `feat/*` branch from fresh `main`; Sol (`high`) cross-model review before each PR merge (Tier 2). Orchestrator runs the gates itself before opening each PR and never merges without owner review.
- Tasks 1 and 2 both touch `cases/page.tsx`, `compliance/page.tsx`, `programs/page.tsx` — run them **sequentially, rebasing the later branch on the merged earlier one**, never in parallel.
- Task 3 and Task 4 are independent of 1–2 and of each other; they may run while 1/2 await review, in worktrees if concurrent.
