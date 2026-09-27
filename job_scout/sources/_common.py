"""Shared plumbing for the board adapters: HTTP, HTML, and relevance."""
from __future__ import annotations

import html
import re
import unicodedata
from typing import Dict, Iterable, List, Sequence, Tuple

import requests

from . import places

from .. import config

_session = requests.Session()
_session.headers.update({"User-Agent": config.USER_AGENT, "Accept": "application/json"})

# Words that carry no signal in a job title, so requiring them in a match
# would throw away good jobs ("engineer of data" vs "data engineer").
_STOP = {"a", "an", "and", "or", "the", "of", "for", "in", "at", "with", "to", "&"}

_REMOTE_WORDS = ("remote", "anywhere", "worldwide", "global", "distributed", "home office")

# Country -> places that satisfy it. Without this, searching "Germany" drops
# every job listed as "Berlin", which is most of them.
_LOCATION_ALIASES = {
    "germany": ("germany", "deutschland", "berlin", "munich", "münchen", "hamburg",
                "frankfurt", "cologne", "köln", "stuttgart", "düsseldorf", "leipzig",
                "dresden", "nuremberg", "nürnberg", "bremen", "hannover", "emea", "europe"),
    "uk": ("uk", "united kingdom", "london", "manchester", "birmingham", "edinburgh",
           "bristol", "leeds", "glasgow", "cambridge", "oxford", "europe"),
    "united kingdom": ("uk", "united kingdom", "london", "manchester", "edinburgh", "europe"),
    "usa": ("usa", "united states", "us", "new york", "san francisco", "seattle", "austin",
            "boston", "chicago", "los angeles", "denver", "atlanta", "remote us"),
    "united states": ("usa", "united states", "us", "new york", "san francisco", "remote us"),
    "netherlands": ("netherlands", "amsterdam", "rotterdam", "utrecht", "eindhoven", "europe"),
    "pakistan": ("pakistan", "karachi", "lahore", "islamabad", "rawalpindi"),
    "india": ("india", "bangalore", "bengaluru", "mumbai", "delhi", "hyderabad", "pune"),
    "canada": ("canada", "toronto", "vancouver", "montreal", "ottawa", "calgary"),
}


def get_json(url: str, params: dict | None = None):
    """GET and decode JSON, raising for anything that is not a 2xx."""
    response = _session.get(url, params=params or {}, timeout=config.HTTP_TIMEOUT)
    response.raise_for_status()
    return response.json()


def post_json(url: str, body: dict):
    """POST JSON and decode the reply. Jooble's API takes its query in a body
    rather than a query string, which is the only reason this exists."""
    response = _session.post(url, json=body, timeout=config.HTTP_TIMEOUT)
    response.raise_for_status()
    return response.json()


def get_html(url: str, params: dict | None = None) -> str:
    """GET a page and return its HTML.

    Sent with a real browser's Accept-Language and User-Agent, because a
    German board serving a default requests agent returns either a consent
    wall or English results, and neither is what the caller asked for.

    Returns "" rather than raising on a non-2xx: a board adapter reading
    pages should give back what it has and let fetch_all carry on, the same
    way a dead API board does.
    """
    response = _session.get(
        url,
        params=params or {},
        timeout=config.HTTP_TIMEOUT,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
            ),
            "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        },
    )
    if not response.ok:
        return ""
    return response.text


