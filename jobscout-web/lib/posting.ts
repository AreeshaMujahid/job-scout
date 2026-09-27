/**
 * Reading a job posting's own structure back out of it.
 *
 * Boards hand over one blob of text. Inside it there is almost always a
 * shape -- what you would do, what they ask for, what they offer -- and
 * flattening that into a wall of paragraph is what makes a posting take five
 * minutes to skim instead of thirty seconds.
 *
 * Two shapes arrive, and both are real. Measured over 179 stored postings:
 *
 *   - Line-shaped. Headings on their own line, bullets marked with • or -.
 *     Remotive, Jobicy, RemoteOK. Roughly one posting in twenty here.
 *   - Flattened. The whole posting on ONE line -- 142 of 142 LinkedIn
 *     descriptions had zero newlines, median length 4kB. The <li> items
 *     became sentences and the <h3> headings became inline "Heading:".
 *
 * A reader that only knew the first shape found structure in 7% of what this
 * app has stored, and none at all in the source that supplies most of it.
 *
 * The rule throughout: NOTHING IS INVENTED. A heading appears here only
 * because the posting wrote one, and no word is ever changed -- the
 * flattened path re-breaks sentences the employer's own <li> tags had
 * already separated, it does not summarise. When a description has no
 * recognisable structure, this returns no sections and the page shows the
 * text as it arrived. Manufacturing "Responsibilities" out of prose would be
 * quoting the employer saying something they did not say.
 */

/**
 * The headings worth pulling out, and the many ways postings write them.
 *
 * One vocabulary, used twice: anchored to the start of a line for the
 * line-shaped postings, and followed by a colon for the flattened ones.
 * Keeping a single list is what stops the two paths disagreeing about what
 * counts as a heading.
 */
const HEADING_WORDS: [string, string][] = [
  [
    "Responsibilities",
    "responsibilities|your responsibilities|key responsibilities|what you.{0,3}ll do|what you will do|what you.{0,3}ll be doing|you will|your role|the role|about the role|your tasks|your mission|duties|aufgaben|ihre aufgaben|deine aufgaben|das erwartet dich|dein verantwortungsbereich",
  ],
  [
    "Qualification",
    "requirements|qualifications|your qualifications|what you bring|what you.{0,3}ll bring|what we.{0,3}re looking for|we would like you to have|who you are|your profile|about you|the ideal candidate|must have|required|required skills|requirements for this role|anforderungen|qualifikationen|ihr profil|dein profil|das bringst du mit|das solltest du mitbringen|voraussetzungen",
  ],
  [
    "Nice to have",
    "preferred|preferred qualifications|nice to have|nice-to-have|bonus points|good to have|w(ü|ue)nschenswert|von vorteil|idealerweise",
  ],
  [
    "What they offer",
    "benefits|what we offer|we offer|what.{0,3}s in it for you|perks|our offer|why join|wir bieten|das bieten wir|unsere benefits|deine vorteile",
  ],
  [
    "About the company",
    "about us|about the company|who we are|(ü|ue)ber uns|das unternehmen|wer wir sind",
  ],
];

/** Anchored: the whole line is the heading. */
const LINE_HEADINGS: [string, RegExp][] = HEADING_WORDS.map(([name, words]) => [
  name,
  new RegExp(`^(${words})\\b`, "i"),
]);

/**
 * Inline: a heading sitting mid-paragraph, followed by a colon.
 *
 * Two things make it a heading rather than prose, and both are needed.
 *
 * The colon: "You will" appears in half of all prose, "You will:" is a
 * heading. Without it this would cut postings in half at random.
 *
 * And a sentence boundary in front of it. This used to accept any
 * whitespace, so an ordinary sentence ENDING in a heading word was split:
 * "...scope technical projects from ambiguous business requirements: you can
 * run a workshop..." got cut at "requirements:", leaving the section opening
 * mid-sentence on a lowercase word. A real heading follows a full stop.
 */
const INLINE_HEADING = new RegExp(
  `(?:^|[.!?]["')\\]]?\\s+|\\n\\s*)((?:${HEADING_WORDS.map(([, w]) => w).join("|")}))\\s*:`,
  "gi",
);

function inlineName(matched: string): string | null {
  const text = matched.trim().toLowerCase();
  for (const [name, words] of HEADING_WORDS) {
    if (new RegExp(`^(${words})$`, "i").test(text)) return name;
  }
  return null;
}

