"use client";

import { useRef, useState } from "react";

/**
 * Chips you can remove, plus a box to add more.
 *
 * The value reaches the server as one comma-separated hidden field rather
 * than N inputs, because that is exactly what `parseList` on the other side
 * already understands -- it is the same shape a person types by hand.
 */
export function TagInput({
  name,
  label,
  hint,
  initial,
  suggestions = [],
  placeholder,
  onChange,
}: {
  name: string;
  label: string;
  hint?: string;
  initial: string[];
  suggestions?: string[];
  placeholder: string;
  /** Lets the parent show what the current selection will cost. */
  onChange?: (tags: string[]) => void;
}) {
  const [tags, setTags] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const update = (next: string[]) => {
    setTags(next);
    onChange?.(next);
  };

  const add = (raw: string) => {
    const wanted = raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (wanted.length === 0) return;

    const next = [...tags];
    for (const item of wanted) {
      // Case-insensitive: "Data Scientist" and "data scientist" search the
      // same thing, and two chips saying it twice would search it twice.
      if (!next.some((tag) => tag.toLowerCase() === item.toLowerCase())) next.push(item);
    }
    update(next.slice(0, 12));
    setDraft("");
  };

  const remove = (tag: string) => update(tags.filter((item) => item !== tag));

  const unused = suggestions.filter(
    (item) => !tags.some((tag) => tag.toLowerCase() === item.toLowerCase()),
  );

  return (
    <div>
      <label htmlFor={`${name}-input`} className="label">
        {label}
      </label>
      {hint && <p className="hint">{hint}</p>}

      <input type="hidden" name={name} value={tags.join(", ")} />

      <div
        className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-2
                   focus-within:border-brand"
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand px-2.5 py-1 text-sm
                       font-medium text-white"
          >
            {tag}
            <button
              type="button"
              onClick={() => remove(tag)}
              aria-label={`Remove ${tag}`}
              className="text-white/70 transition hover:text-white"
            >
              ×
            </button>
          </span>
        ))}

        <input
          id={`${name}-input`}
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              // Enter must add a chip, not submit a form that is missing the
              // thing you were halfway through typing.
              event.preventDefault();
              add(draft);
            } else if (event.key === "Backspace" && !draft && tags.length) {
              remove(tags[tags.length - 1]);
            }
          }}
          onBlur={() => add(draft)}
          placeholder={tags.length ? "" : placeholder}
          className="min-w-40 flex-1 bg-transparent px-1 py-1 text-sm outline-none
                     placeholder:text-ink-faint"
        />

        {tags.length > 0 && (
          <button
            type="button"
            onClick={() => update([])}
            aria-label={`Clear all ${label.toLowerCase()}`}
            className="ml-auto text-ink-faint transition hover:text-ink"
          >
            ⊗
          </button>
        )}
      </div>

      {unused.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
          <span>From your CV:</span>
          {unused.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => add(item)}
              className="chip transition hover:border-brand hover:text-brand"
            >
              + {item}
            </button>
          ))}
        </p>
      )}
    </div>
  );
}
