"use client";
import { useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import type { SegmentRule, SegmentOverride } from "../types";

export interface PreviewResult {
  count: number;
  members: string[];
}

/** Debounced dry-run membership for an unsaved rule. `valid` gates the call (skip while invalid). */
export function usePreview(rule: SegmentRule, overrides: SegmentOverride[], valid: boolean) {
  const api = useApi();
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const key = JSON.stringify({ rule, overrides });
  useEffect(() => {
    if (!valid) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void api
        .post<{ rule: SegmentRule; overrides: SegmentOverride[] }, PreviewResult>(
          "/api/segments/preview",
          { rule, overrides }
        )
        .then((r) => {
          if (!cancelled) {
            setPreview(r);
            setPreviewError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setPreview(null);
            setPreviewError(e instanceof Error ? e.message : "preview failed");
          }
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, valid]);
  return { preview, previewError };
}
