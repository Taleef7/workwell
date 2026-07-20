"use client";

import { useState } from "react";
import { Button, Input } from "@mieweb/ui";
import { emitToast } from "@/lib/toast";
import { formatStatusLabel, normalizeEnumValue } from "@/lib/status";
import type { ApiClient } from "@/lib/api/client";
import type { MeasureDetail, ValueSetRef } from "../types";
import { valueSetBadgeClass } from "../utils";
import { ValueSetGovernancePanel } from "./ValueSetGovernancePanel";
import { CodifyCodeSearch, type CodifyResult } from "./CodifyCodeSearch";

/** Canonical FHIR code-system URI for a Codify codetype (fallback: the codetype itself). */
function codeSystemUri(codetype: string): string {
  const uris: Record<string, string> = {
    LOINC: "http://loinc.org",
    SNOMED: "http://snomed.info/sct",
    SNOMEDCT: "http://snomed.info/sct",
    RXNORM: "http://www.nlm.nih.gov/research/umls/rxnorm",
    CVX: "http://hl7.org/fhir/sid/cvx",
    ICD10: "http://hl7.org/fhir/sid/icd-10-cm",
    ICD10CM: "http://hl7.org/fhir/sid/icd-10-cm",
    ICD10PCS: "http://hl7.org/fhir/sid/icd-10-pcs",
    CPT: "http://www.ama-assn.org/go/cpt",
    HCPCS: "urn:oid:2.16.840.1.113883.6.285",
  };
  return uris[codetype.toUpperCase()] ?? codetype;
}

type Props = {
  measure: MeasureDetail;
  measureId: string;
  api: ApiClient;
  allValueSets: ValueSetRef[];
  onChanged: () => void;
  onValueSetsChanged: () => void;
  onError: (msg: string) => void;
};

export function ValueSetsTab({ measure, measureId, api, allValueSets, onChanged, onValueSetsChanged, onError }: Props) {
  const [oid, setOid] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [picked, setPicked] = useState<CodifyResult | null>(null);

  function onCodifyPick(result: CodifyResult) {
    // Prefill the create form from the picked code (author reviews/edits before saving —
    // Codify assists authoring, it never writes anything itself). The OID is a deterministic
    // LOCAL identifier derived from the picked code — Codify's `fullid` is a search-record key,
    // NOT a value-set OID (Codex P1); the author replaces it with a real VSAC OID when one exists.
    setPicked(result);
    setName(result.label);
    setOid(`urn:workwell:codify:${result.codetype.toLowerCase()}:${result.fullcode}`);
  }

  async function createValueSet() {
    onError("");
    try {
      // The picked code is SENT with the create (Codex P1: previously discarded, leaving an empty,
      // unresolvable set) — the new set starts with that code and reads Resolved in governance.
      const codes = picked
        ? [{ code: picked.fullcode, display: picked.label, system: codeSystemUri(picked.codetype) }]
        : undefined;
      await api.post("/api/value-sets", { oid, name, version, ...(codes ? { codes } : {}) });
      setOid("");
      setName("");
      setVersion("");
      setPicked(null);
      onValueSetsChanged();
      emitToast(picked ? "Value set created with the picked code" : "Value set created");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Value set create failed");
    }
  }

  async function attach(valueSetId: string) {
    onError("");
    try {
      await api.post(`/api/measures/${measureId}/value-sets/${valueSetId}`);
      onChanged();
      emitToast("Value set attached");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Value set link failed");
    }
  }

  async function detach(valueSetId: string) {
    onError("");
    try {
      await api.delete(`/api/measures/${measureId}/value-sets/${valueSetId}`);
      onChanged();
      emitToast("Value set removed");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Value set unlink failed");
    }
  }

  const attached = measure.valueSets ?? [];
  const attachedIds = new Set(attached.map((vs) => vs.id));
  const available = allValueSets.filter((vs) => !attachedIds.has(vs.id));

  return (
    <div className="grid gap-3 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Value Set Governance</h3>
      <ValueSetGovernancePanel measureId={measureId} api={api} />

      <h3 className="mt-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">Attached Value Sets</h3>
      {attached.length ? (
        <ul className="space-y-2">
          {attached.map((vs) => (
            <li key={vs.id} className="flex items-center justify-between rounded border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-sm">
              <div>
                <p className="font-medium text-neutral-800 dark:text-neutral-200">{vs.name}</p>
                <p className="text-xs text-neutral-600 dark:text-neutral-400">{vs.oid} • {vs.version}</p>
                <p className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${valueSetBadgeClass(vs.resolvabilityStatus)}`}>
                  {formatStatusLabel(vs.resolvabilityLabel ?? vs.resolvabilityStatus)}
                </p>
                {normalizeEnumValue(vs.resolvabilityStatus) === "UNRESOLVED" ? <p className="mt-1 text-xs text-amber-700">{vs.resolvabilityNote}</p> : null}
              </div>
              <Button variant="secondary" size="sm" onClick={() => detach(vs.id)}>Remove</Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">No value sets attached yet.</p>
      )}

      <h3 className="mt-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">Find a code (Codify)</h3>
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        Search MIE&apos;s Codify terminology (ICD-10, SNOMED, LOINC, RxNorm, CVX, HCPCS…) and prefill the
        form below — search runs in your browser against MIE&apos;s hosted index.
      </p>
      <CodifyCodeSearch onSelect={onCodifyPick} />
      {picked ? (
        <p aria-live="polite" className="text-xs text-neutral-700 dark:text-neutral-300">
          Picked:{" "}
          <span className="rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px]">
            {picked.codetype} {picked.fullcode}
          </span>{" "}
          — {picked.label} <span className="text-neutral-500">(will be added to the new value set)</span>{" "}
          <button type="button" className="underline underline-offset-2 hover:no-underline" onClick={() => setPicked(null)}>
            clear
          </button>
        </p>
      ) : null}

      <h3 className="mt-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">Create Value Set</h3>
      <Input label="OID" hideLabel placeholder="OID (e.g., urn:oid:...)" value={oid} onChange={(e) => setOid(e.target.value)} />
      <Input label="Name" hideLabel placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <Input label="Version" hideLabel placeholder="Version" value={version} onChange={(e) => setVersion(e.target.value)} />
      <div>
        <Button variant="primary" size="sm" onClick={createValueSet}>Create Value Set</Button>
      </div>

      <h3 className="mt-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">Attach Existing Value Set</h3>
      {available.length ? (
        <ul className="space-y-2">
          {available.map((vs) => (
            <li key={vs.id} className="flex items-center justify-between rounded border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-sm">
              <div>
                <p className="font-medium text-neutral-800 dark:text-neutral-200">{vs.name}</p>
                <p className="text-xs text-neutral-600 dark:text-neutral-400">{vs.oid} • {vs.version}</p>
                <p className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${valueSetBadgeClass(vs.resolvabilityStatus)}`}>
                  {formatStatusLabel(vs.resolvabilityLabel ?? vs.resolvabilityStatus)}
                </p>
              </div>
              <Button variant="primary" size="sm" onClick={() => attach(vs.id)}>Attach</Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">No value sets available yet.</p>
      )}
    </div>
  );
}
