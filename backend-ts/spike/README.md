# CQL Path C parity spike (#103) — **GO**

Proves the decisive GO/NO-GO question for the issue #96 re-platform (ADR-008):
**can Node reproduce the Java CQL engine's compliance outcomes exactly?**

For the Audiogram measure (`AnnualAudiogramCompleted`), across **all 5 outcome
buckets**, the Node engine matches the Java engine on **every define, exactly** —
including the `Days Since Last Audiogram` day count and `Outcome Status`.

```
PASS  compliant     outcome=COMPLIANT     (11 defines)
PASS  due_soon      outcome=DUE_SOON      (11 defines)
PASS  overdue       outcome=OVERDUE       (11 defines)
PASS  missing_data  outcome=MISSING_DATA  (11 defines)
PASS  excluded      outcome=EXCLUDED      (11 defines)
✅ GOLDEN PARITY: all scenarios match Java exactly
```

## How Path C works here (no JVM at runtime)

1. **Build time (Java, the only Java on the path):** `gradlew generateElm` runs
   `com.workwell.engine.cli.ElmCompilerCli`, which uses the cqframework
   `cql-to-elm` translator (already on the backend classpath) to compile
   `audiogram.cql` → `elm/AnnualAudiogramCompleted-1.0.0.elm.json` plus its one
   dependency `elm/FHIRHelpers-4.0.1.elm.json`. The ELM JSON is committed.
2. **Run time (Node, no JVM):** `cql-execution` + `cql-exec-fhir` execute the
   committed ELM against a FHIR R4 bundle. `cql-exec-fhir` maps the bundle into
   the CQL data model; the evaluation timestamp is pinned so `Now()`/`Today()`
   match the Java run.

Audiogram uses **inline code filters** (not ValueSet expansion), so no terminology
service is needed — the codes in the bundle match the CQL directly.

## Reproduce

```bash
# 1. (re)generate ELM from CQL via the Java translator  [build-time only]
cd backend && ./gradlew.bat generateElm \
  --args="src/main/resources/measures/audiogram.cql ../backend-ts/spike/elm"

# 2. (re)generate the Java golden outputs               [reference engine]
#    for s in compliant due_soon overdue missing_data excluded:
./gradlew.bat evaluateMeasure -q \
  --args="../backend-ts/spike/bundles/<s>.json src/main/resources/measures/audiogram.yaml --date 2026-06-12"
#    → save stdout JSON to backend-ts/spike/golden/<s>.json

# 3. run the parity check (Node engine vs Java golden, define-by-define)
cd ../backend-ts && node spike/compare.mjs        # exit 0 iff all match
```

## Can the *last* Java dependency be removed too? — **Yes (proven)**

Path C (above) keeps Java only as the **build-time** CQL→ELM translator (`ElmCompilerCli`).
The remaining question: can even that go, for a **100% Java-free** toolchain?

**Answer: yes.** The cqframework reference translator now ships an official **pure-Node**
build — [`@cqframework/cql`](https://www.npmjs.com/package/@cqframework/cql) (v4.0.0-beta.1,
Apache-2.0) — a **Kotlin-Multiplatform** compile of the *same* translator source to JavaScript
(no JVM). `spike/cqf-translate.mjs` translates `audiogram.cql` → ELM in Node, and that ELM
evaluates **identically to the Java engine**:

```
node spike/cqf-translate.mjs                  # CQL → ELM in pure Node (no JVM), errors=0
node spike/compare.mjs spike/elm-js           # evaluate that ELM vs the Java golden
✅ GOLDEN PARITY: all scenarios match Java exactly
```

**Validated across ALL 10 measures, not just Audiogram:**

```
node spike/cqf-translate.mjs ../backend/src/main/resources/measures spike/elm-js   # 10 measures, errors=0
node spike/compare-all.mjs spike/elm-js                                            # Node-translated ELM vs Java golden
✅ 40/40 scenarios match Java exactly (452 define comparisons, 10 measures × 4 scenarios)
```

