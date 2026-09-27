"""Home + Trip screens E2E (SPEC §8.2, §8.3) — the real app in demo mode, driven through the UI.

Runs in Microsoft Edge (Playwright channel "msedge", falling back to "chrome") at a phone
viewport (390x844, touch). Every test uses a fresh browser context, so the demo backend
re-seeds "טיול לדוגמה בכנרת 🌊" for it. page.evaluate is only used for setup (actAs,
direct API calls that prepare a state) and to read expected values from js/lib/logic.js.
The Open-Meteo call is always intercepted with page routing (mocked, or aborted).

Screenshots land in tests/e2e/artifacts/home/.

    .venv\\Scripts\\python.exe -m pytest tests/e2e/test_home.py -q
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import pytest
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from devserver import start_server  # noqa: E402

ART = ROOT / "tests" / "e2e" / "artifacts" / "home"
PHONE = {"width": 390, "height": 844}
SMALL = {"width": 360, "height": 780}
IGNORED_ERROR_HOSTS = ("fonts.googleapis.com", "fonts.gstatic.com")
WEATHER_GLOB = "https://api.open-meteo.com/**"
TRIP_NAME = "טיול לדוגמה בכנרת 🌊"

STORE_JS = "new URL('js/store.js', location.href).href"
LOGIC_JS = "new URL('js/lib/logic.js', location.href).href"

# What the home screen should show, computed by logic.js from the live snapshot.
EXPECTED_JS = f"""async () => {{
  const S = await import({STORE_JS});
  const L = await import({LOGIC_JS});
  const snap = S.store.get().snap;
  const me = snap.me.member_id;
  const ready = L.tripReadiness(snap);
  const missing = L.missingItems(snap);
  const bal = L.balances(snap).find((b) => b.member_id === me);
  const agenda = L.myAgenda(snap, me);
  const mine = agenda.bring.length + agenda.buy.length + agenda.tasks.length + agenda.each.length;
  const news = L.visibleNotifications(snap).find((n) => n.kind === 'announcement') || null;
  return {{
    me,
    pct: ready.pct,
    total: ready.total,
    proposed: ready.proposed,
    missing: missing.length,
    missingTitles: missing.slice(0, 6).map((i) => i.title),
    balance: bal ? bal.balance : 0,
    balanceText: L.formatMoney(Math.abs(bal ? bal.balance : 0)),
    mine,
    countdown: L.countdown(snap.trip.starts_at, new Date(), snap.trip.ends_at).label,
    news: news ? news.title : null,
    summary: L.buildSummaryText(snap, 'status'),
    pending: snap.items.filter((i) => i.status === 'proposed').map((i) => i.title),
  }};
}}"""


def mock_weather(route):
    """Deterministic Open-Meteo forecast for exactly the dates the app asked for."""
    q = parse_qs(urlparse(route.request.url).query)
    start = dt.date.fromisoformat(q["start_date"][0])
    end = dt.date.fromisoformat(q["end_date"][0])
    days = [(start + dt.timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]
    body = {
        "daily": {
            "time": days,
            "temperature_2m_max": [33.4 - i for i in range(len(days))],
            "temperature_2m_min": [21.2 - i for i in range(len(days))],
            "precipitation_probability_max": [10 for _ in days],
            "weather_code": [0 if i % 2 == 0 else 2 for i in range(len(days))],
        }
    }
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body),
                  headers={"access-control-allow-origin": "*"})


# ---------------------------------------------------------------------------
# fixtures & helpers
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def home_server():
    # tools/devserver.py uses ThreadingHTTPServer's default listen backlog (5). With several
    # browsers running on this machine at once, the app's idle-time screen preloader can then get
    # ERR_CONNECTION_REFUSED. Give our server a deeper backlog without touching the shared tool.
    import devserver

    class _DeepBacklog(devserver.ThreadingHTTPServer):
        request_queue_size = 128

    original = devserver.ThreadingHTTPServer
    devserver.ThreadingHTTPServer = _DeepBacklog
    try:
        srv, base = start_server()
    finally:
        devserver.ThreadingHTTPServer = original
    yield base
    srv.shutdown()


@pytest.fixture(scope="module")
def home_edge():
    ART.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        try:
            b = p.chromium.launch(channel="msedge")
        except PlaywrightError:
            b = p.chromium.launch(channel="chrome")
        yield b
        b.close()


class Session:
    """A fresh context (own localStorage = own demo world) that records console/page errors."""

    def __init__(self, edge, base, scheme="light", viewport=None, weather="mock"):
        self.base = base
        self.ctx = edge.new_context(
            viewport=viewport or PHONE,
            device_scale_factor=2,
            is_mobile=True,
            has_touch=True,
            color_scheme=scheme,
            locale="he-IL",
            timezone_id="Asia/Jerusalem",
            service_workers="block",
        )
        self.weather_calls: list[str] = []
        self.ignored = list(IGNORED_ERROR_HOSTS)

        def on_weather(route):
            self.weather_calls.append(route.request.url)
            if weather == "abort":
                route.abort()
            else:
                mock_weather(route)

        self.ctx.route(WEATHER_GLOB, on_weather)
        if weather == "abort":
            # The browser itself logs the failed request; the app must stay silent.
            self.ignored.append("api.open-meteo.com")
        self.page = self.ctx.new_page()
        self.errors: list[str] = []
        self.page.on("console", self._on_console)
        self.page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))

    def _on_console(self, msg):
        if msg.type != "error":
            return
        where = (msg.location or {}).get("url", "") or ""
        if any(h in where or h in msg.text for h in self.ignored):
            return
        # Other screen agents rewrite their files while this suite runs; the dev server can then
        # serve a truncated file (their screen module / stylesheet). Not an app error; our own
        # files (home/trip .js/.css) are never excused.
        if "ERR_CONTENT_LENGTH_MISMATCH" in msg.text and not re.search(r"/(home|trip)\.(js|css)", where):
            return
        self.errors.append(f"console.error: {msg.text} @ {where}")

    def close(self):
        self.ctx.close()

    def assert_clean(self):
        assert self.errors == [], "console errors:\n" + "\n".join(self.errors)

    def boot(self, hash_=""):
        self.page.goto(f"{self.base}index.html?demo=1{hash_}")
        self.page.wait_for_selector(".bottom-nav", timeout=15000)
        expect(self.page.locator(".home-hero, .trip-hero").first).to_be_visible(timeout=15000)

    def eval_store(self, body):
        """Run `body` (JS statements) with m = store module, st = store.get(), api, snap."""
        return self.page.evaluate(
            f"async () => {{ const m = await import({STORE_JS}); const st = m.store.get();"
            f" const api = st.api; const snap = st.snap; {body} }}"
        )

    def act_as(self, display_name):
        """Demo only: re-link this browser's user to another member of the trip, then refresh."""
        self.eval_store(
            f"const t = snap.members.find((x) => x.display_name === {display_name!r});"
            " await api.demo.actAs(t.id); await m.actions.refresh();"
        )
        expect(self.page.locator(".home-hero, .trip-hero").first).to_be_visible()

    def expected(self):
        return self.page.evaluate(EXPECTED_JS)

    def go_trip(self):
        self.page.locator(".home-hero__chip").click()
        expect(self.page.locator(".trip-hero")).to_be_visible()

    def go_home(self):
        self.page.locator(".bottom-nav [data-tab=home]").click()
        expect(self.page.locator(".home-hero")).to_be_visible()

    def shot(self, name, full_page=True):
        self.page.evaluate("document.fonts.ready")
        self.page.wait_for_timeout(700)
        self.page.screenshot(path=str(ART / f"{name}.png"), full_page=full_page)

    def no_hscroll(self):
        width = self.page.evaluate("document.documentElement.clientWidth")
        scroll = self.page.evaluate("document.documentElement.scrollWidth")
        assert scroll <= width, f"horizontal overflow: scrollWidth {scroll} > {width}"

    def toast(self, text):
        t = self.page.locator(".toast", has_text=text)
        expect(t.first).to_be_visible(timeout=5000)
        return t

    def sheet(self, title):
        d = self.page.get_by_role("dialog", name=title)
        expect(d).to_be_visible()
        return d