/** A line that is a bullet in the posting, whatever it used to mark one. */
const BULLET = /^\s*([•‣▪◦·*–—-]|\d{1,2}[.)])\s+/;

/**
 * Is this line a heading rather than a sentence?
 *
 * Headings are short, do not end in a full stop, and are not bullets. That
 * last one matters: "- Requirements for the role include..." is a bullet
 * that happens to begin with a heading word, and treating it as a heading
 * would split a list in half.
 */
function headingOf(line: string): string | null {
  const text = line.trim().replace(/^#+\s*/, "").replace(/[:：]\s*$/, "");
  if (!text || text.length > 70 || BULLET.test(line)) return null;
  if (/[.!?]$/.test(text)) return null;
  for (const [name, pattern] of LINE_HEADINGS) {
    if (pattern.test(text)) return name;
  }
  return null;
}

export type PostingSection = {
  /** The name this app uses for it, not the posting's exact wording. */
  heading: string;
  /** What the posting listed there, markers stripped and nothing else. */
  bullets: string[];
  /** Prose under the heading that was not a list. */
  paragraphs: string[];
};

export type ReadPosting = {
  sections: PostingSection[];
  /** Everything before the first recognised heading -- usually the intro. */
  intro: string;
};

function clean(line: string): string {
  return line.replace(BULLET, "").trim();
}

/** Sections whose content is a list of things, not a paragraph about one. */
const LISTY = new Set(["Responsibilities", "Qualification", "Nice to have", "What they offer"]);

/**
 * Split a run of flattened text back into the items it was made of.
 *
 * These were <li> elements before the scraper stripped the markup, so the
 * sentence boundaries are the employer's own item boundaries. Nothing is
 * reworded -- the text is cut where it already ended.
 *
 * Returns [] when the result would not be a credible list, so a genuine
 * paragraph stays a paragraph rather than being chopped into fragments.
 */
function asItems(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?;])\s+(?=[A-ZÄÖÜ])/)
    .map((s) => s.trim())
    .filter(Boolean);

  // All or nothing, deliberately. An earlier version FILTERED parts by
  // length, which quietly dropped whatever did not fit -- text the employer
  // wrote, deleted from the page with no trace. And a single over-long part
  // is the tell that this posting's <li> items carried no full stops, so the
  // boundaries did not survive flattening: splitting on sentences then welds
  // two requirements into one ("...two-sided marketplace Experience applying
  // causal inference..."), which reads as the employer asking for something
  // they never asked for.
  //
  // When the split is not clean, the section stays prose. Plain, whole, and
  // true beats itemised and wrong.
  // 400, not 220, and the gap in the middle is why. Measured on two real
  // postings: the one that should split has a longest part of 278, and the
  // one whose items carried no full stops -- where splitting welds two
  // requirements into one -- has a longest part of 2,497. A cap of 220 sat
  // on the wrong side of that gap and turned a 16-item list into a
  // 2,274-character wall because two sentences ran long.
  const looksLikeAList =
    parts.length >= 3 && parts.every((p) => p.length >= 20 && p.length <= 400);
  return looksLikeAList ? parts : [];
}

/** The flattened shape: one long line, headings marked by a colon. */
function readFlattened(text: string): ReadPosting {
  const found: { name: string; at: number; end: number }[] = [];
  for (const match of text.matchAll(INLINE_HEADING)) {
    const name = inlineName(match[1]);
    if (!name || match.index === undefined) continue;
    found.push({
      name,
      at: match.index + match[0].indexOf(match[1]),
      end: match.index + match[0].length,
    });
  }
  if (found.length === 0) return { sections: [], intro: text.trim() };

  const sections: PostingSection[] = [];
  for (let i = 0; i < found.length; i++) {
    const body = text.slice(found[i].end, found[i + 1]?.at ?? text.length).trim();
    if (body.length < 25) continue;

    const existing = sections.find((s) => s.heading === found[i].name);
    const section = existing ?? { heading: found[i].name, bullets: [], paragraphs: [] };
    if (!existing) sections.push(section);

    const items = LISTY.has(section.heading) ? asItems(body) : [];
    if (items.length > 0) section.bullets.push(...items);
    else section.paragraphs.push(body);
  }

  return { sections, intro: text.slice(0, found[0].at).trim() };
}

