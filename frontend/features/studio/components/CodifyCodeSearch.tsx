"use client";

/**
 * CodifyCodeSearch — MIE's Codify terminology search (Doug directive 3, issue #310) wrapped for
 * WorkWell's authoring surfaces. Wraps the vendored `@mieweb/ui` CodeLookup component
 * (`frontend/vendor/codelookup/`, see VENDORED.md — upstream ships it Storybook-only until the
 * npm release; consumer bundling is the designed path) against MIE's hosted shard index.
 *
 * Client-only by nature (module Web Worker + OPFS shard cache), so the component is loaded via
 * `next/dynamic` with `ssr: false` — the NitroGridClient pattern. Search runs entirely in the
 * browser; nothing is sent to the WorkWell backend.
 */
import dynamic from "next/dynamic";
import type { CodifyResult } from "@/vendor/codelookup/engine";

export type { CodifyResult };

const CodeLookup = dynamic(() => import("@/vendor/codelookup/CodeLookup").then((m) => m.CodeLookup), {
  ssr: false,
  loading: () => (
    <div className="rounded border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-sm text-neutral-500">
      Loading Codify search…
    </div>
  ),
});

const INDEX_URL = process.env.NEXT_PUBLIC_CODIFY_INDEX_URL ?? "https://ui.mieweb.org/codify";

type Props = {
  /** Fired when the author picks a code (e.g. to prefill a value-set / mapping form). */
  onSelect: (result: CodifyResult) => void;
  /** Restrict which Codify domains are searched (default: conditions, labs, procedures, meds…). */
  domains?: Array<"condition" | "med" | "lab" | "procedure" | "vaccine" | "occupational" | "quality">;
  placeholder?: string;
};

export function CodifyCodeSearch({ onSelect, domains, placeholder }: Props) {
  return (
    <CodeLookup
      indexUrl={INDEX_URL}
      domains={domains}
      onSelect={onSelect}
      placeholder={placeholder ?? 'Search Codify — all the codes that exist (try "breast cancer screening", "hba1c")'}
    />
  );
}
