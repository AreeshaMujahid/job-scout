"""One function -- ask a model a question, get back a validated object.

Two providers. Gemini is the default because its free key is the one that
works here and rating a full page of jobs is dozens of calls; Claude Opus 5 is
a one-line switch (LLM_PROVIDER=anthropic) when a run deserves the better
judgement.

Both paths are schema-constrained, so callers never see a model's prose and
never parse JSON out of a code fence.
"""
from __future__ import annotations

import os
import random
import re
import threading
import time
from typing import Type, TypeVar

from pydantic import BaseModel, ValidationError

from . import config

T = TypeVar("T", bound=BaseModel)

_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
_RETRYABLE = ("429", "500", "502", "503", "504", "overloaded", "timeout", "unavailable")

# Rate limits are not like other transient failures. A 503 clears in seconds;
# a 429 on Gemini's free tier is a *per-minute* quota, so retrying four
# seconds later lands inside the same closed window and burns an attempt for
# nothing. These are waited out on a different clock -- see _sleep_for.
_RATE_LIMITED = ("429", "too many requests", "rate limit", "quota", "resource_exhausted")

_RETRY_AFTER_RE = re.compile(r"retry[- ]after[\"':\s]+(\d+(?:\.\d+)?)", re.IGNORECASE)

# Minimum gap between calls, process-wide. The free Gemini tier allows about
# ten requests a minute; four rating batches fired at once blew straight
# through it and the whole run came back unscored. Pacing the requests is what
# stops that happening, rather than apologising for it afterwards.
_pace_lock = threading.Lock()
_last_call_at = 0.0


def _min_interval() -> float:
    default = "4.5" if provider() == "gemini" else "0"
    try:
        return max(0.0, float(os.getenv("LLM_MIN_INTERVAL", default)))
    except ValueError:
        return 0.0


def _pace() -> None:
    """Hold each caller back so the provider is never hit in a burst."""
    global _last_call_at
    interval = _min_interval()
    if interval <= 0:
        return
    with _pace_lock:
        wait = _last_call_at + interval - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_call_at = time.monotonic()


def _is_rate_limit(exc: Exception) -> bool:
    return any(token in str(exc).lower() for token in _RATE_LIMITED)


def _sleep_for(exc: Exception, attempt: int) -> float:
    """How long to wait before trying again.

    A rate limit is waited out in tens of seconds because the quota window is
    a minute long; anything else backs off in the usual couple of seconds.
    """
    if not _is_rate_limit(exc):
        return min(2**attempt + random.uniform(0, 0.5), 8)

    stated = _RETRY_AFTER_RE.search(str(exc))
    if stated:
        return min(float(stated.group(1)) + 1, 90)
    return min(20 * (attempt + 1) + random.uniform(0, 3), 90)

_client = None
_client_kind = None


class LLMError(RuntimeError):
    """Raised when a call could not be completed after retries."""


class RateLimited(LLMError):
    """The provider refused because of its own quota, not because of us.

    Worth its own type: it is the one failure a user can fix by waiting, and
    the message should say so rather than blaming the search.
    """


def provider() -> str:
    config.load_env()
    return os.getenv("LLM_PROVIDER", "gemini").strip().lower()


def model_name() -> str:
    if provider() == "anthropic":
        return config.MODEL
    return os.getenv("GEMINI_MODEL", "gemini-flash-latest")


def fallback_model() -> str | None:
    """A second model to try when the first is simply overloaded.

    Gemini's flash tier returns 503 "high demand" in bursts, and a burst
    outlasts any sensible backoff -- a whole batch of jobs was being dropped
    from the results for a condition that clears by switching model. The lite
    tier rates a little more bluntly, which beats not rating at all.
    """
    if provider() == "anthropic":
        return os.getenv("ANTHROPIC_FALLBACK_MODEL", "claude-sonnet-5")
    return os.getenv("GEMINI_FALLBACK_MODEL", "gemini-flash-lite-latest")


def key_present() -> bool:
    """Is the key this provider needs actually set?

    Separate from _get_client() because health has to answer the question
    without constructing a client or making a call: a service that reports
    itself up while it cannot reach a model is worse than one that is plainly
    down, because the thing watching it stops looking.
    """
    config.load_env()
    if provider() == "anthropic":
        return bool(os.getenv("ANTHROPIC_API_KEY"))
    return bool(os.getenv("GEMINI_API_KEY"))