@pytest.fixture
def session(home_edge, home_server):
    s = Session(home_edge, home_server)
    yield s
    s.close()


def card(page, title):
    return page.locator(".card").filter(has=page.get_by_role("heading", name=title, exact=True))


# ---------------------------------------------------------------------------
# Home
# ---------------------------------------------------------------------------


def test_home_owner_overview_matches_logic(session: Session):
    s, page = session, session.page
    s.boot()
    exp = s.expected()

    hero = page.locator(".home-hero")
    expect(hero.locator(".home-hero__name")).to_have_text(TRIP_NAME)
    expect(hero.locator(".home-cd__label")).to_have_text(exp["countdown"])
    expect(hero).to_contain_text("נועה ואיתי")  # greeting uses my names
    expect(hero.locator(".home-hero__chip")).to_contain_text("חוף צאלון, כנרת")

    # readiness ring
    expect(page.locator(".home-ready__pct")).to_have_text(f"{exp['pct']}%")
    sub = page.get_by_test_id("readiness-sub")
    expect(sub).to_contain_text(f"{exp['missing']} חסרים")
    expect(sub).to_contain_text(f"{exp['proposed']} ממתינים לאישור")

    # money chip (the seeded owner owes money)
    assert exp["balance"] <= -1
    expect(page.get_by_test_id("money-chip")).to_contain_text(f"עליך להעביר {exp['balanceText']}")

    # latest announcement
    expect(page.get_by_test_id("latest-news").locator(".home-news__title")).to_have_text(exp["news"])

    # quick actions: admin sees the announcement tile; WhatsApp summary is the status text
    qa = page.get_by_role("navigation", name="פעולות מהירות")
    expect(qa.get_by_role("button", name="הוסף פריט")).to_be_visible()
    expect(qa.get_by_role("button", name="הוצאה חדשה")).to_be_visible()
    expect(qa.get_by_role("button", name="הודעה לכולם")).to_be_visible()
    share = page.get_by_test_id("qa-share").locator("a")
    expect(share).to_have_text("סיכום לוואטסאפ")
    link = share.get_attribute("href")
    assert link.startswith("https://wa.me/?text=")
    assert unquote(link[len("https://wa.me/?text="):]) == exp["summary"]

    # still missing: top 6 in logic order, with the counter
    missing = card(page, "עדיין חסר")
    expect(missing.locator(".need-row__title")).to_have_text(exp["missingTitles"])
    expect(missing.locator(".card__action .pill")).to_have_text(str(exp["missing"]))

    # my tasks
    mine = card(page, "המשימות שלי")
    expect(mine.locator(".mine-row")).to_have_count(exp["mine"])

    # pending approvals (admin only)
    approvals = card(page, "ממתינים לאישור")
    expect(approvals).to_be_visible()
    expect(approvals.locator(".approve-row__title")).to_have_text(exp["pending"])

    s.no_hscroll()
    s.assert_clean()


