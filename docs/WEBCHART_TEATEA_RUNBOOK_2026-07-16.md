# teatea WebChart Trial — Owner Runbook

**Date:** 2026-07-16 · **Instance:** `https://teatea.webchartnow.com` (WebChartNow trial; owner
role: System Owner) · **Goal:** register a SMART Backend Services client, seed a realistic
synthetic population, and run WorkWell's live evaluation against the real WebChart FHIR API.

Everything here is **owner-executed** (the trial admin UI needs your logged-in session). Each step
says what to record back into `docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md` (the #254 answer log).
**Synthetic data only — never PHI** (CLAUDE.md hard rule; the trial is still a shared-vendor
system, treat it as demo-grade).

Verified facts this runbook builds on (probed 2026-07-16):

- FHIR base: `https://teatea.webchartnow.com/webchart.cgi/fhir/` (R4 4.0.1, 35 resources)
- smart-configuration: token endpoint `…/webchart.cgi/oauth/token/`, auth `private_key_jwt`
  **RS384 only**, scopes `patient/*.rs` + `system/*.read`, JWKS `…/webchart.cgi/jwks/`
- `grant_types_supported` advertises **only `authorization_code`** — whether a registered backend
  client still gets `client_credentials` is exactly what step 3 answers
- Client registration is manual, at the admin **JWT screen**: `…/webchart.cgi?f=admin&s=jwt`
  (it is the smart-configuration's `management_endpoint`)

> **⚠ Live-execution finding (2026-07-16) — §§2–3 are blocked on MIE; do NOT expect to self-serve.**
> A full browser walkthrough as System Owner established that client registration is **MIE-controlled**,
> not owner-serviceable on this trial (independently corroborated by a second research pass over the
> public `mieweb/docs` sources). Concretely, all of these were tried and failed:
> - `?f=admin&s=jwt` and `?f=admin&subfunc=login_trusts` → **"Super user access required."**
> - WebChart **"superuser" is NOT the "SuperUser" security role** and NOT the `Manage Login Trusts`
>   ACL. Setting the account to the SuperUser role (security_role_id 12) and granting the ACL still
>   gated. Per MIE docs, the Login Trusts editor lives under **"Control Panel → SuperUser"**, and
>   superuser is a **session elevation requiring an MIE-issued master/unlock password** — held by
>   MIE's internal accounts only (in the seeded dev DB the superuser accounts are `mie`/`cronjobs`,
>   not any customer role).
> - **RFC 7591 dynamic registration is OFF**: `POST …/webchart.cgi/register` and `…/oauth/register`
>   both return the HTML login shell (not JSON); smart-configuration advertises no `registration_endpoint`.
> - The **Application Entities editor is DICOM** (AE-titles), not an OAuth/FHIR client registry — dead end.
>
> **⇒ The `login_trusts` table is the only client registry, and writing it needs superuser. Steps 2–3
> below cannot complete without MIE.** Send the sharpened ask in **"MIE ask"** (end of §3), then resume
> at §3 once MIE either registers `workwell-backend` or grants superuser + the FHIR App Editor.

---

## 1. Generate the RS384 keypair (once, OUTSIDE the repo)

The private key must never enter the repo or any commit. Keep it in `%USERPROFILE%\.workwell\`.

PowerShell (Node is installed — no new tools):

```powershell
mkdir -Force ~\.workwell; cd ~\.workwell
node -e "const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('rsa',{modulusLength:2048});require('fs').writeFileSync('webchart-teatea.key',privateKey.export({type:'pkcs8',format:'pem'}));const jwk=publicKey.export({format:'jwk'});require('fs').writeFileSync('webchart-teatea.pub.jwk.json',JSON.stringify({keys:[{...jwk,alg:'RS384',use:'sig',kid:'workwell-2026-07'}]},null,2));console.log('wrote webchart-teatea.key (PRIVATE - never share) + webchart-teatea.pub.jwk.json (public JWKS - upload this)');"
```

Produces:

- `webchart-teatea.key` — PKCS#8 PEM **private** key → becomes `WORKWELL_WEBCHART_PRIVATE_KEY`
- `webchart-teatea.pub.jwk.json` — the **public** JWKS (`{"keys":[{…,"alg":"RS384","kid":"workwell-2026-07"}]}`) → uploaded/pasted at registration

(OpenSSL alternative: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out
webchart-teatea.key` already emits PKCS#8; derive the public JWK with the same Node
`crypto.createPublicKey(...).export({format:'jwk'})`.)

