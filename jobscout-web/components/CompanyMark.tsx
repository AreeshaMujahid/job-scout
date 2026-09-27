"use client";

import { useState } from "react";

/**
 * The square beside a job: the employer's logo, or their initials.
 *
 * Most postings have no logo and never will. LinkedIn, Xing and StepStone
 * send none, and the company_url they do send is the employer's page ON THAT
 * BOARD -- "linkedin.com/company/holidu" -- so a favicon taken from it would
 * stamp LinkedIn's own logo onto every card. Guessing a domain from the
 * company name is worse still: "Holidu" resolving to the wrong holidu-ish
 * site puts another company's brand on a job that is not theirs.
 *
 * So: a real logo when a board actually sent one, and otherwise initials on
 * a colour picked from the company's name. The colour is the point -- twenty
 * identical navy squares are wallpaper, while a stable colour per employer
 * makes the same company recognisable down a list and across runs.
 */

/**
 * Backgrounds for the monogram.
 *
 * Deep enough for white text to clear WCAG AA at this size, and drawn from
 * one family with the app's brand rather than a rainbow, so a feed of twenty
 * reads as one product.
 */
const TONES = [
  "#1e3a8a", // brand navy
  "#0f766e", // teal
  "#7c2d12", // rust
  "#4c1d95", // violet
  "#155e75", // cyan
  "#3f6212", // olive
  "#831843", // plum
  "#374151", // slate
];

/**
 * A stable colour for a name.
 *
 * Deterministic, so a company keeps its colour between renders, between runs
 * and between users -- a colour that changed on reload would be noise
 * pretending to be information.
 */
function toneFor(name: string): string {
  // Math.imul, not hash * 31: a plain multiply leaves 32-bit range within a
  // few characters, doubles lose the low bits, and every name then lands on
  // the same tone -- measured, Holidu, adesso SE and Zalando SE all came out
  // the same olive. imul keeps the arithmetic exactly 32-bit.
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (Math.imul(hash, 31) + name.charCodeAt(i)) | 0;
  }
  // Then avalanche it. Taking % 8 straight off a 31-multiplier hash uses
  // only the low three bits, which barely move between short similar names:
  // measured, four of five German company names landed on the same violet.
  // This is the standard 32-bit finalizer -- it spreads the whole word into
  // those low bits, so neighbouring names get different colours.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x45d9f3b);
  hash ^= hash >>> 16;
  return TONES[Math.abs(hash) % TONES.length];
}

/** Initials, skipping the legal-form noise that makes half a feed read "G". */
export function monogram(company: string): string {
  const words = company
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !/^(gmbh|ag|ltd|limited|inc|llc|plc|bv|nv|sa|se|co|group|holding|the)$/i.test(w));
  const source = words.length ? words : company.split(/\s+/).filter(Boolean);
  return source.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

export function CompanyMark({
  company,
  logoUrl,
  size = "h-12 w-12",
}: {
  company: string;
  logoUrl?: string;
  size?: string;
}) {
  // A logo URL is no promise that the image loads: boards keep dead links,
  // and a broken-image glyph is worse than initials. onError falls back once
  // and stays fallen back.
  const [broken, setBroken] = useState(false);
  const showLogo = Boolean(logoUrl) && !broken;

  if (showLogo) {
    return (
      // A plain <img>: these are arbitrary third-party hosts, and next/image
      // would need every one of them listed in next.config before it would
      // render at all.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={`${company} logo`}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className={`${size} shrink-0 rounded-xl border border-line bg-surface object-contain p-1`}
      />
    );
  }

  return (
    <div
      className={`${size} grid shrink-0 place-items-center rounded-xl text-sm font-bold text-white`}
      style={{ backgroundColor: toneFor(company) }}
      aria-hidden="true"
    >
      {monogram(company)}
    </div>
  );
}
