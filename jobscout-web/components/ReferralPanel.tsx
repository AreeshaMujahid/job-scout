"use client";

import { useState, useTransition } from "react";

import { fetchCompanyPeopleAction, fetchReferralsAction } from "@/app/actions/referrals";
import { ContactRow } from "@/components/ContactRow";
import type { ReferralContact } from "@/lib/scout";

/**
 * Who you already know at this company.
 *
 * On request only. Each lookup drives a signed-in browser at LinkedIn, which
 * is slow and — on a personal account — not risk-free, so this never runs on
 * page load, never prefetches, and never loops over a list of jobs.
 */
/** A searchable version of a job title.
 *
 *  Postings carry decoration a people-search chokes on -- "(Senior) Data
 *  Scientist (all genders)" finds nobody. Strips bracketed asides, gendered
 *  suffixes and seniority words down to the role itself. */
function roleKeyword(title: string): string {
  const cleaned = title
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(all genders?|divers)\b/gi, " ")
    // Only an m/w/d style cluster, never a bare letter: these word
    // boundaries are load-bearing. Without them the rule matched those
    // letters anywhere and turned "Data Scientist" into "ata Scientist".
    .replace(/\b[mwdfx](\s*\/\s*[mwdfx])+\b/gi, " ")
    .replace(/\b(senior|junior|lead|principal|staff|working student|intern)\b/gi, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.split(" ").filter(Boolean).slice(0, 3).join(" ") || title;
}

export function ReferralPanel({
  jobId,
  company,
  companyUrl,
  jobTitle,
  source,
  initialContacts,
  checked,
}: {
  jobId: string;
  company: string;
  companyUrl: string;
  jobTitle: string;
  source: string;
  initialContacts: ReferralContact[];
  checked: boolean;
}) {
  const [contacts, setContacts] = useState(initialContacts);
  const [error, setError] = useState("");
  const [ran, setRan] = useState(checked);
  const [pending, startTransition] = useTransition();
  // The company search is kept separate from the network lookup above:
  // different people, different risk, and mixing them in one list would
  // hide which of them actually knows the user.
  const [staff, setStaff] = useState<ReferralContact[]>([]);
  const [staffRan, setStaffRan] = useState(false);
  const [staffKeyword, setStaffKeyword] = useState("");
  const [staffPending, startStaffTransition] = useTransition();

  function searchCompany(keyword: string) {
    setError("");
    setStaffKeyword(keyword);
    startStaffTransition(async () => {
      const result = await fetchCompanyPeopleAction(jobId, keyword);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      if (result.status === "ok") {
        setStaff(result.contacts);
        setStaffRan(true);
      }
    });
  }

  // The "people you can reach out to" module lives on a LinkedIn JOB page,
  // so only a LinkedIn posting has one. Searching the COMPANY works for any
  // posting though -- the company is looked up by name -- so the panel stays
  // and only that one button is hidden.
  const canCheckNetwork = source === "LinkedIn";

  function look() {
    setError("");
    startTransition(async () => {
      const result = await fetchReferralsAction(jobId);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      if (result.status === "ok") {
        setContacts(result.contacts);
        setRan(true);
      }
    });
  }

  return (
    <section className="card mt-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Do you know anyone at {company}?</h2>
          <p className="hint">
            {canCheckNetwork
              ? "A referral beats a cold application. This checks who LinkedIn already shows you at this company — your own connections and school alumni."
              : `This posting came from ${source}, so there is no LinkedIn job page to read your own network from — but you can still search who works at ${company}.`}
          </p>
        </div>
        {canCheckNetwork && (
          <button type="button" disabled={pending} onClick={look} className="btn-secondary shrink-0">
            {pending ? "Checking…" : ran ? "Check again" : "Check LinkedIn"}
          </button>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {contacts.length > 0 && (
        <ul className="mt-4 divide-y divide-line">
          {contacts.map((contact) => (
                <ContactRow
                  key={contact.profile_url}
                  jobId={jobId}
                  contact={contact}
                />
              ))}
        </ul>
      )}

      {/* "Nobody" is the common answer, not a failure -- most postings show
          no one, because most people have no connection there. Saying so
          plainly stops it reading as a broken lookup. */}
      {ran && contacts.length === 0 && !error && (
        <p className="mt-4 text-sm text-ink-faint">
          LinkedIn did not show anyone you know at {company}. That is normal — it only surfaces
          people in your own network.
        </p>
      )}

      {/* Beyond your own network.
          These people have no relationship to the user, so this is a
          separate, explicit action rather than part of the lookup above,
          it is capped server-side, and nothing about them is stored. */}
      {(companyUrl || company) && (
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="text-sm font-semibold">Search {company} directly</h3>
          <p className="hint">
            People who work there but are not in your network. Recruiters answer cold
            messages far more often than engineers do, so start there.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={staffPending}
              onClick={() => searchCompany("recruiter")}
              className="btn-secondary"
            >
              {staffPending && staffKeyword === "recruiter" ? "Searching…" : "Recruiters"}
            </button>
            <button
              type="button"
              disabled={staffPending}
              onClick={() => searchCompany(roleKeyword(jobTitle))}
              className="btn-secondary"
            >
              {staffPending && staffKeyword === roleKeyword(jobTitle)
                ? "Searching…"
                : `People in ${roleKeyword(jobTitle)}`}
            </button>
          </div>

          {staff.length > 0 && (
            <ul className="mt-4 divide-y divide-line">
              {staff.map((person) => (
                <ContactRow
                  key={person.profile_url}
                  jobId={jobId}
                  contact={person} muted
                />
              ))}
            </ul>
          )}

          {staffRan && staff.length === 0 && !error && (
            <p className="mt-3 text-sm text-ink-faint">
              No matches for that search at {company}. Try the other button, or open the
              company page on LinkedIn directly.
            </p>
          )}
        </div>
      )}

    </section>
  );
}
