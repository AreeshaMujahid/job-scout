/**
 * Checks that the posting reader finds real structure and invents none.
 *
 *   npx tsx scripts/check-posting.ts
 *
 * The dangerous failure is not missing a heading -- that falls back to the
 * raw text, which is merely plain. It is manufacturing a "Responsibilities"
 * list out of prose the employer never wrote as one, because the page then
 * quotes the company saying something it did not say.
 */
import { labelledItems, readPosting, splitRole, tidy } from "@/lib/posting";

const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  pass  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const ENGLISH = `
We are a healthcare company building tools for clinicians.

Responsibilities
- Develop advanced data analytical models
- Collaborate with business partners
* Mentor junior team members

Requirements:
• Bachelor's or Master's degree in statistics
• Intermediate proficiency in R, Python or other statistical packages

Nice to have
- Experience with Dataiku

What we offer
- Comp & benefits
`;

const GERMAN = `
Wir sind ein Technologieunternehmen aus Berlin.

Deine Aufgaben
· Entwicklung von Machine-Learning-Modellen
· Zusammenarbeit mit Fachbereichen

Dein Profil
– Abgeschlossenes Studium der Informatik
– Erfahrung mit Python

Wir bieten
- 30 Tage Urlaub
`;

const NO_STRUCTURE = `
We are looking for a data scientist to join our team. You will build models
and work with stakeholders. You should have a degree and know Python. We
offer a competitive salary and a friendly office.
`;

