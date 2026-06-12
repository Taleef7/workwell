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

## What this de-risks (and what's next)

- **De-risked:** the product's differentiator (real CQL/eCQM evaluation) runs in
  Node with byte-equal results — Path C is viable, the JVM leaves the runtime.
- **Still to validate in Phase 3 (#106):** the other 9 runnable measures
  (especially CMS122/CMS125 eCQMs and any using ValueSet expansion rather than
  inline codes), and the full 100-employee × 10-measure golden suite. Audiogram
  is the proof of concept; #106 scales it to 100% parity before cutover.
