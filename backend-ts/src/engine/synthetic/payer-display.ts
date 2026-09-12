/**
 * Source of Payment Typology codes, and the names a human reads them by.
 *
 * **Why this lives in `src/engine/synthetic/`.** The corpus directory maps `CorpusPatient.payer` onto
 * `EmployeeProfile.payer`, and `engine-boundary.test.ts` forbids `src/engine/**` importing anything
 * outside the engine tree. A display table in `src/compliance/` would therefore be unreachable from the
 * one place that knows a patient's payer. It imports nothing, which is what keeps that rule cheap.
 *
 * **The vocabulary is PHDSC Source of Payment Typology** — the code system the measures' `SDE Payer`
 * reads through the "Payer Type" value set (2.16.840.1.114222.4.11.3591), and the one
 * `corpus-patient.ts` already draws from. We do not invent codes and we do not restrict to the four the
 * corpus happens to emit: a live WebChart Coverage can carry any member, so an unknown code is
 * DISPLAYED AS ITSELF rather than dropped or renamed.
 *
 * **The typology is hierarchical by prefix, and that is load-bearing here.** A top-level category is
 * one digit (`1` Medicare, `2` Medicaid, `5` Private Health Insurance …) and its children extend it
 * (`11` Medicare managed care — what a practice calls Medicare Advantage). So "is this patient
 * Medicare?" is a prefix question, not an equality one. That distinction is the reason `payerGroupOf`
 * exists: on the pilot corpus Medicare is 3,927 patients under `1` plus 2,900 under `11`, and a filter
 * that treats `1` as "Medicare" hides 2,900 people from a list whose heading says it contains them.
 * The FILTER predicate stays exact-match per code (see `subject-filters.ts`) — grouping is a thing the
 * caller does by selecting several codes, never a thing the predicate does behind their back.
 */

/** A payer code paired with what it is called and the top-level category it belongs to. */
export interface PayerDisplay {
  /** The Source of Payment Typology code, exactly as it appears on the profile. */
  readonly code: string;
  /** The name to show. For a code we do not know, this is the code itself. */
  readonly name: string;
  /** The one-digit top-level code this belongs to (`"11"` → `"1"`), or the code itself if not numeric. */
  readonly group: string;
  /** The top-level category's name — `"Medicare"` for both `1` and `11`. */
  readonly groupName: string;
}

/**
 * The names. Top-level categories plus every child the corpus emits or a Maui Coverage plausibly
 * carries. Deliberately NOT exhaustive over the typology: a name we have not checked is worse than
 * showing the code, because a wrong payer name on a work list is indistinguishable from a right one.
 */
const PAYER_NAMES: Readonly<Record<string, string>> = {
  "1": "Medicare",
  "11": "Medicare Advantage",
  "12": "Medicare FFS",
  "13": "Medicare Hospice",
  "14": "Dual eligible (Medicare/Medicaid)",
  "2": "Medicaid",
  "21": "Medicaid Managed Care",
  "22": "Medicaid FFS",
  "3": "Other government",
  "5": "Commercial",
  "6": "BCBS",
  "8": "Self-pay",
  "9": "Other",
};

/** The top-level category names, keyed by the one-digit code. A subset of `PAYER_NAMES` by construction. */
const GROUP_NAMES: Readonly<Record<string, string>> = {
  "1": "Medicare",
  "2": "Medicaid",
  "3": "Other government",
  "5": "Commercial",
  "6": "BCBS",
  "8": "Self-pay",
  "9": "Other",
};

/** Whether a string is a Source of Payment Typology code shape — digits only, 1–2 of them. */
const isTypologyCode = (code: string): boolean => /^[0-9]{1,2}$/.test(code);

/**
 * The top-level category a code belongs to: `"11"` → `"1"`, `"5"` → `"5"`.
 *
 * A code that is not typology-shaped is its own group. That keeps an unrecognised value from being
 * silently folded into whatever category its first character happens to spell.
 */
export function payerGroupOf(code: string): string {
  const trimmed = code.trim();
  if (!isTypologyCode(trimmed)) return trimmed;
  return trimmed.slice(0, 1);
}

/** What to call a payer code. An unknown code is its own name — never blank, never guessed. */
export function payerNameOf(code: string): string {
  const trimmed = code.trim();
  return PAYER_NAMES[trimmed] ?? trimmed;
}

/** What to call a top-level category. An unknown group is its own name, for the same reason. */
export function payerGroupNameOf(group: string): string {
  const trimmed = group.trim();
  return GROUP_NAMES[trimmed] ?? PAYER_NAMES[trimmed] ?? trimmed;
}

/** The full display record for a code. */
export function payerDisplayOf(code: string): PayerDisplay {
  const trimmed = code.trim();
  const group = payerGroupOf(trimmed);
  return {
    code: trimmed,
    name: payerNameOf(trimmed),
    group,
    groupName: payerGroupNameOf(group),
  };
}

/**
 * Every code in `codes` that shares a top-level category with `code` — the set a caller selects when a
 * staff member asks for "Medicare".
 *
 * It takes the codes PRESENT in the directory rather than expanding the typology, so the answer is
 * always a set the filter can actually return rows for. Asking for Medicare on a roster that carries
 * only `11` returns `["11"]`, not `["1", "11", "12", "13", "14"]` whose first four match nobody.
 */
export function payerCodesInGroup(code: string, codes: Iterable<string>): string[] {
  const group = payerGroupOf(code);
  const matched = new Set<string>();
  for (const candidate of codes) {
    const trimmed = candidate.trim();
    if (trimmed && payerGroupOf(trimmed) === group) matched.add(trimmed);
  }
  return [...matched].sort(comparePayerCodes);
}

/**
 * Display order: by top-level category, then by code within it, numerically where both are numeric.
 *
 * Numeric rather than lexicographic because `"11"` sorts before `"2"` as a string, which would put
 * Medicare Advantage between Medicare and Medicaid and make the grouping look arbitrary to the one
 * person the ordering exists for.
 */
export function comparePayerCodes(a: string, b: string): number {
  const groupA = payerGroupOf(a);
  const groupB = payerGroupOf(b);
  if (groupA !== groupB) return compareCodeSegment(groupA, groupB);
  return compareCodeSegment(a.trim(), b.trim());
}

function compareCodeSegment(a: string, b: string): number {
  const numericA = isTypologyCode(a);
  const numericB = isTypologyCode(b);
  // Typology codes sort ahead of anything that is not one, so an unrecognised value from a live
  // Coverage lands at the end of the list rather than in the middle of the categories.
  if (numericA && !numericB) return -1;
  if (!numericA && numericB) return 1;
  if (numericA && numericB) return Number(a) - Number(b);
  return a.localeCompare(b);
}
