"use client";

import { useActionState } from "react";

import { savePreferences, type PreferencesState } from "@/app/actions/onboarding";
import { SubmitButton } from "@/components/SubmitButton";
import type { Profile } from "@/lib/db/schema";
import { VISA_OPTIONS } from "@/lib/preferences";

const initialState: PreferencesState = { status: "idle", message: "" };

/**
 * Shared by onboarding step 2 and Settings -- they ask for exactly the same
 * things, and having one form means the two screens cannot drift apart.
 */
export function PreferencesForm({
  profile,
  submitLabel,
}: {
  profile: Profile;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState(savePreferences, initialState);
  const roles = profile.targetRoles.length ? profile.targetRoles : profile.suggestedRoles;

  return (
    <form action={formAction} className="mt-8 space-y-8">
      <div>
        <label htmlFor="targetRoles" className="label">
          Roles to search for
        </label>
        <p className="hint">One per line, or separated by commas. Real job titles work best.</p>
        <textarea
          id="targetRoles"
          name="targetRoles"
          rows={4}
          defaultValue={roles.join("\n")}
          placeholder="data scientist&#10;machine learning engineer"
          className="field mt-2 font-mono text-sm"
        />
        {profile.suggestedRoles.length > 0 && (
          <p className="hint">
            From your CV: {profile.suggestedRoles.join(", ")}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="cities" className="label">
          Where would you work?
        </label>
        <p className="hint">
          Cities or countries. Remote jobs are always included regardless of what you put here.
        </p>
        <input
          id="cities"
          name="cities"
          defaultValue={profile.cities.join(", ")}
          placeholder="Berlin, Germany, London"
          className="field mt-2"
        />
      </div>

      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          name="remoteOnly"
          defaultChecked={profile.remoteOnly}
          className="mt-1 h-4 w-4 rounded border-line accent-brand"
        />
        <span>
          <span className="label">Remote only</span>
          <span className="hint block">Hide anything that expects you in an office.</span>
        </span>
      </label>

      <fieldset>
        <legend className="label">Work authorisation</legend>
        <p className="hint">
          This is a hard constraint when scoring: a job you cannot legally take is not a match,
          however well the skills line up.
        </p>
        <div className="mt-3 space-y-2">
          {VISA_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-line
                         bg-surface p-4 hover:bg-canvas has-checked:border-brand
                         has-checked:bg-brand-soft"
            >
              <input
                type="radio"
                name="visaStatus"
                value={option.value}
                defaultChecked={(profile.visaStatus ?? "unsure") === option.value}
                className="mt-1 h-4 w-4 accent-brand"
              />
              <span>
                <span className="block text-sm font-semibold">{option.label}</span>
                <span className="block text-sm text-ink-soft">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="visaNote" className="label">
          Anything else about your situation <span className="font-normal text-ink-faint">(optional)</span>
        </label>
        <input
          id="visaNote"
          name="visaNote"
          maxLength={300}
          defaultValue={profile.visaNote ?? ""}
          placeholder="EU Blue Card holder in Germany, can relocate within the EU"
          className="field mt-2"
        />
      </div>

      {state.status === "error" && (
        <p className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          {state.message}
        </p>
      )}

      <SubmitButton pendingText="Saving..." className="btn-primary w-full">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}
