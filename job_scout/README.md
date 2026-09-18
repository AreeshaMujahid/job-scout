# Job Scout

Upload a CV. Get jobs from six boards, each scored out of 100, each with the
reasons you would actually want before spending an evening on an application.

This is a separate project from the auto-apply bot in the repository root. It
shares nothing with it but the virtual environment and, if you like, the API
key. It does not read `jobs.db`, and it does not apply to anything.

```
   your CV  ──►  what you are  ──►  six job boards  ──►  scored, with reasons
                 (and what to
                  search for)
```

## What it actually does

1. **Reads the CV** — PDF, DOCX, TXT or Markdown.
2. **Works out what to search for.** The search terms come out of the CV, not
   a text box. A CV full of RAG pipelines and drift detection produces
   `data scientist`, `machine learning engineer`, `generative ai engineer` —
   which is the difference between this and typing "python" into a job board.
3. **Searches six boards at once** — Remotive, RemoteOK, Arbeitnow, Jobicy,
   The Muse and Himalayas. All public APIs: no accounts, no keys, no scraping.
   Roughly 700 postings get read on a typical run.
4. **Filters and de-duplicates.** Boards syndicate from each other, so the same
   job arrives three times under three ids.
5. **Rates what survives** against the CV, and explains itself:
   - a score out of 100, and a verdict: strong / good / stretch / weak
   - sub-scores for skills, experience and domain
   - **why you should apply** — each reason tying something in your CV to
     something in the posting
   - **what to watch out for** — the honest version
   - which required skills you have, and which you do not
   - one sentence to open the application with

## Run it

The repository's `.venv` already has everything installed.

```bash
.venv/Scripts/python.exe -m streamlit run job_scout/app.py
```

Or from the command line:

```bash
.venv/Scripts/python.exe -m job_scout.cli Areesha_Mujahid_AI.pdf --location Germany --max 15
```

Useful flags: `--remote`, `--min-score 70`, `--strict` (title must match),
`--terms "nlp engineer, data analyst"`, `--boards Remotive Arbeitnow`,
`--json results.json`.

## The API key

Rating is the only step that needs a model. By default it uses Gemini, whose
key is free:

```
LLM_PROVIDER=gemini
GEMINI_API_KEY=...        # https://aistudio.google.com/apikey
```

Put that in `job_scout/.env` (copy `.env.example`). If it is not there, the
repository-root `.env` is read as a fallback, so an existing key does not need
copying. Nothing here ever writes outside `job_scout/`.

For sharper ratings, switch to Claude Opus 5 — same schemas, better judgement,
and it costs real money:

```
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=...
```

If the chosen model is overloaded — Gemini's flash tier returns 503 in bursts —
one batch is retried on the lite model rather than dropped from your results.

**Rate limits are handled separately from other failures.** The free Gemini
tier allows roughly ten requests a minute, and firing four rating batches at
once hit `429` on every one of them, so a whole run came back unscored.
Requests are now paced (`LLM_MIN_INTERVAL`, default 4.5s on Gemini) and capped
at two in flight, and a `429` backs off in tens of seconds — the quota window
is a minute long, so retrying four seconds later lands inside the same closed
window. If it still cannot get through, it says the key is rate limited rather
than blaming the search.

**A `429` can still happen even with pacing** if something else is calling the
same API key at the same time -- pacing only slows requests made by this
process, and the free-tier quota is per key, not per process.

## As a service

The web app in `jobscout-web/` calls this pipeline over HTTP rather than
importing it:

```bash
.venv/Scripts/python.exe -m job_scout.service     # http://127.0.0.1:8000
```

`POST /profile` (a CV file) returns a profile, `POST /search` queries the six
JSON boards, `POST /scrape` runs the auto-apply bot's LinkedIn / Xing /
Arbeitnow scrapers (imported from `linkedin.py`, driven at `source.fetch()` so
its `jobs.db` is never touched), and `POST /rate` scores any of them.
Interactive docs at `/docs`. It holds no state —
users and saved jobs live in the web app's database. Set `SCOUT_TOKEN` to
require a bearer token anywhere it is reachable from outside the app.

## Tests

```bash
.venv/Scripts/python.exe -m job_scout.tests
```

Thirty tests, no pytest, no network. They cover the parts that quietly go
wrong: whole-word matching (`ai` is inside `blockchain`, and a Solidity job is
not an AI job), city-for-country location matching, de-duplication across
boards, DOCX extraction, and that one dead board does not end the search.

## Files

