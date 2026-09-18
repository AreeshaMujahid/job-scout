import type { Profile } from "@/lib/db/schema";

/**
 * Work authorisation, in the four answers that change which jobs are possible.
 * Anything finer (which permit, which expiry) goes in the free-text note.
 */
export const VISA_OPTIONS = [
  {
    value: "no_sponsorship_needed",
    label: "I can work without sponsorship",
    hint: "Citizen, permanent resident, or an existing right to work where you are applying.",
  },
  {
    value: "needs_sponsorship",
    label: "I need visa sponsorship",
    hint: "Postings that say 'no sponsorship' will be scored down rather than shown as matches.",
  },
  {
    value: "student_or_limited",
    label: "I'm on a student or limited permit",
    hint: "Hour caps and permit conditions get weighed against the role.",
  },
  { value: "unsure", label: "I'd rather not say", hint: "Work authorisation is left out of scoring." },
] as const;

export type VisaStatus = (typeof VISA_OPTIONS)[number]["value"];

export function visaLabel(value: string | null): string {
  return VISA_OPTIONS.find((option) => option.value === value)?.label ?? "Not set";
}

/**
 * The sentence the rater reads about things a CV cannot say.
 *
 * Kept as prose rather than fields because it is going into a prompt: the
 * model weighs "I need visa sponsorship" correctly, and would have to be
 * taught what `visa_status: needs_sponsorship` meant.
 */
export function extraContext(profile: Profile): string {
  const lines: string[] = [];

  const visa = VISA_OPTIONS.find((option) => option.value === profile.visaStatus);
  if (visa && visa.value !== "unsure") {
    lines.push(`Work authorisation: ${visa.label.replace(/^I /, "they ").trim()}.`);
  }
  if (profile.visaNote?.trim()) {
    lines.push(`They add: ${profile.visaNote.trim()}`);
  }

  if (profile.cities.length) {
    lines.push(`Willing to work in: ${profile.cities.join(", ")}.`);
  }
  if (profile.remoteOnly) {
    lines.push("They will only take fully remote roles.");
  }
  if (profile.targetRoles.length) {
    lines.push(`The roles they are aiming for: ${profile.targetRoles.join(", ")}.`);
  }

  return lines.join("\n");
}

/** Comma or newline separated input, cleaned up and de-duplicated. */
export function parseList(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== "string") return [];
  const items = raw
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(items)].slice(0, 12);
}
