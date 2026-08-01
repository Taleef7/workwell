# Cypress CVU+ first-run rehearsal — 2026-08-01

This is the M-B exit-gate checkpoint for WorkWell's official-routed CMS122 and CMS125 QRDA exports.
It records what was measured. No CVU+ validation result exists yet.

## 1. CVU+ paths and scope

Cypress CVU+ is the open-source Cypress validation application used for QRDA and certification-era
quality-measure checks. The running v7.5.1 source exposes two materially different kinds of work:

- The external-document route lists validators at `GET /qrda_validation` and accepts a multipart file at
  `POST /qrda_validation/:year/:qrda_type/:organization`. The form field is `file`; `qrda_type` is
  `qrdaI` or `qrdaIII`; and `organization` selects the HL7 or CMS Schematron family. This path parses
  CDA and reports structural/Schematron findings for a supplied document.
- The full Calculation Check path uses Cypress Product/ProductTest expected results and Cypress's own
  synthetic patient bundles. It is not the external-document upload path.

WorkWell's synthetic corpus with real terminology is appropriate for the external-document path. It
does not contain Cypress Product/ProductTest patient fixtures, so a structural upload response must not
be reported as a full Calculation Check result.

## 2. Docker stand-up measured in the prior stand-up

The prior stand-up cloned Cypress v7.5.1 at source commit
`d3459f0e82290d87b8e6405a2e00f0e52b001e3e` and booted the application successfully. The application image
was built as `workwell/cypress-round1:v7.5.1` with digest
`sha256:df920e01133ae2f2b22d70dc1e3694d5127257fcf1dc3b486f1194adf40906ac`.

The measured stack was Ruby 3.4.9 / Rails 8.1 / MongoDB 8.0.9 /
`mitrehealthdocker/cqm-execution-service:latest`. Puma listened on port 3000 and the CQM execution
service listened on port 8082 inside the compose network. The exact stand-up record is
`cvu-workdir/ROUND1_NOTES.md`; the committed reference files are under `scripts/cvu/`.

The externally supplied-document route is:

```text
GET  /qrda_validation
POST /qrda_validation/:year/:qrda_type/:organization
```

The POST is multipart with field `file`; `qrda_type` is `qrdaI` or `qrdaIII`; and the organization
selects the HL7 or CMS validator family. The route requires a local Cypress user. The measured
unauthenticated JSON request returned HTTP 401:

```json
{"error":"You need to sign in or sign up before continuing."}
```

No CMS account requirement was found. On this Windows machine Docker was reachable during the prior
stand-up only through `tcp://127.0.0.1:2375` with a scratch Docker config; that is a local workaround,
not a repository requirement.

## 3. WorkWell document generation in this pass

The new `scripts/cvu/generate-qrda-fixtures.ts` uses `directSyntheticGenerator()`, the five ADR-038
targets, `officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) })`,
`officialMeasurementPeriod`, `buildQrda1Document`, and `buildQrda3Document`. It was exercised through
`tsx` without a server or Docker:

```powershell
corepack pnpm --dir backend-ts exec tsx ../scripts/cvu/generate-qrda-fixtures.ts
```

The dedicated worktree had no installed `node_modules`, so the direct command first reported
`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` and `tsx is not recognized as an internal or external command.`
The required `corepack pnpm typecheck` attempt likewise stopped before TypeScript with
`tsc is not recognized as an internal or external command.`
The script was then run through an existing `tsx` installation, and it completed its bounded sweep.
The generated scratch manifest is `cvu-workdir/documents/manifest.json`.

Measured result:

- 10 subject evaluations were attempted: five for CMS122 and five for CMS125.
- 0 QRDA Category I files were produced.
- 0 QRDA Category III files were produced.
- The manifest contains 12 failures: five subject failures plus one QRDA III skip for each measure.
- No outcome status or official initial-population membership was recorded because official evaluation
  refused before returning a `MeasureOutcome`.

The first CMS122 subject failure was:

```text
cms122: 26 of 26 value sets could not be expanded (...). Official execution would report every subject out-of-population. Regenerate this measure's terminology with 'pnpm vendor:official' before routing cms122 officially — official execution uses the artifact's own expansions, NOT the 'pnpm resolve-valuesets' VSAC import.
```

CMS125 produced the corresponding refusal for `32 of 32 value sets`. Both measures have their
committed terminology pins, but the gitignored `terminology.json` sidecars were absent in this
worktree. The script therefore skipped each QRDA-I build and correctly withheld each QRDA-III aggregate
because 0/5 subject outcomes were available. This pass produced no document excerpt or well-formedness
finding because no QRDA XML file was written.

## 4. Current M-B state

Docker is unavailable on this machine now. The required live check was:

```text
docker ps
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.
```

No WorkWell document was submitted to CVU+. Consequently, there is no CVU+ validation result: no
pass/fail status, rule id, message set, location set, or error count exists for this pass. The M-B
rehearsal is blocked at two separate stages: official terminology sidecars prevented WorkWell QRDA
fixture generation, and Docker being down prevents the later upload stage even if documents are made
available. The Cypress stand-up itself remains measured as successful from the prior stand-up; it was
not restarted or rebuilt here.

## 5. Next attempt

First make the pinned official terminology sidecars available through the repository's approved
official-vendoring process, then rerun:

```powershell
corepack pnpm --dir backend-ts exec tsx ../scripts/cvu/generate-qrda-fixtures.ts
```

Once the manifest contains the generated XML files, Docker must be available and the local Cypress
stack must be started from the reference in `scripts/cvu/README.md`. Create a local Cypress user at
`/users/sign_up`, sign in, and retain the session cookie locally. Use `GET /qrda_validation` to select
the version-specific validator path, then submit each document as multipart `file` to
`POST /qrda_validation/:year/:qrda_type/:organization`. Capture the HTTP response and its
`execution_errors` fields verbatim. Only that captured response can establish the first CVU+ structural
validation result; the separate Calculation Check path remains out of scope for these externally
supplied WorkWell documents.
