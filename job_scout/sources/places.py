"""Working out what country a posting is in, whatever the board calls it.

Every source writes locations differently, and none of them is wrong:

    LinkedIn    "Paris, Île-de-France, France"   "Greater Nantes Metropolitan Area"
    Arbeitnow   "Berlin"   "Köln"   "Kaarst, Nordrhein-Westfalen, Deutschland"
    The Muse    "Cary, NC"   "Blue Ash, OH"
    Jobicy      "Canada,  USA"   "Europe"   "Anywhere"
    Remotive    "Americas, Europe, Israel"   "Worldwide"

Matching those against a typed "Germany" or "France" needs four things, which
is what this module is: country names including the local spelling, the major
cities that stand in for a country when a board omits it, US and Canadian
state codes, and the regional shorthands the remote boards use.

Deliberately data, not cleverness. Guessing a country from an unknown city
name is how a Honolulu posting ends up in a Berlin search; anything not listed
here simply reports "no country found", and the caller decides what that means
-- which differs by source, and is the whole reason this returns a set rather
than a yes/no. See `countries_in`.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Dict, Iterable, Set

# Same one-typo allowance the title matcher uses, for the same reason.
from .titles import close_enough

# --------------------------------------------------------------------------
# Countries. Canonical name -> the other ways boards spell it. Local-language
# names are here because a German board writes "Deutschland" and a Spanish one
# "España"; adjectives ("German") because postings use them in prose.
# --------------------------------------------------------------------------
_COUNTRY_ALIASES: Dict[str, Set[str]] = {
    "united states": {"usa", "u.s.", "u.s.a", "us", "united states of america", "america", "stateside"},
    "united kingdom": {"uk", "u.k.", "great britain", "britain", "england", "scotland", "wales",
                       "northern ireland", "british"},
    "germany": {"deutschland", "german", "de"},
    "france": {"french", "fr"},
    "spain": {"espana", "españa", "spanish", "es"},
    "italy": {"italia", "italian", "it"},
    "netherlands": {"nederland", "holland", "the netherlands", "dutch", "nl"},
    "belgium": {"belgie", "belgië", "belgique", "belgian", "be"},
    "austria": {"osterreich", "österreich", "austrian", "at"},
    "switzerland": {"schweiz", "suisse", "svizzera", "swiss", "ch"},
    "poland": {"polska", "polish", "pl"},
    "portugal": {"portuguese", "pt"},
    "ireland": {"eire", "irish", "ie"},
    "sweden": {"sverige", "swedish", "se"},
    "norway": {"norge", "norwegian", "no"},
    "denmark": {"danmark", "danish", "dk"},
    "finland": {"suomi", "finnish", "fi"},
    "czechia": {"czech republic", "cesko", "česko", "czech", "cz"},
    "greece": {"hellas", "greek", "gr"},
    "hungary": {"magyarorszag", "magyarország", "hungarian", "hu"},
    "romania": {"romanian", "ro"},
    "bulgaria": {"bulgarian", "bg"},
    "croatia": {"hrvatska", "croatian", "hr"},
    "slovakia": {"slovak republic", "slovensko", "slovak", "sk"},
    "slovenia": {"slovenija", "slovenian", "si"},
    "serbia": {"srbija", "serbian", "rs"},
    "ukraine": {"ukrainian", "ua"},
    "estonia": {"eesti", "estonian", "ee"},
    "latvia": {"latvija", "latvian", "lv"},
    "lithuania": {"lietuva", "lithuanian", "lt"},
    "luxembourg": {"letzebuerg", "lëtzebuerg", "lu"},
    "iceland": {"island", "icelandic", "is"},
    "cyprus": {"cy"}, "malta": {"mt"},
    "canada": {"canadian", "ca"},
    "mexico": {"méxico", "mexican", "mx"},
    "brazil": {"brasil", "brazilian", "br"},
    "argentina": {"argentinian", "ar"},
    "chile": {"chilean", "cl"},
    "colombia": {"colombian", "co"},
    "peru": {"peruvian", "pe"}, "uruguay": {"uy"}, "ecuador": {"ec"},
    "costa rica": {"cr"}, "panama": {"pa"}, "guatemala": {"gt"},
    "india": {"indian", "bharat", "in"},
    "pakistan": {"pakistani", "pk"},
    "bangladesh": {"bd"}, "sri lanka": {"lk"}, "nepal": {"np"},
    "china": {"chinese", "prc", "cn"},
    "hong kong": {"hk"}, "taiwan": {"tw"}, "macau": {"mo"},
    "japan": {"nippon", "nihon", "japanese", "jp"},
    "south korea": {"korea", "republic of korea", "korean", "kr"},
    "singapore": {"sg"}, "malaysia": {"my"}, "indonesia": {"id"},
    "thailand": {"th"}, "vietnam": {"viet nam", "vn"}, "philippines": {"ph"},
    "australia": {"australian", "aus", "au"},
    "new zealand": {"aotearoa", "nz"},
    "israel": {"israeli", "il"},
    "turkey": {"turkiye", "türkiye", "turkish", "tr"},
    "united arab emirates": {"uae", "emirates", "ae"},
    "saudi arabia": {"ksa", "sa"}, "qatar": {"qa"}, "kuwait": {"kw"},
    "bahrain": {"bh"}, "oman": {"om"}, "jordan": {"jo"}, "lebanon": {"lb"},
    "egypt": {"egyptian", "eg"},
    "south africa": {"rsa", "za"}, "nigeria": {"ng"}, "kenya": {"ke"},
    "ghana": {"gh"}, "morocco": {"ma"}, "tunisia": {"tn"}, "ethiopia": {"et"},
    "russia": {"russian federation", "russian", "ru"},
    "belarus": {"by"}, "kazakhstan": {"kz"}, "georgia country": {"sakartvelo"},
    "armenia": {"am"}, "azerbaijan": {"az"}, "uzbekistan": {"uz"},
}

# Cities that have to stand in for their country, because several boards give
# a city and nothing else. Only cities big enough to be unambiguous: adding
# every small town is how a wrong guess gets made.
_CITY_COUNTRY: Dict[str, str] = {}


def _cities(country: str, names: Iterable[str]) -> None:
    for name in names:
        _CITY_COUNTRY[name] = country


_cities("germany", [
    "berlin", "munich", "muenchen", "munchen", "hamburg", "frankfurt", "cologne", "koln", "koeln",
    "stuttgart", "dusseldorf", "duesseldorf", "leipzig", "dresden", "hanover", "hannover",
    "nuremberg", "nurnberg", "nuernberg", "bremen", "essen", "dortmund", "bonn", "mannheim",
    "karlsruhe", "wiesbaden", "munster", "muenster", "augsburg", "aachen", "freiburg", "kiel",
    "heidelberg", "darmstadt", "regensburg", "ingolstadt", "wolfsburg", "walldorf", "erlangen",
    "kaarst", "neu-isenburg", "russelsheim", "ruesselsheim", "potsdam", "jena", "ulm", "mainz",
])
_cities("austria", ["vienna", "wien", "graz", "linz", "salzburg", "innsbruck", "klagenfurt"])
_cities("switzerland", ["zurich", "zuerich", "geneva", "genf", "basel", "bern", "lausanne", "lugano", "zug"])
_cities("united kingdom", [
    "london", "manchester", "birmingham", "edinburgh", "glasgow", "bristol", "leeds", "liverpool",
    "cambridge", "oxford", "sheffield", "newcastle", "nottingham", "cardiff", "belfast", "reading",
    "brighton", "leicester", "coventry", "southampton", "aberdeen", "york",
])
_cities("ireland", ["dublin", "cork", "galway", "limerick"])
_cities("netherlands", [
    "amsterdam", "rotterdam", "utrecht", "eindhoven", "the hague", "den haag", "groningen",
    "delft", "leiden", "haarlem", "tilburg", "nijmegen", "arnhem", "maastricht",
])
_cities("belgium", ["brussels", "bruxelles", "brussel", "antwerp", "antwerpen", "ghent", "gent", "leuven", "liege"])
_cities("france", [
    "paris", "lyon", "marseille", "toulouse", "nantes", "bordeaux", "lille", "nice", "strasbourg",
    "montpellier", "rennes", "grenoble", "sophia antipolis", "toulon", "reims",
])
_cities("spain", ["madrid", "barcelona", "valencia", "seville", "sevilla", "bilbao", "malaga", "zaragoza", "alicante", "murcia"])
_cities("portugal", ["lisbon", "lisboa", "porto", "braga", "coimbra"])
_cities("italy", ["milan", "milano", "rome", "roma", "turin", "torino", "naples", "napoli", "bologna", "florence", "firenze", "venice", "venezia", "genoa", "genova"])
_cities("poland", ["warsaw", "warszawa", "krakow", "cracow", "wroclaw", "gdansk", "gdynia", "poznan", "lodz", "katowice", "szczecin", "lublin", "krakowski"])
_cities("czechia", ["prague", "praha", "brno", "ostrava"])
_cities("sweden", ["stockholm", "gothenburg", "goteborg", "malmo", "malmoe", "uppsala", "lund"])
_cities("norway", ["oslo", "bergen", "trondheim", "stavanger"])
_cities("denmark", ["copenhagen", "kobenhavn", "koebenhavn", "aarhus", "odense", "aalborg"])
_cities("finland", ["helsinki", "espoo", "tampere", "oulu", "turku"])
_cities("hungary", ["budapest", "debrecen", "szeged"])
_cities("romania", ["bucharest", "bucuresti", "cluj", "cluj-napoca", "timisoara", "iasi", "brasov"])
_cities("bulgaria", ["sofia", "plovdiv", "varna"])
_cities("greece", ["athens", "thessaloniki"])
_cities("croatia", ["zagreb", "split", "rijeka"])
_cities("serbia", ["belgrade", "beograd", "novi sad"])
_cities("ukraine", ["kyiv", "kiev", "lviv", "kharkiv", "odesa", "odessa"])
_cities("estonia", ["tallinn", "tartu"])
_cities("latvia", ["riga"])
_cities("lithuania", ["vilnius", "kaunas"])
_cities("slovakia", ["bratislava", "kosice"])
_cities("slovenia", ["ljubljana", "maribor"])
_cities("united states", [
    "new york", "nyc", "brooklyn", "manhattan", "san francisco", "seattle", "austin", "boston",
    "chicago", "los angeles", "denver", "atlanta", "dallas", "houston", "san diego", "san jose",
    "portland", "philadelphia", "phoenix", "miami", "washington dc", "washington d.c.", "detroit",
    "minneapolis", "pittsburgh", "raleigh", "charlotte", "nashville", "salt lake city", "boulder",
    "palo alto", "mountain view", "sunnyvale", "santa clara", "cupertino", "redmond", "bellevue",
    "honolulu", "las vegas", "orlando", "tampa", "columbus", "cleveland", "kansas city", "st louis",
])
_cities("canada", ["toronto", "vancouver", "montreal", "ottawa", "calgary", "edmonton", "waterloo", "quebec", "winnipeg", "halifax", "mississauga"])
_cities("mexico", ["mexico city", "guadalajara", "monterrey", "queretaro"])
_cities("brazil", ["sao paulo", "rio de janeiro", "curitiba", "belo horizonte", "porto alegre", "brasilia", "campinas", "recife", "florianopolis"])
_cities("argentina", ["buenos aires", "cordoba", "rosario"])
_cities("chile", ["santiago", "valparaiso"])
_cities("colombia", ["bogota", "medellin", "cali", "barranquilla"])
_cities("india", [
    "bangalore", "bengaluru", "mumbai", "delhi", "new delhi", "gurgaon", "gurugram", "noida",
    "hyderabad", "pune", "chennai", "kolkata", "ahmedabad", "jaipur", "kochi", "coimbatore", "indore",
])
_cities("pakistan", ["karachi", "lahore", "islamabad", "rawalpindi", "faisalabad", "peshawar", "multan"])
_cities("bangladesh", ["dhaka", "chittagong"])
_cities("china", ["beijing", "shanghai", "shenzhen", "guangzhou", "hangzhou", "chengdu", "wuhan", "xian", "nanjing", "suzhou"])
_cities("japan", ["tokyo", "osaka", "yokohama", "nagoya", "kyoto", "fukuoka", "sapporo", "kobe"])
_cities("south korea", ["seoul", "busan", "incheon", "daejeon", "pangyo"])
_cities("taiwan", ["taipei", "hsinchu", "kaohsiung"])
_cities("singapore", ["singapore"])
_cities("malaysia", ["kuala lumpur", "penang", "johor bahru", "cyberjaya"])
_cities("indonesia", ["jakarta", "bandung", "surabaya", "bali", "denpasar", "yogyakarta"])
_cities("thailand", ["bangkok", "chiang mai", "phuket"])
_cities("vietnam", ["hanoi", "ho chi minh city", "saigon", "da nang"])
_cities("philippines", ["manila", "makati", "cebu", "taguig", "quezon city"])
_cities("australia", ["sydney", "melbourne", "brisbane", "perth", "adelaide", "canberra", "gold coast", "hobart"])
_cities("new zealand", ["auckland", "wellington", "christchurch"])
_cities("israel", ["tel aviv", "jerusalem", "haifa", "herzliya", "raanana", "beer sheva"])
_cities("turkey", ["istanbul", "ankara", "izmir"])
_cities("united arab emirates", ["dubai", "abu dhabi", "sharjah"])
_cities("saudi arabia", ["riyadh", "jeddah", "dammam", "khobar"])
_cities("qatar", ["doha"])
_cities("egypt", ["cairo", "alexandria", "giza"])
_cities("south africa", ["johannesburg", "cape town", "durban", "pretoria", "sandton"])
_cities("nigeria", ["lagos", "abuja"])
_cities("kenya", ["nairobi", "mombasa"])
_cities("morocco", ["casablanca", "rabat", "marrakech"])
_cities("russia", ["moscow", "saint petersburg", "st petersburg", "novosibirsk", "kazan"])

# The Muse writes US locations as "Cary, NC", so the state code is the only
# thing naming the country.
_US_STATES = {
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia",
    "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj",
    "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt",
    "va", "wa", "wv", "wi", "wy", "dc",
}
_CA_PROVINCES = {"on", "qc", "bc", "ab", "mb", "sk", "ns", "nb", "nl", "pe"}

# Regional shorthands the remote boards use instead of a country.
_REGIONS: Dict[str, Set[str]] = {
    "europe": {
        "germany", "france", "spain", "italy", "netherlands", "belgium", "austria", "switzerland",
        "poland", "portugal", "ireland", "sweden", "norway", "denmark", "finland", "czechia",
        "greece", "hungary", "romania", "bulgaria", "croatia", "slovakia", "slovenia", "serbia",
        "ukraine", "estonia", "latvia", "lithuania", "luxembourg", "iceland", "cyprus", "malta",
        "united kingdom",
    },
    "north america": {"united states", "canada", "mexico"},
    "latam": {"brazil", "argentina", "chile", "colombia", "peru", "uruguay", "ecuador", "mexico",
              "costa rica", "panama", "guatemala"},
    "apac": {"australia", "new zealand", "singapore", "japan", "south korea", "india", "china",
             "hong kong", "taiwan", "malaysia", "indonesia", "thailand", "vietnam", "philippines"},
    "middle east": {"israel", "united arab emirates", "saudi arabia", "qatar", "kuwait", "bahrain",
                    "oman", "jordan", "lebanon", "turkey", "egypt"},
    "africa": {"south africa", "nigeria", "kenya", "ghana", "morocco", "tunisia", "egypt", "ethiopia"},
}
_REGIONS["eu"] = _REGIONS["europe"] - {"united kingdom"}
_REGIONS["emea"] = _REGIONS["europe"] | _REGIONS["middle east"] | _REGIONS["africa"]
_REGIONS["americas"] = _REGIONS["north america"] | _REGIONS["latam"]
_REGIONS["asia"] = _REGIONS["apac"]

# "Anywhere" is not a place and must not resolve to one -- it is handled as a
# remote signal by the caller, not matched as a country.
_ANYWHERE = {"worldwide", "anywhere", "global", "remote", "distributed", "international",
             "homeoffice", "home office"}

_WORD_RE = re.compile(r"[a-z0-9.]+")


def normalise(text: str) -> str:
    """Lowercase and strip accents, so Köln and Koln are one word."""
    folded = unicodedata.normalize("NFKD", (text or "").lower().replace("ß", "ss"))
    return "".join(char for char in folded if not unicodedata.combining(char))


# Country names and their aliases only -- kept apart from the city map so a
# typed "Berlin" is known to be a city, not a way of saying "Germany". Without
# that distinction a Berlin search matches a Munich posting, because both
# resolve to the same country.
_COUNTRY_LOOKUP: Dict[str, str] = {}

# Every spelling -> canonical country, built once.
_LOOKUP: Dict[str, str] = {}
for _canon, _aliases in _COUNTRY_ALIASES.items():
    _LOOKUP[normalise(_canon)] = _canon
    _COUNTRY_LOOKUP[normalise(_canon)] = _canon
    for _alias in _aliases:
        _LOOKUP[normalise(_alias)] = _canon
        _COUNTRY_LOOKUP[normalise(_alias)] = _canon
for _city, _country in _CITY_COUNTRY.items():
    _LOOKUP.setdefault(normalise(_city), _country)

# Two-letter codes are only trusted as a whole field ("DE", "NC"), never
# inside prose -- "in" and "no" are ordinary words as well as country codes.
_SHORT_CODES = {code for code in _LOOKUP if len(code) == 2}


def resolve_code(code: str) -> str | None:
    """The country a two-letter code names, or None.

    Exposed for callers that have established from context that a short code
    really is a country -- see _common._remote_country_code. countries_in
    itself still refuses to trust one found loose in a sentence.
    """
    code = code.strip().lower()
    return _LOOKUP.get(code) if code in _SHORT_CODES else None


def countries_in(text: str) -> Set[str]:
    """Which countries this location string names. Empty when it names none.

    Empty is a real answer, not a failure: "Greater Nantes Metropolitan Area"
    and "Berlin Office" name no country, and what to do about that depends on
    whether the source already filtered by country server-side.
    """
    if not text:
        return set()

    flat = normalise(text)
    found: Set[str] = set()

    # Multi-word names first ("united states", "new zealand", "sao paulo"),
    # then single tokens, so "united kingdom" is not read as two misses.
    for name, country in _LOOKUP.items():
        if len(name) <= 2 or " " not in name:
            continue
        if re.search(r"(?<![a-z])" + re.escape(name) + r"(?![a-z])", flat):
            found.add(country)

    # NB: not hyphens. "Ile-de-France" is one place, and splitting it left a
    # field "de" that resolved to Germany -- a French posting in a German search.
    fields = [field.strip() for field in re.split(r"[,/|()]", flat) if field.strip()]
    for field in fields:
        if field in _LOOKUP:
            found.add(_LOOKUP[field])
        elif field in _US_STATES:
            found.add("united states")
        elif field in _CA_PROVINCES:
            found.add("canada")

    for word in _WORD_RE.findall(flat):
        if word in _SHORT_CODES:
            continue  # only trusted as a whole field, handled above
        if word in _LOOKUP:
            found.add(_LOOKUP[word])

    # A posting open to "Europe" is open to Germany. Regions are expanded so
    # the caller compares countries with countries throughout.
    for region, members in _REGIONS.items():
        if re.search(r"(?<![a-z])" + re.escape(region) + r"(?![a-z])", flat):
            found |= members

    return found


def wanted_countries(place: str) -> Set[str]:
    """Which countries a typed location is asking for.

    A region expands to its members, so "Europe" accepts a Berlin posting.
    """
    if not place:
        return set()

    flat = normalise(place)
    wanted: Set[str] = set()
    for field in [f.strip() for f in flat.split(",") if f.strip()]:
        if field in _REGIONS:
            wanted |= _REGIONS[field]
        elif field in _LOOKUP:
            wanted.add(_LOOKUP[field])
        else:
            corrected = _typed_country(field)
            if corrected:
                wanted.add(corrected)
    if not wanted and flat in _REGIONS:
        wanted |= _REGIONS[flat]
    return wanted


def is_anywhere(text: str) -> bool:
    """Does this location say "we do not care where you are"?"""
    flat = normalise(text)
    return any(word in flat for word in _ANYWHERE)


# The same city under its English and local names. Stripping accents makes
# "Koln" out of "Koln", but never "Cologne" out of it -- these are different
# words for one place and only a list can say so.
_CITY_VARIANTS = [
    ("munich", "muenchen", "munchen"), ("cologne", "koln", "koeln"),
    ("vienna", "wien"), ("nuremberg", "nurnberg", "nuernberg"),
    ("zurich", "zuerich"), ("geneva", "genf", "geneve"),
    ("prague", "praha"), ("warsaw", "warszawa"), ("krakow", "cracow"),
    ("lisbon", "lisboa"), ("milan", "milano"), ("rome", "roma"),
    ("turin", "torino"), ("naples", "napoli"), ("florence", "firenze"),
    ("venice", "venezia"), ("genoa", "genova"), ("seville", "sevilla"),
    ("brussels", "bruxelles", "brussel"), ("antwerp", "antwerpen"), ("ghent", "gent"),
    ("copenhagen", "kobenhavn", "koebenhavn"), ("gothenburg", "goteborg", "goeteborg"),
    ("malmo", "malmoe"), ("the hague", "den haag"), ("dusseldorf", "duesseldorf"),
    ("hanover", "hannover"), ("belgrade", "beograd"), ("bucharest", "bucuresti"),
    ("kyiv", "kiev"), ("odesa", "odessa"), ("mexico city", "ciudad de mexico", "cdmx"),
    ("bangalore", "bengaluru"), ("gurgaon", "gurugram"),
    ("ho chi minh city", "saigon"), ("saint petersburg", "st petersburg"),
    ("sao paulo", "san paulo"), ("frankfurt", "frankfurt am main"),
]

_CITY_FAMILY: Dict[str, Set[str]] = {}
for _group in _CITY_VARIANTS:
    _forms = {normalise(name) for name in _group}
    for _form in _forms:
        _CITY_FAMILY[_form] = _forms


def _same_city(place: str, location: str) -> bool:
    """Is this typed city named in the location under any of its spellings?"""
    flat_place = normalise(place)
    flat_location = normalise(location)
    for form in _CITY_FAMILY.get(flat_place, {flat_place}):
        if form in flat_location:
            return True
    return False


def _typed_country(place: str) -> str | None:
    """The country a typed name refers to, forgiving a typo.

    Only the country the user typed is corrected, never a posting's own text:
    a board's location is authoritative, and "correcting" it is how a posting
    ends up in the wrong country. A typed "Germny" getting silence back, on
    the other hand, tells the user nothing.
    """
    flat = normalise(place).strip()
    if flat in _COUNTRY_LOOKUP:
        return _COUNTRY_LOOKUP[flat]
    if len(flat) < 5:
        return None  # short codes like "de" must be exact
    for name, country in _COUNTRY_LOOKUP.items():
        if len(name) >= 5 and close_enough(flat, name):
            return country
    return None


def names_a_country(place: str) -> bool:
    """Is this typed text a country or a region, rather than a city?

    The two need different rules. "Germany" should accept a posting anywhere
    in Germany; "Berlin" should not accept one in Munich, even though both
    resolve to the same country.
    """
    flat = normalise(place).strip()
    return flat in _REGIONS or _typed_country(place) is not None


def matches(wanted: str, location: str, *, source_filtered: bool) -> bool:
    """Would a posting in `location` satisfy someone who asked for `wanted`?

    `source_filtered` says whether the board already applied the location
    server-side, and it decides the one genuinely ambiguous case: a location
    that names no country at all ("Greater Nantes Metropolitan Area", "Berlin
    Office"). When the board has already filtered, that string cannot be
    evidence of the wrong country and the posting is kept -- dropping it threw
    away real jobs in every country. When we are the only filter, the same
    string is unverifiable and is not kept.
    """
    if not wanted.strip():
        return True

    if is_anywhere(location):
        return True

    covered = countries_in(location)

    for place in [p.strip() for p in wanted.split(",") if p.strip()]:
        if names_a_country(place):
            asked = wanted_countries(place)
            if asked & covered:
                return True
        elif _same_city(place, location):
            # A city, or anything else typed: it has to actually appear -- under
            # its own name or another spelling of it ("Munich" / "Muenchen").
            return True

    return source_filtered and not covered
