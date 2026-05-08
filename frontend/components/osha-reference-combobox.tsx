"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";

export type OshaReferenceOption = {
  id: string;
  cfrCitation: string;
  title: string;
  programArea: string;
};

type OshaReferenceComboboxProps = {
  value: string;
  selectedReferenceId: string | null;
  references: OshaReferenceOption[];
  onValueChange: (value: string) => void;
  onReferenceSelect: (reference: OshaReferenceOption | null) => void;
  label?: string;
  placeholder?: string;
};

export function formatOshaReferenceLabel(reference: OshaReferenceOption) {
  return `${reference.cfrCitation} — ${reference.title}`;
}

export function OshaReferenceCombobox({
  value,
  selectedReferenceId,
  references,
  onValueChange,
  onReferenceSelect,
  label = "Policy Reference",
  placeholder = "Search OSHA citations or type a custom policy reference"
}: OshaReferenceComboboxProps) {
  const [open, setOpen] = useState(false);

  const selectedReference = useMemo(
    () => references.find((reference) => reference.id === selectedReferenceId) ?? null,
    [references, selectedReferenceId]
  );

  const filteredReferences = useMemo(() => {
    const query = value.trim().toLowerCase();
    const matches = references.filter((reference) => {
      if (!query) {
        return true;
      }
      const labelText = formatOshaReferenceLabel(reference).toLowerCase();
      return [reference.cfrCitation, reference.title, reference.programArea, labelText].some((entry) =>
        entry.toLowerCase().includes(query)
      );
    });
    return matches.slice(0, 8);
  }, [references, value]);

  function selectReference(reference: OshaReferenceOption) {
    onValueChange(formatOshaReferenceLabel(reference));
    onReferenceSelect(reference);
    setOpen(false);
  }

  return (
    <div className="relative">
      <label className="mb-1 block text-xs font-medium uppercase tracking-[0.15em] text-slate-500">
        {label}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className="w-full rounded border border-slate-300 bg-white py-2 pl-10 pr-10 text-sm text-slate-900 outline-none transition focus:border-slate-900"
          placeholder={placeholder}
          value={value}
          onChange={(event) => {
            onValueChange(event.target.value);
            onReferenceSelect(null);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 120);
          }}
        />
        {value.trim() ? (
          <button
            type="button"
            aria-label="Clear policy reference"
            className="absolute right-8 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onValueChange("");
              onReferenceSelect(null);
              setOpen(false);
            }}
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      </div>

      <div className="mt-1 flex items-start justify-between gap-3 text-[11px] text-slate-500">
        <p>
          {selectedReference
            ? `Linked to ${formatOshaReferenceLabel(selectedReference)}`
            : "Type a custom policy reference if this measure is not tied to a curated OSHA citation."}
        </p>
      </div>

      {open ? (
        <div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {filteredReferences.length > 0 ? (
            filteredReferences.map((reference) => (
              <button
                key={reference.id}
                type="button"
                className="flex w-full flex-col gap-1 border-b border-slate-100 px-3 py-2 text-left transition last:border-b-0 hover:bg-slate-50"
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectReference(reference);
                }}
              >
                <span className="text-sm font-medium text-slate-900">{reference.cfrCitation}</span>
                <span className="text-xs text-slate-600">{reference.title}</span>
                <span className="text-[11px] uppercase tracking-[0.12em] text-slate-400">{reference.programArea}</span>
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-sm text-slate-500">
              No OSHA references match. Keep typing for a custom policy reference.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