def _get_client():
    global _client, _client_kind
    kind = provider()
    if _client is not None and _client_kind == kind:
        return _client

    config.load_env()
    if kind == "anthropic":
        import anthropic

        key = os.getenv("ANTHROPIC_API_KEY")
        if not key:
            raise LLMError("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.")
        _client = anthropic.Anthropic(api_key=key)
    elif kind == "gemini":
        from openai import OpenAI

        key = os.getenv("GEMINI_API_KEY")
        if not key:
            raise LLMError(
                "GEMINI_API_KEY is not set. Get a free key at "
                "https://aistudio.google.com/apikey and put it in job_scout/.env"
            )
        _client = OpenAI(api_key=key, base_url=_GEMINI_BASE_URL)
    else:
        raise LLMError(f"LLM_PROVIDER={kind!r} is not supported (use gemini or anthropic).")

    _client_kind = kind
    return _client


def structured(
    schema: Type[T],
    system: str,
    user: str,
    *,
    max_tokens: int = 8000,
    attempts: int = 3,
    deadline: float | None = None,
) -> T:
    """Ask for one object shaped like `schema`, and return it validated.

    A malformed reply is retried like a network failure: the models here
    occasionally truncate a long JSON array, and one more try is far cheaper
    than dropping a whole batch of jobs from the results.

    `deadline` is a wall-clock budget in seconds, for callers with a person
    waiting on the other end. Without one this will keep retrying through a
    rate limit for well over a minute -- measured: "say hello" took 77
    seconds and nine 429s on an exhausted free tier. That is the right
    behaviour for a background batch and the wrong one for a chat box, where
    a clear "the model is rate limited" at twenty seconds beats a spinner
    that might clear at ninety.
    """
    last: Exception | None = None
    primary = model_name()
    started = time.monotonic()

    def out_of_time() -> bool:
        return deadline is not None and (time.monotonic() - started) >= deadline

    for attempt in range(attempts):
        if out_of_time():
            break
        try:
            remaining = None if deadline is None else max(
                1.0, deadline - (time.monotonic() - started)
            )
            return _call_once(schema, system, user, max_tokens, primary, remaining)
        except (ValidationError, ValueError) as exc:
            last = exc
        except Exception as exc:  # provider SDK errors are not a shared base class
            if not any(token in str(exc).lower() for token in _RETRYABLE):
                raise LLMError(f"{type(exc).__name__}: {exc}") from exc
            last = exc

        if attempt < attempts - 1 and not out_of_time():
            pause = _sleep_for(last, attempt)
            if deadline is not None:
                # Never sleep past the budget. A rate-limit backoff doubles --
                # 20s, then 40s -- so without this a call given 25 seconds
                # spent 64 of them asleep, which is how the chat box came to
                # sit there for over a minute.
                pause = min(pause, max(0.0, deadline - (time.monotonic() - started)))
            if pause > 0:
                time.sleep(pause)

    spare = fallback_model()
    # The fallback is a second model and a second wait. Skipped once the
    # budget is spent -- it is the step that turns a slow answer into a
    # very slow one.
    if spare and spare != primary and not out_of_time():
        try:
            remaining = None if deadline is None else max(
                1.0, deadline - (time.monotonic() - started)
            )
            return _call_once(schema, system, user, max_tokens, spare, remaining)
        except Exception as exc:
            last = exc

    if last is not None and _is_rate_limit(last):
        raise RateLimited(
            f"{provider()} is rate limiting this key. On the free tier that is a "
            f"per-minute quota — wait a minute and run it again, or set "
            f"LLM_MIN_INTERVAL higher to space requests further apart."
        )
    raise LLMError(f"{primary} failed after {attempts} attempts: {last}")


def _call_once(
    schema: Type[T],
    system: str,
    user: str,
    max_tokens: int,
    model: str,
    budget: float | None = None,
) -> T:
    """One request. `budget` caps how long it may take, end to end.

    Without it the provider SDK applies its own retry schedule inside this
    call -- two more attempts with backoff -- so a caller's deadline never
    gets control and a rate-limited turn runs for over a minute whatever the
    caller asked for. With a budget the SDK is told to try once and to give
    up at a fixed time, and the decision comes back here where it belongs.
    """
    client = _get_client()
    if budget is not None:
        client = client.with_options(max_retries=0, timeout=max(5.0, budget))
    _pace()

    if provider() == "anthropic":
        response = client.messages.parse(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_format=schema,
        )
        return response.parsed_output

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {"name": schema.__name__, "schema": schema.model_json_schema()},
        },
        max_tokens=max_tokens,
    )
    content = response.choices[0].message.content
    if not content:
        raise ValueError("model returned an empty response")
    return schema.model_validate_json(content)
