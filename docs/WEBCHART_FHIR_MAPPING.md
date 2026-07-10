# WebChart → FHIR R4 Mapping Reference (E12 PR-2 groundwork)

**Status:** Active — **PR-2b implemented** (2026-07-03). This is the reverse-engineered mapping +
the transport-agnostic adapter core that now lives in `backend-ts/src/engine/ingress/webchart/`
(terminology reconciliation + FHIR normalization, wired into `webChartDataSource`, transport
injected). The remaining **PR-2c** work (the confirmed live HTTP request shaping) waits on the
WebChart API contract from Dave Carlson (MIE, meeting week of 2026-07-06).

**Decisions locked (owner, 2026-07-03):**
- **Integration path = WebChart HTTP/FHIR API** (not a direct MariaDB read). So **no MariaDB driver
  dependency** — the adapter uses the global `fetch`. The dev DB below is a **schema/shape reference**,
  not a runtime dependency.
- **Immunizations are handled by ICE** (the existing E6 `ImmunizationForecast` seam); WorkWell is
  consolidating them here over time. So the WebChart adapter does **not** need to solve WebChart's
  missing CVX-immunization store (§3.7) — immunization data flows from ICE, not this adapter.
- **The dev seed is a *sample*** — representative-ish of production shape but not fully accurate/complete
  (and not wrong/redundant). So map to its *shapes*, don't over-fit exact fields/volumes.

