"use client";

import { useState } from "react";
import { emitToast } from "@/lib/toast";
import { formatStatusLabel, normalizeEnumValue } from "@/lib/status";
import type { ApiClient } from "@/lib/api/client";
import type { MeasureDetail, ValueSetRef } from "../types";
import { valueSetBadgeClass } from "../utils";
import { ValueSetGovernancePanel } from "./ValueSetGovernancePanel";

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

  async function createValueSet() {
    onError("");
    try {
      await api.post("/api/value-sets", { oid, name, version });
      setOid("");
      setName("");
      setVersion("");
      onValueSetsChanged();
      emitToast("Value set created");
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
    <div className="grid gap-3 rounded-md border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-900">Value Set Governance</h3>
      <ValueSetGovernancePanel measureId={measureId} api={api} />

      <h3 className="mt-2 text-sm font-semibold text-slate-900">Attached Value Sets</h3>
      {attached.length ? (
        <ul className="space-y-2">
          {attached.map((vs) => (
            <li key={vs.id} className="flex items-center justify-between rounded border border-slate-200 px-3 py-2 text-sm">
              <div>
                <p className="font-medium text-slate-800">{vs.name}</p>
                <p className="text-xs text-slate-600">{vs.oid} • {vs.version}</p>
                <p className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${valueSetBadgeClass(vs.resolvabilityStatus)}`}>
                  {formatStatusLabel(vs.resolvabilityLabel ?? vs.resolvabilityStatus)}
                </p>
                {normalizeEnumValue(vs.resolvabilityStatus) === "UNRESOLVED" ? <p className="mt-1 text-xs text-amber-700">{vs.resolvabilityNote}</p> : null}
              </div>
              <button className="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700" onClick={() => detach(vs.id)}>Remove</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-600">No value sets attached yet.</p>
      )}

      <h3 className="mt-2 text-sm font-semibold text-slate-900">Create Value Set</h3>
      <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="OID (e.g., urn:oid:...)" value={oid} onChange={(e) => setOid(e.target.value)} />
      <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Version" value={version} onChange={(e) => setVersion(e.target.value)} />
      <div>
        <button className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white" onClick={createValueSet}>Create Value Set</button>
      </div>

      <h3 className="mt-2 text-sm font-semibold text-slate-900">Attach Existing Value Set</h3>
      {available.length ? (
        <ul className="space-y-2">
          {available.map((vs) => (
            <li key={vs.id} className="flex items-center justify-between rounded border border-slate-200 px-3 py-2 text-sm">
              <div>
                <p className="font-medium text-slate-800">{vs.name}</p>
                <p className="text-xs text-slate-600">{vs.oid} • {vs.version}</p>
                <p className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${valueSetBadgeClass(vs.resolvabilityStatus)}`}>
                  {formatStatusLabel(vs.resolvabilityLabel ?? vs.resolvabilityStatus)}
                </p>
              </div>
              <button className="rounded bg-blue-700 px-2 py-1 text-xs font-medium text-white" onClick={() => attach(vs.id)}>Attach</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-600">No value sets available yet.</p>
      )}
    </div>
  );
}