def test_home_toggle_my_task_updates_progress(session: Session):
    s, page = session, session.page
    s.boot()
    mine = card(page, "המשימות שלי")
    rows = mine.locator(".mine-row")
    total = rows.count()
    assert total > 0
    done_before = mine.locator(".mine-row.is-done").count()
    expect(mine.locator(".mine-progress__text b")).to_have_text(f"{done_before}/{total}")

    row = mine.locator(".mine-row:not(.is-done)").first
    title = row.locator(".mine-row__title").inner_text()
    box = mine.get_by_role("checkbox", name=title, exact=True)
    box.click()
    expect(box).to_have_attribute("aria-checked", "true")
    expect(mine.locator(".mine-progress__text b")).to_have_text(f"{done_before + 1}/{total}")

    # persisted in the backend (read back through the snapshot once the call settled)
    expect(mine.locator(".check.is-busy")).to_have_count(0)
    done = s.eval_store(
        f"const it = snap.items.find((i) => i.title === {title!r});"
        " const p = snap.pledges.find((x) => x.item_id === it.id && x.member_id === snap.me.member_id);"
        " return (it.type === 'buy' || it.type === 'task') ? it.done : !!(p && p.done);"
    )
    assert done is True

    # and back
    box.click()
    expect(box).to_have_attribute("aria-checked", "false")
    expect(mine.locator(".mine-progress__text b")).to_have_text(f"{done_before}/{total}")
    s.assert_clean()


def test_home_take_missing_item_moves_to_my_list(session: Session):
    s, page = session, session.page
    s.boot()
    exp = s.expected()
    missing = card(page, "עדיין חסר")
    # pick a row whose button says "אני מביא/ה ✋" or "אני קונה ✋" (not the each/partial ones)
    row = missing.locator(".need-row").filter(has=page.locator("button", has_text=re.compile("^(אני מביא/ה|אני קונה|עליי) ✋$"))).first
    title = row.locator(".need-row__title").inner_text()
    mine = card(page, "המשימות שלי")
    expect(mine.get_by_role("checkbox", name=title, exact=True)).to_have_count(0)

    row.locator("button").click()
    s.toast("סגור!")
    expect(mine.get_by_role("checkbox", name=title, exact=True)).to_have_count(1)
    expect(mine.locator(".mine-row")).to_have_count(exp["mine"] + 1)

    after = s.expected()
    assert after["missing"] == exp["missing"] - 1
    expect(missing.locator(".card__action .pill")).to_have_text(str(after["missing"]))
    expect(page.locator(".home-ready__pct")).to_have_text(f"{after['pct']}%")
    s.assert_clean()


