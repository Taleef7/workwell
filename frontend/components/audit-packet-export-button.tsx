"use client";

import { useState } from "react";
import { Button, Select } from "@mieweb/ui";
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
      <Select
        id={`${filenamePrefix}-format`}
        aria-label="Audit packet format"
        size="sm"
        className="w-24"
        value={format}
        onValueChange={(value) => setFormat(value as PacketFormat)}
        disabled={disabled || exporting}
        options={[
          { value: "json", label: "JSON" },
          { value: "html", label: "HTML" },
        ]}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void exportPacket()}
        disabled={disabled || exporting}
      >
        {exporting ? "Exporting..." : label}
      </Button>
    </div>
  );
}
