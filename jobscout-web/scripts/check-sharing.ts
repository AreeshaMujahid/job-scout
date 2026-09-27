/**
 * Checks the rules that make a shared deployment safe to open up.
 *
 *   npx tsx scripts/check-sharing.ts
 *
 * LinkedIn and Xing are read through the owner's own logged-in browser
 * profile -- one real account, that person's session cookies, one IP. Indeed
 * needs a visible browser and cannot run on a server at all. If a stranger's
 * search can reach any of them, every stranger's search goes out through the
 * owner's LinkedIn account, which is how an account gets restricted.
 *
 * So this is not a UI preference. It is the rule that decides whether this
 * app can have a second user.
 */
import {
  allowedSources,
  isPersonalSource,
  PERSONAL_SOURCES,
  sourcesVisibleTo,
  SINGLE_API_BOARDS,
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
  console.log("what a stranger may search");
  const theirs = sourcesVisibleTo(false);
  for (const source of PERSONAL_SOURCES) {
    check(
      `${source} is not offered`,
      !theirs.includes(source),
      "this runs on the owner's own logged-in browser session",
    );
  }
  check(
    "the public boards still are",
    SINGLE_API_BOARDS.filter((s) => !isPersonalSource(s)).every((s) => theirs.includes(s)),
    JSON.stringify(theirs),
  );
  check("and something is left to search", theirs.length >= 3, JSON.stringify(theirs));

  console.log("\nwhat the owner may search");
  check(
    "everything, including their own sources",
    sourcesVisibleTo(true).length === SOURCE_OPTIONS.length,
    "the owner's own account is the one case where these are fine",
  );

  console.log("\nthe server does not trust the form");
  // A hidden button stops an honest mistake. This is the one that stops a
  // crafted post, and it is the only one that actually protects the account.
  const forged = allowedSources(["LinkedIn", "Xing", "Indeed", "StepStone"], false);
  check(
    "personal sources are stripped from a forged submission",
    forged.join() === "StepStone",
    JSON.stringify(forged),
  );
  check(
    "the owner's submission is untouched",
    allowedSources(["LinkedIn", "StepStone"], true).join() === "LinkedIn,StepStone",
  );
  check(
    "a stranger asking only for personal sources gets none",
    allowedSources(["LinkedIn", "Indeed"], false).length === 0,
    "the action falls back to StepStone and says why",
  );

  console.log("\nnothing has quietly joined the safe list");
  // A new browser-driven source added later must be declared personal, or it
  // silently becomes available to everyone.
  for (const source of ["LinkedIn", "Xing", "Indeed"]) {
    check(`${source} is declared personal`, isPersonalSource(source));
  }
  check(
    "and the public boards are not",
    ["StepStone", "Adzuna", "Arbeitnow"].every((s) => !isPersonalSource(s)),
  );

  console.log(`\n${failures.length === 0 ? "all checks passed" : `${failures.length} FAILED`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
