/**
 * CDS Hooks card assembly (ADR-067) — pure, no I/O, no DB, no env.
 *
 * ## The mapping is OURS, and that is stated rather than implied
 *
 * HL7's blessed route from measure logic to cards is `PlanDefinition/$apply` → `RequestOrchestration` →
 * cards ("CDS Hooks is a wrapper around `PlanDefinition/$apply`", FHIR Clinical Reasoning). DEQM's
 * `$care-gaps` stops at a `DetectedIssue` and **no published mapping carries a care gap into a card.** So
 * this file is a LOCAL mapping from `outcomes.evidence_json` to cards. It is precedented at the
 * CDS-Hooks-mechanics layer (AHRQ's CQL Services, CQF Ruler) and unprecedented at the gap→card leg;
 * `docs/STANDARDS_CONFORMANCE.md` says exactly that.
 *
 * ## Nothing here decides anything
 *
 * Every field is derived from an already-persisted CQL outcome by the SAME readers the roster and the case
 * detail use — `deriveCell` for the display state and its plain-English method, `deriveWhyFlagged` for the
 * dates, `priorityFor`/`nextActionFor` for urgency and the action line. A second implementation of any of
 * those is the defect class ADR-031 exists to prevent, so there is none here.
 */
import { deriveCell } from "../compliance/roster-vocabulary.ts";
import { deriveWhyFlagged } from "../case/case-detail-read-model.ts";
import { dispositionFor, nextActionFor, priorityFor } from "../case/case-logic.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { proposeOrders } from "../order/order-proposal.ts";
import { dedupeKeyFor, toServiceRequest, type ProposedOrder } from "../order/proposed-order.ts";
import { orderForMeasure } from "../order/order-catalog.ts";
import type { StandingOrderProvider } from "../order/standing-order-provider.ts";
import { DEPLOYMENT_PROFILE, subjectNoun } from "../config/deployment-profile.ts";
import type { CdsCard, CdsSuggestion } from "./types.ts";

/** The spec caps `summary` at 140 characters; a long measure name must not silently break conformance. */
const SUMMARY_MAX = 140;

const SOURCE_LABEL = "WorkWell Measure Studio";

/** Occupational deployments report a waiver; clinical-quality deployments report an exclusion. */
const WAIVER_FACT_LABEL = subjectNoun(DEPLOYMENT_PROFILE).singular === "patient" ? "Exclusion" : "Waiver";

/** One finalized outcome, newest for its measure. */
export interface CardInput {
  measureId: string;
  status: string;
  evidence: unknown;
  evaluationPeriod: string;
  runId: string;
  evaluatedAt: string;
}

export interface CardOptions {
  /** The WorkWell subject id, already resolved from `context.patientId`. */
  subjectId: string;
  /**
   * The id the CDS CLIENT sent, which is the only one it can act on.
   *
   * These differ on a live tenant: WorkWell persists subjects as `wc|4821` while the hook supplies `4821`.
   * The internal id keys outcome lookup, dedupe and card identity; **this** one goes into any FHIR resource
   * we hand back, because `Patient/wc|4821` names nothing in the client's namespace and `|` is not even a
   * legal FHIR id — a suggestion carrying it could not be applied (review).
   */
  patientId: string;
  /**
   * `"{system}|{code}"` for every order code carrying an **APPROVED** terminology mapping. Passed in
   * rather than read here, so this module stays pure — and read from the STORE by the caller, not from
   * the seed array, so approving a mapping unlocks a suggestion without a code change.
   */
  approvedOrderCodes: ReadonlySet<string>;
  standingOrders: StandingOrderProvider;
  /** Absolute origin of the Studio UI. When absent, cards carry no links (never a broken one). */
  studioBaseUrl?: string;
  /** `YYYY-MM-DD` for the proposed order's `authoredOn`. Defaults to today. */
  authoredOn?: string;
}

