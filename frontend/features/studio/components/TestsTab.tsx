"use client";

import { useState } from "react";
import { Button, Input, Select } from "@mieweb/ui";
import { OUTCOME_LABELS, labelFor } from "@/lib/status";
import { emitToast } from "@/lib/toast";
import type { ApiClient } from "@/lib/api/client";
import type { TestFixture } from "../types";

const EXPECTED_OUTCOME_OPTIONS = [
  { value: "COMPLIANT", label: labelFor(OUTCOME_LABELS, "COMPLIANT") },
  { value: "DUE_SOON", label: labelFor(OUTCOME_LABELS, "DUE_SOON") },
  { value: "OVERDUE", label: labelFor(OUTCOME_LABELS, "OVERDUE") },
  { value: "MISSING_DATA", label: labelFor(OUTCOME_LABELS, "MISSING_DATA") },
  { value: "EXCLUDED", label: labelFor(OUTCOME_LABELS, "EXCLUDED") },
];

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
    <div className="grid gap-3 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Fixture Validation</h3>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={add}>Add Fixture</Button>
          <Button
            variant="outline"
            size="sm"
            onClick={generateFixtures}
            disabled={isGenerating}
            isLoading={isGenerating}
            loadingText="Generating..."
          >
            Generate Fixtures
          </Button>
          <Button variant="primary" size="sm" onClick={save}>Save Tests</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={validate}
            disabled={isValidating}
            isLoading={isValidating}
            loadingText="Validating…"
          >
            Validate
          </Button>
        </div>
      </div>

      {generatedFixtures.length > 0 ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-amber-800">AI-generated fixtures</p>
            <Button type="button" variant="outline" size="sm" onClick={addAllGeneratedFixtures}>
              Add All to Drafts
            </Button>
          </div>
          <p className="mt-1 text-xs text-amber-900">
            AI-generated fixtures — verify expected outcomes match your CQL logic before running.
          </p>
          <div className="mt-3 grid gap-2">
            {generatedFixtures.map((fixture, index) => (
              <div key={`${fixture.name}-${index}`} className="rounded border border-amber-200 bg-white dark:bg-neutral-900 p-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">{fixture.name}</p>
                    <p className="text-xs text-neutral-600 dark:text-neutral-400">Expected: {labelFor(OUTCOME_LABELS, fixture.expectedOutcome)}</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => addGeneratedFixture(fixture, index)}
                  >
                    Add to Draft
                  </Button>
                </div>
                <pre className="mt-2 overflow-x-auto rounded bg-neutral-50 dark:bg-neutral-800/50 p-2 text-[11px] text-neutral-700 dark:text-neutral-300">
                  {JSON.stringify(fixture.inputData, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {fixtures.length === 0 ? <p className="text-sm text-neutral-600 dark:text-neutral-400">No fixtures yet. Add at least one before activation.</p> : null}
      {fixtures.map((fixture, index) => (
        <div key={`${fixture.fixtureName}-${index}`} className="grid gap-2 rounded border border-neutral-200 dark:border-neutral-800 p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">Fixture {index + 1}</p>
            <Button variant="secondary" size="sm" onClick={() => remove(index)}>Remove</Button>
          </div>
          <Input label="Fixture Name" hideLabel placeholder="Fixture Name" value={fixture.fixtureName} onChange={(e) => update(index, "fixtureName", e.target.value)} />
          <Input label="Employee External ID" hideLabel placeholder="Employee External ID" value={fixture.employeeExternalId} onChange={(e) => update(index, "employeeExternalId", e.target.value)} />
          <Select
            label="Expected outcome"
            hideLabel
            aria-label="Expected outcome"
            value={fixture.expectedOutcome}
            onValueChange={(value) => update(index, "expectedOutcome", value)}
            options={EXPECTED_OUTCOME_OPTIONS}
          />
          <Input label="Notes" hideLabel placeholder="Notes" value={fixture.notes} onChange={(e) => update(index, "notes", e.target.value)} />
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
