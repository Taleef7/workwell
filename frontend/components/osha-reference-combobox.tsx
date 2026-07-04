"use client";

import { useId, useMemo, useRef, useState } from "react";
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
  const [activeIndex, setActiveIndex] = useState(-1);
  const listboxId = useId();
  const optionIdPrefix = useId();
  const rootRef = useRef<HTMLDivElement>(null);

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

  const optionId = (index: number) => `${optionIdPrefix}-opt-${index}`;
  const activeOptionId =
    open && activeIndex >= 0 && activeIndex < filteredReferences.length ? optionId(activeIndex) : undefined;

  function selectReference(reference: OshaReferenceOption) {
    onValueChange(formatOshaReferenceLabel(reference));
    onReferenceSelect(reference);
    setOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
      }
      setActiveIndex((prev) => (filteredReferences.length === 0 ? -1 : Math.min(prev + 1, filteredReferences.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
      }
      setActiveIndex((prev) => Math.max(prev - 1, 0));
    } else if (event.key === "Enter") {
      if (open && activeIndex >= 0 && activeIndex < filteredReferences.length) {
        event.preventDefault();
        selectReference(filteredReferences[activeIndex]);
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
      }
    } else if (event.key === "Home" && open) {
      event.preventDefault();
      setActiveIndex(filteredReferences.length === 0 ? -1 : 0);
    } else if (event.key === "End" && open) {
      event.preventDefault();
      setActiveIndex(filteredReferences.length - 1);
    }
  }

  return (
    <div
      className="relative"
      ref={rootRef}
      onBlur={(event) => {
        // Close only when focus leaves the whole widget (not on internal focus moves).
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setActiveIndex(-1);
        }
      }}
    >
      <label
        htmlFor={`${listboxId}-input`}
        className="mb-1 block text-xs font-medium uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400"
      >
        {label}
      </label>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500 dark:text-neutral-400"
        />
        <input
          id={`${listboxId}-input`}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 py-2 pl-10 pr-10 text-sm text-neutral-900 dark:text-neutral-100 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          placeholder={placeholder}
          value={value}
          onChange={(event) => {
            onValueChange(event.target.value);
            onReferenceSelect(null);
            setOpen(true);
            setActiveIndex(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
        />
        {value.trim() ? (
          <button
            type="button"
            aria-label="Clear policy reference"
            className="absolute right-8 top-1/2 -translate-y-1/2 rounded p-1 text-neutral-500 transition hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onValueChange("");
              onReferenceSelect(null);
              setOpen(false);
              setActiveIndex(-1);
            }}
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500 dark:text-neutral-400"
        />
      </div>

      <div className="mt-1 flex items-start justify-between gap-3 text-[11px] text-neutral-500 dark:text-neutral-400">
        <p>
          {selectedReference
            ? `Linked to ${formatOshaReferenceLabel(selectedReference)}`
            : "Type a custom policy reference if this measure is not tied to a curated OSHA citation."}
        </p>
      </div>

      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={label}
          className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg"
        >
          {filteredReferences.length > 0 ? (
            filteredReferences.map((reference, index) => (
              <li
                key={reference.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === activeIndex}
                className={`flex w-full cursor-pointer flex-col gap-1 border-b border-neutral-100 dark:border-neutral-800 px-3 py-2 text-left transition last:border-b-0 ${
                  index === activeIndex ? "bg-neutral-100 dark:bg-neutral-800" : "hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  // Prevent the input blur from closing the list before the click resolves.
                  event.preventDefault();
                }}
                onClick={() => selectReference(reference)}
              >
                <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{reference.cfrCitation}</span>
                <span className="text-xs text-neutral-600 dark:text-neutral-400">{reference.title}</span>
                <span className="text-[11px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">
                  {reference.programArea}
                </span>
              </li>
            ))
          ) : (
            <li className="px-3 py-3 text-sm text-neutral-500 dark:text-neutral-400">
              No OSHA references match. Keep typing for a custom policy reference.
            </li>
          )}
        </ul>
      ) : null}
    </div>
  );
}
