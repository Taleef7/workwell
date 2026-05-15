"use client";

import { useCallback, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import type { Monaco, OnChange, OnMount } from "@monaco-editor/react";
import { emitToast } from "@/lib/toast";
import { formatStatusLabel } from "@/lib/status";
import type { ApiClient } from "@/lib/api/client";
import type { MeasureDetail } from "../types";
import { compileStatusClass, formatIssue, parseCompileIssue } from "../utils";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[400px] items-center justify-center rounded-md border border-slate-200 bg-slate-950 text-sm text-slate-200">
      Loading editor...
    </div>
  )
});

const BACKEND_MARKER_OWNER = "backend-compile";

type Props = {
  measure: MeasureDetail;
  measureId: string;
  api: ApiClient;
  cqlText: string;
  onCqlChange: (value: string) => void;
  compileErrors: string[];
  compileWarnings: string[];
  onCompileErrors: (errors: string[]) => void;
  onCompileWarnings: (warnings: string[]) => void;
  onCompiled: () => void;
  onError: (msg: string) => void;
};

export function CqlTab({
  measure,
  measureId,
  api,
  cqlText,
  onCqlChange,
  compileErrors,
  compileWarnings,
  onCompileErrors,
  onCompileWarnings,
  onCompiled,
  onError
}: Props) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel?.();
    if (!editor || !monaco || !model) return;
    const markers = compileErrors
      .map(parseCompileIssue)
      .filter((issue): issue is NonNullable<ReturnType<typeof parseCompileIssue>> => issue !== null)
      .map((issue) => ({
        severity: monaco.MarkerSeverity.Error,
        message: issue.message,
        startLineNumber: issue.line,
        startColumn: issue.column,
        endLineNumber: issue.line,
        endColumn: issue.column + 1
      }));
    monaco.editor.setModelMarkers(model, BACKEND_MARKER_OWNER, markers);
  }, [compileErrors]);

  const handleMount = useCallback<OnMount>(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      const model = editor?.getModel?.();
      if (!model) return;
      const markers = compileErrors
        .map(parseCompileIssue)
        .filter((issue): issue is NonNullable<ReturnType<typeof parseCompileIssue>> => issue !== null)
        .map((issue) => ({
          severity: monaco.MarkerSeverity.Error,
          message: issue.message,
          startLineNumber: issue.line,
          startColumn: issue.column,
          endLineNumber: issue.line,
          endColumn: issue.column + 1
        }));
      monaco.editor.setModelMarkers(model, BACKEND_MARKER_OWNER, markers);
    },
    [compileErrors]
  );

  const handleChange = useCallback<OnChange>(
    (value) => {
      onCqlChange(value ?? "");
      onCompileErrors([]);
      onCompileWarnings([]);
    },
    [onCqlChange, onCompileErrors, onCompileWarnings]
  );

  async function compile() {
    onError("");
    try {
      const payload = await api.post<object, { status: string; errors?: string[]; warnings?: string[] }>(
        `/api/measures/${measureId}/cql/compile`,
        { cqlText }
      );
      onCompileWarnings(payload.warnings ?? []);
      onCompileErrors(payload.errors ?? []);
      if ((payload.errors ?? []).length === 0) emitToast("CQL compiled successfully");
      onCompiled();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Compile failed");
    }
  }

  return (
    <div className="grid gap-3 rounded-md border border-slate-200 bg-white p-4">
      <div className="overflow-hidden rounded border border-slate-300" style={{ minHeight: 400, height: "calc(100vh - 24rem)", maxHeight: "calc(100vh - 12rem)" }}>
        <MonacoEditor
          height="100%"
          language="sql"
          theme="vs-dark"
          value={cqlText}
          onMount={handleMount}
          onChange={handleChange}
          options={{
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            wordWrap: "on"
          }}
          loading={<div className="flex h-full items-center justify-center bg-slate-950 text-sm text-slate-200">Loading editor...</div>}
        />
      </div>
      <div className="flex items-center gap-2">
        <button className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white" onClick={compile}>
          Compile
        </button>
        <span className={`rounded-full px-2 py-1 text-xs font-medium ${compileStatusClass(measure.compileStatus ?? "")}`}>
          {formatStatusLabel(measure.compileStatus ?? "UNKNOWN")}
        </span>
      </div>
      {(measure.compileStatus ?? "").toUpperCase() === "WARNINGS" ? (
        <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
          Compile completed with warnings. Activation is allowed, but review warnings before moving to Active.
        </p>
      ) : null}
      {compileWarnings.length > 0 ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-amber-800">Warnings</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
            {compileWarnings.map((entry) => <li key={entry}>{formatIssue(entry)}</li>)}
          </ul>
        </div>
      ) : null}
      {compileErrors.length > 0 ? (
        <div className="rounded border border-red-300 bg-red-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-red-800">Errors</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-800">
            {compileErrors.map((entry) => <li key={entry}>{formatIssue(entry)}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