/** The line-shaped posting: headings on their own line, bullets marked. */
function readLines(text: string): ReadPosting {
  const sections: PostingSection[] = [];
  const intro: string[] = [];
  let current: PostingSection | null = null;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const heading = headingOf(line);

    if (heading) {
      // The same heading twice ("Requirements" then "Required skills") is
      // one section, not two half-empty ones.
      const existing = sections.find((s) => s.heading === heading);
      current = existing ?? { heading, bullets: [], paragraphs: [] };
      if (!existing) sections.push(current);
      continue;
    }
    if (!trimmed) continue;

    if (current) {
      if (BULLET.test(line)) {
        const item = clean(line);
        if (item) current.bullets.push(item);
      } else {
        current.paragraphs.push(trimmed);
      }
    } else {
      intro.push(trimmed);
    }
  }

  // Lines that were list items without a marker.
  //
  // Plenty of postings put one requirement per line and never write a bullet
  // character -- the line break IS the boundary, and the employer drew it.
  // Rendering those as bullets changes no text, only how it is shown; the
  // guard is the same as asItems(), so a section of real prose stays prose.
  for (const section of sections) {
    if (!LISTY.has(section.heading)) continue;
    if (section.bullets.length > 0 || section.paragraphs.length < 3) continue;
    if (!section.paragraphs.every((p) => p.length >= 20 && p.length <= 220)) continue;
    section.bullets = section.paragraphs;
    section.paragraphs = [];
  }

  return { sections, intro: intro.join("\n") };
}

/**
 * Strip the board's own UI text out of a description.
 *
 * LinkedIn renders its description behind a "Show more" toggle, and reading
 * the container's text takes the button with it -- measured, 188 of 232
 * stored descriptions end in "Show more Show less". job_scout strips this at
 * the source now, but everything fetched before that still carries it, so it
 * comes off here too rather than leaving a year of postings looking as
 * though the employer signed off with a button.
 *
 * Anchored to the end or to a matched pair, so ordinary prose survives: "we
 * show more of the roadmap than most" is a sentence, not a control.
 */
const CHROME_PAIR =
  /\s*\b(show more|see more|read more|mehr anzeigen)\s+(show less|see less|weniger anzeigen)\b\s*/gi;
const CHROME_TAIL =
  /\s*\b(show more|show less|see more|see less|read more|mehr anzeigen|weniger anzeigen|apply now|save job)\b\s*$/i;

export function tidy(description: string): string {
  let text = (description || "").replace(CHROME_PAIR, " ");
  for (let i = 0; i < 3; i++) {
    const next = text.replace(CHROME_TAIL, "");
    if (next === text) break;
    text = next;
  }
  return text.trim();
}

/**
 * Where a posting stops talking about itself and starts describing the job.
 *
 * Almost every advert opens with the company: mission, scale, awards, values.
 * That is not what anyone opened the page for. Measured across the 178 stored
 * postings that carry no headings at all, 113 of them name the moment the job
 * begins -- "In this role, you will", "Ihre Aufgaben", "What you'll do" --
 * and the blurb before it averages a fifth of the text.
 *
 * These are ROLE markers, not headings: they need no colon, because each is
 * a phrase nobody writes mid-paragraph about something else.
 */
const ROLE_START = new RegExp(
  "(?:^|[.!?)\\]]\\s+|\\n\\s*)(" +
    [
      "as (?:a|an|our)[^.]{0,60}?,? you will",
      "in this role,? you",
      "you will be responsible for",
      "your (?:tasks|responsibilities|mission|role) (?:will )?(?:include|are|is)",
      "we are looking for",
      "we.{0,3}re looking for",
      "what you.{0,3}ll do",
      "what you will do",
      "your day.to.day",
      "about the role",
      "the role",
      "deine aufgaben",
      "ihre aufgaben",
      "das erwartet dich",
      "wir suchen",
    ].join("|") +
    ")",
  "i",
);

export type RoleSplit = {
  /** What the company said about itself before getting to the job. */
  blurb: string;
  /** The job. The whole text when no start marker was found. */
  job: string;
};

/**
 * Split a description into the company's preamble and the job itself.
 *
 * Conservative on both sides. A marker in the first 80 characters is the
 * posting opening with the job, so there is no blurb to speak of; a marker
 * past two thirds is something else that happened to read like one, and
 * splitting there would file most of the job under "about the company".
 * Either way the answer is "no split", and the caller shows the whole text.
 */
