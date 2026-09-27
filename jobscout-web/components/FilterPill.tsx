"use client";

import { useEffect, useRef, useState } from "react";

/**
 * One filter, as a pill that opens a small panel.
 *
 * A search has eight settings and a row of eight labelled boxes is a form to
 * fill in, not a thing to glance at. As pills, the whole search reads in one
 * line -- "Germany, Data Scientist (+3), 4 sources, last 24 hours" -- and
 * only the one being changed opens.
 *
 * A pill is tinted when its value differs from the default and plain when it
 * does not, so the row also answers "what have I actually changed?" without
 * opening anything.
 *
 * THE PANEL IS HIDDEN WITH CSS, NEVER UNMOUNTED. The controls inside render
 * the form's hidden inputs -- TagInput keeps its own -- so unmounting a
 * closed panel would drop those fields from the submission, and a search
 * would quietly run with no titles rather than failing loudly. Kept mounted,
 * the form always carries every value whether the pill is open or not.
 */
export function FilterPill({
  label,
  summary,
  active,
  wide,
  children,
}: {
  label: string;
  /** The current value, shown in place of the label once one is set. */
  summary?: string;
  active?: boolean;
  /** For panels holding more than a single control. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold
          transition ${
            active
              ? "border-match-line bg-match-tint text-match-ink hover:bg-match-line"
              : "border-line bg-surface text-ink hover:border-ink-faint"
          }`}
      >
        <span className="max-w-[16rem] truncate">{summary || label}</span>
        <svg
          className={`h-3.5 w-3.5 shrink-0 transition ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Hidden, not unmounted -- see the note above. */}
      <div
        role="dialog"
        aria-label={label}
        className={`absolute left-0 z-30 mt-2 rounded-xl border border-line bg-surface p-4
          shadow-lg ${wide ? "w-[22rem]" : "w-72"} ${open ? "" : "hidden"}`}
      >
        <p className="mb-3 text-xs font-bold uppercase tracking-widest text-ink-soft">{label}</p>
        {children}
      </div>
    </div>
  );
}

/** "Data Scientist (+3)" -- the first value, and how many more there are. */
export function summarise(values: string[], empty = ""): string {
  if (values.length === 0) return empty;
  const [first, ...rest] = values;
  return rest.length > 0 ? `${first} (+${rest.length})` : first;
}
