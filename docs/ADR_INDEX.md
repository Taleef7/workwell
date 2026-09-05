# ADR Index (always-loaded extract)

> **Titles only.** `docs/DECISIONS.md` is authoritative and may be ahead of this file; open it for the
> reasoning, alternatives and consequences. This exists so a session knows a decision *exists* and
> roughly what it says (~1.1k tokens, vs ~44k for the bodies). Regenerate after adding an ADR:
> `grep -o '^#\+ ADR-[0-9]*.*' docs/DECISIONS.md`, newest first. If the highest number here is lower
> than the highest there, this file is stale.
>
> **`·archived`** (14 of 71) means the BODY moved to `docs/archive/DECISIONS_ARCHIVE.md` — superseded,
> or a historical *finding* rather than a decision that governs. `DECISIONS.md` keeps every heading plus
> a pointer, so every cross-reference still resolves. The 57 unmarked titles are the record that governs.
>
> **ADR-033 does not exist** — the sequence runs 031, 032, 034. Verified absent 2026-07-29. Do not reuse it.

## Titles (newest first)

- ADR-072: a measure is runnable when it is authored OR official-only-and-routed — and an eCQM is scored over its calendar year, not a rolling window
- ADR-071: official-only measures take the vendored manifest's id — and a legacy catalog row is deprecated, never rewritten
- ADR-070: the spearhead moves to a patient-driven pilot deployment — and the ACO's measure set finds the engine five-sixths already built
- ADR-069: population membership applies the CQM IG's formulas per subject — and spec application is silent where corruption is loud
- ADR-068: the OpenAPI document covers the PROMISED surface only, and a routed-path test is what makes hand-authoring defensible
- ADR-067: CDS Hooks cards render a completed evaluation and never trigger one — and the outcome-to-card mapping is ours, which is stated rather than implied
- ADR-066: the documentation splits into a maintained guide and a dated archive — because a doc that explains and a doc that records rot at different speeds
- ADR-065: an authored regulatory measure is verified by traceability and adversarial cases — no external oracle exists, and none can be manufactured
- ADR-064: one UCUM validator, shared by every translator we run — and an honest table rather than a new dependency
- ADR-063: a package is publishable when its tarball runs outside the workspace — not when it is published
- ADR-062: codegen is not the engine, and a consumer that shares no code with the app is the only proof the split worked
- ADR-061: the compliance API says where its numbers came from, and 404s rather than answering an absence
- ADR-060: a translator gap and an engine gap are different findings, so the conformance harness never merges them
- ADR-059: the engine takes its measure content INJECTED — and the test-edge blocker dissolved rather than being paid
- ADR-058: QRDA III carries QDM identity, which the FHIR lineage does not have — so the verification bar moves to the FHIR column rather than the label moving to the QDM one
- ADR-057: The live third-party WebChart path derives the two elements our SQL mappers add — because reading a server's own "female" as not-female is also an inference, and a worse one
- ADR-056: A batch import and an import-driven finalize — the two routes the certification loop needed, and the guard that keeps finalize from being a "finish this run" button  ·archived
- ADR-055: What a QDM datatype becomes in FHIR is read off the artifact's own ELM retrieves — and the importer is now measured against a third party's answers  ·archived
- ADR-054: CMS130 and CMS165 onboard clean — the credentialed workflow's completion flag was already doing the capped-expansion work ADR-041 built it for  ·archived
- ADR-053: "the terminology is complete" was only ever a claim about what the bundle DECLARED
- ADR-052: the app-side exclusions are decided and enforced; what the package does with CONTENT is not
- ADR-051: QRDA Category I import is a mapping into the unchanged engine — and it proved the export only works in real terminology  ·archived
- ADR-050: QRDA Category I is a patient-DATA document, measured against the HL7 base IG — not the CMS Hospital one
- ADR-049: QRDA Category I exists, reports population membership only, and says so in the document *(central claim superseded by ADR-050)*  ·archived
- ADR-048: The TRANSLATOR debt is paid; the CLI-surface debt is not, and the split is not a file move  ·archived
- ADR-047: A measure is onboarded when its MADiE gate is green — vendoring is not onboarding
- ADR-046: Canonical, improvementNotation and membership all derive from the outcome's own evidence
- ADR-045: The flip is a WORKFLOW edit, gated by tests that read what the workflow ships — and cms125 goes alone
- ADR-044: One real mammogram is emitted in BOTH vocabularies — dual-stamping is normalization, and the flip gate gets a command
- ADR-043: A whole roster out of the initial population is SURFACED at runtime and ENFORCED at the flip gate — never refused mid-run
- ADR-042: The WebChart↔official IPP gap is closed by mapping and guarded by a parity gate — not by refusing the configuration (the NUMERATOR gap stays open)
- ADR-041: A capped official expansion is completed at vendor time, from a pinned VSAC release, or not at all
- ADR-040: The engine declares the logic it runs; the incremental cache never infers it
- ADR-039: The shadow diff is a shadow of the runtime, not a study of its own  ·archived
- ADR-038: The synthetic corpus is verified against the official artifact's own terminology  ·archived
- ADR-037: Official execution prepares bundles for QI-Core — normalization only, never fabrication
- ADR-036: Official terminology is the artifact's own, fetched at build and pinned by hash — not our VSAC import
- ADR-035: Incremental/delta batch evaluation is a descriptive, inert-unless-configured cache (#263)
- ADR-034: Standalone WCDB FHIR shim package (`wcdb-fhir-shim/`) owns the MariaDB driver; CQL→SQL generation stays pure in backend-ts
- ADR-032: A local HAPI FHIR server is the WebChart simulator ("fake WebChart")
- ADR-031: MeasureReport exports use membership-label counts and binding-owned measure semantics
- ADR-030: Durable evidence storage is an app-level S3 seam (`resolveBucket`), not a binding-config change (#167 / #270)
- ADR-029: Immunization forecasting is a self-hosted ICE sidecar behind the existing port — the stub is replaced by a real adapter (#76 / D18)
- ADR-028: WebChart transport implements the verified public FHIR contract — SMART Backend Services auth (dual-mode) + per-resource composition — E12 PR-2c (#262)
- ADR-027: Production CMS122/CMS125 evaluate eCQI v14 faithful-subset CQL (not toy day-count rules); literal QICore remains diagnostic — 2026-07  ·archived
- ADR-026: `fqm-execution` as a diagnostic-only dependency for the LITERAL official-CQL execution diff (pre-shipped ELM, no translation) — E14 literal diff (#258)
- ADR-025: Measure execution is pluggable behind a `MeasureExecutor` seam; FHIR-native is the default + correctness oracle, CQL→SQL is a parity-gated future executor — E9 (#78)
- ADR-024: Official CMS122 fidelity via a faithful subset, not the literal QICore CQL — E14 PR-3 (#186)  ·archived
- ADR-023: Live VSAC value-set resolution behind the `ValueSetResolver` port (composite, inert-unless-configured, descriptive-only) — E14 PR-3 on-ramp
- ADR-022: Cross-system identity is a read-time resolution layer (match-don't-auto-merge; human-in-the-loop) — E15 PR-1 (#187)
- ADR-021: Quality-over-time is a materialized AGGREGATE snapshot store (numerator/denominator per measure/month/scope) — E16 PR-1
- ADR-020: Population scale via generated outcomes + encoded `subject_id` + SQL aggregation (provider-leaf) — E13 PR-2 (#185)
- ADR-019: Multi-tenant rollup modeled in the read-time synthetic directory; cross-system aggregate root — E13 PR-1 (#185)
- ADR-018: Standards fidelity is structural/definitional-first; official-CQL execution deferred — E14 (#186)  ·archived
- ADR-017: E12 data ingress is FHIR-native-first; adapters feed the unchanged engine (no CQL→SQL transpile) — E12 (#184)
- ADR-016: Segments / risk-groups are an applicability layer, not a compliance authority — E11.3 (#183)
- ADR-015: CQL is canonical; rule-params compile to CQL (codegen) — E11.1 (#183)
- ADR-014: CQL→SQL bridge (charter Q2) — recommendation recorded, decision DEFERRED to Doug  ·archived
- ADR-013: E7 order-proposal engine — `ProposedOrder`/`StandingOrderProvider` port (EH-ready, simulated by default)
- ADR-012: E6 immunization & forecasting — `ImmunizationForecast` port (ICE-ready, simulated by default) + AIS-E Td/Tdap measure
- ADR-011: E5 outreach at scale — multi-channel `OutreachChannel` port + staged (audit-backed → Pg) campaign persistence
- ADR-010: E4 multi-level hierarchy — provider = attributed clinician, modeled in the synthetic directory (no DB schema)
- ADR-009: Emit eCQM artifacts JVM-free; QRDA III as a structurally-representative stub  ·archived
- ADR-008: De-Java the backend — re-platform onto TypeScript / `@mieweb/cloud` (strangler-fig)
- ADR-007: Vendor `@mieweb/datavis` (NITRO grid) source to unblock the data grid
- ADR-006: Declarative YAML measure definitions + headless evaluator CLI
- ADR-005: Measure engine ports/adapters (same module, synthetic default adapter)
- ADR-004: Adopt `@mieweb/ui` as the frontend component library (dark mode + Enterprise Health brand)
- ADR-001: Single Spring Boot deployable with modular package boundaries  ·archived
- ADR-003: Single all-encompassing TWH instance (consolidation from three-instance model)
- ADR-002: evidence_json shape and define-level traceability