**Source of truth for this mapping:** MIE's seeded WebChart dev database, shared by Doug on 2026-07-03
as a Docker image (`ghcr.io/mieweb/dev-wcdb:latest`, MariaDB **10.3.32**). It is pulled locally and
backed up (see the maintainer's local `mie-wcdb-backup/` and the `project_webchart_dev_db` memory). Run it:

```bash
docker run -d --name wcdb -p 33306:3306 ghcr.io/mieweb/dev-wcdb:latest
# host=localhost port=33306 user=root pass=pmg2bhok db=wc_miehr_wctroot
```

> This is a **local reference DB only** — it is not, and must not become, a live backend dependency of
> the demo stack. E12 PR-2 reads *shapes* from it; production wiring targets a real WebChart instance.

---

## 1. The target: the FHIR bundle shape the engine already consumes

The adapter's job is to emit, per subject, the **same FHIR R4 `Bundle` (type `collection`)** that
`backend-ts/src/engine/synthetic/fhir-bundle-builder.ts` emits today, so the unchanged
`CqlExecutionEngine` evaluates WebChart data exactly as it evaluates synthetic data (FHIR-native-first,
ADR-017). The engine derives each subject id from its bundle's `Patient`. Resources the current measures read:

| FHIR resource | Key fields the CQL matches on |
|---|---|
| `Patient` | `id`, `name[].text`, `birthDate` |
| `Condition` | `code.coding[].system` + `.code` (enrollment / waiver / refusal), `subject.reference`, `clinicalStatus`, `verificationStatus` |
| `Observation` | `code.coding[].system` + `.code`, `effectiveDateTime`, `valueQuantity` (labs/vitals, e.g. HbA1c) |
| `Procedure` | `code.coding[].system` + `.code`, `performedDateTime` (e.g. audiogram, mammogram) |
| `Immunization` | `vaccineCode.coding[].system` + `.code`, `occurrenceDateTime`, `status` (Td/Tdap, Hep B, MMR, varicella, flu) |

The CQL matches events by **inline code filters** on `code.coding.system`/`code`. Today those are
**synthetic** (`urn:workwell:vs:*` + synthetic codes). WebChart carries **real terminologies**
(LOINC/CPT/CVX/ICD-10/SNOMED). Bridging the two is the crux of PR-2 — see §5.

---

## 2. WebChart data model — three things to know

1. **Revisioning: `_current` + `_revisions`.** Live rows are in `<entity>` / `<entity>_current`;
   history is in `<entity>_revisions`. Read the current view for evaluation.
2. **`patients` holds patients *and* providers.** One table. `is_patient` distinguishes them; provider
   rows carry `license_number`, `dea_number`, `nat_pro_id`, and the `attending/referring/family_physician`
   FKs point back into `patients`.
3. **Observations are EAV over a code dictionary.** A result row (`observations_current`) references an
   `obs_code` whose definition (name, type, **LOINC**, units, ranges) lives in `observation_codes`.

`information_schema.table_rows` is an unreliable InnoDB estimate — always `COUNT(*)`.

Populated counts in the dev seed (verified): `patients` 72, `patient_mrns` 100, `encounters` 105,
`observations_current` 1887, `observation_codes` 8230, `patient_procedures` 99, `encounter_orders` 225,
`order_list` 1470 (catalog), `users` 69, `locations` 9, `documents` 569.

---

## 3. Resource-by-resource mapping

### 3.1 Patient ← `patients` (+ `patient_mrns`)
| FHIR | WebChart |
|---|---|
| `id` | `patients.pat_id` (stable internal id; use as the subject external id) |
| `identifier` (MRN) | `patient_mrns.mrnumber` (partition `wc_partition`; a patient may have >1) |
| `name[].given/family` | `first_name`, `last_name`, `middle_name` (+ `preferred_*`) |
| `birthDate` | `birth_date` (datetime → date) |
| `gender` | `sex` (map WebChart code → FHIR `administrative-gender`) |
| `deceasedBoolean/DateTime` | `death_indicator`, `death_date` |
| `address` | `address1/2/3`, `city`, `state`, `zip_code`, `country` |
| `telecom` | `home_phone`, `cell_phone`, `work_phone`, `email` |
| US Core race/ethnicity | modeled as **observations** (LOINC `32624-9` CDC Race, `80908-7` CDC Ethnicity) — see §3.5 |
| **employer (TWH-relevant)** | `employer_name`, `employer_uid`, `employer_addr*`, `employment_status` — the occupational-health hook; no direct FHIR field (extension or a derived `Group`/coverage) |
| `active` | `active`, `is_patient` (filter `is_patient=1` for the worker roster) |

### 3.2 Practitioner ← `users` and/or `patients WHERE is_patient=0`
`encounters.doc_id` / `patient_procedures.performing_physician` / `encounter_orders.doc_id` reference the
provider. Confirm whether the canonical provider key is `users.*` or the provider rows in `patients`
(both exist; `patients` carries the credential fields). Maps to the E4 **provider** hierarchy level.

### 3.3 Location/Organization ← `locations` (9) + `locations_hierarchy`
`encounters.location` / `location_pat_id` attribute the encounter. `locations_hierarchy` (7) +
`locations_flattened_hierarchy` give the enterprise→location tree — the real-data analog of the E4
synthetic hierarchy.

### 3.4 Encounter ← `encounters` (+ `encounters_current`)
| FHIR | WebChart |
|---|---|
| `id` | `encounter_id` |
| `subject` | `pat_id` |
| `participant` (provider) | `doc_id`, `performing_user_id` |
| `period.start` | `serv_date` |
| `type` | `visit_type`, `service_code` |
| `location` | `location`, `location_pat_id` |
| `reasonCode` (dx) | `primary_diagnosis`, `diagnosis2..4` (ICD) |

### 3.5 Observation ← `observations_current` ⋈ `observation_codes`  ← **primary lab/vital source**
| FHIR | WebChart |
|---|---|
| `subject` | `observations_current.pat_id` |
| `code.coding` | `observation_codes.loinc_num` (system LOINC) — **real LOINC present** |
| `code.text` | `observation_codes.obs_name` |
| `effectiveDateTime` | `observations_current.obs_result_dt` or `obs_ts` |
| `valueQuantity.value` | `observations_current.obs_result_dec` (+ `obs_units` from the code) |

```sql
SELECT o.pat_id, oc.loinc_num, oc.obs_name, o.obs_result_dec, o.obs_result_dt, o.obs_ts
FROM observations_current o
JOIN observation_codes oc ON oc.obs_code = o.obs_code
WHERE oc.loinc_num IS NOT NULL;
```

> **Open item — coded/text observation values.** `observations_current` only carries `obs_result_dec`
> (numeric) + `obs_result_dt` (datetime). The **rich** result model — `obs_result` (text),
> `obs_result_code` + `obs_result_code_system` (coded answers, e.g. CWE race/ethnicity), `obs_flag`,
> `obs_status`, `free_text`, `interpretive_text` — lives on the base **`observations`** table, which is
> **empty in this dev seed**. So in this seed, non-numeric observation *values* are not recoverable.
> **Confirm with MIE** which table is authoritative in production and whether `observations` is
> populated there; the adapter's Observation query likely needs `observations` (full model) rather than
> `observations_current` (numeric fast-path) for anything but decimals. Titer-proves-immunity (a deferred
> WorkWell feature) depends on this — e.g. LOINC `16935-9` Hep B surface Ab is a coded/quantity result.

### 3.6 Procedure ← `patient_procedures` (+ `encounter_orders`)
`patient_procedures` is a clean CPT/ICD-10 Procedure source: `cpt_code`, `icd10`, `concept_id`,
`description`, `service_date`, `performing_physician`. `encounter_orders` is placed orders
(→ FHIR `ServiceRequest` for pending, `Procedure` for completed): `order_id`→`order_list`,
`icd10`/`concept_id`, `status`, `completed_dt`. The `order_list` **catalog** row carries `cpt_code` +
`loinc_code`.

> **Open item — sparse coding.** In the dev seed only **1** `patient_procedures` row has a real CPT
> (`G0202`, mammogram screening) across 99 rows; the rest are blank-coded. Confirm production density.

### 3.7 Immunization ← **NO dedicated CVX table — must be traced**
There is no `immunizations` table. The only vaccine-adjacent table is `encounter_order_forecast` (19
rows). Administered vaccines in WebChart are modeled as **orders** (`encounter_orders`/`order_list`) or
**procedures** (CPT immunization-administration codes) — but a name/CVX search of `order_list` returned
**no** vaccine rows in this seed. **Resolved (owner, 2026-07-03): immunizations are handled by ICE**
(the existing E6 `ImmunizationForecast` seam), which WorkWell is consolidating over time — so the
WebChart adapter does **not** source immunizations, and this gap does not block the immunization
measures via this path. The adapter maps WebChart's labs/vitals/procedures/encounters; immunization
data comes from ICE. (If a production WebChart *does* record administered CVX vaccines, wiring them is a
later additive enhancement, not a blocker.)

### 3.8 Condition ← `encounters.primary_diagnosis` (ICD) + problem list (confirm)
Encounter diagnoses are ICD on `encounters.primary_diagnosis`/`diagnosis2..4`. A standalone problem
list (`patient_conditions`, `patient_diagnosis`) is present but **0 rows** in this seed — confirm the
production problem-list table for enrollment/exclusion Conditions.

---

## 4. Adapter read-query scope (per subject → one bundle)

The PR-2 adapter's `loadBundles()` fans out per patient (or a bounded page of patients) and assembles a
bundle from these reads:

1. **Patient** — `patients` ⋈ `patient_mrns` (`WHERE is_patient=1`).
2. **Observations** — `observations_current` ⋈ `observation_codes` (LOINC) [+ `observations` for coded/text once confirmed].
3. **Procedures** — `patient_procedures` [+ completed `encounter_orders` ⋈ `order_list`].
4. **Immunizations** — **not sourced here** (ICE, per the locked decision).
5. **Conditions** — encounter diagnoses [+ problem list once confirmed].
6. Provider/location joins for hierarchy attribution (§3.2/§3.3).

> **Enrollment gap (found during PR-2b).** The measures gate on a **program-enrollment `Condition`**
> (e.g. `In Hearing Conservation Program`) which is *not* a WebChart clinical code — it's occupational-health
> **program membership**, held in an OH program roster, not in encounters/observations/problems. So a
> WebChart clinical bundle alone evaluates as MISSING_DATA for an enrolled worker (no recognized event
> *and* no enrollment). The adapter therefore needs a **second input — the OH enrollment roster** — to
> stamp the enrollment Condition (the synthetic bundle builder does this today from `ExamConfig.programEnrolled`).
> On the demo synthetic directory that roster is the directory itself; against real WebChart, confirm where
> program membership lives (a WorkWell-side roster is the likeliest home; ask MIE — §7). This is distinct
> from the terminology bridge and applies regardless of the transport.

Bounded, paged reads (mirror the E13 `aggregateScaleRun` discipline — never load the whole table into
memory); the engine already isolates per-item errors via `evaluateBatch` (per-bundle try/catch).

---

## 5. The terminology bridge (the real crux)

WebChart events are **LOINC/CPT/CVX/ICD-10/SNOMED**-coded; the WorkWell measures match **synthetic
`urn:workwell:vs:*` codes** via inline CQL code filters. Three ways to make WebChart data evaluate:

| Option | What it means | Trade-off |
|---|---|---|
| **A. Re-author measures to real codes** | Change each measure's binding/CQL to match real LOINC/CVX/CPT | Cleanest long-term; aligns with E14 standards-fidelity; touches every measure; needs value-set expansion (E3.2 `ValueSetResolver`, blocked on VSAC key for real OIDs) |
| **B. Translate in the adapter** | Adapter maps WebChart codes → the synthetic codes the measures expect, using the existing `terminology_mappings` table | Localizes change to the adapter; measures untouched; but maintains a hand-curated crosswalk and keeps synthetic codes canonical |
| **C. `ValueSetResolver` expansion** | Feed the engine a real `CodeService` so a CQL value-set retrieve matches real membership | The intended architecture (E3.2 seam exists); still needs real value-set content (VSAC) |

**Decision (2026-07-03): option B is implemented** — `backend-ts/src/engine/ingress/webchart/terminology.ts`
is the adapter-local crosswalk. It reuses the same real standard codes as the E7 order catalog
(audiogram→CPT 92557, TB→86580, flu→CVX 141, …) plus LOINC result codes for the lab/vital measures
(HbA1c 4548-4, LDL 13457-7/**2089-1**, BP 85354-9/**8480-6**, BMI 39156-5, mammogram HCPCS G0202/CPT 77067;
the **bold** codes — LDL `2089-1` serum and systolic BP `8480-6` — are MIE's *actual* dev-DB codes, added
after confirming the seed, #246 §8.1). It **appends** the
synthetic measure-event coding to a real WebChart coding (preserving the real code for provenance), maps
one real code to **all** measures it serves (HbA1c → both `diabetes_hba1c` and `cms122`), and tolerates
system aliases (canonical URI or OID, case-insensitive).

**Resource-type seam (Observation vs Procedure).** WebChart records labs/vitals (HbA1c, LDL, BP, BMI)
as `Observation`s, but four of those measures (`diabetes_hba1c`, `cholesterol_ldl`, `hypertension`,
`obesity_bmi`) retrieve `[Procedure]` in their CQL — a synthetic-data modeling quirk (only `cms122` is
value-based and retrieves `[Observation]`). So merely appending a coding to the Observation wouldn't let
those recency measures match. The normalizer therefore **synthesizes a dated `Procedure`** (carrying the
target coding + the Observation's `effectiveDateTime`, tagged `derived-from-observation`) whenever a lab
Observation reconciles to a `[Procedure]`-retrieving measure — so a real WebChart LOINC lab evaluates
end-to-end (proven by a test: an HbA1c `Observation` → `diabetes_hba1c` COMPLIANT). The
standards-correct end state is **option A** — re-point those measures' `event.type` to `observation` — a
measure/CQL change tracked for PR-2c / E14. **A/C stay the standards-correct destination** tied to E14 +
the VSAC unblock. ADR-008 intact: reconciliation supplies coded FHIR, it never decides compliance.

---

## 6. Architecture — decisions (2026-07-03)

1. **Integration path = WebChart HTTP/FHIR API** (not a direct MariaDB read). The dev MariaDB is the
   schema/shape reference; production reads go through WebChart's API. (Dave Carlson provides the exact
   API contract, week of 2026-07-06.) Overlaps the E9 memo but is now decided for E12.
2. **No new dependency.** The HTTP path uses the global `fetch` — **no MariaDB/MySQL driver**, so the
   CLAUDE.md new-dependency gate is not triggered. `backend-ts` adds no deps.
3. **Transport at the edge.** The transport lives in `webchart/webchart-client.ts` (the `WebChartClient`
   port + a **deferred** `httpWebChartClient` that rejects until the confirmed contract + a
   `fixtureWebChartClient` for tests); the reconciliation + normalization core stays I/O-free and portable,
   matching the `evaluate-bundle.ts` design.

---

## 7. Confirm-with-MIE / Dave Carlson (API discovery for PR-2c)

**Answered (owner, 2026-07-03):** ~~representativeness~~ (a sample — representative-ish, not fully
prod-accurate, not wrong); ~~immunization storage~~ (handled by ICE, not this adapter); ~~integration
path~~ (WebChart HTTP/FHIR API); ~~MariaDB driver~~ (not needed — HTTP/`fetch`).

**Open — bring to the Dave Carlson meeting (drives `httpWebChartClient`):**
1. **Is it a true FHIR R4 API** (returns FHIR resources) **or a proprietary REST API** over the
   `wc_miehr_wctroot` schema? (If FHIR, normalization is mostly pass-through + reconciliation; if
   proprietary, the adapter also maps rows→FHIR per §3.)
2. **Endpoints + population read:** how to list the worker population and fetch one patient's clinical
   data — a FHIR `$everything`/search, or per-resource endpoints? Pagination?
3. **Auth:** Bearer token, API key header, OAuth client-credentials? (drives the `WebChartConfig` shape).
4. **Which observation representation** the API returns for non-numeric results (the base `observations`
   `obs_result`/`obs_result_code` model vs the `observations_current` numeric fast-path — §3.5).
5. **Program enrollment / OH roster:** where does *program membership* live (the enrollment gap in §4)?
   Is it a WorkWell-side roster, or does WebChart expose occupational-health program enrollment?
6. **Provider/location** canonical keys for hierarchy attribution (§3.2/§3.3).

---

## 8. PR-2 slicing (progress)

- **PR-2a (done):** this mapping reference + read-query scope + decision forks.
- **PR-2b (done, 2026-07-03):** the **transport-agnostic adapter core** — `webchart/terminology.ts`
  (reconciliation, option B + the `targetEventType` seam), `webchart/normalize.ts` (WebChart FHIR →
  engine bundle shape, non-mutating, with Observation→Procedure synthesis for `[Procedure]`-retrieved lab
  measures), `webchart/webchart-client.ts` (the `WebChartClient` port + fixture + a **deferred** HTTP
  client that rejects until the confirmed contract), wired into `webChartDataSource(cfg, client?)`
  (transport injected). Fully unit-tested + three end-to-end tests proving a **real-CPT-coded** procedure,
  a **real-LOINC-coded** lab Observation, AND a **real-CVX Heplisav-B series** each evaluate to COMPLIANT
  via reconciliation (each with an un-reconciled non-COMPLIANT control). Whole-branch code review + two
  Codex comments folded in (resource-type coverage gap, input non-mutation; **P1** the deferred HTTP client
  rejects rather than collapse a population into one bundle; **P2** multi-alternative Hep B preserves the
  real CVX code so the series matches). No new deps; no schema. Descriptive only (ADR-008/ADR-017).
- **PR-2c (waits on §7 answers):** finalize `httpWebChartClient`'s request shaping against the real API,
  and (if the API is proprietary) add the row→FHIR mapping per §3. Wire behind `resolveDataSource(env)`;
  still descriptive only.

### 8.1 Offline dev-DB evaluation proof (#246 — done, PR-1/PR-2, 2026-07-07)

While PR-2c waits on the live API, the pipeline is proven **end-to-end offline on the real dev-DB sample**,
with no live API and **no MariaDB driver**:

- **PR-1 — OH enrollment roster** (`engine/ingress/enrollment/roster.ts`): closes the §4 enrollment gap.
  `stampEnrollment(bundle, measureId, roster)` appends the `urn:workwell:vs:*` enrollment `Condition` from
  `MEASURE_BINDINGS[id].enrollment` (identical to the synthetic builder's `condition()`), and
  `evaluateSourceWithRoster` wires it into the ingress. So a WebChart clinical bundle (which lacks OH
  enrollment) evaluates to a real bucket instead of MISSING_DATA.
- **PR-2 — export tool + committed fixtures + e2e proof.** `scripts/webchart-devdb-export.ts` (dev-only,
  driver-free: shells `docker exec … mysql --batch --raw -N` with `JSON_OBJECT` and **serializes the FHIR
  in Node**) emits `spike/webchart/devdb-patients.json` (56 patient bundles, every `is_patient=1` row) +
  `spike/webchart/enrollment-roster.json`. `webchart/devdb-eval.test.ts` runs them through the unchanged
  ingress + engine and asserts **deterministic, per-patient outcomes** at a data-contemporaneous eval date
  (2024-06-01) — a real COMPLIANT/OVERDUE/MISSING_DATA mix. Regenerate with
  `pnpm webchart:export-devdb` (Docker + the `wcdb` container up; never at runtime/CI).
- **PR-3 — demo CLI.** `pnpm evaluate:webchart-devdb [--date YYYY-MM-DD]`
  (`webchart/devdb-cli.ts`) evaluates the committed sample across the whitelist and prints a per-measure
  outcome summary (naming the excluded measures — no silent caps) — the showable artifact. On the sample it
  reports **28 real (non-MISSING_DATA) outcomes** (e.g. `obesity_bmi` 5 COMPLIANT / 8 OVERDUE / 43
  MISSING_DATA over 56 patients).

**Crosswalk firmed to MIE's actual codes.** The dev DB records **LDL as LOINC `2089-1`** and **BP as the
component `8480-6` (systolic)** — not the synthetic assumptions (`13457-7`/`18262-6`, panel `85354-9`).
Those two rows were added to `webchart/terminology.ts` (§5, option B). **Demonstrable whitelist** (real
LOINC/HCPCS present): `diabetes_hba1c`, `obesity_bmi`, `cholesterol_ldl`, `hypertension`, and `cms125`
(one HCPCS `G0202` mammogram). **Named-excluded** (no matching seed data — asserted to stay MISSING_DATA,
never silently dropped): the OSHA CPTs (`audiogram`/`tb_surveillance`/`hazwoper`), the CVX vaccine measures
(`flu_vaccine`/`adult_immunization`/`mmr`/`varicella`/`hepatitis_b_vaccination_series` — ICE's domain), and
`cms122` (value-based; the seed's `obs_result_dec` is null and it needs a diabetes dx the seed lacks).

Descriptive-only throughout: the adapter supplies coded FHIR; the CQL engine remains the sole source of
compliance truth (ADR-008/ADR-017).

### 8.2 PR-2c pre-build — mock-contract HTTP transport (#255, 2026-07-09)

While the final MIE answers in `docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md` are still pending,
`httpWebChartClient` has been pre-built against the assumed **true FHIR R4** contract documented in
`docs/WEBCHART_API_ASSUMPTIONS_2026-07.md`: `GET /fhir/Patient?_count=...` for paged population
listing, FHIR searchset `link[relation=next]` pagination, and `GET /fhir/Patient/{id}/$everything` for
one-patient clinical payloads. It sends `Authorization: Bearer <WORKWELL_WEBCHART_API_KEY>`, uses global
`fetch`, bounds every request with an AbortController timeout, retries 429/5xx with short bounded
backoff, and preserves the one-payload-per-patient invariant so the engine never evaluates a collapsed
multi-patient bundle.

The local conformance suite serves the committed dev-DB fixtures through an in-test mock `fetch` shim and
asserts that the mock-HTTP path produces the same per-subject outcomes as the fixture-client path for the
dev-DB goldens, plus timeout, 429-then-success, partial-page, malformed-resource, and empty-population
failure modes. A malformed or failed per-patient `$everything` response degrades to a Patient-only
collection bundle with an `OperationOutcome` marker, so the existing CQL evaluation path reports that
known subject as missing data without aborting the rest of the batch. This is still **not** the final live
transport: PR-2c must adjust request shaping, auth, pagination, and (if A1 says proprietary) add the
row→FHIR mapper once MIE confirms the real contract. Inert-unless-configured remains unchanged:
`resolveDataSource(env)` still selects WebChart only when both WebChart env vars are non-blank.
