# Architecture Decision Records

> **Two of the four ADR classes were moved out of this file on 2026-08-05.** Every record that is
> **superseded** (7) or that turned out to be a **historical finding written in ADR form** (7) now lives in
> [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md), with a dated one-line pointer left
> here so every `ADR-0NN` cross-reference in the codebase still resolves and nobody has to guess where a
> body went. **Nothing was deleted** — `git log -p docs/DECISIONS.md` and the archive both hold the full text.
>
> What remains here is the record that still governs: decisions that **constrain what may be done next**,
> and design records that **explain how a built thing works**. A map of all 58 with that classification is
> recorded in the `docs/JOURNAL.md` entry for 2026-08-05.
>
> **Six records were moved back on review (#396):** ADR-041, 042, 044, 045, 053 and 057 were first filed
> as findings, but each is cited as *current* behaviour by code or a runbook — six test names begin
> `"ADR-044:"`, `normalize.ts` states the ADR-042 mapping rule in its doc comments, `run-pipeline.ts`
> names ADR-057 in an operator-facing warning, and `DEPLOY.md` builds the vendoring runbook on ADR-041
> and ADR-053. They are **design records**, and design records stay here.
>
> **Sequence note:** ADR-033 does not exist — verified absent, and the number must not be reused.

## ADR-068: the OpenAPI document covers the PROMISED surface only, and a routed-path test is what makes hand-authoring defensible

**Status:** Accepted (2026-08-17). Closes the tracked TODO at the top of `docs/JOURNAL.md`.

**Context.** Doug asked whether WorkWell has a Swagger API. It did not: authenticated probes against
production and staging returned `501 not_implemented` from `/api/openapi.json`, `/api/swagger`,
`/swagger-ui` and `/api/docs`, while `ARCHITECTURE.md` §9 asserted *"The OpenAPI document
(`workwell.swagger.enabled=true`) advertises version `v1`"* — a springdoc property belonging to the Java
backend retired in #109 PR4. §7 did not mention `/api/v1/compliance` at all. So the repository was
simultaneously claiming a document it did not serve and omitting the one contract it does.

**Decision.**

1. **Serve a hand-authored OpenAPI 3.1.1 document at one canonical path**, `GET /api/v1/openapi.json`,
   built by `backend-ts/src/openapi/spec.ts`. PERMIT: reading a contract should not require credentials, and
   the document carries shapes and role names, not patient data.
2. **Scope is the PROMISED surface** — `/api/v1/compliance`, the three `/cds-services` operations, this
   document itself, health and version: **seven operations** — and the document *says so*. The ~40 internal
   `/api/**` routes are excluded because
   `COMPLIANCE_API.md` already draws that line ("everything else under `/api/` is internal and moves with
   the frontend"), and documenting them would advertise stability over paths that carry none.
3. **Hand-authored, guarded by a contract test.** The alternatives each cost a dependency or a rewrite: zod
   earns its keep only as a *runtime* validator, `@hono/zod-openapi` presupposes Hono and a router we do not
   have, and TypeSpec would add a second hand-maintained source of truth with no coupling to a hand-rolled
   dispatcher. The recognised risk of hand-authoring is drift and the recognised answer is a contract test,
   so the test is treated as the other half of this decision rather than as optional garnish.
4. **The guard is two-way coverage, and the second direction is bounded.** Every `(path, method, status)` the
   document declares is produced by a real request through the real worker — that direction is complete, and a
   documented path that is not routed fails with `documented but NOT ROUTED`. The reverse direction sees only
   statuses some probe produced, so a real status no test exercises is neither documented nor caught: a
   path-level `405`, a `500` on a DB outage, a `503` from `startupGuard`. Stating the bound rather than
   implying completeness (review). Mutation-checked three ways — deleting the route, removing a produced
   status, and requiring an absent property each fail the intended assertion.
5. **Redocly lints the document in CI**, pinned exactly, telemetry off, with **no ignore file**, because it
   catches a class the contract test cannot. It did so immediately: five uses of `nullable`, which OpenAPI
   3.1 removed in favour of type unions. The five remaining warnings are explained in `spec.ts` rather than
   silenced. **Stated precisely, because "pinned exactly" overstates it:** the *top-level* version is pinned,
   but `npx --yes` resolves that package's transitive tree fresh on each run with no lockfile, in a job that
   holds repository credentials. Elsewhere this repo pins by SHA-256 and gates on byte-reproducibility. The
   trade taken here is a non-reproducible dev tree in exchange for not adding a `package.json` dependency;
   if that becomes unacceptable, the alternative is a committed devDependency, not a different linter
   (review).
6. **3.1.1, not 3.2.** Renderer support for 3.2 is worse than absent, it is *silent* — Redoc 2.5.3 accepts a
   3.2 document by aliasing it to 3.1, so 3.2-only constructs are ignored rather than flagged, and Spectral
   caps at 3.1. 3.1's Schema Objects are literal JSON Schema 2020-12, which is what makes a zero-dependency
   response check tractable.
7. **The reference page is hand-rolled and public** (`frontend/app/api-docs`). Not only on the
   no-new-dependency rule: `swagger-ui-react` peers on `react@">=16.8 <19"` and this app is on React 19, so
   the React integration does not exist for us; Swagger UI's dark mode is a hard-coded `html.dark-mode` class
   that would contest ownership of `<html>`; and Scalar and Redoc both default to a CDN script the CSP and
   the offline demo rule out. The trade is no try-it-out console — a copyable `curl` instead.

**Consequences.** A 405 is **not representable** under a `get` operation, so the four unauthenticated GETs
keep an `operation-4xx-response` warning rather than mis-modelling their path-level 405 — the coverage test
refused the mis-modelling on the first attempt, which is the guard working. Adding a route to the promised
surface now means adding it to the document, because CI fails otherwise. Writing the document also exposed
a second stale ARCHITECTURE claim (§9 said `/api/version` returns `uptime`; it does not), corrected here.

---

## ADR-067: CDS Hooks cards render a completed evaluation and never trigger one — and the outcome-to-card mapping is ours, which is stated rather than implied

**Status:** Accepted (2026-08-17). Implements the 2026-08-14 decision that CDS Hooks is adopted as a
*specification* (ADR-008 stands; `cqf-fhir-cr` does not enter the runtime). Partially delivers proposal P1
(#458).

**Context.** WorkWell did not alert providers at all: verified by search, there was no CDS Hooks
implementation, no `PlanDefinition`, no `$apply`, and no hook fired anywhere — the alerts existed only on
WorkWell's own screens, which is the gap guide S7 describes. CDS Hooks is a JSON request/response contract
over HTTPS, so serving it requires no Java: two routes on the worker that already exists. Nicole's concern
was reinventing wheels, and adopting the community standard is the direct answer; adopting its *reference
implementation* at runtime would have replaced a working engine with a second one.

**Decision.**

1. **One service, `patient-view`.** In the separately versioned CDS Hooks Library IG (v1.0.1, 2025-03-12)
   it carries maturity 5; `encounter-start`, the other hook that fits an in-encounter check, is at maturity
   1 and would return the same cards from the same outcomes. A second hook is a discovery entry and a
   validation branch when a client asks for one.
2. **Cards render persisted outcomes of a FINALIZED run.** Never a preview, never a synthetic bundle. This
   is why no `501` twin of ADR-061's `preview_unavailable` is needed — the answer is truthful on any stack —
   and it answers P1's latency question by not incurring it. The cost, stated: a card is as fresh as the
   last run, not as fresh as this encounter.
3. **No `prefetch` is declared, because none is evaluated**, and `usageRequirements` — the spec's own field
   for telling a caller what it must know — says so in the machine-readable contract. `fhirServer`,
   `fhirAuthorization` and `prefetch` are accepted and ignored. Declaring a template we would ignore would
   make a client fetch and transmit data for nothing; *honouring* it means evaluating a caller-supplied
   bundle per request, which is a different capability and is where S7's step 2 would land.
4. **An absence is a CARD, not an empty list.** A patient with no finalized outcome — including one whose id
   did not resolve — gets one `info` card saying so. `{"cards": []}` at the point of care reads as "no
   gaps", the confusion ADR-061's 404 exists to prevent, and because a hook's `context.patientId` is a bare
   EHR id while WorkWell persists live subjects as `wc|<patientId>`, a namespace mismatch would otherwise be
   indistinguishable from a clean bill of health. Silence is reserved for a subject we *did* evaluate and
   found compliant. Not `412`, which means a failure to retrieve FHIR data.
5. **`critical` is never emitted, and is unrepresentable in the card type.** In CDS Hooks it means the user
   must not proceed; WorkWell is supplementary to WebChart (locked decision 1) and is not entitled to say
   that about someone else's encounter. `systemActions` is likewise never emitted — nothing WorkWell returns
   may change a chart without a human choosing it.
6. **A suggestion is offered only where the order code carries an APPROVED terminology mapping**, read from
   the store rather than the seed array so that approving a mapping unlocks it without a code change.
   `order-catalog.ts` describes its codes as "representative (demo, not billing-certified)", and a CDS
   suggestion is a one-click order into a certified EHR. **The consequence is deliberate: `cms122` and
   `cms125` get no suggestion**, because their CPT codes have no mapping at all — so the two
   officially-routed CMS measures carry information and a link. Getting them a suggestion is a terminology
   review, not a code change.
7. **The measure-outcome-to-card mapping is OURS.** HL7's blessed route is `PlanDefinition/$apply` →
   `RequestOrchestration` → cards; DEQM's `$care-gaps` stops at a `DetectedIssue`, and **no published mapping
   carries a care gap into a card**. We map `outcomes.evidence_json` directly, reusing the readers the roster
   and case detail already use, and `STANDARDS_CONFORMANCE.md` records that the gap-to-card leg is local.
8. **Discovery is public; invoke and feedback are not.** `/cds-services` matches no `/api/**` rule and
   `authorize` ends in permitAll for non-`/api` paths, so the two rules are mandatory rather than a
   refinement — asserted both as a unit call and end-to-end through the worker, and both assertions fail when
   either rule is removed. Invoke reuses the `/sse` and `/mcp/**` authority (`ROLE_MCP_CLIENT` /
   `CASE_MANAGER` / `ADMIN`) rather than inventing a role, since the user directory stays hardcoded.
9. **Authentication is WorkWell's bearer token, and the spec's JWT profile is a NAMED GAP.** CDS Hooks
   defines its own scheme — a JWT the *client* signs, verified against a JWKS, with `aud` equal to the
   invoked endpoint and an `iss`/`jku` allowlist — and it **SHALL NOT** be signed with a symmetric algorithm,
   so our HS256 token can never be a conformant CDS Hooks JWT. The profile is not built: `jku` fetching is
   SSRF-by-design, and a verifier whose allowlist nobody has populated is a control that reads as present
   and cannot fire. This becomes a precise question for MIE — *does WebChart act as a CDS Hooks client, and
   if so what are its `iss` and JWKS URL?*
10. **The feedback endpoint is built, with no schema change.** `card.uuid` and `suggestion.uuid` derive from
    `(runId, subjectId, measureId)`, so correlating feedback is a recomputation over the subject's own
    outcomes rather than a lookup in a table — and schema is the owner's alone. Deterministic ids also mean a
    client re-firing the hook for an unchanged run gets the same uuid, so repeat feedback does not fragment.
    The handler records the uuid verbatim and asserts nothing about what it referred to.

11. **A FAILED evaluation is reported as ours.** `PARTIAL_FAILURE` is terminal, so its rows are served, and a
    subject whose evaluation threw is persisted `MISSING_DATA` with an `evaluationError`
    (`DATA_MODEL_CONTRACTS.md` §5). `deriveCell` has no branch for that and falls through to "No record on
    file", after which `nextActionFor` says "Collect the missing documentation" — asserting a fact about the
    **patient** when the truth is that our engine threw. Tolerable on a dashboard; in someone else's chart it
    is the same confusion decision 4 exists to prevent. Such a row now gets a "could not be evaluated" card,
    `info`, with no suggested order (review).
12. **A suggested resource references the id the CLIENT sent.** `toServiceRequest` writes
    `Patient/<workwell subject id>`, which is right for `GET /api/orders/proposals` and wrong the moment the
    resource crosses into an EHR: on a live tenant that is `Patient/wc|4821`, which names nothing the client
    can resolve and is not a legal FHIR id. Re-pointed at the hook's `patientId` in the CDS layer only, so
    the existing orders surface is unchanged. Card identity still uses the internal id (Codex review).
13. **Feedback fails loudly, and is bounded.** Because the audit event is the only record, a failed write
    returns **503** with `recorded`/`of` rather than a `200` that tells the client never to retry — invoke
    stays best-effort, since its cards are correct regardless. And a request carries at most 100 entries with
    `userComment` capped at 8000 characters, because each entry is an append to the append-only ledger by a
    machine credential (review; both reviewers raised the first independently).

**Consequences.** WorkWell can now be pointed at by any conformant CDS client, which changes the joint-call
question from "should we do this?" to "does WebChart speak it?". The card-selection predicate
(`dispositionFor(...) === "OPEN"`) and the order-proposal predicate (`AT_RISK`) must stay the same set, or a
carded measure could claim a proposal created for a different one; a test now pins that equality, since
nothing in either file mentioned the other. `userComment` is the first path putting unstructured clinical
prose into `audit_events`, which reaches `GET /api/audit-events/export` — noted in
`PRODUCTION_READINESS_2026-07.md`. CORS is **not** relaxed: production keeps its
exact-origin allowlist, so a browser-based client's origin must be added deliberately — the spec requires CORS
support but explicitly declines to specify an allowlist rule. Nothing here is justified by certification: ONC's
(b)(11) DSI criterion does not name CDS Hooks.

---

## ADR-066: the documentation splits into a maintained guide and a dated archive — because a doc that explains and a doc that records rot at different speeds

**Status:** Accepted (2026-08-10). Implements the owner directive to trim the documentation and
maintain one clear explanation of the whole system.

**Context.** `docs/` had grown to 255 files / 34.9 MB. Only ~14 of 47 top-level markdown files were
live reference; 12 were explicitly superseded (three roadmaps carrying "do not act on this"
banners), and 28 were referenced by nothing. The best explanatory document — the 2026-08-08 system
walkthrough — was a dated monolith that was never even committed. Meanwhile only 3 files in the
whole repo contained a mermaid diagram, and `ARCHITECTURE.md` (95 KB, zero diagrams) still carried
a Java-era `com.workwell.*` heading. Explanation was scattered across records, and records were
posing as explanation.

**Decision 1 — `docs/guide/` is the maintained explanatory layer.** Ten chapters, one per topic
(big picture, CQL/authoring, compiler/ELM, engine/routing, FHIR, data/databases, SQL, packages,
state/roadmap), each with at least one mermaid diagram, written from the walkthrough, with four
gaps filled fresh: the YAML→`generateCql` authoring mechanics, an ELM node reference with real
JSON, a FHIR primer, and the SQLite-floor/Pg-ceiling store design. The Definition of Done now
includes updating the affected chapter in the same PR.

**Decision 2 — volatile numbers live in exactly one chapter.** Test counts, gate counts and routing
state rot fastest, so chapter 9 owns them, each with its measurement date and reproducing command.
The other chapters cite mechanisms, which are stable.

**Decision 3 — dated, superseded and finished work moves to `docs/archive/`, never deleted.**
23 top-level files (the three superseded roadmaps, the Java-era `CQF_FHIR_CR_REFERENCE.md`, five
demo docs, the May-era walkthrough, dated research/QA snapshots, both source PDFs) plus five whole
directories (`sprints/`, `superpowers/{plans,specs}`, `new instructions/`, `FABLE_REVIEW`,
`mieweb-ui-migration/`). `OFFICIAL_TESTCASE_REPORT_2026-07.md` moved to `docs/evidence/` instead —
it is regenerated by CI, so the test and workflow paths that read and write it moved with it in the
same change. Live cross-references were updated in place; historical records (`JOURNAL.md`, ADR
bodies, `CHANGELOG.md`) keep their original wording, because a record quoting the path that was
true at the time is correct.

**Decision 4 — `CQF_FHIR_CR_REFERENCE.md` leaves the always-loaded set.** It pinned Java Maven
coordinates for a backend retired in #109 PR4; its stop condition ("a library version doesn't match
what it says works") died with the JVM, and carrying it in every session's context contradicted the
list's own rule that each entry must be load-bearing.

**Consequences.** Top-level `docs/` drops from 47 markdown files to 20 tracked, all live. A reader
sent to `docs/` now finds the guide first. The cost is accepted churn in cross-references (updated
and link-checked in the restructure PR) and one more standing obligation: guide chapters are part
of every PR's documentation duty, which is the point.

## ADR-065: an authored regulatory measure is verified by traceability and adversarial cases — because no external oracle exists, and none can be manufactured

**Status:** Accepted (2026-08-07). Roadmap M-E1, first content. Traceability:
`docs/measures/OSHA_1910_95_STS.md`. Answers the question filed as #405.

**Context.** Locked decision 6 makes occupational content the differentiator — "the measures nobody
publishes". That is now evidenced rather than assumed: the 2026 CMS eligible-clinician eCQMs (49), the
hospital eCQMs (17), HEDIS MY2026 (93), every public `.cql` file on GitHub, the entire `cqframework`
organisation and the complete HL7 FHIR IG registry contain **zero** occupational-health quality
measures. The field has *indicators* — CSTE/NIOSH count events across a state workforce from discharge
and workers-comp data — and no *measures*: what should happen to a named worker by a named date.

Every previous milestone had an external oracle. M-A had the measure stewards' own MADiE expected
results (410/410). M-C had `cqframework/cql-tests`. M-B had the HL7 schematron. **OSHA publishes
regulations, not computable artifacts**, so M-E1 has none and cannot acquire one.

**Decision 1 — the author of the CQL is the author of the test cases, and that is the normal state for
an undefined measure rather than a compromise.** Measures with no official definition do not go
through the measure-authoring or certification pipeline at all; the value of expressing them in CQL is
that CQL is standardised, not that someone else has graded them. What converts author-owned content
into *credible* content is the community route — publishing the measure and its cases in the standard
shape, with the documentation that lets an organisation act as steward and put it through the
acceptance process. So the deliverable is not "a measure that passes an external check"; it is **a
measure packaged so it could be stewarded**.

**Decision 2 — scope is ONE obligation.** 1910.95 creates several: baseline timing `(g)(5)(i)`, annual
testing `(g)(6)`, STS detection `(g)(10)(i)`, 21-day notification `(g)(8)(i)`, protector refitting
`(g)(8)(ii)(A)-(B)`, referral `(g)(8)(ii)(C)`. Each has a different trigger, deadline and evidence. A
single "hearing conservation compliance" percentage would hide partial failure — a programme could
refit every worker and notify none and still score well. This measure implements **STS detection**,
the one fully computable from clinical data, and the traceability document lists the others as
explicitly not implemented with the reason for each. **A traceability table that lists only what was
built is how a measure ends up a coherent implementation of the wrong legal object.**

**Decision 3 — where the regulation is discretionary, refuse rather than default silently.** Age
correction is optional under `(g)(10)(ii)`, Appendix F is informational only, and OSHA has since
permitted tables derived from other datasets — so **two employers can lawfully reach opposite
conclusions on identical audiograms**, and STS is not a pure function of the audiogram but of the
audiogram *and employer policy*. This measure applies **no** age correction, which detects more
workers and is the protective direction, and says so where a reader will see it. Silently applying
Appendix F would present one employer's lawful policy choice as an objective finding. Correspondingly,
incomplete data yields `MISSING_DATA` rather than a conclusion: a shift computed from two of the three
named frequencies is not the regulation's shift.

**Decision 4 — determinability is ASYMMETRIC.** A positive STS is definitive from one ear; a negative
finding requires both ears complete, because concluding "no shift" while an ear is unmeasured asserts
something about data nobody has. The first implementation used OR across ears and returned COMPLIANT
for a worker with an incomplete right ear and a clean left one. **An adversarial test caught it**, and
that bug is the shape that makes a compliance product dangerous: it improves the apparent rate by
absorbing the people whose data is incomplete. A second adversarial test caught a missing
initial-population gate that reported OVERDUE for a worker with no noise exposure at all.

**Decision 5 — real terminology, with the one exception named.** The thresholds are LOINC codes from
panel **89015-2**, all members of `us-core-clinical-test-codes` — so an audiogram already has a
US-Core-conformant representation and no data shape had to be invented. The cohort is the exception
and cannot be otherwise: `(c)(1)`'s trigger is an 8-hour TWA at or above 85 dBA, an industrial-hygiene
measurement absent from every clinical feed. ICD-10-CM **Z57.0** is used as a documented proxy, with
employer assertion accepted as an alternative. Structurally the same gap as ADR-042's `us-core-sex`
problem: clinical data present, eligibility attribute absent.

**Decision 6 — it is NOT in the measure registry.** Registering it would place it in
`RUNNABLE_MEASURE_IDS` and therefore in every population run, where the synthetic corpus cannot
produce what it reads — two dated audiograms carrying six LOINC threshold observations each. The
rule-params bindings that generate every other measure's corpus data describe a recency window
(enrolment + waiver + one event) and cannot express that shape; **this is the first authored measure
the codegen template cannot generate.** It is verified through the engine's own consumer path,
`evaluate({ elm, metaOverride })` — the same surface an external integrator uses for content we do not
ship. Wiring it into the roster with data that cannot exercise it would report MISSING_DATA for the
whole population and look integrated while proving nothing.

**What this verification does and does not establish.** The suite establishes that the measure
computes **what we read the CFR to require**, not that our reading is right — a weaker evidentiary
position than CMS122/125 enjoy, stated in `STANDARDS_CONFORMANCE.md` in those words so the M-A/M-B
language does not carry over by association. What is made rigorous is the *choice* of cases: boundary
cases at the regulation's own numbers (9.99 negative, 10.0 positive) and adversarially
wrong-by-construction cases, two of which found real bugs.

**Review found four more defects after the ADR was first written, and they are recorded because three
of them are the under-detection this ADR claims the measure never commits.** (1) Baseline and current
dates were derived from **both ears combined**, so an unrelated right-ear-only recheck moved the shared
current date, nulled the left ear's average and made a **confirmed left-ear shift vanish** — dates are
now per ear. (2) The `(g)(8)(ii)` exclusion was **permanent**: a worker excused once had every later
shift suppressed; it is now bound to the current shift by `recordedDate`, and an undated determination
does not exclude. (3) Non-final Observations could anchor the baseline, which is the *earliest* record
— a `final | amended | corrected` gate now applies. (4) `Numerator` was not conjoined with
`Denominator`, so it was true outside the initial population; latent in the app under ADR-031, but not
latent for the IG publication this ADR describes, where a consumer computes `group.population[].count`
straight from these defines. Duplicate thresholds now **refuse** rather than resolving by bundle order,
and a threshold in an unexpected unit is refused rather than coerced.

**Three documentation corrections**, on a document whose entire value is traceability: the
`(g)(8)(ii)` chapeau says "Unless a **physician** determines", not "physician or audiologist";
`(g)(9)`'s **per-ear** baseline revision is an OSHA interpretation, not CFR text; and the LOINC codes
do **not** encode conduction method — the bone-conduction panel shares the same 22 members, so a bare
Observation is ambiguous and the measure cannot currently tell air from bone. That last one is now a
stated limitation rather than an unnoticed gap.

**Named and not done: independent re-derivation.** The strongest available verification is a second
author building a decision table from the CFR without seeing this CQL and comparing — disagreement
would identify an unresolved specification question rather than a coding error.

**Consequences.** Suite 1932, 0 fail (+11). `compile-measures` emits 17 libraries. Follow-up, in
order: corpus generation so the measure can join the roster; independent re-derivation; then the
remaining 1910.95 obligations as separate measures. The `1904.10` recordability rule is flagged in the
traceability doc for whoever extends this — it needs an STS **and** a 25 dB total level, with age
correction permitted for the first test and forbidden for the second.

## ADR-064: one UCUM validator, shared by every translator we run — and an honest table rather than a new dependency

**Status:** Accepted (2026-08-05). Closes #397, the follow-up ADR-060 named and deliberately did not bundle.

**Context.** `LibraryManager(modelManager, options, cache, lazyUcumService, …)` takes the UCUM service as
its **fourth** argument and defaults to one that *throws* `No default UCUM service available`. Every
translator we build passed three arguments. So no CQL containing a quantity literal — `5 'mg'`, `1.0'cm'`,
any `Quantity` comparison — could be translated at all.

The user-visible surface was the Studio's **ELM Explorer**, which recompiles as the author types: valid
unit-bearing CQL produced an error naming a missing service rather than anything about their code.

**What makes this worth an ADR is how it hid.** It was invisible to the entire test suite and to
`pnpm compile-measures` alike, because **no committed measure uses a unit**. Every gate was green and the
feature was broken. It surfaced only when the V7 conformance harness ran CQL somebody else wrote, where it
produced **155 of 183 apparent translation errors** — and was very nearly published as "the JS translator
delta" (ADR-060). A defect that only third-party content can reach is an argument for running third-party
content, which is the standing case for the conformance suite.

**Decision 1 — one validator, in `src/measure/ucum.ts`, used by all three call sites.** The runtime
translator, `scripts/compile-measures.mjs` and the conformance harness now share it. They must agree: a
measure that compiles at build time and fails in the authoring UI — or the reverse — is a defect whose
cause is invisible from either side. It moved out of `scripts/` because it is production code now.

Consequence: `compile-measures` runs under `node --import tsx` (it imports a `.ts` module), following
`gen-cql`'s precedent. Bare `node scripts/compile-measures.mjs` now fails, and the script header says so.

**Decision 2 — it does not live in `@workwell/measure-engine`.** UCUM validation is a *translation-time*
concern and the engine executes pre-compiled ELM; it never translates. Putting it there would add surface
to a package whose whole claim is a two-dependency manifest, for a consumer that cannot use it.

**Decision 3 — an honest grammar-plus-table, not a UCUM dependency, and it errs toward rejection.** A
complete UCUM implementation is a new dependency, which CLAUDE.md makes an owner call. The table validates
UCUM grammar plus a list of atoms and prefixes and **refuses an unrecognized atom rather than waving it
through**. Now that this gates authoring, the direction of the error matters and this is the safe one:
rejecting a legitimate unit is a visible complaint an author reports, while accepting a malformed one lets
bad CQL through the gate and surfaces later as a wrong number. The remedy for a false rejection is adding
the atom with the case that needed it. Limits are written in the module rather than implied.

**Decision 4 — the previous behaviour stays reachable as `NO_UCUM_SERVICE`.** Not for production, which
never passes it, but so the fix can be watched failing: the regression test asserts the same library
compiles under the default and **fails** under it. A fix nobody can watch fail is a fix nobody can verify,
and this codebase has now caught three guards that could not fire.

**What review changed, and one place it was wrong.** The first cut's table was a flat `ATOMS` set split
on `.` and `/` by regex, and code review found three defects in it — two of which are the two directions
this ADR claims to weigh, so they are recorded rather than quietly patched:

1. **A false REJECTION: grouped denominators.** `mg/(kg.d)` — an ordinary dose rate — split into
   `["mg", "(kg", "d)"]` and was refused. Parenthesised subterms are now parsed recursively. The same
   rewrite fixed a case review did not report: a **leading solidus** (`/min`, `/uL`) was refused, and it
   is UCUM's `<main-term> ::= "/" <term> | <term>`.
2. **A false ACCEPTANCE: prefixes on non-metric atoms.** `m[lb_av]` validated because `m` is a prefix and
   `[lb_av]` an atom — but UCUM permits prefixes on **metric** units only, and there is no millipound.
   The table is now split into `METRIC_ATOMS` and `NON_METRIC_ATOMS`. Time units above the second are the
   same trap: `s` is metric, `min`/`h`/`d`/`wk`/`mo`/`a` are not. `mmHg` was also removed — it is not a
   UCUM symbol; `mm[Hg]` is milli + the metric atom `m[Hg]`.
3. **A false ACCEPTANCE: internal whitespace.** Per-component `trim()` accepted `mg / dL`. UCUM codes
   contain no whitespace; trimming the outside is our hygiene, whitespace inside is the author's error.

**Rejected, with the grammar as the reason:** the same review held that an ungrouped expression permits
only one division operator, making `mg/kg/d` invalid. It does not — `<term>` is left-recursive
(`<term> ::= <term> "." <component> | <term> "/" <component> | <component>`), so `mg/kg/d` parses as
`(mg/kg)/d`. "Fixing" it would have introduced a fourth false rejection. It is pinned as a test so nobody
re-derives the wrong conclusion.

Writing the tests for (1) then caught a defect of my own: applying the leading-solidus allowance inside
`validTerm` rather than at the main term accepted the empty group `mg/()`.

**Verification.** `pnpm compile-measures` output is **byte-identical** — 16 measures + FHIRHelpers, not one
file moved — so no committed measure's ELM changed. The conformance suite is unchanged (1622 pass, 213
known non-passing, no regressions). A unit-free library compiles to identical ELM with and without the
service, which is what licenses calling this change inert for everything already in the tree.

**What this does NOT do.** It does not make any existing measure use units, and it does not claim complete
UCUM conformance. It removes a wall an author would hit on their first unit-bearing measure.

## ADR-063: a package is publishable when its tarball runs outside the workspace — not when it is published

**Status:** Accepted (2026-08-05). Roadmap M-C / C4. **Completes M-C.** Positioning + semver policy:
`docs/PACKAGES.md`.

**Context.** C1 made `@workwell/measure-engine` content-free (ADR-059) and C2 split codegen out and added
a consumer that shares no code with the app (ADR-062). Both proofs are about the *source tree*: an
import-graph assertion and a `workspace:*` consumer. `example-consumer`'s own README says so — it is a
consumer outside the **app**, not outside the **repo**.

Everything the workspace supplies for free is therefore untested. The workspace resolves these packages
straight from `src/*.ts` under `moduleResolution: Bundler` with `allowImportingTsExtensions`; no registry
consumer has either. Whether `files` ships what the code needs, whether the declared `dependencies` are
sufficient, whether the emitted JavaScript resolves at all — each fails silently in-repo and loudly for
the first integrator.

**Decision 1 — the packages build to `dist/`, and the workspace keeps resolving source.** `publishConfig`
repoints `exports`/`types`/`main` at `dist/` **at pack time only**. In the tree, `exports` still names
`src/index.ts`, so `pnpm typecheck` checks real sources rather than stale build output and a change is
visible to the app without a build step. The alternative — pointing `exports` at `dist/` permanently —
makes a fresh clone fail to typecheck until someone runs a build, and makes it possible to ship code that
no longer matches its own source.

Note this fixes the package manager: `publishConfig` field rewriting is a **pnpm** feature. npm's
`publishConfig` understands only `registry`, `access` and `tag`, so `npm pack` here would ship a manifest
still pointing at `src/*.ts`.

**Decision 2 — the verification is packing and consuming, not publishing.** `scripts/verify-publish.mjs`
packs real tarballs, installs them into a temp directory under the OS temp dir with a plain `npm install`
and no knowledge of this repo, then runs the engine there on `example-consumer`'s measure content and
typechecks a TypeScript consumer against the packed declarations. It is CI's `packages` job, **on every
PR** — a manifest regression should fail when it is introduced, not when someone finally dispatches the
publish workflow.

Reusing `example-consumer`'s content rather than inventing a second toy measure keeps both proofs about
the same artifact.

**Decision 3 — nothing is published, and the workflow says why.** `publish-packages.yml` is
`workflow_dispatch` only, defaults to a dry run, and refuses without `NPM_TOKEN`. Publishing is
irreversible in a way nothing else here is: npm permits unpublish only within 72 hours and never permits
reusing a version, so a mistake cannot be fixed by a revert the way a bad deploy can. It also *cannot*
succeed today — the `@workwell` scope does not exist and the secret is unset — and `docs/PACKAGES.md`
states that rather than glossing it, because "published" is a claim with a trivial external check. This
follows ADR-041's pattern: inert until the owner creates the secret, with the owner steps written down.

**Decision 4 — `official-executor` is not published.** It is the sole home of `fqm-execution` and the
package boundary *is* the ADR-026 quarantine. Publishing it would advertise, as a `@workwell` product,
precisely the dependency the engine package's manifest exists to exclude.

**Decision 5 — the positioning is "composes `fqm-execution`, does not compete with it", and WorkWell's
own routing is the evidence.** `fqm-execution` calculates a published FHIR Measure **bundle** end to end;
this engine executes compiled **ELM** and returns per-define evidence. Both sit on `cql-execution`. The
claim is credible because we made the choice against our own package: official CMS eCQMs route through
`fqm-execution` on the production stack (ADR-045/046), because Nicole's *run the official published CQL,
never reauthor* is a standing rule. **No performance or conformance comparison against `fqm-execution`
has been run, so none is claimed** — `docs/PACKAGES.md` says that in those words.

**Decision 6 — pre-1.0 with a stricter-than-semver reading**, and 1.0 gated on a consumer outside MIE
rather than on a date. `0.x` under plain semver promises nothing, which is too vague to hold anyone to;
the operating rule is that removals, retypes and semantic changes take the **minor**, so a patch never
breaks you. Integrators are told to pin `~0.1.0`.

**A claim of mine that measurement killed, recorded because the reasoning was plausible and wrong.**
`rewriteRelativeImportExtensions` rewrites `./x.ts` → `./x.js` in emitted JS but **not** in emitted
`.d.ts`. I built a post-pass for it and wrote that the TypeScript consumer check (step 5) was what caught
the failure. Mutation-checking that — disabling the rewrite — showed **step 5 still passes**: `tsc`
substitutes `.ts` → `.d.ts` when resolving and finds the declaration beside it, so TypeScript consumers
were never broken. The post-pass is kept (a dangling `.ts` specifier is false on its face and only works
by a TypeScript-specific rule that non-`tsc` declaration readers do not implement), but it is documented
as defensive rather than as a bug fix, and the load-bearing assertion is the one covering **`.js`**, where
dropping the flag would break every consumer at runtime. This is the same guard-scope shape as #380 and
#400: a check cited for more than it covers.

**Consequences.** M-C is complete. `pnpm build:packages` and `pnpm verify:publish` are the two new
commands; `verify:publish` needs the network and is a separate CI job for the reason `official-cases` and
`cql-conformance` are. First publish is an owner step, listed in the workflow header. Scope stays neutral
`@workwell/*`; `@mieweb/*` remains a pitch for later, which is cheap precisely because there are no
external consumers yet.

**Amendment (2026-08-06) — the scope is `@work-well/*`. The body above is left as written**, because it
records what was decided on 2026-08-05 and a dated record that quietly changes its own wording is worth
less than one that says why it moved.

`@workwell` was never obtainable: an unrelated **unscoped** package named `workwell` already exists on
npm, and npm refuses an **org** name that collides with an existing **package** name. Hyphen rather than
underscore because npm scopes conventionally use hyphens and `@work_well` reads as a typo in an install
command. **The decision is unchanged** — a neutral scope rather than `@mieweb/*`.

**The check that missed this looked thorough, which is the part worth keeping.** Before choosing the name
I verified `@workwell/measure-engine` (404), the `scope:workwell` registry search (empty) and
`registry.npmjs.org/-/org/workwell` (404), and called the scope unclaimed. All three were true and **none
of them is the gate** — `registry.npmjs.org/workwell` returns **200**. It could only fail at org-creation
time in a browser, which is nowhere a test reaches. Same shape as this ADR's other finding: a check cited
for more than it covers.

**Three misses in the rename itself, each caught by a different mechanism, all the same shape.** A guard
caught the first — `fqm-isolation.test.ts` writes the specifier as an escaped regex
(`@workwell\/official-executor`), so a search for `@workwell/` skipped it and test 5/5, the ADR-026
quarantine door, **failed with an empty importer list** rather than passing vacuously. Review caught the
second, bare `@workwell` with no trailing slash in `publish-packages.yml`'s owner steps and three places
in `CLAUDE.md`. Review caught the third and worst: the mechanical replace rewrote **every dated record** —
this ADR's body, `DECISIONS_ARCHIVE.md`, both roadmaps and the JOURNAL back to 2026-07-24 — after I had
deliberately not done that to `LOCKED_DECISIONS.md`. All are restored; `LOCKED_DECISIONS.md` §4.5 and this
amendment carry the change instead.

**Prerequisites are now done and nothing is published.** The `work-well` org exists and `NPM_TOKEN` is
set, so `publish-packages.yml` can succeed for the first time; the dry run remains the first step. Note
the dry run **does not exercise the token** — it stops before the publish step — so a token whose scope
selection misses `@work-well` passes it and fails the real run. That is a deliberate trade, not a gap.

## ADR-062: codegen is not the engine, and a consumer that shares no code with the app is the only proof the split worked

**Status:** Accepted (2026-08-05). Roadmap M-C / C2. Completes what ADR-059 started; C4 (publish) remains.

**Context.** ADR-059 made `@workwell/measure-engine` content-free and proved it with a boundary test over
the import graph. Two things were still missing before the packaging claim is real: the package carried
something that is not evaluation, and nothing demonstrated that a consumer *without* WorkWell's content
could actually use it. An import-graph assertion proves the source tree's shape; it does not prove the
package works.

**Decision 1 — `generate-cql.ts` moves to `@workwell/measure-codegen`, with zero dependencies.** The
engine answers "is this patient compliant?" from compiled ELM; codegen answers "what CQL expresses this
rule?". They shared a directory, not code — **`generate-cql.ts` has zero imports** — so the split costs
nothing and states something true: codegen is authoring-time, the engine is runtime. A consumer
evaluating measures should not have to take a CQL emitter; a browser-side rule builder should not have to
take a CQL runtime. Being dependency-free, the new package can run in one.

`src/engine/`'s allowlist gains the new specifier, with the reason: `cql/codegen/generate-sql.ts`
validates a rule with it before templating SQL. It emits text; it never evaluates. Adding it was forced
by the boundary guard rather than anticipated — the guard failed the moment the import appeared, which is
the guard working.

**Decision 2 — `@workwell/example-consumer` exists, and it is a test, not a sample.** It declares one
dependency, ships its own measure (`tetanus-booster.cql` plus the ELM compiled from it, neither referenced
by the app), builds its own FHIR bundle, and evaluates — asserting all three of its own outcomes and that
`audiogram` is **unknown** to it. If the engine ever re-acquires WorkWell's catalog, this stops evaluating.
That is a stronger signal than the import-graph assertion because it exercises the path a real integrator
takes.

**It found an API fact no document stated:** `CqlExecutionEngine`'s constructor loads `FHIRHelpers-4.0.1`
eagerly, so **every** consumer must supply it in `elmLibraries` or construction throws. Discovered by
writing the consumer, not by reading the API, and now pinned as its own test — which is the argument for
building this at all rather than asserting consumability in prose.

**The limitation is stated rather than glossed.** It resolves the engine through `workspace:*`, so it is a
consumer **outside the app**, not outside the repo. Whether the published tarball contains what a consumer
needs is a different question and belongs to C4. Calling this "an external consumer" without that caveat
would be exactly the overclaim this codebase keeps catching in its own docs.

**A defect the move caused, and the detection gap behind it (Codex, #400).** `scripts/gen-cql.mjs` still
imported `generateCql` from `@workwell/measure-engine`, so `pnpm gen-cql` would have thrown on a missing
export. The repoint codemod walked `.ts` only — and more importantly **nothing in CI could have caught it**:
`tsc` does not typecheck `.mjs`, and `measure-engine-api.test.ts`, whose whole job is verifying that every
imported name is actually exported, walked `.ts` under `src/` only. An API check that inspects only the
files the compiler already checks is checking the wrong half. It now walks `scripts/` as well and includes
`.mjs`/`.js`, with a non-degeneracy assertion that at least one `.mjs` was seen.

**Consequences.** Three packages in the workspace: `measure-engine` (2 deps), `measure-codegen` (0), and
`example-consumer` (1, unpublished). The engine's `index.ts` no longer exports codegen — a breaking change
to a `private: true` package, taken now rather than after C4 makes it a promise. Suite 1885 → 1890.

## ADR-061: the compliance API says where its numbers came from, and 404s rather than answering an absence

**Status:** Accepted (2026-08-05). Roadmap M-C / C3, locked decision #5 — *"the versioned compliance API is
the contract MIE consumes."* Consumes ADR-031/ADR-046's evidence readers; adds no new one.

**Context.** Three surfaces nearly answer *"is this patient compliant for this measure?"* and none is a
contract: the roster grid is a UI read model shaped by the frontend, MCP's `check_compliance` is
Claude-facing and role-gated to CM/ADMIN, and a run answers for a population and writes records. C1 made
the engine constructible without WorkWell's content and V7 made it defensible; this is the first piece
that makes it **consumable**.

**Decision 1 — `/api/v1/` in the path, and exactly one route under it.** Everything else under `/api/` is
an internal contract that moves with the frontend. `v1` is a promise — fields are never removed or
retyped — so the existing surface is *not* renamed into a guarantee nobody has audited. A path segment
beats a header or media type here for an unglamorous reason: an integrator evaluating us pastes a URL into
a browser, and it is greppable in a log.

**Decision 2 — the response carries `populationsSource`, and this is the honesty-critical field.** The
owner chose an eCQM-native shape: population membership booleans rather than a bare status. But for a
WorkWell-**authored** measure only `initialPopulation` is measured — the other four are *inferred from
`OutcomeStatus`*. The numbers alone cannot distinguish that from an official artifact's own population
vector, and a consumer treating the second as measured eCQM membership would be wrong with nothing in the
response to warn them. `populationsSource` is read off the **same field** `membershipFor` branches on, so
the label cannot disagree with the numbers it describes.

**Decision 3 — `latest` with nothing persisted is a 404, never an empty 200.** *"No run has covered this
subject"* and *"this subject is compliant"* must not be confusable. The 404 body says which absence it is
and points at `preview`. This is the single easiest way to make a compliance API dangerous, and it is
worth spending an error code on.

**Decision 4 — `preview` routes through `routedEngineForEnv`, and REFUSES on a live stack.** Same engine
as a run: previewing cms125 against authored logic where production runs CMS's artifact would answer a
different question — a confidently wrong answer. **The first draft of this decision also claimed "preview
and a run see identical input", and review proved that false on exactly the stack the API exists to
serve** (#399): the run pipeline's `bundleFor` uses the patient's real `liveBundle` when WebChart is
configured, while preview composed a bundle from `seededTargetFor` + `buildSyntheticBundle` — which picks
the intended outcome from a hash of the subject id and manufactures data to produce it. That is
deterministic demo playback, and reporting it as an evaluation through the contract MIE consumes is the
worst thing this route could do. Preview now returns **501 on a WebChart-configured deployment**, naming
the reason. A live composition path is a different design with different failure modes and belongs in its
own change; refusing is a limitation, answering would have been a lie.

**Decision 6 — every answered request writes a `COMPLIANCE_API_READ` audit event, 404s included.** MCP
records one for every tool call with its sensitivity label, and `check_compliance` is this same question
over this same data. Without it there would be no record that anyone read a patient's compliance status
through a public contract — a larger gap than the role matrix. Best-effort at the response boundary: an
audit failure logs loudly rather than turning a correct read into a 500.

**Decision 7 — `period` is the ANSWER's measurement window; `filter` echoes the caller's bounds.** The
first cut returned the request filter as `period`, undocumented, directly above
`provenance.evaluationPeriod`. In a contract where a field may never change meaning, that had to be fixed
before merge rather than after.

**Decision 5 — no new evidence reader.** `membershipFor` and `officialReportIdentity`
(`src/fhir/measure-report.ts`) are the same functions the MeasureReport and QRDA III exporters use. Two
readers of `evidence_json` that can disagree is the defect class ADR-031 exists to prevent, and a new API
is exactly where a second one gets written by accident. A test asserts the API's population block agrees
with `buildIndividualMeasureReport`'s output **for the same record**, against the exporter's real output
rather than a hand-written expectation.

**Three review findings, all P2, all fixed — and one of them is the field's own failure mode (#399).**

1. **`populationsSource` could lie.** It tested whether `evidence.official.populationResults` was
   *present*; `membershipFor` branches on whether `officialMembership` can *parse* it, and a malformed
   vector falls back to status-derived booleans. The label would have read `official-evidence` over
   inferred numbers — precisely the misleading signal the field exists to prevent. Both now derive from
   the same `officialMembership` call and are incapable of disagreeing.
2. **`latest` served mid-run rows.** An outcome exists before its run is terminal and before `/finalize`
   in the import flow, so the contract could publish a partial result that a later `FAILED` would make
   wrong. `latest` now requires `COMPLETED` or `PARTIAL_FAILURE`, reports `runId`, and its 404 carries
   `pendingRuns` rather than pretending nothing was found. This needed `runId` on
   `EmployeeOutcomeRow` — a projection widening in both adapters, no DDL.
3. **`preview` let a read-only role trigger compute.** `authorize.ts` states the viewer posture as "may
   GET but never write … or trigger compute", and a GET costing a CQL evaluation is the loophole in that
   sentence. `preview` is now gated to CASE_MANAGER/ADMIN — the bar MCP's `check_compliance` already sets
   for the same question over the same data, so there is one answer to "who may ask the engine about a
   patient" rather than a quieter second one.

**A plan correction, recorded because it inverted a security claim.** The plan asserted that
`authorize.ts` falls through to *permit* for an unmatched path, and therefore that a new rule was
mandatory. Verified false: `RULES` ends with a generic `/api/**` → `AUTHENTICATED` pair, so the new route
was already gated and the permit default applies only to non-`/api` paths. **No rule was added** — a
redundant one is noise. A test asserts the 401 anyway, because `RULES` is first-match-wins and a later
reordering could put a `PERMIT` ahead of it on a route that returns per-subject clinical status.

**Consequences.** `GET /api/v1/compliance/{subject}/{measure}?start&end&mode`, documented as a contract in
`docs/COMPLIANCE_API.md` with an explicit stability statement. No machine-to-machine credential — that is
the SSO fork (#265, blocked on MIE) and inventing one here would pre-empt it. No cohort endpoint: a
population question has different performance characteristics and deserves its own design.

## ADR-060: a translator gap and an engine gap are different findings, so the conformance harness never merges them

**Status:** Accepted (2026-08-05). Roadmap M-C / V7, issue #296. Extends ADR-059 (adds one export to
`@workwell/measure-engine`). **Corrects ADR-048's remaining item** — see decision 5.

**Context.** Locked decision 2 makes the FHIR-column verification SET the bar. V7 is a member of it, and
the reason it is worth doing is specific: `cql-execution` 3.3.x — our exact runtime — has **published**
results (1,533 / 81 / 113 / 4), but that run used the **Java** translator. We translate with
`@cqframework/cql` 4.0.0-beta.1. **That delta is unpublished**, and measuring it costs a day.

**Decision 1 — `translation-error` is a first-class outcome, never folded into `fail`.** A case can fail
because the engine computed the wrong value, or because our translator would not compile CQL the corpus
considers valid. Merging them would attribute a translator gap to `cql-execution`, whose own posted
results say otherwise. **The difference between those two columns is the entire deliverable**, so the
runner carries seven outcomes and the report prints all of them.

**Decision 1b — an `invalid` case is EXECUTED when it translates, because that is what the corpus means.**
The first cut graded `invalid` purely on whether the expression translated; `cql-tests-runner` grades it a
pass when the request fails for **any** reason, translation or evaluation. Measured: 5 of our 36
"accepted" cases threw at runtime and are upstream passes, and the finding's headline example was one of
only 2 `invalid="syntax"` cases, which upstream does not route through that branch at all. Corrected to
**11 refused (6 at translation, 5 at runtime) / 31 accepted**, and the upstream-comparable total is stated
as **1,633** alongside our 1,622 (review, #398). A published finding that misstates the rule it is
measuring against is worse than no finding.

**Decision 2 — a case is graded by CQL, not by JavaScript.** Each becomes
`define Actual: <expr>` / `define Expected: <output>` / `define Passed: Actual ~ Expected`, executed
**unfiltered** (no patient). Writing a CQL literal parser in TypeScript would mean re-implementing CQL
semantics in order to test CQL semantics — the comparison would then share defects with the thing under
test. This required one small genuine addition to the package: **`evaluateExpressions`**, data-free
execution. That is a real engine capability (the whole language suite is defined in the data-free subset),
not a test hook, and it keeps the harness app-side where the translator lives rather than reaching into
the package or declaring a second `cql-execution` dependency.

**Decision 3 — the SkipList is the CAPABILITY SET we claim, and it is EMPTY.** The corpus declares
`<capability>` at file, group and test level; issue #296 proposed a list of test names over the known-weak
clusters. Names rot. More importantly, skipping the weak clusters would delete the finding — `system.long`
is 33 cases and the `Long` type is where the most serious defect lives. We claim everything, grade all
1,835, and report 0 skipped. The mechanism exists and is unit-tested against a fixture so it is not
vacuous, but adding a real entry needs a PR that says why.

**Decision 4 — the CI gate is a PER-CASE baseline, not a threshold and not per file.** "≥N passing" goes
green while a translator upgrade trades 30 passes for 30 different ones. The first cut fixed that with
per-FILE tallies — and **review (#398) found the identical hole one level down**: inside a single XML
file, one case can go `pass`→`fail` while another goes `fail`→`pass`, leaving every count identical and CI
green. `regressions()` now compares by `file/group/name`. Only the **non-passing** cases are stored (213
rather than 1,835), which loses nothing: a case absent from that map was passing, so "used to pass, now
does not" stays decidable for all 1,835. A change between two non-passing outcomes is reported without
failing, because the evidence document enumerates those buckets and silent drift between them would leave
it stale. A pre-#398 baseline is **refused** rather than silently compared with the weaker rule.

**Decision 5 — ADR-048's `node:` CLI debt is REFRAMED, not paid; and its stated basis had expired.**
ADR-048 planned to split library values out of the four `*-cli.ts` files because `devdb-cli.ts` exported
to five modules *"including production `live-cli.ts`"*. **Measured 2026-08-05: `live-cli.ts` now takes
`DEVDB_WHITELIST` from `report-table.ts`, and every remaining importer of the four is a test or a `bin.ts`
shim.** The split therefore buys nothing. The real hazard was elsewhere and untouched by it:
`engine-boundary.test.ts` keyed its `node:` carve-out on the **filename** (`/-cli\.ts$/`), so a module the
worker request path genuinely reaches would have passed merely by being named that way. It is now keyed on
**reachability** — the request path is *derived* (any engine module imported by a production file outside
`src/engine/`, plus its closure), never listed, so it cannot drift. Mutation-checked both directions.

**Two harness defects are recorded in the evidence rather than quietly fixed, because they nearly became
the published headline.** The first full run reported **183 translation errors; 171 were ours.** 155 were
`No default UCUM service available` — `LibraryManager` takes the UCUM service as its **fourth** argument
and defaults to one that throws, so every quantity literal failed to translate; 16 were our own
`Actual ~ Expected` line refusing to type-check when the two sides have different static types. The real
figure is **12**. Publishing 183 as "the JS translator delta" would have been wrong by a factor of 15,
and the only reason it was caught is that the plan required clustering the diagnostics before believing
the number.

**A production gap this uncovered, deliberately NOT fixed here.** The runtime translator has no UCUM
service either, so the Studio's ELM Explorer **cannot compile any CQL containing a quantity literal**.
`compileCql` now takes an optional `validateUnit` and the harness passes one; production passes none, so
its behaviour is byte-identical. Wiring it in is a real behaviour change and belongs in its own PR — filed
as a follow-up issue.

**Consequences.** `pnpm cql-tests` + a CI job mirroring `official-cases` (pinned fetch, cached, out of
`pnpm test` so an offline local run stays green). The runner **refuses to report** unless it parsed all 16
files and 1,835 cases with every case in exactly one bucket — a conformance harness that grades a subset
publishes a flattering number, which is the specific way this could be worse than useless. Results:
**1,622 pass / 155 fail / 12 translation-error / 4 runtime-error / 11 invalid-refused / 31 invalid-accepted
/ 0 skipped** — 1,835 exactly, and **1,633 on the upstream rule**. **16 cases are compared in JS rather
than by CQL `~`**; that count is printed, serialized and baselined, because a first draft claimed it was
zero after reading a field `runnerJson` never wrote. `scripts/**/*.ts` is now inside `tsconfig.json`'s
`include` — the harness that produces a published number was not being typechecked at all, which is how a
`Baseline` literal missing a required field reached CI. Findings and limits in
`docs/evidence/CQL_TESTS_2026-08-05.md`. Phase 2 — a dev-only `$cql` operation so the stock
`cql-tests-runner` drives us, the entry ticket to posting official vendor results — is not built.

## ADR-059: the engine takes its measure content INJECTED — and the test-edge blocker dissolved rather than being paid

**Status:** Accepted (2026-08-05). **Answers the question ADR-052 explicitly deferred.** Roadmap M-C / C1,
locked decision #5. Supersedes ADR-052's open question; ADR-052's *decided* half (what is app content)
stands unchanged.

**Context.** `packages/measure-engine` has been promised since the 2026-07-24 roadmap and deferred twice —
resequenced out of PR-2, then blocked by a question nobody had answered. `engine-core-boundary.test.ts`
already decided and enforced *where* the boundary sits. What was open was **what the package contains**:
`cql-execution-engine.ts` hard-imported `MEASURES` (our 15-measure catalog), `ELM_LIBRARIES` (17 compiled
WorkWell libraries, 1.2 MB, 17 of the 29 closure members) and `withBundledEcqmFallback`, whose own docblock
begins *"the codes **the synthetic corpus** stamps"*. ADR-052 named the tension precisely and declined to
resolve it: the argument that excludes `synthetic/employee-catalog.ts` applies to those three with equal
force, and the engine would not construct without them.

**Decision 1 — content is INJECTED. The package ships none of it.** `CqlExecutionEngine`'s constructor
takes `MeasureContent = { measures, elmLibraries, expansionFallback? }`. WorkWell's catalog, ELM and corpus
expansions stay app-side under `src/engine/cql/`, wired in exactly one place —
`src/engine/cql/workwell-engine.ts`'s `createWorkwellEngine()`, which the ~45 former `new
CqlExecutionEngine()` sites now call. `LOCKED_DECISIONS` §5 already recorded that
`evaluate(input.elm, input.metaOverride)` supports consumer-supplied measures, so the registry and ELM were
always a **default**, never a necessity.

**Content is REQUIRED, not defaulted to empty.** An engine with an empty catalog returns `MISSING_DATA` for
every subject, which is indistinguishable from a genuinely ineligible roster — the exact failure mode
ADR-043 exists to keep visible, and one that PR-8f's retrieve check provably cannot see. A compile error is
the cheapest place to catch it, and it is verified as one: `new CqlExecutionEngine()` is `TS2554`.

**Decision 2 — the app remainder does NOT move.** `measure-registry.ts` has ~30 importers,
`bundled-ecqm-expansions.ts` 10, `elm/index.ts` 6. Relocating them to `src/measure/` (ADR-048's precedent)
would churn ~45 files and buy no boundary. `src/engine/` is now a coherent app area — *WorkWell's measure
content, data ingress, the synthetic corpus, and the CLI edge* — 33 production files where it was 43.
`compile-measures.mjs` is untouched for the same reason, and re-running it produced a byte-identical `elm/`.

**Decision 3 — `fhirNativeExecutor` and `resolveMeasureExecutor` now REQUIRE their engine binding.** This
was forced, not chosen. Both defaulted to a lazily-constructed shared `CqlExecutionEngine`, which was only
possible while the engine imported content at module level; an executor that manufactures its own engine
would have to manufacture a catalog, and the only catalog it could invent is an empty one. Both had zero
production callers — the seam is exercised solely by its own test — so the change is a signature widening
with no behavioural surface.

**Decision 4 — offline expansion is gated on the fallback being SUPPLIED, not on the OIDs looking
eCQM-shaped.** `canExpandOffline` used to mean "every value set is a `2.16.*` OID", which was sufficient
while `withBundledEcqmFallback` was a module-level import and therefore always present. Left as it was, a
consumer injecting neither resolver nor fallback would enter expansion mode against an empty `CodeService`
and zero-match every retrieve. It now also requires `expansionFallback != null`, so that consumer gets the
base library instead: a **limited** answer rather than a **silently wrong** one. WorkWell always injects the
fallback, so this changes nothing here — verified by `flip-snapshot`, unchanged at cms125 5/5 in the
official initial population and agreeing with authored across the corpus.

**What ADR-052 called the extraction's real blocker DISSOLVED — it was not paid.** ADR-052 recorded nine
core-test→app edges and concluded: *"the move must either strand those tests or give the package a
devDependency pointing back at the app."* Neither happened, because under content injection every one of
those tests is testing *content-configured* behaviour and is therefore app-side by the same rule that
excludes the content. `cql-execution-engine.test.ts` (→ `synthetic/` ×4), `foreign-condition-scoping.test.ts`,
`generate-sql.test.ts`, `value-set-resolver.test.ts` and `audiogram-vsac-parity.test.ts` (→ `stores/sqlite/`)
all stay in `src/engine/cql/`, now importing the engine by its package name; `measure-executor.test.ts` stays
for the same reason. **Four** package tests had no app edges and moved with their subjects
(`composite-value-set-resolver`, `resolve-value-set-resolver`, `vsac-client`, `vsac-value-set-resolver`);
`package-boundary.test.ts` is a fifth test in the package but is **new**, not moved — git renders it as a
rename of `engine-core-boundary.test.ts` on a similarity heuristic, and a first draft of this ADR repeated
that as "five moved" (review, #395). **Stated
plainly because it is the interesting part: the blocker was an artefact of the undecided question, not an
independent obstacle.** Deciding content resolved it at no cost.

**Enforcement moved with the files, and neither test survived unchanged — by its own prediction.**
`engine-core-boundary.test.ts` said in its docblock that the move would leave it unresolvable if left behind
and structurally vacuous if moved verbatim. It is therefore split:
`packages/measure-engine/src/package-boundary.test.ts` recomputes the closure from `index.ts` and refuses a
third dependency, any `node:` builtin, any escape, and **any import of WorkWell content by name** — that last
one is what keeps decision 1 from being quietly reverted. `src/engine/measure-engine-api.test.ts` keeps the
half only checkable from outside: no deep import past the entry point, no relative reach-around into
`packages/`, and every imported name present in `index.ts` — **read from the file**, so the check cannot
drift from the real surface. `CORE_ENTRY_POINTS`, an eleven-name list restating an API, is deleted.
`engine-boundary.test.ts` keeps policing `src/engine/` but its allowlist no longer admits `cql-execution` or
`cql-exec-fhir`: a file there reaching for the CQL runtime directly would be evaluating measures *beside*
the engine rather than through it.

**All eight new or rewritten assertions were mutation-checked** — each broken deliberately, confirmed red,
restored. That is not ceremony here: the boundary-test-that-survives-its-own-subject-moving is exactly the
vacuous-guard shape this codebase has caught four times (#350, #354, #363, #365).

**And review found a NINTH thing the eight could not see (Codex, #395) — the portability claim was wider
than its guard.** `httpVsacClient` built its HTTP Basic header with **`Buffer`**, a Node global that
arrives through no import, so "the package is NODE-FREE" was green while a VSAC-configured Worker or
browser consumer would have thrown before issuing a request. Not theoretical, and not introduced by this
change either — the same `node:`-only check has lived in `engine-boundary.test.ts` since PR-1 with the
same blind spot. What this change did was **widen the claim** the guard is cited for, from "file I/O
stays at the CLI edge" to "publishable and portable", which is precisely the shape #380 found in
`qrda-schematron-check.py`: a control whose SCOPE is narrower than the sentence quoting it. Both halves
fixed — a `TextEncoder` + `btoa` encoder (verified byte-identical to `Buffer` output, and correct rather
than merely portable, since bare `btoa` throws above U+00FF), and the guard now scans the closure's
SOURCE for `Buffer`, `process.*`, `__dirname`, `__filename` and `require(`, with its own non-degeneracy
assertion because the source map is a second thing that can silently be empty. Mutation-checked.

**Consequences.**
- `@workwell/measure-engine` is a workspace member with `cql-execution` + `cql-exec-fhir` as its entire
  manifest. Those two left the root `package.json`. `private: true` until C4 publishes.
- **Not yet done, and named rather than implied:** the `node:` allowlist for the four `*-cli.ts` entrypoints
  (ADR-048's second debt) is C2's, not this change's — those files stayed app-side, so the debt did not move.
  `packages/measure-codegen`, the external consumer, the `cql-tests` harness and the compliance API are
  C2/C3/C4.
- Verification: suite **1859 → 1863** tests (0 fail), the +4 being the 6→10 boundary-test split, so no test
  was stranded; `compile-measures` and `generate:sql` produce byte-identical output; `pnpm evaluate` and
  `pnpm flip-snapshot` unchanged.

## ADR-058: QRDA III carries QDM identity, which the FHIR lineage does not have — so the verification bar moves to the FHIR column rather than the label moving to the QDM one

**Status:** Accepted (2026-08-04). **Supersedes locked decision #2's "Cypress CVU+ green" bar**
(`docs/LOCKED_DECISIONS.md` §4). Drives `docs/ROADMAP_2026-08-04.md`.

**Context.** M-B built the whole certification-shaped loop and it runs through the product API over a third
party's archive, producing Cypress's own expected counts exactly (ADR-055, ADR-056). Cypress graded it
**red**. The cause was read out of `projecttacoma/cqm-validators` rather than inferred:
`extract_results_by_ids` calls `find_measure_node(measure.hqmf_id, doc)` and **returns `{}` immediately**
when the document's measure identity is not the one Cypress holds. Cypress has **CMS125v14** (QDM lineage);
we execute and report **CMS125FHIR v1.0.000** (QI-Core lineage). The two "invalid id" errors it emitted are
**exactly our own vendored artifact's version-specific and version-independent UUIDs** — the document is
internally honest; Cypress simply holds a different measure.

Three things the first reading of that result got wrong, each corrected here:

1. **The 45/53 supplemental-data errors are NOT an independent second gap.** Supplemental data is built only
   inside the matched node and read back as `(reported_result[:supplemental_data] || {})[pop_key]`. With an
   empty extraction there is nothing to key into. `CVU_C2_SUBMISSION_2026-08-03.md` §4 called this a
   separate end-to-end gap and said "separately from the lineage problem, this alone would fail a
   submission" — true, and it would *also* fail with perfect supplemental data, which is the half that
   decides sequencing. **Building it would not have moved the verdict by one error.**
2. **It is not a two-identifier relabel.** `extract_component_value` matches each population on
   `reference/externalObservation/id[@root = <population hqmf_id UUID>]`. **The QI-Core artifact has no
   per-population UUIDs at all** — read from the vendored bundles, its populations are *named*
   (`InitialPopulation_1`, `Numerator_1`, …). There is nothing in our lineage to put in `@root`. Making
   Cypress read us would mean importing the QDM measure's **entire** identifier surface via a hand-asserted
   crosswalk, taken from the answer key's own internals, with no CMS-published correspondence to cite.
3. **No FHIR-lineage grader exists to switch to.** `projecttacoma/cvu-fhir` — MITRE's fork of Cypress,
   README verbatim *"An open source tool for testing electronic Clinical Quality Measure calculation"* —
   has 3,771 commits and was **last pushed 13 April 2023**. Cypress itself is actively maintained (v7.5.1,
   30 Jul 2026) and contains **zero** mentions of FHIR, QI-Core or dQM.

**The structural statement:** **QRDA Category III is an HQMF/QDM-identity format.** Its identity model has
no counterpart in the FHIR measure lineage. That is a property of the format, not a defect in our work.

**Decision.**

1. **The measure identity in every export continues to derive from the artifact that produced the outcome.**
   ADR-046 decisions 3 and 4 are reaffirmed, not carved out. Emitting `CMS125v14`'s HQMF id over counts
   `CMS125FHIR v1.0.000` produced would assert a provenance that never existed, and a receiver resolving it
   would fetch different CQL.
2. **The deciding argument is informational, not only ethical.** A green obtained by relabelling would teach
   us **nothing we do not already have**: #388 measured 64/64 and 150/150 subject-level agreement against
   Cypress's own per-patient expected results (ADR-055). The badge would add no evidence and would put a
   false provenance claim into a document that leaves the building.
3. **The bar moves to a NAMED SET of FHIR-column checks** (`ROADMAP_2026-08-04.md` §4), each with a stated
   scope and limit, replacing one external pass/fail. Immediate additions: the **FHIR validator + DEQM STU5
   package** against our MeasureReports (structure), and **cross-execution against Java `cqf-fhir-cr`**
   (arithmetic, against a second independently written engine). **`fqm-testify` and `deqm-test-server` are
   NOT independent** — both wrap `fqm-execution`, the library we run.
4. **A Cypress Calculation Check green is retired as a goal**, because reaching it requires a QDM execution
   path we are not building. **We do not build one**, because WorkWell is supplementary to WebChart and does
   not pursue ONC certification — WebChart already carries it. Revisit only if MIE states that certification
   of WorkWell's engine is a business goal.
5. **The QRDA I/III machinery is KEPT, re-scoped from certification target to interoperability bridge.** It
   is built, both document types validate at **0 findings** against the HL7 base ruler (#380/#381/#384), and
   it is what lets WorkWell speak to an EHR audience at all. Nothing is deleted.
6. **Supplemental data (RACE/ETHNICITY/SEX/PAYER) is DEFERRED, not cancelled** — a real end-to-end gap
   (import drops Patient Characteristic Payer; race/ethnicity ride unread in `<recordTarget>`; the Cat III
   emits none), but one that changes **no external number today**: Cypress cannot read past the identity
   check, and the HL7 base Cat III ruler does not require it. Do it when a receiver reads it, or alongside
   DEQM supplemental-data elements.

**Consequences.**

- **Locked decision #2 is rewritten** in `docs/LOCKED_DECISIONS.md`, and `docs/STANDARDS_CONFORMANCE.md`
  plus the `conformance` skill lose the line "Cypress CVU+ is the verification bar." Left stale, that line
  is a gate quietly enforcing a retired goal.
- **Issue #385's remaining scope is retired.** The Calculation Check comparison it asked for was **done**
  offline and passed exactly (ADR-055); what stays undone is the submission verdict, which this ADR says is
  not obtainable in our lineage.
- **The claim we can now make is stronger than the one we gave up.** "Two independently written engines
  agree on CMS's own test cases" (V4, once run) beats "a QDM certification tool read a document we labelled
  as a measure we did not execute."
- **What none of this establishes.** No FHIR-column check produces a certificate; every claim must name who
  graded what. And nothing to date measures our calculations over **real patient data** — every measurement
  is over synthetic corpora, a WebChart dev-DB fixture, or Cypress's generated patients.
- **Evidence:** `docs/evidence/FHIR_VERIFICATION_LANDSCAPE_2026-08-04.md` (mechanism, tooling landscape,
  regulatory position, live-endpoint probes) and `docs/evidence/CVU_C2_SUBMISSION_2026-08-03.md` (the run
  that produced the red).

## ADR-057: The live third-party WebChart path derives the two elements our SQL mappers add — because reading a server's own "female" as not-female is also an inference, and a worse one

**Status:** Accepted (2026-08-03). **Closes the open item in ADR-042 decision 3 and ADR-044.**

**Context.** ADR-042 mapped `us-core-sex` and ADR-044 dual-stamped mammography, both in the two SQL→FHIR
sites (`wcdb-fhir-shim`, `scripts/webchart-devdb-export.ts`). Both sit **upstream of the live FHIR
transport**, and `normalizeWebChartBundle` was left untouched deliberately — so a third-party WebChart
server, which supplies only what its own FHIR API emits, got neither. Both ADRs recorded the consequence
and left it open: official CMS125 puts a live tenant's ENTIRE roster out of its initial population (100%
MISSING_DATA, silently), and a woman who WAS screened reads OVERDUE — which `case-logic.ts` escalates to
HIGH. It was inert only because no WebChart-configured stack routes officially; the day one does, both fire.

**Decision — derive both, on the ADR-037/ADR-044 normalization terms, and say what is inferred.**

`us-core-sex` is asserted from `Patient.gender` when the server states one and not the other: an explicit
two-value allowlist (`male`/`female` → the SNOMED concept ids — `other`, `unknown` and anything else assert
NOTHING, because there is no concept to assert and guessing is precisely what this must not do), never
overwriting an extension the server supplied, and tagged `derived-from-gender`.

A LOINC imaging `Observation` is derived from a CPT/HCPCS mammography `Procedure`: a two-code allowlist
rather than a category sweep, only from a `completed` Procedure (a `not-done` screening did not happen),
carrying the `category ~ imaging` that `Status.isDiagnosticStudyPerformed` also requires, and **suppressed
entirely when the bundle already carries the LOINC Observation** — checked at bundle level precisely so it
can see the whole patient. Both numerators are `exists(...)`, so neither can inflate; for a counting
measure the duplicate would, which is why the allowlist is two codes.

**ADR-042 declined to infer sex here, and this reverses that for a stated reason.** That refusal was
generalized from the configuration it fixed to one it had not measured (ADR-042 decision 3 says so). The
symmetry is the argument: administrative gender and recorded sex can legitimately differ, so deriving is an
inference — but reading a server's own `female` as not-female is *also* an inference, and a worse one,
because it is silent and it empties the measure. ADR-043 established that a whole roster out of the initial
population is the hazard, not the safe answer.

**The residual, which is the one thing a reader of the symmetry argument would not learn.** There IS an
individual the old behaviour got right and this one gets wrong: a person whose administrative gender reads
`female` while their recorded sex is male — a transgender man whose administrative field was never updated,
or a plain data-entry error. Before, they had no extension, fell out of the initial population, and read
MISSING_DATA. Now they enter the denominator, read OVERDUE, and `case-logic.ts` escalates to HIGH, sending
"escalate mammogram follow-up immediately" to someone for whom it may be clinically inappropriate.

That is still the right trade, and the reason is sharper than symmetry: **it converts a systematic,
roster-wide, individually-invisible failure into a rare, individual, human-reviewable one.** A case that
reaches an operator is recoverable; a roster silently reporting 100% MISSING_DATA is not. The
`derived-from-gender` tag exists so that case can be told apart — and it currently has **no reader**:
nothing in `evidence_json`, the case surfaces or the QRDA export distinguishes an asserted sex from a
recorded one. "Tagged so a reader can tell" is true of the bytes, not yet of the system.

**The `male` half of the allowlist is a deliberate choice, not a side effect of the table having two rows.**
It buys nothing measured — for CMS125's initial population, absent and `248153007` are equally excluding —
but the extension is not measure-scoped, so every derived male extension is an assertion a future official
measure reading `us-core-sex` will consume. Kept for symmetry; recorded so the next measure's author knows.

**Consequences.** `live-official-parity.test.ts` is the gate the skill's trap #4 said did not exist: it
strips exactly those two elements from the committed fixture to reproduce the live shape, then pins that
official CMS125 admits **4 of 56** with normalization and **0** without — so the test cannot pass on data
that never needed the fix. Every derivation also pins its negative (a non-final Procedure, a non-mammogram
Procedure, an unmapped gender, a server that already supplies the element). What remains untested is the
live HTTP transport itself: this exercises every transformation a routed run applies to a WebChart payload
and none of the request shaping, exactly as `devdb-official-eval.test.ts` says of itself.

**Suppression is keyed on (subject, DAY) and counts only an Observation the measure could actually use.**
Presence of the mammography code is not usability: an Observation that is `preliminary`/`entered-in-error`,
or carries no `category ~ imaging`, or is simply an old screening from years ago, would otherwise suppress
derivation for a RECENT valid Procedure — and the patient reads OVERDUE and is escalated HIGH, which is the
failure this whole derivation exists to remove (Codex, #390).

**Two limits found in review (#390) and left open rather than papered over.** The suppression check
matches the one canonical LOINC `24606-6`, not the 92-member value set, so a server using one of the other
91 gets a derived duplicate for the same day (widening it would mean reaching the official terminology
sidecar from inside the engine, which the boundary forbids). Only **Procedure to Observation** is derived — a server recording
mammography as a LOINC Observation and no CPT Procedure leaves the AUTHORED engine blind, which is a live
configuration on staging today. And a live tenant's QRDA Category I now carries the screening as two QDM
entries, since `qdm-entries.ts` routes the imaging Observation and the Procedure separately and `meta.tag`
does not survive into CDA.

**One defect this change introduced, caught in review before it shipped:** the mammography allowlist
compared `system|code` exactly while the crosswalk fifty lines away normalizes system aliases and upcases
the code. Measured on a CPT-as-OID mammogram — the commonest alternate form — the crosswalk recognised it
and the authored engine read COMPLIANT while the derivation did not fire and official read OVERDUE. The
derivation created the divergence it exists to remove. Both now go through one exported `codingKey`.


## ADR-056: A batch import and an import-driven finalize — the two routes the certification loop needed, and the guard that keeps finalize from being a "finish this run" button

**Historical finding — full text in [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md#adr-056).** Mechanism: import is a batch because identity resolution spans documents; finalize refuses a run whose outcomes are not all import-derived.

## ADR-055: What a QDM datatype becomes in FHIR is read off the artifact's own ELM retrieves — and the importer is now measured against a third party's answers

**Historical finding — full text in [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md#adr-055).** Mechanism: QDM datatypes are mapped by reading the artifact's own ELM retrieves; the importer then matched a third party's answers exactly.

## ADR-054: CMS130 and CMS165 onboard clean — the credentialed workflow's completion flag was already doing the capped-expansion work ADR-041 built it for

**Historical finding — full text in [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md#adr-054).** CMS130 and CMS165 onboarded clean on the first credentialed dispatch.

## ADR-053: "the terminology is complete" was only ever a claim about what the bundle DECLARED

**Status:** Accepted (2026-07-31). Task #11. Closes a blind spot in the vendor step and, more usefully,
answers a question ADR-047 recorded as open.

**Context.** ADR-047 onboarded CMS2, CMS68 and CMS951 and recorded that three of six candidates did not,
CMS138 among them. Its table reads *"CMS138 tobacco screening | **0/47, 47 errors** — one value set
(…3.526.3.1278) will not expand"*, and — to its credit — it did **not** claim to know why: *"Whether
that is an upstream packaging gap or something our reducer drops is unknown."* CLAUDE.md's summary
dropped that hedge, and "will not expand" is a symptom that points at the wrong system: it reads as a
failure of our expander, our gitignored sidecar, or our VSAC release pin — every one of which is a thing
an engineer can go and check, at length, without getting closer. So this ADR answers ADR-047's open
question rather than correcting a wrong answer.

(The first draft of this ADR quoted that sentence as ADR-047's own words. It was CLAUDE.md's phrasing,
not ADR-047's — the same misattribution class review caught on #363 one PR earlier. Corrected above,
against the text.)

**What was actually measured (2026-07-31, at pin `ca4b4951`, by `pnpm official:terminology-audit`).**

| measure | value sets the ELM retrieves | ValueSet resources the bundle ships |
|---|---:|---:|
| CMS122 / CMS125 / CMS2 / CMS68 / CMS951 | 26 / 32 / 15 / 5 / 26 | identical |
| **CMS138** | **32** | **31** |

`2.16.840.1.113883.3.526.3.1278` ("Tobacco Use Screening") is **not in the bundle**. There is nothing to
expand. Three further facts settle what to do about it, and each one changes the answer:

- **The measure is fine.** Upstream's own discrepancy report at HEAD (2026-07-15; 72 measures, 5826 test
  cases) lists CMS138 under *Measures with No Discrepancies*. Their environment resolves the set from the
  NLM terminology package their README names — `vsac.nlm.nih.gov/download/manifest?rel=20251117` — and
  our vendor step never asked for it. So this is not an upstream bug to file, exactly as ADR-041 found
  for the 1000-code cap; it is the same licensing boundary in a different shape.
- **Re-pinning cannot fix it.** The only commit after our pin (`f705ee60`) adds two connectathon report
  documents and changes no bundle. Checked before writing any code, because "upstream already fixed it"
  and "we must source it ourselves" are different PRs.
- **VSAC is the remedy**, so vendoring CMS138 needs `WORKWELL_VSAC_API_KEY_VENDOR` and is an owner step
  beside CMS130/CMS165 (task #10). CMS138 is deliberately still **not vendored** — the same call ADR-047
  made for those two: an artifact committed in a state that can never be routed is worse than none.

**Decision 1 — the vendor step reports what it cannot see, instead of writing a manifest that reads as
complete.** `collectTerminology` enumerated the ValueSets a bundle SHIPS, so an absent one produced no
sidecar entry, no `truncated` row and no warning. It now diffs the value sets the ELM RETRIEVES against
those, using the same `library.valueSets.def` read the executor makes, over the same reduced bundle
`requiredOids` reads at runtime — so the vendor-time record and the routing refusal are computed from one
input by one algorithm rather than kept in step by hand. The diff is one-directional on purpose: a value
set shipped but never retrieved is not a problem, because upstream bundles carry dependency closures.

The manifest's existing sentence — *"a manifest with an empty `truncated` is a manifest whose sidecar
holds every code the bundle declared"* — was **true and narrow**. "Every code the bundle DECLARED" says
nothing about a value set the bundle never declared. It was doing duty as a completeness record, and
`official-flip-config.test.ts` read it as one.

**Decision 2 — absent is NOT recorded in the manifest; it is recomputed at runtime.** The list is
derivable from the artifact's own two committed-or-pinned files (the ELM names what it retrieves, the
sidecar names what we hold), so persisting it would create a second authority that can disagree with the
artifact it describes — the exact drift `official-terminology.test.ts` guards `truncated` against, in a
field that never needed to exist. `truncated` genuinely cannot be recomputed (upstream's declared totals
are not in the sidecar); this can. Two consequences, both good: the check applies retroactively to
artifacts vendored before it existed, and it adds nothing to the committed artifacts.

**One claim in this ADR's first version was false, and the way it failed is worth keeping.** It said
the change "moved no committed byte", verified by re-vendoring cms2 to an empty `git diff` and an
unchanged sidecar hash. The verification was real and the conclusion did not follow. The first cut also
tagged CAPPED completions with `reason: "capped"`, and the two credentialed artifacts (cms122, cms125)
carry a `completion` block recording exactly `{oid, had, now, declaredTotal}` — so a credentialed
re-vendor produced a different `manifest.json`, and CI's *"The committed artifact is reproducible from
its pin"* step failed, which is a **deploy-blocking** gate that no contributor can clear locally
(`WORKWELL_VSAC_API_KEY_VENDOR` is a GitHub secret). cms2 provably could not have caught it: vendored
without the credential, it has no completion block at all. The check was run against the one artifact
class the change could not affect.

Fixed by emitting `reason` only for `absent-upstream`, and guarded by a test that compares the record
the code PRODUCES against the records already COMMITTED — code-versus-artifact rather than
code-versus-itself, with a non-degeneracy assertion so it cannot pass by finding no completion block.

**Decision 3 — capped and absent are completed by one flag but never conflated.** `--complete-terminology`
(was `--complete-capped-expansions`, still accepted with a notice, and that alias is *tested* rather than
asserted in a docblock) now sources absent sets too. They are not equally evidenced, and the code keeps
them apart:

- A **capped** set is checked against upstream's declared total AND against containment of the codes
  upstream shipped (ADR-041's two guards).
- An **absent** set has neither — upstream shipped nothing to contain, and declared no total to fall
  short of. Its only baseline is VSAC's own `expansion.total`, which is enforced; an empty expansion is
  refused outright, because an empty value set matches nothing and produces the whole-roster-out-of-
  population silence of ADR-043. `completion.valueSets[].reason` is emitted **only** as
  `absent-upstream`, and `declaredTotal` is `null` for it, because that field means "what the bundle
  declared" and an absent set declared nothing. Its ABSENCE means `capped` — which is what every
  completion before this ADR was, so the field marks the weaker provenance rather than labelling both.
  That asymmetry is forced, not stylistic: see the reproducibility consequence below.

**The check on a sourced value set was claimed to be the MADiE gate. MEASURED 2026-07-31, that claim is
FALSE as written, and the correction matters.** The gate executes each measure against **the upstream
bundle's own ValueSet resources** — the report says so in its own words: *"ValueSets are consumed
directly from each official measure Bundle; no VSAC network call or key is used."* For an ABSENT value
set the bundle is precisely what does not have it, so the gate cannot resolve it however good our
sourced codes are. Run with cms138 in the gate: **0/47, 47 errors, every one of them
`Missing the following valuesets: …3.526.3.1278`** — byte-for-byte the pre-ADR-053 result, with a
complete sidecar sitting beside it.

So a sourced-absent value set was validated by neither the vendoring (no containment or declared-total
baseline) nor the gate as it stood. **Built in the same PR, and then measured: CMS138 went 0/47 →
47/47, 0 unexpected mismatches, 0 errors.**

`runOfficialMeasureCases` takes the artifact's runtime terminology and **narrows it to the OIDs the
bundle does not ship**. The narrowing lives next to the `calculate` call rather than at the call site,
because the natural thing for a caller to do is pass the whole cache — which would silently convert this
gate from "upstream's terminology" into "ours" for every measure, with the deck still green and nothing
to notice it. With nothing missing, `calculate` is invoked with three arguments exactly as before, so
the five complete measures are provably unaffected.

**What 47/47 licenses, stated precisely, because it is not the claim the other five carry.** For that
one value set the CODES are ours, sourced from VSAC at the pinned release. What stays upstream's is the
**answer key** — the expected population vectors in the MADiE deck. Agreement is therefore real evidence
that the four sourced codes are right, and is *not* evidence about upstream's terminology. The report
says so on the measure's own line rather than in a footnote, and `supplementedOids` carries it in the
data so nothing downstream can round it off to "47/47 like the others".

**Decision 4 — routing's diagnosis changes; its verdict does not.** `expandArtifactTerminology` already
refused an unexpandable value set, so nothing was ever routed on one, and this ADR does not claim to have
closed a live hazard. What it changes is the sentence an operator gets: "N of M value sets could not be
expanded" becomes a named OID, "the upstream bundle ships no ValueSet resource for it", and "re-pinning
will not fix it". Reported alongside checks 1-6 rather than left to the lazy expansion pass, for the same
reason `scoring` and the sidecar check were moved up — a precise sentence at boot beats an accurate one
later.

**Consequences, including the one that bit during implementation.**

- The routing check exposed an **incoherent test stub**. `executor-router.test.ts` returned
  `{ok: true, codesByOid: new Map()}` for "terminology present" — an artifact whose sidecar loads and
  holds nothing, which is not a state a real artifact can be in. Once the router could notice it, that
  stub meant "all 26 of this measure's value sets are absent" and nine routing tests failed on a
  condition none of them was about. Fixed by making the stub describe a COMPLETE artifact (a code per
  retrieved OID) rather than by adding a third thing to remember to stub — the `offlineChecks` docblock
  is already a warning about forgetting one.
- **Two implementations of "what does this ELM retrieve" now exist**, and that is forced: the vendor
  script runs as bare `node` on the deploy path with no install, so it cannot import
  `@workwell/official-executor`. `scripts/valueset-parity.test.mjs` pins them against each other over the
  real committed artifacts, with a non-degeneracy assertion so it cannot pass by comparing nothing.
- `pnpm official:terminology-audit` is a **measurement, not a gate** — exit 0 whatever it finds, and
  deliberately not in CI, because it reads the gitignored `.official-content` checkout and would
  otherwise be a self-skipping job that reads as covered. Enforcement lives where it can actually run:
  `absentValueSets` + `officialRoutingProblems`, against the artifact's own files.
- **What this does not catch:** a value set that is present, fully expanded, and *wrong* — the
  membership-defect class ADR-038 found in the synthetic corpus. Size and presence are not identity.

---


## ADR-052: the app-side exclusions are decided and enforced; what the package does with CONTENT is not

**Status:** Accepted (2026-07-31), **narrowed after review**. Roadmap M-C, locked decision #3. It decides
less than its first draft claimed, because measurement contradicted three of that draft's statements.

**Context.** M-C promises `@workwell/measure-engine` with `cql-execution` + `cql-exec-fhir` as its only
dependencies. The workspace and `packages/official-executor` exist and `engine-boundary.test.ts` proves
`src/engine/` is self-contained, so the open question was never "can it be lifted" but **what belongs in
it** — task #4's published-API decision, which nothing had decided.

**What IS decided (measured, and enforced by `engine-core-boundary.test.ts`).**

1. **`synthetic/`, `ingress/`, `immunization/` and `cli/` are APP content, not package content.** Every
   cross-area edge among **production** files runs app to core, with exactly one exception:
   `cql/codegen/generate-sql-cli.ts` imports `ingress/webchart/terminology.ts`, and that is a CLI
   entrypoint, so app-side too. `synthetic/employee-catalog.ts` is a fictional employee directory and the
   single most-imported module in the tree (**51** call sites, verified in review); shipping the directory
   as the package would publish our fixtures as API.
2. **`CORE_ENTRY_POINTS` is the published API, and app imports are checked against it.** Eleven modules.
   Verified independently: all eleven have an external importer, and the only closure module *not* listed
   (`cql/vsac-value-set-resolver.ts`) is reachable solely through `resolve-value-set-resolver.ts`. The
   check was **missing from the first cut** (Codex, #363): the docblock called the list "every module the
   app is allowed to import" while nothing verified it, so an app import of a core internal left all
   assertions green. A list that reads as an API and constrains nobody is the vacuous-guard shape, inside
   the test written to pre-empt that class. Zero violations today; mutation-checked.

**What is NOT decided, and this is the substantive one (review, #363).**

**Does the package ship WorkWell's measure CONTENT, or take it injected?** `cql-execution-engine.ts`
hard-imports `MEASURES` (our own 15-measure catalog), `ELM_LIBRARIES` (**17 compiled WorkWell libraries —
17 of the 29 closure members**) and `withBundledEcqmFallback`, whose own docblock begins "the codes **the
synthetic corpus** stamps". The argument this ADR uses to exclude `synthetic/` — that no consumer of a
measure engine wants our fixtures — applies to those three with equal force, and the engine will not
construct without them.

Two things already on the record make that omission worse rather than better: ROADMAP §7.4 scoped the
clean-core claim to a **9-file closure**, which the first draft widened to 29 without reconciling; and
`LOCKED_DECISIONS` records that `evaluate(input.elm, input.metaOverride)` **already supports
consumer-supplied measures**, so the registry and ELM are a default, not a necessity. Deciding this is
task #4's actual question. It is deferred, not answered — and the boundary test measures the closure as
it stands rather than blessing it as final.

**Three first-draft claims were FALSE, and are withdrawn rather than softened.**

- *"Moving `DEVDB_WHITELIST` is what lets the package rule be 'no `node:` at all'."* **Measured false.**
  Running the identical closure algorithm against `main` gives a byte-identical 29-file closure with zero
  `node:` imports. The closure contains no `ingress/` file, so relocating a constant between two files it
  cannot reach could not have affected it. The move is still a tidy-up worth having; it is not
  load-bearing, and presenting it as the enabling step was the "guard whose premise is false" shape in an
  ADR rather than in code.
- *"The four `*-cli.ts` files are now true leaves."* **False.** `cql/codegen/generate-sql-cli.ts` still
  exports `WCDB_SQL_MEASURES` to two modules, and `engine-boundary.test.ts`'s `node:` carve-out
  (`onlyIn: /-cli\.ts$/`) is untouched here. ADR-048 said explicitly that the `node:` allowlist entry
  survives; the first draft read as though this change had discharged that debt.
- *The ADR-048 "correction".* The first draft put a sentence in quotation marks that **ADR-048 does not
  contain**. What ADR-048 actually says is that `generate-sql-cli.ts` exports to two test modules and
  `devdb-cli.ts` exports to five "including **production** `live-cli.ts`" — both counts exact, with the
  production one already flagged. So the finding **restates** ADR-048 rather than refuting it. What is
  fair to say: ADR-048's *count* was right, and its *characterization* ("not a `git mv`") was pessimistic
  **for `devdb-cli.ts` only**.

**Scope of the "exactly one exception" claim, stated because the first draft did not.** It covers
**production** files. There are **seven** further core-to-app edges from TEST files (four from
`cql-execution-engine.test.ts` into `synthetic/`, two into `ingress/evaluate-bundle.ts`, one into
`ingress/webchart/terminology.ts`), plus **two** core tests reaching `stores/sqlite/**`, outside the
engine tree entirely. The closure starts at production entry points and structurally cannot see any of
them. ADR-048 §5 already named this hazard for `cql-translator.ts`: the move must either strand those
tests or give the package a devDependency pointing back at the app. That is the extraction's real
blocker, and it remains undecided.

**Consequences, corrected.**

- **The move is bigger than the first draft said.** The 29 closure members are **12 TypeScript modules +
  17 `.elm.json` data files**. "~87 import sites" counted only external imports of the eleven entry
  points; including engine app-area files and core-area non-closure files it is **125 statements across
  85 files**. `cql/codegen/` does not move as a unit — `generate-cql.ts` goes, `generate-sql*.ts` stays,
  and they import each other. And `cql/cql-libs.d.ts` must move too: nothing imports it (it is picked up
  by `tsconfig` `include`), so a closure computed from imports **cannot see it** — a reminder that an
  import closure is the wrong instrument for enumerating what moves.
- **The move will NOT "satisfy an already-green test".** The test resolves paths from its own location,
  so leaving it behind makes every entry point unresolvable, while moving it into the package makes the
  app-area assertion structurally vacuous (those directories will not exist there) and blinds the API
  check (app imports become the bare specifier `@workwell/measure-engine`, and it inspects only relative
  ones). Both tests need rewriting as part of the move. That is a real cost of this sequencing, and it is
  better known now than discovered.
- What the sequencing does buy, and it is smaller than the first draft claimed: between now and the move,
  the app cannot quietly acquire a core-internal import, and the core cannot quietly acquire an app
  dependency or a third-party one.
- `measure-executor.ts` is on the published list although its headline export `sqlPushdownExecutor` is a
  documented inert stub that throws on use. Publishing a function that exists to reject is a deliberate
  choice, to revisit alongside the content question.
- **Known limit of the instrument**, carried rather than hidden: `stripComments` treats `/*` inside a
  string literal as a comment opener, so an import after one can drop out of the scan. Inert today, and
  `cql/codegen/generate-cql.ts` — which is in the closure — emits CQL, whose block-comment syntax is
  exactly that. Noted in the test.

---

## ADR-051: QRDA Category I import is a mapping into the unchanged engine — and it proved the export only works in real terminology

**Historical finding — full text in [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md#adr-051).** Mechanism of QRDA I import, and the export defect the round trip exposed.

## ADR-050: QRDA Category I is a patient-DATA document, measured against the HL7 base IG — not the CMS Hospital one

**Status:** Accepted (2026-07-30). Roadmap M-B. **Supersedes the central claim of ADR-049**, which is
now marked. Still **not CVU+-validated** — that bar is unmet and this ADR does not claim it.

**Context.** ADR-049 shipped a QRDA Category I export that reported per-subject population membership and
carried an empty Patient Data section, and recorded its conformance against the **CMS 2026 QRDA I
Schematron**. Two things about that turned out to be wrong, and both were found by measurement rather
than by re-reading the code.

*First, the ruler.* The CMS QRDA I IG is titled "for Hospital Quality Reporting" and governs IQR /
Medicare PI / OQR. CMS122 and CMS125 are **Eligible Clinician** measures, whose CMS submission format is
Category **III** (the 2026 CMS QRDA III EC IG covers MIPS/MVP/APP/SSP PI). But QRDA Category I is not
therefore out of scope for us: §170.315**(c)(1)** "record and export" and **(c)(2)** "import and
calculate" both require QRDA Category I per §170.205(h)(2) — the **HL7 QRDA I R1 STU 5.3 US Realm** IG —
setting-neutral, with (c)(1) in the Base EHR definition. Only §170.315**(c)(3)** "report" splits by
setting. Cypress supports 56 EP/EC eCQMs with Category I test data and validates Category I against the
HL7 standard, explicitly **not** the additional CMS constraints. So Category I is squarely our path; we
were simply holding it to the hospital ruler.

*Second, and more seriously, the content.* QRDA Category I **does not report population membership at
all**. Measured: not one of the four CMS RY2026 Category I sample files contains a single `IPOP`,
`DENOM`, `NUMER` or `MSRAGG`. The document carries the patient's clinical data plus a reference to the
measure, and the receiving engine **recalculates** — which is precisely what "(c)(2) import and
calculate" means. What ADR-049 shipped was Category III machinery (`…27.3.24` Measure Data observations)
inside a Category I envelope, plus an empty Patient Data section — while the Patient Data Section QDM
**SHALL contain at least one entry** (CONF:67-14567). It was the inverse of a QRDA I on both axes.

**Decision.**

1. **The bar is the HL7 base IG, and the measurement is a command.** `scripts/qrda-schematron-check.py`
   runs the published Schematron and **partitions** failures by conformance-number prefix: `CONF:1198-*`
   (US Realm Header), `CONF:3343-*` (QRDA I), `CONF:4509-*`/`1098-*`/`81-*`/`67-*` (C-CDA + QDM entries)
   are **base HL7 — our bar**; `CONF:CMS-*` is **Hospital-only — not our bar**. This works because the
   CMS Schematron embeds the base conformance statements it inherits. #360 measured by hand in a scratch
   directory, which is why one of its findings could be wrong without anyone being able to see it.
2. **Population membership comes out.** It is exported by the two artifacts that have a place for it —
   the FHIR MeasureReport and QRDA Category III. Keeping it in Category I as a non-standard extra risks a
   receiver rejecting the document, and states something the format does not mean.
3. **The Patient Data section carries real QDM entries, translated from the evaluated FHIR bundle.**
   `src/fhir/qdm-entries.ts` maps the five datatypes CMS122/CMS125 consume — Encounter Performed,
   Diagnosis (inside a **Diagnosis Concern Act**, which is a SHALL, CONF:4509-28885), Laboratory Test
   Performed (result in the nested Result observation), Diagnostic Study Performed (outer `value`, SHALL,
   CONF:4509-29332), Procedure Performed. An `Observation` routes on **`category`** — the same
   discriminator CMS125's official numerator uses (ADR-044) — and an unclassifiable resource is
   **skipped, not guessed**: absent is visible, wrong-datatype is not.
4. **We do not claim the CMS document template.** `…24.1.3` is "QRDA Category I Report CMS". Claiming a
   template whose IG we do not conform to is a misdeclaration, so it is gone. Four CMS-only findings
   remain and are *expected* — all four are template-declaration rules. (The count moved 3 → 4 because
   the new QDM entries trip entry-level CMS rules an empty section could not, **not** because the
   template was dropped; an earlier draft of this ADR had that causation backwards.)
5. **The header is completed with `nullFlavor`, never with invention.** `author` is an
   `assignedAuthoringDevice` (WorkWell is software; naming a clinician would be a fabricated
   attestation), `custodian` is the WorkWell instance, and `raceCode`/`ethnicGroupCode` are `UNK`.
   There is deliberately **no `legalAuthenticator`**: it is only a SHOULD (CONF:1198-5579) and including
   it forces an `assignedPerson` with a US Realm name that no real person stands behind.
6. **A document with no bundle is emitted, marked, and counted.** The route returns `nonConformant` and
   each document carries a `conformant` flag; the empty section says in prose that it is not conformant
   and cannot be recalculated from. Bundles are **not** reconstructed from the persisted outcome:
   `deriveExamConfig`'s own contract says the target is a distribution BUCKET that can converge to a
   different status (CMS122 DUE_SOON → MISSING_DATA), so status → bundle is not injective and a
   reconstruction would be fiction wearing provenance.

**Measured.** Against the CMS RY2026 Schematron, a document with patient data went from **27 findings
(14 base-HL7 errors)** to **0 base-HL7 errors** + 4 CMS-hospital-only findings + warnings. Without a
bundle it has exactly **one** base error — the missing entry — which is the honest signal.

**Two #360 findings are corrected, both by measurement.**

- **`<addr>` DOES have a nullFlavor escape.** #360 recorded "a hard-error `1..*` with no nullFlavor
  escape, so a patient without an address cannot validate (an INGEST prerequisite)". Element-level
  `<addr nullFlavor="NI"/>` indeed fails CONF:81-7291/7292 — but an `<addr>` whose **children** carry
  `nullFlavor` passes both. Address is **not** an ingest prerequisite. The same is true of
  `raceCode`/`ethnicGroupCode` via `nullFlavor="UNK"`.
- **`legalAuthenticator`, `custodian`-with-CCN and the CMS EHR Certification ID `participant` were
  filed as one undifferentiated gap list.** Partitioned: only 3 of 27 findings were CMS-hospital-only,
  so the hypothesis that re-targeting would shrink the list was **wrong** — every substantive gap
  (`author`, `custodian`, race, ethnicity, address, the QDM sections) was base HL7 all along. Two
  genuinely new SHALLs surfaced that #360 never recorded at all: `raceCode` and `ethnicGroupCode`.

**Review found four defects, three of them P1, and one is answered by DISAGREEING (Codex, #361).**

1. **The live lookup could never fire.** A live run persists `subjectId` as the roster external id
   `wc|<patientId>`, while the bundle carries the bare `Patient.id`. The map was keyed on the bare id,
   so `bundleFor(outcome.subjectId)` missed every time — on the *only* path meant to produce conformant
   documents. Present, plausible, structurally incapable of firing: the vacuous-guard shape again. Now
   keyed both ways.
2. **A retracted record became a *Performed* entry.** Every entry asserts `statusCode="completed"`, so
   an `entered-in-error` mammogram would have handed a recalculating receiver a numerator hit off a
   record WorkWell excludes. Now filtered — as a **denylist** (`entered-in-error`, `not-done`,
   `cancelled`, …) rather than an allowlist, because real WebChart data carries `status: "unknown"` on
   genuine clinical rows (measured on teatea), and an allowlist would silently drop them and make a
   receiver recalculate LOW. Fail closed on retraction, open on ambiguity.
3. **An identifier was used as a patient name.** `employeeById` knows only the synthetic catalog, so a
   live subject's name became `wc|123`. The name (and birth date) now come from the FHIR Patient first —
   which is the better source regardless, being the record the measure was computed from.
4. **Roster-derived evidence: review asked us to re-stamp; we do not.** The pipeline evaluates
   `stampEnrollment(bundle, …)`, which overlays a roster enrollment Condition and — for cms125 — a
   **synthesized CPT 99213 Encounter**, because WebChart supplies none (ADR-042). Re-applying it at
   export would make a receiver reproduce our answer, which is a real benefit. We decline it: a QDM
   `Encounter, Performed` asserts a clinical encounter **happened**, the roster's did not, and a
   receiver cannot tell which entry was inferred. That is precisely ADR-037's normalization-not-
   fabrication rule, inside a regulatory artifact. So the document exports real data only and **names
   the omission**, in the section text and in a `caveats` array on the response. The cost is stated
   rather than hidden: a receiver recalculating from these entries alone may place the subject outside
   the initial population we scored them in.

   **`caveats` is deliberately a separate axis from `conformant`.** A document omitting roster evidence
   is still a structurally valid QRDA I; folding the two together would mark every live cms125 document
   non-conformant for something no validator would ever raise, and would make one boolean mean two
   different things.

**A second review pass changed what the headline number MEANS, and four more defects.**

- **The partition was too coarse, and it could hide a broken document.** Classifying every `CONF:CMS-*`
  assert as "not our bar" is wrong for two families that carry CMS numbers while binding *any* conformant
  CDA: **CMS_0105–0113** (HL7 abstract datatype rules — `@value` xor `@nullFlavor`, non-empty `ST`, …)
  and **CMS_0115–0120** (NPI/TIN validity, including the Luhn checksum). Demonstrated on the real
  artifact: a lab result emitted as `<value xsi:type="PQ" value="not-a-number" nullFlavor="NI"/>` tripped
  only `a-CMS_0110` and was reported as **0 base-HL7 errors, exit 0** — the number quoted in three
  documents. Now classified as base, and the script exits non-zero. Kept OUT of that list on purpose:
  **CMS_0121** ("a UTC offset should not be used anywhere in a QRDA Category I"), which directly
  *contradicts* base HL7's CONF:81-10130 ("SHOULD include time-zone offset") — the clearest evidence the
  partition is doing real work. The classifier now also reads every `CONF:` reference in a message rather
  than the first, prefers the SVRL `role`/`flag` over guessing severity from the assert id, and reports
  anything it cannot classify as an error rather than silently dropping it.
- **One malformed date or numeric id 500'd the whole export.** `hl7Ts` throws by design and `esc` called
  `.replace` on its input; both now see third-party FHIR. A MariaDB zero-date on subject 200 of 500 lost
  all 500 documents. Each resource is now translated inside its own try/catch, `esc` coerces, and
  `hl7TsOrNull` degrades one field to `nullFlavor` — which is what the module's own docblock had claimed
  ("skipping the item loses one") while implementing it for structural junk only.
- **The retraction guard could not fire for Conditions.** FHIR `Condition` has no `status`; retraction is
  `verificationStatus`. So a retracted diabetes diagnosis still became a `Diagnosis` with
  `statusCode="completed"` — the datatype CMS122's denominator is built on. The vacuous-guard shape, in
  the fix for the previous vacuous guard.
- **`effectiveTime` had a dead branch and two lossy ones**: an `abatementDateTime` fallback unreachable
  for every mapped type, a period carrying only `end` silently discarded, and `Condition.onsetPeriod`
  never read.

**Consequences.**

- QRDA I now depends on the subject's FHIR bundle at export time, supplied only where the stack can
  really re-read it (a WebChart-configured seam). The synthetic default exports non-conformant documents
  that say so. Bundles are read **as of now**, not as of the run — making it as-evaluated means
  persisting bundles, which is a schema change and the owner's call.
- **`loadBundles()` crawls the whole tenant**, sequentially, uncached, and is not scoped to the run's
  subjects — `MAX_INDIVIDUAL_REPORT_SUBJECTS` bounds the documents, not the fetch. Fine on the dev
  fixture; this is the request that times out on a production-sized tenant. Scoping it needs a by-id read
  the transport does not expose. Recorded here rather than discovered later.
- The Schematron is **not vendored** (585 KB of yearly third-party artifact) and is **not fetched
  automatically either** — it is downloaded by hand from ecqi.healthit.gov and hash-checked, with a
  mismatch warning rather than a refusal. That is weaker than ADR-036's build-time fetch pinned by a
  committed manifest, and this ADR previously described it as if it were the same thing. The script is
  **not in CI**: it needs Python + lxml, which must not become backend-ts dependencies. The structural
  regressions it would catch are pinned in TypeScript instead, each assertion citing the CONF number it
  stands for.
- **The measured numbers are for ONE document per state**, generated from a hand-built bundle — not a
  sweep of an endpoint response. Evidence: `docs/evidence/QRDA1_SCHEMATRON_2026-07-31.md`.
- **PHI posture, for the owner rather than a defect.** This endpoint's sensitivity changed materially: it
  used to emit population flags and now emits per-patient diagnoses, lab results, procedures and
  encounters as CDA. It sits behind the global JWT middleware with no role gate and writes no audit
  event — consistent with the other export endpoints, so no rule is breached, but the right frame for
  deciding that is `docs/PRODUCTION_READINESS_2026-07.md`, not inheritance.
- **Still open:** QRDA I **import** does not exist, and **Cypress CVU+ has not run** — it needs Docker
  and remains the M-B bar. Nothing here may be described as certified or CVU+-validated.

---

## ADR-049: QRDA Category I exists, reports population membership only, and says so in the document

**Superseded — full text in [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md#adr-049).** Its central claim was wrong and ADR-050 says so. Kept as the record of how the error was found.

## ADR-048: The TRANSLATOR debt is paid; the CLI-surface debt is not, and the split is not a file move

**Historical finding — full text in [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md#adr-048).** Half of an extraction debt paid; the other half turned out smaller than recorded (see ADR-059).

## ADR-047: A measure is onboarded when its MADiE gate is green — vendoring is not onboarding

**Status:** Accepted (2026-07-30). Roadmap M-A. **CMS2, CMS68 and CMS951 are vendored, gated and
ROUTABLE.** None is routed; `WORKWELL_OFFICIAL_MEASURES` still names only cms122 + cms125.

**Context.** With cms122 and cms125 running CMS's published artifacts in production, the remaining six
priority measures were meant to follow. Vendoring all six took minutes. Deciding which could actually be
onboarded took the gate — and it disqualified half of them, for three different reasons.

| measure | outcome |
|---|---|
| **CMS2** depression screening | **36/36** — onboarded |
| **CMS68** current medications | **19/19** — onboarded |
| **CMS951** kidney health eval | **55/55** — onboarded |
| CMS138 tobacco screening | **0/47, 47 errors** — one value set (…3.526.3.1278) will not expand |
| CMS130 colorectal screening | capped `AdvancedIllness` expansion — needs the VSAC key |
| CMS165 controlling high BP | **two** capped expansions — needs the VSAC key |

**Decision.**

1. **Onboard exactly the three the gate passes.** A vendored artifact is not evidence of anything; the
   MADiE deck is. CMS138 vendors cleanly, loads cleanly, and produces **47 errors out of 47 cases** —
   there is no version of "ship it and watch" that improves on not shipping it.
2. **CMS130 and CMS165 are not vendored at all, rather than vendored-but-capped.** Both need
   `--complete-capped-expansions` with `WORKWELL_VSAC_API_KEY_VENDOR`, which exists only as a GitHub
   secret. Committing a capped artifact would put a permanently-unroutable measure in the tree whose
   manifest CI would then rewrite the moment it was added to the vendor list — reproducibility churn for
   an artifact nobody can use. They wait for a credentialed vendoring run (an owner step, exactly as
   ADR-041's "Step 1a" was for cms122/cms125).
3. **The gate harness is driven by `OFFICIAL_GATED_MEASURES`, not by a hardcoded pair.** `parseArgs`
   defaulted to `["cms122", "cms125"]` and rejected anything else; the sparse checkout fetched two
   measures' cases; the committed-report predicate was `measures.length === 2`. Every one of those
   silently stopped meaning "the full gate" the moment a third measure existed — the report predicate
   most dangerously, since a full run would have written nothing and CI's staleness check would compare
   a five-measure run against a two-measure file.
4. **The compared population vector now includes DENEXCEP.** *(Added after review, #358.)* The gate
   compared IPP/DENOM/DENEX/NUMER only. **CMS68 declares no `denominator-exclusion` at all** — its
   populations are IPP, DENOM, NUMER, DENEXCEP — so the gate was comparing a population the measure does
   not have while ignoring the one it does; CMS2 declares both and the exception was ignored there too. A
   green 19/19 could therefore coexist with broken exception handling, which flows into the runtime
   EXCLUDED outcome and into MeasureReport/QRDA (`denexcep` leaves the effective denominator, so it moves
   the score). Not hypothetical arithmetic: **9 of the 55 expected reports carry a non-zero DENEXCEP**,
   and forcing the actual value to zero drops CMS2 to **28/36** and CMS68 to **18/19**. It was green
   before that mutation and after it — which is the definition of a check that was not being made.
   cms122/cms125 declare no exception, so both sides are 0 and their decks are unchanged.
5. **`OfficialMeasureId` is derived from the gate map** (`keyof typeof MEASURES`) rather than hand-listed
   as a union. The union had to be edited in a second place, and forgetting was a compile error at best
   and a silently ungated measure at worst.
6. **An EPISODE-OF-CARE measure is refused at construction — so CMS68 is gated but NOT routable.**
   *(Added after review, #358.)* CMS68 declares `populationBasis: "Encounter"`: one patient with N
   qualifying encounters is N denominator units, and `outcomeFromPopulations` maps exactly one boolean
   vector per **subject**. Routing it would collapse four office visits into one outcome, so
   MeasureReport would count subjects where the measure counts encounters — a wrong denominator with
   nothing to signal it.

   **The MADiE deck provably cannot catch this**, which is why it needed a refusal rather than a note:
   all 19 CMS68 cases have a max expected count of 1 for every population, and not one subject produces
   more than a single episode. `19/19` is evidence about single-encounter patients, and a green gate over
   exactly the shape that hides the defect is the most dangerous kind. Episode support is unbuilt;
   `officialRoutingProblems` now says so at construction. cms2 and cms951 are `populationBasis: boolean`
   and stay routable.
7. **Nothing is routed by this change.** Routable and routed stay separate steps: these three have no
   authored counterpart, so a flip has no oracle to be compared against, and `flip-snapshot`'s
   authored-vs-official comparison — the thing every flip so far has been judged on — cannot run for
   them. What that comparison should be replaced by is the open question the next flip has to answer.

**Consequences.**

- **The gate now covers five measures: 231/231** (55 + 66 + 36 + 19 + 55), 0 unexpected, 0 errors, and it
  is a permanent CI gate for all five.
- **Three routable measures with no authored implementation is a new state**, and the roster/catalog do
  not yet model it: `MEASURE_BINDINGS`, the measure registry and the compliance grid all assume an
  authored measure exists. That is why this PR stops at routable. Onboarding the *product* surfaces is
  separate work from onboarding the *artifact*.
- **CMS138's failure is recorded, not hidden.** One value set will not expand from the artifact's own
  terminology. Whether that is an upstream packaging gap or something our reducer drops is unknown; the
  gate says only that the measure cannot be executed today, which is enough to keep it out.
- **Two measures now depend on an owner step**, and the dependency is narrow and stated: a credentialed
  `pnpm vendor:official --complete-terminology` run for CMS130 and CMS165 — and, since ADR-053, for
  CMS138 too, which needs the wider behaviour only the new flag name describes (the old
  `--complete-capped-expansions` still works but would read as if the narrower behaviour were what
  is wanted).

## ADR-046: Canonical, improvementNotation and membership all derive from the outcome's own evidence

**Status:** Accepted (2026-07-30). Discharges the PR-7 obligation `fhir/measure-report.ts` has carried
since PR-3, and unblocks routing **cms122** (PR-9c shipped cms125 alone because of this).

**Context.** PR-3 made MeasureReport membership *evidence-first*: an official-routed outcome's populations
come from `evidence.official.populationResults`, which is the regulatory truth. But two sibling fields
stayed static — `measureCanonical` always emitted `urn:workwell:measure:<id>`, and `improvementNotation`
always read the authored `MEASURE_BINDINGS` table. The file wrote the consequence down itself:

> *"A report that declares higher-is-better over a poor-control numerator is self-contradictory, so the
> measure that flips MUST switch all three together — canonical, improvementNotation, and membership."*

For cms122 this is not cosmetic. Its official numerator is **poor glycemic control** — being in it is the
failure — so `improvementNotation: increase` asserts higher-is-better about a numerator counting harm. On
the 150-employee directory the numerator moves **~120 → ~27**. QRDA III carries **no `improvementNotation`
element at all**, so there the inverted count would ship with nothing marking it.

The guard that supposedly pinned this could not fail: its fixtures carried no official evidence, so it
only ever exercised the authored path. Review of #356 caught that PR-9c was the flip obliged to discharge
this and had not — which is why cms122 was held back and cms125 flipped alone.

**Decision.**

1. **All three derive from the outcome's own `evidence.official`.** Not from the environment: a report
   describes the run it is built from, and a run's provenance does not change because someone later
   flipped a flag or re-vendored. Asking `WORKWELL_OFFICIAL_MEASURES` at export time would mislabel every
   historical export the day the config moves — the same reasoning `aggregateCountsForRun` already
   applies to counts.
2. **`improvementNotation` comes from `OFFICIAL_MEASURE_SEMANTICS`, not from the artifact.** For cms122
   the artifact itself says `increase`, which contradicts eCQI's own description of the measure;
   `official-measure-semantics.ts` records that human-reviewed decision with its rationale. A routed
   measure with no recorded semantics emits the greppable `WORKWELL_ALERT` rather than guessing — there is
   no safe default, since guessing one way reports every failure as compliant.
3. **The canonical is claimed only for the artifact that actually produced the outcome.** If the vendored
   artifact's `sha256` no longer matches the `artifactSha256` in the evidence — a re-vendor between run
   and export — the report falls back to `urn:workwell:measure:<id>:official:<version>`. Labelling an old
   report with a new canonical would assert a provenance that never existed.
4. **QRDA III gets the official measure IDENTITY, not a new element — and specifically the eMeasure
   UUIDs.** QRDA III has no notation field by design; a receiver derives direction from the measure
   identity. So emitting `urn:workwell:measure|cms122` over counts whose numerator is CMS's poor-control
   one is the actual defect. *(Corrected after review, #357: the first version emitted
   `manifest.cmsId` — `"122FHIR"` — which is the **publisher** identifier and resolves to nothing.)* The
   published Measure carries the two identifiers a receiver actually resolves, typed by
   `artifact-identifier-type`: the **version-specific** UUID as `id/@extension` under the eMeasure
   Identifier root `2.16.840.1.113883.4.738`, and the **version-independent** UUID as `setId/@root`, plus
   `versionNumber`. They are read from the vendored **bundle** rather than the manifest, so no re-vendor
   and no reproducibility-gate churn is needed — the bundle IS the published artifact. If they are absent
   the export falls back to WorkWell's urn: a wrong official identity is worse than an honest local one,
   because a receiver would resolve it to the wrong measure. The counts were already correct.
5. **The flip guard asserts the BUILT REPORT, not the binding table.** ADR-046 moved the source, so
   comparing `MEASURE_BINDINGS` would now check the wrong thing — the authored binding still says
   `increase` for cms122 and correctly so. `official-flip-config.test.ts` builds a summary report from a
   synthetic official outcome for every shipped measure and asserts the notation matches the semantics.

**Consequences.**

- **cms122 is now routed** alongside cms125 on the demo/production stack. Its MeasureReport declares
  `decrease` and CMS's canonical; its QRDA III carries the official eCQM identity and version.
- **Authored reports are byte-identical.** Every non-routed measure takes the same path it always did —
  the trio only moves when `evidence.official` is present.
- **A mixed-provenance run labels itself by the artifact its scored subjects used.** A run where some
  subjects errored (no `official` block) still names the artifact the rest were scored by. That is a
  deliberate choice over labelling the whole report authored, and it matches the mixed-provenance
  trade-off `membershipFor` already documents.
- **The scale/aggregate path is unchanged and still authored-only.** `populationCountsFromStatus` reduces
  status buckets, which are authored semantics by construction; its caller passes no identity. That path
  is `seed:scale` demo data, never official-routed, and `aggregateCountsForRun` routes official runs to
  the per-subject path instead.
- **Four consumer surfaces were saying the wrong thing about a routed cms122 patient, and are fixed
  here** *(added after review, #357 — the original consequences list called these "UI-surface work,
  tracked separately", which understated two of them badly).*
  - **The CQL Evidence Explorer inverted the colours.** Its `INTERNAL_DEFINES` hide-list matches the
    capitalised authored names exactly, and official defines are `official:numerator` — lowercase and
    prefixed — so the prefix chosen to make them *honest* is what defeated the filter. Rendered through
    the generic true/false chips, a cms122 patient in the numerator got a **green ✓ true** under a
    heading reading "Why Flagged". Green meant "this patient's diabetes is uncontrolled". Population
    membership is neither good news nor bad news, so it now renders on its own path as a neutral
    **in / not in** chip with the population spelled out.
  - **The MCP `explain_outcome` tool asserted a recency finding that cms122 does not compute.** The
    sentence was unconditional concatenation, so a routed outcome produced *"their last qualifying exam
    was unknown date (unknown days ago), which exceeds the 365-day compliance window"* — no recency rule
    exists, no window was exceeded, and the 365 came from the authored binding. Asserted to an external
    client, labelled deterministic, no human in the loop, and the only path rather than a fallback. The
    clause is now conditional, and official outcomes state population membership instead.
  - **The outcomes CSV stamped the authored library version.** `measureVersion` answers "what computed
    this", and the CSV is what people mail around; it read `2.0.0` for rows CMS122FHIR **v1.0.000**
    produced. It now reads `evidence.official.version` when present — the same evidence-first rule this
    ADR applies to MeasureReport and QRDA. The **cases** CSV still shows the authored version and says so
    in a comment: a case row carries no evidence, and it is an operational worklist keyed on `lastRunId`.
  - **The catalog described cms125 as "women 50–74".** Both the authored subset and the official IPP are
    **42–74**. Pre-existing, but it is the Studio Spec-tab copy an operator reads beside outcomes the
    artifact now produces.
- **Genuinely still deferred:** the **fidelity/Standards tab**. Verified NOT vacuous — `routes/measures.ts`
  constructs its own `CqlExecutionEngine`, so it still runs the authored engine and the comparison is
  real. What is stale is `literal-diff.ts`'s disclaimer, which says the diff "forecasts the flip rather
  than describing a configuration that will never exist"; the flip has happened, so it now forecasts the
  present. Wording only.
- **One low-severity item recorded rather than fixed:** `case-detail-read-model.ts`'s unanchored
  `/waiver|exemption|exclusion|contraindication/i` matches `official:denominator-exclusion`, mapping DENEX
  to `waiver_status: "active"`. For cms122/cms125 that DENEX genuinely is hospice/palliative/mastectomy,
  so the result is roughly correct — but the adapter's safety comment reads as an exhaustive argument
  about which matchers the `official:` prefix avoids, and it is not exhaustive.

## ADR-045: The flip is a WORKFLOW edit, gated by tests that read what the workflow ships — and cms125 goes alone

**Status:** Accepted (2026-07-30). Roadmap §7.4 PR-9c. **cms125 now evaluates CMS's published QI-Core
artifact on the demo/production stack.** cms122 is routable and agrees with authored, but is held back
until its reporting trio is discharged (decision 1) — so M-A is complete for one of its two ready
measures, not both.

**Context.** Everything since ADR-036 built toward one configuration change. The machinery was complete
and dark: artifacts vendored at v1.0.000, terminology pinned by SHA-256 and completed from VSAC, a
per-measure router with construction-time validation, measure-major batching, an engine-declared
`logic_version`, and a MADiE gate at 121/121. `WORKWELL_OFFICIAL_MEASURES` was unset everywhere, so
`routedEngineForEnv` returned the authored engine *by identity* and no measure had ever been routed.

Two things made the flip decidable rather than a leap. The **mammography numerator gap** closed
(ADR-044), which was the last known way official could contradict authored on data this stack holds. And
`pnpm flip-snapshot` turned "confirm a non-zero initial population" from a prose instruction into a
measurement: both measures admit **5 of 5** corpus subjects to the official initial population and agree
with the authored engine on every one, across COMPLIANT / OVERDUE / EXCLUDED.

**Decision.**

1. **Flip cms125 ONLY.** *(Narrowed from "cms122 + cms125" after review, #356.)* cms122 is routable, and
   ADR-043 decision 6 correctly established that its stack-dependent WebChart blindness does not bind
   here — `deploy-twh-mieweb.yml` carries **no** `WORKWELL_WEBCHART_*`, so this stack evaluates the
   synthetic roster where cms122 scores across all five corpus targets. A **different** blocker stops it:
   its official numerator means **failure** (`numeratorMeansCompliant: false` — HbA1c > 9% or no
   assessment), while `measure-bindings.ts` still declares `improvementNotation: "increase"` and
   `measure-report.ts` still emits the WorkWell canonical. `measure-report.ts:246-252` had already written
   this down as a **PR-7 obligation** — "the measure that flips MUST switch all three together" — and
   PR-9c was the flip that had to discharge it and did not. Routing cms122 would ship a MeasureReport
   declaring higher-is-better over a poor-control numerator (~120 → ~27 on the 150-employee directory),
   and QRDA III carries **no** `improvementNotation` field at all, so the inverted count would go out
   unmarked. cms125's trio is already consistent, so it flips alone; cms122 follows once the trio is
   discharged. **Enforced, not remembered:** `official-flip-config.test.ts` fails if a measure whose
   official numerator means failure is shipped with `increase`. Staging is unchanged.
2. **The flag is set in the WORKFLOW, not on the container.** `CONTAINER_ENV_VARS_JSON` is a fixed `jq`
   array and the deploy deletes-and-recreates the container, so a hand-set value is wiped on the next
   deploy. This makes the flip a reviewed, merged, revertable change rather than an operator action —
   which is the right shape for something that changes what the compliance engine *is*.
3. **A test reads what the workflow ships and refuses an unroutable configuration.** Every existing check
   validated a configuration passed in by a test; nothing validated the string that reaches production.
   `official-flip-config.test.ts` parses `WORKWELL_OFFICIAL_MEASURES` out of both deploy workflows and
   asserts every id named is MADiE-gated, vendored, proportion-scored, and — with the sidecar — produces
   no `officialRoutingProblems` at all.
4. **That test is split in two, deliberately.** The structural half is pure and always runs; the
   terminology half needs the gitignored sidecar, self-skips without it, and is wired into CI's
   `official-cases` job. A single test would have self-skipped in `pnpm test` and read as covered — the
   defect class this branch has been pulled up on four times (#350, #352, #354, #355).
5. **The reconciler ships the SAME value, and a test asserts it does.** *(Added after review, #356.)*
   `reconcile-twh-mieweb.yml` recreates twh-api-ts from `:latest` on a health event, using its own
   mirrored env array. It did not carry `WORKWELL_OFFICIAL_MEASURES`, so the **first self-heal after this
   flip would have silently reverted both measures to authored CQL** — container healthy, image
   unchanged, no signal at any layer. The two workflows must agree on the *value*, not merely both
   mention the flag: a reconciler shipping a different subset would flip measures on or off during an
   incident nobody initiated.
6. **The routability assertion excuses capped expansions when — and only when — the tree is capped.**
   Fork and Dependabot PRs get no VSAC secret, so CI deliberately re-vendors without
   `--complete-capped-expansions` and the working-tree artifacts become capped. `officialRoutingProblems`
   refuses a capped expansion by design (ADR-041), so an unconditional assertion would have failed every
   outside contributor's PR for a condition unrelated to their change. Every other problem class is
   asserted always; the credentialed run on merge covers the capped class for real.
7. **Every workflow `run:` block is syntax-checked in CI.** *(Added after review, #356 — this PR shipped
   a broken production deploy step and nothing could see it.)* The flag was added inside a `jq` program
   that lives in a **single-quoted shell string**, and the surrounding comment contained apostrophes
   (`CMS's`, `WorkWell's`). The first one CLOSED the quote and turned the whole step into a bash syntax
   error. Deploy workflows only run on push to `main`, so no PR check could catch it; the new
   `official-flip-config.test.ts` passed 3/3 because it validates the *semantics* of a line the shell
   would never execute; and verifying by extracting the jq program and running it standalone — which is
   what was done — bypasses the shell quoting entirely. The program was always fine; the string
   containing it was not.

   The second-order effect is why this warranted a guard rather than a fix. `build-backend-ts` would have
   succeeded and pushed a new `:latest`; the deploy step would have died *before* the delete/recreate, so
   the live container survives on the old image; and then the 15-minute self-heal reconciler — which now
   carries the flag and parses cleanly — would have recreated it from the new `:latest`, **delivering the
   flip unattended through a path nobody reviewed as the delivery mechanism, while the deploy pipeline was
   red.** Exactly the silent-delivery class this PR exists to prevent.
   `.github/scripts/workflow-run-blocks.test.sh` now `bash -n`s all 54 run-blocks in the `deploy-helper`
   CI job. It carries a minimum-block floor, because its own first version reported "all parse" after
   checking **zero**.
8. **The test does not pin WHICH measures are flipped.** Asserting the literal value would make every
   future flip a two-file change guarded by a test that only says "you changed what you changed". The
   property that matters is that whatever is shipped is **routable**.

**Consequences.**

- **The flip is inert on this stack's data, and that is the expected result, not a disappointment.** No
  roster row changes. The value is that official execution is now *running in production* — the
  precondition for onboarding the remaining six priority measures, and for any claim that WorkWell
  executes published eCQMs rather than reimplementing them.
- **A misconfiguration does NOT refuse at boot.** The throw is at engine construction, per request, while
  the deliberately DB-free `/actuator/health` keeps answering 200 — so the container reads green, the
  self-heal reconciler stays quiet, and every evaluating route 500s. `worker.ts` logs
  `OFFICIAL_ROUTING_MISCONFIGURED` on the first request; that log line is the signal, and the post-deploy
  checklist says to grep for it rather than trust the health probe.
- **The nightly scheduler exercises this without anyone asking.** `WORKWELL_SCHEDULER_ENABLED=true` on
  this stack, so the first scheduled `ALL_PROGRAMS` run after the deploy evaluates both measures
  officially. Verification cannot wait for someone to click a button.
- **Deploys are now coupled to NLM VSAC availability** for these two measures — already true since
  ADR-041, but it bites harder now: the vendor step fails closed, the reproducibility gate fails the
  deploy, and rolling *forward* during a VSAC outage is blocked (rolling back to a pre-ADR-041 image
  still works). DEPLOY.md "Step 1a" records this.
- **Rollback is one line and a redeploy.** `logic_version` carries the artifact identity (ADR-040), so
  flip-on, flip-off and re-vendor each invalidate `eval_state` by construction — no manual cache `DELETE`,
  and no possibility of serving an authored outcome for a routed measure.
- **The authored cms125 subset is now dead weight in the catalog** and retires to the fidelity lab per
  locked owner decision #4 — after the flip is observed running, not in the change that starts it. The
  authored cms122 subset is still LIVE and must stay until cms122 itself flips.
- **What this does not establish.** The oracle is our own authored engine, so agreement means the flip
  changes nothing for this data — not that either engine is correct. The external check remains the MADiE
  gate, which runs over CMS's test patients rather than ours. **Cypress CVU+ has not run** and stays the
  verification bar (M-B).


## ADR-044: One real mammogram is emitted in BOTH vocabularies — dual-stamping is normalization, and the flip gate gets a command

**Status:** Accepted (2026-07-30). Roadmap §7.4 PR-9 (the numerator prerequisite to PR-9c). Nothing routes
officially yet.

**Context.** ADR-042 closed the WebChart↔official *initial population* gap and left the **numerator** gap
open, with the failure direction recorded as the dangerous one. The two engines retrieve different FHIR
resource types for the same clinical fact:

| | retrieves | value set |
|---|---|---|
| authored `cms125.cql` | `[Procedure: "Mammography"]` | includes CPT / HCPCS |
| official CMS125 ELM | `isDiagnosticStudyPerformed([Observation: "Mammography"])` — additionally requires `status in {final, amended, corrected}` **and** `exists(category ~ imaging)` | **92 LOINC codes and nothing else** |

WebChart records a mammogram as a CPT/HCPCS **procedure** (`77067` / legacy `G0202`). Measured: one
crosswalk-shaped mammogram → authored COMPLIANT, official **OVERDUE**. That is a *false non-compliance on
an already-screened woman*, and `case-logic.ts` escalates it to a HIGH-priority "escalate mammogram
follow-up immediately". A confident wrong answer on the ordinary case — worse than the out-of-population
read ADR-043 handles, because nothing detects it: those subjects **are** in the initial population, so the
ADR-043 WARN is silent by design.

Neither representation alone works, and they fail in **opposite directions** — the Procedure clears
authored and not official; a LOINC Observation clears official and not authored; and a LOINC Observation
*without* `category` clears neither, which is the trap in the obvious fix.

**Decision.**

1. **The crosswalk dual-stamps.** A screening-mammogram procedure row emits the CPT/HCPCS `Procedure` it
   always did **and** a LOINC `Observation` (`24606-6`, a verified member of the official value set)
   carrying `category ~ imaging` and `status = final`. Both mapping sites change —
   `wcdb-fhir-shim/src/fhir-mapping.ts` and the by-design duplicate
   `backend-ts/scripts/webchart-devdb-export.ts` — exactly as `us-core-sex` did in ADR-042.
2. **Served from `/Observation`, and `/Procedure` is untouched.** The derived resource appears where its
   FHIR type says it belongs, so the authored engine sees byte-identical input to before. Dual-stamping
   **adds** a representation; it never moves or replaces one.
3. **This is normalization, not fabrication (ADR-037).** No clinical event is invented — one real,
   recorded mammogram is expressed in the two vocabularies the two engines read, which is what the
   synthetic corpus has done since ADR-038. Three properties keep that honest, each tested:
   - **derived strictly from a real row** — no procedure row, no Observation; the date is the procedure's
     own, never today's;
   - **an explicit allowlist, not a category sweep** — only codes that mean "a screening mammogram was
     performed" dual-stamp, so an unrelated CPT can never mint a diagnostic study;
   - **non-inflating** — both numerators are `exists(...)`, so one event in two vocabularies is still one
     event. **This would NOT be safe for a counting measure — nor for a most-recent-value one.** `cms122.cql`
     does a bare unfiltered `Last([Observation] …)` and reads `.value`; a valueless Observation that
     became "most recent" drives it to a falsely-COMPLIANT outcome, and `Status.isLaboratoryTestPerformed`
     has no category gate, so the `imaging` category protecting CMS125 protects nothing there. Today the
     only barrier is value-set membership, which is runtime-resolvable. Stated in
     `WEBCHART_FHIR_MAPPING.md` §3.6 rather than left to be rediscovered.
4. **The flip gate gets a COMMAND: `pnpm flip-snapshot`.** ADR-043 moved enforcement onto "the flip gate",
   and review of #354 made the fair objection that the half which can see a tenant — confirm a non-zero
   initial population (step 2), take a before/after distribution snapshot (step 4) — shipped as prose with
   no command, no tooling and no artifact. That is the vacuous-guard shape this branch has now been pulled
   up on three times. The CLI evaluates a measure both ways over the same bundles and reports the before/
   after distribution, the official IPP count, and every subject whose roster row would change.
5. **The snapshot reads the CONFIGURED TENANT, not a fixture.** *(Corrected 2026-07-30 after review.)* The
   first version's `--source webchart` always loaded the committed 56-patient sample, so the command
   DEPLOY.md sends an operator to for "confirm a non-zero initial population against the tenant's own
   data" could not see a tenant at all — a tenant whose live mapping still omits `us-core-sex` would have
   received a healthy verdict computed from our frozen fixture (Codex, #355). A gate that cannot see the
   thing it gates is the exact failure this tool exists to stop. `--source live` now reads
   `WORKWELL_WEBCHART_*` over the real ingress path and **refuses loudly when the seam is unset** rather
   than falling back; the frozen sample is `--source fixture`, named so nobody reaches it by accident.
6. **`--source live` requires `--roster`, and refuses a roster that enrolls nobody.** *(Added after
   review, #355 — this was the most serious defect in the PR, and my own fix for the finding above
   introduced it.)* The committed `enrollment-roster.json` is keyed by the dev-DB's `wc-N` ids, and
   `stampEnrollment` is a **silent no-op** for any subject absent from the roster. Pointed at a real
   tenant it would enroll nobody, so the OH roster's synthesized CPT-99213 Encounter — the conjunct
   authored CMS125's `Has Qualifying Visit` depends on — would never be stamped, `authoredActionable`
   would collapse to ~0, and the report would print **"the flip is inert rather than wrong"** for a tenant
   whose official roster reads empty. A **false all-clear on precisely the configuration ADR-042/044
   document as broken**, and the DO-NOT-FLIP verdict is the tool's whole reason to exist. `live-cli.ts`
   has always required `--roster`; this now does too.
7. **The report NAMES its source under every measure.** `--source synthetic` is **five designed corpus
   probes**, one per intended outcome — *not* the synthetic employee directory the demo/production stack
   evaluates through the run pipeline, and the five collapse into three buckets because `DUE_SOON` and
   `MISSING_DATA` both score OVERDUE. It is the right default (the cheapest way to ask "do the two engines
   agree across the outcome space", which is what a flip turns on) but it is **not a roster forecast**,
   and an earlier draft of DEPLOY.md said it was. Only `--source live` produces a roster forecast.
8. **The official side is evaluated batch-then-fallback, exactly as a run evaluates it.** `evaluateBatch`
   omits a subject it returned nothing for and the run pipeline re-evaluates each one individually; a
   snapshot that skipped that step would not forecast the run it claims to forecast, and a roster whose
   omitted subjects DO qualify could report zero-in-IPP and earn a spurious DO-NOT-FLIP. Also review
   (#355) — and the same incomplete-roster mistake ADR-043 decision 2 records, which suggests "did you
   model the omission fallback?" belongs on the checklist for anything reading `evaluateBatch`.
9. **The snapshot renders a verdict but gates nothing**, and exits 0 even on DO-NOT-FLIP. The judgement it
   supports is the one ADR-043 established a machine cannot make from shape alone. What it *can* do is
   compute the comparison a human needs: `authoredActionable > 0 && officialInIpp === 0` means the cohort
   is not the explanation. Where both engines find nobody it reports **INCONCLUSIVE** rather than picking
   a side. Wiring it into CI as pass/fail would re-assert exactly the automated judgement ADR-043 rejected.

**Consequences.**

- **The last numerator blocker to PR-9c is closed.** Measured after the change: a dual-stamped mammogram
  makes both engines report COMPLIANT, and all four failure states stay pinned as tests — three of them
  are the ways a future "simplification" would silently reopen the gap.
- **The committed fixture moved by exactly one resource.** Its only mammography record (wc-49, HCPCS
  `G0202`, 2015) belongs to a 33-year-old outside the `[42..74]` IPP, so **no outcome changed** — which is
  precisely why the dual stamp is asserted directly rather than inferred from an unchanged distribution.
- **Measured with the new tool, and it confirms the flip list.** On the **synthetic** roster the
  demo/production stack evaluates, cms122 and cms125 both admit **5 of 5** subjects to the initial
  population and agree with authored on every one. Over **WebChart** data cms125 admits 4 of 56 and agrees
  on all 56, while cms122 admits 0 of 56 and reports INCONCLUSIVE — a data gap (zero Conditions in the
  seed), not a divergence. Consistent with ADR-043 decision 6: cms122's routability is stack-dependent and
  it stays in the flip list.
- **The fixture was NOT re-exported from the dev DB** — Docker was unavailable, so the generator's own
  insertion rule was replayed over the committed artifact and the diff verified to be exactly the 28 lines
  of one added Observation. A re-export when the dev DB is up should be a no-op; if it is not, the
  generator and the fixture have drifted and the fixture is wrong.
- **Three copies of the mapping now exist** (shim, export script, and the test's injected shapes), and
  **no drift guard covers the pair that matters.** *(Corrected after review, #355.)* `hapi-live.test.ts` is
  named as that guard here and in two code comments, and it demonstrably cannot be one: it loads a HAPI
  server from the committed fixture and compares against the same committed fixture, so both sides
  originate from one file — it never runs the export script's SQL and never touches the shim. The
  `us-core-sex` docstring had already retracted the same claim for its own field; reasserting it
  un-caveated for mammography was a regression in load-bearing safety documentation, which is the kind
  that gets believed later. What actually guards this today is `devdb-official-eval.test.ts` asserting the
  dual stamp on the committed fixture — covering the **export script only**; the shim side is covered by
  its own unit tests against a stubbed DB. A genuine shim-vs-generator comparison does not exist, and the
  honest place to remove the need for one is M-C's package extraction, not a cross-package import ADR-034
  forbids.
- **What this does NOT close:** the live third-party path still supplies neither `us-core-sex` nor
  dual-stamped mammography, because both mapping sites sit upstream of the live FHIR transport and
  `normalizeWebChartBundle` is untouched by design. For a real WebChart tenant the gap is open exactly as
  ADR-042 consequence 5 describes. Cypress CVU+ remains the verification bar and has not run.


## ADR-043: A whole roster out of the initial population is SURFACED at runtime and ENFORCED at the flip gate — never refused mid-run

**Status:** Accepted (2026-07-30). Roadmap §7.4 PR-9 (the PR-9c precondition). Nothing routes officially yet.

**Context.** ADR-042 consequence 5 recorded a limit it could only assert in prose: both `us-core-sex` mapping
fixes sit upstream of the live FHIR transport, so a third-party WebChart FHIR server still supplies no
extension and its whole roster reads out-of-population for official CMS125 — silently, as 100% MISSING_DATA
rather than an error. `deploy-staging-mieweb.yml` sets `WORKWELL_WEBCHART_BASE_URL`, so staging is exactly
where official routing and a live seam can coexist.

PR-8f's batch retrieve refusal cannot catch this, and that is measured rather than argued: official CMS125
matched **236 LOINC Observations** on the WebChart fixture and still put all 56 subjects out of the initial
population, because the IPP also reads the extension. `retrieveSignal` was true throughout. The refusal
catches *retrieved nothing at all*; this is *retrieved the wrong thing*, which ADR-038 established it is
blind to.

**The first version of this ADR got the remedy wrong, and the reason is worth keeping.** It refused inside
`evaluateBatch` — a batch of >1 with nobody in the IPP threw, reaching the run pipeline's existing
batch-failure isolation. Review (Codex P1) showed that **converts a valid result into corruption.** For a
site- or program-scoped CMS125 run over an all-male cohort, zero-in-IPP is the *correct* answer. A batch
failure re-throws per subject, so every outcome becomes MISSING_DATA carrying an `evaluationError` **in place
of** its `official.populationResults` evidence — the blob MeasureReport and QRDA read (ADR-031) — the run
terminal becomes `PARTIAL_FAILURE`, and the #264 alert fires. A zero-denominator MeasureReport is a
legitimate, reportable artifact, not an engine failure.

The decisive argument is that **cohort composition varies by run**, so "stop routing this measure" is not a
remedy an operator can apply: the same measure over the same tenant may be correct next week. A guard whose
false positive recurs and whose prescribed fix does not exist is worse than the silence it replaces.

**Decision.**

1. **The executor reports; it does not refuse.** `evaluateBatch` returns the honest outcomes for a whole
   roster out of the IPP, evidence intact. The two causes — data missing an element the IPP reads, versus
   nobody qualifying — are indistinguishable from inside the executor, and a check that cannot tell them
   apart must not destroy the benign one.
2. **The run pipeline surfaces it as a `WARN`**, naming both possible causes and pointing at
   `WEBCHART_FHIR_MAPPING.md` §3.1 for the known one. Best-effort, like every other observability write
   there: an observability write must never author an outcome.

   **Read AFTER the evaluation loop, from the final per-subject outcomes — not in the batch pre-pass.**
   *(Corrected 2026-07-30; the first version concluded in the pre-pass, off the prefetched map alone.)* A
   subject the executor returns nothing for is deliberately absent from the batch result and is
   re-evaluated individually later in the loop, so a pre-pass conclusion judges an **incomplete roster**
   and is wrong in both directions: a batch of two out-of-IPP outcomes plus one omission warns even when
   the omitted subject then lands squarely in the population, and one out-of-IPP outcome plus two
   omissions stays silent because the sample size failed its own `> 1` guard — the exact silence this ADR
   exists to end. Membership is a property of the finished roster, so it is decided where the roster is
   finished. Both directions are pinned as tests that fail against the pre-pass version.

   A consequence of moving it: the check is **no longer gated on the batch path**. An official measure
   evaluated one subject at a time reports membership just the same, and the hazard is identical.
3. **Only an OFFICIALLY-ROUTED measure is checked**, and `undefined` membership means UNKNOWN rather than
   out-of-population.

   *(Corrected 2026-07-30 after review; both halves of the first version's reasoning here were wrong.)* It
   claimed "the authored engine never sets `inInitialPopulation`", and therefore that no gate on official
   routing was needed. **The authored engine sets it always:** `deriveInInitialPopulation`
   (`engine/cql/cql-execution-engine.ts`) emits the field for every measure carrying a boolean
   `Initial Population` define — all 16 of ours — and its own docstring says so. Ungated, an authored
   measure whose evaluated cohort happened to sit wholly outside its own IPP would be told nobody entered
   the **official** initial population and pointed at the `us-core-sex` extension, for a measure with no
   official artifact and nothing to do with WebChart. It did not fire only because the synthetic roster
   puts somebody in every measure's IPP — a property of the fixture, not an invariant. **An
   official-specific message needs an official-specific trigger.**

   The gate is the engine's own declared identity (ADR-040): `logicVersionFor` returns
   `official-fqm:…` for a routed measure, the authored ELM hash otherwise. Asking the engine what it ran
   beats re-reading the environment at the point of use. `undefined` membership is still treated as
   unknown — absence of evidence, not evidence of absence.
4. **`> 1`, as with the retrieve check.** For one subject, "not in the initial population" is an ordinary
   correct answer — `/simulate` on somebody outside the age band.
5. **Enforcement lives at the FLIP GATE, not at runtime.** `devdb-official-eval.test.ts` compares official
   against the authored engine over known data, which is the only place the two causes *can* be told apart:
   when authored finds four actionable women in the same bundles official finds nobody in, "this cohort is
   ineligible" is demonstrably false. That comparison is not available at runtime at acceptable cost — it
   would mean evaluating BOTH engines for every subject of a measure whose whole purpose is to replace one of
   them. (Not literally impossible: `standards/literal-diff.ts` does exactly this as a diagnostic. Per run,
   over a live roster, it is prohibitive.)
6. **cms122's official routability is STACK-DEPENDENT — and the flip target is the stack where it works.**
   *(Corrected 2026-07-30 after review; the first version of this decision removed cms122 from the flip list
   outright, and that was wrong.)* Official cms122 over **WebChart** data puts all 56 subjects out of the IPP,
   because the dev seed carries zero Conditions and cms122 is deliberately outside
   `ROSTER_ELIGIBLE_MEASURES` (its "enrollment" is a diabetes *diagnosis* the roster must never fabricate).
   But **PR-9c flips the demo/production stack, which has no WebChart seam at all** —
   `deploy-twh-mieweb.yml` contains zero `WORKWELL_WEBCHART_*` (verified), so it evaluates the **synthetic**
   roster, where `official-corpus-outcomes.test.ts` records official cms122 scoring
   COMPLIANT/OVERDUE/EXCLUDED across all five targets and **agreeing with authored on every one**.

   So: **cms122 stays in the flip list.** What the finding actually establishes is narrower — routing
   official cms122 on the **WebChart-configured staging** stack (`deploy-staging-mieweb.yml`, 11
   `WORKWELL_WEBCHART_*` references) produces nothing useful, and the WARN above will say so on every run.
   Also corrected: the claim "nothing is lost, authored is equally blind" holds only over WebChart data — on
   the synthetic roster authored is not blind at all; the two engines simply agree.

**Consequences.**

- The ADR-042 residual limit is no longer silent: a live third-party tenant routed for official CMS125 gets a
  `WARN` in `run_logs` naming the likely cause. It is **not** enforced at runtime, and that is the deliberate
  outcome of decision 1 rather than an omission — the honest conclusion is that this hazard is **not
  runtime-detectable without false positives.**
- **The run terminal and all evidence are preserved.** A zero-denominator run reports `COMPLETED` with real
  `official.populationResults` on every outcome.
- **A `WARN` is weaker than the #264 alert**, which fires only on `FAILED`/`PARTIAL_FAILURE` terminals. That
  is the price of not corrupting valid runs. If a stronger non-failing signal is wanted later, the right
  shape is a run-summary warning count, not a terminal change. (Precisely: the alert takes `runMessage` as
  its body, so on a run that is *independently* PARTIAL_FAILURE the ADR-043 sentence does ride along. "The
  alert stays silent" is true of COMPLETED runs — which is every run this check fires on by itself.)
- **The enforcement is one automated test over FROZEN data plus one unautomated prose step.**
  `devdb-official-eval.test.ts` pins the committed 56-patient fixture and cannot see a tenant; confirming a
  non-zero initial population against the tenant's own data (DEPLOY.md step 2) ships no command, no tooling
  and no artifact. That is a real reduction in enforcement strength against the refusal it replaced, and it
  is accepted only because the refusal's false positives were unfixable-by-the-operator. Worth revisiting
  if a tenant-facing dry-run tool ever exists.
- **How far the warning actually reaches, stated exactly — the first version overclaimed it** (Codex, #354).
  It is echoed into the run **message**, but that message is returned on the **synchronous** response only.
  Every `ALL_PROGRAMS` and `SITE` run, and a `MEASURE` run on a WebChart-configured stack — *precisely the
  configuration this warning exists for* — goes through `scheduleAsyncRun`, which answers the POST with the
  `RUNNING` response and discards the finishing one. `RunRecord` has no message column and neither
  `RunListItem` nor `RunSummary` carries a message, so the polling UI shows only `COMPLETED`. For those runs
  the warning lives in `run_logs`, which **is** reachable (`GET /api/runs/:id/logs`, and the runs page
  fetches it for the selected run) but only as a timeline entry an operator opens — not on the run list.
  So "no longer silent" is accurate; "visible on the run list" was not. Persisting it onto the run needs a
  `runs` column, and **schema is owner-owned** — recorded here as a follow-up rather than smuggled in.
- **A PARTIAL collapse is not caught, and that is the more likely live failure.** The check is
  all-or-nothing: one subject in the initial population silences it entirely (deliberately — a
  mostly-ineligible roster is the ordinary shape of a screening measure, and tested as such). But the
  realistic third-party-tenant shape is a **partially** populated `us-core-sex` column, not an absent one:
  55 of 56 silently MISSING_DATA, and nothing fires. Raised by review; no check is proposed for it here
  because the same indistinguishability argument applies with less signal, which is another reason the flip
  gate rather than runtime is where this is settled.
- **A WARNed run still opens N cases.** `dispositionFor` sends MISSING_DATA to `OPEN` and `priorityFor` to
  `MEDIUM`, so a whole-roster-out-of-IPP run publishes a full set of MEDIUM "collect the documentation"
  cases. That is the same mis-signalling ADR-042's own review correction was about, and it is unchanged by
  this ADR — the outcomes are honest, but the case fan-out is real operational noise.
- **The enforcement is itself gated.** Decision 5 makes `devdb-official-eval.test.ts` the enforcement, and
  that test runs only in the `official-cases` CI job, behind a gitignored terminology sidecar. This branch
  already lost 4 of 6 tests in that exact file to exactly that mechanism once (ADR-042 review). Worth
  re-checking whenever the job's explicit file list changes.
- **What this does not catch:** an IPP that IS satisfied while the *numerator* reads the wrong shape. That is
  the open mammography gap (ADR-042 consequence 3), where official reports a screened woman OVERDUE, subjects
  are in the population, and nothing here fires. Dual-stamping the crosswalk remains outstanding.
- The pre-flip checklist therefore gains a step: **run the gate against the tenant's own data and confirm a
  non-zero initial population before flipping a measure for it.** That checklist did not exist as anything
  but a phrase in this ADR when it was first written — decision 5 named a control that was half prose, which
  is the same vacuous-guard shape flagged on #350 and #352. It is now written down, per measure and per
  stack, in `DEPLOY.md` §"Flipping a measure to official execution", together with the
  `WORKWELL_OFFICIAL_MEASURES` row that was missing from the environment reference entirely.

## ADR-042: The WebChart↔official IPP gap is closed by mapping and guarded by a parity gate — not by refusing the configuration (the NUMERATOR gap stays open)

**Status:** Accepted (2026-07-30). Roadmap §7.4 PR-9 (PR-9b). Nothing routes officially yet.

**Context.** No test anywhere evaluated real WebChart data through an official artifact. Every piece of
evidence that official execution works runs over CMS's MADiE patients (121/121) or over our synthetic
corpus (ADR-038) — both are bundles *built to be evaluated*. WebChart data is what a real EHR happens to
hold, and that is where the flip's risk lives.

The plan of record for this step was a **construction-time refusal**: throw when
`WORKWELL_OFFICIAL_MEASURES` is set while the WebChart seam is configured. That plan predated any
measurement. It came from a structural inventory of the committed dev-DB fixture — 0 Conditions, 0
Encounters, no `Patient.extension`, no `Observation.category` across 56 patients — which counted what was
*absent* rather than testing what the measures actually *read*.

Measuring changed the picture in three ways:

1. **The cms125 INITIAL-POPULATION gap was one field.** The official IPP is
   `AgeAt(end of MP) in [42..74] AND us-core-sex = SNOMED 248152002 AND exists Qualifying Encounters`.
   Age passed and the roster's CPT 99213 visit satisfied the encounter. The sole failing conjunct was the
   extension: 0 of 56 patients carried it. Of three other candidates, only `Condition.onsetDateTime` is
   genuinely inapplicable (cms125's IPP reads no Condition — only its mastectomy exclusions do). A LOINC
   mammography `Observation` and `Observation.category` moved no outcome **only because no in-IPP subject
   in this fixture has a mammogram at all** — both are live NUMERATOR blockers (consequence 3 below).
   "One fix, not four" is scoped to the initial population; it is not a claim that the rest are retired.
   Review caught this file making exactly that elision, which is why the scope is now in the title.
2. **cms122 has no divergence to refuse.** Official and authored both return MISSING_DATA for all 56, for
   the same reason: no Conditions in the seed, and cms122 is deliberately outside
   `ROSTER_ELIGIBLE_MEASURES` because its "enrollment" is a diabetes *diagnosis* the roster must never
   fabricate. Routing it over this data changes nothing.
3. **The seam-keyed predicate outlives the problem it describes.** "Both env vars are set" stands in for
   "this data cannot satisfy the IPP". Fix the mapping and the predicate stays true while the property goes
   false, so the check refuses a *correct* configuration until someone deletes it. This is the argument that
   survives; the two below it were weaker than first written.

   **Correction (review, 2026-07-30).** The first version of this ADR also argued that the effect —
   four subjects moving `OVERDUE → MISSING_DATA` — left the roster "noisier, not rosier", since both
   buckets open a case. **That is wrong on the axis operators triage by.** From `case/case-logic.ts`:
   `dispositionFor` sends both to `OPEN` (so the case *count* is identical — nothing got noisier), but
   `priorityFor` maps `OVERDUE → HIGH` and `MISSING_DATA → MEDIUM`, and `nextActionFor` swaps *"Escalate
   mammogram follow-up immediately"* for *"Collect the missing mammogram documentation"*. So the pre-fix
   behaviour **downgraded four genuinely-overdue screenings from HIGH to MEDIUM and misdirected the
   operator toward paperwork.** That is rosier, and closer to ADR-038's hazard than this ADR first allowed.
   The decision not to build the refusal still holds — on the predicate argument above, not on this one.

**Decision.**

1. **Emit `us-core-sex` from WebChart's `patients.sex`, alongside `Patient.gender`.** Both mapping sites
   change together (`wcdb-fhir-shim/src/fhir-mapping.ts` and the by-design duplicate in
   `backend-ts/scripts/webchart-devdb-export.ts`). The SNOMED concept id is load-bearing: the ELM compares
   against `248152002`, so an extension carrying `"F"` is indistinguishable from one absent — a distinction
   that cost a measurement pass to find.

   **On the drift guard, corrected (review, 2026-07-30).** The first version of this ADR repeated
   `fhir-mapping.ts`'s header claim that `hapi-live.test.ts` bucket parity guards this duplication. **It
   cannot see this field.** That test compares authored-engine bucket counts, and the authored engine reads
   `Patient.gender` and never the extension — which is exactly how both sites came to omit it. Real
   coverage: `server.test.ts` pins the shim's output, `devdb-official-eval.test.ts` pins the export
   script's committed output. Nothing cross-checks the two sites against each other.
2. **We assert `us-core-sex` where the SOURCE SYSTEM records a sex value; we do not synthesize it from a
   FHIR `gender` we did not map ourselves.** So `normalizeWebChartBundle` does not stamp it for third-party
   WebChart FHIR servers, and such a server's roster reads out-of-population for CMS125 — fail closed,
   because reading nobody beats guessing.

   **The reason, stated more carefully than at first (review, 2026-07-30).** The original wording claimed
   `patients.sex` *is* recorded sex rather than administrative gender, making this "normalization, not
   derivation". `docs/WEBCHART_FHIR_MAPPING.md` §3.1 contradicts that — it calls `patients.sex` the
   `administrative-gender` source — and a single F/M column in a 675-table schema does not settle the
   question either way. The rule above needs no such semantic claim: the distinction it draws is between
   reading a source column and inferring from another system's mapping. The fail-closed conclusion is
   unchanged; the justification is narrower and defensible.
3. **No construction-time refusal keyed on the seam being configured** — on the predicate-rot argument in
   context 3, which is the one that holds. See consequence 5 for the case this decision does *not* cover.
4. **The guard is a live-path parity gate instead** (`devdb-official-eval.test.ts`): official vs authored
   outcomes, per subject, over the committed fixture through the real ingress path, using
   `evaluateBatch` — the primitive a routed run uses. The load-bearing assertion is a **divergence map**;
   empty means routing is inert for this data, populated names every subject whose roster row would change
   and how. A shift is then either progress or a regression, and both are deliberate.
5. **The cause is pinned by removal, not by presence.** A separate test strips the extension and asserts
   official collapses to 56 MISSING_DATA while authored is unaffected. Asserting the field is present only
   proves the mapping emits it; stripping it proves that is what holds the agreement up — and it preserves
   the pre-fix measurement as the historical record.

**Consequences.**

1. Official CMS125 now produces the same outcomes as the authored implementation on all 56 subjects of real
   WebChart-derived data. This is the first official artifact to do so on anything other than purpose-built
   bundles.
2. **What this is not.** The oracle is our own authored engine, not an external expected answer, so
   agreement is evidence the flip is safe *for this data* — not that either engine is right. And 52 of 56
   outcomes are MISSING_DATA, so **only 4 subjects carry discriminating signal**, all in one bucket for one
   reason. The id-set comparison in `devdb-official-eval.test.ts` is what protects against a collapsed
   distribution (the `assert.ok` non-degeneracy line is implied by it and is insurance, not the guard — the
   first version of this ADR cited the wrong one). Cypress CVU+ remains the verification bar (locked
   decision 2) and has not run.
3. **The NUMERATOR gap is OPEN, and it fails in the dangerous direction.** Everything above concerns
   initial-population membership. The two engines read different resource types for the numerator —
   authored `[Procedure: "Mammography"]`, official `isDiagnosticStudyPerformed([Observation: "Mammography"])`
   — and the WebChart crosswalk emits mammography as CPT `77067` / HCPCS `G0202` on a **`Procedure`**, while
   the official `Mammography` value set (OID …108.12.1018) is **92 LOINC codes and nothing else**. Measured
   on `wc-8` with one crosswalk-shaped mammogram inside the period: **authored COMPLIANT, official
   OVERDUE** — a confident false non-compliance on the ordinary case, which `case-logic.ts` turns into a
   HIGH-priority "escalate mammogram follow-up immediately" for a woman already screened.

   The obvious fix is a trap worth recording: a correctly-coded LOINC `Observation` **alone changes
   nothing**, because `Status.isDiagnosticStudyPerformed` also requires `exists(category ~ imaging)`. And
   the Observation alone (with category) flips the error the other way — official COMPLIANT, authored
   OVERDUE. **The remedy is dual-stamping both representations**, as the synthetic corpus already does
   (ADR-038). All four states are pinned as tests. Closing it is a crosswalk change (M-D), not an edit here.
4. PR-8f's batch retrieve refusal does **not** fire on either measure — confirmed by the batch returning
   all 56 subjects. It catches "retrieved nothing at all", and these retrieves matched plenty (236 LOINC
   observations); they just did not match the conjunct deciding membership. The ADR-038 lesson holds on
   real data as it did on the corpus.
5. **This fix does not reach a live third-party WebChart tenant, and nothing enforces that.** Both changed
   mapping sites are upstream of the live FHIR transport: the shim (dev MariaDB) and the offline export
   script. `normalizeWebChartBundle` is untouched by design (decision 2), so the teatea trial — the only
   live integration — still supplies no `us-core-sex` and its whole roster would read out-of-population for
   official CMS125. `deploy-staging-mieweb.yml` sets `WORKWELL_WEBCHART_BASE_URL`, so staging is exactly
   where official routing and a live seam can coexist.

   Review's point, which stands: for the live third-party path the seam-keyed predicate retired in
   decision 3 **is** still an accurate predicate — decision 3 reasons about the configuration this ADR
   fixed and generalizes to one it did not. The residual limit is asserted in prose here and guarded by
   nothing. Enforcing it (a first-run check that a WebChart-derived roster carries the elements an
   officially-routed measure's IPP reads, failing the *measure* per PR-8f's MISSING_DATA + PARTIAL_FAILURE
   pattern rather than the run) is a **PR-9c precondition**, deliberately not taken here.
6. The WebChart gap is **narrower than recorded** for cms125's IPP (one field, now closed) and **wider in
   kind** for cms122 (no diagnoses at all, blocking both engines — an M-D ingest question, not a flip risk).
   The earlier note that official cms122 "would read out-of-population over live data too" was true but
   omitted that authored does the same, which is the half that decides whether the flip changes anything.
7. **The pipeline this ADR validates already fabricates one of the three IPP conjuncts.**
   `engine/ingress/enrollment/roster.ts` synthesizes a CPT 99213 `Encounter` for every cms125-enrolled
   subject because WebChart supplies none (the fixture has 0 Encounters and 0 Conditions), and that
   Encounter is what satisfies `exists Qualifying Encounters`. Without it nobody is in population and the
   whole measured result vanishes. That decision is pre-existing and argued in `roster.ts` (program-visit
   evidence, not a fabricated clinical mammogram), and this ADR does not reopen it — but an argument about
   never inventing facts to satisfy an IPP should say plainly that the path being validated invents one.


## ADR-041: A capped official expansion is completed at vendor time, from a pinned VSAC release, or not at all

**Status:** Accepted (2026-07-29). Roadmap §7.3 (terminology) + §7.4 PR-9. Nothing routes officially yet.

**Context.** `officialRoutingProblems` refuses to route any measure whose ELM retrieves a value set the
manifest records as capped (ADR-036, decision 7). Both vendored artifacts trip it on the same OID:
`AdvancedIllness` (2.16.840.1.113883.3.464.1003.110.12.1082) ships **1000 of a declared 1997 codes** in
each bundle and feeds the 66+/advanced-illness denominator exclusion in both. That refusal is the only
thing standing between cms122/cms125 and the PR-9 flip, and it is correct: a half-expanded exclusion set
does not error, it silently leaves subjects who should have been excluded in the denominator to be
scored. The empty-set preflight cannot see it, because half-expanded is not empty.

Two facts settled the shape of the fix. First, **the cap is upstream policy, not a defect** — the
content repo's README says so outright (*"The value sets in this repository are limited to expansions of
1000"*; full expansions require an NLM licence), so there is nothing to raise upstream and no version of
this that is fixed by waiting. Second, **VSAC's `$expand` supports `offset`/`count`**, confirmed against
its published `OperationDefinition`, and `engine/cql/vsac-client.ts` has been paging it correctly for the
authored path since #295. The missing piece was never the capability; it was that the two terminology
paths have no bridge, deliberately — ADR-036 forbids the runtime mixing them, and `resolve-valuesets`
writes DB rows the official executor must never read.

**Decision.**

1. **The completion happens at VENDOR time, in `vendor-official-measure.mjs`, behind
   `--complete-capped-expansions`.** This is roadmap §7.3's own rule — *bundle-shipped expansions
   PRIMARY, VSAC-patched at VENDOR time, no runtime fallback* — and it keeps ADR-036's single authority
   intact: the sidecar remains the one thing the runtime reads, and it is still pinned by a SHA-256 in
   the committed manifest. A runtime fallback to VSAC would have been the easy version and would have
   reintroduced exactly the split PR-8a closed.

2. **Only the OIDs upstream actually capped are re-expanded** — today one, two pages. This is not an
   import. The 25 or 31 other value sets in each artifact come from the bundle, unchanged and unasked
   about, so the blast radius of the network call is one value set per measure.

3. **Pinned to `Library/ecqm-fhir-update-2025`**, the release the upstream content repo itself names as
   the terminology package supporting its measures — and the same eCQM release CVU+ validates the 2026
   reporting period against, so M-A and M-B stay on one terminology story rather than two. Unpinned,
   VSAC serves latest-active: a republish would move our expansions, the terminology digest, and
   therefore `officialLogicVersion` (ADR-040), with the bundle bytes unchanged. CI's
   `git diff --exit-code measures/official` would catch it — after the fact, on an unrelated PR.

4. **Completed codes are sorted by `system|code` and deduped before they are written.** The sidecar is
   pinned by hash, so its byte ORDER is part of the artifact and VSAC's page order is not a contract.
   Code-point comparison rather than `localeCompare`, for the reason `collectTerminology`'s own sort
   already spells out.

5. **Every failure leaves upstream's codes exactly as shipped.** No flag, no key, VSAC unreachable after
   the bounded retry — each warns and returns, the manifest's `truncated` entry survives, and routing
   keeps refusing. There is no path that yields a set which *looks* complete and is not: `truncated` is
   recomputed from the codes actually present after completion, by the same comparison as before.

6. **A VSAC expansion that comes back SHORT of the declared total, or that does not CONTAIN upstream's
   shipped codes, is rejected outright rather than merged.** These are the non-obvious ones and the
   reason they are written down. The short comparison is made AFTER dedupe, so a response padded with
   duplicate `system|code` pairs cannot clear the bar and then shrink below it — comparing the raw page
   total was the original mistake, caught in review. The containment check exists because a count cannot
   distinguish "the full version of this set" from "a different set that happens to be bigger", and that
   difference is a wrong release pin scoring real patients; it is also what empirically confirms the pin,
   since VSAC's 2000 codes do contain all 1000 upstream shipped. Merging a shorter, different
   set would swap upstream's 1000 codes for someone else's 800 — a narrowing dressed as a fix, and the
   only outcome worse than staying capped. Staying capped is loud; a wrong 800 is not.

7. **The vendor-time credential is a DIFFERENT GitHub secret from the runtime one**
   (`WORKWELL_VSAC_API_KEY_VENDOR`, not `WORKWELL_VSAC_API_KEY_TWH`), even though both hold the same UMLS
   key. They serve the two terminology authorities ADR-036 exists to keep apart: one vendors the official
   artifact's own expansions, the other drives the authored engine's live resolver. Giving them one name
   would invite precisely the conflation that ADR forbids.

**Consequences.**

- Completing the expansion changes `manifest.terminology.sha256`, and therefore `officialLogicVersion`
  (`official-fqm:<version>:<artifactSha>:<terminologySha>`), and therefore invalidates every cached
  `eval_state` row for that measure. Designed behaviour, not a regression — the terminology digest is in
  that identity for exactly this case.
- **Landing order is load-bearing.** The flag ships first and is a no-op without the secret, so CI stays
  green; the secret and the re-vendored manifests must then land *together*. Adding the secret alone
  means CI completes the expansion while Git still records it as capped, and the reproducibility step
  goes red on every unrelated PR. The step now says so in its own error message.
- The MADiE gate is expected to stay 121/121 — its own analysis already reports "Value-set-cap effects:
  0 observed" across the deck. If a case does move, that is the finding: the cap was load-bearing for a
  test subject, and the report's own classification rule covers it.
- Two tests stopped asserting that the cap EXISTS. They were scheduled to be deleted by their own fix —
  `assert.ok(capped.length > 0)` is only true while the blocker is unfixed. The mechanism is now pinned
  against a synthetic manifest (never vacuous, never state-dependent), and the real artifacts are checked
  for the invariant that holds in *both* states: the manifest's caps, the sidecar's own shortfalls, and
  the routing decision agree. Review caught that this covered `cappedExpansions` the HELPER while leaving
  `officialRoutingProblems` the GUARD vacuous — with both artifacts now complete, deleting its
  capped-expansion loop left the suite green. A test stubbing `cappedFor` non-empty now pins the refusal
  itself, verified by mutation; without it this would have repeated the ADR-036 decision-7 finding
  (recorded, documented as a guard, and never actually exercised). That last one is a new guard, and it is the one that matters — a manifest
  claiming `truncated: []` over a still-short sidecar would clear the refusal on a lie.
- The paging loop is a second implementation of `httpVsacClient`'s, deliberately. The vendor script runs
  as plain `node` on the deploy path with no install and no build step, which is what makes the deploy's
  terminology fetch cheap and hard to break; importing TypeScript from `src/` would end that.

**Rejected.** *Completing it in the runtime* — reintroduces the two-authority split of ADR-036.
*Committing the completed expansion* — it is licensed VSAC/CPT/SNOMED content in a public Apache-2.0
repo, which is the whole reason the sidecar is gitignored. *Hosting the completed sidecar in the
`workwell-twh-evidence` bucket and fetching it at build* — workable, and it would keep the UMLS key off
CI, but it adds a second artifact to keep in sync with the pin and an owner step to every re-vendor, to
avoid two HTTP requests. *Raising the cap upstream* — it is documented policy with a licensing reason.


## ADR-040: The engine declares the logic it runs; the incremental cache never infers it

**Status:** Accepted (2026-07-28). Roadmap §7.4, PR-8 (remaining). Nothing routes officially yet.

**Context.** Incremental evaluation (ADR-035) reuses a subject's prior CQL outcome when its data and its
*logic* are unchanged. "Logic unchanged" is decided by `logic_version`, which `incremental-eval.ts`
derives by hashing `ELM_LIBRARIES[libraryName]` — **WorkWell's authored ELM**.

That derivation stops being true the moment a measure is routed to the official published artifact. The
authored ELM is still there and still hashes identically, so the fingerprint reports "same logic" about
two engines that answer differently, and the `eval_state` cache copies **authored outcomes forward for a
measure now running official CQL**. Re-vendoring that artifact would not invalidate them either: nothing
in the fingerprint knows the artifact exists.

This is the one input to the fingerprint whose absence is *silent*. Every other signal degrades
pessimistically — a missing value-set hash makes `logic_version` change when it needn't, and costs a
re-evaluation. This one degrades toward a wrong answer that no test, log line, or alert would show,
because a reused outcome looks exactly like a computed one.

It is inert today (`WORKWELL_INCREMENTAL_EVAL` is unset everywhere, and so is
`WORKWELL_OFFICIAL_MEASURES`), which is why it is being closed *before* PR-9 rather than after. Two
independently-off flags is not a safety property; it is a coincidence with a deadline.

**Decision.**

1. **The engine declares its own logic identity.** `RoutedEngine` gains an optional
   `logicVersionFor(measureId)`, returning the artifact's identity for a routed measure and `undefined`
   — meaning "authored" — for everything else. The incremental cache consults it first and falls back to
   the ELM hash unchanged.
2. **It travels ON the engine, not beside it.** The obvious alternative is another optional field on
   `RunPipelineDeps` passed by each caller. That is precisely the shape of the bug PR-7b's review caught:
   a call site that forgot to pass the official flag, so the nightly run used a different engine than the
   manual one — a mistake the same block of code had already documented twice. Hanging the identity off
   the engine makes the logic identity and the thing that computes the outcome *the same object*, so they
   cannot disagree, and a future call site gets it without having to remember it.
3. **The identity is a readable composite, not a hash:**
   `official-fqm:<version>:<artifactSha>:<terminologySha>`. The roadmap sketched `sha256(...)`; every
   input is already a digest, so re-hashing buys no collision resistance and only makes an `eval_state`
   row unreadable at the moment someone is asking which artifact produced it. The `official-fqm:` prefix
   is disjoint from the authored side's `sha256:<hex>` **by construction**, so the two spaces can never
   collide however the authored hash is later computed.
4. **The terminology digest is part of the identity.** This is the input the roadmap's sketch omitted.
   Since ADR-036 the executor retrieves against the artifact's *own* expansions, fetched at build and
   pinned in the committed manifest — so re-fetching at a different upstream ref can move value-set
   membership, and therefore outcomes, with the bundle bytes unchanged. Version + artifact sha alone
   would call that "same logic".
5. **An official-routed outcome is same-day-only, structurally.** `computeNextTransition` — which decides
   how long a cached status may be reused — reasons in authored terms: it keys on `MEASURE_BINDINGS` and
   reads a `"Days Since"` define out of authored evidence. Two of its branches would over-reuse an
   official outcome: a binding marked `PERMANENT` returns `null` (terminal ⇒ *unbounded* across-day
   reuse) before the boundary table is consulted, and a measure in `BOUNDARY_SAFE` would have thresholds
   derived from the **authored** CQL applied to an **official** status. Neither is sound, because the
   official measurement period is a rolling window (ADR-039) — the same bundle can score differently as
   the eval date moves the period, so nothing about an official outcome is terminal on unchanged data.
   The cache therefore bounds an official outcome to its own evaluation date. This changes nothing today
   (cms122/cms125 are both `RECURRING` and neither is boundary-safe, so they already fall through to the
   same-day default) — it converts that from a coincidence of how two measures happen to be classified
   into a property of routing. It also keeps `recomputeEvidenceAsOf` a no-op on official evidence, since
   the copy-forward delta can then only ever be zero.
6. **And, for now, an official-routed outcome is not reused at all.** `logic_version` identifies the
   measure *definition*, never the code that executes it — true of the authored side too, where it hashes
   ELM rather than `cql-execution-engine.ts`, and harmless there because that engine is old and stable.
   The official adapter is neither: `preparedForQiCore`, `officialMeasurementPeriod`,
   `officialMeasureSemantics` and `outcomeFromPopulations` all move the answer, all shipped or changed
   within a week, and ADR-037 *measured* preparation swinging a roster from IPP=0 to IPP=25. A same-day
   redeploy would therefore leave rows reusable that the previous adapter produced. The identity cannot
   close that by itself — there is no build sha or package version available at runtime to fold in
   (`/api/version` reports a literal; `package.json` is `0.0.0`), and a hand-bumped "adapter contract"
   constant is the remember-to-do-it failure mode decision (2) exists to avoid. So the cache declines the
   work instead of guessing.

   **What that costs, exactly.** Official rows are same-day-only by (5), so the entire benefit forgone is
   *a second run on the same day skipping CQL*; across-day reuse — incremental evaluation's actual payoff
   — was never available to them. Rows are still committed (they record which artifact produced the
   outcome, and they are what a re-enabled reuse path consumes, so lifting the policy rebuilds no cache),
   but they are **write-only today**. The exit condition is named rather than "later": either the identity
   grows a digest covering the adapter's output-affecting surface, or that surface stops moving once
   PR-10..12 finish onboarding the remaining six measures. Re-enabling is deleting one branch in `plan`.

   The cost this does **not** avoid is the write: one `eval_state` row per routed subject per run that
   can never be read while the policy stands, and writes are billed on the Neon stack (DEPLOY.md →
   "Database compute cost"). That is deliberate — the warm fingerprint is what makes re-enabling a
   one-line change rather than a cold cache — but it is an option worth paying for only while the exit is
   near. If the policy outlives PR-12, skip the commit for official rows too.
7. **Officialness travels ON the fingerprint, not re-derived at each use.** `plan` decides it once and
   carries it (`EvaluatePlan.engineDeclaredLogic`) to `commit`, which governs the temporal bound in (5).
   Asking the engine a second time would make the bound and the identity it is stored beside two
   independent evaluations of one fact — the same coupling (2) removes between the engine and the cache,
   reintroduced one layer down. The field is **required**, not defaulted: a caller that hand-builds a
   fingerprint is exactly the one that would otherwise get an authored bound on an official row, and the
   compiler should make it say which it means.

**Consequences.**

- Flipping a measure **on**, flipping it **off**, and **re-vendoring** it while it stays routed all
  invalidate reuse, by construction rather than by care: the two identity spaces are disjoint, and every
  vendor-time input is inside the official one. All three are tested against the real engine and a real
  SQLite `eval_state`, in a setup where every *other* reason to re-evaluate has been removed (same day,
  identical bundle, terminal status) — with a baseline test proving that setup does reuse, so the tests
  isolate `logic_version` and nothing else.
- Unchanged on every environment today. `WORKWELL_OFFICIAL_MEASURES` unset ⇒ `routedEngineForEnv` returns
  the authored engine itself, which has no `logicVersionFor`, so the cache reaches the identical ELM-hash
  path. The demo/default run loop is byte-identical.
- **The identity tracks what the MANIFEST records about the bundle, not the bundle bytes.**
  `loadOfficialArtifact` parses `bundle.json` without checking it against `manifest.sha256` (unlike
  terminology, which ADR-036 verifies against its pin at load, because that sidecar is gitignored). So a
  hand-edited `bundle.json` would execute new logic under the old identity. `bundle.json` is committed and
  CI runs `git diff --exit-code measures/official` after re-vendoring, which is what actually closes this
  on the normal path; the precise claim is therefore "a **re-vendored** artifact is a logic change", since
  vendoring regenerates the manifest alongside the bundle.
- **The compiler does not enforce the wiring; the runtime does.** `Pick<RoutedEngine, "logicVersionFor">`
  has an optional member, so a future caller could pass an unrouted engine and typecheck. That is
  self-correcting rather than dangerous — an unrouted engine yields authored evaluation *and* an authored
  identity, so the two stay consistent — but "cannot disagree" is a statement about the runtime object,
  not about the type. The pipeline's single read of `deps.engine.logicVersionFor` is covered by a test
  that fails when that line is deleted; it is the only place this can now go wrong.
- **Scoped to the measure, not to the input.** The router's `elm`/`metaOverride` escape evaluates a routed
  measure with the authored engine, which `logicVersionFor` cannot see. Sound only because the two callers
  cannot meet — the escape belongs to the fidelity lab and the Rule Builder, neither of which is a
  population run, and the cache exists only inside `finishManualRun`. Recorded here because a future caller
  that both overrides the library *and* caches must key on the library it asked for.
- Descriptive only (ADR-008), unchanged: this decides *whether* to re-ask the engine, never the answer.

**Alternatives rejected.** *Disable incremental evaluation whenever any measure is routed* — a blunt
correctness fix, but it turns the two features into mutually exclusive ones exactly where their value
overlaps (the WebChart tenant, whose fixed exam dates are what makes across-day reuse pay off, is also
where official execution is headed). *Fold the artifact sha into the existing ELM hash* — keeps one code
path, but produces an opaque `sha256:` that silently changes meaning depending on configuration, and
still leaves the cache inferring routing rather than being told it.

## ADR-039: The shadow diff is a shadow of the runtime, not a study of its own

**Historical finding — full text in [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md#adr-039).** Diagnosis: the shadow diff used a different date window and enriched inputs, so it was not a shadow of the runtime.

## ADR-038: The synthetic corpus is verified against the official artifact's own terminology

**Historical finding — full text in [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md#adr-038).** Diagnosis: 12 of 24 corpus codes were registered under the wrong value set, invisible because one file supplied both sides of the comparison.

## ADR-037: Official execution prepares bundles for QI-Core — normalization only, never fabrication

**Status:** Accepted (2026-07-27). Roadmap §7.4 PR-8. Nothing routes officially yet.

**Context.** Official artifacts retrieve against QI-Core profiles, which are materially stricter than
the plain FHIR this repo emits: a diabetes `Condition` must be an ACTIVE, CONFIRMED problem whose
prevalence period overlaps the measurement period, and an `Encounter` is expected to carry a `class`.
Our synthetic Conditions ship a system-less `clinicalStatus` and no `onsetDateTime`.

`standards/literal-diff.ts` had a private `stampQiCoreStructure` for this, and the router's docstring
carried "must call it, or the whole population reads out-of-population" as an unmeasured obligation.
Measured against the vendored CMS122 artifact over 25 synthetic subjects:

| bundle | IPP | DENOM | NUMER |
|---|---|---|---|
| raw synthetic | **0** | 0 | 0 |
| + preparation | 25 | 25 | **0** |
| + preparation + harness enrichment | 22 | 22 | 4 |

**Decision.**

1. **One preparation, used by both paths.** `wiring/qicore-preparation.ts` — the diff and the runtime
   executor call the same function. Two implementations of this could not be compared, and comparing
   them is the entire purpose of the shadow period.
2. **The runtime prepares a COPY.** The authored engine may evaluate the same bundle object, and ADR-008
   requires its outcome to be byte-identical whether or not official routing is on.
3. **Normalization, never fabrication**, and review tightened this twice before it held:
   - **No invented onset.** The first cut anchored a missing `onsetDateTime` three years before the
     evaluation date. That is a date of an actual event — exactly what this rule forbids — and CMS165, on
     the priority list, decides denominator membership on hypertension onset relative to the measurement
     period. Isolating the parts showed it also bought nothing: **status alone yields IPP=25/25**,
     identical to applying everything, while onset alone yields 0/25. Removed.
   - **`clinicalStatus`/`verificationStatus` are replaced only when nothing in them names a system.**
     The first cut overwrote unconditionally, justified by the synthetic coding being system-less — true
     of our corpus, false as a rule. It would have turned a `resolved`, `refuted` or `entered-in-error`
     Condition into an active confirmed one, putting a corrected misdiagnosis into CMS122's denominator
     and, with no HbA1c, its numerator. The defect is an unbindable coding, so that is the condition.

   Everything else (`category`, Encounter `class`) is filled only when absent, so data that already
   carries a real value is never rewritten — which is the basis for running this over WebChart data and
   not only over the synthetic corpus.
4. **The literal diff uses the artifact's own terminology (ADR-036), with no fallback.** It was the last
   call site still expanding from our VSAC import. A diff that expands one terminology while the runtime
   expands another forecasts a configuration that will never exist, which defeats the point of running it
   before a flip. When the sidecar is absent, `literalDiffAvailable()` reports false and the route
   degrades to the subset tier **visibly, in its `mode` field**, rather than silently swapping sources.
5. **Both deploy workflows vendor terminology into the build context** — production and staging. Not
   doing so would have silently downgraded the live stack's `mode:"literal"` to `"subset"`, a regression
   of a shipped capability; staging matters more rather than less, since it is where the PR-9 flip gets
   validated against live teatea data. Deliberately not fail-soft on a MISSING sidecar — but the fetch
   itself retries with backoff on transport errors and 5xx, because an emergency rollback rebuilds the
   image and a thirty-second GitHub blip must not block the fix for an unrelated incident. A 4xx at an
   immutable pin means the path is wrong and is never retried.

**Consequences.**

- **This does NOT make the synthetic corpus sufficient for official cms122, and that gates PR-9.** With
  preparation alone the 25 subjects score IPP=25 / DENOM=25 / NUMER=0, and cms122's numerator is *poor
  glycemic control* — so the roster renders as **100% compliant**. A wrong answer that looks like good
  news is worse than an obviously broken one, and no automatic check distinguishes it from a genuinely
  well-controlled population: `hasRetrieveSignal` passes, because retrieves DID match.
  The gap is that our corpus carries `urn:workwell:*` codes where the official numerator retrieves real
  LOINC. `standards/cms122-official.ts` closes it with a harness-local enrichment for the diff, and that
  enrichment must **never** move into the runtime — synthesising clinical codes at evaluation time is
  fabrication. The real fix is a synthetic corpus that emits real codes, which the roadmap already
  schedules per measure at PR-10..12.
- The shadow period (PR-8) is therefore the gate that catches this class, not a formality.
- Descriptive only (ADR-008): preparation changes what the official artifact can see, never what CQL
  decides. Nothing routes officially, so no current outcome changes.

## ADR-036: Official terminology is the artifact's own, fetched at build and pinned by hash — not our VSAC import

**Status:** Accepted (2026-07-27). Roadmap §7.3 called this in advance ("bundle-shipped expansions
PRIMARY, VSAC-patched at VENDOR time, no runtime fallback. Runtime never mixes two terminology
authorities"); PR-6a and PR-7a drifted from it, and this ADR records the correction.

**Context.** Two PRs, each locally reasonable, together split terminology into two authorities:

- **PR-6a** stripped `ValueSet` resources out of the vendored `bundle.json`. That was a **licensing**
  decision, not a size one: 26 expansions per bundle carry thousands of AMA CPT and SNOMED CT codes,
  and this repository is public.
- **PR-7a** then filled the resulting hole by expanding from our imported VSAC `value_sets` rows at
  runtime.

The consequence was only visible from a distance. The MADiE gate (`official-cases.ts`) validated the
official artifact against the **upstream bundle's own** expansions, while the runtime expanded from
**VSAC store rows** — a configuration no gate had ever executed. So 121/121 green proved nothing about
the path production would take, which is the single thing that gate exists to do. It also made PR-9
depend on an owner-only UMLS import, and it is the failure mode most likely to be silent: fqm treats an
unexpandable value set as *empty rather than missing*, an empty set matches nothing, and the measure
then reports every subject out-of-population — indistinguishable downstream from a genuinely ineligible
roster.

Restoring the ValueSets to `bundle.json` was measured (+605 KB cms122, +464 KB cms125 — affordable) and
**rejected**: it would commit redistribution of licensed terminology from a public repo.

**Decision.**

1. **The artifact's own expansions are the only official terminology.** `vendor-official-measure.mjs`
   writes them to `measures/official/<catalogId>/terminology.json` at the same pinned upstream commit as
   the ELM. Our VSAC import (`pnpm resolve-valuesets`) serves the authored measures and the fidelity
   lab; it has no role in official execution.
2. **Fetched at build, never committed.** The sidecar is gitignored — the same fetch-not-vendor pattern
   `.official-content/` already uses for the test deck. Nothing licensed enters Git.
3. **Pinned by hash.** The **committed** `manifest.json` records the sidecar's SHA-256, so bytes that
   are not stored are still pinned: a regenerated sidecar either hashes identically or is refused at
   load. That is what makes "fetched" as trustworthy as "vendored" without the redistribution.
4. **The expander is keyed by measure, not by a flat OID map.** CMS122 and CMS125 share 23 of their
   canonicals today, so a flat map works — until two artifacts are pinned at different commits and
   disagree about one expansion, at which point whichever loaded first silently wins for both.
5. **The MADiE reduction check executes the runtime configuration.** It now runs our reduced artifact
   plus its own sidecar, built through the same `expandArtifactTerminology` the router uses, against the
   upstream bundle and upstream ValueSets. Verified 2026-07-27: **0/55 and 0/66 cases changed
   population vector**. The report records which terminology mode ran, so a weaker check can never be
   mistaken for the stronger one.
6. **A missing sidecar refuses routing, and names the command that fixes it.** `officialRoutingProblems`
   reports it as one build step rather than as 26 separate expansion failures.
7. **A VSAC-CAPPED expansion refuses routing too.** This is the same failure one notch weaker, and the
   empty-set guard cannot see it: it refuses on empty, and half-expanded is not empty. Review of this
   PR found `cappedExpansions` recording caps while documenting a guard that had zero callers — so a
   capped set would have sailed through preflight. It is now a routing problem, filtered to the sets the
   measure's ELM actually retrieves so an unused cap cannot block a measure.

**Consequences.**

- A fresh clone cannot route officially until `pnpm vendor:official` has run. That is the correct
  failure: the alternative is evaluating a measure with terminology nobody validated.
- **PR-9 obligation:** the deploy workflow must run the fetch before `docker build`, since the image
  needs the sidecar. Routing is off in production today, so nothing is broken meanwhile — but a flip
  without that build step would fail closed at boot.
- **`AdvancedIllness` blocks the flip, by design.** VSAC caps expansions at 1000 codes, and
  `2.16.840.1.113883.3.464.1003.110.12.1082` (1000 of 1997) is capped in **both** upstream bundles,
  where it feeds the 66+/advanced-illness denominator exclusion. It changes none of the 121 official
  cases — that is the claim we can support, and all of it — but "changes none of the test cases" is not
  "changes no patient", so decision 7 refuses to route either measure until it is completed from VSAC at
  vendor time (§7.3). **cms122 and cms125 are therefore NOT routable today**, and PR-9 must do that
  expansion, not merely remember it.
- Descriptive only (ADR-008): terminology feeds the engine's retrieves; it never sets an `Outcome
  Status`. Nothing routes officially yet, so no current outcome changes.

## ADR-035: Incremental/delta batch evaluation is a descriptive, inert-unless-configured cache (#263)

**Status:** Accepted (2026-07-24). Owner-approved the `eval_state` DDL + the scope decisions in-session.

**Context.** A recurring population run re-evaluates every subject × measure whether or not anything
changed — ~1.68M CQL evaluations at the 120k scale, ≈68 ms each (#253). Most of that recomputes an
answer that cannot have moved. #263's design (`docs/superpowers/specs/2026-07-13-e263-incremental-evaluation-design.md`)
was gated on WebChart's change signal; the 2026-07-13 research answered enough to build the
content-hash tier now.

**Decision.**
1. **Reuse the EVALUATION, never the OUTCOME ROW.** Every read model reads "the outcomes of the latest
   run per measure"; skipping rows would break them all. A reused subject still gets an outcome row
   (copy-forward: prior status + date-corrected evidence, new run id), so every read model is untouched
   and DB write volume is unchanged — we save only the ~68 ms of CQL, the cost that matters.
2. **Two tiers.** `data_hash` (canonical hash of the evaluated bundle) + `logic_version` (hash of the
   measure ELM + referenced value-set expansion hashes) gate reuse; **status-boundary caching**
   (`next_transition_at`) extends it across days for measures whose status is a monotone step function of
   days-since-event (windowed-recency OSHA/wellness + PERMANENT series). `flu_vaccine` (seasonal) and
   `cms122`/`cms125` (period-based) are EXCLUDED from across-day reuse — same-day-hash only — because a
   stale copy could ship a wrong status when the season/period rolls. The `next_transition_at` threshold
   table is **golden-verified against the real CQL engine** so it can never silently drift.
3. **Copy-forward evidence is date-corrected, not verbatim** (design §3 option 1): each `"Days Since …"`
   define is advanced by the elapsed days (measure-agnostic; same-day copy is byte-identical), so
   `deriveWhyFlagged`'s `days_overdue` stays honest and the parity guarantee holds.
4. **Inert-unless-configured** (`WORKWELL_INCREMENTAL_EVAL=true`; the 10th boot-inventory seam) and
   **scoped to the live-tenant pipeline** (`finishManualRun`) — the scale batch path and the demo/default
   stack are byte-identical to today (no `eval_state` row is ever written).
5. **The `eval_state` table is a pure cache** (DATA_MODEL §3.27): reversible with `DELETE FROM eval_state`,
   no row references it.

**Correctness invariant (ADR-008).** Reuse decides only WHETHER to re-ask the CQL engine, never the
answer. A cache miss on ANY uncertainty falls back to a full evaluation. The acceptance criterion is the
parity suite (`run/incremental/parity.test.ts`): on identical data an incremental run is byte-identical
to a full run, and it re-evaluates exactly when (and only when) the answer could have changed.

**Two correctness holes caught in code review (both P1, fixed pre-merge) — worth recording because they
are the non-obvious ways this feature can go wrong:**
- **Backdated runs.** The whole `next_transition_at` scheme assumes the clock only moves forward. A
  rerun of an *older* run (which reuses that run's persisted `evaluationDate`) after a newer run advanced
  the cache would otherwise copy a future-computed status backward (July's OVERDUE into a June rerun).
  Fix: reuse requires `evalDate >= source_eval_date`; a backdated run always re-evaluates.
- **`logic_version` must reflect the EXECUTED library + value-set membership.** Hashing only the base ELM
  would let a VSAC toggle/re-import or an operator value-set edit slip through (same `data_hash`, same
  base ELM, different codes). Fix: hash the engine-selected library (base vs `expansionLibrary`) plus the
  referenced value sets' store `expansion_hash`. Byte-identical on the demo/scoped path.

**Scope decisions (owner, 2026-07-24):** live tenants only (exclude the synthetic scale tenant — ~2,100
rows vs ~1.7M of no-real-value cache); build `next_transition_at` (the ~90% saving, vs ~21% hash-only);
recompute evidence at copy time. Tier 1 (`Group/$export?_since=` transport pre-filter) remains MIE-gated
and unbuilt.

## ADR-034: Standalone WCDB FHIR shim package (`wcdb-fhir-shim/`) owns the MariaDB driver; CQL→SQL generation stays pure in backend-ts

**Status:** Accepted (2026-07-20).

**Context:** The 2026-07-19 Doug call gave two build directives that supersede the 2026-07-15 D17
position ("CQL runs our side; CQL→SQL parked"): (1) build our **own** small FHIR R4 facade directly
over the WebChart MariaDB dev database (`ghcr.io/mieweb/dev-wcdb`, 56 synthetic patients) — a "shim"
proving the layered/swappable-API contract — and (2) translate CQL measures + the WCDB schema into
**SQL that runs against the WebChart database itself**, returning numerator/denominator behind a
simple compliance API ("is this patient compliant for this measure in this range?"). Directive (2)
activates epic #292 (E9 Option B) ahead of its recorded trigger conditions — Doug's direct request
plus the in-hand dev-wcdb schema satisfy the gate. Executing SQL requires a MySQL/MariaDB client,
but backend-ts is deliberately driver-free (locked 2026-07-03: the dev-DB export shells
`docker exec … mysql`), and the `MeasureExecutor` port (ADR-025) is bundle-in/DB-less by design —
an impedance mismatch with set-at-a-time SQL.

**Decision:** A new top-level **standalone package `wcdb-fhir-shim/`** hosts both directives'
runtime: the FHIR facade (plain `node:http`; endpoints matching the verified WebChart client
contract — `{base}/fhir` root, paged `Patient` search with same-origin `link[next]`, per-resource
`?patient=` composition, `/fhir/metadata`) and the compliance API that executes generated SQL.
**`mysql2` is approved as a dependency of this package only** — backend-ts remains
MariaDB-driver-free. CQL→SQL **generation** (`generateSql`, sibling to `generateCql`) lives in
backend-ts as pure, dependency-free templating over the existing rule-param shapes and terminology
crosswalk; its output is committed as reviewed `.sql` artifacts in `wcdb-fhir-shim/sql/`
(freshness-tested), which the shim executes with bound parameters. The bundle-shaped
`sqlPushdownExecutor` stub stays inert; wiring SQL into the app's executor seam remains gated on
per-measure golden parity (ADR-025), which this wave proves externally: the CQL engine evaluating
the shim's FHIR output is the parity oracle for the SQL results over the same 56 patients.
Scope v1 = windowed-recency measures only (WCDB has no immunization table, so series-completion
SQL could never reach parity there).

**Consequences:** The app is byte-identical when the WebChart seam is unset; the shim + `wcdb`
containers join `infra/docker-compose.yml` under an opt-in `wcdb` profile. One new dependency
(`mysql2`), isolated in a package the deployed stack never loads. The shim is dev/demo-grade by
declared intent (no auth enforcement, synthetic data only, never deployed to the live stack —
mirrors Doug's "you don't even need security"). CQL remains the sole compliance authority
(ADR-008): SQL results serve only the shim's demo API until parity-gated per ADR-025.
Reversal = delete the package + compose profile; backend-ts codegen additions are pure and inert.

**Addendum (2026-07-20, PR #316 — YAML ingest):** the shim additionally takes **`yaml`** (parsing
only, for the AI-patient ingest CLI) and moves **`tsx`** to runtime dependencies (it always executed
the package; now the lockfile/Docker image pin it). Same scoping as `mysql2` — shim-only, never
backend-ts, never the deployed stack. The ingest tool's safety contract: writes are
model-catalog-validated (existence + declared type), transactional (one BEGIN…COMMIT per run),
manifest-reversible (`<file>.ingested.json` records exactly the created pat_ids; `--rollback`
refuses natural-key guessing), guarded to local `wc_*` targets, and logged to an append-only
`ingest-audit.log` (the dev-tool analogue of the app's `audit_events` rule — the WCDB has no
WorkWell audit table to write to).

**Status:** Accepted (2026-07-17).

**Context:** A configured WebChart population can be evaluated through the existing FHIR/CQL ingress,
but persisted outcomes carry only subject ids. The static synthetic directory therefore dropped live
subjects from roster, hierarchy, programs, case identity, and quality scopes. Persisting a second
clinical/directory model would add owner-gated DDL and risk making stale clinical data look current.

**Decision:** Keep a per-worker, atomically replaced last-known-good registry of live identity profiles
(`wc|Patient.id`, display name, birth date, and fixed `wc`/`WebChart`/`wc-provider-1` placement). It is
a directory cache only; clinical bundles are never cached for verification. Every population read or
materialization first loads its persisted latest/run outcome rows, constructs exactly one
`directoryForRows(rows)` snapshot, and threads that snapshot's lookup closures through the operation.
The snapshot merges the static catalog, the registry, and minimal profiles for unknown persisted `wc|`
ids (`name = raw Patient.id`). A successful population fetch replaces the registry; a fetch failure
aborts the configured population run before any outcomes, leaving the prior successful run and registry
authoritative. Read models ignore FAILED runs.

Clinical eligibility and `Outcome Status` remain exclusively CQL-owned (ADR-008). The live enrollment
override is optional; the default is enroll-all within the existing fail-closed eligible-measure list.
Existing site-specific segments do not match `WebChart`, so they create no live cases unless an
administrator adds that site. Fetch-one-subject is not available in phase 1: `wc|` CASE reruns return a
controlled, non-mutating 409, and `SITE=WebChart` remains unsupported rather than superseding a whole
population with a partial latest run.

**Consequences:** No schema, dependency, frontend, or clinical-cache change is introduced. A worker
restart temporarily shows raw Patient ids until the next successful population refresh, while persisted
rows and hierarchy/quality totals remain visible and reconciling. Unsetting the WebChart configuration
restores the byte-identical static path; stored outcome history remains but the live tenant is no longer
selected. Reversal is therefore environment-only plus an ordinary code revert. Real provider/site
attribution, fetch-one CASE/EMPLOYEE, safe SITE latest-run semantics, and identity linking are deferred.

## ADR-032: A local HAPI FHIR server is the WebChart simulator ("fake WebChart")

**Status:** Accepted (2026-07-16).

**Context:** The 2026-07-15 Doug meeting confirmed the integration contract (FHIR R4 + SMART
Backend Services; data flows WebChart→WorkWell) and suggested standing up a HAPI FHIR server over
the dev-DB data to simulate WebChart. Until now the live transport (`httpWebChartClient`, ADR-028)
had only ever run against in-process shims — the fixture client and a mock-`fetch` conformance
suite — so real-HTTP behaviors (server-minted pagination links, the off-origin guard, header
handling against a genuine server) were untested in anger. Separately, the real teatea trial
instance is remote, read-only via FHIR, and rate-limited by courtesy — unsuitable as a
development/CI hammer.

**Decision:** The official `hapiproject/hapi` image (already in `infra/docker-compose.yml`, R4,
port 8081) is the local WebChart stand-in, populated from the committed dev-DB fixtures by
`pnpm load:hapi` via a pure collection→transaction transform (`hapi-transform.ts`): `PUT` with
preserved patient ids (roster keying) and deterministic minted ids for id-less clinical resources
(idempotent re-loads). The `jamesagnew/hapi-fhir` fork Doug pointed at is a stale personal fork of
upstream with no MIE-specific code — the official image is used instead. Stock HAPI stays open
(no auth): the static-bearer path exercises the Authorization header, while the SMART
backend-services flow is proven against the real trial. Division of labor: **HAPI = local/CI
real-HTTP + rich-clinical-data proof; teatea = real-contract auth + live-instance proof.**

**Consequences:** Development and self-skipping live tests never depend on the remote trial;
re-loads are idempotent (verified 293 created → 293 updated, no growth); the simulator is one
`docker compose up` away. HAPI is not WebChart — contract quirks (scope forms, grant types, paging
behavior) are still verified against teatea and recorded in the #254 answer log. Descriptive only
(ADR-008): the simulator feeds data; the CQL engine remains the sole compliance authority.

## ADR-031: MeasureReport exports use membership-label counts and binding-owned measure semantics

**Status:** Accepted (2026-07-15).

**Context:** Connectathon review found two export-only conformance defects. First, WorkWell reported
`DENOM = IPP - DENEX`, even though the clarified calculation example on the `fhir-cqm` ballot branch
`br-57509` treats denominator populations as membership labels: exclusion members remain in the
reported DENOM and subtract only in the score (`score=(3-1)/(6-1-1)` over `DENOM=6`). This is a
ballot-branch QM IG clarification, not yet published normative text, but the worked arithmetic is
unambiguous. Second, the generic outcome mapping counted every `MISSING_DATA` subject in IPP/DENOM;
that is correct for WorkWell's OSHA/HEDIS-style measures, but `cms122.cql` and `cms125.cql` explicitly
emit `MISSING_DATA` for `not Initial Population`. Both defects affected FHIR/QRDA export numbers only;
stored outcomes and compliance decisions were correct.

The same review found a fragile semantic coupling: the exporter hardcoded `improvementNotation` to
`increase`. That is internally correct only because WorkWell defines every numerator as
compliance-oriented (including an inverted CMS122 numerator) and claims a WorkWell canonical rather
than the official CMS canonical.

**Decision:**

1. `countPopulations`, the bounded status-histogram path, individual memberships, FHIR summary score,
   and the QRDA performance rate share membership-label semantics: `DENOM = IPP`, `EXCLUDED` contributes
   to both DENOM and DENEX, and the effective score denominator is `DENOM - DENEX` (guarded above zero).
2. Measure-specific export semantics live in the YAML-generated `MEASURE_BINDINGS`. All current
   measures explicitly declare `improvementNotation: increase`; only `cms122` and `cms125` declare
   `missingDataMeansOutOfPopulation: true`, mapping `MISSING_DATA` to all-zero populations in both
   count paths and individual reports.
3. MeasureReport export must continue to claim `urn:workwell:measure:*`. Switching to an official CMS
   canonical is forbidden unless numerator orientation and improvement notation are changed together;
   a guard test pins this invariant.
4. Add base-R4 identity/provenance elements (`MeasureReport.id`, report-generation `date`, contained
   WorkWell Organization `reporter`, and Bundle-entry `urn:uuid:*` `fullUrl`) without claiming DEQM
   profiles. The route injects one generation timestamp so the timestamp field remains deterministic
   under test; the run's measurement timeframe remains in `period`.

**Consequences:** Exported DENOM values increase by the DENEX count, while scores are unchanged for
OSHA/HEDIS-style measures because exclusions still subtract in the rate. CMS122/CMS125 IPP and DENOM
now omit out-of-population `MISSING_DATA` rows, correcting their previously deflated exported scores.
Individual populations still sum exactly to the summary. QRDA inherits the same corrected count/rate
semantics. CQL `Outcome Status` remains the sole compliance authority (ADR-008); no schema, dependency,
or stored-outcome change is introduced. Accepted limitation: the run pipeline forces a per-subject
evaluation failure to `MISSING_DATA`, with `evidence_json.evaluationError`; for `cms122`/`cms125`, the
FHIR/QRDA exports consequently omit that subject from IPP/DENOM, indistinguishable from verified
not-in-IPP. A future refinement may distinguish those cases using the persisted evaluation-error
evidence. Revisit the count interpretation if the final published QM IG materially differs from the
cited ballot-branch clarification.

**Amendment (2026-07-24, roadmap §7.4 PR-3) — membership is evidence-first.** Point 2 above does not
scale: it needs one hand-written binding flag per measure, and the eight incoming official CMS measures
would each need one guessed from their CQL. It also cannot express DENEXCEP/NUMEX, and it inverts for
lower-is-better measures (cms122's numerator is poor control, so an official NUMER subject carries the
workflow status OVERDUE). So `membershipFor(outcome, measureId)` now reads
`evidence_json.official.populationResults` **first** and uses it verbatim when present — that is the
measure's own logic reporting its own populations, and it is authoritative over any status heuristic.
When absent (every measure today, and every authored measure forever) the point-2 rule applies
unchanged, so this amendment is **behavior-neutral until the official flip**; malformed evidence
degrades to the status rule rather than throwing inside an export. `denominator-exception` is emitted
and subtracted from the effective score denominator in **both** MeasureReport and QRDA III, but only
when non-zero — so authored exports remain byte-identical. Two deliberate limits: (a)
`populationCountsFromStatus`, the bounded histogram behind 120k `seed:scale` summaries, has no
per-subject evidence and stays valid for authored measures only; (b) keying out-of-IPP off each
measure's own `"Initial Population"` define — which **is** persisted, and is defined by all 16
`.cql` artifacts (the 14 runnable measures plus `cms122_official`/`audiogram_vs`) — was
considered and **rejected for now**: it would change exported IPP/DENOM for the 12 OSHA/HEDIS measures
(e.g. audiogram's IPP is `In Hearing Conservation Program or Has Active Waiver`, so non-enrolled
subjects currently inflate the denominator) *and* break the documented 1:1 reconciliation with the
histogram path. That is a real correctness finding, but it is a deliberate reporting change that
deserves its own decision, not a silent side effect of this one.

## ADR-030: Durable evidence storage is an app-level S3 seam (`resolveBucket`), not a binding-config change (#167 / #270)

**Status:** Accepted (2026-07-14).

**Context:** Evidence bytes lived behind the `CloudBucket` port on the live stack's in-container `fs`
`BUCKET` binding — lost on every container recreate (deploy/heal). DEPLOY.md's documented recipe was
"point the `BUCKET` binding at the s3 driver", but the `@mieweb/cloud` config loader
(`external/mieweb-cloud/packages/cli/src/config.mjs`) parses `mieweb.jsonc` bindings as **literal
JSON — no env substitution** — so a committed binding cannot carry credentials, and the config-level
route is unreachable without forking the platform CLI. Separately, the #270 runbook found the live
Neon PITR window is the **Free-plan-capped six hours** with **no second recovery line**; one managed
bucket unblocks both evidence durability (#167) and a nightly `pg_dump` (#270).

**Decision:** Select the durable backend **at app level**, exactly like the `DATABASE_URL` store
override (stores/factory.ts): a `resolveBucket(env)` seam (`backend-ts/src/case/resolve-bucket.ts`)
that constructs an S3-backed `CloudBucket` via `createS3Bucket` (`@mieweb/cloud-os` — the same adapter
the mieweb target's binding uses) **only** when ALL THREE of `WORKWELL_BUCKET_S3_BUCKET` +
`WORKWELL_BUCKET_S3_ACCESS_KEY_ID` + `WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY` are set
(inert-unless-configured, the 9th inventory seam `bucket-s3`; region defaults us-east-1; `endpoint`
only for non-AWS S3 — it also flips to path-style). `createIfMissing: false` — bucket provisioning is
owner-gated infra and the app's IAM policy deliberately cannot create buckets. The provisioned bucket
is `workwell-twh-evidence` (us-east-1, public-access-blocked, versioned; least-privilege IAM user
`workwell-twh-app`; 30-day lifecycle on `db-dumps/`). A nightly `backup-neon-nightly.yml` workflow
dumps the `workwell_spike` schema to the same bucket. **`@aws-sdk/client-s3` is an approved dependency
add** — it is the platform package's own declared optionalDependency for this adapter, promoted to a
direct dep so the seam works on the `local` target the live container runs.

**Consequences:** evidence survives container recreates on the live stack with zero `EvidenceService`
changes (the `CloudBucket` contract is unchanged); unset env ⇒ byte-identical fs-binding behavior
(tested); the remaining #270 gap — the 6-hour PITR window itself — is a Neon **plan-upgrade decision**
(owner/billing), tracked for the MIE conversation.

## ADR-029: Immunization forecasting is a self-hosted ICE sidecar behind the existing port — the stub is replaced by a real adapter (#76 / D18)

**Status:** Accepted (2026-07-13).

**Context:** `iceForecaster` had been an **inert stub** since E6 (#76) — it returned "ICE not wired
(Doug Q5)" for every series — because the transport question (CDS Hooks vs ICE API vs a WebChart-ICE
bridge) was deferred to MIE. The 2026-07-13 research pass
(`docs/INTEGRATION_RESEARCH_2026-07-13.md` §4) established that ICE is **self-hostable today**: HLN
publishes an official, actively ACIP-maintained Docker image (`hlnconsulting/ice`), and its OpenCDS
DSS REST endpoint answers real forecasts. That answers #254 Q D18 ourselves — no MIE dependency. A
Java→TS port of ICE remains infeasible (a continuously-updated Drools rule base is the product).

**Decision:**
1. Replace the stub with a **real HTTP adapter** (`engine/immunization/ice-forecaster.ts`) speaking
   the DSS contract (`/api/resources/evaluate`, `/api/resources/evaluateAtSpecifiedTime` for an as-of
   date) over a pure vMR codec (`ice-vmr.ts` — string-template `CDSInput` build + regex `CDSOutput`
   parse; **no new deps**, the same hand-rolled-XML pattern as the QRDA stub). ICE runs as a
   **long-lived sidecar** (~2–3 GB, tens-of-seconds Drools cold start) — never per-request.
2. **The seam predicate relaxes to BASE_URL-only.** A self-hosted sidecar has no API key;
   `WORKWELL_IMMZ_ICE_API_KEY` stays optional (a bearer token if a deployment fronts ICE with an
   authenticating proxy) and can never by itself select the seam. Inert-unless-configured holds: with
   no `WORKWELL_IMMZ_ICE_BASE_URL` the simulated forecaster serves and behavior is byte-identical.
3. **Any failure falls back to `simulatedForecaster`** (injected, so no import cycle): transport
   error, non-2xx, timeout, unparseable body, or a vaccine group missing from the response. The
   forecast is an *advisory* panel — it must degrade, never error the case-detail read (ADR-012).
   The fallback is deliberately **all-or-nothing**: a half-ICE/half-simulated forecast would be an
   unattributable mix of two schedules.
4. The port's `forecast()` becomes **async** (it is now a network call); selection moves to
   `resolve-forecaster.ts` (above both port and adapter).
5. Forecasting stays **advisory only** — it never sets or overrides an `Outcome Status`. CQL remains
   the sole compliance authority (ADR-008/ADR-012). ICE and WorkWell can legitimately disagree (ICE
   scores full ACIP; a WorkWell measure scores its own rule) and that is not a defect.

**Operational hardening (from the whole-branch review):**
- **The request-path timeout is 3 s, not a cold-start budget** (a warm ICE answers in ~50–300 ms), and
  a **60 s circuit breaker** trips on failure. Without it, an unhealthy sidecar would charge *every*
  `GET /api/cases/:id` the full timeout, forever — an interactive-latency incident whose only symptom
  is a slow page. With it, an unhealthy ICE costs one timeout per TTL.
- **ICE's clock is ALWAYS pinned** (`/evaluateAtSpecifiedTime` with `specifiedTime = asOf`, even when
  `asOf` is today). `/evaluate` evaluates at the *container's* clock, so a TZ-skewed or drifting ICE
  host would shift "today" forecasts by a day while as-of forecasts stayed correct. Verified live:
  pinning today returns byte-identical proposals, so this costs nothing.
- **`CONDITIONAL` is deliberately NOT surfaced as DUE.** ICE emits it for risk-conditional
  recommendations, and an occupational-health cohort often *is* that high-risk group — but we do not
  send ICE a risk group, so it cannot have applied one, and we must not assert one on its behalf.
  Rendering every CONDITIONAL as DUE would manufacture work items ICE did not unconditionally
  recommend. The reason string carries it verbatim (`ICE CONDITIONAL (HIGH_RISK)`); a risk-group-aware
  mapping is future work, and needs the OH risk cohort in the CDSInput first.
- **`dosesRequired` on the ICE path follows the CVX we actually report** (HepB = 3, the traditional
  adult series we send as CVX 43 — not the Heplisav 2 the simulated forecaster models), so the card
  cannot read the self-contradictory "2 of 2 doses — OVERDUE".

**Two contract facts the live engine taught us** (both regression-tested, and neither documented
where we looked):
- The **request's** `base64EncodedPayload` is an **ARRAY**, not a string — a bare string is rejected
  `400 Bad Request`.
- A proposal's **vaccine group is on `<observationFocus>`, not `<substanceCode>`**: ICE proposes a
  concrete *product* for some groups (CVX 115 Tdap under focus group 200 DTP; CVX 187 Shingrix under
  focus 620 Zoster). Keying on the substance loses TDAP entirely for any subject with **no DTP
  history** — i.e. exactly the adult occupational-health population — and (per decision 3) that
  silently degraded the whole forecast to simulated.

**Consequences:** D18 is answered without MIE. The demo/live stacks stay unchanged (no
`WORKWELL_IMMZ_ICE_BASE_URL` ⇒ simulated); `infra/docker-compose.yml` gains an opt-in `ice` service
for local/self-hosted use. The dose-history source is **injectable** (`historySource`) — the synthetic
history is today's demo source and real WebChart immunization history is the E12 drop-in. Reversible
by reverting the adapter commits (the port shape, minus `async`, is unchanged). Verified against a
real `hlnconsulting/ice` container: 5 live tests (self-skipping without the env var) plus a golden
fixture captured from that container.

## ADR-028: WebChart transport implements the verified public FHIR contract — SMART Backend Services auth (dual-mode) + per-resource composition — E12 PR-2c (#262)

**Status:** Accepted (2026-07-13).

**Context:** The #255 pre-build coded `httpWebChartClient` against an *assumed* contract (static bearer
API key + `Patient/$everything`), pending MIE's #254 answers. A 2026-07-13 public-sources research pass
(`docs/INTEGRATION_RESEARCH_2026-07-13.md`) live-verified WebChart's real contract from its public FHIR
sandbox and published docs: auth is **SMART Bulk Backend Services** (`client_credentials` + RS384
`private_key_jwt` verified against a registered JWKS — not an API key), and the CapabilityStatement
exposes **no `Patient/$everything`** (per-resource `?patient={id}` searches; the only operation is
`Group/$export`). Waiting for MIE to restate publicly documented facts was the wrong trade.

**Decision:**
1. `httpWebChartClient` implements the **verified** contract: population `GET /fhir/Patient` (searchset
   `link[next]` paging) + per-patient composition from paged
   `GET /fhir/{Observation|Condition|Procedure|Immunization|Encounter}?patient={id}` searches into one
   collection Bundle.
2. **Auth is dual-mode behind a `WebChartAuthProvider` port** (`smart-backend-auth.ts`):
   `smartBackendServicesAuth` (smart-configuration discovery or `tokenUrl` override; RS384
   `private_key_jwt` assertion; token cache + expiry skew; single-flight refresh; 401 → invalidate +
   one retry) is selected when `WORKWELL_WEBCHART_CLIENT_ID` + `WORKWELL_WEBCHART_PRIVATE_KEY` are set;
   the legacy static bearer (`WORKWELL_WEBCHART_API_KEY`) is retained for fixtures/tests/proxies.
   Signing uses **WebCrypto only** (portable, mirrors `auth/password.ts`; no `node:crypto`, no new deps).
3. **Any per-resource fetch failure degrades the whole patient** to the Patient-only fallback bundle
   (⇒ MISSING_DATA downstream): partial clinical data must never evaluate — a missing
   Condition/Observation page could silently flip an outcome. The off-origin pagination guard now also
   covers resource searches (it protects the OAuth token, not just the legacy key).
4. Pagination semantics remain **unverified** with MIE (#254 A2): `_count` + `link[next]` are the
   standard-FHIR conservative default; `Group/$export` (bulk) is future scope tied to #263.

**Consequences:** PR-2c is no longer blocked on #254 for request shaping — only for credentials
(registration/service account) and the residual unknowns (pagination, `$export _since`). The seam
predicate (`isWebChartConfigured`) accepts BASE_URL + (API_KEY or CLIENT_ID+PRIVATE_KEY); the deployed
default stays inert (no env vars → JSON source, byte-identical). Reversible by reverting the client
commits (the `WebChartClient` port is unchanged).

## ADR-027: Production CMS122/CMS125 evaluate eCQI v14 faithful-subset CQL (not toy day-count rules); literal QICore remains diagnostic — 2026-07

**Superseded — full text in [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md#adr-027).** Production no longer runs the faithful subsets; both measures run CMS's own artifacts. The subsets retire to the standards lab (#377).

## ADR-026: `fqm-execution` as a diagnostic-only dependency for the LITERAL official-CQL execution diff (pre-shipped ELM, no translation) — E14 literal diff (#258)

**Status:** Accepted (2026-07-09). **Supersedes ADR-024's "revisit when the translator ships a stable multi-model release" clause** — the literal official CMS122 measure now runs today, without any translator.

**Context:** ADR-024 shipped a faithful official-**SUBSET** CMS122 because compiling the literal multi-library QICore CMS122v14 CQL was intractable under the pinned JVM-free translator `@cqframework/cql` 4.0.0-beta.1 (its modelinfo loader can't resolve cross-model `FHIR.*`/`USCore.*` refs), and it parked the literal path pending a stable multi-model translator. Research (2026-07-09) established two facts that reopen it: (1) `@cqframework/cql` 4.0.0-beta.1 is the **only** version ever published to npm — that train may never arrive; (2) **translation is unnecessary.** Official CMS/MADiE *computable* FHIR measure bundles ship **pre-compiled ELM** (base64 `application/elm+json`) inside `Library.content`, and MITRE's `fqm-execution` (npm) *executes* those bundles on `cql-execution` + `cql-exec-fhir` — the exact runtime stack this repo already depends on. **Gate result (#258, verified before any code):** the official CMS122v14 MADiE FHIR bundle (`cqframework/ecqm-content-cms-2025` @ `30a627013f1c…`, measure `CMS122FHIRDiabetesAssessGreaterThan9Percent` v0.5.000, `using QICore '6.0.0'`) carries base64 `application/elm+json` for the Measure **and all 9 chained libraries** — `MISSING ELM: NONE`. A feasibility probe then executed the literal artifact end-to-end via fqm-execution against a plain-FHIR patient (IPP/DENOM/DENEX/NUMER all computed). So the ADR-024 blocker is irrelevant: **we run pre-compiled ELM, we do not translate.**

**Decision:** Add **`fqm-execution` pinned to `1.8.5`** as a **DIAGNOSTIC-ONLY** dependency and build the LITERAL execution-diff tier on it.
- **Isolation is a hard invariant.** `fqm-execution` is imported from **exactly one** module — `backend-ts/src/standards/literal-diff.ts` (a lazy `await import("fqm-execution")`) — and reached **only** from the `/api/measures/cms122/fidelity/diff` route. It must **never** be imported by the run pipeline, `engine/ingress/`, or `worker.ts`. An arch/grep test (`standards/fqm-isolation.test.ts`) asserts the single owner and the empty forbidden set; CI fails if the import leaks.
- **Transitive deps.** `fqm-execution` pulls `axios`, `handlebars`, `moment`, `lodash`, `cql-exec-fhir`, `cql-execution`, `fhir-spec-tools`, `commander`, `core-js`, `uuid`. Two (`cql-exec-fhir ^2.1.6`, `cql-execution ^3.3.2`) are **already** direct deps at the same versions — no runtime-stack fork. The rest are diagnostic-path only (never loaded unless the literal fidelity-diff route runs), and the pinned version freezes the whole graph.
- **Three-tier ladder** (`chooseDiffMode(resolver, literalAvailable)` in `routes/measures.ts`): **literal** (vendored official bundle present + every VSAC value set resolves non-empty from the imported `value_sets`) → **subset** (ADR-024 official-subset, when the bundle is absent) → **estimate** (PR-2 criteria-impact, when the value sets don't resolve). The `GET /api/measures/cms122/fidelity/diff` response carries an additive `mode: "literal" | "subset" | "estimate"`. A runtime literal failure (fqm fighting the runtime) is caught and degrades to the subset tier rather than failing the route.
- **Vendored artifact.** ⚠ **SUPERSEDED by the PR-5 amendment below — do not follow this bullet.** *(As written 2026-07-09:)* The official bundle is committed under `backend-ts/measures/official/cms122v14/` (README with provenance URLs + SHA). Redundant `application/elm+xml` content blobs (which fqm-execution never reads) were stripped to keep the vendored file lean; every library retains its `application/elm+json` + `text/cql`. *(Now: `measures/official/cms122/` under a manifest; `text/cql` is stripped too — only `application/elm+json` survives.)*

**Descriptive-only, structurally guaranteed (ADR-008).** The literal diff **writes nothing** and never sets an `Outcome Status`. It reuses ADR-024's harness-local `enrichForOfficialCms122` (real VSAC codings **appended** to the diff harness's own bundle copy, never the shared `fhir-bundle-builder.ts`, never the live run path) plus a literal-only `stampQiCoreStructure` (normalizes the synthetic Conditions to QICore-active/confirmed with an in-past onset, and adds Encounter `class`) — all fields WorkWell's plain-FHIR cms122 CQL ignores. So WorkWell's cms122 outcomes stay **byte-identical** (guard test `literal-diff.test.ts` + the pre-existing `cms122-official.test.ts`). fqm-execution runs with `trustMetaProfile:false` (retrieve by base FHIR type, since our bundles are plain FHIR) and a `valueSetCache` built from the imported VSAC rows (no runtime VSAC key; the key was only for the one-time `pnpm resolve-valuesets` import). Per-subject population membership (IPP/DENEX/NUMER) maps to WorkWell's outcome vocabulary; divergence attribution is population-level (`initial-population` / `denominator-exclusion` / `numerator-glycemic-status` / `workwell-exclusion`) — the finer per-define attribution remains in the subset path.

**Consequences:** The literal official CMS122v14 QICore artifact now runs as a real, subject-by-subject execution diff — no translator, no VSAC key, **no schema**. New dependency `fqm-execution@1.8.5` (owner-pre-approved for the diagnostic path via the 2026-07-09 roadmap; this ADR records the terms). Reversible: revert the PR (drop the dep + the vendored bundle + `literal-diff.ts`); the ladder degrades to subset/estimate exactly as before. **#251 is superseded/closeable.** Full suite green — 1065 pass / 1 pg-skip / 0 fail. Known bounds: literal diff is **CMS122-only**; gate attribution is population-level; ~~the vendored measure is v0.5.000~~ **(superseded — v1.0.000 since PR-5; see the amendment below)**.

**Amendment (2026-07-24, roadmap §7.4 PR-5) — the vendored artifact moved SOURCE REPOSITORY, not just
version.** This ADR pinned `cqframework/ecqm-content-cms-2025 @ 30a627013f1c…`, measure
`CMS122FHIRDiabetesAssessGreaterThan9Percent` **v0.5.000**. The artifact is now
`cqframework/dqm-content-qicore-2025 @ ca4b4951…`, measure `CMS122FHIRDiabetesAssessGT9Pct`
**v1.0.000** — a different repository, measure name, and canonical URL, so this is not the version bump
it looks like. The move follows the 2026-07-24 recalibration: `dqm-content-qicore-2025` is the QI-Core
content line that also publishes the MADiE test decks we gate on, and all eight priority measures were
verified present there, so bundle and test deck now come from one pinned source. The fidelity-diff
response's `officialMeasure.url` changes accordingly — a deliberate, visible API change.
Two further corrections to this ADR's text: the vendored bundle no longer retains `text/cql` (only
`application/elm+json` survives reduction), and the artifact lives at `measures/official/cms122/` under
a manifest, not at `measures/official/cms122v14/` under a versioned filename. **Licensing:** the
reduction drops all ValueSet resources and their expansions, but the compiled ELM still embeds the
direct-reference codes the official CQL declares inline (CPT + SNOMED, with descriptions), so
`measures/official/NOTICE.md` records those terms — including NCQA's commercial-use clause, which is an
open owner/legal question.

**Amendment (2026-07-24, roadmap §7.4 PR-4) — the quarantine is now a PACKAGE BOUNDARY.** The invariant
was never "fqm-execution is diagnostic-only"; it was **"its heavy transitive deps must not reach the
worker's cold-start or request path, and CQL remains the sole outcome authority."** A file allowlist was
the cheapest way to express that at the time, but it could not survive official-first execution, where
fqm legitimately becomes a *production* evaluation path (PR-7). The dependency now lives in
**`@workwell/official-executor`** — one `package.json`, pinned `1.8.5` — whose entry point imports it only
through a lazy `await import`, so consuming the package costs nothing until something calculates. The
single allowlist test is replaced by three that are harder to defeat than one grep: the **manifest**
(no workspace package other than the executor may declare fqm; the app declares none), the **app tree**
(no `src/` file — nor any other package's source — imports it directly), and the **lazy-import check**
(every fqm reference in the package entry, comments stripped, must be the dynamic `import(...)` form, so
the multi-line `import { … } from "fqm-execution"` shape a formatter produces cannot slip past — plus a
positive assertion that the app cannot even *resolve* fqm under pnpm's strict linking). Both original protections therefore survive, and
the "diagnostic-only" framing is retired rather than the invariant.

## ADR-025: Measure execution is pluggable behind a `MeasureExecutor` seam; FHIR-native is the default + correctness oracle, CQL→SQL is a parity-gated future executor — E9 (#78)

**Status:** Accepted (2026-07-08). Supersedes the *Deferred-to-Doug* status of **ADR-014**; makes concrete the "opt-in second executor as future work" that **ADR-017** parked.

**Context:** E9 (#78) is the charter's biggest architectural fork (Doug **Q2**): do we **transpile CQL→SQL** so measures run *inside* WebChart's MariaDB report engine (data never leaves — "run where the data lives"), keep the **CQF/FHIR engine** as the report engine (data adapted *out* to FHIR bundles — ADR-017's chosen direction), or a **hybrid**? ADR-014 recorded the recommendation (hybrid, FHIR-native-first) but left the decision *deferred pending Doug's Q2*. Proceeding on our own, the decision has to be robust to **either** answer Doug could give, and E9's own charter says it ships *"a decision, not a build"* (full transpilation is research-grade). So the deliverable is the **decision + the seam shape**, not a transpiler.

**Decision:** Adopt the **hybrid (Option C)** as the architecture, commit **Option A** as the built default, and stub **Option B** behind the seam:
- **One `MeasureExecutor` port** (`backend-ts/src/engine/measure-executor.ts`) — a pluggable measure-execution strategy that **extends `EvaluateMeasureBinding`** (the headless patient+measure → `MeasureOutcome` contract), so any executor is directly injectable into `evaluateBundle`/`evaluateBatch` (`opts.engine`) and the run pipeline **with no new plumbing**. `resolveMeasureExecutor(env)` selects config-driven, mirroring `resolveDataSource`/`resolveForecaster`/`resolveChannel`/`resolveStandingOrderProvider`.
- **Option A — `fhirNativeExecutor` (built, DEFAULT + correctness oracle).** Adapt data into a FHIR bundle, evaluate with the existing JVM-free CQL→ELM engine. It IS the engine the run pipeline + E12 ingress already use, so the default introduces **no second evaluation path** and changes **no outcome** (parity-tested against the direct engine path). Full eCQM fidelity; CQL `Outcome Status` stays the sole compliance authority (ADR-008).
- **Option B — `sqlPushdownExecutor` (INERT stub, research-grade).** Run a measure as SQL inside WebChart's MariaDB. **Not built:** general CQL→SQL (interval/temporal algebra, FHIRPath navigation, value-set expansion, 3-valued null logic) does not map to portable SQL, and the only concrete CQL→SQL transpiler (VA) is Databricks/Spark-only, not transactional MariaDB. Inert-unless-built (mirrors the inert `webChartDataSource`): it constructs so the seam is fully wired and selection is testable, but `evaluate` **rejects loudly**. Selected only on an explicit `WORKWELL_MEASURE_EXECUTOR=sql-pushdown` opt-in — so the deployed default is byte-identical to today.

**Why this is right even without Doug's answer.** It can't be wrong either way: if Doug requires in-WebChart execution, the seam is already there for a **scoped, per-measure** SQL executor; if "CQL→SQL" was shorthand for "replace hand-written SQL reports with a measure engine," that's Option A, which we're already building. A's weakness is **scale** (materializing bundles + per-subject evaluation at population size — E13 PR-2 sidestepped it by *generating* the 120k tenant's outcomes rather than live-evaluating 1.68M/run), which is ordinary batch/incremental engineering; B's weakness is **fidelity**, which is research-grade and possibly unsolvable — so B can never be the correctness *authority*, only a parity-gated optimization for a narrow measure subset (existence/recency/simple counts). A compliance engine that is only right for the easy measures is not defensible (ADR-008, and the standards exports MeasureReport/QRDA/QI-Core all depend on the real CQL engine).

**Guardrail — parity gate.** Any future SQL-pushdown executor must pass **golden parity** against `fhirNativeExecutor` (the oracle), **per measure**, before it is allowed to serve. Never trusted on assertion.

**Consequences:** Descriptive only (ADR-008) — the executor decides *how* a measure is computed, never that anything but CQL sets `Outcome Status`. **No schema, no new dependencies, no engine change** (the seam is additive; the default delegates to the existing engine). *Future-wiring note:* when a live route is switched onto this seam it must thread the env-built engine through — `resolveMeasureExecutor(env, await engineForEnv(env))` — so the keyed VSAC path (ADR-023) is preserved; a bare `resolveMeasureExecutor(env)` builds a resolver-less engine (correct for the unwired default today, byte-equal for the `urn:workwell:*` measures, but it would silently drop VSAC expansion on the keyed path). B is deferred as its own research-grade epic (revisit when a concrete high-volume WebChart measure demonstrates A can't serve it economically, and once the WebChart schema — the same gating unknown as E12 PR-2c — is confirmed). Reversible by reverting the PR.

## ADR-024: Official CMS122 fidelity via a faithful subset, not the literal QICore CQL — E14 PR-3 (#186)

**Superseded — full text in [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md#adr-024).** The faithful-subset approach to CMS122, correct while the translator could not handle the official artifact. Superseded by ADR-026/027.

## ADR-023: Live VSAC value-set resolution behind the `ValueSetResolver` port (composite, inert-unless-configured, descriptive-only) — E14 PR-3 on-ramp

**Status:** Accepted (2026-07-05). **Context:** The engine's `ValueSetResolver` seam (ADR/E3.2, #90) could feed a populated `cql.CodeService` from a store-backed adapter, but a **live** VSAC (NLM UMLS) expansion was still a "future drop-in" — the value sets referenced by real eCQMs (the ~21 VSAC OIDs in the E14 CMS122v14 reference) resolved only against locally-seeded `value_sets`, not the authoritative NLM terminology service. E14 PR-3 (the official-CQL execution/outcome diff) needs real value-set membership, and the CMS122 fidelity report already flags SIMPLIFIED criteria that a true value-set window would tighten. The bar: add live VSAC without any risk of drifting a current measure's `Outcome Status`.

**Decision:** A live VSAC resolver behind the existing port, layered so it is **strictly additive**:
- **Transport seam** — `VsacClient` (`backend-ts/src/engine/cql/vsac-client.ts`): `fixtureVsacClient` for tests + `httpVsacClient` (live NLM FHIR terminology service `GET {base}/ValueSet/{oid}/$expand`, HTTP Basic auth username `apikey` + password = the UMLS API key, pages `expansion.contains`, throws on non-2xx). Uses global `fetch` — **no new dependency**.
- **Resolver** — `VsacValueSetResolver` (`vsac-value-set-resolver.ts`): expands an OID via the client, memoized per-OID, and **propagates errors** — never a silent empty set (a masked empty expansion would quietly change a retrieve's membership).
- **Composite routing** — `CompositeValueSetResolver` + `vsacOid`/`isVsacOid` (`composite-value-set-resolver.ts`): VSAC OIDs — bare (`2.16.840…`) **or** the `urn:oid:2.16.840…` form the repo's authored/exported/official CQL emits (`ai-assist.ts`, `mat-export.ts`) — route to the VSAC tier, normalized to the bare OID VSAC's `$expand` expects; `urn:workwell:*` / canonical URLs / names → the local `StoreValueSetResolver`. So the synthetic measures' `urn:workwell:vs:*` references keep resolving locally exactly as before, and a `urn:oid:` reference no longer silently falls through to an empty store lookup (Codex P2).
- **Inert-unless-configured selection** — `resolveValueSetResolver(env, store)` (`resolve-value-set-resolver.ts`): plain `StoreValueSetResolver` by default; the composite **only** when `WORKWELL_VSAC_API_KEY` is set (mirrors `resolveForecaster`/`resolveChannel`/`resolveDataSource`).
- **Key-gated engine builder** — `engineForEnv(env)` (`engine-factory.ts`). With **no** `WORKWELL_VSAC_API_KEY` it returns a single shared stateless `CqlExecutionEngine` with **no resolver** — byte-identical to today's inline-code path (the store is not even consulted). Only with the key set does it attach the composite resolver. The VSAC credentials are read from the worker **`env` first** (how `DATABASE_URL`/auth/CORS and every other `WORKWELL_*` flag arrive on @mieweb/cloud), with a `process.env` fallback for Node-host/CLI contexts — reading `process.env` alone would leave a worker deployment that sets only `env.WORKWELL_VSAC_API_KEY` on the inline path (Codex P2). A **seed guard** keeps the inline engine when the local `value_sets` are not yet seeded (`stores.valueSets.isEmpty()`): the `urn:workwell:*` seed runs lazily via /api/measures, so a run/scheduler as the first op on a fresh DB would otherwise expand audiogram's set to `[]` and mis-evaluate — inline is byte-equal for those measures until the seed lands (Codex P2). And on the keyed path it builds a **fresh engine + resolver per call** rather than caching one process-wide: the composite's `StoreValueSetResolver` tier snapshots `store.listAll()` for its lifetime, so a process-cached resolver would freeze that snapshot (an operator value-set edit would then serve stale expansions until restart — Codex P1). A per-evaluation resolver (one consistent snapshot per run; fresh next run) always reflects current value sets; engine construction is cheap (FHIRHelpers ELM is a bundled lookup, not a parse). Wired into every runtime evaluation path — the `runs`/`cases`/`measures` routes, `compliance-simulation`, **and** the nightly `schedulerTick` (ALL_PROGRAMS). Deliberately **not** wired into the DB-less `evaluate-bundle.ts` ingress library or the seed CLIs (they stay portable/offline).

**Owner-run import CLI, no DDL.** `pnpm resolve-valuesets` (`backend-ts/src/run/cli/resolve-valuesets.ts`) `$expand`s each target OID via VSAC and upserts the real codes into the **existing** `value_sets` columns (`source="VSAC"`, `status=ACTIVE`, `resolution_status` RESOLVED/ERROR, `resolution_error`, `expansion_hash`, `last_resolved_at`) via `upsertResolvedValueSet` — idempotent per-OID, a failed OID → an ERROR row + continue, audited `VALUE_SETS_RESOLVED` per OID. Default target = the 21 CMS122v14 reference OIDs; `--oid <oid>` (repeatable) / `--measure cms122` override. Owner-run **on demand** (honors `DATABASE_URL` for Neon), **not** on deploy; requires `WORKWELL_VSAC_API_KEY`. **No schema change** — existing columns only (DATA_MODEL §3.4).

**Descriptive only (ADR-008).** VSAC expansion changes *how a value set is populated*, never *how compliance is decided*. Because the composite falls back to the local store for `urn:workwell:*`, enabling the key does **not** change any current measure's `Outcome Status` — guarded by `audiogram-vsac-parity.test.ts` (audiogram inline == composite-with-VSAC-key-on == expected across all scenarios). New env vars: `WORKWELL_VSAC_API_KEY` (the UMLS API key; **the demo stack leaves it unset**) and `WORKWELL_VSAC_BASE_URL` (default `https://cts.nlm.nih.gov/fhir`).

**Rationale:** unblocks real value-set expansion and the E14 official-CQL on-ramp without any compliance drift or new dependency, and keeps the unkeyed (demo) path provably unchanged.

**Consequences:** Full backend suite green — 958 pass / 1 pg-skip / 0 fail; no new deps. Reversible: unset the key → plain `StoreValueSetResolver` (pre-change behavior); remove imported rows with `DELETE FROM workwell_spike.value_sets WHERE source = 'VSAC';` (schema-qualify on Postgres). **Out of scope (the E14 PR-3 follow-on, not done here):** executing the official CMS122 CQL and diffing outcomes subject-by-subject — that needs the official CQL→ELM plus synthetic-data enrichment (encounters/hospice/frailty) so the official denominator populations resolve.

**Notes (2026-07-05 hardening):**
- The CLI-persisted `source='VSAC'` rows are the **governance catalog** (resolution status / provenance / expansion hash in `value_sets`) — the runtime `CompositeValueSetResolver` live-fetches dotted OIDs via HTTP and does **not** currently read these persisted rows as an evaluation cache. A store-then-VSAC fallback (read the persisted expansion when present, live-fetch only on a miss) is a possible E14 PR-3 enhancement.
- `evaluate-bundle.ts` (the DB-less ingress library) and the seed CLIs intentionally stay on the **inline** engine (no resolver). So if a future measure is added whose CQL references a **real dotted VSAC OID**, historical snapshots/exports produced via the inline path and live runs produced via the VSAC path could **diverge for that measure** — to be reconciled when PR-3 wires the first such measure.
- `httpVsacClient` now guards the response: a **200 with an empty expansion but `total > 0`** (the ADR-008 silent-drift case) throws, as does a malformed response with no `expansion` object and a paging loop that exceeds the max-iteration guard; a legitimately-empty value set (`total === 0`, no members) still returns `[]`.

## ADR-022: Cross-system identity is a read-time resolution layer (match-don't-auto-merge; human-in-the-loop) — E15 PR-1 (#187)

**Status:** Accepted (2026-07-01). **Context:** Doug's June-15 feedback — *"same employee in two different systems,"* *"an expatriate might move from one country to another,"* *"someone might move from one oncologist to another,"* plus the DUPLICATE-badge / cross-system employee-search mockups. WorkWell assumed a single directory; E13 (ADR-019) added a tenant/system dimension, but each person still belonged to exactly one system keyed by a system-local `externalId`. Reality: one human is a patient in ≥2 WebChart systems, those records may not obviously be the same person (so they must be *flagged*, not silently merged), and a person's compliance history must **follow** them across a move rather than restarting.

**Decision:** A pure, read-time **person-identity layer** (`backend-ts/src/identity/`) above the existing tenant→enterprise→location→provider→patient hierarchy. A `Person` is a resolved *view* over ≥1 source-system records grouped by a **deterministic match key** (a shared national/MRN identifier; absent one, a record keys uniquely and never groups by accident — the documented seam where a real EMPI/probabilistic matcher drops in, E15 PR-3). `duplicateCandidates` = people whose links span >1 tenant (the DUPLICATE surface). `mergedComplianceTimeline` = the union of each linked record's outcomes, time-ordered and system-tagged, with a mobility annotation (PRIOR → ACTIVE + move date). Exposed read-only via `GET /api/identity/people`, `/people/:id`, `/duplicates`.

**Match, don't auto-merge; human-in-the-loop.** Deterministic candidate keys produce *suggestions*; the confirm/unlink WRITE path (audited `IDENTITY_LINK_*`) is E15 PR-2, owner-gated. EMPI-grade probabilistic matching is explicitly out of scope for PR-1.

**Descriptive only; E13 reconciliation preserved.** Identity groups and follows — it never recomputes compliance (`Outcome Status` per (subject, measure, system) stays authoritative, ADR-008) and never re-aggregates tenant counts: each source record still belongs to exactly one tenant, so All = Σ tenants (ADR-019) holds. A guard test asserts this.

**Consequences:** **No schema in PR-1** — cross-system people are modeled in the read-time synthetic directory (mirrors E13/ADR-019): a shared synthetic `nationalId`/`dateOfBirth` on a couple of existing twh↔ihn employee pairs (zero count change; one pair is the mobility subject, `emp-006` moved twh→ihn). PR-3 = wire the resolver to real WebChart sources via the E12 PR-2 adapter seam (blocked on MIE's WebChart schema). Frontend: a new `/people` route (search + DUPLICATE badge + unified person view + mobility banner). No new deps.

**PR-2 (this slice) — the owner-gated reconcile write path.** A `person_links` table (owner-approved DDL, floor + ceiling, `workwell_spike`; DATA_MODEL §3.26) records a human-confirmed assertion that two source records ARE (`CONFIRMED`) or are NOT (`BROKEN`) the same person. `resolvePeople` becomes **override-aware**: over the auto matchKey grouping (via union-find), a CONFIRMED pair **unions** two records (links even without a shared identifier), a BROKEN pair **removes** the direct auto/confirmed edge (undo a bad shared-id auto-match, or unlink a prior CONFIRM). Pairs are normalized `(a) <= (b)` so the key is direction-independent and UNLINK re-upserts to BROKEN (last write wins). The component's `personId` is the smallest **record ref-key** in it (unique per component — a match-key-based id could not distinguish the two halves of a BROKEN split). Write path: `POST /api/identity/people/:personId/reconcile` (body `{action: CONFIRM_LINK|UNLINK, tenantId, externalId}`), **CASE_MANAGER/ADMIN-gated** + audited (`IDENTITY_LINK_CONFIRMED`/`IDENTITY_LINK_BROKEN`). Frontend: an "unlink" reconcile action on the person view (CM/ADMIN). Still descriptive only — the link overrides read-time grouping, never `Outcome Status`; still match-don't-auto-merge (a human asserts every link). Reversible: `DELETE FROM person_links`. A full merge-picker UI (CONFIRM_LINK across two separately-resolved people) is API-ready but a follow-up. PR-3 remains blocked on E12 PR-2.

## ADR-021: Quality-over-time is a materialized AGGREGATE snapshot store (numerator/denominator per measure/month/scope) — E16 PR-1

**Status:** Accepted (2026-06-30). **Context:** Doug's June-24 ask — *"your system is the source of truth for quality over time… how to know if they were compliant in December? October? August?… you can dump into a table and get the numerators and denominators"* — for 160k patients. The product had **no** persisted historical-quality store: every `/programs` trend recomputed live by re-aggregating `outcomes` grouped by `run`, which only exists for dates a run executed and does not scale (1.68M outcome rows/run at population scale; the per-person Simulate #197 is advisory + non-persisted).

**Decision:** Materialize an AGGREGATE snapshot — one `quality_snapshots` row per (measure, calendar month, scope: all → tenant → site → provider) with numerator/denominator + the 5 bucket counts — on completion of every population run (ALL_PROGRAMS/MEASURE), read back as a bounded table query (DATA_MODEL §3.24). numerator/denominator reuse the existing proportion model (`fhir/measure-report.ts` `countPopulations`: numerator = COMPLIANT, denominator = IPP − EXCLUDED). The scale tenant folds in via the bounded `aggregateScaleRun` GROUP BY (O(providers), **never** the 120k rows). Idempotent (UNIQUE (measure_id, period, scope_level, scope_id), last-write-wins), audited (`QUALITY_SNAPSHOT_MATERIALIZED`), best-effort (a snapshot failure never fails the run — it is hooked AFTER `finalizeRun`).

**Aggregate-only — explicitly NOT per-employee.** A per-subject historical store would reintroduce the very 160k-row scan the table exists to avoid; the per-person "Simulate Compliance History" path (#197) already covers the individual case.

**Descriptive only.** A snapshot counts what CQL already decided; it never sets or overrides `Outcome Status` (ADR-008). Reconciles All = Σ tenants = Σ sites = Σ providers at every (measure, period) — the same invariant as the live hierarchy rollup (ADR-019).

**Consequences:** the first E16 schema (one new owner-applied table; additive `CREATE … IF NOT EXISTS`; reversible by `DELETE`). PR-1 = the table + `QualitySnapshotStore` port (floor + ceiling) + the pure `buildSnapshotRows` core + `materializeRun` + the run-completion hook. PR-2 = the `GET /api/quality/history` read API + an as-of backfill CLI (replacing the synthetic sine-wave trend-history, #180) + the `/programs` trend rewired to read snapshots. PR-3 = the UI (scope selector + as-of month picker; a "compliance on date D" KPI). Real-data (vs synthetic) materialization rides on the same path once a real `PatientDataProvider` lands (E12 PR-2).

## ADR-020: Population scale via generated outcomes + encoded `subject_id` + SQL aggregation (provider-leaf) — E13 PR-2 (#185)

Date: 2026-06-26
Status: Accepted

**Decision.** E13 PR-2 proves the multi-tenant rollup scales to a ~120k-subject tenant (`mhn` /
"MetroHealth Network") on the live stack. Because live-evaluating 120k×14 ≈ **1.68M CQL evaluations per
run** is infeasible (and storing/serving millions of rows in app memory worse), the scale tenant's
compliance is **generated, not live-evaluated**, seeded **once on-demand** (`pnpm seed:scale`, modeled
on `seed:trend-history` — NOT on deploy), and **aggregated in SQL**:
- The 120k subjects are **not** in the in-memory directory. They exist only as `outcomes` rows whose
  `subject_id` **encodes the hierarchy** — `mhn|Lxx|Pxx|nnnnnnn` (`scale-structure.ts` is the codec +
  the small ~240-provider structure that names the rollup nodes).
- A new `OutcomeStore.aggregateScaleRun(runId)` does a single `GROUP BY` (Postgres `split_part`, SQLite
  `substr` over the fixed-width id) → O(locations×providers×statuses) rows (~1.2k), **never** the
  per-subject rows. This is the one path that must scale.
- The hierarchy rollup + programs overview **exclude `seed:scale` runs from the existing in-memory
  scan** (`runTriggeredBy !== 'seed:scale'`) so the live 150-employee tenants keep their exact
  directory-resolved path and the 120k rows are never materialized in app memory; the scale tenant is
  built/folded in from `aggregateScaleRun`. `?tenant=mhn` returns the scale subtree only.

**Provider-leaf.** The scale subtree stops at **provider** (no patient level) — enumerating 120k
patient nodes would defeat the purpose. Reconciliation (parent = Σ children) holds for the levels that
exist: All = Σ tenants; `mhn` = Σ locations = Σ providers. The roster (`/compliance`) is **excluded**
(no paging through 120k individuals).

**Consequences.** **No DDL** (encoded `subject_id` + `GROUP BY` over existing columns), **no new deps**.
The default demo stays 150 live employees until the owner runs `seed:scale`; **reversible** by deleting
the `seed:scale` runs+outcomes (documented SQL). Every scale-seed write is audited
(`SCALE_POPULATION_SEEDED`). CQL `Outcome Status` stays the sole compliance authority for the
live-evaluated subjects (ADR-008) — the scale tenant is generated demo data and never sets a live
subject's status. **Deferred:** the scale tenant in the roster / per-patient drill-down /
trend·top-drivers; live CQL evaluation of the scale tenant; PR-3 scheduled cron recompute.

**Update (2026-07-08, `feat/scale-batch-eval`) — the fabricated-outcome path is superseded by real
batch evaluation.** The formerly-deferred "live CQL evaluation of the scale tenant" is now the
default: `batchEvaluateScalePopulation` (`backend-ts/src/run/batch-evaluate-scale.ts`) produces the
`mhn` outcomes by **real CQL evaluation** — subject-major (each subject's bundle generated once via a
`ScaleSubjectGenerator`, default `webChartRealisticGenerator` emitting real LOINC/CVX/CPT codes routed
through the WebChart terminology crosswalk, evaluated against all runnable measures, fanned out to the
per-measure runs), bounded-memory, whole-batch resumable, per-subject error-isolated (failure ⇒
MISSING_DATA), audited `SCALE_POPULATION_EVALUATED`. **What ADR-020 keeps unchanged:** the
`mhn|Lxx|Pxx|n` `subject_id` encoding, `aggregateScaleRun`'s content-agnostic SQL `GROUP BY`, the
provider-leaf rollup, and the reversibility (same `triggered_by='seed:scale'` rollback SQL) — so only
the outcomes' provenance changed (fabricated distribution → real evaluation). `pnpm seed:scale`
defaults to `--mode evaluate`; `--mode fabricated` keeps the legacy instant path one more release;
`--trim-evidence` stores minimal `{scale:true}` evidence for a large run. No schema, no new deps;
descriptive (ADR-008 preserved). Spec/plan:
`docs/superpowers/specs/2026-07-08-option-a-scale-batch-eval-design.md`,
`docs/superpowers/plans/2026-07-08-option-a-scale-batch-eval.md`.

## ADR-019: Multi-tenant rollup modeled in the read-time synthetic directory; cross-system aggregate root — E13 PR-1 (#185)

Date: 2026-06-26
Status: Accepted

**Decision.** E13 PR-1 adds a **tenant/system dimension** above the existing
enterprise→location→provider→patient hierarchy (#74 E4) so compliance from **multiple WebChart systems**
rolls up into one dashboard. The dimension is modeled **entirely in the read-time synthetic directory**
(`backend-ts/src/engine/synthetic/employee-catalog.ts`): a `Tenant`/`Enterprise` model + `tenantId` on
`EmployeeProfile`/`Provider`, exactly like `site`/`providerId` today. A second synthetic system —
**Indus Hospital Network** (`ihn`, 50 employees across 3 campuses) — joins the existing 100-employee
**Total Worker Health** (`twh`) tenant; `EMPLOYEES` spans both, so the run pipeline evaluates everyone and
both systems carry real outcomes. **No schema, no new dependencies** — `outcomes`/`cases` still persist only
`subjectId`; the hierarchy above a subject is resolved in code (the #93 schema stop-and-ask gate is satisfied
with no migration, consistent with ADR-010).

**Cross-system aggregate root.** The rollup (`hierarchy-rollup.ts`) returns a single reconciling
**"All Systems"** root (`level:"all"`) whose children are **tenant** nodes, each →
enterprise → location → provider → patient. The E4 reconciliation invariant (parent totals = Σ children at
every level) extends to the two new top edges (All = Σ tenants; tenant = its enterprise). Internal
accumulation maps are **tenant-qualified** (`${tenantId}|…`) so same-named locations/providers never merge
across systems. `?tenant=<id>` returns that single tenant's subtree as the root (an empty zero-node when the
tenant has no data).

**Multi-tenant everywhere via an optional filter.** Every read surface (`/api/hierarchy/rollup`,
`/api/compliance/roster`, `/api/programs/*`) gains an **optional `?tenant=<id>`** filter (default = all
systems), plus a new read-only `GET /api/tenants` for the UI selector (authenticated under the catch-all
`GET /api/**`). Omitting `tenant` preserves prior behavior aggregated across all systems, so existing callers
keep working; the live demo numbers grow because the second tenant is now evaluated (accepted trade-off).

**Consequences.** Tenant resolution is **display/grouping only** — it never sets or overrides an outcome; CQL
`Outcome Status` remains the sole compliance authority (ADR-008). Reversible by reverting the PR (Tenant 2 is
purely additive synthetic data). **Deferred to later E13 PRs:** population-scale batch (~120k) + a seed/scale
harness (PR-2), and scheduled cron recompute wiring the inert `/api/admin/scheduler` stub (PR-3); the real
WebChart/MariaDB→FHIR adapter is E12 PR-2 (blocked on MIE's schema).

## ADR-018: Standards fidelity is structural/definitional-first; official-CQL execution deferred — E14 (#186)

**Superseded — full text in [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md#adr-018).** 'Official-CQL execution deferred' — overtaken entirely; CMS's published artifacts run in production.

## ADR-017: E12 data ingress is FHIR-native-first; adapters feed the unchanged engine (no CQL→SQL transpile) — E12 (#184)

Date: 2026-06-26
Status: Accepted

**Decision.** E12 (pluggable data adapters) resolves the E9 (#78) architectural fork — how real
WebChart/EHR data reaches the measure engine — in favor of **FHIR-native-first**. A new patient-data
**ingress seam** sits *above* the unchanged `CqlExecutionEngine`: data sources adapt their native
representation into FHIR bundles, which the existing JVM-free CQL→ELM engine evaluates. We do **not**
transpile CQL→SQL to run measures inside WebChart's MariaDB.

**The fork (E9 / #78).** Three options were on the table (ADR-014's recommendation memo): (A) a
FHIR-native adapter feeding the existing engine; (B) a wholesale CQL→MariaDB transpiler; (C) hybrid.
We choose **FHIR-native-first (A, opening the door to C later)** because the engine is already built,
golden-parity-proven across all runnable measures (ADR-008), and JVM-free — so the adapter is the only
new surface. A CQL→SQL transpiler is research-grade/high-risk (the only concrete transpiler is
Databricks-only/partial, targets Spark not transactional MariaDB) and would fork the execution path. The
adapter seam is fully reversible — it adds a layer, it does not touch the engine. A bounded SQL-on-FHIR
opt-in second executor stays available as future work (ADR-014 Option C) but is not built here.

**PR-1 deliverable.** A new `backend-ts/src/engine/ingress/` module: a `PatientDataSource` port + a
DB-less, fs-less JSON-bucket library entry — `evaluateBundle(bundle, measureId)` (single) and
`evaluateBatch(bundles, measureId)` (a "bucket", with per-item error isolation). `resolveDataSource(env)`
selects the source config-driven (mirrors `resolveForecaster`/`resolveChannel`/`resolveStandingOrderProvider`:
JSON by default). The headless CLI is refactored to reuse `evaluateBundle` (one evaluation path). The
library path imports no DB and no `node:fs`, so it stays portable across every `@mieweb/cloud` target.

**WebChart adapter is an inert stub now.** `webChartDataSource` is **inert-unless-configured** —
selected only when both `WORKWELL_WEBCHART_BASE_URL` + `WORKWELL_WEBCHART_API_KEY` are set, and it
rejects with a clear "not yet wired (E12 PR-2)" message. The real WebChart/MariaDB→FHIR mapping is **PR-2**.

**Consequences.** CQL `Outcome Status` remains the sole compliance authority (ADR-008) — the ingress
seam only feeds bundles in, it never decides compliance. **No schema, no new dependencies.** The engine
is unmodified. PR-2 adds the real WebChart adapter behind the same port; deeper data depth and the
optional SQL-on-FHIR executor are later epics.

## ADR-016: Segments / risk-groups are an applicability layer, not a compliance authority — E11.3 (#183)

Date: 2026-06-25
Status: Accepted

**Decision.** A *segment* (risk-group) maps a cohort to an applicable rule-set. The cohort is a `role`/`site`
predicate rule (`{match: ANY|ALL, conditions:[{attr, op, value}]}`) plus per-employee INCLUDE/EXCLUDE
overrides (hybrid membership; EXCLUDE wins over INCLUDE). The rule-set is a list of measure ids. A subject's
**applicable measures** = the union of the rule-sets of every **enabled** segment the subject belongs to.

Segment applicability gates two things only: **case creation** (the run→case upsert is skipped for an
out-of-cohort `(subject, measure)`) and **display** (the roster + per-employee card show `NOT_APPLICABLE`).
It **never** changes CQL evaluation or `Outcome Status` — the outcome is always computed and persisted with
full evidence even when no case is created (ADR-008 holds; CQL is the sole compliance authority). The single
applicability definition lives in `backend-ts/src/segment/segment-applicability.ts` and is consumed by both
the roster read model and the run pipeline.

**Reversibility invariant.** With **zero enabled segments, every measure is applicable to everyone** — i.e.
the exact pre-E11.3 behavior. Disabling or deleting all segments fully reverts the feature, so it is a safe
additive overlay. A *disabled* segment is also not selectable as a roster column/row scope (it is not in
effect).

**Persistence.** Three owner-gated tables on both the SQLite floor and the Postgres ceiling
(`segments`, `segment_measures`, `segment_overrides`; see DATA_MODEL §3.22) behind a `SegmentStore` port —
the first E11 feature to add schema (the rule-builder halves were schema-free). CRUD is exposed at
`/api/segments` (writes ADMIN-only + audited `SEGMENT_*`; reads authenticated). The Configure Groups editor
UI is E11.3 PR-2.

**Scope.** Predicates are `role`/`site` only for now; richer (FHIR-data, program-enrollment) predicates and
WebChart-group import are deferred to later epics (E12+).

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
synthetic scenarios (`codegen-parity.test.ts`, 6 measures × 4 scenarios). **No cutover** — the hand-written
`.cql` remains the build source; `measures/generated/<id>.cql` is the parity artifact. Legacy non-code-scoped
measures (hazwoper, tb_surveillance) are excluded pending a code-scope migration. The Rule Builder UI (E11.2)
emits the `rule:` params; segments/risk-groups (E11.3) are separate.

**Consequences.** Non-CQL authors can change a rule's thresholds via params (E11.2 builds the form); CQL
remains the standards layer; no schema/DDL (rule-params are build-time YAML); no new runtime deps.

**E11.2a (codegen extensions).** Added three additive, back-compatible rule capabilities to the codegen:
**grace** (windowed — `overdueThreshold = windowDays + gracePeriodDays`, extends the Due-Soon band before
OVERDUE), **titer** (series — `allowPositiveTiter` + a titer Observation binding ORs `Has Positive Titer`
into `Series Complete`, a real immunity path), and **declination** (a `Refused` define wherever a refusal
binding is present — read by the roster's DECLINED display, never changes `Outcome Status`). All fields are
optional; absent ⇒ E11.1 output byte-for-byte, so the parity proof is unaffected. Proven by behavioral
goldens (`generate-cql-extensions.test.ts`). The Hep B multi-alternative-series with min-interval validation
+ multi-CVX is deferred. The E11.2b Rule Builder UI emits these params.

**E11.2c (multi-alternative series).** The `series-completion` codegen now supports **multi-alternative
series** — an OR of alternative dose series (real Hep B = Heplisav-B 2-dose CVX 189 OR traditional 3-dose
CVX 08/43/44/45) — each alternative carrying a **multi-CVX code set** and optional **per-alternative
minimum dose intervals** (an ordered multi-source `exists` with inclusive `>=` day gaps between doses).
Additive and back-compatible: absent `alternatives` ⇒ byte-identical to E11.1, so the `codegen-parity.test.ts`
proof is unchanged. CQL stays canonical (ADR-015) — this is the codegen capability only; no live measure is
repointed in PR-1 (PR #203).

**E11.2c PR-2 (live Hep B repoint).** The live `hepatitis_b_vaccination_series` measure is now repointed
onto this capability (Heplisav-B 2-dose CVX 189 ≥28d OR traditional 3-dose CVX 08/43/44/45, ACIP intervals
28/56d). This is **additive seed/app data — no DB schema/DDL** (value-set CVX 44/45 + YAML rule +
alternative-aware synthetic dose model); the hand-written + generated Hep B CQL/ELM were regenerated. Hep B's
demo compliance semantics shift to Heplisav-vs-traditional by design (called out in JOURNAL + MEASURES);
reversible by reverting the PR. CQL `Outcome Status` stays the sole compliance authority (ADR-008).

## ADR-014: CQL→SQL bridge (charter Q2) — recommendation recorded, decision DEFERRED to Doug

**Superseded — full text in [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md#adr-014).** Deferred to Doug and never returned as a decision; ADR-025 settled it by building the seam with the SQL path inert.

## ADR-013: E7 order-proposal engine — `ProposedOrder`/`StandingOrderProvider` port (EH-ready, simulated by default)

- **Date:** 2026-06-19
- **Status:** Accepted
- **Epic:** #77 (E7 order generation)
- **Context:** The TWH charter's "Action Evaluators → orders" layer calls for generating proposed
  orders from non-compliant measure findings — audiogram overdue → propose audiogram; TB screening
  overdue → propose TB screen. Three design questions had to be resolved up front.

  **1. Advisory vs. auto-submit.** Orders in clinical systems (EHR, EH) are actionable: submitting
  one can schedule an appointment, trigger a workflow, or notify a provider. Auto-submitting from a
  compliance system without a human review step violates the spirit of the AI_GUARDRAILS rule and the
  project's human-in-the-loop contract. Proposed orders must be advisory — generated for a human
  reviewer who decides to submit or discard.

  **2. Standing-order deduplication.** Duplicate orders are a patient-safety concern (and flagged in
  the charter). The engine must detect when a qualifying standing order already exists for a subject
  and suppress a new proposal for that subject rather than adding a redundant one.

  **3. EH integration.** The real standing-order query and the real order-submission write are EH
  FHIR API calls. Those require credentials and a live EH instance (Doug Q6), and are inert stubs
  today. The `OutreachChannel`/`ImmunizationForecast` port pattern applies: simulated by default,
  inert-unless-configured.

- **Decision:**
  - **`ProposedOrder` domain type** (`backend-ts/src/order/proposed-order.ts`): `{subjectId,
    measureId, order, reasonOutcome, priority, status, dedupeKey, authoredOn,
    suppressedByStandingOrder?}` (`order` is `{code, system, display}`). `toServiceRequest()`
    emits a FHIR R4 `ServiceRequest` (`intent:"proposal"`, `status:"draft"`) hand-built as JSON (no
    FHIR runtime dependency — same pattern as `MeasureReport`/QRDA). `bundleOf()` wraps a set into a
    collection `Bundle`.
  - **`order-catalog.ts` — action-evaluator map:** runnable measure → `OrderCode` (system + code +
    display). Reuses the `terminology_mappings` seed standard codes where present (audiogram → CPT
    92557; tb_surveillance → CPT 86580; flu_vaccine → CVX 141; hazwoper → `hazwoper-exam` in
    `urn:workwell:vs:hazwoper-exams`). LOCAL codes (`urn:workwell:orders`) for measures without a
    seed mapping (e.g., BMI screening). No new DB dependency.
  - **Panel=Risk selection:** `proposeOrders(outcomes, provider)` in `order-proposal.ts` classifies
    the Denominator − Numerator subset: OVERDUE/DUE_SOON/MISSING_DATA outcomes propose; COMPLIANT and
    EXCLUDED do not. Risk maps to `priority`: OVERDUE → `urgent`; DUE_SOON or MISSING_DATA →
    `routine`. The engine is pure and trigger-agnostic — read-time today, callable from the run
    pipeline later without changes.
  - **Dedupe contract:** in-batch per-subject deduplication (one proposal per subject per measure);
    standing-order suppression (subjects with a qualifying standing order are excluded from
    `proposed`, returned separately in `suppressed`). Prevents the "duplicate orders" safety concern
    from the charter.
  - **`StandingOrderProvider` port** (`backend-ts/src/order/standing-order-provider.ts`):
    `simulatedStandingOrderProvider` (default — deterministic ~1/5 of subjects have a standing order,
    no HTTP) + inert `ehStandingOrderProvider` stub (selected only when both
    `WORKWELL_EH_FHIR_BASE_URL` + `WORKWELL_EH_FHIR_API_KEY` are set; performs no real HTTP; returns
    empty). `resolveStandingOrderProvider(env)` selects between them. **Inert-unless-configured**,
    mirroring ADR-011 (SendGrid/DataChaser) and ADR-012 (ICE).
  - **Proposals are advisory — never auto-submitted.** A human reviews and submits. This is the
    order-generation analog of "AI never decides compliance": the engine proposes, the operator acts.
    The real EH write path (`OrderSubmitter`) is **named but deferred** (documented drop-in) — when
    Doug Q6 is answered and EH credentials are available, it drops in without touching the proposal
    engine.
  - **`GET /api/orders/proposals?measureId=&subjectId=&from=&to=&format=domain|fhir`** — gated
    CASE_MANAGER/ADMIN (`authorize.ts` `rx("/api/orders/**") → [CM, A]`). Selects the latest
    population run per Active measure (reuses `rollup-shared.ts` `isPopulationRun` + `latestRunRows`).
    `format=domain` → `{proposed, suppressed}` JSON; `format=fhir` → FHIR R4 ServiceRequest
    `Bundle` (proposed only). Read-time; **no schema change**.
  - **No schema change.** Proposals are derived read-time from `outcomes`; nothing is persisted. The
    production drop-in is an `OrderSubmitter` EH FHIR write + a `submitted_orders` audit table
    (owner-gated, not built today). The emitted `ServiceRequest` carries no resource `id` today
    (the collection `Bundle` is non-transactional, advisory read output); the `OrderSubmitter` will
    assign a stable `id` (e.g. a UUID) per resource when it POSTs to EH so EH can dedupe on re-send.

- **Consequences:**
  - Adding the real EH standing-order query and the real `OrderSubmitter` write are port adapter swaps
    behind `resolveStandingOrderProvider` and a future `OrderSubmitter` port, env-gated; the demo
    stays simulated by default with zero config (CLAUDE.md hard rule preserved).
  - No schema migration today. No compliance-logic change — proposals never set or override
    `Outcome Status`. CQL `Outcome Status` remains the sole source of truth.
  - Proposals are advisory: human submits, system proposes. This invariant is documented in
    `docs/ARCHITECTURE.md` §6 and enforced by the endpoint returning read-only data with no write
    side-effects.
  - Ships on `feat/issue-77-order-generation`; deploys on merge to `main`.

## ADR-012: E6 immunization & forecasting — `ImmunizationForecast` port (ICE-ready, simulated by default) + AIS-E Td/Tdap measure

- **Date:** 2026-06-19
- **Status:** Accepted
- **Epic:** #76 (E6 immunization & forecasting)
- **Context:** E6 adds immunization forecasting alongside a new runnable measure for adult immunization
  status. Three design questions had to be resolved up front.

  **1. Port shape and ICE integration.** Immunization forecasting in clinical quality uses the
  Immunization Calculation Engine (ICE), a CDC-supported CDS service. The demo stack must stay
  simulated by default (CLAUDE.md hard rule), and the exact ICE integration surface (CDS Hooks
  vs. the REST API vs. a WebChart-ICE bridge) is an open question deferred to Doug (#76 Q5). The
  `OutreachChannel` port pattern from ADR-011 applies directly: simulated adapter by default, inert
  stub when real env vars are set.

  **2. Measure vs. forecast split.** The synthetic data model is single-event per subject per
  measure — one enrollment/waiver/event Condition. A true multi-series composite immunization measure
  (Td/Tdap + Influenza + Hepatitis B) would require reworking the shared synthetic infra used by all
  10+ existing measures. Forcing a composite on the existing infra would be a wide blast radius with
  no correctness benefit.

  **3. Measure choice.** NCQA HEDIS AIS-E (Adult Immunization Status) is the natural fit for a TWH
  employer wellness platform. CMS117 (Pneumococcal Vaccination, pediatric) is a mismatch for an
  adult workforce. CMS127 (Pneumococcal Vaccination for adults 65+) was explicitly considered and
  rejected: it covers a narrow age cohort, measures ever-received not time-to-next, and forecasting
  is ill-suited to a near-permanent binary outcome. AIS-E Td/Tdap single-series (10-year window) is
  the correct real NCQA measure, implementable within the existing single-event model.

- **Decision:**
  - **`ImmunizationForecast` port** (`backend-ts/src/engine/immunization/immunization-forecast.ts`):
    `ImmunizationForecast` interface + `simulatedForecaster` default (ACIP-style "next dose due" over
    the port's OWN deterministic per-subject synthetic immunization history — `syntheticImmunizationHistory`,
    epoch-anchored — covering 3 series: Td/Tdap 10y, Influenza annual, Hepatitis B 3-dose series) +
    an inert `iceForecaster` stub (selected only when both `WORKWELL_IMMZ_ICE_API_KEY` +
    `WORKWELL_IMMZ_ICE_BASE_URL` are set; returns a "ICE not wired (Doug Q5)" reason; **no real HTTP**).
    `resolveForecaster(env)` selects between them. Mirroring ADR-011's SendGrid/DataChaser posture:
    **simulated by default, inert-unless-configured**.
  - **Forecasting is advisory only** — an analog to the AI_GUARDRAILS rule. `ImmunizationForecast`
    output is labelled advisory on every surface; `CQL Outcome Status` remains the sole compliance
    authority. The forecaster never sets or overrides a case status.
  - **`adult_immunization` measure** — AIS-E Td/Tdap single-series: CQL `backend-ts/measures/adult_immunization.cql`
    + YAML, seeded Active in the HEDIS wellness category. 10-year window (3650 days); Td/Tdap
    contraindication → EXCLUDED; refusal (documented `tdap-refusal` Condition) stays open (a `Refused`
    define flags it but does not exclude — refusals need case-manager intervention). Outcomes: COMPLIANT
    ≤3590 days, DUE_SOON 3591–3650, OVERDUE >3650, MISSING_DATA no record. Catalog total: **61 measures,
    11 runnable**.
  - **Measure vs. forecast split** is the correct model: the measure covers the NCQA single-series
    Td/Tdap obligation (answering "is this worker current?"); the forecaster covers all 3 series
    advisory-only (answering "when is the next dose due?"). A composite multi-series measure and
    age-gated indicators (zoster 50+, pneumococcal 65+) are documented follow-ups.
  - **Case-detail enrichment:** `GET /api/cases/:id` attaches an advisory `immunizationForecast` (the
    3-series forecast) for `adult_immunization` cases only; rendered as an advisory panel on `/cases/[id]`.
  - **Endpoint:** `GET /api/immunization/forecast?subjectId=&asOf=` → `ImmunizationForecast` JSON;
    `asOf` defaults to today, validated YYYY-MM-DD (400 on malformed); authenticated under `/api/**`.
    Read-time; **no schema change**.
  - **Doug Q5 deferred** behind `iceForecaster` stub. When Doug's answer arrives, the production ICE
    adapter drops in behind `resolveForecaster` with zero impact on the measure or case logic.

- **Consequences:**
  - Adding a real ICE adapter is a port adapter swap behind `resolveForecaster`, env-gated; the demo
    stays simulated by default with zero config (CLAUDE.md hard rule preserved). ICE is inert until
    configured — no live HTTP, no overclaim.
  - No schema migration today. The production drop-in is an `immunization_forecasts` cache table fed
    by a real ICE adapter (analogous to the §3.17 E5 `PgCampaignStore` drop-in). `adult_immunization`
    adds no new columns.
  - Forecasting is advisory; the `ImmunizationForecast` port never influences `Outcome Status`. This
    is the immunization analog of "AI never decides compliance."
  - Ships on `feat/issue-76-immunization-forecasting`; deploys on merge to `main`.

## ADR-011: E5 outreach at scale — multi-channel `OutreachChannel` port + staged (audit-backed → Pg) campaign persistence

- **Date:** 2026-06-19
- **Status:** Accepted
- **Epic:** #75 (E5 outreach at scale)
- **Context:** E5 generalizes per-case outreach into (a) multiple delivery channels and (b) bulk
  campaigns over many cases. Two design questions follow: how to add SMS/PHONE and a real outreach
  vendor (DataChaser) without violating the CLAUDE.md "simulated by default on the demo stack" hard
  rule, and how to persist a campaign given that schema is owner-gated (both the SQLite floor
  `schema.ts` **and** the Pg ceiling `schema-pg.ts`) and the actual sends are still simulated. Contrast
  with E4 (ADR-010), where the hierarchy was a **derived** read-time view — so adding no schema was
  the *correct* model there. A campaign is different: it is **created state** (an operator launches it
  with specific filters/channel and gets back a result), not derivable from existing rows.
- **Decision:**
  - **Multi-channel `OutreachChannel` port** (`backend-ts/src/case/outreach-channel.ts`):
    `ChannelType` EMAIL/SMS/PHONE, each with a **simulated** adapter (EMAIL delegates to the existing
    simulated email service; SMS/PHONE body-only), plus an inert **DataChaser stub** (`dataChaserChannel`
    — returns QUEUED with a self-describing stub note, **no real HTTP**). `resolveChannel(type, env)`
    returns the simulated adapter **by default** and the DataChaser stub **only** when both
    `WORKWELL_OUTREACH_DATACHASER_API_KEY` + `WORKWELL_OUTREACH_DATACHASER_BASE_URL` are set
    (inert-unless-configured, mirroring the SendGrid posture). `dispatchOutreach` (`case-outreach.ts`)
    is the shared send core for both single-case send and campaigns; the per-case action and
    `POST /api/cases/:id/actions/outreach?channel=` honor a channel (default EMAIL; PHONE → `tel:`,
    SMS → `sms:`, EMAIL → `@workwell-demo.dev` synthetic addresses).
  - **Staged campaign persistence behind a `CampaignStore` port — audit-backed NOW, Pg tables LATER.**
    A campaign persists as a single `OUTREACH_CAMPAIGN_COMPLETED` audit event (payload =
    `{campaign, recipients}`); the demo adapter (`audit-campaign-store.ts`) reads by scanning
    `listAuditEvents` and filtering by event type (O(ledger-size), demo-scale). **No new DDL** on either
    floor or ceiling. The documented production drop-in is a `PgCampaignStore` over `outreach_campaigns`
    + `outreach_delivery_log` (+ an owner migration). **Why staged rather than just writing the tables:**
    because the campaign *is* created state it cannot be derived (so ADR-010's no-schema rationale does
    not transfer), **but** the sends are simulated, DataChaser is a stub, and the schema is owner-gated
    on both stores — so writing real tables now would add DDL the simulated layer can't actually
    exercise. A port stages the decision: the demo runs audit-backed today; the Pg store drops in when
    real sends + owner-approved schema land together.
  - **`POST /api/campaigns` gated to CASE_MANAGER/ADMIN** (`authorize.ts` rule
    `rx("/api/campaigns/**") → [CM, A]`), matching per-case outreach — this also closed an authz gap
    found in review (campaigns must not be more permissive than the single-case action they batch).
- **Consequences:**
  - Adding a real channel/vendor is a port adapter swap behind `resolveChannel`, env-gated; the demo
    stays simulated by default with zero config (CLAUDE.md hard rule preserved). DataChaser is an inert
    stub until configured — no live HTTP, no overclaim.
  - Campaign reads are O(ledger-size) on the audit adapter — acceptable at demo scale, and the reason
    the Pg drop-in exists for production.
  - No schema migration today; no AI/compliance-logic change — campaigns send outreach, they never
    decide compliance. CQL `Outcome Status` remains the sole source of truth.
  - Ships on `feat/issue-75-outreach-at-scale`; deploys on merge to `main` (not yet live).

## ADR-010: E4 multi-level hierarchy — provider = attributed clinician, modeled in the synthetic directory (no DB schema)

- **Date:** 2026-06-18
- **Status:** Accepted
- **Epic:** #74 (E4 multi-level dashboards); sub-issues #93 (E4.1 hierarchy model) + #94 (E4.2 rollups + UI)
- **Context:** E4 needs a multi-level compliance view above the per-measure programs overview —
  enterprise → location → provider → patient. The roadmap flagged E4.1 (#93, "org/provider hierarchy
  data model") as a likely **schema change = stop-and-ask**. The key finding on inspection: `backend-ts`
  has **no `employees` DB table** — the workforce is the synthetic directory
  (`engine/synthetic/employee-catalog.ts`), and `outcomes`/`cases` persist only `subjectId`. So the
  hierarchy can be added entirely as read-time structure over the existing synthetic data with **no
  migration**, which satisfies the #93 stop-and-ask gate without writing any SQL.
- **Decision:**
  - **Provider = the attributed occupational-health clinician** (eCQM/MIPS-authentic: quality measures
    roll up by attributed provider), strictly **nested under location** (`site`). Each `EmployeeProfile`
    gains a `providerId`; new exports `ENTERPRISE` (root), `PROVIDERS` (8 synthetic clinicians, 2 per
    location across Plant A / Plant B / HQ / Clinic), `providerById`, `providersForLocation`. The
    enterprise→location→provider→patient levels live **only in the synthetic directory** — **no DB
    schema change, no `employees` table, no migration**.
  - The rollup is a **read-time read model** (`backend-ts/src/program/hierarchy-rollup.ts`,
    `buildHierarchyRollup`) over the same outcome rows the programs overview uses (latest population run
    per Active measure; CASE/EMPLOYEE reruns excluded). Exposed via `GET /api/hierarchy/rollup`. Shared
    helpers extracted to `rollup-shared.ts`; the date-param parser to `routes/query-dates.ts`.
  - **UI:** a semantic nested expandable drill-down table at `/programs/hierarchy` (NITRO grid deferred
    until `@mieweb/datavis` is published — ADR-007).
- **Consequences:**
  - **Reconciliation invariant is the testable backbone:** because providers are strictly nested under
    locations (and locations under the enterprise), parent count totals = Σ children at **every** level.
    This is the property the rollup tests assert.
  - A future real `EmployeeDirectory`/org-hierarchy adapter (ADR-005 ports) can supply the same
    enterprise→location→provider→patient shape behind the read model without touching the rollup or the
    API. If a relational org-hierarchy table is ever introduced, that **would** be a schema change and a
    fresh stop-and-ask.
  - No AI/compliance-logic change; CQL `Outcome Status` remains the sole source of truth.

## ADR-009: Emit eCQM artifacts JVM-free; QRDA III as a structurally-representative stub

**Superseded — full text in [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md#adr-009).** JVM-free artifact emission holds (restated by ADR-008); the 'QRDA III is a stub' half is long overtaken — it validates clean against the HL7 base ruler.

## ADR-008: De-Java the backend — re-platform onto TypeScript / `@mieweb/cloud` (strangler-fig)

- **Date:** 2026-06-12
- **Status:** Accepted — **DONE (2026-06-17).** `twh.os.mieweb.org` is served by the TS backend (`twh-api-ts`) on Neon (Pg ceiling, `workwell_spike` schema). The blue-green flip went live (#109 PR #159), and **#109 PR4 retired the JVM**: `backend/` deleted, Java build/deploy jobs + the shadow workflow removed, `backend-ts` is the CI-gated sole backend, and a self-heal reconciler covers reboot/crash recovery. The zero-Java end state is reached.
- **Stakeholder:** Doug Horner (`horner`) — issue [#96](https://github.com/Taleef7/workwell/issues/96)
- **Plan:** `docs/superpowers/plans/2026-06-12-issue-96-dejava-replatform.md`
- **Context:** Doug's #96 changes the repo direction: the backend must **not require Java/Spring Boot,
  a JVM, Spring DI, Spring Data, or Spring MVC** to run, test, or deploy. `@mieweb/cloud` (a v0.0.0
  Cloudflare-shaped portability layer) becomes the pluggable backend; application code calls explicit
  repository contracts (e.g. `runStore.createRun(input)`, `runStore.claimNextQueuedRun(workerId)`) and
  each runtime adapter (Cloudflare native / local Node / SQLite / D1 / Postgres / S3-MinIO / Valkey)
  implements them. Principle: **"SQLite/D1 define the portable floor; Postgres provides the
  performance ceiling."** A lightweight query builder (Drizzle or Kysely) handles schema/migrations/
  CRUD, **not** the portability layer. This supersedes the ADR-001 "single Spring Boot deployable"
  decision for the backend runtime (ADR-001 remains the historical record of why the monolith was
  right for the MVP timeline). The frontend (ADR-004/007) is unaffected.
- **Decision:**
  - **Strangler-fig re-platform**, not a big-bang rewrite. Port the backend to TypeScript
    module-by-module **behind the unchanged frontend API contract** (`frontend/lib/api/client.ts` URL
    + request/response shapes are the seam); nothing is deleted until its TS replacement passes parity.
  - **CQL engine = Path C (confirmed by Taleef 2026-06-12).** Keep CQL and eCQM standards-compliance;
    run the Java `cql-to-elm` translator **offline at authoring/build time only** (committing ELM JSON +
    FHIRHelpers + ModelInfo + expanded value sets) and **execute ELM in Node** via
    `cql-execution`/`fqm-execution`. Java thus leaves the **runtime/deploy-required** path entirely,
    surviving only as a build tool. Rejected: Path B (FHIRPath, zero Java but abandons CQL/MAT — gives up
    the differentiator). Fallback if Path C fails parity: keep the Java engine as an isolated evaluation
    microservice (Java stays required to deploy — last resort).
  - **Live CQL authoring is preserved (no functionality compromise).** The Studio CQL compile gate
    stays; CQL→ELM translation runs in Node (see the 2026-06-12 update) — never requiring a JVM.

- **Update 2026-06-12 — Phase-1 spike GO + zero-Java end state (Taleef, per Doug's #96):**
  The Phase-1 vertical-slice spike (#103) cleared the gate on evidence:
  - The TS worker runs on the `@mieweb/cloud` local Node host; `RunStore` works over `CloudDatabase`
    (SQLite floor) with an atomic queue-claim; live `POST /api/runs` · `GET /api/runs/:id` · `claim`.
  - **CQL Path C golden parity across all 10 runnable measures × 4 scenarios — 40/40 exact** (452
    define comparisons) vs the Java engine, incl. the eCQMs (CMS122 value-based, CMS125 820-day),
    season-based flu (`Measurement Period`), and count-based hazwoper/tb. The feared ValueSet-expansion
    risk is **absent** — all 10 measures use inline code filters (no `in "ValueSet"`), so no terminology
    service is needed.
  - **Zero Java is achievable with no functional compromise, so we take it (Doug's stated end state).**
    `@cqframework/cql` (v4.0.0-beta.1, Apache-2.0) — the cqframework reference translator compiled to
    **pure Node via Kotlin Multiplatform, no JVM** — translates all 10 measures' CQL→ELM (errors=0), and
    that Node-translated ELM evaluates **40/40 exact** against the Java golden. So CQL→ELM, the last Java
    touchpoint, **also runs in Node**: Java/Spring Boot leaves the project **entirely** — runtime, build,
    and authoring. The earlier "JVM evaluator sidecar / build-time Java" fallbacks are demoted to
    contingency only (used solely if `@cqframework/cql` regresses before cutover).
  - **Guardrails:** the `@cqframework/cql` beta version is **pinned**; the full-catalog golden-parity
    harness (`backend-ts/spike/compare-all.mjs`) is the **regression gate** on every bump/measure change;
    the Java `ElmCompilerCli` is retained transitionally as a cross-check, removed with the rest of Java
    when the TS engine binding lands (#106). Three standard version-stable resources (System + FHIR-R4
    model-info XML, FHIRHelpers CQL) are committed config, not a Java dependency.
  - Evidence + reproduce: `backend-ts/spike/README.md` (PR #112).
  - **Reusable-module mandate (Vision Doc, Doug 2026-06-08):** each layer ships as a reusable MIE
    package (frontend on `@mieweb/ui`, backend on `@mieweb/cloud`), and the headless
    `evaluate(patient, measure.yaml)` evaluator (ADR-006) survives as a first-class reusable TS artifact.
  - **Engine as an explicit swappable compute binding (not the app framework).** The worker calls an
    `EvaluateMeasure` binding like an AI/vector provider; the portability layer is JVM-free regardless.
    Path C (Node-ELM execution) is the **preferred** binding implementation; a **JVM evaluator sidecar**
    is the fallback implementation (decided by the Phase-1 parity spike). A target with no CQL binding
    **raises `UnsupportedBindingError`, never guesses a status** — same invariant as "AI never decides
    compliance." Full storage decomposition into `RunStore`/`CaseStore`/`OutcomeStore`/`MeasureStore`/
    `AuditStore` contracts, the answers to Doug's 9 questions, and the repo-grounded Spring footprint are
    detailed in the companion memo `docs/MIEWEB_CLOUD_REFACTOR_MEMO.md`. The eventual zero-JVM endgame
    (no sidecar) ties to roadmap epic **E9/#78 (CQL→SQL / transpile)**, tracked separately.
  - **Not a FHIR server.** Postgres stays the system of record; FHIR R4 bundles remain transient,
    synthesized in-memory only to feed the engine. We adopt TS FHIR *typing* (`@types/fhir`), not a TS
    FHIR server. `node-on-fhir/honeycomb` (Meteor + MongoDB + AGPL-3.0, no CQL) is **not adopted**;
    Medplum (monolithic platform) is overkill.
  - **Deploy target:** Node container on MIE Create-a-Container (not Cloudflare Workers yet) — same
    `deploy-twh-mieweb.yml` v1 Container Manager flow with the JVM image swapped for a Node image.
  - **`@mieweb/cloud` added as a git submodule** and co-developed: `@mieweb/cloud-postgres` does not
    exist yet and is built as part of Phase 2.
  - **Parity is the gate.** A Phase-1 vertical-slice spike must show one measure's TS output equals the
    Java engine's `Outcome Status` + key `expressionResults` for the shared employee fixtures before the
    expensive phases proceed (GO/NO-GO).
- **Consequences:**
  - Tracked as epic sub-issues under #96 (Phases 0–5) on the "WorkWell #96 — De-Java Re-platform" board.
  - The `evidence_json` contract (ADR-002), the `audit_event`-on-every-state-change invariant, case
    idempotency, and "AI never decides compliance" all carry forward unchanged into the TS backend.
  - **JSONB-floor tension:** the schema's Postgres JSON ops must either be reworked to the SQLite/D1
    floor or surfaced as honest `UnsupportedBindingError` on constrained adapters — resolved per-target.
  - Schema migrations remain **Taleef-owned**; no agent writes `V0xx`/new migrations without explicit
    instruction. The 21 existing migrations define the data model the Drizzle/Kysely schema mirrors.
  - End state: Java/Spring/Gradle removed from the backend; `CLAUDE.md`/`README.md` stack lines change
    from "Java 21 + Spring Boot" to the TS/`@mieweb/cloud` stack when Phase 5 lands (a future ADR amends
    the "immutable stack" line at that point).

## ADR-007: Vendor `@mieweb/datavis` (NITRO grid) source to unblock the data grid

- **Date:** 2026-06-11
- **Status:** Accepted
- **Stakeholder:** Doug (direction 2026-06-08: "use nitro for all tables"); supersedes the "deferred" stance in ADR-004.
- **Context:** ADR-004 deferred the DataVis NITRO grid as "not npm-consumable." On closer inspection that was incomplete: the published `@mieweb/ui@0.6.1` **does** ship the NITRO bundle (`dist/datavis.js` + the `./datavis` export), but that bundle imports from a **bare `datavis` specifier** (raw `datavis/src/...` `.ts`/`.tsx`) plus `datavis-ace`. `datavis-ace@=4.0.0-PRE.2` **is** on public npm; the `datavis` UI source is **not** published, but the `github.com/mieweb/datavis` repo is **public**, and `@mieweb/ui`'s own build marks `/^datavis\//` external — expecting the consumer to provide `datavis`, exactly as the upstream monorepo does via a `file:` link. So NITRO is consumable today by mirroring that.
- **Decision:**
  - **Vendor the `datavis` source** into `frontend/vendor/datavis` (pinned to upstream commit `52c27cc`, matching `@mieweb/ui@0.6.1`) and alias it `"datavis": "file:./vendor/datavis"`. Runtime deps added: `datavis-ace@=4.0.0-PRE.2`, `@dnd-kit/*`, `i18next`, `react-i18next`. Provenance + upgrade recipe in `frontend/vendor/datavis/VENDORING.md`.
  - **Wiring:** `transpilePackages: ["datavis", "@mieweb/ui"]` (Next must transpile both so the extensionless deep imports resolve); Tailwind `@source "../vendor/datavis/src"` + the `.wcdv-*` custom classes. Both Dockerfiles `COPY vendor` before `pnpm install`.
  - **Integration seam:** `features/datavis/NitroGrid*.tsx` — client-only (`next/dynamic`, `ssr:false`, because the engine touches `window` at module load), local in-memory data via the upstream `createMockView` pattern (no `http` fetch; the authed API client still owns data loading). Pages import the wrapper, never `@mieweb/ui/datavis` directly. Rich cells preserved via NITRO's `formatCell` (returns `ReactNode`).
  - **Applied to the strong-fit operational/audit tables:** `/measures`, `/runs` (Outcomes), `/admin` ×3 (data mappings, terminology mappings, delivery log). Small in-card tables (`/programs/[measureId]`, studio panels, `/employees/[externalId]`) intentionally stay semantic — NITRO chrome too heavy.
- **Consequences:**
  - Vendored MIE-internal source now lives in the tree (public, used under its license). Brittle on `@mieweb/ui` upgrades — the deep import paths are the contract to re-verify; VENDORING.md documents the re-vendor step. The clean long-term fix (MIE publishes a built `@mieweb/datavis` to npm so `vendor/` can be deleted) remains tracked in `questions_for_doug.md`.
  - Vendored source is excluded from our eslint (`vendor/**`).
  - Landed on `feat/datavis-nitro-unblock`. The remaining `@mieweb/ui` form-control component-swap is split out as issue #99.
  - No backend/schema/API/compliance change.

## ADR-006: Declarative YAML measure definitions + headless evaluator CLI

- **Date:** 2026-06-10
- **Status:** Accepted
- **Epic:** #72 (sub-issues #85–#88); spec `docs/superpowers/specs/2026-06-10-e2-yaml-measures-design.md`
- **Context:** After E1 (ADR-005), measure bindings still lived in a hardcoded Java switch
  (`SyntheticMeasureDefinitionProvider`), and there was no way to evaluate an arbitrary patient
  outside the web app. Doug's most concrete ask is a "programming layer, no UI: given this patient
  and this YAML file, are they compliant?".
- **Decision:**
  - **YAML is the single source of measure bindings.** One `measures/<id>.yaml` per runnable measure
    (sibling to its `.cql`), schema v1: metadata (`id`, `name` = exact catalog name, `version`,
    `title`, `policyRef`, `tags`) + `cql:` file ref + `bindings:` (enrollment/waiver/event code +
    value set, `event.type: procedure|immunization|observation` replacing the two raw booleans,
    `complianceWindowDays` defaulting to 365). `YamlMeasureDefinitionProvider` loads
    `classpath*:measures/*.yaml` at construction (Spring-core resource resolver as plain library
    code — no ApplicationContext; the no-Spring guard still constructs it with `new`) and is the
    default bean. The hardcoded switch is **deleted**; no `yaml|java` fallback flag (dual sources
    were the #82 smell). Golden parity (100 employees × 10 measures) gates the swap.
  - **Population logic and bucket thresholds stay in the CQL** (`Outcome Status` define) — CQL is
    the single source of logic; YAML is the binding/metadata envelope. Aspirational eCQM packaging
    fields were deliberately not added (extension path documented in the spec for E3).
  - **Headless surface:** public `CqlEvaluationService.evaluateBundle(...)` evaluates an arbitrary
    FHIR `Bundle` and returns `BundleOutcome` (normalized bucket + define-level expression results);
    the synthetic path delegates to the same core. `HeadlessEvaluatorCli` (plain `main`, no Spring,
    no DB) + the Gradle `evaluateMeasure` task expose it:
    `./gradlew.bat evaluateMeasure --args="patient.json measures/audiogram.yaml"` (Java-era form; post-#109
    this is realized JVM-free in `backend-ts` as `pnpm evaluate --patient <bundle.json> --measure <id>`, #72/E2).
    A REST endpoint was deferred (trivial later atop `evaluateBundle`).
  - **No new dependencies:** SnakeYAML (Boot), HAPI JSON parser, Jackson — all already shipped.
- **Consequences:**
  - Authoring a new runnable measure = a `.cql` + a `.yaml` file; no Java changes for bindings.
  - Headless evidence is `expressionResults` + outcome only — the synthetic `why_flagged` block
    derives from `ExamConfig`, which doesn't exist for real bundles (intentional, documented).
  - E3 (#73) plugs MeasureReport/value-set expansion into the same seam; a future real
    `PatientDataProvider` feeds `evaluateBundle` directly.

## ADR-005: Measure engine ports/adapters (same module, synthetic default adapter)

- **Date:** 2026-06-10
- **Status:** Accepted
- **Epic:** #71 (sub-issues #79–#84); spec `docs/superpowers/specs/2026-06-10-e1-measure-engine-ports-design.md`
- **Context:** `CqlEvaluationService` hard-wired its inputs to the synthetic demo: `new SyntheticFhirBundleBuilder()`, the static `SyntheticEmployeeCatalog`, and the per-measure binding switch `measureSeedSpecFor()`. This blocked plugging in real EHR/FHIR data and a declarative measure format (E2) without editing the core. The roadmap (`docs/PLAN.md`) calls for inverting these onto ports so synthetic data today and real data later share one seam.
- **Decision:**
  - Introduce four input ports — `PatientDataProvider`, `EmployeeDirectory`, `MeasureDefinitionProvider`, `EvaluationConfigProvider` — in `com.workwell.engine.port`, with `MeasureDefinition` in `engine.model`. `CqlEvaluationService` is constructed from these ports.
  - The synthetic demo becomes the **default adapter set** in `engine.synthetic` (`@Component` beans). The live TWH demo runs on them unchanged; a future real-data adapter is added as an alternative bean selected by profile/config (the `EngineConfig` seam), with the synthetic beans remaining default (`docs/PLAN.md` principle 5).
  - **Same Gradle module**, not a separate `:engine` project — keeps CI sharding, Docker build, and the OneDrive binary-results workaround untouched. The "Spring-free core" guarantee is enforced by `EngineNoSpringContextTest`, which constructs and runs the engine with plain `new` and no `ApplicationContext`. Future extraction to a dedicated module stays mechanical because the package boundary has no Spring imports.
  - **`OutreachChannel` deferred to E5** (no consumer yet — YAGNI). Four ports now.
  - **Outcome parity is the gate:** a golden-file characterization test captures the deterministic (employee → outcome-status) mapping for all 100 employees × 10 measures and asserts it is unchanged by the refactor.
- **On the "#82 single source of truth":** the value-set/code **bindings** that were duplicated lived only in `CqlEvaluationService.measureSeedSpecFor()`; they are now solely in `SyntheticMeasureDefinitionProvider`. `MeasureService.ensure*Seed()` holds catalog/UI metadata (`spec_json`) and CQL filenames — a separate concern, not the binding data — so no further dedup was warranted there. A speculative name→file catalog was intentionally **not** added (YAGNI; E2's YAML carries the CQL reference).
- **Consequences:**
  - `CqlEvaluationService` public methods (`evaluate`, `evaluateSubject`) are unchanged, so callers (`AllProgramsRunService`, `CaseFlowService`, `MeasureImpactPreviewService`, `SeedHistoricalRunsService`) are unaffected.
  - E2 adds a YAML-backed `MeasureDefinitionProvider`; later epics add real `PatientDataProvider`/`EmployeeDirectory` adapters behind the same ports.
  - No schema migration; no AI/compliance-logic change. AI still never decides compliance; CQL `Outcome Status` remains the sole source of truth.

## ADR-004: Adopt `@mieweb/ui` as the frontend component library (dark mode + Enterprise Health brand)

- **Date:** 2026-06-09
- **Status:** Accepted
- **Stakeholder:** Doug (direction 2026-06-08: "Mieweb UI" + "use nitro for all tables")
- **Context:** The frontend was built on hand-rolled primitives (CVA + clsx + tailwind-merge) styled with hardcoded `slate-*` Tailwind classes, light-only. Doug's direction is for WorkWell to consume MIE's own component library so the work is reusable across MIE's internal projects and products. `@mieweb/ui` (v0.6.1, public npm, ui.mieweb.org) provides themeable React components (Tailwind 4, dark mode, brand theming incl. Enterprise Health) plus a DataVis NITRO data-grid entry.
- **Decision:**
  - Adopt `@mieweb/ui` as the frontend component library. Primary surfaces use its components (`Button`, `Select`, `Input`, `Badge`, `Modal`, `Toast`, `Skeleton`, `Sidebar`, `AppHeader`).
  - **Brand:** Enterprise Health is the default brand; a runtime brand switcher lives in the header (`useBrand` injects `/brands/{brand}.css`).
  - **Theming:** full semantic-token migration + dark mode (`useTheme` sets `.dark` + `data-theme`; persisted). Status-color helpers in `lib/status.ts` carry `dark:` variants app-wide.
  - **Tables:** DataVis NITRO was deferred here, then **unblocked via vendoring** — see **ADR-007**. The strong-fit operational/audit tables now use the real NITRO grid; small in-card tables stay themed semantic tables.
  - **Kept:** Monaco (CQL editor) and recharts (rethemed) — no `@mieweb/ui` equivalent.
  - **Exceptions:** `/login` and `/sandbox` remain bespoke pre-auth pages (not part of the themed dashboard surface).
- **Consequences:**
  - The frontend stack line in `CLAUDE.md`, `README.md`, and `AGENTS.md` changes from `shadcn/ui` to `@mieweb/ui` (this ADR authorizes that stack change).
  - New runtime dependency: `@mieweb/ui` (+ its `lucide-react`/CVA peers already present). `@mieweb/ui` must only be imported from `"use client"` modules — its barrel evaluates `React.createContext` at load, which breaks Server Component builds (hence the `components/client-providers.tsx` boundary).
  - Implementation landed phased on `feat/mieweb-ui-migration` → **PR #68**; report-first living doc at `frontend/MIEWEB-UI-MIGRATION.md`; design spec at `docs/superpowers/specs/2026-06-08-mieweb-ui-migration-design.md`.
  - Follow-ups: publish/consume NITRO once available; component-purity swap of native controls on the dense table pages + studio tabs; brand Jost-font fidelity.

## ADR-001: Single Spring Boot deployable with modular package boundaries

**Superseded — full text in [`docs/archive/DECISIONS_ARCHIVE.md`](archive/DECISIONS_ARCHIVE.md#adr-001).** The original Spring Boot architecture. ADR-008 retired the JVM and deleted `backend/`.

## ADR-003: Single all-encompassing TWH instance (consolidation from three-instance model)

- **Date:** 2026-05-21
- **Status:** Accepted
- **Stakeholder:** Doug (confirmed direction 2026-05-21)
- **Context:** During the sprint build-out (May 2–17), three separate deployment instances were created to isolate concerns during development: `workwell` (base skeleton), `ecqm` (CMS eCQM catalog seeding), and `twh` (Total Worker Health — OSHA safety measures). Each had its own workflow, frontend image, and partially-seeded database. Doug's May 21 review surfaced that these were not separate products — they were a development stepping stone. From the JOURNAL 2026-05-21 entry:
  > "Doug clarified the product direction: TWH (Total Worker Health) is all-encompassing. OSHA occupational safety compliance and clinical quality (eCQMs, HEDIS wellness) are not separate products — they are two sides of the same coin and belong in one platform. The three-instance deployment model (workwell, ecqm, twh) was a development stepping stone, not the product architecture. One TWH instance covers everything."
  >
  > "NIOSH's TWH framework is the conceptual foundation: worker health is shaped by both workplace hazards (OSHA safety programs) and general health promotion (chronic disease, preventive care). WorkWell is the platform that manages both in one system with a shared measure catalog, shared case workflow, shared audit trail, and shared CQL evaluation engine."
- **Decision:** Consolidate to a single TWH deployment. Delete the `deploy-os-mieweb.yml` (workwell instance) and `deploy-ecqm-mieweb.yml` (eCQM instance) workflows. The sole active workflow is `deploy-twh-mieweb.yml`, which builds the backend (`ghcr.io/taleef7/workwell-api`) and TWH-branded frontend (`ghcr.io/taleef7/workwell-twh-frontend`) and sets `WORKWELL_INSTANCE=twh` to seed all three measure categories on startup: OSHA safety (4 active CQL + 3 catalog-only), HEDIS wellness (4 active CQL), and CMS eCQM catalog (49 Draft entries). The old `workwell` and `workwell-api` MIE containers were deleted from the manager UI. Fly.io `workwell-measure-studio-api` was destroyed (stale secondary stack from the Fly era). The production URLs are `https://twh.os.mieweb.org` (frontend) and `https://twh-api.os.mieweb.org` (backend).
- **Consequences:**
  - `ecqm.os.mieweb.org` and `workwell.os.mieweb.org` are intentionally offline. The workwell hostname currently returns a 404; a 301 redirect to `twh.os.mieweb.org` is the documented follow-up (see infra/redirect/).
  - The eCQM seeding path (`ensureCmsEcqmCatalogSeed()`), the `workwell-ecqm-frontend` image build config, and the `*_ECQM` GitHub secrets are retained as a restore-later capability in case a separate eCQM-only instance is needed in future.
  - Every push to `main` deploys the single TWH environment, giving a clear signal that `main` is always production.
  - The platform can expand its catalog (more OSHA measures, more HEDIS measures, more CMS eCQMs) without any infrastructure change — it is all one seeded database with one shared catalog, case workflow, and audit trail.
  - Cost: reduced — one container pair instead of three.

## ADR-002: evidence_json shape and define-level traceability

- **Date:** 2026-05-01
- **Status:** Accepted
- **Context:** For "Explain Why Flagged", we need to decide whether to keep raw `evaluatedResource` evidence only, add explicit `rule_path[]`, or derive rule path automatically from CQL define results. D1 rechecked this against the repository CQF reference in `docs/CQF_FHIR_CR_REFERENCE.md`, which is the durable source of truth for `cqf-fhir-cr` behavior used by this ADR.
- **Decision:** Adopt the processor two-step composite flow as the canonical run pipeline:
  1. `R4MeasureProcessor.evaluateMeasureWithCqlEngine(...)` to compute `CompositeEvaluationResultsPerMeasure` (including define-level `expressionResults`).
  2. `R4MeasureProcessor.evaluateMeasure(..., compositeResults)` to materialize the standard `MeasureReport` from the same computed results.
- **Evidence from probe:**
  - `R4MeasureService.evaluate(...)` returns `MeasureReport` only; no define-result map is present on `MeasureReport`.
  - `R4MeasureProcessor.evaluateMeasureWithCqlEngine(...)` returns `CompositeEvaluationResultsPerMeasure` containing per-subject `EvaluationResult`.
  - `EvaluationResult.expressionResults` contains define-name/value pairs (probe output included `Denominator`, `Initial Population`, `Numerator` with boolean values).
  - Dual-evaluation cost probe (2026-05-01): `serviceEvaluateMs=5` vs composite flow `combinedMs=2` (`engineEvalMs=2`, `reportBuildFromCompositeMs=0`), so the composite path is a cheaper primary path, not a workaround.
- **Consequences:**
  - `evidence_json` shape is now structured as `{ expressionResults: {...}, evaluatedResource: [...] }`.
  - `rule_path[]` is derived at render time from CQL define names + `expressionResults`; it is not persisted as a stored field.
  - "Why Flagged" UI is structured-first: render `expressionResults` deterministically as the base case; AI natural-language wrapping is optional polish.
  - Outstanding Week 5 confirmation: run this same composite flow against the JPA-backed repository path. Expected yes, not yet tested in this exact combination.
