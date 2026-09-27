"""Runs the browser unit tests for js/lib/logic.js (tests/web/logic.test.js) in Edge/Chrome.

The page is served by tools/devserver.py and executed in several device timezones to prove
that date logic always uses Asia/Jerusalem. Every failing JS assertion is listed in the error.

Run:  .venv\\Scripts\\python.exe -m pytest tests/test_logic.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from devserver import start_server  # noqa: E402

MIN_EXPECTED_TESTS = 150


@pytest.fixture(scope="module")
def logic_server():
    srv, base = start_server(ROOT)
    try:
        yield base
    finally:
        srv.shutdown()
        srv.server_close()


@pytest.fixture(scope="module")
def logic_browser():
    with sync_playwright() as p:
        last_error: Exception | None = None
        for channel in ("msedge", "chrome"):
            try:
                b = p.chromium.launch(channel=channel)
                break
            except PlaywrightError as exc:  # channel not installed on this machine
                last_error = exc
        else:
            raise RuntimeError(f"Neither Edge nor Chrome could be launched: {last_error}")
        try:
            yield b
        finally:
            b.close()


def _run_page(browser, base_url: str, timezone: str) -> dict:
    context = browser.new_context(locale="he-IL", timezone_id=timezone)
    page = context.new_page()
    page_errors: list[str] = []
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.on("console", lambda msg: page_errors.append(msg.text) if msg.type == "error" else None)
    try:
        page.goto(base_url + "tests/web/logic.html")
        page.wait_for_function("window.__RESULTS__ !== undefined", timeout=30_000)
        results = page.evaluate("window.__RESULTS__")
    finally:
        context.close()
    results["page_errors"] = page_errors
    return results


@pytest.mark.parametrize("timezone", ["Asia/Jerusalem", "America/Los_Angeles", "Pacific/Kiritimati"])
def test_logic_js(logic_browser, logic_server, timezone):
    results = _run_page(logic_browser, logic_server, timezone)
    failures = results.get("failures", [])
    assert not results["page_errors"], "browser errors:\n" + "\n".join(results["page_errors"])
    assert results["failed"] == 0, f"{results['failed']} JS test(s) failed in {timezone}:\n\n" + "\n\n".join(failures)
    assert results["passed"] >= MIN_EXPECTED_TESTS, f"only {results['passed']} JS tests ran"
    print(f"[{timezone}] logic.js: {results['passed']} passed, {results['failed']} failed")
