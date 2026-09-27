/**
 * Checks that a run queries every source that was ticked.
 *
 *   npx tsx scripts/check-sources.ts
 *
 * Sources go down two different paths -- scrapers drive a browser per title
 * per location, the JSON boards ask ten services one question -- and the
 * split between them is silent when it goes wrong: a board that is quietly
 * dropped looks exactly like a board having a quiet day. These are pure
 * functions, so this is cheap enough to run on every check.
 */
import {
  API_BOARDS,
  DEFAULT_JOBS_PER_RUN,
  MAX_JOBS_PER_RUN,
  planFor,
  sourcesOf,
  SOURCE_HINTS,
  SOURCE_OPTIONS,
} from "@/lib/boards";

const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  pass  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function main(): void {
  console.log("one source at a time still works");
  const linkedin = planFor(["LinkedIn"]);
  check(
    "a scraper goes down the scrape path only",
    linkedin.scrapers.join() === "LinkedIn" && !linkedin.searchesApi,
  );
  const stepstone = planFor(["StepStone"]);
  check(
    "a named board goes down the search path only",
    stepstone.scrapers.length === 0 &&
      stepstone.searchesApi &&
      stepstone.apiBoards?.join() === "StepStone",
    JSON.stringify(stepstone),
  );

  console.log("\na run across both kinds does both");
  const mixed = planFor(["LinkedIn", "StepStone", "Indeed"]);
  check("the scraper is kept", mixed.scrapers.join() === "LinkedIn");
  check("and so is every named board", mixed.apiBoards?.join() === "StepStone,Indeed",
    JSON.stringify(mixed.apiBoards));
  check("both paths run", mixed.scrapers.length > 0 && mixed.searchesApi);

  console.log("\nevery ticked source reaches a path");
  for (const source of SOURCE_OPTIONS) {
    const plan = planFor([source]);
    check(
      `${source} is queried`,
      plan.scrapers.length > 0 || plan.searchesApi,
      "ticked and then silently dropped is the failure this file exists for",
    );
  }
  const all = planFor(SOURCE_OPTIONS);
  check(
    "picking everything queries every scraper",
    all.scrapers.length === SOURCE_OPTIONS.filter((s) => planFor([s]).scrapers.length > 0).length,
    JSON.stringify(all.scrapers),
  );

  console.log("\n\"Job boards\" absorbs the individual ones");
  const both = planFor([API_BOARDS, "StepStone"]);
  check(
    "asking for all of them plus one still asks for all of them",
    both.searchesApi && both.apiBoards === null,
    "a named list here would NARROW the search to that one board -- the " +
      "opposite of what ticking both asks for",
  );

  console.log("\nnothing ticked asks for nothing");
  const empty = planFor([]);
  check(
    "no source means no fetch",
    empty.scrapers.length === 0 && !empty.searchesApi,
    "the form blocks this, but a plan that invented a default would run a " +
      "search nobody asked for",
  );

  console.log("\nprofiles saved before a run could span sources");
  check(
    "an empty list falls back to the single old column",
    sourcesOf({ searchBoards: [], searchBoard: "StepStone" }).join() === "StepStone",
  );
  check(
    "a missing list does too",
    sourcesOf({ searchBoard: "Xing" }).join() === "Xing",
  );
  check(
    "and a real list wins",
    sourcesOf({ searchBoards: ["LinkedIn", "Adzuna"], searchBoard: "Xing" }).join() ===
      "LinkedIn,Adzuna",
  );
  check(
    "a source that no longer exists is dropped, not queried",
    sourcesOf({ searchBoards: ["Monster"], searchBoard: "LinkedIn" }).join() === "LinkedIn",
    "boards get removed; a stale name must not reach planFor()",
  );

  console.log("\nthe run-size setting");
  check("the default is inside the allowed range", DEFAULT_JOBS_PER_RUN <= MAX_JOBS_PER_RUN);
  check("and is a real number of jobs", DEFAULT_JOBS_PER_RUN >= 1);

  console.log("\nevery source explains itself");
  for (const source of SOURCE_OPTIONS) {
    check(`${source} has a hint`, Boolean(SOURCE_HINTS[source]?.trim()));
  }

  console.log(`\n${failures.length === 0 ? "all checks passed" : `${failures.length} FAILED`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
