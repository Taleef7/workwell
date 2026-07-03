"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal, ModalHeader, ModalTitle, ModalBody, ModalFooter } from "@mieweb/ui";
import { usePreview } from "./hooks/usePreview";
import { useDirectorySearch } from "./hooks/useDirectorySearch";
import type {
  Segment,
  SegmentCondition,
  SegmentDraft,
  SegmentOverride,
  SegmentRule,
  ConditionAttr,
  ConditionOp,
  OverrideMode,
} from "./types";

type Props = {
  open: boolean;
  initial?: Segment | null;
  activeMeasures: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
  onSave: (draft: SegmentDraft) => Promise<unknown>;
};

// First N preview members surfaced in the live-preview footer.
const PREVIEW_LIMIT = 5;

// Internal editing shape. Each condition carries a stable `id` for React keys ONLY — it is stripped
// when building the API draft. `value` is always a RAW edit-buffer string here (even for op="in");
// it is normalized to string[] for "in" at validity/draft/preview time so commas can be typed freely.
interface EditCondition {
  id: string;
  attr: ConditionAttr;
  op: ConditionOp;
  value: string;
}
interface EditRule {
  match: "ANY" | "ALL";
  conditions: EditCondition[];
}

let cidSeq = 0;
function genId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* jsdom/older runtime without crypto.randomUUID */
  }
  return `c-${Date.now()}-${cidSeq++}`;
}

const emptyRule = (): EditRule => ({ match: "ANY", conditions: [] });
const newCondition = (): EditCondition => ({ id: genId(), attr: "role", op: "contains", value: "" });

// Split the raw "in" buffer into trimmed, non-empty tokens (only at validity / draft / preview time).
const parseInValues = (raw: string): string[] => raw.split(",").map((v) => v.trim()).filter((v) => v !== "");

function seedConditions(rule: SegmentRule | undefined): EditCondition[] {
  if (!rule) return [];
  return rule.conditions.map((c) => ({
    id: genId(),
    attr: c.attr,
    op: c.op,
    value: Array.isArray(c.value) ? c.value.join(", ") : c.value,
  }));
}

// Edit condition → API SegmentCondition (strip `id`; normalize "in" raw string → string[]).
// Scalar values are trimmed (like the "in" parser) so a padded "Welder " can't slip through —
// the backend matcher lower-cases but does not trim, so an untrimmed value would match nobody.
function toApiCondition(c: EditCondition): SegmentCondition {
  if (c.op === "in") return { attr: c.attr, op: c.op, value: parseInValues(c.value) };
  return { attr: c.attr, op: c.op, value: c.value.trim() };
}

function readableError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object") return (o.message as string) || (o.error as string) || raw;
  } catch {
    /* not JSON */
  }
  return raw;
}

function conditionValid(c: EditCondition): boolean {
  if (!c.attr || !c.op) return false;
  if (c.op === "in") return parseInValues(c.value).length > 0;
  return c.value.trim() !== "";
}

const inputClass =
  "rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";

