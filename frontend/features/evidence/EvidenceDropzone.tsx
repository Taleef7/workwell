"use client";

import { useCallback, useId, useState } from "react";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Styled drag-and-drop evidence dropzone (UX-7). Presentational wrapper around the same native
 * file input that drove the bare "Choose File" control — it does NOT fork the upload logic:
 * both a click-selection and a drop feed the identical `onFileChange(file)` callback the parent
 * already used. Keeps `aria-label="Evidence file"` on the input for a11y. Storage is durable since
 * #167/ADR-030 (managed S3 bucket); the muted note now reminds that the demo takes synthetic
 * evidence only (the demo stack never receives PHI — PRODUCTION_READINESS_2026-07.md).
 */
export function EvidenceDropzone({
  file,
  onFileChange,
  accept = ".pdf,.png,.jpg,.jpeg",
  disabled = false,
}: {
  file: File | null;
  onFileChange: (file: File | null) => void;
  accept?: string;
  disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputId = useId();

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLLabelElement>) => {
      event.preventDefault();
      setDragging(false);
      if (disabled) return;
      const dropped = event.dataTransfer?.files?.[0] ?? null;
      if (dropped) onFileChange(dropped);
    },
    [disabled, onFileChange]
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLLabelElement>) => {
      event.preventDefault();
      if (!disabled) setDragging(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
  }, []);

  const borderClass = dragging
    ? "border-emerald-500 bg-emerald-50 dark:border-emerald-400 dark:bg-emerald-950/30"
    : "border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 hover:border-neutral-400 dark:hover:border-neutral-600";

  return (
    <div className="space-y-1.5">
      <label
        htmlFor={inputId}
        data-testid="evidence-dropzone"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed px-4 py-6 text-center transition-colors focus-within:ring-2 focus-within:ring-emerald-500 focus-within:ring-offset-2 dark:focus-within:ring-offset-neutral-900 ${borderClass} ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
      >
        <input
          id={inputId}
          type="file"
          aria-label="Evidence file"
          accept={accept}
          disabled={disabled}
          className="sr-only"
          onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
        />
        {file ? (
          <>
            <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">📎 {file.name}</span>
            <span className="text-xs text-neutral-600 dark:text-neutral-400">
              {formatFileSize(file.size)} • click or drop to replace
            </span>
          </>
        ) : (
          <>
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Drag &amp; drop a file here, or click to browse
            </span>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">PDF, PNG, or JPG</span>
          </>
        )}
      </label>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Demo note: uploaded files are synthetic demo evidence — do not upload real records.
      </p>
    </div>
  );
}