| File | What it is |
|---|---|
| `app.py` | the Streamlit UI |
| `cli.py` | the same pipeline, from a terminal |
| `pipeline.py` | CV in, ranked jobs out |
| `cv_reader.py` | PDF/DOCX/TXT to text |
| `profile.py` | CV to profile, and to search terms |
| `sources/` | one adapter per board, the parallel fetch, `scrapers.py` (the bot's LinkedIn/Xing/Arbeitnow), `titles.py` (matching a searched title) and `places.py` (matching a country) |
| `service.py` | the same pipeline over HTTP, for jobscout-web |
| `rating.py` | the scoring, and the reasoning |
| `cv_editor.py` | which of a CV's words should become a posting's words |
| `cv_inplace.py` | applies those swaps to the original PDF, in place |
| `llm.py` | Gemini or Claude, both schema-constrained |
| `models.py` | Job, CandidateProfile, JobRating |
| `tests.py` | runnable with `python -m job_scout.tests` |

## Titles and countries

Two matching problems sit between a search and its results, and both were too
strict to work outside a narrow case.

**Titles** (`sources/titles.py`) — a posting does not have to say your title
exactly. Seniority and `(m/w/d)` are ignored, hyphens and slashes are
separators, `Machine Learning` == `ML`, and developer/engineer/dev are one
word, so "Android Developer" finds "Senior Android Engineer". It stops short
of matching any shared word: "Data Scientist" still rejects "Data Engineer".

**One typo is forgiven**, in the title and in the typed country -- "marketting
manager" finds Marketing Manager, "andriod" finds Android, "Germny" finds
Germany. Two swapped letters count as one mistake, since that is the most
common way of mistyping a word. The allowance applies only to what *you* type:
a posting's own location is authoritative and is never second-guessed, because
"correcting" it is how a job ends up in the wrong country.

**Countries** (`sources/places.py`) — every board writes locations its own
way: `Paris, Ile-de-France, France`, `Koln`, `Cary, NC`, `Canada,  USA`,
`Europe`, `Greater Nantes Metropolitan Area`. That module holds country names
with their local spellings (`Deutschland`, `Espana`), the major cities that
stand in for a country, US and Canadian state codes, regional shorthands, and
city spelling variants (`Munich` == `Muenchen`).

The one genuinely ambiguous case is a location naming no country at all
(`Greater Nantes Metropolitan Area`). What that means depends on who filtered:
LinkedIn was already asked for the country server-side, so the posting is
kept; the JSON boards apply no location filter of their own, so it is not.
That is the `source_filtered` argument to `places.matches`.

## Tailoring a CV to one posting

A CV is a designed document -- a photo, a coloured header, a font, column
widths. The first attempt at tailoring rebuilt one from its extracted text,
and what came back was a plain Helvetica page that shared nothing with the
document the candidate had actually made. Reading the words out and laying
them back down cannot preserve a design.

So nothing is rebuilt. The model proposes a handful of **find-and-replace
pairs** (`cv_editor.py`), and those are applied to the original PDF in place
(`cv_inplace.py`). The photo, the header bar, the rules and the fonts are the
original objects, never redrawn. A replaced phrase is re-typeset using the
*same embedded font, size and colour* as the words it stands in for, pulled
out of the file itself.

The constraint this buys is real and worth stating: **the rest of the line
does not move.** A replacement has to fit the space its original occupied, so
it must be close to the same length. One that does not fit is refused and
reported rather than drawn over its neighbour. Much shorter ones are allowed
but leave a visible gap, which is why the prompt asks for near-equal length
rather than merely "not longer".

Two details that are invisible until they are not:

- **Redactions must be applied before any replacement is written.** MuPDF
  rewrites the whole content stream when redactions are applied, so a second
  edit's erase pass silently deleted text a first edit had already written.
  The failure produced a perfectly valid PDF with a blank gap in it.
- **Spaces are written per word.** The fonts in a Word-exported CV are
  subsets whose cmaps usually omit `U+0020`, so writing a phrase as one run
  makes PyMuPDF substitute a non-breaking space. Identical on the page;
  wrong in the extracted text, which is exactly what an ATS keyword screen
  reads. Each word is positioned separately so the gaps are real spaces.

Only PDFs can be tailored. There is no in-place edit to make to a `.docx`.

## Known limits

- **Boards, not employers.** These six APIs skew remote and tech. Arbeitnow is
  the only one with a real supply of on-site European roles, so an on-site
  search in a small city will be thin.
- **Descriptions are truncated** to 2,500 characters for rating. Requirements
  are near the top of a posting; company values are not.
- **The score is an opinion**, from a model reading two documents. It is a
  filter for your attention, not a decision.
- **`places.py` is a list, not a geocoder.** Countries and regions are
  comprehensive; cities are the major ones per market. An unlisted small town
  reports "no country", which is handled safely but is less precise than a
  real geocoding service would be.
- **Titles are matched in the language you type.** An English query will not
  match a German-only title ("Softwareentwickler"), though the board's own
  keyword search often surfaces those anyway.
