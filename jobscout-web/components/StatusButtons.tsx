"use client";

import { useTransition } from "react";

import { setJobStatus } from "@/app/actions/tracker";
import type { JobStatus } from "@/lib/db/schema";

const CHOICES: { value: JobStatus; label: string; activeLabel: string }[] = [
  { value: "saved", label: "Save", activeLabel: "Saved" },
  { value: "applied", label: "Mark applied", activeLabel: "Applied" },
  { value: "dismissed", label: "Not for me", activeLabel: "Hidden" },
];

/**
 * Each button is a toggle: pressing the status a job already has clears it,
 * so a mis-click is undone by clicking the same thing again.
 */
export function StatusButtons({
  jobId,
  current,
  size = "normal",
}: {
  jobId: string;
  current: JobStatus | null;
  size?: "normal" | "small";
}) {
  const [pending, startTransition] = useTransition();

  const padding = size === "small" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";

  return (
    <div className="flex flex-wrap gap-2" aria-busy={pending}>
      {CHOICES.map((choice) => {
        const active = current === choice.value;
        return (
          <button
            key={choice.value}
            type="button"
            disabled={pending}
            aria-pressed={active}
            onClick={() =>
              startTransition(() => setJobStatus(jobId, active ? "none" : choice.value))
            }
            className={`rounded-lg border font-medium transition disabled:opacity-50 ${padding} ${
              active
                ? "border-brand bg-brand-soft text-brand"
                : "border-line bg-surface text-ink-soft hover:bg-canvas"
            }`}
          >
            {active ? choice.activeLabel : choice.label}
          </button>
        );
      })}
    </div>
  );
}
