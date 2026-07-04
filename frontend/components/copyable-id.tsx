"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * Renders a raw id (e.g. a run/case UUID) as a SHORTENED, monospace token with a copy button, and
 * optionally links it to its surface — so operators aren't shown a bare 36-char UUID as primary content
 * (UX-6). The full id stays available via the tooltip, the copy button, and the link target.
 */
export function CopyableId({
  id,
  href,
  label = "id",
  className = "",
}: {
  id: string;
  href?: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (!id) return <span className="text-neutral-400">—</span>;
  const short = id.length > 12 ? `${id.slice(0, 8)}…` : id;

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable (insecure context) — the tooltip + link still expose the id */
    }
  }

  const token = (
    <span className="font-mono text-xs" title={id}>
      {short}
    </span>
  );

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {href ? (
        <Link href={href} className="text-blue-600 hover:underline dark:text-blue-400">
          {token}
        </Link>
      ) : (
        token
      )}
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        title={copied ? "Copied" : "Copy full id"}
        className="inline-flex min-h-6 min-w-6 items-center justify-center p-1 text-neutral-600 transition-colors hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
      >
        {copied ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </span>
  );
}