## 2. Register the client at the admin JWT screen

Open **`https://teatea.webchartnow.com/webchart.cgi?f=admin&s=jwt`** (logged in as System Owner).

This screen is only partially publicly documented, so the field names below are best-effort — **if
the UI differs, screenshot it** and we correct this runbook:

1. Create/register a new client. Suggested client id: **`workwell-backend`**.
2. Key material: paste/upload the **public** JWKS from step 1 (the whole `{"keys":[…]}` object). If
   the screen asks for a JWKS **URL** instead of inline key material, say so (screenshot) — we
   would then host the JWKS or ask MIE which form the trial accepts.
3. Scopes/permissions: grant the **system** read scope (`system/*.read` — the form teatea
   advertises). If only `patient/*` scopes are offered, note it.
4. If it asks for redirect URIs (an app-launch concept), a backend-services client has none —
   enter a placeholder like `https://localhost/unused` only if the form requires one, and note it.

**Record:** a screenshot of the registration screen + the exact fields it offered (this doubles as
the per-customer registration runbook for production later).

## 3. Probe the grant (the #254 A3 residual, answered in one run)

From `backend-ts/` in PowerShell:

```powershell
$env:WORKWELL_WEBCHART_BASE_URL='https://teatea.webchartnow.com/webchart.cgi'
$env:WORKWELL_WEBCHART_CLIENT_ID='workwell-backend'
$env:WORKWELL_WEBCHART_PRIVATE_KEY=Get-Content -Raw ~\.workwell\webchart-teatea.key
$env:WORKWELL_WEBCHART_SCOPE='system/*.read'
$env:WORKWELL_WEBCHART_KID='workwell-2026-07'
pnpm webchart:probe-auth
```

The probe (`scripts/webchart-auth-probe.ts`) reuses the production auth code path unchanged and
never prints key/assertion/token material. Three steps: discovery → the RS384 `private_key_jwt`
`client_credentials` grant → a `GET /fhir/Patient?_count=1` with the granted token.

- **GRANT SUCCEEDED** → record in the #254 log: granted scope, `expires_in` (token lifetime), and
  that client_credentials works despite the advertised grant list.
- **GRANT FAILED (unsupported_grant_type)** → client_credentials is genuinely off. Record the
  exact error; the sharpened MIE ask becomes *"enable backend services (client_credentials) for
  the registered client `workwell-backend` on teatea"*. Do **not** build an authorization_code
  flow — wrong tool for system-to-system; the HAPI simulator (ADR-032) carries the live-HTTP proof
  meanwhile.
- **invalid_client / invalid_scope** → the probe prints a targeted hint (registration/JWKS
  mismatch vs scope form); adjust and re-run.

### MIE ask (send this — §2 is MIE-gated, see the finding box up top)

Because self-registration is blocked (superuser is MIE-controlled; RFC 7591 off), send MIE this
request. It resolves the §254 A3 residual either way (they register us, or they grant superuser +
the FHIR App Editor so we self-serve):

