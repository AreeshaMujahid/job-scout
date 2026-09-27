import { Expandable } from "@/components/Expandable";
import {
  labelledItems,
  readPosting,
  splitRole,
  tidy,
  type PostingSection,
} from "@/lib/posting";

/**
 * The posting itself, in the shape it wrote for itself.
 *
 * Responsibilities and Qualification lead because they are what the decision
 * turns on; the company blurb sits last because it is the part every posting
 * has and nobody reads twice.
 *
 * Qualification is the one that earns extra: the posting's own requirements
 * sit under the skills it asks for, marked against the CV. Reading "Required:
 * strong Python" right beneath a filled Python chip answers the question the
 * page exists for in one glance, where two separate panels made you hold one
 * list in your head while reading the other.
 *
 * When the reader finds no structure -- about two postings in three, since
 * most boards hand over one flattened blob -- this shows the text exactly as
 * it arrived rather than inventing headings for it. A plain posting is fine;
 * a posting quoted saying something it never said is not.
 */

/** Everything except Qualification and Nice to have, which pair up below. */
const ORDER = ["Responsibilities", "What they offer", "About the company"];

/**
 * How much opening text reads as a lead paragraph rather than a wall.
 *
 * About five lines. Past that it stops being orientation and starts being
 * the thing you scroll past to reach the job.
 */
const LEAD_LIMIT = 420;

/** Past this, a section's prose is a wall rather than a paragraph. */
const PARAGRAPH_LIMIT = 700;