const measureName = (measureId: string): string =>
  MEASURE_CATALOG.find((m) => m.id === measureId)?.name ?? measureId;

const isDeprecated = (measureId: string): boolean =>
  MEASURE_CATALOG.find((m) => m.id === measureId)?.status === "Deprecated";

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Sentence-case a display state for a card summary: `MISSING_DATA` → `missing data`. */
function humanState(state: string): string {
  return state.toLowerCase().replace(/_/g, " ");
}

/**
 * SHA-256 of the parts, rendered as a **conformant** UUID. Deterministic, so nothing is persisted.
 *
 * Version and variant bits are set — version **8**, the RFC 9562 "custom" form, which is exactly what this
 * is, and variant `10xx`. CDS Hooks types `card.uuid` as a UUID, so a client that validates the version
 * nibble, or stores it in a native `uuid` column, would reject a bare hash (review).
 *
 * Parts are joined on a space, which none of a run id, subject id or measure id contains, so the
 * derivation is unambiguous. An earlier revision joined on a literal NUL byte a `sed` run had introduced
 * by accident: a control character in source makes `grep` report the file as binary, which is how it was
 * found. Use a visible separator here, never an invisible one.
 */
async function deterministicUuid(...parts: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join(" "));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A card's identity, derived rather than stored.
 *
 * The feedback endpoint reports outcomes against `card.uuid`, so a service that wants feedback must be
 * able to resolve a uuid back to what it was a card ABOUT. Deriving it from `(runId, subjectId, measureId)`
 * means that resolution is a recomputation, not a lookup — which is why this feature needs **no schema
 * change**, and schema changes are the owner's alone (CLAUDE.md).
 */
export const cardUuid = (runId: string, subjectId: string, measureId: string): Promise<string> =>
  deterministicUuid("card", runId, subjectId, measureId);

export const suggestionUuid = (runId: string, subjectId: string, measureId: string): Promise<string> =>
  deterministicUuid("suggestion", runId, subjectId, measureId);

/**
 * The card WorkWell returns when it has nothing measured for this patient.
 *
 * **Not `{"cards": []}`.** An empty card list at the point of care reads as "no gaps", which is precisely
 * the confusion ADR-061's 404 exists to prevent — and because a hook's `context.patientId` is a bare EHR
 * id while WorkWell persists live subjects as `wc|<patientId>`, an id-namespace mismatch would otherwise
 * be indistinguishable from a clean bill of health. Silence is reserved for a subject we DID evaluate and
 * found compliant.
 *
 * Also not `412 Precondition Failed`: that status means the service could not retrieve necessary FHIR
 * data, and this is a truthful "nothing has been evaluated yet".
 */
export function noEvaluationCard(patientId: string, studioBaseUrl?: string): CdsCard {
  return {
    summary: truncate(`No WorkWell evaluation on record for patient ${patientId}`, SUMMARY_MAX),
    indicator: "info",
    source: { label: SOURCE_LABEL, ...(studioBaseUrl ? { url: studioBaseUrl } : {}) },
    detail:
      "WorkWell has no completed evaluation covering this patient, so no compliance gap can be asserted " +
      "either way. This is the absence of a run — not a statement that the patient is compliant.",
  };
}

/**
 * Did this outcome come from an evaluation that FAILED?
 *
 * `PARTIAL_FAILURE` is terminal, so its rows are served — and per `DATA_MODEL_CONTRACTS.md` §5 a subject
 * whose evaluation threw is persisted as `MISSING_DATA` with `evidence_json = { evaluationError, message }`.
 * That distinction is invisible to `deriveCell`, which falls through to "No record on file", and
 * `nextActionFor` then says "Collect the missing documentation" — asserting a fact about the PATIENT when
 * the truth is that our engine threw (review). On a dashboard that is a tolerable approximation; in someone
 * else's chart it is the same confusion `noEvaluationCard` exists to prevent.
 */