def clean_html(raw: str | None) -> str:
    """Job descriptions arrive as HTML on every board except one."""
    if not raw:
        return ""
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    text = re.sub(r"(?i)<br\s*/?>|</(p|li|div|h[1-6]|tr)>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\xa0]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return strip_chrome(text)


# Buttons and labels that belong to the board's page, not to the posting.
#
# LinkedIn renders its description behind a "Show more" toggle, and reading
# the container's text takes the button with it: measured, 188 of 232 stored
# descriptions ended in "Show more Show less". It is the employer's posting
# that matters here, and nobody should have to wonder whether the company
# wrote "Apply now" at the end of their own advert.
#
# Anchored to the end of the text or to a line of its own, so the ordinary
# English inside a posting survives -- "we show more of the roadmap than
# most" is a sentence, not a button.
_UI_CHROME = re.compile(
    r"(?:\n|\s)*\b("
    r"show\s+more|show\s+less|see\s+more|see\s+less|read\s+more|"
    r"mehr\s+anzeigen|weniger\s+anzeigen|"
    r"apply\s+now|save\s+job|report\s+this\s+job"
    r")\b(?:\s*\1)*\s*$",
    re.IGNORECASE,
)

_CHROME_PAIR = re.compile(
    r"\s*\b(show\s+more|see\s+more|read\s+more|mehr\s+anzeigen)\s+"
    r"(show\s+less|see\s+less|weniger\s+anzeigen)\b\s*",
    re.IGNORECASE,
)


def strip_chrome(text: str) -> str:
    """Remove the board's UI text, leaving the posting's own words alone."""
    cleaned = _CHROME_PAIR.sub(" ", text or "")
    # Then any single leftover sitting at the very end.
    for _ in range(3):
        trimmed = _UI_CHROME.sub("", cleaned)
        if trimmed == cleaned:
            break
        cleaned = trimmed
    return cleaned.strip()


def _words(phrase: str) -> List[str]:
    return [w for w in re.findall(r"[a-z0-9+#.]+", phrase.lower()) if w not in _STOP]


def _tokens(text: str) -> set:
    return set(re.findall(r"[a-z0-9+#.]+", text.lower()))


def _has(word: str, tokens: set) -> bool:
    """Is this word present, allowing a short suffix?

    Substring matching was tried first and was badly wrong: "ai" is inside
    "blockchain" and "Rails", so an AI search returned Solidity and Ruby jobs.
    Whole tokens only -- but "engineer" still has to match "engineering", so
    longer words may grow by up to three letters.
    """
    if word in tokens:
        return True
    if len(word) >= 5:
        return any(t.startswith(word) and len(t) - len(word) <= 3 for t in tokens)
    return False


# The same job title, written the way the local market writes it.
#
# A German board advertises "KI Engineer", never "AI Engineer": KI is
# Kuenstliche Intelligenz, and to a matcher that only knows English these
# postings are about nothing at all. Measured on a StepStone search for four
# AI titles in Germany, this table is the difference between seeing the
# German-language half of the board and never knowing it was there.
#
# Only exact, whole-token equivalences belong here. "ai" is two letters, so
# _has() will not grow it into a longer word -- that is what keeps "ki" from
# matching "kind" and is the same reason the substring matching described in
# _has() had to go.
_WORD_ALIASES: Dict[str, Tuple[str, ...]] = {
    "ai": ("ki",),
    "ki": ("ai",),
    # scientist/science share a stem but not a prefix short enough for the
    # three-letter growth rule: "Data Science & AI" would otherwise miss a
    # search for "data scientist".
    "scientist": ("science",),
    "science": ("scientist",),
    "scientists": ("science",),
    "developer": ("entwickler", "entwicklerin"),
    "engineer": ("ingenieur",),
}

# Phrases that a posting may contract to a single word, and the reverse.
# "Machine Learning Engineer" and "ML Engineer" are the same job, and a
# search for one that cannot see the other halves the board.
_PHRASE_ALIASES: Dict[Tuple[str, ...], Tuple[str, ...]] = {
    ("machine", "learning"): ("ml", "ki", "ai"),
    ("artificial", "intelligence"): ("ai", "ki"),
    ("deep", "learning"): ("dl", "ki", "ai"),
    ("natural", "language", "processing"): ("nlp",),
    ("large", "language", "model"): ("llm",),
}


def _satisfied(word: str, tokens: set) -> bool:
    """Is this query word present, under any name the market uses for it?"""
    if _has(word, tokens):
        return True
    return any(_has(alias, tokens) for alias in _WORD_ALIASES.get(word, ()))


def _matched(words: Sequence[str], tokens: set) -> bool:
    """Does this posting answer the whole query phrase?

    Every word must be present, except where a run of them has a recognised
    contraction: "machine learning" is satisfied outright by "ML", so the
    words it stands in for are struck off before the rest are checked.
    """
    remaining = list(words)
    for phrase, aliases in _PHRASE_ALIASES.items():
        if not any(_has(alias, tokens) for alias in aliases):
            continue
        # Strike the phrase's words off once; a posting saying "ML" has
        # answered for "machine" and "learning" but not for "engineer".
        for word in phrase:
            if word in remaining:
                remaining.remove(word)
    return all(_satisfied(w, tokens) for w in remaining)


def relevance(title: str, tags: Iterable[str], body: str, queries: Iterable[str]) -> int:
    """How well a posting answers any of the search phrases.

    3 = the title says it, 2 = the tags say it, 1 = the body mentions it,
    0 = unrelated. Ranking beats filtering here: boards that cannot search
    server-side return everything they have, and a title hit is worth far
    more than the same words buried in a benefits paragraph.

    Matching runs through _matched(), so a posting written in German or in
    abbreviations scores the same as one spelled out in English.
    """
    in_title = _tokens(title)
    in_tags = in_title | _tokens(" ".join(tags))
    in_body = in_tags | _tokens(body[:4000])
    best = 0

    for query in queries:
        words = _words(query)
        if not words:
            continue
        if _matched(words, in_title):
            return 3
        if _matched(words, in_tags):
            best = max(best, 2)
        elif _matched(words, in_body):
            best = max(best, 1)
    return best


def looks_remote(*fields: str) -> bool:
    blob = " ".join(f or "" for f in fields).lower()
    return any(word in blob for word in _REMOTE_WORDS)


# Cities whose English and local names share no letters worth matching on.
# Without this, someone who types "Munich" never sees a job posted as
# "Muenchen" -- which is most of them, on a German board.
_CITY_SYNONYMS = {
    "munich": ("munchen", "muenchen"),
    "munchen": ("munich",),
    "cologne": ("koln", "koeln"),
    "koln": ("cologne",),
    "vienna": ("wien",),
    "wien": ("vienna",),
    "nuremberg": ("nurnberg", "nuernberg"),
    "nurnberg": ("nuremberg",),
    "zurich": ("zuerich",),
    "geneva": ("genf", "geneve"),
    "prague": ("praha",),
    "warsaw": ("warszawa",),
    "lisbon": ("lisboa",),
    "milan": ("milano",),
    "rome": ("roma",),
    "brussels": ("bruxelles", "brussel"),
    "copenhagen": ("kobenhavn", "koebenhavn"),
    "gothenburg": ("goteborg", "goeteborg"),
    "the hague": ("den haag", "s-gravenhage"),
    "dusseldorf": ("duesseldorf",),
}


def _normalise(text: str) -> str:
    """Lowercase and strip accents, so Muenchen and Munchen are one word."""
    # NFKD does not decompose the sharp s, so it is spelled out first.
    folded = unicodedata.normalize("NFKD", text.lower().replace("ß", "ss"))
    return "".join(char for char in folded if not unicodedata.combining(char))


def _wanted_forms(place: str) -> set:
    place = _normalise(place)
    return {place, *_CITY_SYNONYMS.get(place, ())}


# "Remote - US", "Remote (UK)", "Remote | CA". A bare two-letter code is
# ignored by places.countries_in on purpose -- "us", "in" and "it" are
# ordinary English words and trusting them anywhere would be a disaster. But
# directly after a remote marker, separated by a dash or bracket, it is a
# country and nothing else, and it is how half the US-only listings on these
# boards write themselves.
_REMOTE_CODE = re.compile(
    r"\bremote\b\s*[-\u2013\u2014(\[,/|:]\s*([a-z]{2})\b", re.IGNORECASE
)


def _remote_country_code(job_location: str) -> set:
    """Countries named by a two-letter code attached to a remote marker."""
    found = set()
    for code in _REMOTE_CODE.findall(job_location or ""):
        resolved = places.resolve_code(code.lower())
        if resolved:
            found.add(resolved)
    return found


def location_ok(job_location: str, remote: bool, wanted: str, remote_only: bool) -> bool:
    """Would this posting be open to someone in `wanted`?

    `wanted` may name several places, comma separated ("Berlin, Munich,
    Germany") -- people are rarely willing to move to exactly one city, and
    any one of them matching is enough.

    A remote posting is NOT automatically open to everyone. It used to be
    treated that way, on the grounds that location is the thing remote jobs
    do not care about, and that is untrue of most of them: "Remote - US"
    means remote on US payroll, in US hours, with the right to work there.
    Those were arriving at the top of a search from Germany and were the
    commonest bad match this produced. A remote posting that names countries
    is remote WITHIN them; one that names none is open to anyone.

    The country work is in places.py, which knows local spellings
    ("Deutschland"), cities that stand in for a country ("Koln"), US state
    codes ("Cary, NC") and regions ("Europe"). `source_filtered=False`
    because these boards have no server-side location filter -- this function
    is the only thing standing between a Berlin search and a Texas job, so an
    ON-SITE posting whose country cannot be established is not kept.
    """
    is_remote = remote or looks_remote(job_location)

    # Asked for first: "remote only" is a statement about the job, not about
    # where it is, and it holds even when no location was given at all.
    if remote_only and not is_remote:
        return False

    if not wanted.strip():
        return True

    if is_remote:
        # Countries are read BEFORE asking "does this mean anywhere", because
        # the word "remote" is itself an anywhere-word -- ask that first and
        # "Remote - US" answers yes.
        stated = places.countries_in(job_location) | _remote_country_code(job_location)
        if stated:
            return bool(stated & places.wanted_countries(wanted))

        # "Remote", "Worldwide", or a place naming no country. Ambiguity is
        # kept, the same way an unmarked seniority is kept.
        return True

    return places.matches(wanted, job_location, source_filtered=False)
