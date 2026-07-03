# WebChart → FHIR R4 Mapping Reference (E12 PR-2 groundwork)

**Status:** Groundwork / design reference. Unblocks **E12 PR-2** (the real WebChart/MariaDB→FHIR
adapter that today is the inert `webChartDataSource` stub, `backend-ts/src/engine/ingress/data-source.ts`).
**No code or schema change in this document** — it is the reverse-engineered mapping that a subsequent
implementation PR builds against.

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
**no** vaccine rows in this seed. **This is the biggest gap and blocks the immunization measures**
(Td/Tdap AIS-E, Hep B series, MMR, varicella, flu — a large share of the runnable catalog). Action:
ask MIE where administered immunizations + their CVX codes live in a production WebChart, or accept that
this dev seed cannot exercise the immunization measures end-to-end.

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
4. **Immunizations** — TBD (see §3.7).
5. **Conditions** — encounter diagnoses [+ problem list once confirmed].
6. Provider/location joins for hierarchy attribution (§3.2/§3.3).

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

**Recommendation:** start with **B** for the demo-provable slice (adapter-local crosswalk over
`terminology_mappings`, which already seeds audiogram→CPT 92557, TB→86580, flu→CVX 141), and treat **A/C**
as the standards-correct destination tied to E14 + the VSAC unblock. This keeps ADR-008 intact
(CQL stays the sole compliance authority; the adapter only supplies coded FHIR, it never decides
compliance).

---

## 6. Architecture forks to decide (flagged, not decided here)

1. **MariaDB-direct vs WebChart HTTP API.** The current stub config is `{baseUrl, apiKey}` (HTTP-shaped),
   but Doug provided a **MariaDB** image. Direct-DB read is the lowest-friction path against this
   reference and matches "WebChart/MariaDB→FHIR adapter." Confirm whether production integration should
   go through a WebChart REST/FHIR endpoint instead (in which case the config shape stays HTTP and the
   adapter maps API responses, not SQL rows). This overlaps the **E9 CQL→SQL-bridge decision memo** (the
   pending Doug Q2 fork).
2. **New dependency (hard rule — needs approval).** A direct-DB adapter needs a MariaDB/MySQL driver
   (`mysql2`/`mariadb`) in `backend-ts`. Per CLAUDE.md, **new dependencies require explicit approval +
   an ADR**. Do not add it silently. An HTTP adapter avoids a DB driver but needs a WebChart API.
3. **Where the adapter runs.** `evaluate-bundle.ts`/`data-source.ts` are deliberately `node:fs`-free /
   DB-free to stay portable across `@mieweb/cloud` targets. A DB driver would live at the ingress **edge**
   (like the CLI's file I/O), not in the portable core.

---

## 7. Confirm-with-Doug / MIE

1. **Is this dev seed representative** of production WebChart shape *and volume*, or a minimal seed? (It
   is rich in dictionary/config + demographics but **thin on coded clinical events**: 1 real CPT, no
   CVX immunizations, empty base `observations`/problem-list.)
2. **Where do administered immunizations + CVX codes live** in production WebChart? (§3.7 — blocks the
   immunization measures.)
3. **Which observation table is authoritative** for non-numeric results — base `observations`
   (`obs_result`/`obs_result_code`) vs `observations_current`? (§3.5.)
4. **Integration path:** direct MariaDB read vs a WebChart REST/FHIR API? (§6.1; ties to E9 Q2.)
5. OK to add a **MariaDB driver dependency** to `backend-ts` (ADR), or should PR-2 target an HTTP API?

---

## 8. Proposed PR-2 slicing

- **PR-2a (this doc):** the mapping reference + read-query scope + decision forks. **No code.**
- **PR-2b:** a **read-only, offline** `webchart-fhir` mapping module + fixtures — pure functions
  `rowsToPatientBundle(...)` with unit tests over rows captured from the dev DB (no live driver, no new
  dependency; fixtures checked in). Proves the mapping against real shapes.
- **PR-2c (needs the §6/§7 decisions):** the live `PatientDataSource` — either a MariaDB driver adapter
  (with the approved dependency + ADR) or a WebChart HTTP adapter — wired behind
  `resolveDataSource(env)`, replacing the inert stub. Terminology option B crosswalk. Still descriptive
  only (ADR-008).

Descriptive-only throughout: the adapter supplies coded FHIR; the CQL engine remains the sole source of
compliance truth (ADR-008/ADR-017).