def test_home_admin_approves_and_rejects_inline(session: Session):
    s, page = session, session.page
    s.boot()
    exp = s.expected()
    assert len(exp["pending"]) >= 2
    first, second = exp["pending"][0], exp["pending"][1]
    approvals = card(page, "ממתינים לאישור")

    approvals.get_by_role("button", name=f"אישור: {first}").click()
    s.toast("אושר ✅")
    expect(approvals.locator(".approve-row__title")).to_have_text(exp["pending"][1:])
    status = s.eval_store(f"return snap.items.find((i) => i.title === {first!r}).status;")
    assert status == "active"

    approvals.get_by_role("button", name=f"דחייה: {second}").click()
    sheet = s.sheet("לדחות את ההצעה?")
    expect(sheet).to_contain_text(second)
    sheet.get_by_role("button", name="כבר יש לנו").click()
    sheet.get_by_role("button", name="לדחות").click()
    s.toast("ההצעה נדחתה")
    expect(sheet).to_be_hidden()
    row = s.eval_store(f"const i = snap.items.find((x) => x.title === {second!r}); return [i.status, i.reject_reason];")
    assert row == ["rejected", "כבר יש לנו"]
    if len(exp["pending"]) == 2:
        expect(approvals).to_have_count(0)
    s.assert_clean()


def test_home_admin_sends_announcement(session: Session):
    s, page = session, session.page
    s.boot()
    page.get_by_role("button", name="הודעה לכולם").click()
    sheet = s.sheet("הודעה לחבר'ה 📣")
    sheet.get_by_role("button", name="שליחה").click()  # empty title → inline error, nothing sent
    expect(sheet).to_contain_text("מה הכותרת?")
    sheet.get_by_placeholder("למשל: יוצאים ב-09:00 מהחניון 🚗").fill("נפגשים ב-08:45 בחניון 🚗")
    sheet.get_by_placeholder("כל מה שחשוב לדעת").fill("מי שמאחר — להודיע")
    sheet.get_by_role("button", name="שליחה").click()
    s.toast("ההודעה נשלחה 📣")
    news = page.get_by_test_id("latest-news")
    expect(news.locator(".home-news__title")).to_have_text("נפגשים ב-08:45 בחניון 🚗")
    expect(news).to_contain_text("מי שמאחר — להודיע")
    s.assert_clean()


def test_home_member_view_propose_and_expense(session: Session):
    s, page = session, session.page
    s.boot()
    s.act_as("יואב")
    exp = s.expected()
    expect(page.locator(".home-hero")).to_contain_text("יואב")

    # members: no admin-only controls
    expect(card(page, "ממתינים לאישור")).to_have_count(0)
    qa = page.get_by_role("navigation", name="פעולות מהירות")
    expect(qa.get_by_role("button", name="הודעה לכולם")).to_have_count(0)
    expect(qa.get_by_role("button", name="הצע פריט")).to_be_visible()

    # propose an item → goes to approval
    qa.get_by_role("button", name="הצע פריט").click()
    sheet = s.sheet("הצעת פריט ✨")
    expect(sheet).to_contain_text("ההצעה תישלח לאישור מנהל")
    sheet.get_by_role("button", name="שליחה לאישור").click()
    expect(sheet).to_contain_text("מה להוסיף?")
    sheet.get_by_placeholder("למשל: מחצלת גדולה").fill("רמקול בלוטות׳")
    sheet.get_by_role("tab", name="🎒 להביא מהבית").click()
    sheet.get_by_role("button", name="שליחה לאישור").click()
    s.toast("ההצעה נשלחה לאישור ⏳")
    expect(sheet).to_be_hidden()
    after = s.expected()
    assert after["proposed"] == exp["proposed"] + 1
    expect(page.get_by_test_id("readiness-sub")).to_contain_text(f"{after['proposed']} ממתינים לאישור")
    item = s.eval_store("const i = snap.items.find((x) => x.title === 'רמקול בלוטות׳'); return [i.status, i.type];")
    assert item == ["proposed", "bring"]

    # add an expense → my money chip changes
    chip_before = page.get_by_test_id("money-chip").inner_text()
    qa.get_by_role("button", name="הוצאה חדשה").click()
    sheet = s.sheet("הוצאה חדשה 🧾")
    sheet.get_by_placeholder("למשל: קניות בסופר").fill("קרח וקרטיבים")
    sheet.get_by_label("כמה שילמת?").fill("450")
    expect(sheet).to_contain_text("לאדם")
    sheet.get_by_role("button", name="הוספת הוצאה").click()
    s.toast("ההוצאה נוספה 🧾")
    after = s.expected()
    expect(page.get_by_test_id("money-chip")).not_to_have_text(chip_before)
    if after["balance"] >= 1:
        expect(page.get_by_test_id("money-chip")).to_contain_text(f"מגיע לך {after['balanceText']}")
    elif after["balance"] <= -1:
        expect(page.get_by_test_id("money-chip")).to_contain_text(f"עליך להעביר {after['balanceText']}")
    s.no_hscroll()
    s.assert_clean()


