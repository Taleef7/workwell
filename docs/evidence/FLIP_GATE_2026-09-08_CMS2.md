# CMS2's flip gate over the whole Maui roster

Date: 2026-09-08. Command, from `backend-ts`:

```bash
WORKWELL_INSTANCE=maui WORKWELL_MAUI_CORPUS_SIZE=20000 WORKWELL_OFFICIAL_MEASURES=cms122,cms125 \
  pnpm flip-gate --measure cms2 --evaluation-date 2026-12-31 --subjects all
```

Report: `backend-ts/.flip-gate/cms2-2026-12-31.json` (gitignored; the numbers below are its content).

| reading | result |
|---|---|
| MADiE — the steward's own expected vectors | **36 of 36** agree, 0 disagree |
| Roster — the artifact over the deployment's own 20,000 corpus patients, routed as `cms122,cms125,cms2` | **17,795 in the initial population and denominator**, 5,413 actionable, **0 evaluation errors** |
| Outcome distribution | COMPLIANT 11,884 · OVERDUE 5,413 · EXCLUDED 498 · MISSING_DATA 2,205 |
| `effectivePeriod` | covers the measured year (2026) |

Verdict printed by the gate: *the three readings agree — evidence FOR the flip; the flip itself is a
workflow edit a human still makes.* The 2,205 MISSING_DATA are subjects outside the initial population
(no qualifying encounter or outside the age band), which the roster shows as OUT_OF_POPULATION and
which open no case (ADR-077 d7, ADR-078 d2).

The run emitted ~18,700 `Failed to locate element for ServiceRequest.performed` lines on stderr — the
cql-exec-fhir model walker warning once per subject that CMS2's ELM reads a path QI-Core's
`ServiceRequest` does not carry. It is noise, not an error: the same warning appears on the MADiE deck,
which agrees 36/36.

Second-engine evidence for the same measure: `CROSS_ENGINE_2026-09-07_CMS2.md` (29 of 36 agree; the
seven disagreements diagnosed to one medication-period helper, on which MADiE's own expected results
side with our engine).
