"""UI-foundation E2E: component gallery + app shell + onboarding flows.

Runs the real app (demo mode) in Microsoft Edge via Playwright at a phone viewport (390x844).
Screenshots land in tests/e2e/artifacts/ui/ (gitignored).

    .venv\\Scripts\\python.exe -m pytest tests/test_ui_foundation.py -q
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from devserver import start_server  # noqa: E402

ART = ROOT / "tests" / "e2e" / "artifacts" / "ui"
PHONE = {"width": 390, "height": 844}
# Web-font hiccups (offline CI, captive wifi) are not app errors.
IGNORED_ERROR_HOSTS = ("fonts.googleapis.com", "fonts.gstatic.com")
UUID_HASH = re.compile(r"#/t/[0-9a-f-]{36}$")
LIGHT_BG = "rgb(251, 246, 238)"
DARK_BG = "rgb(14, 21, 18)"

STORE_JS = "new URL('js/store.js', location.href).href"


# ---------------------------------------------------------------------------
# fixtures & helpers
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def app_url():
    srv, base = start_server()
    yield base
    srv.shutdown()


@pytest.fixture(scope="module")
def edge():
    ART.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        try:
            b = p.chromium.launch(channel="msedge")
        except PlaywrightError:
            b = p.chromium.launch(channel="chrome")
        yield b
        b.close()


class Session:
    """A fresh browser context (own localStorage = own demo world) + console error capture."""

    def __init__(self, edge, scheme="light", sw="block", viewport=None):
        self.ctx = edge.new_context(
            viewport=viewport or PHONE,
            device_scale_factor=2,
            is_mobile=True,
            has_touch=True,
            color_scheme=scheme,
            locale="he-IL",
            timezone_id="Asia/Jerusalem",
            service_workers=sw,
        )
        self.page = self.ctx.new_page()
        self.errors: list[str] = []
        self.page.on("console", self._on_console)
        self.page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))

    def _on_console(self, msg):
        if msg.type != "error":
            return
        where = (msg.location or {}).get("url", "") or ""
        if any(h in where or h in msg.text for h in IGNORED_ERROR_HOSTS):
            return
        self.errors.append(f"console.error: {msg.text} @ {where}")

    def close(self):
        self.ctx.close()

    def assert_clean(self):
        assert self.errors == [], "console errors:\n" + "\n".join(self.errors)

    # --- app helpers ---
    def boot(self, app_url, hash_=""):
        self.page.goto(f"{app_url}index.html?demo=1{hash_}")
        self.page.wait_for_selector(".bottom-nav, .onb, .gate", timeout=15000)
        if self.page.locator(".bottom-nav").count():
            self.wait_snap()
        self.page.evaluate("document.fonts.ready")

    def wait_snap(self):
        """The nav can render before the trip snapshot lands (slow machines) - wait for it (or the access gate)."""
        self.page.evaluate(f"import({STORE_JS}).then((m) => {{ window.__testStore = m.store; }})")
        self.page.wait_for_function(
            "!!window.__testStore.get().snap || !!document.querySelector('.gate')", timeout=15000
        )

    def store(self, expr="s"):
        """Evaluate `expr` with s = store.get() inside the page."""
        return self.page.evaluate(f"async () => {{ const m = await import({STORE_JS}); const s = m.store.get(); return {expr}; }}")

    def shot(self, name, full_page=False):
        self.page.evaluate("document.fonts.ready")
        self.page.wait_for_timeout(350)  # let entrance animations settle
        self.page.screenshot(path=str(ART / f"{name}.png"), full_page=full_page)

    def no_hscroll(self):
        width = self.page.evaluate("document.documentElement.clientWidth")
        scroll = self.page.evaluate("document.documentElement.scrollWidth")
        assert scroll <= width, f"horizontal overflow: scrollWidth {scroll} > {width}"

    def body_bg(self):
        return self.page.evaluate("getComputedStyle(document.body).backgroundColor")


@pytest.fixture
def session(edge):
    s = Session(edge)
    yield s
    s.close()


# ---------------------------------------------------------------------------
# gallery
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_gallery_renders_every_component(edge, app_url, scheme):
    s = Session(edge, scheme=scheme)
    try:
        page = s.page
        page.goto(f"{app_url}tests/web/gallery.html?theme={scheme}")
        page.wait_for_selector("[data-gallery-ready]")
        assert s.body_bg() == (LIGHT_BG if scheme == "light" else DARK_BG)

        counts = page.evaluate(
            """() => Object.fromEntries(Object.entries({
                btn: '.btn', iconBtn: '.icon-btn', card: '.card', avatar: '.avatar', stack: '.avatar-stack',
                chip: '.chip', seg: '.segmented__opt', ring: '.ring', bar: '.progress', pill: '.pill',
                stepper: '.stepper', field: '.field', input: '.input', money: '.money-input', toggle: '[role=switch]',
                empty: '.empty', section: '.section', skeleton: '.skeleton', emoji: '.emoji-opt', color: '.color-opt',
                member: '.member-opt', fab: '.fab', share: '.btn--share', icons: '.icon-cell svg',
            }).map(([k, sel]) => [k, document.querySelectorAll(sel).length]))"""
        )
        minimum = {
            "btn": 12, "iconBtn": 4, "card": 6, "avatar": 8, "stack": 2, "chip": 10, "seg": 7, "ring": 4, "bar": 4,
            "pill": 10, "stepper": 1, "field": 8, "input": 4, "money": 1, "toggle": 2, "empty": 1, "section": 9,
            "skeleton": 1, "emoji": 20, "color": 10, "member": 13, "fab": 1, "share": 1, "icons": 35,
        }
        for key, n in minimum.items():
            assert counts[key] >= n, f"{key}: expected ≥{n}, got {counts[key]}"
        empty_icons = page.evaluate("[...document.querySelectorAll('.icon-cell svg')].filter(s => !s.childElementCount).length")
        assert empty_icons == 0
        s.shot(f"gallery-{scheme}", full_page=True)

        if scheme == "light":
            # Stepper
            page.locator(".stepper").first.get_by_role("button", name="עוד", exact=True).click()
            expect(page.get_by_test_id("qty")).to_have_text("3")
            # Segmented (tabs)
            tab = page.get_by_role("tab", name=re.compile("לאישור"))
            tab.click()
            expect(tab).to_have_attribute("aria-selected", "true")
            # Sheet: opens as a dialog, locks page scroll, ESC closes it
            page.get_by_test_id("open-sheet").click()
            dialog = page.get_by_role("dialog", name="הוספת פריט ✨")
            expect(dialog).to_be_visible()
            assert page.evaluate("document.documentElement.classList.contains('is-scroll-locked')")
            page.wait_for_timeout(350)
            # Controlled inputs inside the (portalled) sheet keep focus and state across parent re-renders
            field = dialog.get_by_label("מה צריך?")
            field.click()
            page.keyboard.type("מחצלות גדולות")
            expect(field).to_have_value("מחצלות גדולות")
            assert page.evaluate("document.activeElement === document.querySelector('[role=dialog] input')")
            expect(page.get_by_label("שם הפריט")).to_have_value("מחצלות גדולות")  # parent state updated
            dialog.get_by_role("button", name="עוד", exact=True).click()
            expect(dialog.get_by_test_id("sheet-qty")).to_have_text("4")
            s.shot("gallery-sheet-light")
            page.keyboard.press("Escape")
            expect(dialog).to_have_count(0)
            assert not page.evaluate("document.documentElement.classList.contains('is-scroll-locked')")
            # Backdrop click closes too
            page.get_by_test_id("open-sheet").click()
            expect(dialog).to_be_visible()
            page.mouse.click(195, 40)
            expect(dialog).to_have_count(0)
            # confirmDialog resolves true on confirm, false on ESC
            page.get_by_test_id("open-confirm").click()
            alert = page.get_by_role("alertdialog")
            expect(alert).to_be_visible()
            s.shot("gallery-confirm-light")
            alert.get_by_role("button", name="כן, ארוז!").click()
            expect(page.get_by_test_id("answer")).to_have_text("אישור")
            expect(alert).to_have_count(0)
            page.get_by_test_id("open-confirm").click()
            expect(page.get_by_role("alertdialog")).to_be_visible()
            page.keyboard.press("Escape")
            expect(page.get_by_test_id("answer")).to_have_text("ביטול")
            # Confetti canvas appears and cleans itself up
            page.get_by_test_id("confetti").click()
            expect(page.locator(".confetti-canvas")).to_have_count(1)
            page.wait_for_timeout(250)
            s.shot("gallery-confetti-light")
            expect(page.locator(".confetti-canvas")).to_have_count(0, timeout=4000)
            # Toggle
            sw = page.get_by_role("switch", name="התראות על שיבוצים")
            expect(sw).to_have_attribute("aria-checked", "true")
            sw.click()
            expect(sw).to_have_attribute("aria-checked", "false")
            # Narrow phone: no horizontal scroll
            page.set_viewport_size({"width": 360, "height": 800})
            s.no_hscroll()
        s.assert_clean()
    finally:
        s.close()


# ---------------------------------------------------------------------------
# app shell
# ---------------------------------------------------------------------------


def test_app_boots_into_trip_home_shell(session, app_url):
    s = session
    s.boot(app_url)
    page = s.page
    # Exactly one trip (the demo sample) → auto-opened.
    expect(page).to_have_url(UUID_HASH)
    expect(page.locator(".topbar__name")).to_contain_text("טיול לדוגמה")
    expect(page.locator(".banner--demo")).to_contain_text("מצב הדגמה — הנתונים נשמרים רק בדפדפן הזה")
    expect(page.locator(".nav-tab")).to_have_count(5)
    expect(page.locator('.nav-tab[data-tab="home"]')).to_have_attribute("aria-current", "page")
    unread = s.store("s.snap.notifications.length")
    assert unread >= 1
    expect(page.locator(".topbar .badge")).to_be_visible()
    assert s.store("s.ready && s.mode") == "demo"
    s.no_hscroll()
    s.shot("app-home-light")
    s.assert_clean()


def test_bottom_nav_reaches_all_five_tabs(session, app_url):
    s = session
    s.boot(app_url)
    page = s.page
    trip_id = s.store("s.tripId")
    for key, suffix in [("lists", "/lists"), ("money", "/money"), ("messages", "/messages"), ("people", "/people"), ("home", "")]:
        page.locator(f'.nav-tab[data-tab="{key}"]').click()
        expect(page).to_have_url(re.compile(re.escape(f"#/t/{trip_id}{suffix}") + "$"))
        expect(page.locator(f'.nav-tab[data-tab="{key}"]')).to_have_attribute("aria-current", "page")
        expect(page.locator(".nav-tab[aria-current=page]")).to_have_count(1)
        expect(page.locator(".page .screen, .page > *").first).to_be_visible()
        expect(page.get_by_text("המסך לא נטען")).to_have_count(0)
        expect(page.get_by_text("אופס, משהו השתבש")).to_have_count(0)
        s.no_hscroll()
        s.shot(f"tab-{key}-light")
    # Top bar: avatar → me, trip name → trip info, bell → messages
    page.locator(".topbar__me").click()
    expect(page).to_have_url(re.compile(r"/me$"))
    page.locator(".topbar__trip").click()
    expect(page).to_have_url(re.compile(r"/trip$"))
    expect(page.locator('.nav-tab[data-tab="home"]')).to_have_attribute("aria-current", "page")
    page.locator(".topbar__bell").click()
    expect(page).to_have_url(re.compile(r"/messages$"))
    s.assert_clean()


def test_landing_lists_trips_and_accepts_links(session, app_url):
    s = session
    s.boot(app_url)
    page = s.page
    code = s.store("s.snap.trip.invite_code")
    trip_id = s.store("s.tripId")
    page.evaluate("location.hash = '#/'")
    expect(page.locator(".onb--landing")).to_be_visible()
    expect(page.locator(".trip-card")).to_have_count(1)
    expect(page.locator(".bottom-nav")).to_have_count(0)
    s.shot("landing-light", full_page=True)
    page.get_by_role("button", name="יש לי קישור / קוד").click()
    field = page.get_by_label("הדביקו כאן את הקישור או הקוד")
    field.fill("שלום!!")
    page.get_by_role("button", name="המשך").click()
    expect(page.get_by_text("זה לא נראה כמו קישור הזמנה")).to_be_visible()
    # A full invite link to a trip I'm already in → straight to that trip.
    field.fill(f"https://example.org/medura/#/join/{code}")
    page.get_by_role("button", name="המשך").click()
    expect(page).to_have_url(re.compile(re.escape(f"#/t/{trip_id}") + "$"))
    expect(page.locator(".bottom-nav")).to_be_visible()
    # Trip card opens the trip
    page.evaluate("location.hash = '#/'")
    page.locator(".trip-card").click()
    expect(page).to_have_url(re.compile(re.escape(f"#/t/{trip_id}") + "$"))
    s.assert_clean()


def test_access_gate_not_found_and_bad_invite(session, app_url):
    s = session
    s.boot(app_url, "#/t/00000000-0000-4000-8000-000000000000")
    page = s.page
    expect(page.get_by_text("הטיול הזה עוד לא אצלך")).to_be_visible()
    expect(page.locator(".bottom-nav")).to_have_count(0)  # no chrome for a trip I can't open
    expect(page.locator(".topbar")).to_have_count(0)
    s.shot("gate-light")
    page.get_by_role("link", name="יש לי קישור").click()
    expect(page.get_by_label("הדביקו כאן את הקישור או הקוד")).to_be_visible()
    page.evaluate("location.hash = '#/nowhere'")
    expect(page.get_by_text("הלכנו לאיבוד ביער")).to_be_visible()
    page.evaluate("location.hash = '#/join/zzzzzzzzzz'")
    expect(page.get_by_text("הקישור הזה לא עובד")).to_be_visible()
    s.shot("join-invalid-light")
    s.assert_clean()


def test_store_run_toasts_and_theme(session, app_url):
    s = session
    s.boot(app_url)
    page = s.page
    result = page.evaluate(
        f"""async () => {{
            const {{ actions }} = await import({STORE_JS});
            const ok = await actions.run(async () => 42, {{ success: 'נשמר ✅' }});
            const bad = await actions.run(async () => {{ throw new Error('forbidden'); }});
            return {{ ok, bad: bad === undefined }};
        }}"""
    )
    assert result == {"ok": 42, "bad": True}
    expect(page.locator(".toast--success")).to_contain_text("נשמר ✅")
    expect(page.locator(".toast--error")).to_contain_text("אין לך הרשאה")
    s.shot("toasts-light")
    # Concurrent refreshes share one request
    same = page.evaluate(
        f"""async () => {{
            const {{ actions }} = await import({STORE_JS});
            const a = actions.refresh(); const b = actions.refresh();
            const same = a === b; await a; return same;
        }}"""
    )
    assert same is True
    # Theme override wins over the OS preference and persists
    page.evaluate(f"async () => (await import({STORE_JS})).actions.setTheme('dark')")
    assert page.evaluate("document.documentElement.dataset.theme") == "dark"
    assert s.body_bg() == DARK_BG
    assert page.evaluate("localStorage.getItem('medura:theme')") == "dark"
    page.evaluate(f"async () => (await import({STORE_JS})).actions.setTheme('auto')")
    assert page.evaluate("document.documentElement.dataset.theme") is None
    assert s.body_bg() == LIGHT_BG
    s.assert_clean()


# ---------------------------------------------------------------------------
# onboarding flows
# ---------------------------------------------------------------------------


def test_create_trip_flow_end_to_end(session, app_url):
    s = session
    s.boot(app_url, "#/new")
    page = s.page
    sample_trip = s.store("s.trips[0].trip.id")
    expect(page.get_by_role("heading", name="טיול חדש ⛺")).to_be_visible()
    s.no_hscroll()

    # Validation
    page.get_by_role("button", name="המשך").click()
    expect(page.get_by_text("איך נקרא לטיול?")).to_be_visible()

    page.get_by_label("איך קוראים לטיול?").fill("קמפינג בדיקה")
    page.get_by_role("button", name="🏕️").click()
    page.get_by_label("לאן?").fill("פארק החבשושיות")
    page.get_by_label("יוצאים").fill("2026-10-01")
    expect(page.get_by_label("חוזרים")).to_have_value("2026-10-02")  # auto: +1 day
    page.get_by_label("בשעה").nth(1).fill("11:00")
    expect(page.locator(".ticket__name")).to_have_text("קמפינג בדיקה")
    s.shot("new-trip-step1-light", full_page=True)
    page.get_by_role("button", name="המשך").click()

    # Profile (couple)
    expect(page.get_by_role("heading", name=re.compile("ומי את"))).to_be_visible()
    page.get_by_role("radio", name="זוג").click()
    page.get_by_label("השם שלך").fill("הדס")
    page.get_by_label("ושל בן/בת הזוג").fill("עידו")
    expect(page.locator(".profile-preview__name")).to_have_text("הדס ועידו")
    page.get_by_label("טלפון (לא חובה)").fill("123")
    page.get_by_role("button", name="צור את הטיול 🔥").click()
    expect(page.get_by_text("המספר לא נראה תקין")).to_be_visible()
    page.get_by_label("טלפון (לא חובה)").fill("050-1234567")
    s.shot("new-trip-step2-light", full_page=True)
    page.get_by_role("button", name="צור את הטיול 🔥").click()

    # Invite step
    expect(page.get_by_role("heading", name="הטיול מוכן!")).to_be_visible()
    code = s.store("s.snap.trip.invite_code")
    expect(page.locator(".invite-card__link")).to_contain_text(f"#/join/{code}")
    share = page.get_by_role("link", name="שלחו הזמנה בוואטסאפ")
    assert share.get_attribute("href").startswith("https://wa.me/?text=")
    s.shot("new-trip-invite-light", full_page=True)
    page.get_by_role("button", name="יאללה, לטיול").click()

    expect(page).to_have_url(UUID_HASH)
    new_id = s.store("s.tripId")
    assert new_id != sample_trip
    expect(page.locator(".topbar__name")).to_have_text("קמפינג בדיקה")
    snap = s.store("({ trip: s.snap.trip, me: s.snap.me, members: s.snap.members, trips: s.trips.length })")
    assert snap["trips"] == 2
    assert snap["me"]["role"] == "owner"
    assert snap["trip"]["emoji"] == "🏕️"
    assert snap["trip"]["location"] == "פארק החבשושיות"
    assert snap["trip"]["starts_at"].startswith("2026-10-01T06:00")  # 09:00 Israel (UTC+3)
    assert snap["trip"]["ends_at"].startswith("2026-10-02T08:00")  # 11:00 Israel
    me = next(m for m in snap["members"] if m["id"] == snap["me"]["member_id"])
    assert me["display_name"] == "הדס ועידו"
    assert me["headcount"] == 2
    assert me["people"] == ["הדס", "עידו"]
    s.assert_clean()


def _become_new_user(s: Session, app_url: str) -> dict:
    """Boot the demo, remember the sample trip, then switch to a brand-new demo identity."""
    s.boot(app_url)
    info = s.store("({ code: s.snap.trip.invite_code, tripId: s.tripId, me: s.snap.me.member_id })")
    s.page.evaluate(f"async () => {{ const m = await import({STORE_JS}); await m.store.get().api.demo.switchUser(); }}")
    s.page.goto("about:blank")  # the new person opens the link fresh (full page load)
    return info


def test_join_flow_claims_placeholder(session, app_url):
    s = session
    info = _become_new_user(s, app_url)
    page = s.page
    page.goto(f"{app_url}index.html?demo=1#/join/{info['code']}")
    expect(page.get_by_role("heading", name=re.compile("מי אתם"))).to_be_visible()
    expect(page.locator(".join-ticket__name")).to_contain_text("טיול לדוגמה")
    s.no_hscroll()
    s.shot("join-claim-grid-light", full_page=True)

    tile = page.locator(".claim-tile", has_text="אורי")
    expect(tile).to_contain_text("זה אני!")
    tile.click()
    expect(page.get_by_role("heading", name=re.compile("רק מוודאים"))).to_be_visible()
    expect(page.get_by_label("איך קוראים לך?")).to_have_value("אורי")
    expect(page.get_by_role("radio", name="יחיד/ה")).to_have_attribute("aria-checked", "true")
    page.get_by_label("טלפון (לא חובה)").fill("0521234567")
    s.shot("join-claim-form-light", full_page=True)
    page.get_by_role("button", name="יאללה, נכנסים! 🔥").click()

    expect(page.locator(".confetti-canvas")).to_have_count(1)
    expect(page).to_have_url(re.compile(re.escape(f"#/t/{info['tripId']}") + "$"))
    expect(page.locator(".toast--success")).to_contain_text("ברוכים הבאים")
    expect(page.locator(".topbar__me .avatar")).to_have_attribute("aria-label", "אורי")
    s.wait_snap()
    me = s.store("s.snap.members.find(m => m.id === s.snap.me.member_id)")
    assert me["display_name"] == "אורי"
    assert me["claimed"] is True
    assert me["phone"] == "0521234567"
    assert s.store("s.userId")
    s.assert_clean()


def test_join_flow_new_couple_profile(session, app_url):
    s = session
    info = _become_new_user(s, app_url)
    page = s.page
    page.goto(f"{app_url}index.html?demo=1#/join/{info['code']}")
    page.get_by_role("button", name=re.compile("אנחנו חדשים")).click()
    page.get_by_role("radio", name="זוג").click()
    page.get_by_label("השם שלך").fill("רון")
    page.get_by_label("ושל בן/בת הזוג").fill("מאיה")
    page.get_by_role("button", name="✏️ רוצים שם תצוגה אחר?").click()
    page.get_by_label("שם תצוגה").fill("המאיה-רונים")
    page.get_by_role("button", name="🐬").click()
    page.get_by_role("button", name="ורוד").click()
    page.get_by_role("button", name="יאללה, נכנסים! 🔥").click()
    expect(page).to_have_url(re.compile(re.escape(f"#/t/{info['tripId']}") + "$"))
    expect(page.locator(".topbar__me .avatar")).to_have_attribute("aria-label", "המאיה-רונים")
    s.wait_snap()
    me = s.store("s.snap.members.find(m => m.id === s.snap.me.member_id)")
    assert me["display_name"] == "המאיה-רונים"
    assert me["headcount"] == 2
    assert me["people"] == ["רון", "מאיה"]
    assert me["emoji"] == "🐬"
    assert me["color"].upper() == "#FF6B9A"
    assert me["role"] == "member"
    s.assert_clean()


def test_link_device_flow(session, app_url):
    s = session
    s.boot(app_url)
    page = s.page
    device_code = page.evaluate(
        f"""async () => {{
            const m = await import({STORE_JS}); const st = m.store.get();
            return st.api.getDeviceCode(st.snap.me.member_id);
        }}"""
    )
    trip_id = s.store("s.tripId")
    page.evaluate(f"async () => {{ const m = await import({STORE_JS}); await m.store.get().api.demo.switchUser(); }}")
    page.goto(f"{app_url}index.html?demo=1#/link/{device_code}")
    expect(page.get_by_role("heading", name="מחברים מכשיר נוסף")).to_be_visible()
    s.shot("link-device-light")
    page.get_by_role("button", name="חברו את המכשיר").click()
    expect(page.get_by_role("heading", name="מחוברים! 🎉")).to_be_visible()
    expect(page.locator(".link-card")).to_contain_text("נועה ואיתי")
    page.get_by_role("button", name="לטיול").click()
    expect(page).to_have_url(re.compile(re.escape(f"#/t/{trip_id}") + "$"))
    expect(page.locator(".topbar__me .avatar")).to_have_attribute("aria-label", "נועה ואיתי")
    s.assert_clean()


# ---------------------------------------------------------------------------
# dark mode, narrow phones, service worker
# ---------------------------------------------------------------------------


def test_dark_mode_renders(edge, app_url):
    s = Session(edge, scheme="dark")
    try:
        s.boot(app_url)
        page = s.page
        assert s.body_bg() == DARK_BG
        s.shot("app-home-dark")
        page.evaluate("location.hash = '#/'")
        expect(page.locator(".onb--landing")).to_be_visible()
        assert page.evaluate("getComputedStyle(document.querySelector('.sc-moon')).display") != "none"
        s.shot("landing-dark", full_page=True)
        page.evaluate("location.hash = '#/new'")
        expect(page.get_by_role("heading", name="טיול חדש ⛺")).to_be_visible()
        s.shot("new-trip-dark", full_page=True)
        code = s.store("s.trips[0] && s.snap ? s.snap.trip.invite_code : null")
        page.evaluate(f"async () => {{ const m = await import({STORE_JS}); await m.store.get().api.demo.switchUser(); }}")
        page.goto(f"{app_url}index.html?demo=1#/join/{code}")
        expect(page.get_by_role("heading", name=re.compile("מי אתם"))).to_be_visible()
        s.shot("join-dark", full_page=True)
        # data-theme="light" beats the OS dark preference
        page.evaluate("document.documentElement.dataset.theme = 'light'")
        assert s.body_bg() == LIGHT_BG
        s.assert_clean()
    finally:
        s.close()


def test_no_horizontal_scroll_at_360(edge, app_url):
    s = Session(edge, viewport={"width": 360, "height": 740})
    try:
        s.boot(app_url)
        page = s.page
        for hash_ in ["", "#/", "#/new"]:
            if hash_:
                page.evaluate(f"location.hash = '{hash_}'")
                page.wait_for_timeout(300)
            s.no_hscroll()
        page.evaluate("location.hash = '#/new'")
        page.get_by_label("איך קוראים לטיול?").fill("טיול עם שם ארוך במיוחד כדי לבדוק שבירת שורות")
        page.get_by_role("button", name="המשך").click()
        page.get_by_role("radio", name="זוג").click()
        s.no_hscroll()
        s.shot("new-trip-profile-360", full_page=True)
        s.assert_clean()
    finally:
        s.close()


def test_service_worker_installs_and_caches_shell(edge, app_url):
    s = Session(edge, sw="allow")
    try:
        s.boot(app_url)
        page = s.page
        state = page.evaluate(
            """async () => {
                const reg = await Promise.race([
                    navigator.serviceWorker.ready,
                    new Promise((_, rej) => setTimeout(() => rej(new Error('sw timeout')), 15000)),
                ]);
                const worker = reg.active;
                if (worker && worker.state !== 'activated') {
                    await new Promise((res) => worker.addEventListener('statechange', () => worker.state === 'activated' && res()));
                }
                const keys = await caches.keys();
                const cache = await caches.open('medura-v1');
                const shell = await cache.match('index.html');
                const css = await cache.match('css/styles.css');
                return { keys, hasShell: !!shell, hasCss: !!css, scope: reg.scope };
            }"""
        )
        assert "medura-v1" in state["keys"]
        assert state["hasShell"] and state["hasCss"]
        assert state["scope"] == app_url

        # Deliver a real push message to the worker (DevTools protocol) → a Hebrew RTL notification.
        origin = app_url.rstrip("/")
        s.ctx.grant_permissions(["notifications"], origin=origin)
        cdp = s.ctx.new_cdp_session(page)
        regs = []
        cdp.on("ServiceWorker.workerRegistrationUpdated", lambda e: regs.extend(e["registrations"]))
        cdp.send("ServiceWorker.enable")
        for _ in range(50):
            if regs:
                break
            page.wait_for_timeout(100)
        reg_id = next(r["registrationId"] for r in regs if not r.get("isDeleted") and r["scopeURL"] == app_url)
        payload = json.dumps({"title": "יוצאים בעוד שעה 🚗", "body": "לא לשכוח כסאות!", "url": "#/t/x/lists", "tag": "go", "urgent": True})
        cdp.send("ServiceWorker.deliverPushMessage", {"origin": origin, "registrationId": reg_id, "data": payload})
        notes = []
        for _ in range(40):
            notes = page.evaluate(
                """async () => (await (await navigator.serviceWorker.ready).getNotifications())
                    .map((n) => ({ title: n.title, body: n.body, dir: n.dir, lang: n.lang, tag: n.tag, data: n.data,
                                   icon: n.icon, urgent: n.requireInteraction }))"""
            )
            if notes:
                break
            page.wait_for_timeout(100)
        assert len(notes) == 1
        n = notes[0]
        assert n["title"] == "יוצאים בעוד שעה 🚗" and n["body"] == "לא לשכוח כסאות!"
        assert n["dir"] == "rtl" and n["lang"] == "he" and n["tag"] == "go" and n["urgent"] is True
        assert n["data"] == {"url": "#/t/x/lists"}
        assert n["icon"].endswith("assets/icons/icon-192.png")
        s.assert_clean()
    finally:
        s.close()


def test_offline_banner(session, app_url):
    s = session
    s.boot(app_url)
    page = s.page
    expect(page.locator(".banner--offline")).to_have_count(0)
    s.ctx.set_offline(True)
    expect(page.locator(".banner--offline")).to_be_visible()
    s.shot("offline-light")
    s.ctx.set_offline(False)
    expect(page.locator(".banner--offline")).to_have_count(0)
    s.assert_clean()


def test_error_boundary_and_failed_screen_load(session, app_url):
    s = session
    page = s.page
    # A screen that throws while rendering, and one whose module fails to download.
    page.route("**/js/screens/money.js", lambda r: r.fulfill(
        status=200, content_type="text/javascript",
        body="export default function MoneyScreen() { throw new Error('boom'); }"))
    people_js = re.compile(r".*/js/screens/people\.js(\?.*)?$")  # incl. cache-busted retries
    page.route(people_js, lambda r: r.fulfill(status=503, body="down"))
    s.boot(app_url)
    page.locator('.nav-tab[data-tab="money"]').click()
    expect(page.get_by_text("אופס, משהו השתבש")).to_be_visible()
    expect(page.locator(".bottom-nav")).to_be_visible()  # the shell survives
    s.shot("error-boundary-light")
    page.locator('.nav-tab[data-tab="people"]').click()
    expect(page.get_by_text("המסך לא נטען")).to_be_visible()
    # Once the module is reachable again, "לנסות שוב" recovers without a reload.
    page.unroute(people_js)
    page.get_by_role("button", name="לנסות שוב").click()
    expect(page.get_by_text("המסך לא נטען")).to_have_count(0)
    expect(page.locator(".page .screen").first).to_be_visible()
    # Only the two deliberate failures were logged.
    assert any("screen crashed" in e for e in s.errors)
    assert any('failed to load screen "people"' in e for e in s.errors)
    unexpected = [e for e in s.errors if "screen crashed" not in e and "people" not in e and "boom" not in e and "503" not in e]
    assert unexpected == []


def test_new_notification_becomes_a_toast(session, app_url):
    s = session
    s.boot(app_url)
    page = s.page
    title = page.evaluate(
        f"""async () => {{
            const m = await import({STORE_JS});
            const st = m.store.get(); const api = st.api; const snap = st.snap;
            const me = snap.me.member_id;
            const admin = snap.members.find((x) => x.id !== me && (x.role === 'admin' || x.role === 'owner'));
            const item = snap.items.find((i) => i.status === 'active' && (i.type === 'buy' || i.type === 'bring')
                && !snap.pledges.some((p) => p.item_id === i.id && p.member_id === me));
            await api.demo.actAs(admin.id); await m.actions.refresh();   // another admin…
            await api.assign(item.id, me, 1);                            // …assigns something to me
            await api.demo.actAs(me);                                    // back to me; realtime refresh follows
            return item.title;
        }}"""
    )
    toast = page.locator(".toast", has_text=f"שובצת: {title}")
    expect(toast).to_be_visible(timeout=5000)
    s.shot("notification-toast-light")
    toast.click()
    expect(page).to_have_url(re.compile(r"/messages$"))
    s.assert_clean()
