"""Sign in to LinkedIn once, so referral lookups can read your connections.

    python -m job_scout.linkedin_login

Opens a real browser window at LinkedIn and waits while you sign in. Nothing
is typed for you and no credentials pass through this program: you sign in
the way you always do, including whatever two-factor step your account uses.
What is kept afterwards is the browser profile in `.pw-profile`, which is the
same thing a browser keeps when you tick "remember me".

Why this exists at all: the referral feature reads the "people you may know
here" module, which LinkedIn only renders for a signed-in session. Without
one it renders nothing, and the honest report is that there is nothing to
show rather than that you know nobody.

Until now the only way to create that profile lived in a separate program
that is not part of this repository, so a fresh clone was told to run a file
it did not have.
"""
from __future__ import annotations

import sys
from pathlib import Path

PROFILE_DIR = ".pw-profile"

# Where LinkedIn lands you once a session is real. Checked rather than
# assuming a fixed wait: signing in takes ten seconds or three minutes
# depending on whether a code has to arrive by SMS.
_SIGNED_IN = ("/feed", "/mynetwork", "/jobs", "/in/")


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            "Playwright is not installed. It is an optional extra for this "
            "feature:\n    pip install playwright\n    python -m playwright install chromium",
            file=sys.stderr,
        )
        return 1

    profile = Path(PROFILE_DIR).resolve()
    print(f"Opening a browser. Sign in to LinkedIn as you normally would.")
    print(f"The session is kept in {profile}\n")

    try:
        with sync_playwright() as p:
            # headless=False on purpose: the entire point is that a person
            # sees the page and signs in. A headless window would sit there
            # invisibly waiting for a login nobody can perform.
            context = p.chromium.launch_persistent_context(str(profile), headless=False)
            page = context.pages[0] if context.pages else context.new_page()
            page.goto("https://www.linkedin.com/login", wait_until="domcontentloaded")

            print("Waiting for you to finish signing in... (close the window to cancel)")
            try:
                # Ten minutes, because a code by SMS can take a while and the
                # cost of giving up early is doing the whole thing again.
                page.wait_for_url(
                    lambda url: any(mark in url for mark in _SIGNED_IN),
                    timeout=600_000,
                )
                print("\nSigned in. Referral lookups will work from now on.")
                result = 0
            except Exception:
                print(
                    "\nDid not reach a signed-in page. If you did sign in, it is "
                    "probably fine -- try the referral lookup and see.",
                    file=sys.stderr,
                )
                result = 1

            context.close()
            return result
    except Exception as exc:
        message = str(exc)
        if "Executable doesn't exist" in message or "playwright install" in message:
            print(
                "The browser is not installed yet:\n"
                "    python -m playwright install chromium",
                file=sys.stderr,
            )
        else:
            print(f"Could not open a browser: {message[:200]}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
