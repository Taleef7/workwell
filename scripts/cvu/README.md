# Cypress CVU+ QRDA rehearsal

This directory contains a reproducible, reference-only path for measuring WorkWell QRDA Category I and
Category III documents with Cypress CVU+ 7.5.1. It is not wired into CI. Docker, Ruby, MongoDB, and the
Cypress source remain external to the WorkWell application.

The measured stand-up facts below are taken directly from `cvu-workdir/ROUND1_NOTES.md`, which is the
round-1 scratch record and is intentionally not committed.

## What is being measured

Cypress has two separate paths:

- The externally supplied-document path lists validators at `GET /qrda_validation` and accepts a
  multipart upload at `POST /qrda_validation/:year/:qrda_type/:organization`. **Both routes must be asked
  for XML or JSON explicitly** — `QrdaUploadsController` declares `respond_to :xml, :json` and ships no
  HTML template, so a request that negotiates neither (curl's default `Accept: */*`) fails: the GET
  returns **HTTP 500** (`ActionView::MissingTemplate (Missing template qrda_uploads/index...)`, which
  reads like a broken stand-up rather than a wrong Accept type) and the POST returns **HTTP 422**. Either
  an `Accept: application/json` header **or** a `.json` path suffix works — measured 2026-08-02 at 200/201
  for both forms; see `docs/evidence/CVU_VALIDATION_RUN_2026-08-02.md` §4. The commands below send the
  header and append the suffix, so neither is load-bearing alone. The form field is `file`;
  `qrda_type` is `qrdaI` or `qrdaIII`; and `organization` selects the `hl7` or `cms` validator family.
  The application runs CDA plus the selected HL7 or CMS Schematron validators and returns execution
  errors and warnings.
- The full Calculation Check path compares Cypress Product/ProductTest expected results with Cypress's
  own synthetic patients. It is a different path and does not turn an externally supplied WorkWell
  document into a Calculation Check case.

WorkWell's synthetic corpus is intended for the first path. It supplies official CMS122 and CMS125
clinical data and official measure evidence, but it does not supply Cypress Product/ProductTest fixtures.
Do not report an upload/Schematron response as a Calculation Check result.

## Generate the WorkWell fixtures

The generator uses the existing official measure artifacts and the ADR-038 five-target corpus. It does
not start a server and does not use Docker:

```powershell
corepack pnpm --dir backend-ts install --frozen-lockfile
corepack pnpm --dir backend-ts exec tsx ../scripts/cvu/generate-qrda-fixtures.ts
```

An optional argument selects the output directory. The default is `cvu-workdir/documents/`. The script
writes one QRDA-I per successful subject, a QRDA-III only when all five subject outcomes for that
measure are available, and `manifest.json`. It clears the resolved output directory before each run, so
a blocked rerun cannot leave stale XML beside a zero-document manifest. Subject failures are logged and
recorded in the manifest.

For each document, the manifest records `clinicalDocumentRootParses`, which is true only when the
existing CDA reader returns a root whose local name is `ClinicalDocument`. It also records
`nestingAndEscapingFinding`, a narrower scanner for unbalanced or mismatched tags and unescaped `&` in
text or attributes. That scanner does not validate all XML well-formedness cases: it does not catch
malformed content after the last closing tag, unquoted attribute values, or a bare `>` inside a quoted
attribute value. Neither field is a CVU+ validation result or a compliance decision.

Official execution needs each measure's gitignored `terminology.json` sidecar to match its committed
manifest pin. If the executor reports that value sets could not be expanded, **check where you are
running before you regenerate anything**: the sidecars are gitignored (ADR-036), so they do not exist in
a fresh git worktree even though they are present in the primary working tree. Run this generator from
the primary tree. That is what the 2026-08-01 pass hit, and re-vendoring was the wrong remedy — an
UNCREDENTIALED `pnpm vendor:official` reverts ADR-041's completed expansions back to capped, which makes
cms122/cms125 unroutable and fails the reproducibility gate. Only if the sidecars are genuinely absent
from the primary tree should you regenerate, with the credential.

## Reproduce the Cypress v7.5.1 stand-up

Round 1 measured the following versions and artifact:

- Cypress tag `v7.5.1`, source commit `d3459f0e82290d87b8e6405a2e00f0e52b001e3e`.
- Application image `workwell/cypress-round1:v7.5.1`, digest
  `sha256:df920e01133ae2f2b22d70dc1e3694d5127257fcf1dc3b486f1194adf40906ac`.
- Stack: Ruby 3.4.9, Rails 8.1, MongoDB 8.0.9, and
  `mitrehealthdocker/cqm-execution-service:latest`. That service has no known pinned alternative tag
  in this record, so it remains unpinned as a known reproducibility limitation.
- Puma listened on `http://127.0.0.1:3000`; the CQM execution service listened on port 8082 inside
  the compose network.

The direct host clone and the first image build had network and Docker credential-helper failures. The
successful clone/build path used Docker and the scratch config already described in
`cvu-workdir/ROUND1_NOTES.md`:

```powershell
New-Item -ItemType Directory -Force cvu-workdir/docker-config | Out-Null
'{"auths":{}}' | Set-Content cvu-workdir/docker-config/config.json

$DockerHost = 'tcp://127.0.0.1:2375'
$DockerConfig = 'cvu-workdir/docker-config'
$Scratch = (Resolve-Path cvu-workdir).Path

docker --config $DockerConfig -H $DockerHost build `
  -f scripts/cvu/clone.Dockerfile -t workwell/cvu-git:round1 cvu-workdir
docker --config $DockerConfig -H $DockerHost run --rm `
  -v "${Scratch}:/out" workwell/cvu-git:round1 `
  git clone --branch v7.5.1 --depth 1 --single-branch `
  https://github.com/projectcypress/cypress.git /out/cypress

$ExpectedCypressCommit = 'd3459f0e82290d87b8e6405a2e00f0e52b001e3e'
$ActualCypressCommit = (docker --config $DockerConfig -H $DockerHost run --rm `
  -v "${Scratch}:/out" workwell/cvu-git:round1 `
  git -C /out/cypress rev-parse HEAD).Trim()
if ($ActualCypressCommit -ne $ExpectedCypressCommit) {
  throw "Cypress v7.5.1 clone commit mismatch: expected $ExpectedCypressCommit, got $ActualCypressCommit"
}

docker --config $DockerConfig -H $DockerHost build `
  -f cvu-workdir/cypress/Dockerfile -t workwell/cypress-round1:v7.5.1 cvu-workdir/cypress
```

The local image tag is mutable by construction. After rebuilding, inspect the resulting image digest and
compare it with the recorded value before treating the stand-up as reproduced:

```powershell
$RecordedCypressImageDigest = 'sha256:df920e01133ae2f2b22d70dc1e3694d5127257fcf1dc3b486f1194adf40906ac'
$RebuiltCypressImageDigest = (docker --config $DockerConfig -H $DockerHost image inspect `
  --format '{{.Id}}' workwell/cypress-round1:v7.5.1).Trim()
if ($RebuiltCypressImageDigest -ne $RecordedCypressImageDigest) {
  Write-Warning "Cypress image digest mismatch: recorded $RecordedCypressImageDigest, rebuilt $RebuiltCypressImageDigest"
}
```

The recorded digest is the pin for the measured build; a mismatch is a changed build, not an assumed
reproduction. If the local Docker version reports the digest through the build output or a different
inspect field, capture that reported digest and compare it to the same recorded value.

The `tcp://127.0.0.1:2375` transport and scratch Docker config are local Windows workarounds for the
machine measured in `ROUND1_NOTES.md`. Other machines may use the normal Docker named pipe. Do not
hard-code the TCP transport as a repository requirement, and do not put credentials in the scratch
config.

Before concluding that Docker is unreachable on a machine with this history, check both the default
named pipe and the TCP endpoint used by the measured stand-up. Round 1 showed that the default pipe can
be down while the TCP endpoint still works:

```powershell
docker ps
docker --config cvu-workdir/docker-config -H tcp://127.0.0.1:2375 ps
```

Use whichever probe succeeds for the remaining Docker commands. If both probes fail, record both
failures before treating Docker as unavailable.

Set a local-only random secret for the reference compose file, then start the three services:

```powershell
$env:CYPRESS_SECRET_KEY_BASE = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
docker --config $DockerConfig -H $DockerHost compose `
  -f scripts/cvu/round1.compose.yml up -d
docker --config $DockerConfig -H $DockerHost compose `
  -f scripts/cvu/round1.compose.yml ps
```

`depends_on` only orders container startup; it does not wait for the Rails application to be ready. Poll
the sign-in page before signup or upload requests, and fail after a bounded number of attempts:

```powershell
$Base = 'http://127.0.0.1:3000'
$Ready = $false
for ($Attempt = 1; $Attempt -le 30; $Attempt++) {
  $Status = curl.exe --silent --show-error --output NUL --write-out '%{http_code}' `
    "$Base/users/sign_in" 2>$null
  if ($LASTEXITCODE -eq 0 -and $Status -match '^[1-5][0-9]{2}$') {
    $Ready = $true
    Write-Host "Cypress returned HTTP $Status on readiness attempt $Attempt"
    break
  }
  Start-Sleep -Seconds 2
}
if (-not $Ready) {
  throw 'Cypress did not return an HTTP response from /users/sign_in after 30 attempts.'
}
```

The committed `clone.Dockerfile` and `round1.compose.yml` are references for this external stand-up;
they are not CI inputs.

## Create a local Cypress user

No CMS account is needed for the upload validator, but the local Cypress application requires a local
user. Open `http://127.0.0.1:3000/users/sign_up`, enter a synthetic local email, an eight-character
password satisfying the displayed complexity rule, the confirmation, and accept the terms. The tested
development settings auto-approve and auto-confirm the local registration. Keep the email and password
outside the repository.

The unauthenticated JSON request measured in `ROUND1_NOTES.md` returned HTTP 401 with:

```json
{"error":"You need to sign in or sign up before continuing."}
```

After creating the user, use curl to fetch the sign-in form and submit the login so curl itself writes
`cvu-workdir/cypress.cookies` in the Netscape cookie-jar format that `curl.exe -b` reads. The checked-in
v7.5.1 source confirms the Devise form posts to `/users/sign_in` with `user[email]` and
`user[password]`; the exact live response and redirect remain unverified in this round because Docker is
down.

```powershell
$CookieJar = 'cvu-workdir/cypress.cookies'
$SignInHtml = (curl.exe --fail --silent --show-error -c $CookieJar `
  "$Base/users/sign_in" | Out-String)
