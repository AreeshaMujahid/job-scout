"use client";

import { useState } from "react";

import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

/**
 * A password input with a show/hide toggle.
 *
 * The toggle is not a nicety. A password field people cannot read is a
 * password field people mistype, and on a sign-up form a typo becomes an
 * account they cannot get back into. Letting someone check what they typed
 * beats a "confirm password" box that they paste the same mistake into.
 *
 * Defaults to hidden, and the button is excluded from the tab order: it is
 * for the mouse and the thumb, not something to land on between the field
 * and the submit button.
 */
export function PasswordField({
  name = "password",
  label = "Password",
  autoComplete = "current-password",
  hint,
  autoFocus = false,
}: {
  name?: string;
  label?: string;
  autoComplete?: "current-password" | "new-password";
  hint?: string;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const isNew = autoComplete === "new-password";

  return (
    <div>
      <label htmlFor={name} className="label">
        {label}
      </label>
      <div className="relative mt-2">
        <input
          id={name}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          // The browser enforces nothing useful about strength; this only
          // saves a round trip on the most obvious case.
          minLength={isNew ? MIN_PASSWORD_LENGTH : undefined}
          required
          autoFocus={autoFocus}
          className="field pr-16"
          aria-describedby={hint ? `${name}-hint` : undefined}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible((shown) => !shown)}
          className="absolute inset-y-0 right-0 px-3 text-xs font-semibold text-ink-soft hover:text-ink"
          aria-label={visible ? "Hide password" : "Show password"}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
      {hint && (
        <p id={`${name}-hint`} className="hint">
          {hint}
        </p>
      )}
    </div>
  );
}