export function splitRole(description: string): RoleSplit {
  const text = tidy(description);
  const match = text.match(ROLE_START);
  const at = match?.index;

  if (at === undefined || at < 80 || at > text.length * 0.66) {
    return { blurb: "", job: text };
  }
  // Start the job at the marker itself, not after it -- "Ihre Aufgaben" is
  // the first thing the reader should see, not a word that vanished.
  const marker = match?.[1] ?? "";
  const start = at + (match?.[0].length ?? 0) - marker.length;
  let job = text.slice(start).trim();

  // "What you'll doAdvise on AI trust..." -- the heading ran straight into
  // its first item when the markup was stripped, and reads as a typo. A
  // newline puts the break back. Whitespace only: no word is changed, none
  // added, none removed.
  if (marker && job.startsWith(marker)) {
    const after = job.slice(marker.length).replace(/^[ \t]+/, "");
    // An uppercase letter straight after the marker means the heading ran
    // into its first item -- with a space ("do Own the pipeline") or
    // without one ("doAdvise on AI trust"). Either way it wants its own
    // line, and moving whitespace changes no word.
    if (/^[A-ZÄÖÜ]/.test(after)) job = marker + "\n" + after;
  }

  return { blurb: text.slice(0, at).trim(), job };
}

/**
 * A short capitalised phrase followed by a colon, starting a sentence.
 *
 * One to four words, with no sentence punctuation inside, then a colon and
 * a capital letter. That shape is a label -- "Dein Impact:", "Monitoring:",
 * "Deployment:" -- and a posting that uses it several times has written a
 * list whose markers did not survive the markup being stripped.
 *
 * This is reading the employer's punctuation, not guessing at their intent.
 * The words are theirs; only the line breaks are restored.
 */
const LABEL =
  /(?:^|[.!?]\s+|\n\s*)((?:[A-ZÄÖÜ][^\s:.!?]*(?:\s+[^\s:.!?]+){0,3}))\s*:\s+(?=[A-ZÄÖÜ])/g;

export type LabelledItem = { label: string; body: string };
export type LabelledRun = {
  /** Anything before the first label. Kept, never dropped. */
  lead: string;
  items: LabelledItem[];
};

/**
 * Read a run of "Label: sentence" items out of flattened text.
 *
 * Returns no items unless there are at least three -- two could be ordinary
 * prose that happens to use colons ("Standorte: Berlin"), while three or
 * more in one description is a list. Measured: 27 of the 101 postings that
 * had no other structure are shaped exactly like this.
 */
export function labelledItems(description: string): LabelledRun {
  const text = tidy(description);
  const found = [...text.matchAll(LABEL)];
  if (found.length < 3) return { lead: text, items: [] };

  const items: LabelledItem[] = [];
  for (let i = 0; i < found.length; i++) {
    const m = found[i];
    if (m.index === undefined) continue;
    const labelAt = m.index + m[0].indexOf(m[1]);
    const bodyAt = m.index + m[0].length;
    const nextAt = found[i + 1]?.index ?? text.length;
    const body = text.slice(bodyAt, nextAt).trim();
    // A label with nothing under it is a colon in a sentence, not an item.
    if (body.length < 15) continue;
    items.push({ label: text.slice(labelAt, bodyAt).replace(/\s*:\s*$/, "").trim(), body });
  }

  if (items.length < 3) return { lead: text, items: [] };
  const firstAt = found[0].index ?? 0;
  return { lead: text.slice(0, firstAt).trim(), items };
}

/**
 * Split a description into the sections it wrote for itself.
 *
 * Returns no sections when the posting has no structure this recognises,
 * which is the honest answer and the signal to show the raw text instead.
 */
export function readPosting(description: string): ReadPosting {
  const text = tidy(description);
  const newlines = (text.match(/\n/g) ?? []).length;

  // Which shape this is. A long description with almost no line breaks came
  // out of a scraper that dropped the markup; anything else kept its lines.
  const read = newlines < 3 && text.length > 400 ? readFlattened(text) : readLines(text);

  return {
    // A heading with nothing under it says nothing, and an empty panel on
    // the page reads as a bug rather than as a quiet posting.
    sections: read.sections.filter((s) => s.bullets.length > 0 || s.paragraphs.length > 0),
    intro: read.intro,
  };
}
