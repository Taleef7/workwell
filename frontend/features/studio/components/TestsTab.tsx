"use client";

import { useState } from "react";
import { OUTCOME_LABELS, labelFor } from "@/lib/status";
import { emitToast } from "@/lib/toast";
import type { ApiClient } from "@/lib/api/client";
import type { TestFixture } from "../types";

type GeneratedFixture = {
  name: string;
  inputData: {
    examDate: string | null;
    programEnrolled: boolean;
    hasExemption: boolean;
    role?: string;
    site?: string;
  };
  expectedOutcome: string;
};

type Props = {
  measureId: string;
  api: ApiClient;
  initialFixtures: TestFixture[];
  onSaved: () => void;
  onError: (msg: string) => void;
};

export function TestsTab({ measureId, api, initialFixtures, onSaved, onError }: Props) {
  const [fixtures, setFixtures] = useState<TestFixture[]>(initialFixtures);
  const [generatedFixtures, setGeneratedFixtures] = useState<GeneratedFixture[]>([]);
  const [testFailures, setTestFailures] = useState<string[]>([]);
  const [isValidating, setIsValidating] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  function update(index: number, field: keyof TestFixture, value: string) {
    setFixtures((current) => current.map((f, i) => (i === index ? { ...f, [field]: value } : f)));
  }

  function add() {
    setFixtures((current) => [...current, { fixtureName: "", employeeExternalId: "", expectedOutcome: "COMPLIANT", notes: "" }]);
  }

  function remove(index: number) {
    setFixtures((current) => current.filter((_, i) => i !== index));
  }

  function fixtureFromGenerated(generated: GeneratedFixture, index: number): TestFixture {
    const inputDataText = JSON.stringify(generated.inputData);
    const employeeId = `AI-${generated.expectedOutcome}-${index + 1}`;
    return {
      fixtureName: generated.name,
      employeeExternalId: employeeId,
      expectedOutcome: generated.expectedOutcome,
      notes: `AI generated inputData: ${inputDataText}`
    };
  }

  function addGeneratedFixture(generated: GeneratedFixture, index: number) {
    setFixtures((current) => [...current, fixtureFromGenerated(generated, index)]);
  }

  function addAllGeneratedFixtures() {
    setFixtures((current) => [
      ...current,
      ...generatedFixtures.map((fixture, index) => fixtureFromGenerated(fixture, index))
    ]);
  }

  async function generateFixtures() {
    setIsGenerating(true);
    onError("");
    try {
      const payload = await api.post<undefined, GeneratedFixture[]>(`/api/measures/${measureId}/ai/generate-test-fixtures`);
      setGeneratedFixtures(payload ?? []);
      emitToast("AI draft fixtures generated");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Fixture generation failed");
    } finally {
      setIsGenerating(false);
    }
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
    setIsValidating(true);
    try {
      const payload = await api.post<undefined, { passed: boolean; failures: string[] }>(`/api/measures/${measureId}/tests/validate`);
      setTestFailures(payload.failures ?? []);
      emitToast(payload.passed ? "Test fixtures are valid" : "Test fixtures need fixes");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Test validation failed");
    } finally {
      setIsValidating(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-md border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Fixture Validation</h3>
        <div className="flex gap-2">
          <button className="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700" onClick={add}>Add Fixture</button>
          <button
            className="rounded border border-purple-300 bg-white px-2 py-1 text-xs font-medium text-purple-700 disabled:opacity-60"
            onClick={generateFixtures}
            disabled={isGenerating}
          >
            {isGenerating ? "Generating..." : "Generate Fixtures"}
          </button>
          <button className="rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white" onClick={save}>Save Tests</button>
          <button
            className="flex items-center gap-1 rounded bg-blue-700 px-2 py-1 text-xs font-medium text-white disabled:opacity-60"
            onClick={validate}
            disabled={isValidating}
          >
            {isValidating ? (
              <>
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Validating…
              </>
            ) : (
              "Validate"
            )}
          </button>
        </div>
      </div>

      {generatedFixtures.length > 0 ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-amber-800">AI-generated fixtures</p>
            <button
              type="button"
              className="rounded border border-amber-400 bg-white px-2 py-1 text-xs font-semibold text-amber-900"
              onClick={addAllGeneratedFixtures}
            >
              Add All to Drafts
            </button>
          </div>
          <p className="mt-1 text-xs text-amber-900">
            AI-generated fixtures — verify expected outcomes match your CQL logic before running.
          </p>
          <div className="mt-3 grid gap-2">
            {generatedFixtures.map((fixture, index) => (
              <div key={`${fixture.name}-${index}`} className="rounded border border-amber-200 bg-white p-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold text-slate-900">{fixture.name}</p>
                    <p className="text-xs text-slate-600">Expected: {labelFor(OUTCOME_LABELS, fixture.expectedOutcome)}</p>
                  </div>
                  <button
                    type="button"
                    className="rounded border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700"
                    onClick={() => addGeneratedFixture(fixture, index)}
                  >
                    Add to Draft
                  </button>
                </div>
                <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700">
                  {JSON.stringify(fixture.inputData, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      ) : null}

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