if ($SignInHtml -notmatch '<input[^>]*name=["'']authenticity_token["''][^>]*value=["'']([^"'']+)["'']') {
  throw 'Could not find the Rails authenticity_token in the sign-in form.'
}
$AuthenticityToken = $Matches[1]

$CypressEmail = Read-Host 'Cypress local email'
$CypressPasswordSecure = Read-Host 'Cypress local password' -AsSecureString
$CypressPassword = [System.Net.NetworkCredential]::new('', $CypressPasswordSecure).Password

curl.exe --fail --silent --show-error --include `
  -b $CookieJar -c $CookieJar `
  --data-urlencode "user[email]=$CypressEmail" `
  --data-urlencode "user[password]=$CypressPassword" `
  --data-urlencode "authenticity_token=$AuthenticityToken" `
  "$Base/users/sign_in"
```

The first `-c` creates the file and the second request updates that same file with the session cookie.
Keep the jar and credentials outside version control; do not hand-copy a browser cookie or print the
password. The field names and endpoint above are source-confirmed, but a successful authenticated request
was not tested in this pass.

## Submit a document and read the response

First list the available validator paths. The route's `year` is the reporting year exposed by the
running Cypress version; choose the exact path returned by this request rather than assuming it:

```powershell
$Base = 'http://127.0.0.1:3000'
curl.exe -i -b cvu-workdir/cypress.cookies `
  -H 'Accept: application/json' "$Base/qrda_validation.json"
