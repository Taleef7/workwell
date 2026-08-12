# Guide diagram chronology sweep — 2026-08-12

Date: 2026-08-12. Companion to the `feat/guide-scenarios` PR (chapter 10 + the rebuilt README
one-pager). Scope: the 20 mermaid diagrams in `docs/guide/01-*` through `docs/guide/09-*`.

## Why this sweep

The README one-pager was rebuilt after owner feedback that build-time and run-time content sat side
by side at the top of the diagram — two stages that happen at different times, drawn as peers. That
critique is about a *layout* implying a false order, not about wording, so it generalizes: this
sweep applied the same test to every other mermaid diagram in the guide. The test, stated once and
applied uniformly: **does the diagram depict a process over time, and does its layout imply an order
contradicting the real order?** A diagram that depicts structure rather than process cannot fail it;
a diagram that depicts process passes only if reading order matches execution order. Result: **zero
offenders** — the README diagram was the only one, and it is the only one that changed.

## Verdict table

| Ch | Diagram | Verdict | Reason |
|---|---|---|---|
| 01 | six stages, data in → Postgres → out | TIME-OK | Already TB with stages 1→6 numbered in reading order |
| 02 | the three ways a measure gets written | TIME-OK | Three mutually exclusive paths, not sequential phases; within each path arrows chain in true order |
| 02 | OSHA STS decision tree | TIME-OK | Decision tree read top-down; each branch follows its predecessor |
| 03 | BUILD TIME / RUN TIME two clocks | TIME-OK | Already the house shape: explicit build/run subgraphs, one dashed crossing |
| 03 | the `Overdue` ELM tree | STRUCTURE | An AST; no events |
| 04 | one run, steps 1–17 | TIME-OK | TB, numbered, ascending; branch pairs are genuine alternatives that rejoin |
| 04 | the router | TIME-OK | Routing decision then each path's ordered steps, converging on one output |
| 04 | vendoring a CMS measure, steps 1–12 | TIME-OK | TB, numbered 1→12 in reading order |
| 05 | one bundle, anatomically | STRUCTURE | Composition of a data object |
| 05 | CMS publishes every measure twice | STRUCTURE | Lineage explanation, not a process; the one ordered edge reads downward |
| 05 | WebChart rows become FHIR | TIME-OK | Left-to-right matches SQL read → map → serve |
| 05 | standards documents on the way out | STRUCTURE | Source-to-artifact fan-out; the four exports are independent |
| 06 | the four ways data enters | TIME-OK | Alternative ingress configurations converging on the same spine, whose order is correct |
| 06 | the three databases | STRUCTURE | Deployment/ownership map |
| 06 | what happens to one answer | TIME-OK | TB, strictly ordered outcome → case → audit → rollover → finalize → snapshot |
| 07 | SQL in three places | STRUCTURE | Taxonomy of three unrelated roles |
| 07 | the CQL→SQL bridge parity proof | TIME-OK | Left-to-right matches generate → evaluate → compare; fully offline, no build/run mixture |
| 08 | the published package's inputs | STRUCTURE | Injection picture; the three inputs are simultaneous |
| 09 | how the project got here | TIME-OK | A `timeline`; inherently chronological |
| 09 | the measure funnel | TIME-OK | vendored → gated → routed reads in that order; authored line genuinely parallel |

## The two borderline calls, recorded rather than smoothed over

**Chapter 2's dashed codegen-parity back-edge.** It points backwards against the reading direction,
which is the shape the test is meant to catch. Left as is: the edge asserts a *relation* between two
artifacts (the generated SQL is differentially tested against the engine), not a step that happens
after the ones before it, and it is dashed precisely to say so. The same convention carries the
README one-pager's SQL side-track.

**Chapter 5's "CMS publishes every measure twice".** It has one ordered edge, so it is not purely
structural, and a stricter reading would file it as TIME-OK-with-caveat. Filed as STRUCTURE because
the surrounding prose frames it as *why two versions of the same measure exist* — a lineage
question — rather than as a sequence anybody performs; the single edge reads downward, so either
classification yields the same verdict.
