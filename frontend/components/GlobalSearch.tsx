'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useApi } from '@/lib/api/hooks';

interface SearchResult {
  externalId: string;
  name: string;
  role: string;
  site: string;
  latestOutcome: string | null;
}

const OUTCOME_BADGE: Record<string, string> = {
  OVERDUE: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  DUE_SOON: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  COMPLIANT: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  MISSING_DATA: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400',
  EXCLUDED: 'bg-neutral-50 dark:bg-neutral-800/50 text-neutral-400',
};

export function GlobalSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const api = useApi();
  const router = useRouter();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (query.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      setOpen(false);
      return;
    }
    clearTimeout(timeoutRef.current);
    setLoading(true);
    timeoutRef.current = setTimeout(async () => {
      try {
        const data = await api.get<SearchResult[]>(
          `/api/employees/search?q=${encodeURIComponent(query)}`
        );
        setResults(data);
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timeoutRef.current);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function navigate(externalId: string) {
    setQuery('');
    setOpen(false);
    router.push(`/employees/${externalId}`);
  }

  return (
    <div ref={containerRef} className="relative hidden sm:block">
      <div className="relative">
        <svg
          className="absolute left-2.5 top-2 h-3.5 w-3.5 text-neutral-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          type="text"
          aria-label="Search employees"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="Search employees…"
          className="h-8 w-56 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 pl-7 pr-3 text-xs text-neutral-700 dark:text-neutral-300 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
        />
      </div>

      {open && (results.length > 0 || (query.length >= 2 && !loading)) && (
        <div className="absolute top-full mt-1 w-72 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg z-50 overflow-hidden">
          {results.length > 0 ? (
            <ul className="max-h-64 overflow-y-auto py-1">
              {results.map((r) => (
                <li key={r.externalId}>
                  <button
                    type="button"
                    onClick={() => navigate(r.externalId)}
                    className="w-full px-3 py-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/50 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">{r.name}</p>
                      <p className="text-xs text-neutral-400 truncate">
                        {r.role} · {r.site}
                      </p>
                    </div>
                    {r.latestOutcome && (
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${OUTCOME_BADGE[r.latestOutcome] ?? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400'}`}
                      >
                        {r.latestOutcome.replace(/_/g, ' ')}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-3 py-4 text-center text-xs text-neutral-400">No employees found</div>
          )}
        </div>
      )}
    </div>
  );
}
