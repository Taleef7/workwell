# Cypress CVU+ QRDA rehearsal

This directory contains a reproducible, reference-only path for measuring WorkWell QRDA Category I and
Category III documents with Cypress CVU+ 7.5.1. It is not wired into CI. Docker, Ruby, MongoDB, and the
Cypress source remain external to the WorkWell application.

The measured stand-up facts below are taken directly from `cvu-workdir/ROUND1_NOTES.md`, which is the
round-1 scratch record and is intentionally not committed.

## What is being measured

Cypress has two separate paths:

- The externally supplied-document path lists validators at `GET /qrda_validation` and accepts a
  multipart upload at `POST /qrda_validation/:year/:qrda_type/:organization`. The form field is `file`;
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
measure are available, and `manifest.json`. Subject failures are logged and recorded in the manifest.

Official execution needs each measure's gitignored `terminology.json` sidecar to match its committed
manifest pin. If the executor reports that value sets could not be expanded, restore or regenerate the
sidecars with the repository's approved official-vendoring process before treating the generator as
blocked by document code.

## Reproduce the Cypress v7.5.1 stand-up

Round 1 measured the following versions and artifact:

- Cypress tag `v7.5.1`, source commit `d3459f0e82290d87b8e6405a2e00f0e52b001e3e`.
- Application image `workwell/cypress-round1:v7.5.1`, digest
  `sha256:df920e01133ae2f2b22d70dc1e3694d5127257fcf1dc3b486f1194adf40906ac`.
- Stack: Ruby 3.4.9, Rails 8.1, MongoDB 8.0.9, and
  `mitrehealthdocker/cqm-execution-service:latest`.
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
docker --config $DockerConfig -H $DockerHost build `
  -f cvu-workdir/cypress/Dockerfile -t workwell/cypress-round1:v7.5.1 cvu-workdir/cypress
```

The `tcp://127.0.0.1:2375` transport and scratch Docker config are local Windows workarounds for the
machine measured in `ROUND1_NOTES.md`. Other machines may use the normal Docker named pipe. Do not
hard-code the TCP transport as a repository requirement, and do not put credentials in the scratch
config.

Set a local-only random secret for the reference compose file, then start the three services:

```powershell
$env:CYPRESS_SECRET_KEY_BASE = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
docker --config $DockerConfig -H $DockerHost compose `
  -f scripts/cvu/round1.compose.yml up -d
docker --config $DockerConfig -H $DockerHost compose `
  -f scripts/cvu/round1.compose.yml ps
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

Sign in through the local application and use the resulting session cookie for the upload request. A
browser-exported cookie is sufficient; do not put the cookie or credentials in a committed file.

## Submit a document and read the response

First list the available validator paths. The route's `year` is the reporting year exposed by the
running Cypress version; choose the exact path returned by this request rather than assuming it:

```powershell
$Base = 'http://127.0.0.1:3000'
curl.exe -i -b cvu-workdir/cypress.cookies `
  -H 'Accept: application/json' "$Base/qrda_validation"
```

For a listed HL7 Category I validator, submit a generated document as multipart form field `file`:

```powershell
$Document = (Resolve-Path cvu-workdir/documents/cms122-compliant-qrda1.xml).Path
curl.exe -i -b cvu-workdir/cypress.cookies `
  -H 'Accept: application/json' `
  -F "file=@$Document" `
  "$Base/qrda_validation/<year>/qrdaI/hl7"
```

Use `cms` instead of `hl7` for a listed CMS Category I validator. For Category III, use
`qrdaIII` in the same position. In v7.5.1's checked-in `possible_qrda_uploaders` helper, the CMS
Category III listing uses an `hl7` path segment; use the path returned by `GET /qrda_validation` and
record that selected path with the response.

The JSON response has the validator path and an `execution_errors` collection. Each error contains the
file name, validator, and message; preserve those fields and the HTTP status as the measurement. A
successful HTTP response is not by itself a pass claim: report the returned error and warning counts,
rule identifiers, locations, and messages. The upload route is structural/CDA/Schematron validation;
it is not the separate Product/ProductTest Calculation Check.