```

The `Accept` header alone is sufficient (measured HTTP 200); the `.json` suffix is belt-and-braces so the
command does not silently depend on the header surviving a copy-paste into a client that rewrites it.

For a listed HL7 Category I validator, submit a generated document as multipart form field `file`:

```powershell
$Document = (Resolve-Path cvu-workdir/documents/cms122-compliant-qrda1.xml).Path
curl.exe -i -b cvu-workdir/cypress.cookies `
  -H 'Accept: application/json' `
  -F "file=@$Document" `
  "$Base/qrda_validation/<year>/qrdaI/hl7.json"
```

Use `cms` instead of `hl7` for a listed CMS Category I validator. For Category III, use
`qrdaIII` in the same position. In v7.5.1's checked-in `possible_qrda_uploaders` helper, the CMS
Category III listing uses an `hl7` path segment; use the path returned by `GET /qrda_validation.json` and
record that selected path with the response.

The JSON response has the validator path and an `execution_errors` collection. Each error contains the
file name, validator, and message; preserve those fields and the HTTP status as the measurement. A
successful HTTP response is not by itself a pass claim: report the returned error and warning counts,
rule identifiers, locations, and messages. The upload route is structural/CDA/Schematron validation;
it is not the separate Product/ProductTest Calculation Check.

