"use client";

import { useState } from "react";
import type { ApiClient } from "@/lib/api/client";

type PacketFormat = "json" | "html";

type AuditPacketExportButtonProps = {
  api: ApiClient;
  path: string;
  filenamePrefix: string;
  label: string;
  disabled?: boolean;
  onError?: (message: string) => void;
};

export function AuditPacketExportButton({
  api,
  path,
  filenamePrefix,
  label,
  disabled = false,
  onError,
}: AuditPacketExportButtonProps) {
  const [format, setFormat] = useState<PacketFormat>("json");
  const [exporting, setExporting] = useState(false);

  async function exportPacket() {
    setExporting(true);
    onError?.("");
    try {
      const blob = await api.downloadBlob(`${path}?format=${format}`);
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${filenamePrefix}.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Audit packet export failed");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <label className="sr-only" htmlFor={`${filenamePrefix}-format`}>
        Audit packet format
      </label>
      <select
        id={`${filenamePrefix}-format`}
        className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-800"
        value={format}
        onChange={(event) => setFormat(event.target.value as PacketFormat)}
        disabled={disabled || exporting}
      >
        <option value="json">JSON</option>
        <option value="html">HTML</option>
      </select>
      <button
        type="button"
        className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        onClick={() => void exportPacket()}
        disabled={disabled || exporting}
      >
        {exporting ? "Exporting..." : label}
      </button>
    </div>
  );
}
