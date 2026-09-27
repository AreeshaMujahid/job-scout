"use client";

import { useState } from "react";

/**
 * A long run of text, clamped to a few lines until asked for the rest.
 *
 * Postings open with a wall: company mission, values, scale, awards, and
 * somewhere inside it the job. Measured over the stored descriptions, a
 * quarter put more than half their text before the first heading -- one put
 * 96% of it there. Printing all of that at the top means scrolling past a
 * screen of "we help the world run better" to reach a requirement.
 *
 * Clamped rather than cut, and clamped rather than hidden. Truncating would
 * throw words away, which is what this component exists to stop; folding it
 * all behind a closed panel would be wrong too, because on the posting that
 * was 96% intro the "overview" IS the job, and collapsing it would bury the
 * description under a label. Clamping shows the opening, admits there is
 * more, and hands over the control.
 */
export function Expandable({
  text,
  lines = 6,
  moreLabel = "Show more",
  lessLabel = "Show less",
}: {
  text: string;
  lines?: number;
  moreLabel?: string;
  lessLabel?: string;
}) {
  const [open, setOpen] = useState(false);

  // Tailwind needs the whole class name in the source to generate it, so
  // these are written out rather than built from `lines`.
  const clamp =
    lines === 4 ? "line-clamp-4" : lines === 8 ? "line-clamp-8" : "line-clamp-6";

  return (
    <div>
      <p
        className={`whitespace-pre-line text-sm leading-relaxed text-ink-soft ${
          open ? "" : clamp
        }`}
      >
        {text}
      </p>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="mt-2 text-sm font-semibold text-brand hover:underline"
      >
        {open ? lessLabel : moreLabel}
        <span className="ml-1.5 font-normal text-ink-faint">
          {open ? "" : `${text.length.toLocaleString()} characters`}
        </span>
      </button>
    </div>
  );
}