> I am the verified System Owner of the WebChartNow trial `https://teatea.webchartnow.com/`. My
> account has the SuperUser security role and the Manage Login Trusts permission, but both
> client-registration routes return "Super user access required" (`?f=admin&s=jwt` and
> `?f=admin&subfunc=login_trusts`). Please either **(1)** grant my System Owner account SMART/FHIR
> app-registration access — the MIE-issued Super User unlock password + the FHIR App Editor — or
> **(2)** register this SMART **Backend Services** client for me:
> - Client name: `WorkWell Measure Studio` · preferred client id: `workwell-backend`
> - Grant type: `client_credentials` · token-endpoint auth: `private_key_jwt` · alg: **RS384**
> - JWKS URL: *(I will host the public JWKS at an HTTPS URL — the `webchart-teatea.pub.jwk.json` from §1)*
> - Redirect/launch URI: **none** (backend service, no browser flow)
> - Scopes: `system/*.read` (and `patient/*.rs` if supported for a backend context)
>
> Please confirm the assigned `client_id`, the pre-authorized scopes, that the token endpoint accepts
> `client_credentials` + RS384 `private_key_jwt`, and whether smart-configuration will advertise
> `client_credentials`. I will never share the private key — only the public JWKS URL.

(I keep the private key in `~\.workwell\`; MIE only ever needs the **public** JWKS.)

## 4. Seed the synthetic population (~30 patients)

FHIR on teatea is read-scoped, so data enters through WebChart's own import tooling / UI.

Generate the import files from WorkWell's synthetic corpus (real LOINC/CVX/CPT codes spread over
realistic dates so every outcome bucket appears):

```powershell
cd backend-ts
pnpm generate:webchart-import --patients 30 --out ..\webchart-import
```

> **✓ Live-verified 2026-07-16 (Data Import → "Validate File" dry-run on teatea).** The first validation
> pass taught us the instance's exact Chart Data contract and the generator was corrected accordingly:
> - **`patients.zip_code` is REQUIRED** and validated `12345`/`12345-6789` on **every** row — omitting it
>   fails both the header ("does not match full list") and every data row. The generator now emits a
>   synthetic demo ZIP (`46514`). *This was the whole cause of the first run's 451 validation issues.*
> - `@patient_mrns.MR` is correct — **`MR` is a real partition** on teatea (confirmed in the partition
>   list) — and `patients.first_name/last_name/birth_date/sex/email` all validated.
> - The instance's own **Sample** (Data Import → Sample → `Sample_Chart_Data.csv`) is the authoritative
>   header if a column is ever rejected; open it and match names.
>
> Always **Validate File** (non-destructive) before **Upload File** — it returns a per-row issue log and a
> "Download Failed Test Data File" button. The Data Import modal is heavy; if it fails to open, reload the
> page and reselect the row.

This emits MIE's documented Data-Migration CSV formats (verified against the `mieweb/docs` repo
sources, 2026-07-16 — the rendered docs live under
`docs.enterprisehealth.com/functions/system-administration/data-migration/`):

| File | Format | Doc page |
|---|---|---|
| `01-patients.csv` | Chart Data CSV API (`patients.*` + `@patient_mrns.MR` headers; MRN creates the chart) | `chart-data-csv-api/` |
| `02-encounters.csv` | Clinical Encounter CSV API (office visits — the eCQM qualifying-visit gate) | `clinical-encounter-csv-api/` |
| `03-observations.csv` | Observation Import (18 fixed columns, dates `YYYYMMDD`, keyed on observation **name**) | `observation-import/` |
| `04-injections.csv` | Injections CSV API (CVX in `injections.inject_code`, SQL dates) | `injections-csv-api/` |
| `checklist.md` | manual-entry fallback + the **mammograms** (no procedure CSV exists — enter as completed CPT 77067 orders) | — |
| `README.md` | upload order, caveats, verification steps | — |

**Upload procedure** (documented in `data-import-standards/`):

1. Ensure your role has **"Allow .csv data import" = YES** (Security Role Settings) — it exposes
   the **Data Import** tab.
2. **Menu → Control Panel → Data Import tab** → pick the import type from the drop-down → **Go**.
3. Interface name: **`WC_DATA_IMPORT`** (the Chart Data default). Tick **Verbose** on first runs.
4. Upload in the numbered order (patients → encounters → observations → injections). **Test with
   2–3 rows first** (MIE's own best practice); a "Download Failed Test Data File" button returns
   only the rejected rows for fixing.
5. Mammograms: manual, per `checklist.md` (completed screening-mammography order, CPT 77067).

**One clinical must-do:** the HbA1c-bearing profiles need a **manual problem-list diabetes
diagnosis, SNOMED CT 44054006** (per `checklist.md`) — cms122's IPP gates on a diabetes Condition,
the enrollment roster deliberately never stamps one, and its value-set expansion is SNOMED-only, so
the encounter CSV's ICD diagnosis field cannot satisfy it. Skipping this makes every patient read
out-of-IPP (MISSING_DATA) for cms122.

**Three format caveats to verify on the first small upload** (all flagged in the generated README):
the exact `patients.sex` header string; `part:MR` as the `pat_id_type` for encounters/injections
(documented `part:` prefix, not byte-verified — fallback `id:ext_id`); and — most important —
**Observation Import keys on observation NAME, not LOINC**, so after uploading spot-check one
patient via `GET /webchart.cgi/fhir/Observation?patient={id}` and confirm each observation carries
its intended LOINC coding (recorded in each CSV row's Comment column). If a name resolved without
LOINC, map it in **Control Panel → Observation Codes** and re-check — without the LOINC, WorkWell's
crosswalk can't reconcile the observation and the subject reads MISSING_DATA.

(Also worth one click first: the welcome screen's **"Sample patient demo — TRY IT"** card — it is
not publicly documented; if it seeds usable demo charts, note what it created. An HL7 route —
ADT/VXU/ORU messages — also exists as an alternative to CSV if the Data Import tab is unavailable
on the trial.)

If a given import tool is missing/broken on the trial, fall back to **manual entry of ~10
patients** using the generated per-patient checklist:

```powershell
pnpm generate:webchart-import --patients 10 --format checklist --out ..\webchart-import
```

Each checklist entry lists exactly what to enter in the chart (labs with LOINC + value + date,
immunizations with CVX + date, a visit, a mammogram) so the cohort still covers every
measure-relevant property.

**Verify from outside** (no auth needed for `_summary=count` on this trial? — if 401, use the
probe's token step):

```powershell
curl "https://teatea.webchartnow.com/webchart.cgi/fhir/Patient?_summary=count"
```

**Record:** which import path worked (tool + format), patient count, anything the importer
rejected.

## 5. Live evaluation — WorkWell reads real WebChart data

With the step-3 env still set, from `backend-ts/`:

```powershell
# 1) population + roster template (table on the console, JSON template into the file)
pnpm evaluate:webchart-live --list-patients > ..\teatea-roster.json
# 2) prune/adjust measure enrollment per subject (the template pre-fills the default measures)
# 3) evaluate
pnpm evaluate:webchart-live --roster ..\teatea-roster.json
```

Expected: a per-measure outcome table computed from **live teatea data** — non-MISSING_DATA
outcomes for every subject whose chart carries the seeded labs/immunizations.

**Record in the #254 log:** observed pagination behavior (page size the server chose, `link[next]`
shape) → **A2**; how Observations come back (coded? value+unit? text?) → **A5**; any rate-limit
signals (429s) → **A4**.

## 6. What "done" looks like

- [ ] Client registered; screenshot of the registration screen archived
- [ ] `pnpm webchart:probe-auth` → all three steps green (or the exact failure recorded + MIE ask sharpened)
- [ ] ~30 synthetic patients live on teatea with measure-relevant clinical data
- [ ] `pnpm evaluate:webchart-live` prints real outcomes from teatea
- [ ] #254 answer log updated (A2/A3/A4/A5 observations), JOURNAL entry added
- [ ] Keys stay in `~\.workwell\` — never committed, never pasted into issues/PRs