def test_home_member_sees_unread_announcement(session: Session):
    s, page = session, session.page
    s.boot()
    # setup: the owner posts a fresh announcement, then we look at it as a member
    s.eval_store("await api.sendAnnouncement(snap.trip.id, { title: 'מביאים כובעים 🧢', body: null,"
                 " audience: null, urgent: false });")
    s.act_as("יואב")
    news = page.get_by_test_id("latest-news")
    expect(news.locator(".home-news__title")).to_have_text("מביאים כובעים 🧢")
    expect(news).to_have_class(re.compile(r"\bis-unread\b"))
    expect(news.locator(".pill")).to_have_text("חדש")
    news.click()
    expect(page).to_have_url(re.compile(r"#/t/[^/]+/messages"))
    s.assert_clean()


def test_home_confetti_when_trip_reaches_100(session: Session):
    s, page = session, session.page
    s.boot()
    # Setup through the API: cover everything except one item the owner will take via the UI.
    last = s.eval_store(
        f"""const L = await import({LOGIC_JS});
        const owner = snap.me.member_id;
        const miss = L.missingItems(snap);
        const keep = miss.find((i) => i.type === 'buy' || (i.type === 'bring' && (i.needed || 1) === 1
          && !snap.pledges.some((p) => p.item_id === i.id)));
        for (const it of miss) {{
          if (it === keep) continue;
          if (it.type === 'each') {{
            for (const mem of snap.members) {{ await api.demo.actAs(mem.id); await api.setPledgeDone(it.id, true); }}
            await api.demo.actAs(owner);
          }} else {{
            const pledged = snap.pledges.filter((p) => p.item_id === it.id).reduce((a, p) => a + (p.qty || 0), 0);
            const mine = snap.pledges.find((p) => p.item_id === it.id && p.member_id === owner);
            const need = it.type === 'bring' ? Math.max(1, (it.needed || 1) - pledged + (mine ? mine.qty : 0)) : 1;
            await api.pledge(it.id, need);
          }}
        }}
        await api.demo.actAs(owner);
        await m.actions.refresh();
        return keep.title;"""
    )
    exp = s.expected()
    assert exp["missing"] == 1, exp
    missing = card(page, "עדיין חסר")
    expect(missing.locator(".need-row")).to_have_count(1)
    expect(missing.locator(".need-row__title")).to_have_text(last)
    page.evaluate("window.__confetti = 0; new MutationObserver((l) => l.forEach((r) => r.addedNodes.forEach((n) => {"
                  " if (n.classList && n.classList.contains('confetti-canvas')) window.__confetti++; })))"
                  ".observe(document.body, { childList: true });")
    missing.locator(".need-row button").click()
    s.toast("הכל מכוסה! המדורה מוכנה 🎉")
    expect(page.locator(".home-ready__pct")).to_have_text("100%")
    expect(missing).to_contain_text("הכל מכוסה!")
    assert page.evaluate("window.__confetti") >= 1
    s.assert_clean()


# ---------------------------------------------------------------------------
# Trip
# ---------------------------------------------------------------------------


