"""Command line front end.

    python -m job_scout.cli Areesha_Mujahid_AI.pdf --location Germany --max 15
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import llm, pipeline
from .cv_reader import UnreadableCV
from .sources import BOARDS

# Terminal colour, skipped when output is piped to a file.
_TTY = sys.stdout.isatty()


def _paint(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _TTY else text


def _score_colour(score: int) -> str:
    if score >= 80:
        return "32"  # green
    if score >= 65:
        return "36"  # cyan
    if score >= 50:
        return "33"  # yellow
    return "90"  # grey


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="job_scout",
        description="Search six job boards using your CV, and rate what comes back.",
    )
    parser.add_argument("cv", help="Path to your CV (.pdf, .docx, .txt, .md)")
    parser.add_argument("--location", default="", help="City or country, e.g. Germany")
    parser.add_argument("--remote", action="store_true", help="Remote roles only")
    parser.add_argument("--max", type=int, default=15, dest="max_jobs",
                        help="How many jobs to rate (default 15)")
    parser.add_argument("--min-score", type=int, default=0,
                        help="Hide anything scoring below this")
    parser.add_argument("--boards", nargs="*", choices=list(BOARDS), default=None,
                        help="Limit to these boards (default: all six)")
    parser.add_argument("--terms", default="", help="Extra search terms, comma separated")
    parser.add_argument("--strict", action="store_true",
                        help="Only accept jobs whose title matches a search term")
    parser.add_argument("--json", dest="json_out", metavar="FILE",
                        help="Also write the full results to this file")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    cv_path = Path(args.cv)
    if not cv_path.is_file():
        print(f"No such file: {cv_path}", file=sys.stderr)
        return 2

    try:
        result = pipeline.run(
            cv_path.read_bytes(),
            cv_path.name,
            location=args.location,
            remote_only=args.remote,
            boards=args.boards,
            extra_queries=[t.strip() for t in args.terms.split(",") if t.strip()],
            max_jobs=args.max_jobs,
            min_relevance=3 if args.strict else 2,
            on_status=lambda message: print(_paint(f"  {message}", "90"), flush=True),
        )
    except UnreadableCV as exc:
        print(f"Could not read the CV: {exc}", file=sys.stderr)
        return 1
    except llm.LLMError as exc:
        print(f"The model could not be reached: {exc}", file=sys.stderr)
        return 1

    profile = result.profile
    print()
    print(_paint(profile.headline, "1"))
    print(f"  {profile.seniority} · {profile.years_experience:g} years · "
          f"searched: {', '.join(result.queries)}")
    print(f"  {result.report.total_fetched} postings read, "
          f"{len(result.rated)} rated, {result.report.duplicates} duplicates dropped")
    for board, message in result.report.errors.items():
        print(_paint(f"  {board} did not respond: {message}", "33"))
    for message in result.errors:
        print(_paint(f"  {message}", "33"))

    shown = [r for r in result.rated if r.score >= args.min_score]
    if not shown:
        print("\nNothing matched. Try --strict off, a wider --location, or --terms.")
        return 0

    for item in shown:
        job, rating = item.job, item.rating
        print()
        print(_paint(f"{rating.score:3d}/100  {rating.verdict.upper():8}", _score_colour(rating.score))
              + f"  {job.title}")
        print(f"         {job.company} · {job.location or 'location not stated'} · {job.source}")
        print(f"         {job.url}")
        for reason in rating.why_pick:
            print(_paint(f"    + {reason}", "32"))
        for concern in rating.concerns:
            print(_paint(f"    - {concern}", "33"))
        if rating.missing_skills:
            print(f"    missing: {', '.join(rating.missing_skills)}")

    if args.json_out:
        payload = [
            {
                "score": r.score,
                "verdict": r.rating.verdict,
                "title": r.job.title,
                "company": r.job.company,
                "location": r.job.location,
                "source": r.job.source,
                "url": r.job.url,
                "why_pick": r.rating.why_pick,
                "concerns": r.rating.concerns,
                "matched_skills": r.rating.matched_skills,
                "missing_skills": r.rating.missing_skills,
                "pitch": r.rating.pitch,
            }
            for r in shown
        ]
        Path(args.json_out).write_text(
            json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(f"\nWrote {len(payload)} results to {args.json_out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