## The Calculation Check (C2) comparison

This is the second of the two paths above — the Product/ProductTest one — run **offline against the
downloaded archive** rather than through a Cypress upload. It measures what `ExpectedResultsValidator`
grades (our population counts against Cypress's precalculated ones) without first needing a run-finalize
route or a QRDA III submission. Results and the full method are in
`docs/evidence/CVU_CALCULATION_CHECK_SPIKE_2026-08-02.md` Part 3.

### Prerequisite: a measure bundle, which is NLM-gated

Cypress cannot create a Product without one, and `cypressdemo.healthit.gov/measure_bundles/bundle-<year>.zip`
returns 401 unauthenticated. It is licensed NLM content in its entirety, so it must be downloaded **on the
machine running Cypress, by the owner, with the owner's UMLS/NLM key** — routing it through a CI artifact
would be redistribution. Import it through the admin Bundles page (`BundleUploadJob`); there is no import
rake task. `bundle-2025.zip` is ~28 MB and imports as 70 measures / 714 patients.

Its measurement period is **CY2024** even though it self-describes as the 2026 performance period. Read
`measure_period_start` / `effective_date` off the bundle rather than assuming a year.

### Build the oracle (Cypress side)

The four Ruby scripts in `c2/` run inside the Cypress container with
`bundle exec rails runner /tmp/<script>.rb`:

| script | what it does |
|---|---|
| `rebuild.rb` | tears the Product down **including its `CQM::IndividualResult`s**, recreates it, and waits for `ProductTestSetupJob` |
| `snapshot.rb` | the full oracle: patients, results, archive composition, expected populations, measurement period |
| `per-patient.rb` | per-patient expected populations, keyed by MBI, for a subject-level comparison — **run it against the same rebuild the archive came from**, because Cypress regenerates the MBI on every setup run (measured: joining pass A's documents to pass B's rows matched 4 of 64) |
| `copy-archives.rb` | copies each test's `patient_archive` to `/tmp` for `docker cp` |

Three setup traps, each of which fails silently — all three are handled by `rebuild.rb`, and the third is
why teardown deletes results explicitly:

1. Pre-setting `measure_ids` on the Product creates **zero** tests (`add_measure_tests` builds one per
   `new_ids - old_ids`), and the Product still saves reporting `tests=0`.
2. `/app/public/data` is root-owned while the app runs as uid 1001, so `archive_patients` fails **after**
   generating and evaluating patients — the test shows `errored` while the job log says `COMPLETED`.
3. Re-running `ProductTestSetupJob` deletes Patients but **not** `IndividualResult`s, and
   `ExpectedResultsCalculator` aggregates every result carrying the test's `correlation_id`. One re-run
   doubles every expected population. Used as an oracle, that makes a correct engine look ~50% wrong.

**Run setup exactly once.** `MeasureTest`'s `after_create` already enqueues the job, so calling
`perform_now` as well runs it twice.

What is stable across rebuilds: patients, `IndividualResult` count, expected populations, supplemental
data. What is **not**, by design: the archive document count. `archive_patients` splits one patient across
two documents and appends `rand(1..3)` augmented duplicates from a fresh per-test `rand_seed`.

### Run the comparison (WorkWell side)

```powershell
corepack pnpm --dir backend-ts exec tsx ../scripts/cvu/c2-calculation-check.ts `
  --docs ../cvu-workdir/c2/passB/CMS122v14 --measure cms122 `
  --expected ../cvu-workdir/c2/passB/snapshot.json --expected-key CMS122v14 `
  --per-patient ../cvu-workdir/c2/passB/per-patient.json --per-patient-key CMS122v14 `
  --period-start 2024-01-01 --period-end 2024-12-31 --also-rolling
```

Paths are resolved from `backend-ts/`, so prefix repository paths with `../`. `--period-start/--period-end`
are required on purpose: the runtime's `officialMeasurementPeriod` is a ROLLING window (ADR-039) and
Cypress's expected results are computed over the bundle's own calendar period. `--also-rolling` re-runs the
same subjects on the rolling window and reports how many subjects move, so the difference is measured
rather than assumed (measured 2026-08-03: zero).

**Documents are not people.** The harness resolves identity by Medicare Beneficiary Identifier
(`2.16.840.1.113883.4.927`), which survives both archive transforms, falling back to name+birth for the
patients Cypress ships without one — and merges each person's documents into one bundle. Comparing
document counts to expected patient counts fails C2 on arithmetic before any logic is involved. Nothing in
the product path does this today.

### Proving a cause instead of correlating one

`--inject <file.json>` adds FHIR resources to one named subject and prints its populations before and
after, which turns "the datatype we drop is why the exclusion is missed" into an experiment. The file is
`{ "subjectLabel": "...", "resources": [ ... ] }`; `scripts/cvu/c2/inject-assessment.json` and
`inject-mastectomy.json` are the two used in Part 3 of the evidence. Each is n=1 subject: it establishes
the mechanism, not that the mechanism explains every differing subject.

### What the harness checks about ITSELF

A wrong harness reports a plausible number rather than an error, so three self-checks are in the report
rather than in a reviewer's head: the **people resolved** are compared against the oracle's own patient
count (the direct detector for an over-merge, an under-merge, or a person lost to an import failure); the
**per-patient rows** are summed against the aggregate (which is exactly what setup contamination breaks);
and every **demographic disagreement inside a merged person** is listed. That last one is reported and not
resolved on purpose: which document's Patient wins is arbitrary, both artifacts gate the initial population
on `AgeInYearsAt(...)`, and Cypress randomises the duplicate's birthdate about 1 time in 21 — so a silent
pick can print MATCH while discarding a birthdate that would have changed the answer.

This is still not a Calculation Check RESULT: `ExpectedResultsValidator` has never graded a document we
produced. Do not report the harness output as a Cypress pass.
