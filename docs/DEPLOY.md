# Deployment Guide

**Stack:** MIE Create-a-Container (frontend + backend) + Neon (Postgres) + OpenAI API.
**Status:** Current deployment reference for the merged WorkWell Measure Studio stack.
**Cost target:** keep the live stack under about $25/month.

> The MIE TWH stack below is the **live primary deployment**. The Maui sandbox is documented below.
> The earlier Vercel + Fly.io
> public-preview stack is **decommissioned** — its setup is retained only as
> [Appendix A](#appendix-a--decommissioned-vercel--flyio-stack-historical-reference) for historical reference.

---

## MIE Create-a-Container Deployment (sole live stack)

The deployment runs on MIE's internal container platform (`os.mieweb.org`).
**The live primary instance is TWH** — Total Worker Health. Encompasses all OSHA safety + eCQM wellness measures.

| Service | Hostname | Image |
|---------|----------|-------|
| Frontend | `twh.os.mieweb.org` | `ghcr.io/taleef7/workwell-twh-frontend` |
| Backend API | `twh-api-ts.os.mieweb.org` | `ghcr.io/taleef7/workwell-api-ts` — the de-Java TypeScript backend (`backend-ts/`), the sole backend |

> **#109 — JVM retired (PR4):** the frontend is served by the **TypeScript** backend (`twh-api-ts`);
> the Java backend (`twh-api`) has been retired (`backend/` deleted). The TS backend runs the `local`
> mieweb target (`MIEWEB_TARGET=local` — in-process bindings, no
> companion services, internal port **8080**) and overrides the DB to Neon via `DATABASE_URL` (the
> store factory then uses the Pg ceiling, isolated to the `workwell_spike` schema; Java's `public`
> tables are untouched). The `DATABASE_URL_TWH` secret is a **JDBC** URL (`jdbc:postgresql://…`); the
> workflow strips the `jdbc:` prefix for node-postgres. **Evidence upload is durable since 2026-07-14**
> (#167/ADR-030): the `WORKWELL_BUCKET_S3_*` env vars route evidence bytes to the managed
> `workwell-twh-evidence` S3 bucket via the `resolveBucket` seam. See **Rollback** below.

### Deployment workflow

Push to `main` triggers `.github/workflows/deploy-twh-mieweb.yml` which:
1. **Vendors official-measure terminology into the build context** (see below) — before any image build
2. Builds the **TypeScript** backend image (`workwell-api-ts`, from `backend-ts/Dockerfile`, repo-root
   context + `submodules: recursive`) tagged `latest` + `sha-<SHA>`
3. Builds the frontend image (TWH branding via build-args) pointed at `twh-api-ts.os.mieweb.org`
4. Deploys both containers to MIE via `.github/scripts/deploy-mieweb-container.sh`

#### Step 1 — official terminology is FETCHED AT BUILD, not committed (ADR-036)

`measures/official/<catalogId>/terminology.json` holds the value-set expansions the official CMS
artifacts execute against. It is **gitignored on purpose**: the expansions contain VSAC/CPT-derived
content whose redistribution in a public repo is a licensing question we do not want to answer by
accident. So every build re-fetches it from the same pinned upstream commit the vendored bundle came
from, and the committed manifest's SHA-256 pins the bytes:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 24 }
- name: Vendor official terminology into the build context
  working-directory: backend-ts
  env:
    WORKWELL_VSAC_API_KEY: ${{ secrets.WORKWELL_VSAC_API_KEY_VENDOR }}
  run: |
    node scripts/vendor-official-measure.mjs --measure CMS122FHIRDiabetesAssessGT9Pct --catalog-id cms122 --strip-elm-annotations --complete-terminology
    node scripts/vendor-official-measure.mjs --measure CMS125FHIRBreastCancerScreen --catalog-id cms125 --strip-elm-annotations --complete-terminology
```

Invoked as plain `node` — the script imports nothing outside node built-ins and global `fetch`, so this
needs no install and no package manager on the deploy path. It retries transport errors and 5xx with
backoff (a 30-second GitHub blip must not block an emergency **rollback**, which rebuilds the image); a
4xx at an immutable pin means the path is wrong and is never retried.

#### Step 1a — `--complete-terminology`: value sets the bundle does not fully carry (ADR-041, ADR-053)

> **Flag renamed 2026-07-31.** It was `--complete-capped-expansions`, which is still accepted (with a
> notice) so a stale runbook does not hit "unknown argument" mid-incident. The behaviour is WIDER than
> the old name says — it now also sources value sets upstream omits entirely, below.

Upstream limits every expansion it ships to 1000 codes (its README says so; full expansions need an NLM
licence). One of them matters: `AdvancedIllness` (`2.16.840.1.113883.3.464.1003.110.12.1082`) is **1000
of a declared 1997** in both bundles and feeds the 66+/advanced-illness denominator exclusion in each.
A capped exclusion set does not error — it narrows a population silently — so
`officialRoutingProblems` **refuses to route any measure whose ELM retrieves one**. This flag completes
the shortfall from VSAC at vendor time, paging `offset`/`count` against the release the upstream content
itself names (`Library/ecqm-fhir-update-2025`, the same eCQM release CVU+ validates the 2026 reporting
period against). Only the capped OIDs are re-expanded — today one, two requests per measure.

| `WORKWELL_VSAC_API_KEY_VENDOR` | effect |
|---|---|
| set, VSAC reachable | the shortfall is completed, `truncated` empties, and `manifest.terminology.completion` records the release the codes came from. **The normal path.** |
| set, VSAC unreachable or refusing | the script warns and leaves upstream's capped codes, so the regenerated manifest no longer matches the committed one and **the deploy FAILS at the reproducibility gate below.** No image is built |
| unset | identical to the row above — capped codes, mismatched manifest, **deploy fails** |

> **⚠ Since the completed manifests were committed, a deploy needs VSAC.** Before ADR-041 the committed
> manifests recorded the capped expansion, so a missing key was a no-op and the deploy proceeded. That is
> no longer true: the committed manifests only reproduce with a working key against a reachable NLM
> service, and both deploy workflows run `git diff --exit-code backend-ts/measures/official` immediately
> afterwards. **An NLM outage now blocks production deploys.** That is fail-closed rather than
> fail-quiet — the alternative is shipping an image whose sidecar the runtime would refuse, silently
> degrading the literal fidelity diff — but it is a real new coupling and it has one sharp edge worth
> knowing before you need it:
>
> **Rolling back still works. Rolling forward during a VSAC outage does not.** Redeploying a pre-ADR-041
> SHA is unaffected (those manifests are the capped ones, and that revision's workflow does not pass the
> flag). Redeploying any post-ADR-041 SHA while NLM is down will fail. If you need to ship during an
> outage, roll back to a pre-ADR-041 image rather than fighting the gate.

> **This is a different secret from `WORKWELL_VSAC_API_KEY_TWH`, deliberately, even though both hold the
> same UMLS key.** The `_TWH` one is *runtime* — it drives the authored engine's live VSAC resolver
> (ADR-023). `_VENDOR` is *build-time* — it vendors the official artifact's own expansions. ADR-036
> exists to keep those two terminology authorities apart; one secret name would invite exactly the
> conflation it forbids.

##### Step 1b — vendoring a NEW measure when you cannot read the secret

`WORKWELL_VSAC_API_KEY_VENDOR` is a GitHub secret. Secrets are write-only — `gh secret list` returns
names, never values — so a completed artifact cannot be produced from a clone even though the credential
is configured and CI uses it on every push.

That is a tooling gap, not an owner gap, and it had been recorded as the latter. The fix is a manual
trigger that runs the existing command in the one place the credential already lives:

```bash
gh workflow run vendor-official-measure.yml \
  -f measure=CMS138FHIRTobaccoScrnCessation -f catalog_id=cms138
gh run watch                        # the log prints truncated + completion
gh run download <run-id> -n vendored-cms138 -D backend-ts/measures/official/cms138
```

`-D` points at the **catalog directory**, not at `measures/official/`. With `-n` selecting a single
artifact, `gh run download` extracts its contents directly into `-D`, and this artifact's root holds
`bundle.json`/`manifest.json` — so the shorter path drops them one level too high, where neither the
vendor script nor the runtime looks (review of #365).

It uploads **`bundle.json` and `manifest.json` only**. `terminology.json` stays on the runner: it holds
thousands of AMA CPT and SNOMED CT codes under an NLM licence, is gitignored for that reason (ADR-036),
and an artifact URL is redistribution. `vendor-workflow-safety.test.ts` pins that — named files, no
directory glob, no recursive copy, `contents: read` only — and is mutation-checked against the exact
edit that would sweep the sidecar in (`cp -r …/*`).

CMS130 and CMS165 used this same path on 2026-07-31: one credentialed dispatch each, and both were
verified terminology-complete on first arrival (`truncated: []`, `absent: []`). The
`--complete-terminology` flag resolved their capped `AdvancedIllness`-class expansions during normal
vendoring, so neither needed a sourced supplement.

The job **fails** rather than running without the credential: an uncredentialed vendor produces an
artifact that looks vendored and cannot be routed, which is worse than none. It also **fails rather than
uploading an incomplete artifact** — `completeTerminology` fails closed and exits 0, so an expired key,
an unreachable VSAC, a short expansion or a wrong-OID echo all leave the terminology as upstream shipped
it while the vendor step still succeeds. A verification step runs the real runtime predicates
(`absentValueSets` + the manifest's `truncated`) over the produced artifact and stops the job if either
is non-empty. Checking only `truncated` would have been useless for the very measure this was built
for — an ABSENT value set never appears there.

Then, in one PR: commit the two files, add the measure to `OFFICIAL_GATED_MEASURES`, to the deploy
workflows' vendor lists, and to `fetch-official-cases.ps1` if it is not already a candidate there. CI
re-derives the same bytes and runs the measure's MADiE deck — **that deck is the check**, especially for
an ADR-053 absent value set, where nothing in the vendoring can tell a correct expansion from a wrong
one of the right size. The [credentialed CI run](https://github.com/Taleef7/workwell/actions/runs/30718966633)
scored CMS130 64/64 and CMS165 68/68, with 0 unexpected mismatches and 0 errors for each, and both
manifests reproduced byte-for-byte.

##### Step 1a (cont.) — value sets upstream ships **no ValueSet resource for at all** (ADR-053)

A second, different incompleteness, and the same flag now handles it. A measure's ELM can retrieve a
value set the bundle simply does not carry. That is not a capped expansion and not an expansion failure:
there is nothing to expand.

Check any measure — including ones not yet vendored — before spending an owner step on it:

```bash
cd backend-ts
pnpm official:terminology-audit                        # every measure in .official-content
pnpm official:terminology-audit CMS138FHIRTobaccoScrnCessation
```

Measured 2026-07-31 at pin `ca4b4951` across all eight measures currently checked out:

| measure | retrieved by the ELM | shipped by the bundle | |
|---|---:|---:|---|
| CMS122, CMS125, CMS2, CMS68, CMS951 | 26 / 32 / 15 / 5 / 26 | same | OK |
| **CMS130** | **31** | **31** | OK |
| **CMS165** | **33** | **33** | OK |
| **CMS138** | **32** | **31** | `2.16.840.1.113883.3.526.3.1278` "Tobacco Use Screening" **absent** |

Three things worth knowing before acting on it:

- **The measure is not broken.** Upstream's own discrepancy report (2026-07-15, 72 measures / 5826 test
  cases) lists CMS138 under *no discrepancies*. Their environment resolves the set from the NLM
  terminology package their README names; our vendor step never asked for it.
- **Re-pinning does not fix it.** Upstream HEAD (`f705ee60`) changes no bundle file — only report
  documents — so there is no newer content to move to.
- **VSAC is the only remedy for CMS138**, which makes vendoring CMS138 an owner step. CMS130 and CMS165
  were separately vendored through the same credentialed workflow and arrived complete on their first
  dispatch, so their case was simpler than CMS138's. It is
  a *weaker* completion than a capped one: upstream shipped no codes to check containment against and no
  declared total to check length against, so the only size baseline is VSAC's own `expansion.total`.
  `manifest.terminology.completion.valueSets[].reason` records `absent-upstream` rather than `capped` so
  the two are never read as equally evidenced. **The real check is the MADiE gate** — CMS138 scores
  0/47 with 47 errors today, and a wrongly-sourced value set does not turn that green.

Routing already refused this (an unexpandable value set is refused as empty), so nothing was ever at
risk of running on it. What ADR-053 changed is that the vendor step now *warns* instead of writing a
manifest that reads as complete, and the routing refusal names the actual cause instead of
"could not be expanded" — which had sent this investigation at our sidecar, our pin and our fetch.

> **⚠ Landing order (this WILL turn CI red — and BLOCK DEPLOYS — if done backwards).** CI runs the same
> command and then `git diff --exit-code measures/official`. Adding the secret without also committing
> the re-vendored manifests means CI completes the expansion while Git still records it as capped, and
> that check fails on every unrelated PR. **Both deploy workflows carry the same gate** (`git diff
> --exit-code backend-ts/measures/official`), so the next push to `main` fails its deploy too and the
> live stack stops updating until the manifests land — fail-closed, but it is a production-visible
> outage of the deploy path, not just a red check. **Add the secret and commit the regenerated manifests
> in the same change:**
>
> ```bash
> cd backend-ts
> WORKWELL_VSAC_API_KEY=<umls-api-key> pnpm vendor:official \
>   --measure CMS122FHIRDiabetesAssessGT9Pct --catalog-id cms122 --strip-elm-annotations --complete-terminology
> WORKWELL_VSAC_API_KEY=<umls-api-key> pnpm vendor:official \
>   --measure CMS125FHIRBreastCancerScreen --catalog-id cms125 --strip-elm-annotations --complete-terminology
> git diff measures/official          # terminology.sha256 moves; truncated → []; completion block appears
> pnpm test:official-cases            # expect 121/121 unchanged, then commit the regenerated report
> ```
>
> Completing the expansion changes `manifest.terminology.sha256` and therefore `officialLogicVersion`
> (ADR-040), which invalidates cached `eval_state` rows for those measures. That is designed behaviour.

**Both the production and the staging workflow run this step.** Omitting it does not fail the build — it
degrades behaviour silently, which is why it is written down here:

| sidecar | effect |
|---|---|
| present | `GET /api/measures/:id/fidelity/diff` answers `mode:"literal"` (the official artifact, executed) |
| absent | the ladder degrades to `"subset"` (cms122) or `"estimate"` (any other measure) — a **shipped capability quietly lost** |
| absent, with `WORKWELL_OFFICIAL_MEASURES` set | official routing **refuses at construction** and the run fails loudly — the safe direction |

To produce it locally: `cd backend-ts && pnpm vendor:official --measure <MADiE name> --catalog-id <id>
--strip-elm-annotations`. CI's `official-cases` job runs the same commands and then
`git diff --exit-code measures/official`, so the committed artifact is proven reproducible from its pin
on every PR.

### Flipping a measure to official execution — pre-flip checklist (ADR-043)

Setting `WORKWELL_OFFICIAL_MEASURES` on a stack is the only irreversible-feeling step in the official-first
sequence, because from that point the measure's roster rows are produced by the published artifact rather
than by our authored CQL. Most of what could go wrong already fails loudly — a missing artifact, a missing
terminology sidecar, or a capped expansion all **refuse at construction** (ADR-036/041), and a batch that
retrieved nothing for anybody refuses at runtime (PR-8f).

**One failure mode does not, and this checklist exists for it.** A whole roster can land *outside the
official initial population* while every retrieve matches — measured: official CMS125 matched 236 LOINC
Observations on real WebChart data and still put all 56 subjects out of the IPP, for want of a `us-core-sex`
extension. The run completes, writes a full set of MISSING_DATA outcomes, and reads exactly like a cohort in
which nobody is eligible. ADR-043 decided **not** to refuse that at runtime: a legitimately all-ineligible
cohort produces the identical shape, cohort composition varies per run, and failing would replace valid
`official.populationResults` evidence with an engine error. The runtime emits a `WARN` (in `run_logs` and in
the run message) and reports the outcomes as computed. **Discrimination between the two causes happens
here, before the flip — comparing official against the authored engine over data whose answer is known.**

Per measure, per stack:

1. **Confirm the gate is green for the data this stack will actually see.** These tests need the fetched
   terminology sidecar and **self-skip without it** — `pnpm test` does not run them, so run them explicitly.
   These are the two that decide a flip; CI's `official-cases` job runs them inside a longer list
   (`official-terminology`, `corpus-membership`, `literal-diff` as well), and **any new sidecar-reading test
   must be added to that job or it is permanently skipped while reading as covered**:

   ```bash
   cd backend-ts
   pwsh -NoProfile -File scripts/fetch-official-cases.ps1   # MADiE cases → .official-content
   # The terminology SIDECAR comes from vendoring, NOT from the fetch above. Without it every test
   # below self-skips and the run reads green having verified nothing.
   WORKWELL_VSAC_API_KEY=<umls-api-key> pnpm vendor:official \
     --measure CMS122FHIRDiabetesAssessGT9Pct --catalog-id cms122 --strip-elm-annotations --complete-terminology
   WORKWELL_VSAC_API_KEY=<umls-api-key> pnpm vendor:official \
     --measure CMS125FHIRBreastCancerScreen --catalog-id cms125 --strip-elm-annotations --complete-terminology
   pnpm exec node --import tsx --test \
     src/wiring/official-corpus-outcomes.test.ts \
     src/engine/ingress/webchart/devdb-official-eval.test.ts
   pnpm test:official-cases                                 # the MADiE known-answer gate, 121/121
   ```

   > **Read the `skipped` count, not just `fail`.** Both files self-skip wholesale without the sidecar
   > (`devdb-official-eval.test.ts`'s skip reason is literally *"run 'pnpm vendor:official' to fetch the
   > terminology sidecars"*), and `pnpm test:official-cases` silently degrades to a weaker
   > upstream-terminology fallback. `pass 0, fail 0, skipped N` is **not** a green gate — it is the gate
   > not running. Expect `skipped 0`.

   Note which corpus is representative for the stack you are flipping: `devdb-official-eval.test.ts` is the
   per-subject official-vs-authored divergence map over the committed 56-patient **WebChart** dev-DB
   fixture; `official-corpus-outcomes.test.ts` covers the **synthetic** roster a seamless stack evaluates.
2. **Take the before/after snapshot and confirm a NON-ZERO initial population** — steps 2 and 4 are one
   command (ADR-044):

   ```bash
   # The stack you are flipping decides --source. A stack with NO WORKWELL_WEBCHART_* evaluates the
   # SYNTHETIC roster and never sees WebChart data.
   pnpm flip-snapshot --measure cms125 --measure cms122 --source synthetic --eval <YYYY-MM-DD>

   # WebChart-configured stacks: `live` reads THE TENANT via WORKWELL_WEBCHART_*, over the real ingress
   # path. This is the only source that answers "is the initial population non-zero for MY data".
   # --roster is REQUIRED — it maps THIS tenant's subject ids → measures. Template:
   #   pnpm evaluate:webchart-live --list-patients > roster.json
   WORKWELL_WEBCHART_BASE_URL=… WORKWELL_WEBCHART_CLIENT_ID=… WORKWELL_WEBCHART_PRIVATE_KEY_B64=… \
     pnpm flip-snapshot --measure cms125 --source live --roster roster.json --eval <YYYY-MM-DD>
   ```

   It evaluates each measure through **both** engines over the same bundles and reports the before/after
   outcome distribution, the official initial-population count, and every subject whose roster row would
   change. Read the verdict:

   | verdict | meaning |
   |---|---|
   | no verdict | somebody entered the initial population — proceed to step 3 |
   | **DO NOT FLIP** | official admits nobody while authored finds actionable subjects in the *same* bundles, so "this cohort is ineligible" is demonstrably false — a data or mapping gap |
   | **INCONCLUSIVE** | neither engine finds anybody; a genuinely ineligible cohort and a gap that blinds both are the same shape. Routing changes no roster row either way |

   It gates nothing and exits 0 regardless — deliberately. The judgement is the one ADR-043 established a
   machine cannot make from shape alone; the command computes the comparison, a human draws the conclusion.
   **Do not wire it into CI as pass/fail.**

   > **`--source fixture` is NOT a substitute for `live`.** It reads the committed 56-patient dev-DB
   > sample — frozen data that says nothing about a tenant. `--source live` refuses loudly rather than
   > falling back to it, because a silent fallback is exactly how this step would hand you a healthy
   > verdict computed from our sample while your tenant's roster falls out of the official initial
   > population. For the same reason it refuses without `--roster`, and refuses a roster matching none of
   > the subjects the tenant returned: an unenrolled roster silently drops the qualifying-visit Encounter
   > the authored side depends on, turning a **DO NOT FLIP** into a false all-clear.
   >
   > **`--source synthetic` is an AGREEMENT check, not a roster forecast.** It runs five designed corpus
   > probes (one per intended outcome) — *not* the synthetic employee directory the demo/production stack
   > actually evaluates — and the five collapse into three buckets, since `DUE_SOON`/`MISSING_DATA` both
   > score OVERDUE here. Read it as "do the two engines agree across the outcome space", which is what a
   > flip turns on. The report prints its source under every measure so the two cannot be confused.

3. **Check the numerator, not just membership.** Being in the population is not agreement. The mammography
   case is the worked example (ADR-044): the crosswalk emits a CPT `Procedure`, the official artifact
   retrieves a LOINC `Observation` with `category ~ imaging`, and emitting one and not the other made
   official report an already-screened woman **OVERDUE** — a HIGH-priority case chasing a mammogram she had.
   Nothing detects this: those subjects *are* in the population, so the ADR-043 WARN stays silent. It is
   closed for mammography by dual-stamping; **the same question has to be asked of each new measure.**
4. **Add the variable to the deploy workflow — setting it on the container by hand does not survive.**
   `deploy-twh-mieweb.yml` builds `CONTAINER_ENV_VARS_JSON` as a fixed `jq -nc '[…]'` array with **no
   `WORKWELL_OFFICIAL_MEASURES` key and no passthrough**, and the deploy script deletes and recreates the
   container — so a hand-set value is wiped on the next deploy. Flipping is a **workflow edit**, reviewed
   and merged like any other change. (Same for staging.)

5. **Redeploy, then check the two signals that exist — neither is a clean boot failure.**
   - The seam line reports `official-measures=on|off` only; it does **not** name the routed measures, so
     `on` confirms the variable was read, not that it says what you intended.
   - **A misconfiguration does NOT refuse at boot.** `worker.ts` logs
     `WORKWELL_ALERT {"kind":"OFFICIAL_ROUTING_MISCONFIGURED",…}` on the first request and the actual
     throw is at engine construction, **per request**. `/actuator/health` is deliberately DB-free and
     stays **200**, so the container reads green while every evaluating route 500s — the exact symptom
     profile DEPLOY.md's "Watch the right signal" section exists because of. **Grep the logs for
     `OFFICIAL_ROUTING_MISCONFIGURED` before trusting a green container.**
   - Then run one population run and read `run_logs`: an `INFO` line per routed measure (`N subject(s)
     evaluated in one official batch`) proves the artifact ran, and the ADR-043 `WARN` flags a whole
     roster out of the initial population.

Reversible: remove the variable from the workflow and redeploy. `logic_version` carries the artifact's
identity (ADR-040), so flip-on, flip-off and re-vendor each invalidate `eval_state` by construction — no
manual cache `DELETE`.

| stack | seam | what a flip evaluates |
|---|---|---|
| demo / production (`deploy-twh-mieweb.yml`) | none — zero `WORKWELL_WEBCHART_*` | the synthetic roster; official cms122 **and** cms125 score and agree with authored |
| staging (`deploy-staging-mieweb.yml`) | live WebChart (teatea) | official **cms122** puts every subject out of the IPP (zero Conditions in the seed) — routing it there produces nothing useful, and the WARN says so each run |

The deploy script talks to the MIE Container Manager **v1 API** (`<manager-origin>/api/v1`):
responses are wrapped in a `{"data": ...}` envelope, the create body uses `template` with
`services` as an array of flat objects, and job polling reads `.data.status` (success value
`"success"`). See the 2026-06-03 JOURNAL entries for the v1 migration details (PRs #55, #56).

> **Job-poll window (`DEPLOY_JOB_POLL_ATTEMPTS`, PR #283).** After the container-create call, the
> script polls the MIE job until it reports `success`, **90 attempts × 10 s = 900 s** by default. The
> attempt count is overridable via the `DEPLOY_JOB_POLL_ATTEMPTS` env var — it must be a positive
> integer (validated `^[1-9][0-9]*$`, capped at 360 / 60 min); a non-numeric, zero, or empty value
> **fails fast** rather than producing an empty poll loop that would report a deploy successful without
> ever polling. The window was raised from the original 300 s because the backend image grew (the
> `fqm-execution` dependency + the vendored `measures/official/` MADiE bundle) and the GHCR pull +
> Proxmox `vzcreate` began exceeding 300 s; `backend-ts/Dockerfile` was also multi-staged to a slim
> ~436 MB production runtime to keep the pull fast. If a genuinely slow MIE pull still times out, bump
> `DEPLOY_JOB_POLL_ATTEMPTS` (up to 360) on a `workflow_dispatch` run.

> **Manager-request resilience.** Every Container Manager call has a 10-second connection timeout
> and a 30-second overall timeout. Safe `GET` calls retry transient curl transport failures up to
> six times with 20-second spacing; `POST` and `DELETE` are attempted **once**, because a lost
> response is ambiguous — the manager may already have applied the state change. CI runs
> `.github/scripts/mieweb-api-request.test.sh` to pin the timeout, retry, and method-safety behavior.
> A manager outage longer than this bounded window still fails the deploy honestly; wait for
> `manager.os.mieweb.org:443` to recover, then rerun the failed workflow jobs.

> **An ambiguous container DELETE is resolved by reading the manager back, not by failing.** The
> once-only rule above is about not *re-issuing* blindly; it is not a reason to abandon a deploy
> mid-replace. Twice — 2026-08-30 and 2026-09-01 — `DELETE /sites/1/containers/<id>` returned
> `curl: (28)` after 30 s with zero bytes, **the manager had already applied the deletion**, and the
> deploy aborted before recreating: the live backend was gone and the frontend stayed on the old
> image until someone re-ran the workflow by hand.
>
> `.github/scripts/mieweb-delete-confirmed.sh` closes that. On a DELETE that does not return cleanly
> it polls `GET /sites/{id}/containers?hostname=…` (6× / 10 s) and takes **three** verdicts, not two:
>
> | read-back says | action |
> |---|---|
> | **absent** | the delete landed — continue to the create |
> | **still registered** | **re-issue** — not a blind retry, because the request demonstrably did not take effect; re-targets the id the manager itself just reported |
> | **could not tell** (the read failed) | **refuse and fail the job** — never guess |
>
> Bounded at three attempts. The third verdict is the one that matters: "could not tell" must collapse
> into neither of the others. Read as *absent*, the deploy creates over a container that is still
> running. Read as *present*, the deploy re-issues a state-changing request into a state it cannot
> see — the very ambiguity the once-only rule exists to respect, and it could target an id the manager
> has since reused. Only the **last** observation in the window decides, so a manager that answers and
> then goes away is unknown, not present — though a read failure *inside* the window is retried
> inside it, so one flaky read does not abort a deploy the next read would have resolved.
>
> **Absence is required to be an affirmative shape**, not merely an empty extraction:
> `.data[0].id // empty` yields `""` for an error envelope served with a 200 exactly as it does for a
> genuinely empty list, and `""` is the verdict that lets the deploy proceed to CREATE. A response
> whose envelope is not recognised is reported as could-not-tell.
>
> **One exception to the "refuse" row**, deliberately: the create-retry cleanup path
> (`cleanup_existing_for_retry`) calls the same helper with `|| true` and proceeds, because the create
> that follows fails with a clearer message than anything that path could raise. Everywhere else a
> failure to confirm fails the job.
>
> Knobs, all with safe defaults and all validated (a bad value fails fast rather than silently
> weakening the read-back): `MIEWEB_DELETE_ATTEMPTS` (3), `MIEWEB_DELETE_CONFIRM_ATTEMPTS` (6),
> `MIEWEB_DELETE_CONFIRM_DELAY_SECONDS` (10). The confirmation GETs deliberately run with
> `MIEWEB_REQUEST_ATTEMPTS=1` — the poll loop *is* the retry, and compounding the two would turn a
> flaky manager into a job that holds the `twh-mieweb-container-ops` concurrency group for hours. For
> the same reason every container-ops job now carries `timeout-minutes: 45`.
>
> All of that is pinned in `.github/scripts/mieweb-delete-confirmed.test.sh` (11 cases), which runs on
> every PR — **and in `mieweb-delete-confirmed.integration.test.sh`, which exists because the first
> one was not enough.** That test fakes `request()`, which is the right boundary for the *decisions*
> but blind to how the real `request()` behaves. On 2026-09-01 the confirmed-delete path failed on its
> first production run for exactly that reason: an unconditional `set -e` inside `request()` re-armed
> errexit **before the function returned**, reaching across the function boundary to undo the caller's
> `set +e`, so the shell exited on `request()`'s own non-zero return. The guard existed, was tested,
> and could not run. `request()` now saves and restores the caller's errexit, the call sites are
> errexit-immune by construction (`||` and condition contexts), and the integration test drives the
> real `request()` under the deploy's own `set -euo pipefail` while faking only `curl`.
>
> **The rule worth carrying**: when a guard's job is to survive a failure, test it against the real
> thing that fails. A double that cannot reproduce the failure mode is not coverage.

### Required GitHub Secrets for MIE deploy

| Secret | Purpose |
|--------|---------|
| `LAUNCHPAD_API_URL` | MIE Create-a-Container API base URL |
| `LAUNCHPAD_API_KEY` | MIE API authentication key |
| `DATABASE_URL_TWH` | Neon pooled connection string for TWH instance |
| `OPENAI_API_KEY` | AI services (Draft Spec, Explain Why Flagged) |
| `WORKWELL_AUTH_JWT_SECRET_TWH` | JWT signing secret for TWH instance |
| `WORKWELL_VSAC_API_KEY_VENDOR` | **Build-time** UMLS key used by `vendor:official --complete-terminology` (ADR-041). Read by CI *and* both deploy workflows. Optional — unset means capped expansions ship as upstream sent them and official routing refuses. Distinct from the runtime `WORKWELL_VSAC_API_KEY_TWH`; see Step 1a above |

The deploy workflow maps these `*_TWH` GitHub secrets onto the backend container's runtime
environment variable names (e.g. `DATABASE_URL_TWH` → `DATABASE_URL`,
`WORKWELL_AUTH_JWT_SECRET_TWH` → `WORKWELL_AUTH_JWT_SECRET`) used in the
[environment variables reference](#environment-variables-reference) below.

### Backend runtime configuration (set by the workflow / container)

- `WORKWELL_INSTANCE=twh` — selects the default deployment profile: the pre-existing TWH behavior
- `SPRING_PROFILES_ACTIVE=prod`
- `WORKWELL_AUTH_ENABLED=true`, `WORKWELL_AUTH_JWT_SECRET=<strong-random-secret>`
- `WORKWELL_AUTH_COOKIE_SAME_SITE=None`, `WORKWELL_AUTH_COOKIE_SECURE=true`
- `WORKWELL_EMAIL_PROVIDER=simulated` (must stay `simulated` on the demo stack)

> **Refresh-cookie config:** the refresh-token cookie is set `SameSite=None; Secure`, and
> production startup **fails fast** if `WORKWELL_AUTH_COOKIE_SAME_SITE` is not `None` or
> `WORKWELL_AUTH_COOKIE_SECURE` is not `true`. With the frontend (`twh.os.mieweb.org`) and
> API (`twh-api-ts.os.mieweb.org`) on split origins, this is what lets the browser send the
> cookie on the `POST /api/auth/refresh` fetch — otherwise silent token refresh fails and
> users are logged out on every reload.

### Deployment profiles

`WORKWELL_INSTANCE` selects the deployment profile: which tenants are visible, which tenants are
evaluable, and which measures are runnable. Unset, `default`, and `twh` reproduce the pre-existing TWH
behavior; `maui` exposes the 48-patient Maui directory and currently allows `cms122`, `cms125`, and
`hypertension` to run. The measure catalog and database seeding remain shared across profiles.

Total catalog: **63 measures**, 14 runnable (see `docs/MEASURES.md` for the full breakdown).

#### One-time segment repair after adding a tenant (E13 PR-1, owner-gated)

> **✓ Done on 2026-06-29 (live Neon).** `PUT /api/segments/ad1facc4-14f5-4897-8d67-a3f9136c3f6c`
> widened `All Employees` from `["HQ","Plant A","Plant B","Clinic"]` to all 7 sites
> (`Clinic`, `HQ`, `North Campus`, `Outpatient Clinic`, `Plant A`, `Plant B`, `South Campus`).
> `SEGMENT_UPDATED` audit event recorded; `updatedAt` → 2026-06-29T15:12:24Z.
> If the stack is ever re-provisioned from a fresh DB, the seed auto-covers all sites — no repair needed.
>
> **maui (added 2026-08-30) needs NO repair yet**: the tenant is directory-only
> (`EVALUATION_EXCLUDED_TENANTS` in `employee-catalog.ts`), so no outcomes or cases are produced for it and
> segment applicability never fires. When MM-1 activates evaluation for the pilot cohort, the live
> `All Employees` baseline must be widened to include `Wailuku Clinic` and `Kihei Clinic` via the same
> audited `PUT /api/segments/:id` repair — that step belongs to the MM-1 activation checklist.

The demo **risk-group segments** seed (`backend-ts/src/segment/segment-seed.ts`) is **name-idempotent**:
a boot over an already-seeded DB adds no duplicates and **never mutates an existing segment** (so it
can't clobber operator edits, and it writes no unaudited boot-time change). The universal
`All Employees` baseline now derives its cohort site list from the directory, so any **fresh** DB (the
SQLite floor, a new instance) automatically covers every tenant — including a newly added one (E13's
`ihn` / Indus Hospital Network campuses).

An **already-seeded** stack (the live Neon demo, seeded pre-E13) keeps its old `All Employees` row,
which lists only the original `twh` sites — so the new tenant's employees would read
`NOT_APPLICABLE` for the baseline wellness/eCQM measures until repaired. The repair is **owner-gated**
(like all data migrations): edit `All Employees` to add the new tenant's sites
(`North Campus`, `South Campus`, `Outpatient Clinic`) via the **audited** `PUT /api/segments/:id`
route — i.e. the `/admin → Groups` Configure Groups editor — which records a `SEGMENT_UPDATED` audit
event. (Do **not** hand-edit `segment_measures`/`rule_json` directly; use the route so the change is
audited.)

### Seeding synthetic trend history (on-demand, NOT auto-run on deploy)

The `/programs` + `/programs/[measureId]` trend charts can read as flat lines on a stack with only a
few real runs per measure. `pnpm seed:trend-history` backfills **synthetic demo data** — backdated
weekly COMPLETED runs per runnable measure — so the trends show realistic variation. It is a
controlled, on-demand tool and is **not run automatically on deploy**. Run it once against Neon from
`backend-ts/` (it honors `DATABASE_URL` for the Pg ceiling and opens no local SQLite file when set):

```bash
cd backend-ts
DATABASE_URL=<neon-pooled> pnpm seed:trend-history --weeks 12 --as-of 2026-06-21
```

It is idempotent and resumable at the week level — a rerun or a larger `--weeks` fills only missing
weeks, no duplicates. Seeded runs carry `triggered_by='seed:trend-history'` (labeled `SEED` on
`/api/runs`; real operator runs stay `MANUAL`) and are anchored strictly before each measure's latest
real run, so the programs overview is never affected.

**Rollback (reversible, synthetic data only) — delete tagged outcomes first, then runs**
(`outcomes.run_id` is not `ON DELETE CASCADE`; schema-qualify on the Pg ceiling):

```sql
DELETE FROM workwell_spike.outcomes
  WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:trend-history');
DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:trend-history';
```

### Seeding the population-scale tenant (E13 PR-2, on-demand, NOT auto-run on deploy)

> **✓ Live Neon status (updated 2026-07-09, superseding the 2026-06-29 fabricated seed).** The
> 2026-06-29 fabricated 1.68M-row seed was **rolled back** and replaced by the **#253 real-eval proof**:
> `pnpm seed:scale --subjects 5000 --as-of 2026-06-26 --mode evaluate` — **14 runs × 5,000 subjects =
> 70,000 real CQL evaluations** (14 `SCALE_POPULATION_EVALUATED` audit events, full evidence). Live All
> Systems rollup = **72,100** (ihn 700 + twh 1,400 + mhn 70,000), all reconciling. The full-120k
> real-eval run on Neon is **not planned** (cost; the N=5000 proof carries the scale-honesty claim —
> see CLAUDE.md). Re-run only after rolling back (see SQL below) or to change `--subjects`.

`pnpm seed:scale` populates the **`mhn` ("MetroHealth Network") ~120k-subject tenant** so the
`/programs/hierarchy` rollup + the `/programs` KPIs aggregate a real population-scale system (Doug's
"120,000 people"). The subjects are **generated demo data** (not live CQL-evaluated) and exist only as
`outcomes` rows whose `subject_id` encodes the hierarchy (`mhn|Lxx|Pxx|n`) — **no schema change**. It is
a controlled, on-demand, owner-gated tool and is **not** run automatically on deploy. Run it once
against Neon from `backend-ts/` (honors `DATABASE_URL` for the Pg ceiling; opens no local SQLite when
set):

```bash
cd backend-ts
DATABASE_URL=<neon-pooled> pnpm seed:scale --subjects 120000 --as-of 2026-06-26
```

It writes one COMPLETED `MEASURE` run per runnable measure (`triggered_by='seed:scale'`, minimal
`evidence_json`), audited (`SCALE_POPULATION_SEEDED`). It is **idempotent** — a single existing
`seed:scale` run makes a rerun a no-op (re-seed after a rollback, or to change `--subjects`, requires
the rollback below first). The bounded SQL aggregation (`aggregateScaleRun`) is what keeps the rollup
fast at 120k — app memory never holds the per-subject rows. **Storage note:** 120k × 14 runnable
measures ≈ **1.68M `outcomes` rows** on Neon (minimal evidence keeps each row small); size accordingly
or seed fewer `--subjects`.

> **Now real batch CQL evaluation (2026-07-08, this branch — supersedes the fabricated path).**
> `seed:scale` now defaults to **`--mode evaluate`**: the `mhn` outcomes are produced by **real batch
> CQL evaluation** (engine `batchEvaluateScalePopulation`), not the previous fabricated compliance
> distribution. It is **subject-major** — each subject's FHIR bundle is generated once (default the
> `webChartRealisticGenerator`, emitting real LOINC/CVX/CPT codes routed through the WebChart terminology
> crosswalk, so the real WebChart adapter is genuinely exercised at scale — for **13 of the 14** runnable
> measures; `hazwoper` has no real terminology for OSHA 1910.120 surveillance and passes through on its
> synthetic code. Lab/vital measures re-code to a real LOINC Procedure, so the crosswalk runs but the
> Observation→Procedure *synthesis* half of the adapter is not exercised at scale — that path is covered
> by the offline #246 dev-DB proof), evaluated against all runnable measures, then fanned out to the
> per-measure `seed:scale` runs. It is bounded-memory (one
> chunk buffered), whole-batch resumable (per-measure idempotency on COMPLETED `seed:scale` runs; a crash
> before the finalize loop re-seeds all measures), and per-subject error-isolated (an evaluation failure
> persists `MISSING_DATA` with `{evaluationError, message}` evidence and never aborts the run). Each real
> run is audited with the new **`SCALE_POPULATION_EVALUATED`** event (the fabricated path used
> `SCALE_POPULATION_SEEDED`). The **`mhn|Lxx|Pxx|n` `subject_id` encoding, `aggregateScaleRun`, and the
> rollback SQL below are all unchanged** — only the outcomes' provenance changed (fabricated → real CQL).
>
> **⚠ Long-run warning + parallelism (#256).** `--mode evaluate` is CPU-bound — **measured cost (#253
> N=5000 live-Neon proof, 2026-07-09): ≈68 ms per evaluation overall** (70,000 evaluations in ~79.5 min
> wall-clock; ~63 ms/eval once host CPU contention eased — the first chunks ran at 86–88 ms/eval under 4
> concurrent build agents) — so a full 120k × 14 ≈ 1.68M evaluations is on the order of **~30 hours
> single-threaded** (`--workers 1`; a proof/dev run at `--subjects 5000` is ~80 min). A **worker
> pool** (`--workers <n>`, default **4**, clamped to `availableParallelism()-1`) parallelizes the evaluate
> phase across `node:worker_threads` — measured **3.7× at 4 workers / 5.1× at 8 workers** on a many-core
> host (N=500 × 14 measures: 693.6s → 187.5s → 136.3s; see `docs/JOURNAL.md` 2026-07-09), making the 120k
> dial usable (order of hours on 8 cores rather than a day). Each worker regenerates bundles from subject indices and evaluates in-thread; the **main
> thread does every DB write**, so resume/idempotency (per-measure COMPLETED `seed:scale` +
> `requestedScope.batchEvaluated` marker) and the `SCALE_POPULATION_EVALUATED` audit are unchanged, and the
> `aggregateScaleRun` read path is byte-for-byte the same (status-only). `--workers 1` (or `0`) forces the
> single-threaded path unchanged. The pool is confined to this batch CLI — never the request path.
> Progress is logged one line per chunk. For a proof/dev run use a small `--subjects` (e.g. 5000, ~80 min
> single-threaded, less with workers). `--mode fabricated` keeps the legacy instant path reachable for one
> more release (it ignores `--workers` and the evidence policy below).
>
> **Tiered evidence policy (#257) — evidence value follows ACTIONABILITY.** Full `evidence_json` (~1–3
> KB/outcome) at 120k × 14 is GB-scale on the cost-capped Neon, so trimming is now **tiered**, not
> all-or-nothing: when trimming, outcomes with status **OVERDUE / DUE_SOON / MISSING_DATA keep FULL
> evidence** (they feed cases/worklists — load-bearing; an evaluation-error MISSING_DATA keeps its
> `{evaluationError}` payload), **COMPLIANT / EXCLUDED get minimal `{scale:true}`**, and a
> **deterministic ~1% subject-index sample** (`idx % 100 === 0`) keeps full evidence across ALL buckets
> for audit spot-checks. **Auto-trim:** the trim engages automatically when `--subjects > 20000` and
> `--trim-evidence` was not explicitly passed (a notice is printed) — the "forgotten flag on a big run"
> failure mode is closed; pass **`--full-evidence`** to explicitly keep full evidence on every row
> (the two flags together are a usage error). `--trim-evidence` still forces the tiered trim at any N.
> The trim never touches `outcomes.status`, so `aggregateScaleRun` + the rollup (status-only reads) are
> provably unchanged (guard test). **Long-term home** for large evidence payloads is the #167 managed
> S3/R2 bucket — once that lands, Neon keeps status + hash only.
>
> **First run on a DB that already has the OLD fabricated seed (⚠ applies to live Neon).** `--mode evaluate`
> **refuses to run** if any COMPLETED *fabricated* `seed:scale` run exists (it will not silently no-op, and
> it will not auto-delete). The live Neon DB carries the 2026-06-29 fabricated 1.68M-row seed, so the first
> real-eval run there must **roll that back first** (the SQL below), then run `--mode evaluate`. Real
> (batch-evaluated) runs carry a `requestedScope.batchEvaluated` marker so they are distinguished from
> fabricated ones — a resumed evaluate run correctly skips already-evaluated measures.
>
> **Crash recovery.** A crashed `--mode evaluate` run leaves orphaned RUNNING `seed:scale` runs (up to one
> per measure, each holding its already-written outcomes) — these are **not** auto-swept (`failStuckRuns`
> excludes `seed:%` runs). A resume re-seeds every measure under new run ids (correct: the rollup is
> COMPLETED-only, latest-wins), but the orphaned rows persist. **Roll back the crashed run with the SQL
> below before resuming** to avoid storage bloat on Neon.
>
> ```bash
> cd backend-ts
> # proof/dev run: real batch eval over a small population (default 4 workers, core-clamped)
> DATABASE_URL=<neon-pooled> pnpm seed:scale --subjects 5000 --as-of 2026-06-26 --mode evaluate
> # full 120k real run: tiered trim AUTO-ENGAGES above 20k subjects; scale workers to the host's cores
> DATABASE_URL=<neon-pooled> pnpm seed:scale --subjects 120000 --as-of 2026-06-26 --mode evaluate --workers 8
> # explicitly keep FULL evidence on every row despite >20k (overrides the auto-trim)
> DATABASE_URL=<neon-pooled> pnpm seed:scale --subjects 120000 --as-of 2026-06-26 --mode evaluate --full-evidence --workers 8
> # force the single-threaded path (escape hatch / parity baseline)
> DATABASE_URL=<neon-pooled> pnpm seed:scale --subjects 5000 --as-of 2026-06-26 --mode evaluate --workers 1
> ```
>
> Spec/plan: `docs/archive/superpowers/specs/2026-07-08-option-a-scale-batch-eval-design.md`,
> `docs/archive/superpowers/plans/2026-07-08-option-a-scale-batch-eval.md`.

**Rollback (reversible, synthetic data only) — delete tagged outcomes first, then runs**
(schema-qualify on the Pg ceiling):

```sql
DELETE FROM workwell_spike.outcomes
  WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:scale');
DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:scale';
```

### Seeding quality-over-time history (E16 PR-2, on-demand, NOT auto-run on deploy)

> **✓ Done on 2026-07-01 (live Neon).** `pnpm seed:quality-history --months 12 --as-of 2026-06` wrote
> **12 months × ~4,046 rows = 48,552 `quality_snapshots`** (2025-07 → 2026-06; 2026-07 already existed
> from forward materialization → 13 months total). Verified live: `all` scope ~flat 82.5–82.6% (scale
> tenant is time-invariant by design), `tenant=twh` shows the real evaluated trend (97.9% → 69.1% as the
> RECURRING measure ages). Re-run only after a rollback (`DELETE FROM quality_snapshots`).

`pnpm seed:quality-history` materializes **real evaluated** `quality_snapshots` (numerator/denominator +
the 5 bucket counts per measure × month × scope) for a range of past calendar months, so the
`/programs/[measureId]` "Quality over time" card has genuine history — Doug's *"how do I know if they were
compliant in December? October?"* answered from a persisted aggregate. It **supersedes** the synthetic
sine-wave `seed:trend-history` for the quality trend: these rows are actually CQL-evaluated as-of each
month's end, not faked. On-demand, owner-run, **not** auto-run on deploy. Run once against Neon from
`backend-ts/` (honors `DATABASE_URL`; no local SQLite when set):

```bash
cd backend-ts
DATABASE_URL=<neon-pooled> pnpm seed:quality-history --months 12 --as-of 2026-06
```

Forward materialization also accrues a snapshot on every completed population run (E16 PR-1), so this CLI
is only needed to backfill *history* the live runs haven't produced yet. The live `twh`/`ihn` employees are genuinely
re-evaluated per month; the 120k `mhn` scale tenant folds in via the bounded `aggregateScaleRun` (never its
per-subject rows), but the scale population is **generated demo data with no time dimension**, so its
current distribution is folded unchanged into every historical month (there is no per-month history to
recover for it) — so per-tenant scopes (`twh`/`ihn`) show real evaluated month-to-month variation, while
the `all` aggregate at population scale is dominated by that time-invariant scale distribution. Audited
(`QUALITY_HISTORY_BACKFILLED`, one per month). **Idempotent + resumable** at the month level (a rerun
skips months that already have snapshots).

**Rollback (reversible) — the whole table is a rebuildable cache** (schema-qualify on the Pg ceiling):

```sql
DELETE FROM workwell_spike.quality_snapshots;
```

### Resolving VSAC value sets (ADR-023, on-demand, NOT auto-run on deploy)

> **✓ Done on live Neon (imported 2026-07-05; verified 2026-07-13).** All **21 CMS122v14 reference
> OIDs** are present in `workwell_spike.value_sets` with `source='VSAC'`, `resolution_status='RESOLVED'`,
> and non-empty code lists. Live-verified end-to-end on 2026-07-13:
> `GET /api/measures/cms122/fidelity/diff` on the deployed stack returns **`mode: "literal"`**
> (150 subjects, 15 divergent, 0 errors — the fqm-execution literal ladder is live). Re-run only to
> refresh expansions or add OIDs (idempotent per-OID).

`pnpm resolve-valuesets` imports **real VSAC (NLM UMLS) value-set expansions** into `value_sets` so the
CQL engine can resolve official eCQM value sets against authoritative terminology instead of only the
locally-seeded codes — the on-ramp for the E14 official-CQL work. It `$expand`s each target OID via the
live NLM FHIR terminology service and upserts the codes (`source="VSAC"`, RESOLVED; a failed OID → an
ERROR row + continue), audited `VALUE_SETS_RESOLVED` per OID (existing `value_sets` columns only — **no
DDL**; DATA_MODEL §3.4). Default target = the 21 CMS122v14 reference OIDs; `--oid <oid>` (repeatable) /
`--measure cms122` override. On-demand, owner-run, **not** auto-run on deploy. Run against Neon from
`backend-ts/` (honors `DATABASE_URL`; requires the VSAC key):

```bash
cd backend-ts
# unpinned (latest-active — warns; kept for parity with the 2026-07-05 import)
DATABASE_URL=<neon-pooled> WORKWELL_VSAC_API_KEY=<umls-api-key> pnpm resolve-valuesets
# pinned to a VSAC release manifest — REPRODUCIBLE, preferred (#295)
DATABASE_URL=<neon-pooled> WORKWELL_VSAC_API_KEY=<umls-api-key> \
  pnpm resolve-valuesets --manifest Library/ecqm-update-2025-05-08
```

> **`--official <catalogId>` — required before any measure is routed to official execution (PR-7a).**
> The default target is a hand-kept 21-OID table, and the vendored official artifacts need more than
> that: **CMS122 references 26 canonicals and CMS125 references 32** (35 distinct across both). The
> official executor refuses to run a measure when any referenced value set expands to zero codes —
> deliberately, because fqm treats an unexpandable set as *empty rather than missing*, and an empty set
> matches nothing, so the measure would report every subject out-of-population with no error anywhere.
> `--official` derives the target list from the artifact's own compiled ELM, so the importer and that
> refusal cannot disagree:
>
> ```bash
> cd backend-ts
> DATABASE_URL=<neon-pooled> WORKWELL_VSAC_API_KEY=<umls-api-key> \
>   pnpm resolve-valuesets --official cms122 --official cms125 --manifest <release-canonical>
> ```
>
> Repeatable and idempotent per OID; the 23 canonicals both measures share are expanded once. Rows are
> named from the ELM's CQL aliases rather than bare OIDs.

> **Release pinning + drift detection (#295).** Without `--manifest <canonical>` (or `--expansion
> <name>`; the two are mutually exclusive) VSAC serves **latest-active** semantics — a republish
> silently changes our expansions and therefore the CMS122/CMS125 literal-diff results. The CLI now
> warns when unpinned, forwards the pin to every `$expand`, and records the returned
> `ValueSet.version` on the row (it used to hardcode `version: null`) plus
> `expansion.identifier`/`timestamp` in the `VALUE_SETS_RESOLVED` audit payload. The expansion hash
> is **SHA-256** over the sorted `system|code` pairs *and* the `ValueSet.version` (the
> non-load-bearing `expansion.identifier` is deliberately excluded — FHIR does not require it stable
> across identical expansions, so hashing it would fire false drift), prefixed
> `sha256:` so pre-#295 rolling hashes (`h<hex>`) are never compared across algorithms. When a
> re-import's hash differs from the stored one, a distinct **`VALUE_SET_EXPANSION_CHANGED`** audit
> event is written and the OIDs are listed on stderr — silent terminology drift is now loud.
> **Choosing the manifest is an owner/standards call**: it must match the measure year being
> evaluated (CMS122v14/CMS125v14 = 2026), so the CLI ships **no default pin** rather than guessing
> one. Verify the exact canonical against the VSAC FHIR API docs before the next import.

**Descriptive only — changes no current outcome.** The runtime composite resolver still falls back to the
local store for the synthetic measures' `urn:workwell:*` references, so importing VSAC codes does not shift
any measure's `Outcome Status` (ADR-008/ADR-023; audiogram cross-mode parity test). VSAC is **inert on the
demo stack unless the key is set** — `resolveValueSetResolver`/`engineForEnv` are key-gated, so with no
`WORKWELL_VSAC_API_KEY` the evaluation path is byte-identical to today. **If VSAC is enabled in the deployed
env,** add the UMLS API key as a GitHub secret `WORKWELL_VSAC_API_KEY_TWH` and map it onto the backend
container env in `deploy-twh-mieweb.yml` (analogous to `DATABASE_URL_TWH` → `DATABASE_URL`,
`WORKWELL_AUTH_JWT_SECRET_TWH` → `WORKWELL_AUTH_JWT_SECRET`); the **demo stack leaves the key unset**.

**Rollback (reversible) — remove the imported rows** (schema-qualify on the Pg ceiling):

```sql
DELETE FROM workwell_spike.value_sets WHERE source = 'VSAC';
```

### Manual re-deploy (force update existing containers)

Use `workflow_dispatch` with `replace_existing: true` from the GitHub Actions UI.

### Maui sandbox deployment

Maui is a separate sandbox for the pilot group on the same MIE Create-a-Container platform. It has its
own Neon database and JWT secret, and uses the same backend image build and deployment script as TWH:

| Service | Hostname | Image |
|---------|----------|-------|
| Frontend | `maui.os.mieweb.org` | `ghcr.io/taleef7/workwell-maui-frontend` |
| Backend API | `maui-api-ts.os.mieweb.org` | `ghcr.io/taleef7/workwell-api-ts` |

Run `.github/workflows/deploy-maui-mieweb.yml` from **Actions → Deploy Maui OS MIEWeb → Run workflow**.
It is **`workflow_dispatch` only** because the two Maui-only secrets are not present on every push;
an automatic trigger would fail until those secrets were set.

Owner-set GitHub secrets:

| Secret | Purpose |
|--------|---------|
| `DATABASE_URL_MAUI` | Pooled Neon connection string for the Maui sandbox |
| `WORKWELL_AUTH_JWT_SECRET_MAUI` | JWT signing secret for the Maui sandbox |

The workflow reuses these secrets from TWH: `LAUNCHPAD_API_URL`, `LAUNCHPAD_API_KEY`,
`OPENAI_API_KEY`, `WORKWELL_VSAC_API_KEY_VENDOR`, and `WORKWELL_VSAC_API_KEY_TWH`. The workflow maps
the two Maui-only secrets onto the runtime names `DATABASE_URL` and `WORKWELL_AUTH_JWT_SECRET`.
It sets `WORKWELL_INSTANCE=maui` and passes `NEXT_PUBLIC_SUBJECT_TERM=patient` and
`NEXT_PUBLIC_PUBLIC_DEMO=off` while building the frontend image (suppressing public sandbox links,
walkthrough videos, and GitHub source links, and making Sign in the primary CTA).
`WORKWELL_OFFICIAL_MEASURES` is deliberately **unset**; Maui uses authored CQL until
each pilot measure passes its own flip gate. Maui has no self-heal reconciler, so dispatch the workflow
again for a replacement or recovery.

Evidence bytes deliberately remain on the in-container `fs` binding for now; the Maui workflow omits the
four `WORKWELL_BUCKET_S3_*` variables, so evidence is lost whenever the container is recreated.

**Unclaimed QUEUED run recovery:** In addition to recovering in-process `RUNNING` runs orphaned by a container
restart (30-minute threshold), boot recovery (`failStuckRuns`) sweeps unclaimed `QUEUED` runs whose
`claimed_by` worker ID is null and whose timestamp is older than 6 hours (`UNCLAIMED_QUEUED_THRESHOLD_MS`).
Because live deployments do not run a separate claiming worker daemon, any run left queued without a worker
is recovered to `FAILED` with an audited `RUN_RECOVERED` event and alert. An audit failure restores the run so the next boot retries.

**Backend image tags are namespaced, and that is load-bearing — do not "simplify" it.** Maui and TWH
share one GHCR backend repository (`ghcr.io/taleef7/workwell-api-ts`), and
`reconcile-twh-mieweb.yml` heals the live `twh-api-ts` container by recreating it from that
repository's `:latest`. So the Maui workflow pushes **`maui-latest`** and **`maui-sha-<SHA>`** and
deploys from `maui-sha-<SHA>`; it must never publish `:latest`, or a Maui dispatch from an unmerged
branch would leave the live TWH demo able to self-heal onto that code. `deploy-staging-mieweb.yml`
namespaces its tags (`staging-*`) for the same reason. The frontend needs no namespacing — Maui
builds a different image repository. **Maui rollback:** re-dispatch with `replace_existing: true` at
an earlier commit, whose image is `maui-sha-<that SHA>`.

Sandbox accounts (all use the documented demo password `Workwell123!`):

Demo accounts are strictly profile-scoped: on the Maui profile (`WORKWELL_INSTANCE=maui`), only
`@maui.workwell.dev` accounts authenticate. The standard `@workwell.dev` demo accounts (including the
public `/sandbox` viewer) are refused.

| Identifier | Role |
|------------|------|
| `quality-lead@maui.workwell.dev` | `ROLE_CASE_MANAGER` |
| `quality-staff@maui.workwell.dev` | `ROLE_CASE_MANAGER` |
| `clinician@maui.workwell.dev` | `ROLE_VIEWER` |
| `admin@maui.workwell.dev` | `ROLE_ADMIN` |

### Staging environment — live WebChart against teatea (separate stack; NOT the demo)

`deploy-staging-mieweb.yml` provisions a **separate, non-demo** environment that runs the app **live
against the teatea WebChart trial** (synthetic data — no PHI), so the real WebChart FHIR integration
(#262) is exercised on a deployed URL. It is distinct from the demo stack in every way and **cannot touch
it**:

| | Demo (production) | Staging |
|---|---|---|
| Frontend | `twh.os.mieweb.org` | `twh-staging.os.mieweb.org` |
| Backend | `twh-api-ts.os.mieweb.org` | `twh-staging-api-ts.os.mieweb.org` |
| Database | `DATABASE_URL_TWH` (Neon `workwell-twh`) | `DATABASE_URL_STAGING` (a **separate** Neon project) |
| Image tags | `:latest` / `:sha-*` | `:staging-latest` / `:staging-sha-*` |
| WebChart seam | **unset** (byte-identical) | **configured → teatea** |
| Scheduler | `WORKWELL_SCHEDULER_ENABLED=true` | **`false`** (no idle DB polling — the 2026-07-22 Neon-cost lesson) |
| Concurrency group | `twh-mieweb-container-ops` | `twh-staging-mieweb-container-ops` (separate) |
| Trigger | push to `main` + dispatch | **`workflow_dispatch` only** |
| Self-heal | reconcile-twh-mieweb.yml (`:latest`) | **none** — re-dispatch to recover |

**Dispatch it from the branch whose code you want to test** (e.g. `feat/webchart-count-capability-fallback`
/ PR #328 before it merges) — a `workflow_dispatch` builds the selected ref, so staging can validate
unmerged WebChart work. **The workflow depends on the PR #328 client code:** teatea 400s `_count` and 403s
a bare `GET /Patient`, and the client refuses to guess a demographic filter, so the workflow sets
`WORKWELL_WEBCHART_PATIENT_SEARCH=birthdate=le9999-12-31` — `9999-12-31` is the **FHIR maximum date**, so
the bound spans the whole representable range. That matters because sentinel birthdates cluster at *both*
ends: `gt1900-01-01` dropped 7 early/default records (28/35), and a `le3000`-style bound would likewise
miss the common `9999-12-31` "unknown" sentinel. Verified 2026-07-23: teatea returns **35** with a
**numeric `Bundle.total`**, so the client's completeness guard is live against it.

> **Residual gap, stated honestly.** 35 is the largest count any enumeration tried returns — it is *not*
> independently confirmed to be the whole population, and no birthdate bound can reach a record with **no**
> `birthDate` at all. The client's guard compares the fetched count to `Bundle.total`, which counts the
> *query's* matches — so it detects a truncated fetch but **cannot** detect a query that under-matches.
> Bulk export is the likely complete enumeration, but WebChart advertises only **`Group`**-level
> `$export` (a Group is itself a curated cohort, so it must be verified to cover everyone), and the teatea
> trial exposes **no** `$export` at all (verified 2026-07-23: no operations advertised;
> `Patient/$export` → 404, `/$export` → 403). Treat complete enumeration as an open item.

Dispatching from a branch WITHOUT the PR #328 client code (e.g. `main` before #328
merges) will fail the population fetch — land #328 first, or dispatch from its branch.

**Owner setup required before the first dispatch (one-time):**

1. ~~**MIE hosting confirmation**~~ — **not required** (settled 2026-07-24). The deploy provisions both
   containers programmatically through the same Container Manager API and `LAUNCHPAD_*` secrets the
   production deploy uses; the first staging dispatch created `twh-staging` + `twh-staging-api-ts` with no
   MIE involvement. Tell Doug/Dave as a courtesy, not as a gate.
2. **A separate Neon project** for staging → its pooled connection string as the `DATABASE_URL_STAGING`
   GitHub secret. **Never** point staging at the `workwell-twh` demo DB (the deploy hard-fails if the two
   resolve to the same host). Match production deliberately: **Postgres 16** (the Neon console and CLI
   both default to a newer major — a staging env on a different major cannot validate planner-dependent
   work like the #233 index fix), **AWS us-east-1**, autoscaling **0.25–2 CU**. Live staging project:
   `workwell-staging` / `damp-hill-78058027`, created 2026-07-24.
3. **GitHub secrets** (repo → Settings → Secrets):
   - `DATABASE_URL_STAGING` — the staging Neon pooled URL.
   - `WORKWELL_AUTH_JWT_SECRET_STAGING` — a strong random secret (distinct from production).
   - `WORKWELL_WEBCHART_PRIVATE_KEY_STAGING` — the **RS384 PKCS#8 PEM** for the teatea backend-services
     client, stored as a plain multi-line PEM (the workflow base64-encodes it before handing it to the
     container — see `WORKWELL_WEBCHART_PRIVATE_KEY_B64` below for why). Its public half is the registered
     JWKS. This is the **only** WebChart secret — the base URL / client id (`workwell`) / scope
     (`system/*.read`) / kid (`workwell-2026-07`) are non-secret env constants in the workflow (update
     them there if MIE moves the trial). Set it from the key file rather than by pasting, so the newlines
     survive exactly: `Get-Content key.pem -Raw | gh secret set WORKWELL_WEBCHART_PRIVATE_KEY_STAGING`.
   - `LAUNCHPAD_API_URL` / `LAUNCHPAD_API_KEY` / `OPENAI_API_KEY` — reused from the demo stack.

Then run **Actions → Deploy TWH Staging (live WebChart / teatea) → Run workflow** (`replace_existing:true`).
Verify: the staging backend boots with `webchart=on` in the seam-inventory line; a staging `ALL_PROGRAMS`
run pulls the live teatea population and the dashboards render the `wc` tenant (reconciling
`All Systems = Σ tenants`); and the **demo** stack's seam-inventory line still reads `webchart=off`.

> **teatea trial runway:** extended to ~3 months (Dave → Cornwell, 2026-07-23). When it lapses the seam
> stops resolving — a live run FAILS and the prior successful population stays authoritative; no PHI is
> involved. **The demo stack is unaffected by anything in this section** (it leaves every
> `WORKWELL_WEBCHART_*` unset).

### Service startup & reboot policy

> "What happens if the server reboots — does WorkWell come back up on its own?"

There are two runtime contexts, and the answer differs:

**1. Live stack (`os.mieweb.org`) — MIE Create-a-Container.**
The `twh` and `twh-api-ts` containers run on **MIE's Container Manager**, which is a **Proxmox
abstraction** (the manager talks to each node's Proxmox API via a stored token; nodes are named
`opensource-phxdc-pve*`). Restart-on-reboot therefore lives at the Proxmox **`onboot`** layer.

What was verified directly against the manager API (`GET /api/v1/sites/1/containers/{id}` and
`/sites/1/nodes`, 2026-06-09):
- The container object exposes **no** restart/`onboot`/uptime field (only `status`, `hostname`,
  `nodeName`, `services`, `environmentVars`, etc.), and neither does the node object. So a restart
  policy is **not user-configurable or user-readable** through this API — there is nothing to add
  to the create payload in `deploy-mieweb-container.sh`, and nothing to inspect.
- **Clean restart recovery is already proven** by normal operation: every push to `main` runs
  `deploy-twh-mieweb.yml`, which **deletes and recreates** both containers, and the deploy script
  fails unless the final container `status` is `running`. So the containers reliably return to
  `running` after being recreated.

> **Open question (nice-to-know, not a blocker — see the reconciler below):** are provisioned
> containers created with Proxmox **`onboot=1`** (auto-start when the node reboots)? This is the one
> thing not verifiable from our side — a manual container restart does **not** test it (restart ≠ node
> reboot), and rebooting a shared Proxmox node is not an option.

**Self-healing reconciler (covers reboot recovery regardless of `onboot`).**
`.github/workflows/reconcile-twh-mieweb.yml` is scheduled every 15 minutes (+ `workflow_dispatch`): it
health-checks the live surfaces (`twh` → 200; `twh-api-ts` → `/actuator/health` `UP`, retrying up to
6× over ~3 min so a transient blip or a normal cold start never registers as down) and, if any is
down, **recreates that container from its last-good GHCR `:latest` image** via
`deploy-mieweb-container.sh` (`REPLACE_EXISTING=true`). This recovers the stack from a node reboot, a
container crash/OOM, or accidental deletion — **independent of `onboot`** — so the `onboot` question
above is no longer a blocker. **Do not treat the 15-minute cron as a recovery-time guarantee.** Measured 2026-08-30..09-01, the
twelve most recent scheduled runs arrived **2.5–7.5 hours apart** — GitHub queues `schedule` on a
best-effort basis and drops runs under load. That gap is what left production down for ~3 hours after
the 2026-09-01 deploy failure. Treat this as a slow backstop, dispatch it by hand when you need a
heal now, and make anything that must not break for hours fail safe on its own. A recreate is
~30–120s of that container's downtime; no data loss (Neon persists). It heals both live containers
(`twh` + `twh-api-ts`); since the JVM was retired (#109 PR4) there is no separate Java rollback
container to exclude. The env blocks are duplicated from `deploy-twh-mieweb.yml` and marked
**keep-in-sync** in both.

**How to see reconciler history (#264 doc note):** open the repo on GitHub → **Actions** tab → filter
workflow **`reconcile-twh-mieweb`** (or open `.github/workflows/reconcile-twh-mieweb.yml` → "View
workflow runs"). Each run shows the health-check outcome and whether a recreate fired. Manual re-run:
**Actions → reconcile-twh-mieweb → Run workflow** (`workflow_dispatch`).

**Two safety properties to know.** (1) The reconciler shares the `twh-mieweb-container-ops` concurrency
group with `deploy-twh-mieweb.yml`, so a heal never runs while a push-to-main deploy is mid
delete+recreate of the same container — the later run queues behind the in-flight one. (2) A heal
recreates from `:latest`. After a **fast rollback** (redeploying an older `sha-<SHA>` via
`workflow_dispatch`), the next heal would re-pull `:latest` and silently undo it — so follow a fast
rollback with a **durable** one (revert the bad commit on `main` so `:latest` rebuilds to the good
image), or temporarily disable the reconcile workflow, before relying on the rollback.

**2. Self-hosted / VM / local — Docker Compose + systemd.**
For any host we *do* control, reboot recovery is fully handled and is the reference Doug asked for:

- **Per-container crash recovery:** every service in `infra/docker-compose.yml` is now
  `restart: unless-stopped`, so Docker restarts a crashed container automatically (and restarts
  the stack when the Docker daemon starts).
- **Boot-time startup:** an example systemd unit, `infra/systemd/workwell.service`, starts the
  whole compose stack on boot. Install + verification steps are in `infra/systemd/README.md`.

```bash
sudo systemctl enable docker                       # Docker starts on boot
sudo systemctl enable --now workwell               # stack starts now + on every boot
systemctl status workwell                          # verify
```

With both in place, a `sudo reboot` brings the entire stack back automatically (`docker compose ps`
shows all services `Up`).

---

## Environment variables reference

| Var | Where | Purpose |
|-----|-------|---------|
| `DATABASE_URL` | Backend | Pooled Neon connection for app runtime |
| `DATABASE_URL_DIRECT` | Backend | Direct Neon connection for Flyway migrations |
| `OPENAI_API_KEY` | Backend | AI calls (drafting and explanation surfaces) |
| `SPRING_PROFILES_ACTIVE` | Backend | Always `prod` in deployed env |
| `WORKWELL_INSTANCE` | Backend | Selects the deployment profile: visible tenants, evaluable tenants, and runnable measures. Unset/default/`twh` reproduces the pre-existing TWH behavior; `maui` selects the Maui profile. |
| `WORKWELL_AUTH_ENABLED` | Backend | Enable auth; set `true` in deployed env |
| `WORKWELL_AUTH_JWT_SECRET` | Backend | Required when auth is enabled; use a strong secret |
| `WORKWELL_AUTH_COOKIE_SAME_SITE` | Backend | Refresh-cookie SameSite. **Must be `None` in production** (split frontend/API origins). Default `Lax` for local same-origin dev. |
| `WORKWELL_AUTH_COOKIE_SECURE` | Backend | Refresh-cookie Secure flag. **Must be `true` in production** (required for SameSite=None). Default `false` for local HTTP dev. |
| `WORKWELL_CORS_ALLOWED_ORIGINS` | Backend | Comma-list of **exact** origins. Production refuses a wildcard, a blank entry, a non-URL and `localhost` (`config/startup-safety.ts`), and an unsafe value makes every route answer **503 `unsafe_configuration`** rather than degrading. Two consumers beyond the SPA: the **first origin is used as the Studio link target in CDS Hooks cards** (ADR-067) — definitionally the frontend, so no new variable — and a **browser-based CDS Hooks client must have its origin added here** before it can invoke the service. The CDS Hooks specification requires CORS support but explicitly declines to specify an allowlist rule, so this stays a deliberate, reviewed addition per client; `sandbox.cds-hooks.org` is not pre-allowed. A server-side CDS client needs nothing here. |
| `NEXT_PUBLIC_API_BASE_URL` | Frontend | Backend URL for fetch calls (origin-only, no `/api` suffix, no trailing whitespace). Also what the public `/api-docs` page fetches `/api/v1/openapi.json` from, so an unset value leaves the API reference showing its unreachable-backend state. |
| `NEXT_PUBLIC_APP_NAME` | Frontend | App display name |
| `NEXT_PUBLIC_DEMO_MODE` | Frontend | Prefill login form for local/demo builds only; `true` **fails the production frontend build** |
| `NEXT_PUBLIC_SUBJECT_TERM` | Frontend | Subject noun for all display text (`frontend/lib/terminology.ts`, ROADMAP MM-0): `employee` (default) or `patient` (the Maui pilot). Build-time like every `NEXT_PUBLIC_*` var — the Dockerfile takes it as a build ARG, so the Maui deploy workflow must pass `--build-arg NEXT_PUBLIC_SUBJECT_TERM=patient` (goes on the MM-1 activation checklist; the TWH workflows pass nothing and keep the byte-identical employee default). The match is exact and case-sensitive; any other value silently falls back to `employee`, so verify the rendered UI after a Maui build. Display text only — API paths, payload keys (`employeeExternalId`) and routes (`/employees/...`) are deliberately unchanged. |
| `NEXT_PUBLIC_PUBLIC_DEMO` | Frontend | Build-time toggle for public demo affordances (`frontend/lib/public-demo.ts`): `on` (default) or `off` (the Maui pilot). When `off`, public sandbox shortcuts, walkthrough video links, and GitHub repository links are not rendered, and Sign in is promoted to primary CTA. On `/sandbox`, requests redirect to `/login` without signing in. Default `on` keeps all other deployments byte-identical. |
| `WORKWELL_EMAIL_PROVIDER` | Backend | Outreach email provider. **Stays `simulated` on the demo stack (default + CLAUDE.md hard rule).** |
| `WORKWELL_EMAIL_SENDGRID_API_KEY` | Backend | SendGrid API key. Wiring exists in code but **must remain unset on the demo stack**; only set in an explicit non-demo deployment alongside `WORKWELL_EMAIL_PROVIDER=sendgrid`. |
| `WORKWELL_EMAIL_FROM_ADDRESS` | Backend | From address for outreach (default `noreply@workwell-demo.dev`). |
| `WORKWELL_EMAIL_FROM_NAME` | Backend | From display name (default `WorkWell Measure Studio`). |
| `WORKWELL_WEBCHART_BASE_URL` | Backend | WebChart origin+app path (e.g. `https://<practice>.webchartnow.com/webchart.cgi`; the FHIR root is `{base}/fhir`). **Inert unless paired with an auth mode below — the demo stack leaves all `WORKWELL_WEBCHART_*` unset** (JSON-bucket ingress stays selected). |
| `WORKWELL_WEBCHART_CLIENT_ID` | Backend | SMART Backend Services client id (the verified contract, PR-2c/ADR-028). Selects SMART auth together with `WORKWELL_WEBCHART_PRIVATE_KEY`. |
| `WORKWELL_WEBCHART_PRIVATE_KEY` | Backend | PKCS#8 PEM private key for the RS384 `private_key_jwt` client assertion (multi-line env value; the matching public key is registered as the client's JWKS). **Local/dev only — on a deployed stack use the `_B64` form below.** |
| `WORKWELL_WEBCHART_PRIVATE_KEY_B64` | Backend | The same key, base64-encoded **whole file, headers included** — single-line, and therefore the form any deployed stack must use. Takes precedence over the raw variable when both are set. A multi-line env value does **not** survive the Create-a-Container transport: the first staging deploy (2026-07-24) reached the container truncated at the PEM's first newline, and every token request died on WebCrypto's opaque `Invalid keyData`. Encode with `base64 -w0 key.pem` (the staging workflow does this from the plain-PEM GitHub secret, so the stored secret stays a normal PEM). A too-short body now fails with an error that names the cause. |
| `WORKWELL_WEBCHART_TOKEN_URL` | Backend | Optional token-endpoint override; when unset it is discovered from `{base}/fhir/.well-known/smart-configuration`. |
| `WORKWELL_WEBCHART_SCOPE` | Backend | Optional OAuth scope (default `system/*.rs` — the documented bulk-registration grant; the sandbox also advertises v1-style `system/*.read`). |
| `WORKWELL_WEBCHART_KID` | Backend | Optional JWK `kid` header for the client assertion (multi-key registered JWKS). |
| `WORKWELL_WEBCHART_API_KEY` | Backend | Legacy static bearer key (pre-verified-contract mode; kept for fixtures/proxies). Ignored for auth selection when the SMART pair is set. |
| `WORKWELL_WEBCHART_DISABLE_COUNT` | Backend | Optional `"true"` to pin the client to never send FHIR `_count` — for servers that reject it (teatea rejects `_count` with a 400, verified 2026-07-23). Left unset, the client probes the standard `_count` shape and falls back automatically on a 400/403 first Patient page, so this is only needed to skip the one-time probe round-trip on a known-quirky server. |
| `WORKWELL_WEBCHART_PATIENT_SEARCH` | Backend | Raw FHIR query for the population-listing request, **required** for servers that 403 a bare `GET /Patient` (teatea does — verified 2026-07-23). The client drops `_count` automatically on a 400/403, but it will **not** guess a demographic filter (that could silently drop subjects) — so when a bare `/Patient` is also refused it errors unless this is set. Use a query you have verified returns the **whole** population by comparing its `Bundle.total`: prefer the **full FHIR range** `birthdate=le9999-12-31` (teatea = 35, numeric `Bundle.total` present) over a narrow bound like `birthdate=gt1900-01-01` (drops early/default records → 28/35) or `le3000-01-01` (would miss the common `9999-12-31` "unknown" sentinel). The client also fails an authoritative run if it fetches fewer than `Bundle.total` (paging truncation), but it **cannot** detect a query that under-matches, and no birthdate bound reaches a record with no `birthDate` — see the staging section's residual-gap note. |
| `WORKWELL_WEBCHART_ENROLLMENT_JSON` | Backend | Optional JSON object `{ "raw-patient-id": ["measure_id"] }` controlling live-tenant enrollment. When unset, every live subject is enrolled in the fail-closed `ROSTER_ELIGIBLE_MEASURES` allowlist; clinical age/sex/diagnosis/visit gates in CQL remain authoritative. Inert unless the WebChart seam is configured. |
| `WORKWELL_WEBCHART_LIVE_TEST_BASE_URL` | Dev/test only | Gates the self-skipping live-HTTP suite (`hapi-live.test.ts`) at a local HAPI "fake WebChart" (ADR-032). **Never set on a deployed stack** — deliberately distinct from `WORKWELL_WEBCHART_BASE_URL` so a runtime `.env` can't make `pnpm test` network-dependent. |
| `WORKWELL_OFFICIAL_MEASURES` | Backend | Comma-list of catalog ids that evaluate the **official published artifact** instead of authored CQL (roadmap §7.4 / ADR-036..043), e.g. `"cms122,cms125"`. Never `"all"` — that is refused, because "all" is a measure name like any other. **Set to `"cms122,cms125"` on demo/production since 2026-07-30** (PR-9c / ADR-045); unset on every other environment, and while unset `routedEngineForEnv` returns `engineForEnv`'s value *by identity*, so the run loop is byte-identical. **Not settable on the container** — it has no key the deploy script accepts, and the deploy deletes-and-recreates, so flipping or rolling back is a WORKFLOW edit. It must be set in **both** `deploy-twh-mieweb.yml` and `reconcile-twh-mieweb.yml` (the self-heal path recreates the same container from its own env array; a value present in one and not the other silently changes routing on a health event — `official-flip-config.test.ts` asserts they agree). Validated at engine construction: an id with no vendored artifact, a missing terminology sidecar, or an incomplete (capped) expansion **refuses rather than degrading** — but note the refusal is **per request**, not a boot failure: the worker logs `WORKWELL_ALERT {"kind":"OFFICIAL_ROUTING_MISCONFIGURED",…}` on the first request while the DB-free `/actuator/health` stays 200, so the container reads green and every evaluating route 500s. Grep for that alert. **Not settable on the container** — it has no key in either deploy workflow's `CONTAINER_ENV_VARS_JSON`, so flipping is a workflow edit. Read the pre-flip checklist above before setting it. |
| `WORKWELL_VSAC_API_KEY` | Backend | UMLS API key for live VSAC value-set expansion (ADR-023). **Inert unless set — the demo stack leaves it unset** (evaluation stays byte-identical to the inline path). Also required by the `pnpm resolve-valuesets` import CLI. |
| `WORKWELL_VSAC_BASE_URL` | Backend | NLM FHIR terminology service base for VSAC `$expand` (default `https://cts.nlm.nih.gov/fhir`). |
| `WORKWELL_IMMZ_ICE_BASE_URL` | Backend | Base URL of a self-hosted **ICE** sidecar (ADR-029), e.g. `http://ice:8080/opencds-decision-support-service`. **Selects the real ICE forecaster on its own** — a self-hosted sidecar has no API key. **Inert unless set — the demo stack leaves it unset** (the simulated forecaster serves; behavior is byte-identical). See "Immunization forecasting (ICE sidecar)" below. |
| `WORKWELL_IMMZ_ICE_API_KEY` | Backend | Optional bearer token, only if ICE is fronted by an authenticating proxy. It **never selects** the seam by itself. |
| `WORKWELL_ALERT_WEBHOOK_URL` | Backend | Optional failed-run alert webhook (#264). When set, PARTIAL_FAILURE/FAILED population runs (and scheduler tick errors / stuck-run recoveries) POST a JSON `RunAlert` body here. **Inert unless set.** Console always emits a greppable `WORKWELL_ALERT …` line regardless. Demo stack may leave unset. |
| `WORKWELL_INCREMENTAL_EVAL` | Backend | Optional `"true"` to enable incremental/delta batch evaluation (#263/ADR-035): a population run reuses a subject's prior CQL outcome (copy-forward) when its data + logic are unchanged and its status can't have moved, instead of re-running the ~68 ms CQL. **Inert unless `"true"`** — the demo stack leaves it unset, so no `eval_state` row is written and the run loop is byte-identical. Descriptive only (ADR-008): reuse never authors a status. Reversible cache — `DELETE FROM eval_state`. The boot seam line reports `incremental-eval=on|off`. Safe alongside official routing since ADR-040, **when that becomes reachable** (cms122 and cms125 are ROUTED on demo/production since PR-9c / ADR-045; every other environment leaves `WORKWELL_OFFICIAL_MEASURES` unset): an official-routed measure is **not reused at all** while its adapter is still changing, so a flip needs no manual `DELETE` and cannot serve an outcome the previous adapter produced. Such a measure's rows are still written, carrying the ARTIFACT's identity (`official-fqm:<version>:<artifactSha>:<terminologySha>`) rather than the authored ELM hash, so flipping on, flipping off, or re-vendoring is self-invalidating whenever reuse is re-enabled. Most useful once the WebChart live tenant is on (real data, fixed exam dates), where across-day reuse pays off; the synthetic tenants regenerate bundles per date, so it saves only same-day reruns for them. |
| `WORKWELL_BUCKET_S3_BUCKET` | Backend | Durable evidence bucket name (#167/ADR-030). Selects the S3-backed evidence bucket **only together with** the key id + secret below (all three required; inert otherwise — evidence falls back to the in-container `fs` BUCKET binding). **Set on the live TWH stack since 2026-07-14** (`workwell-twh-evidence`). |
| `WORKWELL_BUCKET_S3_ACCESS_KEY_ID` | Backend | Access key id for the evidence bucket (from the `WORKWELL_BUCKET_S3_ACCESS_KEY_ID_TWH` GitHub secret; least-privilege IAM user `workwell-twh-app`). |
| `WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY` | Backend | Secret access key for the evidence bucket (from the `WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY_TWH` GitHub secret). |
| `WORKWELL_BUCKET_S3_REGION` | Backend | Bucket region (default `us-east-1`). |
| `WORKWELL_BUCKET_S3_ENDPOINT` | Backend | Optional S3 endpoint for non-AWS S3 APIs (Cloudflare R2, MinIO) — also switches to path-style addressing. Leave unset for AWS S3. |

`Where = Backend` vars are container environment on the MIE backend container (mapped from the
`*_TWH` GitHub secrets where applicable); `Where = Frontend` vars are build-args/env baked into
the MIE frontend image. `.env.example` at repo root mirrors this list (without values). Env vars
must be verified manually before deploy; the CI workflow does not validate deployment secrets.

### Local HAPI live-tenant recipe (ADR-032)

The same runtime seam can point at local HAPI today and a configured WebChart host later; switching
targets is environment-only and requires no code change:

```powershell
docker compose -f infra/docker-compose.yml up -d hapi-fhir
Set-Location backend-ts
corepack pnpm load:hapi
$env:WORKWELL_WEBCHART_BASE_URL = "http://localhost:8081"
$env:WORKWELL_WEBCHART_API_KEY = "local-dev"
corepack pnpm dev
```

Trigger an `ALL_PROGRAMS` run, then verify 56 `wc|` rows in the compliance roster, a `wc` hierarchy
tenant, and `All Systems = Σ tenants`. For the self-skipping real-HTTP/app tests, use only the dedicated
test target (the test constructs runtime configuration internally and probes metadata for at most two
seconds):

```powershell
$env:WORKWELL_WEBCHART_LIVE_TEST_BASE_URL = "http://localhost:8081"
corepack pnpm exec node --import tsx --test src/engine/ingress/webchart/hapi-live.test.ts src/engine/ingress/webchart/hapi-app-live.test.ts
```

Do not set `WORKWELL_WEBCHART_LIVE_TEST_BASE_URL` on a deployed stack. With all runtime
`WORKWELL_WEBCHART_*` variables unset, the feature is inert and the static demo behavior is unchanged.

### Local WCDB shim live-tenant recipe (ADR-034) — SQL-backed alternative to HAPI

`wcdb-fhir-shim/` serves the same WebChart FHIR contract **directly from the dev-wcdb MariaDB**
(no fixture load step — the SQL *is* the source). Same seam, same verification, different backing
store; both `wcdb` + shim are gated behind the compose `wcdb` profile so the default stack is
untouched:

```powershell
docker compose -f infra/docker-compose.yml --profile wcdb up -d wcdb wcdb-fhir-shim
Set-Location backend-ts
$env:WORKWELL_WEBCHART_BASE_URL = "http://localhost:8085"
$env:WORKWELL_WEBCHART_API_KEY = "local-dev"     # accepted, not enforced by the shim
corepack pnpm dev
```

The self-skipping live suite runs against it identically
(`$env:WORKWELL_WEBCHART_LIVE_TEST_BASE_URL = "http://localhost:8085"`) — verified 2026-07-20:
all 4 tests pass including the bucket-for-bucket parity vs the committed-fixture evaluation.
The shim also hosts the CQL→SQL compliance API (#292/#309; see `wcdb-fhir-shim/README.md`).
Never deployed to the live stack; synthetic dev data only.

### Email delivery (Sprint 6)

The demo stack runs `WORKWELL_EMAIL_PROVIDER=simulated`. Outreach actions never send a real
email — each attempt is logged and written to `outreach_delivery_log` with `status=SIMULATED`,
visible in the Admin → Outreach Delivery Log panel. SendGrid wiring lives in `backend-ts`
(`resolveEmailService(env)` + `sendgridEmailService` in `backend-ts/src/case/email-service.ts`,
routed through the EMAIL outreach channel) and is selected solely when both
`WORKWELL_EMAIL_PROVIDER=sendgrid` and `WORKWELL_EMAIL_SENDGRID_API_KEY` are set; if the
provider is `sendgrid` but no key is configured it degrades safely back to a simulated send.
The SendGrid adapter is currently an **inert stub** (returns a `QUEUED` record, no real HTTP —
inert-unless-configured, mirroring the DataChaser channel stub, ADR-011); a real SendGrid v3
send is the documented drop-in behind it. Do not set `WORKWELL_EMAIL_SENDGRID_API_KEY` on the
demo stack.

The non-prod `POST /api/admin/demo-reset` endpoint (admin-only, `@Profile("!prod")`) truncates
volatile demo tables including `audit_events`; it returns 403 under the `prod` profile.

### Failed-run alerts (#264)

Every population run that ends **FAILED** or **PARTIAL_FAILURE** (plus stuck-run boot recovery and a
scheduler tick throw) emits **exactly one** alert through `resolveAlertChannels(env)`:

1. **Always:** a single greppable container log line —
   `WORKWELL_ALERT {"kind":"RUN_PARTIAL_FAILURE",...}` (`console.error`). Grep MIE container logs for
   `WORKWELL_ALERT`.
2. **Optional:** when `WORKWELL_ALERT_WEBHOOK_URL` is set, a plain JSON POST of the same payload.
   Leave unset on the demo stack unless you have a webhook sink. Inert-unless-configured; listed on
   the boot seam inventory as `alert-webhook=off|on`.

Alert emission is best-effort — a webhook timeout never fails the run. Run metrics (duration,
evaluated count, compliant/non-compliant, per-status `outcomeCounts`) remain on `GET /api/runs` and
`GET /api/runs/:id` as before.

### Immunization forecasting (ICE sidecar) — ADR-029, opt-in, NOT on the demo stack

The advisory immunization forecast (`GET /api/immunization/forecast`, and the panel on an
`adult_immunization` case) is served by the **simulated** forecaster unless
`WORKWELL_IMMZ_ICE_BASE_URL` is set. Setting it selects a **real** adapter against a self-hosted
**ICE** — HLN's Immunization Calculation Engine, the ACIP-maintained forecaster (ADR-029). No API key
is involved (a self-hosted sidecar has none; `WORKWELL_IMMZ_ICE_API_KEY` exists only for an
authenticating proxy and never selects the seam by itself).

**Run the sidecar** (local/self-hosted; `infra/docker-compose.yml` carries the same service):

```bash
docker run --rm -d -p 32775:8080 --memory=3g --name ice hlnconsulting/ice:latest
# then point the backend at it (compose does this for you):
#   WORKWELL_IMMZ_ICE_BASE_URL=http://localhost:32775/opencds-decision-support-service
```

**Operational notes.** ICE is a Drools engine: budget **~2–3 GB RAM** and a **tens-of-seconds cold
start** (it compiles its rule base on boot). It must be a **long-lived sidecar** — never started
per-request; give it time to warm before pointing the backend at it.

The adapter bounds every call at **3 s** (a warm ICE answers in ~50–300 ms — the sidecar's cold start
must not be charged to an interactive case-detail read) and, on **any** failure — transport error,
non-2xx, timeout, unparseable body, a vaccine group missing from the response — falls back **whole**
to the simulated forecaster and logs `ICE forecast failed for <subject>; falling back to simulated: …`.
A failure also **trips a 60-second circuit breaker**: while it is open, requests serve the simulated
forecast immediately without dialing ICE, so an unhealthy sidecar costs one timeout per minute rather
than one per page view. The breaker closes on the first success after the TTL. The advisory panel
therefore degrades; it never errors the case-detail read.

**Symptom to watch for:** the boot line says `ice=on` but every forecast reads like the simulated one
(no `ICE …` reason strings). That means the adapter is falling back — grep the container log for
`ICE forecast failed`.

**Verify a live sidecar** from `backend-ts/` (these tests self-skip when the var is unset):

```bash
cd backend-ts
WORKWELL_IMMZ_ICE_BASE_URL=http://localhost:32775/opencds-decision-support-service \
  node --import tsx --test src/engine/immunization/ice-live.test.ts
```

**The demo stack leaves `WORKWELL_IMMZ_ICE_BASE_URL` unset** — the boot seam line reads `ice=off` and
the forecast path is byte-identical to before ADR-029. The forecast is **advisory**: it never sets or
overrides an `Outcome Status` (CQL stays authoritative, ADR-008/ADR-012), and ICE disagreeing with a
WorkWell measure (ICE scores full ACIP; a measure scores its own rule) is expected, not a defect.

### Evidence upload persistence (managed S3 bucket) — LIVE since 2026-07-14 (#167 / ADR-030)

Evidence bytes are stored behind the `CloudBucket` port (`@mieweb/cloud`): `EvidenceService`
(`backend-ts/src/case/evidence-service.ts`) only calls `bucket.put(key, bytes)` / `bucket.get(key)`.

**The durable backend is selected at app level** by the `resolveBucket(env)` seam
(`backend-ts/src/case/resolve-bucket.ts`) — the `mieweb.jsonc` bindings are literal JSON (the
`@mieweb/cloud` config loader does no env substitution), so a committed binding cannot carry
credentials; the seam mirrors the `DATABASE_URL` store override instead. When ALL THREE of
`WORKWELL_BUCKET_S3_BUCKET` + `WORKWELL_BUCKET_S3_ACCESS_KEY_ID` +
`WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY` are set, evidence I/O goes to that S3-compatible bucket
(`createS3Bucket`, the same `@mieweb/cloud-os` adapter the mieweb target uses); unset ⇒ the
in-container `fs` BUCKET binding serves unchanged (inert-unless-configured — the `bucket-s3` seam on
the boot inventory line).

**Live TWH setup (provisioned 2026-07-14):** bucket `workwell-twh-evidence` (AWS us-east-1,
public-access-blocked, versioning on, 30-day lifecycle on the `db-dumps/` prefix), least-privilege
IAM user `workwell-twh-app` (List/Get/Put/DeleteObject on this bucket only), credentials in the
`WORKWELL_BUCKET_S3_ACCESS_KEY_ID_TWH` / `WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY_TWH` GitHub secrets,
mapped onto the backend container env by `deploy-twh-mieweb.yml` (and the reconciler — keep-in-sync).
The same bucket receives the **nightly `pg_dump`** written by `backup-neon-nightly.yml` (#270 —
see `docs/BACKUP_DR_RUNBOOK.md`) under a **separate, dedicated IAM principal** (`workwell-twh-backup`,
`PutObject` on `db-dumps/*` only; secrets `WORKWELL_BACKUP_S3_ACCESS_KEY_ID_TWH` /
`WORKWELL_BACKUP_S3_SECRET_ACCESS_KEY_TWH`). The app user carries an **explicit deny on `db-dumps/*`**,
so a compromised app container cannot read, overwrite, or delete the DB backups.

Evidence uploaded **before** 2026-07-14 lived on in-container disk and was lost on the next recreate
(known demo-era limitation); everything uploaded after persists across deploys/heals.

> **⚠ Bucket re-home deadline:** the hosting AWS account is a Free Plan account that **expires
> 2026-08-24** (it cannot be charged; AWS restricts-then-deletes instead). Move the bucket before
> then — MIE-provided storage (C14), a paid-plan upgrade, or Cloudflare R2 free tier. Env-var-only
> migration (see `docs/BACKUP_DR_RUNBOOK.md` §2 note).

## Database compute cost (read before changing any polling interval)

Neon compute is billed by **CU-hours**, and a compute that is merely *awake* bills whether or not it
is serving anything. It suspends after an idle timeout (~5 min by default). The single most
expensive mistake is therefore **a background timer that touches the database more often than the
suspend timeout** — that pins the compute awake 24/7 and bills a constant 0.25 CU (~**182
CU-hours/month**) with zero users.

**This is not hypothetical — it took the live stack down for four days (2026-07-18 → 07-22).** The
scheduler tick polled every 5 minutes against a 5-minute suspend timeout, exhausted the Free plan's
100 CU-hours on day ~17 of the month, and every DB-backed route began returning
`{"error":"internal_error"}` (HTTP 402 from the pooler). See `docs/JOURNAL.md` 2026-07-22.

**The invariant, stated once:** *any* recurring task that queries the database must either run less
frequently than the idle-suspend timeout, or gate itself behind a DB-free check so that a
no-op cycle issues zero queries. `schedulerTick` does the latter via `shouldSkipTickWithoutDb()` —
keep that as its first statement, and keep the `setInterval` period in `backend-ts/src/server.ts`
comfortably above the suspend timeout.

### Console settings that cap the bill

Set these in the Neon console (Project → Settings); none are reachable from the deploy workflow:

| Setting | Recommended | Why |
|---|---|---|
| **Spending limit** | Set one (e.g. $10–20/mo) | Launch is pay-as-you-go with no cap by default. This is the real backstop against a runaway loop. |
| **Suspend timeout** | 60 s (from the 300 s default) | Cuts ~4 minutes of idle billing off the tail of every burst of activity. |
| **Autoscaling max CU** | 1 CU to start (from 2) | Roster/hierarchy queries burst; 2 CU costs 8× the 0.25 idle floor while bursting. Raise only if a page is measurably slow. |
| **Autoscaling min CU** | 0.25 (leave) | The floor while awake. |

### Watch the right signal

The self-heal reconciler probes `/actuator/health`, which is **deliberately DB-free** — do not
"fix" this by adding a database query to it, or the 15-minute reconciler becomes the exact
compute-pinning loop described above. It follows that **the reconciler cannot detect a database
outage** and will report green through one.

The signal that *does* catch it is the nightly `backup-neon-nightly.yml` job. It is the only
always-on process that opens a **real connection to the real database**, which makes it our de-facto
database health check — and it fails the first night the database is unreachable.

**It now raises that failure as a GitHub issue** ("Nightly Neon backup is failing"), commenting on
the existing issue rather than opening a new one each night, and **closing it automatically** on the
next successful backup. Treat that issue as a production incident, not a backup problem: in the
07-18 outage the job failed five nights running and was the only thing telling the truth, but a red
scheduled workflow is invisible unless you go looking. Detection was never the gap — notification
was.

This deliberately reuses a database connection we already pay for once a day, so it adds **no**
compute cost. A dedicated deep-health-check workflow was considered and rejected for that reason.

## Neon (Postgres)

1. Project `workwell-twh`, region us-east, **Postgres 16**
2. **Pooled** connection string → `DATABASE_URL_TWH` GitHub secret (app runtime)
3. **Direct** connection string → used for Flyway migrations (`DATABASE_URL_DIRECT`)

Do not use `neonctl projects create` unless it supports `pg_version=16`; the CLI defaults to
Postgres 17 and is not compliant with the locked stack.

## OpenAI

1. Get API key from platform.openai.com
2. Set a hard monthly usage limit in billing
3. Store as the `OPENAI_API_KEY` GitHub secret only (never expose to the frontend)

## CI/CD

**Active deploy workflow:** `.github/workflows/deploy-twh-mieweb.yml`
- Triggers on every push to `main` and via `workflow_dispatch`
- Builds backend + frontend Docker images, pushes to GHCR, deploys both containers to MIE

**CI workflow:** `.github/workflows/ci.yml`
- Runs backend build + tests (8-way test sharding; ~11m30s wall-clock)
- Runs frontend lint
- Does not deploy (deploy is the separate workflow above)

## Health checks

- Backend (TS): `GET https://twh-api-ts.os.mieweb.org/api/version` → `{"api":"v1",...}` (also serves `/actuator/health` → 200)
- Frontend: `GET https://twh.os.mieweb.org/` → 200 OK
- DB: `psql "$DATABASE_URL_DIRECT" -c "SELECT 1"` from any host with the Neon direct string

> Quick end-to-end check of the live primary: `scripts/smoke-shadow.sh https://twh-api-ts.os.mieweb.org`
> runs the post-deploy smoke checklist below (expects all-pass except the two documented WARN
> limitations — ephemeral evidence BUCKET + the MCP-SSE nginx caveat).

Post-deploy smoke checklist (MVP complete surface):
- `GET /actuator/health` -> `200`
- `GET /api/runs?limit=1` -> `200`
- `GET /api/cases?status=open` -> `200`
- `GET /api/exports/runs?format=csv` -> `200`
- `GET /api/exports/outcomes?format=csv&runId=<latest-run-id>` -> `200`
- `GET /api/exports/cases?format=csv&status=open` -> `200`
- `GET /api/audit-events/export?format=csv` -> `200`
- `GET /api/admin/integrations` -> `200`
- `POST /api/admin/integrations/mcp/sync` -> `200`
- `POST /api/cases/{id}/actions/outreach/delivery?deliveryStatus=SENT` -> `200`
- `GET /api/cases/{id}` confirms `latestOutreachDeliveryStatus=SENT`

## Rollback

### Roll back to a known-good TS image (Java is retired)
The Java backend was retired in #109 PR4, so rollback is **redeploying an earlier known-good
`twh-api-ts` image** (each build is tagged `sha-<SHA>` in GHCR):
- **Workflow dispatch:** run `deploy-twh-mieweb.yml` via `workflow_dispatch` from the Actions UI at the
  earlier good SHA with `replace_existing: true` — it rebuilds + redeploys that SHA's images.
- **Or revert + push:** `git revert <bad-merge-sha>` on `main` re-triggers `deploy-twh-mieweb.yml` with
  the reverted code.
- **Or pin a prior image fast (no rebuild):** the self-heal reconciler (`reconcile-twh-mieweb.yml`)
  and `deploy-mieweb-container.sh` recreate from `:latest`; to pin an *older* image, re-run the deploy
  at that SHA.

### Neon
Each schema change is additive (`workwell_spike` self-creates via `CREATE … IF NOT EXISTS` on boot;
no Flyway). Neon branches can still be promoted from the dashboard if a data rollback is needed.

> **Index build on next deploy (Fable H5/M17 hardening, 2026-07-03):** the boot DDL now also creates
> five indexes via `CREATE INDEX IF NOT EXISTS` — `spike_outcomes_subject_idx`,
> `spike_outcomes_measure_idx`, `spike_audit_events_occurred_at_idx`,
> `spike_audit_events_event_type_idx`, `spike_audit_events_ref_run_id_idx`. On the live Neon DB the
> first deploy after this change builds them **once** over the existing ~1.68M-row `outcomes` table (a
> one-time index build; the boot query blocks until each completes, then subsequent boots are no-ops).
> No data migration; reversible with `DROP INDEX … ` in `workwell_spike` if ever needed. Owner-gated
> DDL — reviewed via the hardening PR.

## Cost monitoring

Daily check while the stack is live:

- **Neon dashboard:** storage + compute consumed
- **OpenAI usage dashboard:** today's spend
- **MIE platform:** internal container hosting (no per-month cloud bill like the legacy Fly tier)

If any approaches limit, fix that day. Don't wait.

## Troubleshooting

**MCP / SSE connections drop every ~60 s behind MIE ingress (504s, "request may have expired")**
- Cause (diagnosed 2026-07, Java-era but ingress-level so it still applies): MIE's nginx defaults —
  `proxy_read_timeout 60s` cuts any long-lived SSE stream, and `proxy_buffering` holds SSE frames
  until the buffer fills. The reconnect gets a new session, so the queued response lands on a dead
  one and nginx returns 504.
- Fix is an MIE ops change on the vhost, scoped to the SSE/MCP locations: `proxy_buffering off`,
  `proxy_read_timeout 3600s`, `proxy_http_version 1.1` with an empty `Connection` header.
- Local workaround: point the MCP client at a locally run backend, bypassing the ingress.

**Neon connection limit hit**
- Use the pooled connection string (`DATABASE_URL`), not direct, in the app
- HikariCP `maximum-pool-size: 10` in `application.yml`
- Direct connection only for Flyway

**OpenAI 429**
- One retry with exponential backoff (1s, 2s)
- Surface "AI temporarily unavailable" in UI
- Fall back to rule-based explanation text
- Audit log records the failure

**Audit log missing entries after deploy**
- Check Spring profile is `prod`, not `dev`
- Verify migrations ran: `psql "$DATABASE_URL_DIRECT" -c "\dt"` — should list `audit_events`

**Case detail or outreach delivery endpoint returns 500 after deploy**
- Check for SQL operator compatibility in prepared statements.
- PostgreSQL JSON existence should use `jsonb_exists(payload_json, 'key')` in JDBC query text rather than the raw `?` operator when bind parameters are present.

**MCP server can't be reached**
- MCP is exposed at `/sse` + `/mcp/**` on the backend
- Verify the Claude Desktop config points to the deployed URL and sends an `Authorization` header with a valid WorkWell JWT
- Role gates apply: `/sse` and `/mcp/**` return 403 unauthenticated

**Backend deploy job fails at the MIE manager API**
- Confirm the API base resolves to `<manager-origin>/api/v1` (the origin serves the SPA; `/api` serves Swagger)
- Responses are `{"data": ...}` enveloped; the create body uses `template` + `services[]`; job polling reads `.data.status` (`"success"`)
- For `curl exit 7/28`, verify TCP 443 reachability to the manager. The deploy
  retries safe reads within a bounded window; if the control plane remains unavailable, do not loop
  state-changing requests manually. Once it recovers, use `gh run rerun <run-id> --failed`.

**Deploy fails with `Container is 'offline', expected running`**
- This is a **startup race**, not a crash: the create job reports `success` once the container is
  provisioned, but it can still be `offline`/`pending` for a few seconds before it reports `running`.
  `deploy-mieweb-container.sh` now **polls** the container status up to ~3 min (18× / 10s) instead of a
  single eager read, so a brief startup window no longer fails an otherwise-good deploy.
- If it still fails after the full poll window, the container genuinely failed to start — check the
  image tag, the container env vars, and (for the backend) `DATABASE_URL`/auth secrets; the self-heal
  reconciler will also retry from `:latest` — but on its real cadence (hours, not the 15-minute cron;
  see the reconciler section above), so dispatch it by hand rather than waiting.

---

## Appendix A — Decommissioned Vercel + Fly.io stack (historical reference)

> **Decommissioned — do not use.** None of the resources below are deployed any more.
> MIE TWH (above) is the sole live stack. This section is retained only so the earlier
> public-preview setup remains documented. Environment variable *names* are unchanged;
> on the current stack they are set on the MIE containers, not as Fly secrets or Vercel env.

Legacy stack layout:

| Layer | Service | Tier | Cost |
|-------|---------|------|------|
| Frontend | Vercel | Hobby | $0 |
| Backend | Fly.io | shared-cpu-1x, 512MB | ~$2/mo |
| Postgres | Neon | Free | $0 (3GB cap) |
| AI | OpenAI API | direct, budget-capped | variable |
| Domain | Vercel subdomain | n/a | $0 |

Notes from that era: Fly 256MB free OOMs Spring Boot (use 512MB). Fallback if Fly cost was a
problem: Render free tier (cold-start tradeoff, ~30s first hit per inactive period).

### Legacy prerequisites
- Fly CLI: `iwr https://fly.io/install.ps1 -useb | iex` (Windows) or `curl -L https://fly.io/install.sh | sh`
- Vercel CLI: `pnpm i -g vercel`

### Legacy Fly.io setup

```bash
cd backend
fly launch --no-deploy
fly secrets set DATABASE_URL=<neon-pooled>
fly secrets set DATABASE_URL_DIRECT=<neon-direct>
fly secrets set OPENAI_API_KEY=<key>
fly secrets set SPRING_PROFILES_ACTIVE=prod
fly secrets set WORKWELL_AUTH_ENABLED=true
fly secrets set WORKWELL_AUTH_JWT_SECRET=<strong-random-secret>
fly secrets set WORKWELL_AUTH_COOKIE_SAME_SITE=None
fly secrets set WORKWELL_AUTH_COOKIE_SECURE=true
```

> On the legacy stack the frontend (Vercel) and backend (Fly) were different registrable
> domains, so every browser→API call was **cross-site** and the refresh-token cookie had to be
> `SameSite=None; Secure`. (The same production fail-fast check applies on MIE today.)

`fly.toml`: `memory = "512mb"`, region closest to you (e.g., `ord`, `iad`), and
`min_machines_running = 1` for a stable remote MCP connection.

```bash
fly deploy
curl https://<app>.fly.dev/actuator/health  # expect {"status":"UP"}
```

### Legacy Vercel setup

1. Import GitHub repo, root directory `frontend/`
2. Framework: Next.js (auto-detected)
3. Env vars: `NEXT_PUBLIC_API_BASE_URL` = Fly app URL; `NEXT_PUBLIC_APP_NAME`; `NEXT_PUBLIC_DEMO_MODE` (local/demo only)

### Legacy rollback
- **Fly:** `fly releases list` then `fly releases rollback <version>`, or `git checkout <sha> && fly deploy`
- **Vercel:** Dashboard → Deployments → previous → Promote to Production

### Legacy troubleshooting
- **Fly OOM:** verify `memory = "512mb"`; reduce heap `JAVA_OPTS=-Xmx384m -Xss256k`; check `fly logs` for OOMKilled
- **Vercel build fails:** Node 20+; verify `NEXT_PUBLIC_API_BASE_URL`; clear build cache if backend types changed
- **DB from Fly machine:** `fly ssh console` then `psql $DATABASE_URL_DIRECT -c "SELECT 1"`

### Legacy domain / probe notes
- Vercel subdomain `workwell-measure-studio.vercel.app` was the demo frontend; Fly `workwell-measure-studio-api.fly.dev` the backend
- S0 `/runs` probe: `OPTIONS https://workwell-measure-studio-api.fly.dev/api/eval` expecting `200` + `Access-Control-Allow-Origin`
