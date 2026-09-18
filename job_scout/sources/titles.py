"""Deciding whether a posting's title answers the title you searched for.

The bot's own rule is "every word of the query must appear in the title", and
it is too strict to use as-is. Real postings it rejected:

    query "Senior Data Scientist"  -> "Data Scientist (m/w/d)"          dropped
    query "Machine Learning Engineer" -> "ML Engineer"                  dropped
    query "Android Developer"      -> "Android Engineer"                dropped
    query "Frontend Developer"     -> "Front-End Developer"             dropped
    query "Software Developer"     -> "Software Development Engineer"   dropped

Each is the same job under a different house style. The check still has to
exist -- once a narrow search runs out of real matches, LinkedIn pads later
pages with unrelated "you might also like" postings that ignore the keyword
entirely -- so this loosens it deliberately rather than removing it:

  * seniority and contract noise is optional ("Senior", "m/w/d", "Werkstudent")
  * hyphens and slashes are separators, so "Front-End" == "front end"
  * known phrases collapse to one token, so "Machine Learning" == "ML"
  * developer / engineer / dev are the same role word; scientist / analyst /
    architect deliberately are NOT, because "Data Scientist" must keep
    rejecting "Data Engineer"
  * a word also matches a longer word starting with it, so a half-typed
    "develop" still finds "Developer"

What it does not do is match on *any* single word. "Data Engineer" shares
"data" with "Data Scientist" and is a different job; letting it through would
spend a rating call -- and a slice of the model's per-minute quota -- on a
posting the score would then bury.
"""
from __future__ import annotations

import re
from typing import Set

# Collapsed before splitting into words, so the spelled-out and abbreviated
# forms of the same thing become one token on both sides of the comparison.
_PHRASES = [
    ("machine learning", "ml"),
    ("artificial intelligence", "ai"),
    ("site reliability", "sre"),
    ("natural language processing", "nlp"),
    ("front end", "frontend"),
    ("back end", "backend"),
    ("full stack", "fullstack"),
]

# Words that mean the same role. Kept narrow on purpose: merging "scientist"
# with "engineer" would make "Data Scientist" match "Data Engineer", which is
# the one rejection this whole check has to keep getting right.
_SYNONYM_GROUPS = [
    {"developer", "developers", "dev", "devs", "engineer", "engineers", "engineering", "programmer"},
    {"scientist", "scientists", "science"},
    {"analyst", "analysts", "analytics", "analysis"},
    {"architect", "architects", "architecture"},
    {"administrator", "admin", "administration"},
    {"manager", "managers", "management"},
    {"consultant", "consultants", "consulting"},
    {"specialist", "specialists"},
]
_CANON = {word: min(group) for group in _SYNONYM_GROUPS for word in group}

# Seniority, contract type and gender markers. A posting is the same job
# whether or not it says "Senior" or "(m/w/d)", so these never have to be
# present -- the experience-level filter is what actually decides seniority.
_OPTIONAL = {
    "senior", "sr", "junior", "jr", "mid", "middle", "lead", "principal", "staff",
    "head", "chief", "intern", "internship", "trainee", "graduate", "entry", "level",
    "student", "students", "werkstudent", "praktikant", "praktikum", "working",
    "fulltime", "parttime", "freelance", "contract", "permanent", "temporary",
    "remote", "hybrid", "onsite", "onsite",
    "m", "w", "d", "f", "x", "all", "genders", "gender", "divers", "diverse",
    "the", "a", "an", "and", "or", "of", "for", "in", "at", "with", "to", "und",
}

_WORD_RE = re.compile(r"[a-z0-9+#]+")