def test_trip_member_view(session: Session):
    s, page = session, session.page
    s.boot()
    s.act_as("יואב")
    s.go_trip()
    trip = s.eval_store("return snap.trip;")

    expect(page.locator(".trip-hero__name")).to_have_text(TRIP_NAME)
    where = card(page, "מתי ואיפה")
    expect(where).to_contain_text("יוצאים")
    expect(where).to_contain_text("חוזרים")
    expect(where).to_contain_text("חוף צאלון, כנרת")
    waze = where.get_by_role("link", name="ניווט ב-Waze")
    assert waze.get_attribute("href").startswith("https://waze.com/ul")
    maps = where.get_by_role("link", name="גוגל מפות")
    assert "google.com/maps" in maps.get_attribute("href")
    assert "35.5647" in maps.get_attribute("href")

    # weather (mocked) — the trip is 4 days away and has coordinates
    wx = page.get_by_test_id("weather")
    expect(wx).to_be_visible()
    expect(wx).to_contain_text("33°")
    expect(wx).to_contain_text("חם! קרם הגנה")
    assert len(s.weather_calls) == 1
    q = parse_qs(urlparse(s.weather_calls[0]).query)
    assert q["latitude"] == ["32.8625"] and q["longitude"] == ["35.5647"]
    assert q["timezone"] == ["Asia/Jerusalem"]

    # schedule timeline, rules, notes
    sched = card(page, "לו״ז")
    expect(sched.locator(".tl-row")).to_have_count(len(trip["info"]["schedule"]))
    expect(sched.locator(".tl-label").first).to_have_text(trip["info"]["schedule"][0]["label"])
    expect(sched.locator(".tl-day")).to_have_count(2)  # 08:30 after 22:00 rolls over to the next day
    rules = card(page, "חשוב לדעת")
    expect(rules.locator(".trip-rules__text")).to_have_text([r["text"] for r in trip["info"]["rules"]])
    expect(card(page, "הערות")).to_contain_text("חניה בחוף")

    # invite link
    expect(page.get_by_test_id("invite-link")).to_contain_text(f"#/join/{trip['invite_code']}")
    invite = card(page, "מזמינים את החבר'ה")
    href = invite.get_by_role("link", name="שליחה בוואטסאפ").get_attribute("href")
    assert href.startswith("https://wa.me/?text=") and trip["invite_code"] in unquote(href)
    expect(page.get_by_test_id("approval-policy")).to_contain_text("מחכים לאישור")

    # members see no edit controls
    expect(page.get_by_role("button", name="עריכת פרטי הטיול")).to_have_count(0)
    page.goto(page.url + "?edit=1")
    expect(page.locator(".trip-hero")).to_be_visible()
    page.wait_for_timeout(400)
    expect(page.get_by_role("dialog")).to_have_count(0)
    s.no_hscroll()
    s.assert_clean()


def test_trip_weather_fails_silently(home_edge, home_server):
    s = Session(home_edge, home_server, weather="abort")
    try:
        s.boot()
        s.go_trip()
        expect(card(s.page, "לו״ז")).to_be_visible()
        s.page.wait_for_timeout(500)
        assert len(s.weather_calls) == 1
        expect(s.page.get_by_test_id("weather")).to_have_count(0)
        s.assert_clean()
    finally:
        s.close()


def test_trip_no_weather_when_far_or_no_coords(session: Session):
    s, page = session, session.page
    s.boot()
    # setup: move the trip 30 days out
    s.eval_store(
        "const far = new Date(Date.now() + 30 * 864e5).toISOString();"
        " const back = new Date(Date.now() + 31 * 864e5).toISOString();"
        " await api.updateTrip(snap.trip.id, { starts_at: far, ends_at: back }); await m.actions.refresh();"
    )
    s.go_trip()
    expect(card(page, "לו״ז")).to_be_visible()
    page.wait_for_timeout(500)
    assert s.weather_calls == []
    expect(page.get_by_test_id("weather")).to_have_count(0)
    s.assert_clean()


