# Official artifact terminology audit — 2026-07-31

Evidence for **ADR-053** and the closure of task #11. Everything here is reproducible from the repo; no
number in this file was typed by hand.

Upstream pin: `cqframework/dqm-content-qicore-2025` @ `ca4b49516de4cbed9f92bfb7c35d97b1bf1022ab`.

## 1. The question

ADR-047 recorded CMS138 as failing to onboard with *"scores 0/47 with 47 errors (value set
…3.526.3.1278 will not expand)"*. "Will not expand" is a symptom, and it names our expander, our
sidecar and our VSAC pin as suspects. None of them is the cause.

## 2. The measurement

```
$ cd backend-ts && pnpm official:terminology-audit
CMS122FHIRDiabetesAssessGT9Pct      26 retrieved   26 shipped   OK
CMS125FHIRBreastCancerScreen        32 retrieved   32 shipped   OK
CMS138FHIRTobaccoScrnCessation      32 retrieved   31 shipped   1 ABSENT
  ABSENT 2.16.840.1.113883.3.526.3.1278  "Tobacco Use Screening"
CMS2FHIRPCSDepScreenAndFollowUp     15 retrieved   15 shipped   OK
CMS68FHIRDocumentationCurrentMeds    5 retrieved    5 shipped   OK
CMS951FHIRKidneyHealthEval          26 retrieved   26 shipped   OK

1 value set(s) are retrieved but not shipped. …
```

**"Retrieved"** is `library.valueSets.def[]` from each Library's compiled ELM — the same read
`requiredOids()` makes at runtime to decide routing. **"Shipped"** is the count of `ValueSet` resources
in the upstream bundle. CMS138's bundle carries no ValueSet resource for `…3.526.3.1278`. There is
nothing to expand, and no configuration of ours changes that.

Pinned as a test in `scripts/valueset-parity.test.mjs` (self-skips without the gitignored
`.official-content` checkout — which is why the *parity* assertion in the same file, which needs only
committed artifacts, is the guard that always runs).

## 3. Three checks that decided the remedy

| question | answer | how |
|---|---|---|
| Is CMS138 broken upstream? | **No.** Listed under *Measures with No Discrepancies* — 72 measures, 5826 test cases | upstream `scripts/reports/2026-07/Dynamic Health IT - qicore-discrepancy-report-2026-07-15.md` |
| Does a newer upstream commit fix it? | **No.** The only commit after our pin (`f705ee60`) adds two report documents and changes no bundle | `gh api …/compare/ca4b4951...f705ee60` |
| What resolves it, then? | **VSAC.** Upstream's README: value sets are limited to expansions of 1000 and full ones need an NLM licence, downloadable from `vsac.nlm.nih.gov/download/manifest?rel=20251117` | `.official-content/README.md` §Terminology Expectations |

So upstream can run CMS138 because their environment holds the NLM terminology package; our vendor step
simply never asked for the one value set the bundle omits. Same licensing boundary as ADR-041's
1000-code cap, in a different shape — and, as there, nothing to file upstream.

## 4. Reproducibility: this change moved no committed byte

The new check is computed at runtime from the artifact's own two files, not recorded in the manifest
(ADR-053 decision 2), and `absent` is deliberately excluded from the terminology sidecar. Verified by
re-vendoring a measure that was vendored WITHOUT VSAC completion:

```
$ node scripts/vendor-official-measure.mjs --measure CMS2FHIRPCSDepScreenAndFollowUp \
    --catalog-id cms2 --strip-elm-annotations
  15.7 MB → 2.3 MB (85% smaller) [ELM annotations stripped]
  terminology: 15 value sets, 829 codes → 0.1 MB (gitignored)

$ git diff --stat backend-ts/measures/official/
(no output)

$ sha256(measures/official/cms2/terminology.json)
0355252109aed497…   # unchanged, before and after
```

CI's `git diff --exit-code measures/official` reproducibility gate is therefore unaffected, and the five
committed manifests — including the two whose `completion` blocks came from a credentialed run — are
untouched.

## 5. Guards, and the mutation that proves each one fires

| mutation | test that failed |
|---|---|
| delete the absent refusal loop in `officialRoutingProblems` | `officialRoutingProblems REFUSES a measure with an absent value set, and names the real cause` |
| make `absentValueSets` report every OID when terminology will not load | `absentValueSets: reports NOTHING when the terminology will not load` |
| read `codeSystems.def` instead of `valueSets.def` in `declaredValueSets` | both `valueset-parity` tests |
| accept an empty VSAC expansion as a completion | `REFUSES an empty expansion — an empty set is the ADR-043 silence, not a completion` |
| *(control)* no mutation | nothing failed |

## 6. What is still open

- **CMS138 is NOT vendored.** Sourcing `…3.526.3.1278` needs `WORKWELL_VSAC_API_KEY_VENDOR`, a GitHub
  secret. Committing an artifact that can never be routed is worse than committing none — the same call
  ADR-047 made for CMS130 and CMS165. Folded into owner task #10.
- **The completion is weaker than a capped one and is recorded as such.** No upstream codes to check
  containment against, no declared total to check length against. The real oracle is the MADiE gate:
  0/47 with 47 errors today, and a wrongly-sourced value set does not turn that green.
- **Not covered by any of this:** a value set that is present, fully expanded and *wrong*. Size and
  presence are not identity — that is the ADR-038 membership class, and it needs a different check.
