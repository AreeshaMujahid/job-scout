"""Settings, and where the API key comes from.

The key is read from job_scout/.env first, then from the repo-root .env as a
fallback. The fallback exists so this project runs out of the box next to the
older job bot without a second copy of the same key -- but it only ever reads
that file. Nothing here writes to anything outside job_scout/.
"""
from __future__ import annotations

import os
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE_DIR.parent

# Claude Opus 5. Override with JOB_SCOUT_MODEL if you want a cheaper run;
# claude-sonnet-5 costs roughly a third as much and rates noticeably blunter.
MODEL = os.getenv("JOB_SCOUT_MODEL", "claude-opus-5")

# Jobs sent to the model per request. Larger batches are cheaper but blur the
# reasoning together: at 8+ the model starts reusing one job's phrasing for the
# next. Five keeps each verdict specific.
BATCH_SIZE = 5

# Rating requests in flight at once. Two, not four: the free Gemini tier
# allows roughly ten requests a minute, and four batches fired together hit
# 429 on every one of them, so a whole run came back unscored. Paired with the
# pacing in llm.py, this keeps a run inside the quota.
MAX_RATING_WORKERS = 2

# How much of a job description the rater sees. Descriptions run to 20k+ chars
# of boilerplate about company values; the requirements are almost always near
# the top.
DESCRIPTION_CHARS = 2500

HTTP_TIMEOUT = 25
USER_AGENT = "Mozilla/5.0 (compatible; job-scout/1.0)"


def _load_env_file(path: Path) -> None:
    """Minimal .env reader -- set only keys that are not already set."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def load_env() -> None:
    _load_env_file(PACKAGE_DIR / ".env")
    _load_env_file(REPO_ROOT / ".env")


def api_key() -> str | None:
    load_env()
    return os.getenv("ANTHROPIC_API_KEY") or None