def test_trip_admin_edit_sheet_saves_everything(session: Session):
    s, page = session, session.page
    s.boot()
    s.go_trip()
    page.get_by_role("button", name="עריכת פרטי הטיול").first.click()
    sheet = s.sheet("עריכת פרטי הטיול ✏️")

    name = sheet.get_by_label("שם הטיול")
    name.fill("")
    sheet.get_by_role("button", name="שמירה").click()
    expect(sheet).to_contain_text("איך נקרא לטיול?")
    name.fill("טיול לפארק החבשושיות 🏕️")

    sheet.get_by_label("מקום", exact=True).fill("פארק החבשושיות")
    sheet.get_by_label("קואורדינטות (לניווט ולתחזית)").fill("https://www.google.com/maps/@32.0853,34.7818,15z")

    sheet.get_by_role("button", name="הוספת שורה ללו״ז").click()
    n = sheet.locator(".row-editor__row--sched").count()
    new_row = sheet.locator(".row-editor__row--sched").nth(n - 1)
    new_row.locator("input").nth(0).fill("23:30")
    new_row.locator("input").nth(1).fill("🎶")
    new_row.locator("input").nth(2).fill("ג׳אם ליד המדורה")
    # delete the first schedule row
    sheet.get_by_role("button", name="מחיקת שורה 1 בלו״ז").click()

    sheet.get_by_role("button", name="הוספת טיפ").click()
    rule = sheet.locator(".row-editor__row--rule").last
    rule.locator("input").nth(0).fill("🧢")
    rule.locator("input").nth(1).fill("כובע חובה בצהריים")
    sheet.get_by_label("הערות לכולם").fill("חניה חינם ליד השער 🙌")

    toggle = sheet.get_by_role("switch", name=re.compile("הצעות של חברים מחכות לאישור"))
    expect(toggle).to_be_checked()
    toggle.click()
    expect(toggle).not_to_be_checked()

    sheet.get_by_role("button", name="שמירה").click()
    s.toast("פרטי הטיול עודכנו ✅")
    expect(sheet).to_be_hidden()

    expect(page.locator(".trip-hero__name")).to_have_text("טיול לפארק החבשושיות 🏕️")
    sched = card(page, "לו״ז")
    expect(sched).to_contain_text("ג׳אם ליד המדורה")
    expect(sched).not_to_contain_text("יוצאים מהמרכז")
    expect(card(page, "חשוב לדעת")).to_contain_text("כובע חובה בצהריים")
    expect(card(page, "הערות")).to_contain_text("חניה חינם ליד השער 🙌")
    expect(page.get_by_test_id("approval-policy")).to_contain_text("נכנס לרשימה מיד")
    trip = s.eval_store("return snap.trip;")
    assert trip["lat"] == 32.0853 and trip["lon"] == 34.7818
    assert trip["location"] == "פארק החבשושיות"
    assert trip["settings"]["require_approval"] is False
    assert trip["info"]["schedule"][-1] == {"time": "23:30", "label": "ג׳אם ליד המדורה", "emoji": "🎶"}
    waze = card(page, "מתי ואיפה").get_by_role("link", name="ניווט ב-Waze").get_attribute("href")
    assert waze  # the seed's own Waze link is kept

    # with approval off, a member's item goes straight in
    s.act_as("יואב")
    s.go_home()
    qa = page.get_by_role("navigation", name="פעולות מהירות")
    expect(qa.get_by_role("button", name="הצע פריט")).to_have_count(0)
    qa.get_by_role("button", name="הוסף פריט").click()
    sheet = s.sheet("פריט חדש ✨")
    expect(sheet).not_to_contain_text("ההצעה תישלח לאישור מנהל")
    sheet.get_by_placeholder("למשל: מחצלת גדולה").fill("גפרורים")
    sheet.get_by_role("button", name="הוספה לרשימה").click()
    s.toast("נוסף לרשימה ✅")
    status = s.eval_store("return snap.items.find((x) => x.title === 'גפרורים').status;")
    assert status == "active"
    s.assert_clean()


def test_trip_edit_cancel_asks_before_discarding(session: Session):
    s, page = session, session.page
    s.boot()
    s.go_trip()
    page.get_by_role("button", name="עריכת פרטי הטיול").first.click()
    sheet = s.sheet("עריכת פרטי הטיול ✏️")
    sheet.get_by_label("מקום", exact=True).fill("מקום אחר")
    sheet.get_by_role("button", name="ביטול").click()
    dlg = page.get_by_role("alertdialog", name="לצאת בלי לשמור?")
    expect(dlg).to_be_visible()
    dlg.get_by_role("button", name="להמשיך לערוך").click()
    expect(sheet).to_be_visible()
    expect(sheet.get_by_label("מקום", exact=True)).to_have_value("מקום אחר")
    sheet.get_by_role("button", name="ביטול").click()
    page.get_by_role("button", name="לצאת").click()
    expect(page.get_by_role("dialog", name="עריכת פרטי הטיול ✏️")).to_have_count(0)
    expect(card(page, "מתי ואיפה")).to_contain_text("חוף צאלון, כנרת")
    s.assert_clean()


def test_trip_invite_copy(home_edge, home_server):
    s = Session(home_edge, home_server)
    try:
        s.ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=home_server.rstrip("/"))
        s.boot()
        s.go_trip()
        invite = card(s.page, "מזמינים את החבר'ה")
        invite.get_by_role("button", name="העתקה").click()
        expect(invite).to_contain_text("הועתק!")
        code = s.eval_store("return snap.trip.invite_code;")
        clip = s.page.evaluate("navigator.clipboard.readText()")
        assert clip.endswith(f"#/join/{code}")
        s.assert_clean()
    finally:
        s.close()


# ---------------------------------------------------------------------------
# Screenshots + layout at 360px, light and dark
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_screenshots_390(home_edge, home_server, scheme):
    s = Session(home_edge, home_server, scheme=scheme)
    try:
        s.boot()
        s.no_hscroll()
        s.shot(f"home-owner-{scheme}")
        s.go_trip()
        expect(s.page.get_by_test_id("weather")).to_be_visible()
        s.no_hscroll()
        s.shot(f"trip-owner-{scheme}")
        if scheme == "light":
            s.page.get_by_role("button", name="עריכת פרטי הטיול").first.click()
            s.sheet("עריכת פרטי הטיול ✏️")
            s.shot("trip-edit-sheet-light", full_page=False)
        s.assert_clean()
    finally:
        s.close()