function evaluationErrorOf(evidence: unknown): string | null {
  if (typeof evidence !== "object" || evidence === null) return null;
  const err = (evidence as Record<string, unknown>)["evaluationError"];
  return typeof err === "string" && err.length > 0 ? err : null;
}

/** A card that reports OUR failure as ours, and asserts nothing about the patient. */
function evaluationFailedCard(row: CardInput, studioBaseUrl?: string): CdsCard {
  return {
    summary: truncate(`${measureName(row.measureId)} — could not be evaluated`, SUMMARY_MAX),
    indicator: "info",
    source: {
      label: SOURCE_LABEL,
      ...(studioBaseUrl ? { url: `${studioBaseUrl}/measures/${row.measureId}` } : {}),
    },
    detail:
      `WorkWell could not evaluate this measure for this patient — the evaluation itself failed, so **no ` +
      `compliance gap is being asserted either way**. This is not a statement that documentation is ` +
      `missing from the chart.\n\n_WorkWell run ${row.runId}, ${row.evaluatedAt}._`,
  };
}

function detailFor(row: CardInput, method: string): string {
  const wf = deriveWhyFlagged(row.evidence, row.measureId, row.evaluationPeriod, row.status);
  const lines = [`**${method}.** ${nextActionFor(row.status, row.measureId)}`];
  const facts: string[] = [];
  if (wf.last_exam_date) facts.push(`Last completed: ${wf.last_exam_date}`);
  if (wf.days_overdue != null && wf.days_overdue > 0) facts.push(`Days overdue: ${wf.days_overdue}`);
  facts.push(`Compliance window: ${wf.compliance_window_days} days`);
  if (wf.waiver_status !== "none") facts.push(`${WAIVER_FACT_LABEL}: ${wf.waiver_status}`);
  lines.push(facts.map((f) => `- ${f}`).join("\n"));
  lines.push(`_Computed by CQL and evaluated ${row.evaluatedAt} (WorkWell run ${row.runId})._`);
  return lines.join("\n\n");
}

/**
 * Suggestions are gated on an APPROVED terminology mapping, and the consequence is deliberate.
 *
 * `order-catalog.ts` says its codes are "representative (demo, not billing-certified)". A CDS suggestion
 * is a one-click order into a certified EHR, so only codes whose mapping an operator has actually approved
 * may be offered: today `audiogram` (CPT 92557), `tb_surveillance` (CPT 86580) and `flu_vaccine` (CVX 141).
 * **`cms122` and `cms125` therefore get no suggestion** — their CPT codes have no mapping at all — so the
 * two officially-routed CMS measures carry information and a link. Approving the mapping is a terminology
 * review, not a code change, which is the point of reading `mappingStatus` instead of a hardcoded list.
 */
function suggestionFor(
  row: CardInput,
  proposal: ProposedOrder | undefined,
  approvedOrderCodes: ReadonlySet<string>,
  uuid: string,
  patientId: string,
): CdsSuggestion | undefined {
  if (!proposal) return undefined;
  const key = `${proposal.order.system}|${proposal.order.code}`;
  if (!approvedOrderCodes.has(key)) return undefined;
  return {
    label: `Order ${proposal.order.display}`,
    uuid,
    actions: [
      {
        type: "create",
        description:
          `Draft order proposal for ${proposal.order.display} (${measureName(row.measureId)}). ` +
          `Advisory — a clinician reviews and submits; WorkWell orders nothing.`,
        resource: withClientSubject(toServiceRequest(proposal), patientId),
      },
    ],
  };
}

/**
 * Re-point a proposed order at the id the CLIENT knows the patient by.
 *
 * `toServiceRequest` writes `Patient/<workwell subject id>`, which is correct for our own order-proposal
 * surface and wrong the moment the resource crosses into an EHR: on a live tenant the subject id is
 * `wc|4821`, so the reference names nothing the client can resolve and `|` is not a legal FHIR id anyway.
 * Done here rather than in `toServiceRequest` because that function has an existing caller
 * (`GET /api/orders/proposals`) for which the internal id IS the right answer.
 */
