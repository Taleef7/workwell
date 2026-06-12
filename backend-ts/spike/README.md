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
