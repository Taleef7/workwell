# QRDA Category I — Schematron measurement (2026-07-31)

Produced by `backend-ts/scripts/qrda-schematron-check.py` against the CMS RY2026 QRDA I Schematron
(`2026-CMS-QRDA-I-v1.0.sch`, sha256 `1f4e1ff48e80fdd708f3291e212d143afcdd14d8fead9f5427359424dae0abc7`).

**Scope: ONE document per state, built from a hand-made bundle — not a sweep of an endpoint response.**
The script takes a single document; the endpoint returns an envelope of N. Read these as "this document
shape validates", not "every document the route emits validates".

## 1. With QDM patient data (official-routed outcome)

```
### final.xml
    BASE HL7 (our bar):        0 error(s), 25 warning(s)
      of which generic-CDA:    0 (CMS-numbered but binds any CDA)
    CMS Hospital-only:         4 finding(s) — EXPECTED, not our bar

--- BASE HL7 — warnings
    [a-4509-12959-warning] This effectiveTime SHOULD contain zero or one [0..1] low (CONF:4509-12959).
    [a-4509-11670-warning] This effectiveTime SHOULD contain zero or one [0..1] low (CONF:4509-11670).
    [a-67-12864-warning] This externalDocument SHOULD contain zero or one [0..1] code (CONF:67-12864).
    [a-1198-8738-warning] SHOULD contain zero or more [0..*] participant (CONF:1198-8738) such that it SHALL contain exactly one [1..1] @typeCode="LOC" Location (CodeSystem: HL
```

## 2. Without a bundle — the honest one-error state

```
### final-nobundle.xml
    BASE HL7 (our bar):        1 error(s), 8 warning(s)
      of which generic-CDA:    0 (CMS-numbered but binds any CDA)
    CMS Hospital-only:         4 finding(s) — EXPECTED, not our bar

--- BASE HL7 — ERRORS
    [a-67-14567-error] SHALL contain at least one [1..*] entry (CONF:67-14567).

--- BASE HL7 — warnings
    [a-67-12864-warning] This externalDocument SHOULD contain zero or one [0..1] code (CONF:67-12864).
```

## 3. Negative control — a deliberately broken datatype

The `PQ` result replaced with `value="not-a-number" nullFlavor="NI"`. **Before the partition fix this
reported 0 base-HL7 errors and exit 0**, filing a broken datatype under "not our bar" (review, #361).
CMS_0105–0113 and CMS_0115–0120 carry CMS conformance numbers but bind any conformant CDA.

```
### broken.xml
    BASE HL7 (our bar):        1 error(s), 25 warning(s)
      of which generic-CDA:    1 (CMS-numbered but binds any CDA)
    CMS Hospital-only:         4 finding(s) — EXPECTED, not our bar

--- BASE HL7 — ERRORS
    [a-CMS_0110-error] Data types of PQ SHALL have either @value or @nullFlavor but SHALL NOT have both @value and @nullFlavor. If @value is present then @unit SHALL be pres

--- BASE HL7 — warnings
    [a-4509-12959-warning] This effectiveTime SHOULD contain zero or one [0..1] low (CONF:4509-12959).
```

## Exit-code contract

| document | human mode | `--json` |
|---|---|---|
| with patient data | `0` | `0` |
| broken datatype | `1` | `1` |

Both modes share the contract deliberately: `--json` used to return 0 unconditionally, so anything
wiring the machine-readable output into a check would have been a green light that cannot go red.