function main(): void {
  console.log("an English posting");
  const en = readPosting(ENGLISH);
  const heads = en.sections.map((s) => s.heading);
  check(
    "finds the sections it wrote",
    heads.join() === "Responsibilities,Qualification,Nice to have,What they offer",
    JSON.stringify(heads),
  );
  const duties = en.sections.find((s) => s.heading === "Responsibilities");
  check("keeps every bullet", duties?.bullets.length === 3, JSON.stringify(duties?.bullets));
  check(
    "strips the marker and nothing else",
    duties?.bullets[0] === "Develop advanced data analytical models",
    JSON.stringify(duties?.bullets[0]),
  );
  check(
    "handles -, * and • as the same thing",
    en.sections.find((s) => s.heading === "Qualification")?.bullets.length === 2,
  );
  check("keeps the intro before the first heading", en.intro.includes("healthcare company"));

  console.log("\na German posting");
  const de = readPosting(GERMAN);
  const deHeads = de.sections.map((s) => s.heading);
  check(
    "reads Aufgaben / Profil / Wir bieten",
    deHeads.join() === "Responsibilities,Qualification,What they offer",
    JSON.stringify(deHeads),
  );
  check(
    "and the German bullet characters with them",
    de.sections[0].bullets[0] === "Entwicklung von Machine-Learning-Modellen",
    JSON.stringify(de.sections[0].bullets),
  );

  console.log("\na posting with no structure at all");
  const flat = readPosting(NO_STRUCTURE);
  check(
    "invents no sections",
    flat.sections.length === 0,
    "prose must never be dressed up as a list the employer wrote",
  );
  check("and hands the text back whole", flat.intro.includes("competitive salary"));

  console.log("\na flattened posting -- one line, colon headings");
  // Shaped like the real LinkedIn descriptions: no newlines, <li> items
  // collapsed into sentences, headings left inline with a colon.
  const FLAT =
    "Clariness is looking for a DevOps Engineer based in Berlin. About the role: " +
    "This role is about ensuring that our global cloud infrastructure remains " +
    "reliable, secure and ready to scale for the teams that depend on it. " +
    "We would like you to have: A degree in Computer Science, Information " +
    "Technology or equivalent practical experience. Hands-on experience working " +
    "with production infrastructure on AWS, ideally including ECS and RDS. " +
    "Practical experience with Terraform, including modules and state management. " +
    "Experience with CI/CD pipelines and container deployment processes. " +
    "We offer: A competitive salary reviewed every year without you asking. " +
    "Thirty days of paid holiday plus public holidays in your region. " +
    "A hardware budget for whatever machine you actually want to work on.";

  const flatRead = readPosting(FLAT);
  const flatHeads = flatRead.sections.map((s) => s.heading);
  check(
    "finds the inline headings",
    flatHeads.includes("Qualification") && flatHeads.includes("What they offer"),
    JSON.stringify(flatHeads),
  );
  const quals = flatRead.sections.find((s) => s.heading === "Qualification");
  check(
    "splits the run back into the items it was made of",
    (quals?.bullets.length ?? 0) >= 3,
    JSON.stringify(quals?.bullets),
  );
  check(
    "and changes not one word of them",
    Boolean(quals?.bullets.every((b) => FLAT.includes(b))),
    "every item must appear verbatim in the original",
  );
  check(
    "keeps the intro before the first heading",
    flatRead.intro.startsWith("Clariness is looking"),
    JSON.stringify(flatRead.intro.slice(0, 40)),
  );

  console.log("\nthe colon is what makes it a heading");
  const prose =
    "You will be working with a team of engineers who care about their craft " +
    "and you will have plenty of room to grow into the role over time. The " +
    "company has offices in Berlin and Munich and we offer flexible hours to " +
    "everyone regardless of level or tenure across the whole organisation.";
  check(
    "\"you will\" without a colon is prose, not a heading",
    readPosting(prose).sections.length === 0,
    JSON.stringify(readPosting(prose).sections.map((s) => s.heading)),
  );

  check(
    "a section with almost nothing under it is dropped",
    readPosting("Responsibilities: Do the thing.").sections.length === 0,
    "too little to be worth a panel",
  );

  console.log("\nthings that look like headings but are not");
  const trap = readPosting(
    "Responsibilities\n- Requirements gathering with stakeholders\n- About us we are hiring\n",
  );
  check(
    "a bullet starting with a heading word stays a bullet",
    trap.sections.length === 1 && trap.sections[0].bullets.length === 2,
    JSON.stringify(trap.sections.map((s) => [s.heading, s.bullets])),
  );

  const sentence = readPosting("You will have responsibilities across the team.\n");
  check(
    "a sentence ending in a full stop is not a heading",
    sentence.sections.length === 0,
    JSON.stringify(sentence.sections),
  );

  console.log("\nnothing is dropped on the way through");
  // The page says the sections are the posting "grouped under the headings
  // it used". That is a claim about not losing anything, so it needs a test:
  // every sentence of the original has to come out the other side.
  function words(text: string): string[] {
    return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  }

  for (const [label, source] of [
    ["line-shaped", ENGLISH],
    ["German", GERMAN],
    ["flattened", FLAT],
  ] as const) {
    const read = readPosting(source);
    const out = [
      read.intro,
      ...read.sections.flatMap((s) => [...s.bullets, ...s.paragraphs]),
    ].join(" ");
    const got = new Set(words(out));
    // Heading words legitimately disappear: they become the section's name.
    const headingish = new Set(words(
      "responsibilities requirements qualifications nice to have preferred " +
      "what we offer deine aufgaben dein profil wir bieten about the role " +
      "we would like you to have",
    ));
    const lost = words(source).filter((w) => !got.has(w) && !headingish.has(w));
    check(
      `${label}: every word survives into a section`,
      lost.length === 0,
      `lost: ${JSON.stringify(lost.slice(0, 12))}`,
    );
  }

  console.log("\nthe board's own buttons are not the posting");
  // LinkedIn renders its description behind a toggle, and scraping the
  // container takes the button with it: 188 of 232 stored descriptions
  // ended in "Show more Show less", which read on the page as though the
  // employer had signed off with a control.
  check(
    "a trailing Show more / Show less pair comes off",
    tidy("...our Privacy Notice. Show more Show less") === "...our Privacy Notice.",
    JSON.stringify(tidy("...our Privacy Notice. Show more Show less")),
  );
  check(
    "and a lone one at the end",
    tidy("Real text here. Show more") === "Real text here.",
  );
  check(
    "German too",
    tidy("Echter Text. Mehr anzeigen Weniger anzeigen") === "Echter Text.",
    JSON.stringify(tidy("Echter Text. Mehr anzeigen Weniger anzeigen")),
  );
  check(
    "ordinary prose is left alone",
    tidy("We show more of the roadmap than most companies do.") ===
      "We show more of the roadmap than most companies do.",
    "stripping a phrase mid-sentence would edit the employer's words",
  );
  check(
    "and so is a sentence that opens with one",
    tidy("Apply now to join us and show more initiative.") ===
      "Apply now to join us and show more initiative.",
  );
  check(
    "readPosting sees the tidied text",
    !JSON.stringify(readPosting(["Responsibilities", "- Build things that last", "Show more Show less"].join("\n")))
      .includes("Show more"),
  );

  console.log("\ntelling the company blurb from the job");
  // Adverts open with the company: mission, scale, awards. Measured, 113 of
  // the 178 postings that carry no headings name the moment the job starts,
  // and the blurb before it averages a fifth of the text. The job leads;
  // the blurb is kept, moved below it, and folded shut.
  const ADVERT =
    "HARTING stands for strong connections across the globe. As one of the " +
    "leading suppliers we employ 6,000 people worldwide and have won awards " +
    "for our culture every year since 2015. In this role, you will build and " +
    "own machine learning services end to end, working with product teams.";

  const advert = splitRole(ADVERT);
  check(
    "the job starts at the marker",
    advert.job.startsWith("In this role"),
    JSON.stringify(advert.job.slice(0, 40)),
  );
  check(
    "the company blurb is kept, not discarded",
    advert.blurb.includes("HARTING") && advert.blurb.includes("awards"),
  );
  check(
    "and between them nothing is lost",
    advert.blurb.length + advert.job.length >= ADVERT.length - 4,
    "every character has to land on one side or the other",
  );

  const noMarker = "We build tools for clinicians and are hiring a data scientist to help.";
  check(
    "a posting with no marker is all job and no blurb",
    splitRole(noMarker).blurb === "" && splitRole(noMarker).job.length > 0,
    "inventing a split would file the job under About the company",
  );

  const lateMarker = "x".repeat(400) + ". We are looking for someone.";
  check(
    "a marker near the end is not a split point",
    splitRole(lateMarker).blurb === "",
    "splitting there would call most of the job a company blurb",
  );

  const runOn = splitRole(
    "We are a large engineering company with offices across Europe and a " +
      "long history of building infrastructure that other companies rely on. " +
      "What you will do Own the data pipeline end to end, from ingestion " +
      "through to serving. Mentor two junior engineers. Work with product " +
      "teams to turn vague questions into models that answer them.",
  );
  check(
    "a heading that ran into its first item gets its line break back",
    runOn.job.includes("What you will do" + "\n"),
    JSON.stringify(runOn.job.slice(0, 40)),
  );

  console.log("\na run of labelled items");
  // Plenty of postings write a list as "Label: sentence." repeated, and
  // flattening leaves it as one paragraph. Measured, 27 of the postings with
  // no other structure are shaped this way -- the Deloitte advert runs
  // "Dein Impact:", "Monitoring:", "Incident Management:", "Deployment:".
  const LABELLED =
    "Deloitte bietet Beratungsleistungen weltweit an. " +
    "Dein Impact: Als Consultant unterstützt du unsere Kunden bei der " +
    "Entwicklung moderner Lösungen. " +
    "Monitoring: Du überwachst kontinuierlich Anwendungen und Systeme. " +
    "Incident Management: Du bearbeitest Störungen nach definierten Prozessen. " +
    "Deployment: Du setzt neue Software-Releases produktiv und stellst Qualität sicher.";

  const run = labelledItems(LABELLED);
  check(
    "the labels become the list the employer wrote",
    run.items.length === 4,
    JSON.stringify(run.items.map((i) => i.label)),
  );
  check(
    "each label keeps its own sentence",
    run.items[1]?.label === "Monitoring" && run.items[1]?.body.startsWith("Du überwachst"),
    JSON.stringify(run.items[1]),
  );
  check(
    "the text before the first label is kept",
    run.lead.startsWith("Deloitte bietet"),
    JSON.stringify(run.lead),
  );
  check(
    "and nothing is lost between lead and items",
    run.lead.length + run.items.reduce((n, i) => n + i.label.length + i.body.length, 0) >=
      LABELLED.length - 3 * run.items.length - 4,
    "every character lands in the lead or in an item",
  );

  console.log("\nand prose that merely uses a colon is left alone");
  check(
    "two colons are not a list",
    labelledItems(
      "We work in Berlin. Note: the office is central. " +
        "The team is small and we ship often every single week of the year.",
    ).items.length === 0,
    "three or more is a list; fewer is punctuation",
  );
  check(
    "a label with nothing under it is not an item",
    labelledItems("Alpha: ok. Beta: no. Gamma: hm. Delta: x.").items.length === 0,
    "a colon inside a sentence must not become a bullet",
  );

  console.log("\nempty and broken input");
  check("empty description is empty, not a crash", readPosting("").sections.length === 0);
  check(
    "a heading with nothing under it is dropped",
    readPosting("Responsibilities\n\nBenefits\n- Free coffee\n").sections
      .map((s) => s.heading)
      .join() === "What they offer",
    "an empty panel reads as a bug, not as a quiet posting",
  );

  console.log(`\n${failures.length === 0 ? "all checks passed" : `${failures.length} FAILED`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