It needs three **standard, version-stable** resources supplied once (committed config, not a
Java dependency): `system-modelinfo.xml`, `fhir-modelinfo-4.0.1.xml`, `FHIRHelpers-4.0.1.cql`.
These are extracted from the cqframework `model`/`quick` artifacts (see below); the translator
is the same codebase as the JVM one (Kotlin → JVM **and** JS), so correctness lineage is shared.

**Decision (per Doug's #96 — zero Java/Spring Boot, no functional compromise):** adopt
`@cqframework/cql` as the CQL→ELM translator so **Java/JVM leaves the project entirely** —
runtime, build, **and** authoring. The full-catalog golden-parity harness (`compare-all.mjs`) is
the **regression gate**: it must stay green on any `@cqframework/cql` bump or measure change.
The beta version is **pinned**, and the Java `ElmCompilerCli` is retained transitionally as a
cross-check/fallback until the TS engine binding lands (#106), then removed with the rest of Java.
(Reproduce the resource extraction:
`unzip -j <gradle-cache>/.../quick-3.29.0.jar org/hl7/fhir/fhir-modelinfo-4.0.1.xml org/hl7/fhir/FHIRHelpers-4.0.1.cql`
and `.../model-3.29.0.jar org/hl7/elm/r1/system-modelinfo.xml` into `spike/cqf-resources/`.)

## Layout

```
spike/
├─ elm/        Java-translated ELM JSON (committed artifact — the Path C output)
├─ bundles/    5 FHIR R4 patient bundles, one per outcome bucket
├─ golden/     Java engine output per scenario (the reference to match)
├─ parity.mjs  run one bundle through the Node engine, print defines
└─ compare.mjs run all 5, diff Node vs Java define-by-define, exit non-zero on any drift
```

## All 10 measures (#106) — **40/40 exact**

Scaled the proof to the whole runnable catalog. For all 10 measures × 4 scenarios
(`present_recent` / `present_old` / `missing` / `excluded`), the Node engine matches
the Java engine on **every define** — **452 define comparisons, 0 divergences**.

```
node spike/compare-all.mjs
  PASS  audiogram/…  hazwoper/…  tb_surveillance/…  flu_vaccine/…  hypertension/…
        diabetes_hba1c/…  obesity_bmi/…  cholesterol_ldl/…  cms125/…  cms122/…
✅ 40/40 scenarios match Java exactly (452 define comparisons, 10 measures × 4 scenarios)
```

Covered the structurally-different measures explicitly:
- **cms122** (eCQM, *value-based*): outcome driven by the HbA1c `Observation.value > 9`, not recency.
- **cms125** (eCQM): 27-month (820-day) window.
- **flu_vaccine** (*season-based*): uses the `Measurement Period` parameter (`occurrence during …`) — Node passes the **same** 12-month period the Java engine builds.
- **hazwoper / tb** (*count-based enrollment*): `exists([Condition])` / `Count([Condition]) > 1`.

### The risk that turned out to be absent
All 10 measures use **inline code filters** (`x.system = '<vs-urn>' and x.code = '<code>'`),
**zero `in "ValueSet"` membership** — so `cql-execution` needs **no terminology/ValueSet
expansion service**. The big feared Path C risk does not exist in the current catalog. (If a
future measure adopts real ValueSet membership, a code service with expanded value sets would
be wired then — out of scope here.)

### Harness (multi-measure)
```bash
node spike/gen-bundles.mjs          # 10 measures × 4 scenarios → spike/synthetic/<id>/<scenario>.json
cd ../backend && ./gradlew.bat batchEvaluate \
  --args="src/main/resources/measures ../backend-ts/spike/synthetic 2026-06-12"   # Java goldens (one JVM)
cd ../backend-ts && node spike/compare-all.mjs        # Node vs Java, define-by-define; exit 0 iff all match
```

> Note: the 100-distinct-employee suite (vs these 40 representative scenario bundles) is a
> natural follow-on, but the per-measure CQL feature coverage that mattered for Path C — recency
> math, value thresholds, season windows, exclusions, missing data — is fully proven here.
