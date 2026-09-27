"""Who you already know at a company, for one job you are considering.

Reads the "People you can reach out to" module LinkedIn itself renders on a
job page when you are signed in -- its own referral surface, showing your own
connections and school alumni. Nothing here searches for people, and nothing
builds an index of them.

TWO LOOKUPS, DELIBERATELY DIFFERENT
  * fetch_referral_contacts reads only that module -- the applicant's own
    network, on one posting.
  * fetch_company_people reads a company's "People" tab, which is a
    different thing and a heavier one: those people have no relationship to
    the user. Added on explicit request, bounded to COMPANY_PEOPLE_LIMIT,
    and never called in a loop or on a schedule.

WHAT NEITHER DOES
  * Neither runs on a schedule or in the background. Every call is one the
    user asked for.
  * It does not take every /in/ link on the page. The links are read from
    inside the referral module only -- a page-wide sweep picks up whoever
    happens to appear in a sidebar, and mislabelling a stranger as "someone
    who can refer you" is worse than showing nothing.

COSTS THE CALLER SHOULD KNOW
  Each call drives a real, signed-in browser to a real LinkedIn page.
  That is against LinkedIn's terms of service, it is slow (seconds), and
  automated page loads on a personal account carry a real risk of that
  account being flagged. The bot's own module docstring makes the same
  point about its scrapers. Use sparingly and never in a loop.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import List, Optional

log = logging.getLogger(__name__)

# The module's own heading, in the wordings LinkedIn has been seen to use.
# Matched against a heading's text, not the whole page, so an unrelated
# mention of "connections" elsewhere cannot select the container.
_MODULE_HEADING = re.compile(
    r"people you can reach out to|people you may know|"
    r"connections? (who |that )?work|alumni",
    re.I,
)

_DEGREE = re.compile(r"•?\s*(1st|2nd|3rd)\b", re.I)


@dataclass
class ReferralContact:
    """One person LinkedIn suggested for this job, as shown to this user."""

    name: str
    profile_url: str
    headline: str = ""
    degree: str = ""

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "profile_url": self.profile_url,
            "headline": self.headline,
            "degree": self.degree,
        }


# Runs in the page. Finds the referral module by its heading, then reads the
# person links inside THAT container only.
_EXTRACT_JS = """() => {
  const NL = String.fromCharCode(10);
  const headingRe = /people you can reach out to|people you may know|connections? (who |that )?work|alumni/i;

  // The heading element, then the nearest ancestor that actually holds
  // person links -- the heading's own parent is often just a text wrapper.
  let container = null;
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,span,div'));
  for (const h of headings) {
    const first = (h.innerText || '').trim().split(NL)[0].trim();
    if (!first || first.length > 70 || !headingRe.test(first)) continue;
    let node = h;
    for (let i = 0; i < 6 && node; i++) {
      if (node.querySelectorAll("a[href*='/in/']").length > 0) { container = node; break; }
      node = node.parentElement;
    }
    if (container) break;
  }
  if (!container) return { found: false, people: [] };

  const seen = new Set();
  const people = [];
  container.querySelectorAll("a[href*='/in/']").forEach(a => {
    const href = (a.href || '').split('?')[0];
    if (!href || seen.has(href)) return;
    seen.add(href);
    const lines = (a.innerText || '').split(NL).map(s => s.trim()).filter(Boolean);
    people.push({ href: href, lines: lines });
  });
  return { found: true, people: people };
}"""


def _friendly(exc: Exception) -> str:
    """Turn a Playwright failure into something a person can act on.

    Playwright's own message for a missing browser is six lines of box-drawing
    characters wrapped around "playwright install", which arrives in the web
    UI as a wall of broken glyphs and tells the reader nothing they can do
    from where they are standing. The browser is an optional extra for this
    feature alone, so its absence deserves one sentence and the command.
    """
    text = str(exc)
    if "Executable doesn't exist" in text or "playwright install" in text:
        return (
            "Referral lookups need a browser, which is an optional extra. "
            "Install it once with: python -m playwright install chromium"
        )
    # Everything else keeps its own message, minus the box drawing.
    cleaned = " ".join(
        part.strip()
        for part in text.replace("║", " ").replace("═", " ").split()
    )
    return cleaned[:300]


def fetch_referral_contacts(
    job_url: str,
    *,
    profile_dir: str = ".pw-profile",
    timeout_ms: int = 20000,
) -> List[ReferralContact]:
    """People LinkedIn suggests you could reach out to about this posting.

    Returns an empty list when the module is not on the page -- which is the
    common case, not an error: most postings show nobody, because the user
    has no connection there. Raises RuntimeError only when the browser could
    not be driven at all, so "we could not look" is never reported as
    "you know nobody there".
    """
    if "linkedin.com" not in (job_url or ""):
        return []  # only LinkedIn renders this module

    from playwright.sync_api import sync_playwright

    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(profile_dir, headless=True)
            try:
                page = ctx.new_page()
                page.goto(job_url, wait_until="domcontentloaded", timeout=timeout_ms)
                # The module is rendered client-side after the posting itself.
                page.wait_for_timeout(4500)

                if "authwall" in page.url or "/login" in page.url:
                    raise RuntimeError(
                        "LinkedIn is not signed in. Sign in once with: "
                        "python -m job_scout.linkedin_login"
                    )

                result = page.evaluate(_EXTRACT_JS)
            finally:
                ctx.close()
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(_friendly(exc)) from exc

    if not result.get("found"):
        return []
    return _to_contacts(result.get("people", []))


def _to_contacts(raw: List[dict]) -> List[ReferralContact]:
    """Turn the raw link text into contacts, dropping anything unusable.

    LinkedIn renders a person card's name, connection degree and headline as
    separate lines inside one anchor, and repeats the name for the image
    link -- so the lines are de-duplicated in order rather than taken
    positionally, which breaks the moment a card gains a row.
    """
    contacts: List[ReferralContact] = []
    for item in raw:
        href = item.get("href") or ""
        lines: List[str] = []
        for line in item.get("lines", []):
            if line and line not in lines:
                lines.append(line)
        if not href or not lines:
            continue

        name = lines[0]
        degree = ""
        headline = ""
        for line in lines[1:]:
            match = _DEGREE.search(line)
            if match and not degree:
                degree = match.group(1).lower()
                continue
            if not headline and len(line) > 2:
                headline = line

        # A card with no readable name is not worth showing as a contact.
        if len(name) < 2 or name.lower().startswith("view "):
            continue
        contacts.append(
            ReferralContact(
                name=name, profile_url=href, headline=headline[:120], degree=degree
            )
        )
    return contacts

# --- Beyond the user's own network -----------------------------------------
#
# Reads a company's own People tab. This is a different thing from the module
# above and the caller should know it: the people here have no relationship to
# the user, so it is bounded to COMPANY_PEOPLE_LIMIT, runs only when asked for
# one company, and is never called in a loop or on a schedule.
#
# It is also the riskiest call in this project. Automated loads of a company
# People page look far more like scraping than a job page does, it is against
# LinkedIn's terms of service, and the account doing it is the user's real one.
COMPANY_PEOPLE_LIMIT = 10

_COMPANY_PEOPLE_JS = """() => {
  const NL = String.fromCharCode(10);
  const out = [];
  // The person card, confirmed live against LinkedIn's rendered DOM rather
  // than guessed: a page-wide sweep of /in/ links also picked up company
  // entries from other modules ("Douglas", "Siemens Energy") and returned
  // each person twice, once per link in their card.
  document.querySelectorAll('.org-people-profile-card__profile-info').forEach(card => {
    const hrefs = Array.from(card.querySelectorAll("a[href*='/in/']"))
      .map(a => (a.href || '').split('?')[0])
      .filter(Boolean);
    if (!hrefs.length) return;
    // Every card carries the same person twice: a readable vanity URL and
    // LinkedIn's opaque /in/ACoAA... form. Keep the one a human can read.
    let href = hrefs[0];
    for (const h of hrefs) {
      if (h.indexOf('/in/ACoAA') === -1) { href = h; break; }
    }
    const lines = [];
    (card.innerText || '').split(NL).forEach(l => {
      const s = l.trim();
      if (s && lines.indexOf(s) === -1) lines.push(s);
    });
    if (lines.length) out.push({ href: href, lines: lines });
  });
  return out;
}"""


def fetch_company_people(
    company_url: str,
    *,
    keyword: str = "",
    limit: int = COMPANY_PEOPLE_LIMIT,
    profile_dir: str = ".pw-profile",
    timeout_ms: int = 30000,
) -> List[ReferralContact]:
    """Staff at one company, for finding somebody to ask about a referral.

    `keyword` narrows it the way the page's own search box does -- "recruiter"
    is the one worth starting from, since recruiters answer cold messages far
    more often than engineers do.

    Bounded at `limit` deliberately. The page lazy-loads more on scroll and
    this never scrolls: a job seeker needs a few names to approach, not an
    export of the staff list.
    """
    if not company_url or "linkedin.com" not in company_url:
        return []

    from playwright.sync_api import sync_playwright

    url = company_url.rstrip("/") + "/people/"
    if keyword.strip():
        from urllib.parse import quote

        url += "?keywords=" + quote(keyword.strip())

    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(profile_dir, headless=True)
            try:
                page = ctx.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                page.wait_for_timeout(6000)
                if "authwall" in page.url or "/login" in page.url:
                    raise RuntimeError(
                        "LinkedIn is not signed in. Sign in once with: "
                        "python -m job_scout.linkedin_login"
                    )
                raw = page.evaluate(_COMPANY_PEOPLE_JS)
            finally:
                ctx.close()
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(_friendly(exc)) from exc

    return _to_company_contacts(raw)[:limit]

# Lines on a person card that are not the person's role. The degree appears
# twice ("2nd degree connection" and a "· 2nd" chip), and the mutuals line
# names other people entirely -- none of it belongs in a headline.
_CARD_NOISE = re.compile(
    r"^[0-9]+(st|nd|rd|th) degree connection$|"
    r"^[·•]?[\s ]*[0-9]+(st|nd|rd|th)$|"
    r"mutual connection|"
    r"^(connect|message|follow|view profile)$",
    re.I,
)


def _to_company_contacts(raw: "List[dict]") -> "List[ReferralContact]":
    """Parse the company People card, which has a different shape from the
    referral module: name first, the connection degree twice, then the
    headline, then a mutual-connections line."""
    contacts = []
    for item in raw:
        href = item.get("href") or ""
        lines = [l for l in item.get("lines", []) if l]
        if not href or not lines:
            continue

        name = lines[0]
        if len(name) < 2 or _CARD_NOISE.search(name):
            continue

        degree = ""
        headline = ""
        for line in lines[1:]:
            match = re.search(r"([0-9]+)(st|nd|rd|th)", line)
            if match and _CARD_NOISE.search(line):
                if not degree:
                    degree = match.group(1) + match.group(2)
                continue
            if _CARD_NOISE.search(line):
                continue
            if not headline:
                headline = line

        contacts.append(
            ReferralContact(
                name=name, profile_url=href, headline=headline[:120], degree=degree
            )
        )
    return contacts

# --- Finding a company's LinkedIn page from its name -----------------------
#
# Needed because only LinkedIn-sourced postings arrive with a company URL
# attached. A job found on Xing, Arbeitnow or one of the JSON boards has a
# company NAME and nothing else, so searching for people there means finding
# the company's LinkedIn page first.
#
# Costs one extra page load on top of the People tab -- so the resolved URL
# is handed back to the caller to store on the job, and this runs once per
# company rather than once per click.

_COMPANY_SEARCH_JS = r"""() => {
  const NL = String.fromCharCode(10);
  const out = [];
  const seen = new Set();
  document.querySelectorAll("a[href*='/company/']").forEach(a => {
    const href = (a.href || '').split('?')[0].replace(/\/$/, '');
    // Only a company's own page: /company/<slug>, not /company/<slug>/jobs
    // or a post that happens to mention one.
    const m = href.match(/^https?:\/\/[^/]*linkedin\.com\/company\/[^/]+$/);
    if (!m || seen.has(href)) return;
    const text = (a.innerText || '').split(NL).map(s => s.trim()).filter(Boolean)[0] || '';
    seen.add(href);
    out.push({ href: href, text: text });
  });
  return out;
}"""


def _normalise(name: str) -> str:
    """Company names for comparison, with the legal-form noise removed.

    "flaconi GmbH" and "Flaconi" are the same employer, and a strict match
    would reject the very page being looked for.
    """
    cleaned = re.sub(r"[^a-z0-9 ]+", " ", (name or "").lower())
    words = [
        w for w in cleaned.split()
        if w not in {"gmbh", "ag", "se", "kg", "mbh", "co", "ltd", "limited",
                     "inc", "llc", "plc", "bv", "nv", "sa", "group", "holding",
                     "deutschland", "germany", "the"}
    ]
    return " ".join(words)


def resolve_company_url(
    company_name: str,
    *,
    profile_dir: str = ".pw-profile",
    timeout_ms: int = 30000,
) -> Optional[str]:
    """The company's own LinkedIn page, found by name. None when no result
    looks like the right company -- deliberately, because loading the People
    tab of the WRONG company and presenting strangers as colleagues is worse
    than saying nothing.
    """
    name = (company_name or "").strip()
    if not name:
        return None

    from urllib.parse import quote

    from playwright.sync_api import sync_playwright

    url = "https://www.linkedin.com/search/results/companies/?keywords=" + quote(name)
    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(profile_dir, headless=True)
            try:
                page = ctx.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                page.wait_for_timeout(4500)
                if "authwall" in page.url or "/login" in page.url:
                    raise RuntimeError(
                        "LinkedIn is not signed in. Sign in once with: "
                        "python -m job_scout.linkedin_login"
                    )
                results = page.evaluate(_COMPANY_SEARCH_JS)
            finally:
                ctx.close()
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Could not search for {name}: {exc}") from exc

    wanted = _normalise(name)
    if not wanted:
        return None

    # Prefer a result whose displayed name actually matches. Falling back to
    # "the first company link on the page" is how you end up showing someone
    # a competitor's staff and calling them colleagues.
    for item in results:
        got = _normalise(item.get("text", ""))
        if got and (got == wanted or wanted in got or got in wanted):
            return item.get("href")

    # Nothing matched by name; try the slug, which is often the company name
    # with the spaces removed.
    slug_wanted = wanted.replace(" ", "")
    for item in results:
        slug = (item.get("href", "").rsplit("/", 1)[-1] or "").replace("-", "")
        if slug and (slug == slug_wanted or slug_wanted in slug):
            return item.get("href")

    log.info("no LinkedIn company page matched %r", name)
    return None