def test_layout_360_member(home_edge, home_server):
    s = Session(home_edge, home_server, viewport=SMALL)
    try:
        s.boot()
        s.act_as("יואב")
        s.no_hscroll()
        s.shot("home-member-360")
        s.go_trip()
        s.no_hscroll()
        s.shot("trip-member-360")
        s.assert_clean()
    finally:
        s.close()


# ---------------------------------------------------------------------------
# Empty trip: empty states, then set a date from the hero link and add a first item
# ---------------------------------------------------------------------------


def test_empty_trip_states_and_first_steps(session: Session):
    s, page = session, session.page
    s.boot()
    trip_id = s.eval_store(
        "const r = await api.createTrip({ name: 'ערב פיצה', emoji: '🍕' },"
        " { display_name: 'דני', headcount: 1, people: ['דני'], emoji: '🦊', color: '#2F6B4F' });"
        " return r.trip_id;"
    )
    page.goto(f"{s.base}index.html?demo=1#/t/{trip_id}")
    hero = page.locator(".home-hero")
    expect(hero.locator(".home-hero__name")).to_have_text("ערב פיצה")
    expect(hero.locator(".home-cd")).to_have_count(0)
    expect(page.locator(".home-ready__headline")).to_have_text("הרשימות עוד ריקות 📝")
    expect(page.get_by_test_id("readiness-sub")).to_have_text("מוסיפים פריטים ומתחילים")
    expect(page.get_by_test_id("money-chip")).to_contain_text("עוד אין הוצאות משותפות")
    expect(page.get_by_test_id("latest-news")).to_have_count(0)
    expect(card(page, "ממתינים לאישור")).to_have_count(0)
    expect(card(page, "המשימות שלי")).to_contain_text("עוד לא לקחת כלום")
    missing = card(page, "עדיין חסר")
    expect(missing).to_contain_text("הרשימות עוד ריקות")
    expect(missing.get_by_role("link", name="ייבוא מוואטסאפ")).to_have_attribute("href", f"#/t/{trip_id}/import")
    s.no_hscroll()

    # first item straight from the empty state (admin → goes in directly)
    missing.get_by_role("button", name="הוספת פריט").click()
    sheet = s.sheet("פריט חדש ✨")
    sheet.get_by_placeholder("למשל: מחצלת גדולה").fill("בצק לפיצה")
    sheet.get_by_label("כמות").fill("300")
    sheet.get_by_role("button", name="גרם").click()
    sheet.get_by_role("switch", name=re.compile("הכמות היא לאדם")).click()
    sheet.get_by_role("button", name="הוספה לרשימה").click()
    s.toast("נוסף לרשימה ✅")
    expect(missing.locator(".need-row__title")).to_have_text(["בצק לפיצה"])
    expect(missing.locator(".need-row__sub")).to_contain_text("300 גרם")
    expect(page.locator(".home-ready__pct")).to_have_text("0%")
    item = s.eval_store("const i = snap.items[0]; return [i.qty, i.unit, i.per_person, i.status];")
    assert item == [300, "גרם", True, "active"]

    # no date yet → the hero link opens the trip edit sheet
    hero.get_by_role("link", name=re.compile("עוד לא נקבע תאריך")).click()
    sheet = s.sheet("עריכת פרטי הטיול ✏️")
    start = (dt.date.today() + dt.timedelta(days=3)).isoformat()
    sheet.get_by_label("תאריך יציאה").fill(start)
    sheet.get_by_label("שעת יציאה").fill("18:00")
    expect(sheet.get_by_label("תאריך חזרה")).to_have_value((dt.date.today() + dt.timedelta(days=4)).isoformat())
    sheet.get_by_role("button", name="שמירה").click()
    s.toast("פרטי הטיול עודכנו ✅")
    expect(card(page, "מתי ואיפה")).to_contain_text("18:00")
    label = s.eval_store(
        f"const L = await import({LOGIC_JS}); return L.countdown(snap.trip.starts_at, new Date(), snap.trip.ends_at).label;"
    )
    assert label.startswith("בעוד")
    expect(page.locator(".trip-hero__cd")).to_have_text(label)
    # no coordinates → no forecast request; admins get an empty schedule with a CTA
    expect(card(page, "לו״ז")).to_contain_text("עוד אין לו״ז")
    assert s.weather_calls == []
    expect(page.get_by_test_id("weather")).to_have_count(0)
    wall = s.eval_store(
        "return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', hourCycle: 'h23', year: 'numeric',"
        " month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(snap.trip.starts_at));"
    )
    assert wall == f"{start}, 18:00"  # stored as the right instant for 18:00 Israel time
    s.assert_clean()
