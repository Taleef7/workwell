"use client";

import { useState } from "react";
import { OUTCOME_LABELS, labelFor } from "@/lib/status";
import { emitToast } from "@/lib/toast";
import type { ApiClient } from "@/lib/api/client";
import type { TestFixture } from "../types";

type Props = {
  measureId: string;
  api: ApiClient;
  initialFixtures: TestFixture[];
  onSaved: () => void;
  onError: (msg: string) => void;
};

export function TestsTab({ measureId, api, initialFixtures, onSaved, onError }: Props) {
  const [fixtures, setFixtures] = useState<TestFixture[]>(initialFixtures);
  const [testFailures, setTestFailures] = useState<string[]>([]);

  function update(index: number, field: keyof TestFixture, value: string) {
    setFixtures((current) => current.map((f, i) => (i === index ? { ...f, [field]: value } : f)));
  }

  function add() {
    setFixtures((current) => [...current, { fixtureName: "", employeeExternalId: "", expectedOutcome: "COMPLIANT", notes: "" }]);
  }

  function remove(index: number) {
    setFixtures((current) => current.filter((_, i) => i !== index));
  }

  async function save() {
    onError("");
    try {
      await api.put(`/api/measures/${measureId}/tests`, { fixtures });
      emitToast("Test fixtures saved");
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Tests save failed");
    }
  }

  async function validate() {
    onError("");
    try {
      const payload = await api.post<undefined, { passed: boolean; failures: string[] }>(`/api/measures/${measureId}/tests/validate`);
      setTestFailures(payload.failures ?? []);
      emitToast(payload.passed ? "Test fixtures are valid" : "Test fixtures need fixes");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Test validation failed");
    }
  }

  return (
    <div className="grid gap-3 rounded-md border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Fixture Validation</h3>
        <div className="flex gap-2">
          <button className="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700" onClick={add}>Add Fixture</button>
          <button className="rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white" onClick={save}>Save Tests</button>
          <button className="rounded bg-blue-700 px-2 py-1 text-xs font-medium text-white" onClick={validate}>Validate</button>
        </div>
      </div>

      {fixtures.length === 0 ? <p className="text-sm text-slate-600">No fixtures yet. Add at least one before activation.</p> : null}
      {fixtures.map((fixture, index) => (
        <div key={`${fixture.fixtureName}-${index}`} className="grid gap-2 rounded border border-slate-200 p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-700">Fixture {index + 1}</p>
            <button className="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700" onClick={() => remove(index)}>Remove</button>
          </div>
          <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Fixture Name" value={fixture.fixtureName} onChange={(e) => update(index, "fixtureName", e.target.value)} />
          <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Employee External ID" value={fixture.employeeExternalId} onChange={(e) => update(index, "employeeExternalId", e.target.value)} />
          <select className="rounded border border-slate-300 px-3 py-2 text-sm" value={fixture.expectedOutcome} onChange={(e) => update(index, "expectedOutcome", e.target.value)}>
            <option value="COMPLIANT">{labelFor(OUTCOME_LABELS, "COMPLIANT")}</option>
            <option value="DUE_SOON">{labelFor(OUTCOME_LABELS, "DUE_SOON")}</option>
            <option value="OVERDUE">{labelFor(OUTCOME_LABELS, "OVERDUE")}</option>
            <option value="MISSING_DATA">{labelFor(OUTCOME_LABELS, "MISSING_DATA")}</option>
            <option value="EXCLUDED">{labelFor(OUTCOME_LABELS, "EXCLUDED")}</option>
          </select>
          <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Notes" value={fixture.notes} onChange={(e) => update(index, "notes", e.target.value)} />
        </div>
      ))}
      {testFailures.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-red-700">
          {testFailures.map((entry) => <li key={entry}>{entry}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
