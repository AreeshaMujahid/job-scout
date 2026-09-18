"""Shared plumbing for the board adapters: HTTP, HTML, and relevance."""
from __future__ import annotations

import html
import re
import unicodedata
from typing import Iterable, List

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


def clean_html(raw: str | None) -> str:
    """Job descriptions arrive as HTML on every board except one."""
    if not raw:
        return ""
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    text = re.sub(r"(?i)<br\s*/?>|</(p|li|div|h[1-6]|tr)>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\xa0]+", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


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


def relevance(title: str, tags: Iterable[str], body: str, queries: Iterable[str]) -> int:
    """How well a posting answers any of the search phrases.

    3 = the title says it, 2 = the tags say it, 1 = the body mentions it,
    0 = unrelated. Ranking beats filtering here: boards that cannot search
    server-side return everything they have, and a title hit is worth far
    more than the same words buried in a benefits paragraph.
    """
    in_title = _tokens(title)
    in_tags = in_title | _tokens(" ".join(tags))
    in_body = in_tags | _tokens(body[:4000])
    best = 0

    for query in queries:
        words = _words(query)
        if not words:
            continue
        if all(_has(w, in_title) for w in words):
            return 3
        if all(_has(w, in_tags) for w in words):
            best = max(best, 2)
        elif all(_has(w, in_body) for w in words):
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


def location_ok(job_location: str, remote: bool, wanted: str, remote_only: bool) -> bool:
    """Would this posting be open to someone in `wanted`?

    `wanted` may name several places, comma separated ("Berlin, Munich,
    Germany") -- people are rarely willing to move to exactly one city, and
    any one of them matching is enough.

    Remote jobs always pass a location filter: location is the one thing they
    explicitly do not care about.

    The country work is in places.py, which knows local spellings
    ("Deutschland"), cities that stand in for a country ("Koln"), US state
    codes ("Cary, NC") and regions ("Europe"). `source_filtered=False`
    because these boards have no server-side location filter -- this function
    is the only thing standing between a Berlin search and a Texas job, so a
    posting whose country cannot be established is not kept.
    """
    if remote_only:
        return remote or looks_remote(job_location)
    if not wanted.strip():
        return True
    if remote or looks_remote(job_location):
        return True

    return places.matches(wanted, job_location, source_filtered=False)
