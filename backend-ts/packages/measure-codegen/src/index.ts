/**
 * `@workwell/measure-codegen` — declarative measure rules compiled to canonical CQL.
 *
 * ## Why this is not part of the engine
 *
 * `@workwell/measure-engine` answers "is this patient compliant?" from compiled ELM. This answers a
 * different question — "what CQL expresses this rule?" — and it rode along in the engine package only
 * because both started life under `src/engine/cql/`. They share no code: `generate-cql.ts` has **zero
 * imports**, so the separation costs nothing and states something true. Codegen is authoring-time; the
 * engine is runtime. A consumer who wants to evaluate measures should not have to take a CQL emitter,
 * and a consumer who authors rules in a UI should not have to take a CQL runtime.
 *
 * ## Zero dependencies, deliberately
 *
 * Pure string templating — no engine, no parser, no I/O, no `node:` builtins. It runs anywhere a string
 * concatenation runs, which is what makes it usable from a browser-side rule builder.
 *
 * ## What it does NOT do (ADR-015)
 *
 * It does not decide compliance and it does not execute anything. The CQL it emits is compiled to ELM by
 * the normal build pipeline and executed by the engine, which stays the sole authority on `Outcome
 * Status` (ADR-008). Codegen is a convenience for expressing a rule in the canonical language — never a
 * second way of computing the answer.
 *
 * Two rule shapes are supported: `series-completion` (N doses, optional minimum intervals, optional
 * multi-alternative series) and `windowed-recency` (an event within a window, optional grace period).
 * `validateRule` refuses a rule whose numerics make an outcome unreachable — a fat-fingered
 * `dueSoonDays > windowDays` compiles cleanly and mislabels an entire cohort, so it is rejected at
 * authoring time rather than discovered in a report.
 */
export {
  generateCql,
  validateRule,
  type CodeBinding,
  type CodegenBindings,
  type GenerateCqlInput,
  type Rule,
  type SeriesAlternative,
} from "./generate-cql.ts";
