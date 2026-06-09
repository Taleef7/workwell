"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Monaco, OnChange, OnMount } from "@monaco-editor/react";
import { emitToast } from "@/lib/toast";
import { formatStatusLabel } from "@/lib/status";
import type { ApiClient } from "@/lib/api/client";
import type { MeasureDetail } from "../types";
import { compileStatusClass, formatIssue, parseCompileIssue } from "../utils";
import { SqlPreviewPanel } from "./SqlPreviewPanel";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[400px] items-center justify-center rounded-md border border-neutral-200 dark:border-neutral-800 bg-slate-950 text-sm text-slate-200">
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
  canClone: boolean;
  onCreateNewVersion: (summary: string) => Promise<boolean>;
  /** Live compile status from the most recent compile response; overrides the persisted prop on the badge. */
  liveCompileStatus?: string | null;
  /** Reports the compile response status (COMPILED | WARNINGS | ERROR) up to the parent. */
  onCompileStatusChange?: (status: string) => void;
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
  onError,
  canClone,
  onCreateNewVersion,
  liveCompileStatus,
  onCompileStatusChange
}: Props) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const [showNewVersionDialog, setShowNewVersionDialog] = useState(false);
  const [newVersionSummary, setNewVersionSummary] = useState("");
  const [creatingVersion, setCreatingVersion] = useState(false);
  const [showDraftCqlDialog, setShowDraftCqlDialog] = useState(false);
  const [oshaText, setOshaText] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [draftBanner, setDraftBanner] = useState<string | null>(null);

  // Prefer the live status from the latest compile response so the badge flips immediately,
  // falling back to the persisted measure status (e.g. on first load / after refetch).
  const displayedCompileStatus = liveCompileStatus ?? measure.compileStatus ?? "UNKNOWN";

  async function handleDraftCql() {
    setDrafting(true);
    onError("");
    try {
      const result = await api.post<{ oshaText: string }, { cql: string; fallbackUsed: boolean; provider: string; success: boolean }>(
        `/api/measures/${measureId}/ai/draft-cql`,
        { oshaText }
      );
      onCqlChange(result.cql);
      if (editorRef.current) {
        editorRef.current.setValue(result.cql);
      }
      setDraftBanner(
        result.fallbackUsed
          ? "AI unavailable — template inserted. Fill in the TODO sections before compiling."
          : `AI-generated draft (${result.provider}) — review all logic before compiling. Not valid until compiled.`
      );
      onCompileErrors([]);
      onCompileWarnings([]);
      setShowDraftCqlDialog(false);
      emitToast(result.fallbackUsed ? "Fallback CQL template inserted" : "AI CQL draft inserted");
    } catch (err) {
      onError(err instanceof Error ? err.message : "AI Draft CQL failed");
    } finally {
      setDrafting(false);
    }
  }

  async function handleSubmitNewVersion() {
    if (!newVersionSummary.trim()) {
      onError("Change summary is required to create a new version.");
      return;
    }
    setCreatingVersion(true);
    onError("");
    try {
      const created = await onCreateNewVersion(newVersionSummary.trim());
      if (created) {
        setNewVersionSummary("");
        setShowNewVersionDialog(false);
      }
    } catch {
      onError("Version clone failed");
    } finally {
      setCreatingVersion(false);
    }
  }

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
    setCompiling(true);
    try {
      const payload = await api.post<object, { status: string; errors?: string[]; warnings?: string[] }>(
        `/api/measures/${measureId}/cql/compile`,
        { cqlText }
      );
      onCompileWarnings(payload.warnings ?? []);
      onCompileErrors(payload.errors ?? []);
      if (payload.status) onCompileStatusChange?.(payload.status);
      if ((payload.errors ?? []).length === 0) emitToast("CQL compiled successfully");
      onCompiled();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Compile failed");
    } finally {
      setCompiling(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      {draftBanner ? (
        <div className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="mt-0.5 font-semibold uppercase tracking-wider text-amber-700">AI draft</span>
          <span className="flex-1">{draftBanner}</span>
          <button
            type="button"
            onClick={() => setDraftBanner(null)}
            className="text-amber-700 hover:text-amber-900"
            aria-label="Dismiss AI draft banner"
          >
            ✕
          </button>
        </div>
      ) : null}
      <div className="overflow-hidden rounded border border-neutral-300 dark:border-neutral-700" style={{ minHeight: 400, height: "calc(100vh - 24rem)", maxHeight: "calc(100vh - 12rem)" }}>
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
        <button
          className="flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
          onClick={compile}
          disabled={compiling}
        >
          {compiling ? (
            <>
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Compiling…
            </>
          ) : (
            "Compile"
          )}
        </button>
        <button
          type="button"
          onClick={() => setShowDraftCqlDialog(true)}
          className="rounded-md border border-purple-300 bg-white dark:bg-neutral-900 px-3 py-2 text-xs font-semibold text-purple-700 hover:bg-purple-50"
        >
          AI Draft CQL
        </button>
        <span
          data-testid="compile-status-badge"
          className={`rounded-full px-2 py-1 text-xs font-medium ${compileStatusClass(displayedCompileStatus)}`}
        >
          {formatStatusLabel(displayedCompileStatus)}
        </span>
        {canClone && (
          <button
            type="button"
            onClick={() => setShowNewVersionDialog(true)}
            className="ml-auto rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-xs font-semibold text-neutral-800 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
          >
            New Version
          </button>
        )}
      </div>

      {showNewVersionDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Create New Measure Version</h3>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              This will clone the current CQL logic into a new draft version.
            </p>
            <div className="mt-4">
              <label htmlFor="change-summary-input" className="block text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                Change Summary
              </label>
              <textarea
                id="change-summary-input"
                className="mt-1 w-full rounded-2xl border border-neutral-300 dark:border-neutral-700 p-3 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                placeholder="Describe what changed in this version..."
                rows={3}
                value={newVersionSummary}
                onChange={(e) => setNewVersionSummary(e.target.value)}
              />
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowNewVersionDialog(false);
                  setNewVersionSummary("");
                }}
                className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-4 py-2 text-xs font-semibold text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmitNewVersion}
                disabled={creatingVersion || !newVersionSummary.trim()}
                className="rounded-md bg-neutral-900 px-4 py-2 text-xs font-semibold text-white hover:bg-neutral-800 disabled:opacity-60"
              >
                {creatingVersion ? "Creating..." : "Create Version"}
              </button>
            </div>
          </div>
        </div>
      )}
      {displayedCompileStatus.toUpperCase() === "WARNINGS" ? (
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

      <SqlPreviewPanel measure={measure} />

      {showDraftCqlDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50 backdrop-blur-sm">
          <div className="w-full max-w-xl rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">AI Draft CQL</h3>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              Paste relevant OSHA/policy text below. The AI will use your saved Spec and this text to generate
              a starting CQL library. You must compile and review before activating.
            </p>
            <textarea
              value={oshaText}
              onChange={(e) => setOshaText(e.target.value)}
              className="mt-3 h-48 w-full rounded-2xl border border-neutral-300 dark:border-neutral-700 p-3 font-mono text-xs focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
              placeholder="Paste OSHA regulatory text or policy requirements here…"
            />
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowDraftCqlDialog(false)}
                className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-4 py-2 text-xs font-semibold text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDraftCql}
                disabled={drafting}
                className="rounded-md bg-purple-600 px-4 py-2 text-xs font-semibold text-white hover:bg-purple-700 disabled:opacity-60"
              >
                {drafting ? "Generating…" : "Generate CQL Draft"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