def _edit_distance(a: str, b: str, limit: int) -> int:
    """Edit distance counting a swap of two neighbours as one mistake.

    Plain Levenshtein scores "andriod" against "android" as 2, because it can
    only see two substitutions -- yet transposing two letters is the single
    most common way of mistyping a word. Counting it as one edit (the
    optimal-string-alignment variant) is what lets a one-typo allowance
    actually cover one typo.

    Small and self-contained: this is not worth a dependency, and giving up
    once the limit is exceeded keeps it cheap enough to run per word per card.
    """
    if abs(len(a) - len(b)) > limit:
        return limit + 1

    before_previous: list[int] | None = None
    previous = list(range(len(b) + 1))

    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            best = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
            if (
                before_previous is not None
                and i > 1
                and j > 1
                and ca == b[j - 2]
                and a[i - 2] == cb
            ):
                best = min(best, before_previous[j - 2] + 1)  # the two letters were swapped
            current.append(best)
        if min(current) > limit:
            return limit + 1
        before_previous, previous = previous, current

    return previous[-1]


def close_enough(typed: str, actual: str) -> bool:
    """Is `typed` the same word as `actual`, allowing for a slip of the finger?

    A search for "marketting manager" returned nothing at all: LinkedIn coped
    with the typo and sent back ten Marketing Manager postings, and every one
    was then dropped here because "marketting" is not "marketing". Typing a
    job title from memory is exactly where a double letter creeps in, and
    getting silence back gives no clue what went wrong.

    Short words are left alone -- at four letters, one edit reaches too many
    unrelated words to be safe.
    """
    if typed == actual:
        return True
    shorter = min(len(typed), len(actual))
    if shorter < 5:
        return False
    allowed = 2 if shorter >= 9 else 1
    return _edit_distance(typed, actual, allowed) <= allowed


def _normalise(text: str) -> str:
    """Lowercase, and turn separators into spaces before phrases collapse.

    Hyphens and slashes are word separators in job titles, not characters:
    "Front-End", "AI/ML" and "(m/w/d)" all have to split the way a reader
    reads them.
    """
    text = text.lower().replace("-", " ").replace("/", " ").replace("_", " ")
    for phrase, token in _PHRASES:
        text = text.replace(phrase, token)
    return text


def _forms(word: str) -> Set[str]:
    """A word and its canonical form, both worth matching on."""
    canon = _CANON.get(word, word)
    return {word} if canon == word else {word, canon}


def title_tokens(title: str) -> Set[str]:
    """Every form a title's words can be matched against."""
    tokens: Set[str] = set()
    for word in _WORD_RE.findall(_normalise(title)):
        tokens |= _forms(word)
    return tokens


def _hits(word: str, tokens: Set[str]) -> bool:
    """Is this query word present, allowing a longer word that starts with it?

    The prefix rule is what makes a partly-typed or differently-suffixed word
    work -- "develop" finds "Developer", "analytic" finds "Analytics" -- and
    is length-guarded so short tokens cannot match half a longer word.
    """
    forms = _forms(word)
    if forms & tokens:
        return True
    for form in forms:
        if len(form) < 4:
            continue
        for token in tokens:
            if token.startswith(form) or (len(token) >= 3 and form.startswith(token)):
                return True
            if close_enough(form, token):
                return True
    return False


def title_matches(title: str, keywords: str) -> bool:
    """Does this posting title answer the searched-for title?

    One-and two-word queries must match in full -- at that length every word
    is carrying meaning, and dropping one turns "Data Scientist" into "Data".
    Longer queries may miss a single word, which is what lets a three-word
    house style ("Software Development Engineer") answer a two-word search
    without opening the door to unrelated postings.
    """
    if not keywords.strip():
        return True

    tokens = title_tokens(title)
    query_words = _WORD_RE.findall(_normalise(keywords))

    required = [word for word in query_words if word not in _OPTIONAL]
    if not required:
        # A query made entirely of noise ("senior", "m/w/d") has nothing to
        # check against, so nothing is rejected on its behalf.
        return True

    hits = sum(1 for word in required if _hits(word, tokens))
    allowed_misses = 0 if len(required) <= 2 else 1
    return hits >= len(required) - allowed_misses