export function SegmentEditorModal({ open, initial, activeMeasures, onClose, onSaved, onSave }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [rule, setRule] = useState<EditRule>(emptyRule());
  const [measureIds, setMeasureIds] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<SegmentOverride[]>([]);
  const [nameById, setNameById] = useState<Record<string, string>>({});
  const [employeeQuery, setEmployeeQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Snapshot of the form as seeded on open, used to detect unsaved edits (Fable M26) so a stray
  // backdrop-click/Escape can't silently discard a multi-condition rule + overrides. Kept in state
  // (not a ref) so it's safe to read during render for the `dirty` comparison below.
  const [initialSnapshot, setInitialSnapshot] = useState<string>("");

  // Re-seed local form state whenever the modal opens for a different segment. This is the canonical
  // "reset state when a prop changes" case: the seed must run synchronously on open so the fields are
  // populated on first paint (deferring would flash stale/empty inputs). Suppress the rule here only.
  useEffect(() => {
    if (!open) return;
    const seedName = initial?.name ?? "";
    const seedDescription = initial?.description ?? "";
    const seedEnabled = initial?.enabled ?? true;
    const seedRule = initial?.rule ? { match: initial.rule.match, conditions: seedConditions(initial.rule) } : emptyRule();
    const seedMeasureIds = initial?.measureIds ? [...initial.measureIds] : [];
    const seedOverrides = initial?.overrides ? initial.overrides.map((o) => ({ ...o })) : [];
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(seedName);
    setDescription(seedDescription);
    setEnabled(seedEnabled);
    setRule(seedRule);
    setMeasureIds(seedMeasureIds);
    setOverrides(seedOverrides);
    setNameById({});
    setEmployeeQuery("");
    setSaving(false);
    setFormError(null);
    setInitialSnapshot(
      JSON.stringify({
        name: seedName,
        description: seedDescription,
        enabled: seedEnabled,
        rule: seedRule,
        measureIds: seedMeasureIds,
        overrides: seedOverrides,
      }),
    );
  }, [open, initial]);

  // True once any field has diverged from the snapshot captured at open. Drives the unsaved-changes
  // confirm on backdrop-click/Escape/Cancel below.
  const dirty = useMemo(
    () => JSON.stringify({ name, description, enabled, rule, measureIds, overrides }) !== initialSnapshot,
    [name, description, enabled, rule, measureIds, overrides, initialSnapshot],
  );

  // Guarded close: an in-progress edit (a multi-condition rule + overrides) must not vanish on a stray
  // backdrop click or Escape press. Both the Modal's overlay-click and Escape handling route through
  // `onOpenChange(false)`, so guarding here covers both triggers in one place; Cancel routes through it
  // too for consistency.
  function requestClose() {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  }

  const hits = useDirectorySearch(employeeQuery);

  // Normalized API rule (ids stripped, "in" values parsed) — used for both the live preview and the draft.
  const apiRule: SegmentRule = useMemo(
    () => ({ match: rule.match, conditions: rule.conditions.map(toApiCondition) }),
    [rule]
  );

  // Membership/preview depends ONLY on the rule + overrides — never on name/measures.
  const ruleValid = useMemo(
    () => rule.conditions.length >= 1 && rule.conditions.every(conditionValid),
    [rule]
  );
  // Saving additionally requires a name and at least one applicable measure.
  const canSave = ruleValid && name.trim() !== "" && measureIds.length >= 1;

  const { preview, previewError } = usePreview(apiRule, overrides, ruleValid);

  function updateCondition(idx: number, patch: Partial<Pick<EditCondition, "attr" | "op" | "value">>) {
    setRule((prev) => ({
      ...prev,
      conditions: prev.conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    }));
  }

  function addOverride(externalId: string, displayName: string) {
    setNameById((prev) => ({ ...prev, [externalId]: displayName }));
    // Preserve an existing override's mode — re-selecting from search must not flip EXCLUDE → INCLUDE.
    setOverrides((prev) =>
      prev.some((o) => o.externalId === externalId) ? prev : [...prev, { externalId, mode: "INCLUDE" as OverrideMode }]
    );
    setEmployeeQuery("");
  }

  function toggleMeasure(id: string) {
    setMeasureIds((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  }

  async function save() {
    if (!canSave || saving) return;
    setSaving(true);
    setFormError(null);
    const draft: SegmentDraft = { name: name.trim(), description, enabled, rule: apiRule, measureIds, overrides };
    try {
      await onSave(draft);
      onSaved();
      onClose();
    } catch (e) {
      setFormError(readableError(e));
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={(o: boolean) => { if (!o) requestClose(); }} size="lg">
      <ModalHeader>
        <ModalTitle>{initial ? "Edit Group" : "New Group"}</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <div className="grid gap-4">
          {formError ? (
            <p role="alert" className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
              {formError}
            </p>
          ) : null}

          {/* Identity */}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col text-xs">
              <span className="mb-1">Group name</span>
              <input aria-label="Group name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col text-xs">
              <span className="mb-1">Description</span>
              <input aria-label="Group description" value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" aria-label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled (gates the roster overlay and case creation)
          </label>

          {/* Rule builder */}
          <div className="grid gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <p className="text-xs font-semibold uppercase text-neutral-500">Cohort rule</p>
            <label className="flex flex-col text-xs">
              <span className="mb-1">Match</span>
              <select aria-label="Match" value={rule.match} onChange={(e) => setRule((prev) => ({ ...prev, match: e.target.value as "ANY" | "ALL" }))} className={`w-32 ${inputClass}`}>
                <option value="ANY">ANY</option>
                <option value="ALL">ALL</option>
              </select>
            </label>
            {rule.conditions.map((c, i) => {
              const isIn = c.op === "in";
              return (
                <div key={c.id} className="grid gap-2 sm:grid-cols-[8rem_8rem_1fr_auto] sm:items-end">
                  <label className="flex flex-col text-xs">
                    <span className="mb-1">Attribute</span>
                    <select aria-label={`condition ${i + 1} attribute`} value={c.attr} onChange={(e) => updateCondition(i, { attr: e.target.value as ConditionAttr })} className={inputClass}>
                      <option value="role">role</option>
                      <option value="site">site</option>
                    </select>
                  </label>
                  <label className="flex flex-col text-xs">
                    <span className="mb-1">Operator</span>
                    <select aria-label={`condition ${i + 1} operator`} value={c.op} onChange={(e) => updateCondition(i, { op: e.target.value as ConditionOp })} className={inputClass}>
                      <option value="equals">equals</option>
                      <option value="contains">contains</option>
                      <option value="in">in</option>
                    </select>
                  </label>
                  <label className="flex flex-col text-xs">
                    <span className="mb-1">{isIn ? "Values (comma separated)" : "Value"}</span>
                    <input
                      aria-label={`condition value ${i + 1}`}
                      value={c.value}
                      placeholder={isIn ? "Plant A, Plant B" : undefined}
                      onChange={(e) => updateCondition(i, { value: e.target.value })}
                      className={inputClass}
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`remove condition ${i + 1}`}
                    onClick={() => setRule((prev) => ({ ...prev, conditions: prev.conditions.filter((_, j) => j !== i) }))}
                    className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                  >
                    Remove
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => setRule((prev) => ({ ...prev, conditions: [...prev.conditions, newCondition()] }))}
              className="justify-self-start rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Add condition
            </button>
          </div>

          {/* Applicable measures */}
          <div className="grid gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <p className="text-xs font-semibold uppercase text-neutral-500">Applicable measures</p>
            <div className="grid gap-1 sm:grid-cols-2">
              {activeMeasures.map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    aria-label={`measure ${m.id}`}
                    checked={measureIds.includes(m.id)}
                    onChange={() => toggleMeasure(m.id)}
                  />
                  {m.name}
                </label>
              ))}
            </div>
          </div>

          {/* Overrides */}
          <div className="grid gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <p className="text-xs font-semibold uppercase text-neutral-500">Membership overrides</p>
            <div className="relative">
              <input
                aria-label="search employees"
                value={employeeQuery}
                placeholder="Search employees to include/exclude…"
                onChange={(e) => setEmployeeQuery(e.target.value)}
                className={`w-full ${inputClass}`}
              />
              {employeeQuery.trim().length >= 2 && hits.length > 0 ? (
                <div className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
                  {hits.map((h) => (
                    <button
                      key={h.externalId}
                      type="button"
                      className="flex w-full flex-col border-b border-neutral-100 px-3 py-2 text-left text-xs last:border-b-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => addOverride(h.externalId, h.name)}
                    >
                      <span className="font-medium text-neutral-900 dark:text-neutral-100">{h.name}</span>
                      <span className="text-neutral-500">{h.externalId} · {h.role} · {h.site}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {overrides.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {overrides.map((o) => (
                  <span key={o.externalId} className="inline-flex items-center gap-1 rounded-full border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700">
                    <span>{nameById[o.externalId] ?? o.externalId}</span>
                    <button
                      type="button"
                      aria-label={`toggle override ${o.externalId}`}
                      onClick={() =>
                        setOverrides((prev) => prev.map((x) => (x.externalId === o.externalId ? { ...x, mode: x.mode === "INCLUDE" ? "EXCLUDE" : "INCLUDE" } : x)))
                      }
                      className={`rounded px-1 text-[10px] font-semibold ${o.mode === "INCLUDE" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"}`}
                    >
                      {o.mode}
                    </button>
                    <button
                      type="button"
                      aria-label={`remove override ${o.externalId}`}
                      onClick={() => setOverrides((prev) => prev.filter((x) => x.externalId !== o.externalId))}
                      className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          {/* Live preview */}
          <div className="grid gap-1 rounded border border-neutral-200 bg-neutral-50 p-3 text-xs dark:border-neutral-800 dark:bg-neutral-950">
            {preview ? (
              <>
                <p className="font-medium">{preview.count} employees match</p>
                {preview.members.length > 0 ? (
                  <p className="text-neutral-500">{preview.members.slice(0, PREVIEW_LIMIT).join(", ")}{preview.members.length > PREVIEW_LIMIT ? "…" : ""}</p>
                ) : null}
              </>
            ) : null}
            {!ruleValid ? (
              <p className="text-neutral-500">Add at least one complete condition to preview membership.</p>
            ) : null}
            {previewError ? <p role="alert" className="text-rose-600 dark:text-rose-400">{previewError}</p> : null}
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        {ruleValid && !canSave ? (
          <span className="mr-auto text-xs text-neutral-500">Add a name and at least one measure to save.</span>
        ) : null}
        <button
          type="button"
          onClick={requestClose}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave || saving}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