function withClientSubject(resource: unknown, patientId: string): unknown {
  if (typeof resource !== "object" || resource === null) return resource;
  return { ...(resource as Record<string, unknown>), subject: { reference: `Patient/${patientId}` } };
}

/**
 * Build one card per open measure gap.
 *
 * Inclusion reuses `dispositionFor(status) === "OPEN"` — the same predicate that decides whether a run
 * creates a case — rather than a second list of statuses that could drift from it. `COMPLIANT` and
 * `EXCLUDED` produce nothing; `DECLINED` and `IN_PROGRESS` arrive as `deriveCell` display refinements of
 * an open gap, so they are carded without being enumerated here.
 */
export async function buildComplianceCards(
  rows: readonly CardInput[],
  opts: CardOptions,
): Promise<CdsCard[]> {
  const open = rows.filter((r) => dispositionFor(r.status) === "OPEN" && !isDeprecated(r.measureId));
  if (open.length === 0) return [];

  // ONE `proposeOrders` call for the whole subject, so its in-batch dedupe applies: two measures mapping
  // to the same order code (diabetes_hba1c and cms122 both → CPT 83036) collapse to a single proposal,
  // because one order is the correct clinical action. The measure that did not win the collapse gets an
  // information card — correct, and the reason a per-measure call would be wrong.
  const { proposed } = proposeOrders(
    open.map((r) => ({ subjectId: opts.subjectId, measureId: r.measureId, status: r.status })),
    opts.standingOrders,
    opts.authoredOn,
  );
  const proposalByKey = new Map(proposed.map((p) => [p.dedupeKey, p]));
  const claimed = new Set<string>();

  const cards: CdsCard[] = [];
  for (const row of open) {
    // A failed evaluation is OUR problem, reported as ours — never as "no record on file", and never with a
    // suggested order derived from a status the engine did not actually compute.
    if (evaluationErrorOf(row.evidence)) {
      cards.push(evaluationFailedCard(row, opts.studioBaseUrl));
      continue;
    }
    const cell = deriveCell(row.status, row.evidence, row.measureId, row.evaluationPeriod);
    const name = measureName(row.measureId);
    const uuid = await cardUuid(row.runId, opts.subjectId, row.measureId);

    const order = orderForMeasure(row.measureId);
    const key = order ? dedupeKeyFor(opts.subjectId, order) : null;
    // First measure to claim a collapsed proposal carries the suggestion; the rest do not re-offer it.
    const proposal = key && !claimed.has(key) ? proposalByKey.get(key) : undefined;
    if (proposal && key) claimed.add(key);
    const suggestion = suggestionFor(
      row,
      proposal,
      opts.approvedOrderCodes,
      await suggestionUuid(row.runId, opts.subjectId, row.measureId),
      opts.patientId,
    );

    cards.push({
      summary: truncate(`${name} — ${humanState(cell.status)}`, SUMMARY_MAX),
      // `critical` is unrepresentable in `CdsCard` by design — see types.ts.
      indicator: priorityFor(row.status) === "HIGH" ? "warning" : "info",
      source: {
        label: SOURCE_LABEL,
        ...(opts.studioBaseUrl ? { url: `${opts.studioBaseUrl}/measures/${row.measureId}` } : {}),
      },
      detail: detailFor(row, cell.method),
      uuid,
      ...(opts.studioBaseUrl
        ? {
            links: [
              {
                label: "Open in WorkWell",
                url: `${opts.studioBaseUrl}/compliance?subjectId=${encodeURIComponent(opts.subjectId)}`,
                type: "absolute" as const,
              },
            ],
          }
        : {}),
      ...(suggestion ? { suggestions: [suggestion], selectionBehavior: "at-most-one" as const } : {}),
    });
  }
  return cards;
}