/** A small glyph per section, so the eye finds the one it wants. */
function SectionIcon({ heading }: { heading: string }) {
  const common = "h-4 w-4";
  if (heading === "Responsibilities") {
    return (
      <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="4" y="5" width="16" height="16" rx="2" />
        <path d="M9 3v4M15 3v4M8 12h8M8 16h5" strokeLinecap="round" />
      </svg>
    );
  }
  if (heading === "Qualification") {
    return (
      <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (heading === "What they offer") {
    return (
      <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="3" y="8" width="18" height="13" rx="2" />
        <path d="M3 12h18M12 8v13M12 8s-1-4-4-4a2.5 2.5 0 0 0 0 5M12 8s1-4 4-4a2.5 2.5 0 0 1 0 5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 21V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M14 10h5a1 1 0 0 1 1 1v10" strokeLinecap="round" />
      <path d="M7 9h3M7 13h3M17 14h1" strokeLinecap="round" />
    </svg>
  );
}

function Heading({ heading }: { heading: string }) {
  return (
    <h2 className="flex items-center gap-2.5 text-lg font-bold tracking-tight">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-match-tint text-match-ink">
        <SectionIcon heading={heading} />
      </span>
      {heading}
    </h2>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="mt-3 space-y-2.5">
      {items.map((item, i) => (
        <li key={`${i}-${item.slice(0, 24)}`} className="flex gap-3 text-sm leading-relaxed">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-match-line" />
          <span className="text-ink-soft">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Body({ section }: { section: PostingSection }) {
  return (
    <>
      {section.bullets.length > 0 && <Bullets items={section.bullets} />}
      {section.paragraphs.map((paragraph, i) => (
        <div key={`${i}-${paragraph.slice(0, 24)}`} className="mt-3">
          {/* A section whose items carried no punctuation could not be split
              into bullets without welding two requirements into one, so it
              arrives here as one long run. Clamping it means the section is
              still skimmable; the words are all present either way. */}
          {paragraph.length > PARAGRAPH_LIMIT ? (
            <Expandable text={paragraph} lines={8} moreLabel="Show the rest" />
          ) : (
            <p className="whitespace-pre-line text-sm leading-relaxed text-ink-soft">
              {paragraph}
            </p>
          )}
        </div>
      ))}
    </>
  );
}

/** One skill the posting asks for, marked against the CV. */
function Skill({ text, have }: { text: string; have: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium ${
        have ? "bg-match-tint text-match-ink" : "border border-line bg-canvas text-ink-faint"
      }`}
    >
      {have && (
        <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
          <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {text}
    </span>
  );
}

/**
 * A run of "Label: sentence" items, drawn as the list it is.
 *
 * The label carries the meaning -- "Dein Impact", "Monitoring", "Deployment"
 * -- so it leads in bold and the sentence follows. Measured, 27 of the
 * postings that had no other structure are written exactly this way, and as
 * one paragraph they were unreadable.
 */
function LabelledList({ text }: { text: string }) {
  const { lead, items } = labelledItems(text);

  if (items.length === 0) {
    return <Expandable text={text} lines={10} moreLabel="Show the rest of the job" />;
  }

  return (
    <>
      {lead && lead.length > 40 && (
        <p className="whitespace-pre-line text-sm leading-relaxed text-ink-soft">{lead}</p>
      )}
      <ul className={`space-y-3 ${lead && lead.length > 40 ? "mt-4" : ""}`}>
        {items.map((item, i) => (
          <li key={`${i}-${item.label}`} className="flex gap-3 text-sm leading-relaxed">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-match-line" />
            <span className="text-ink-soft">
              <span className="font-semibold text-ink">{item.label}</span> — {item.body}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The company talking about itself, kept but moved out of the way.
 *
 * Folded shut on purpose: this is the part nobody opened the page for, and
 * it sits AFTER the job rather than in front of it. It is still here in
 * full, because it is what the employer wrote.
 */
function CompanyBlurb({ blurb }: { blurb: string }) {
  return (
    <details className="card p-6">
      <summary className="cursor-pointer text-sm font-semibold">
        About the company
        <span className="ml-2 font-normal text-ink-faint">
          {blurb.length.toLocaleString()} characters the posting opened with
        </span>
      </summary>
      <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-ink-soft">{blurb}</p>
    </details>
  );
}

/**
 * What this posting asks for, marked against the CV.
 *
 * Its own export so the page can put it near the top, where the decision is
 * made, while the rest of the posting stays lower down. Everything else in
 * PostingDetail is the employer describing the job; this is the one panel
 * that is about YOU against it, which is why it earns the position.
 *
 * Reads the description itself rather than taking parsed sections as props:
 * the two components then cannot disagree about what "Required" means.
 */
export function QualificationPanel({
  description,
  matchedSkills = [],
  missingSkills = [],
}: {
  description: string;
  matchedSkills?: string[];
  missingSkills?: string[];
}) {
  const { sections } = readPosting(tidy(description || ""));
  const qualification = sections.find((s) => s.heading === "Qualification");
  const preferred = sections.find((s) => s.heading === "Nice to have");
  const listed = matchedSkills.length + missingSkills.length;

  if (!qualification && !preferred && listed === 0) return null;

  return (
    <section className="card mt-8 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading heading="Qualification" />
        {listed > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-soft">
            <svg className="h-3.5 w-3.5 shrink-0 text-match-ink" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
              <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {/* Says what the mark means, and no more. The tags are not
                editable here, so this does not invite a click that does
                nothing. */}
            Marked skills are ones your CV mentions
          </span>
        )}
      </div>

      {listed > 0 && (
        <>
          <p className="hint mt-2">
            {matchedSkills.length} of {listed} matched. The hollow ones are what this
            posting asks for and your CV does not mention.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {matchedSkills.map((skill) => (
              <Skill key={`have-${skill}`} text={skill} have />
            ))}
            {missingSkills.map((skill) => (
              <Skill key={`gap-${skill}`} text={skill} have={false} />
            ))}
          </div>
        </>
      )}

      {qualification && (
        <div className={listed > 0 ? "mt-5" : "mt-1"}>
          <h3 className="text-sm font-bold">Required</h3>
          <Body section={qualification} />
        </div>
      )}

      {preferred && (
        <div className="mt-5">
          <h3 className="text-sm font-bold">Preferred</h3>
          <Body section={preferred} />
        </div>
      )}
    </section>
  );
}

export function PostingDetail({
  description,
  url,
  source,
  matchedSkills = [],
  missingSkills = [],
}: {
  description: string;
  url: string;
  source: string;
  /** From the scoring pass: what the CV covers, and what it does not. */
  matchedSkills?: string[];
  missingSkills?: string[];
}) {
  // The board's UI text off the front of everything shown, the raw block
  // included -- "exactly as posted" means as the employer posted it, not as
  // the board's page happened to render around it.
  const clean = tidy(description || "");
  const { sections, intro } = readPosting(clean);
  // The company's preamble told apart from the job. On a posting with no
  // headings this is the whole difference between "here is 5kB of text" and
  // "here is the job, and the corporate introduction is below if you want
  // it". Nothing is discarded either way.
  const role = splitRole(clean);

  const qualification = sections.find((s) => s.heading === "Qualification");
  const preferred = sections.find((s) => s.heading === "Nice to have");
  const rest = sections
    .filter((s) => ORDER.includes(s.heading))
    .sort((a, b) => ORDER.indexOf(a.heading) - ORDER.indexOf(b.heading));

  // Qualification is drawn by QualificationPanel, higher up the page. It is
  // still counted here so that a posting whose only structure IS its
  // requirements does not also fall through to the "no sections" branch and
  // print the whole description a second time.
  const listed = matchedSkills.length + missingSkills.length;

  const readOn = (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-block text-sm font-semibold text-brand hover:underline"
    >
      Read it on {source} ↗
    </a>
  );

  // Nothing the reader recognised. Two postings in three land here -- most
  // boards hand over a flattened blob whose headings carry no colon -- so
  // this is the common case, not the exception, and it used to be folded
  // shut behind a summary. Open and clamped instead: readable at a glance,
  // whole when asked for, and never dressed in headings the employer did
  // not write.
  const hasAnySection = Boolean(qualification || preferred || rest.length > 0);
  if (!hasAnySection && listed === 0) {
    if (!clean) return null;
    return (
      <>
        <section className="card mt-6 p-6">
          <h2 className="text-lg font-bold tracking-tight">The job</h2>
          <p className="hint mt-1">
            This posting names no sections, so it is here as written — nothing grouped,
            nothing left out.
          </p>
          <div className="mt-4">
            <LabelledList text={role.job} />
          </div>
          <div className="mt-4 border-t border-line pt-4">{readOn}</div>
        </section>

        {role.blurb && <CompanyBlurb blurb={role.blurb} />}
      </>
    );
  }

  const responsibilities = rest.filter((s) => s.heading === "Responsibilities");
  const after = rest.filter((s) => s.heading !== "Responsibilities");

  return (
    <div className="mt-6 space-y-4">
      {/* The opening text: everything before the first heading the reader
          recognised. On a tidy posting that is two useful sentences; on one
          that names no headings until halfway down it is most of the ad.
          Measured: a quarter of the structured postings put more than half
          their text here, and one put 96% of it here.

          Clamped, not cut and not folded away. Cutting would throw words
          out; folding would bury the description on that 96% posting, where
          the opening IS the job. */}
      {intro && intro.length > 60 && (
        <div className="card p-6">
          {intro.length > LEAD_LIMIT ? (
            <Expandable text={intro} lines={6} moreLabel="Show the rest of the overview" />
          ) : (
            <p className="whitespace-pre-line text-sm leading-relaxed text-ink-soft">{intro}</p>
          )}
        </div>
      )}

      {responsibilities.map((section) => (
        <section key={section.heading} className="card p-6">
          <Heading heading={section.heading} />
          <Body section={section} />
        </section>
      ))}

      {after.map((section) => (
        <section key={section.heading} className="card p-6">
          <Heading heading={section.heading} />
          <Body section={section} />
        </section>
      ))}

      {/* Skills came back but the posting named no sections. Without this
          the page showed the chips and then nothing -- the description
          itself only reachable by opening the raw block at the bottom. */}
      {!hasAnySection && clean && (
        <>
          <section className="card p-6">
            <h2 className="text-lg font-bold tracking-tight">The job</h2>
            <p className="hint mt-1">
              This posting names no sections, so it is here as written — nothing grouped,
              nothing left out.
            </p>
            <div className="mt-4">
              <LabelledList text={role.job} />
            </div>
          </section>
          {role.blurb && <CompanyBlurb blurb={role.blurb} />}
        </>
      )}

      {/* The whole thing, always, however well the sections above came out.
          Everything above is a READING of the posting -- headings matched,
          text grouped -- and a reading can be wrong. Nothing is summarised
          or shortened here: this is the description exactly as the board
          sent it, so there is never a sentence the employer wrote that this
          page has quietly dropped. */}
      <details className="card p-6">
        <summary className="cursor-pointer text-sm font-semibold">
          Read the whole description
          <span className="ml-2 font-normal text-ink-faint">
            {clean.length.toLocaleString()} characters, exactly as posted
          </span>
        </summary>
        <div className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
          {clean}
        </div>
        <p className="hint mt-4">
          Nothing above is written by Job Scout — it is this text, grouped under the
          headings the posting used. Check the original before you apply.
        </p>
        <div className="mt-3">{readOn}</div>
      </details>
    </div>
  );
}
