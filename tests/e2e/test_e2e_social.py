"""Social screens E2E — Messages (SPEC §8.8), People (§8.9) and Me (§8.10).

The real app in demo mode (index.html?demo=1), driven through the UI with clicks and typing,
as the owner/admin ("נועה ואיתי") and as a regular member ("יואב", via api.demo.actAs).

Runs in Microsoft Edge (Playwright channel "msedge", falling back to "chrome") at a phone
viewport (390x844, touch). Every test uses a fresh browser context, so the demo backend
re-seeds "טיול לדוגמה בכנרת 🌊" for it. page.evaluate is only used for setup (actAs) and to
read expected values from the snapshot / js/lib/logic.js. Any console error or page error
fails the test (Google Fonts network errors are ignored).

Screenshots land in tests/e2e/artifacts/social/.

    .venv\\Scripts\\python.exe -m pytest tests/e2e/test_social.py -q
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from devserver import start_server  # noqa: E402

ART = ROOT / "tests" / "e2e" / "artifacts" / "social"
PHONE = {"width": 390, "height": 844}
SMALL = {"width": 360, "height": 780}
IGNORED_ERROR_HOSTS = ("fonts.googleapis.com", "fonts.gstatic.com")

STORE_JS = "new URL('js/store.js', location.href).href"
LOGIC_JS = "new URL('js/lib/logic.js', location.href).href"

# config.js may be switched to the real Supabase project (and a VAPID key) at any time; the
# tests always run the demo backend and the "no VAPID key yet" push path.
TEST_CONFIG = 'window.MEDURA_CONFIG = { supabaseUrl: "", supabaseAnonKey: "", vapidPublicKey: "" };'

OWNER = "נועה ואיתי"
ADMIN = "מאיה ורון"
MEMBER = "יואב"


# ---------------------------------------------------------------------------
# fixtures & helpers
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def social_server():
    # tools/devserver.py uses the socketserver default listen backlog (5). On Windows a fresh
    # page load fires ~30 parallel module/CSS requests, and some are refused
    # (net::ERR_CONNECTION_REFUSED) often enough to make boot flaky. Raise the backlog for
    # the server this module starts only.
    import devserver

    cls = devserver.ThreadingHTTPServer
    had = "request_queue_size" in cls.__dict__
    old = cls.__dict__.get("request_queue_size")
    cls.request_queue_size = 128
    try:
        srv, base = start_server()
    finally:
        if had:
            cls.request_queue_size = old
        else:
            del cls.request_queue_size
    yield base
    srv.shutdown()


@pytest.fixture(scope="module")
def social_edge():
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

    def __init__(self, edge, base, scheme="light", viewport=None):
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
        try:
            self.ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=base.rstrip("/"))
        except PlaywrightError:
            pass
        self.ctx.route("**/config.js*", lambda route: route.fulfill(
            status=200, content_type="application/javascript", body=TEST_CONFIG))
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

    # --- setup / reading ----------------------------------------------------

    def boot(self, hash_=""):
        self.page.goto(f"{self.base}index.html?demo=1{hash_}")
        try:
            self.page.wait_for_selector(".bottom-nav", timeout=15000)
            self.page.evaluate(f"import({STORE_JS}).then((m) => {{ window.__testStore = m.store; }})")
            self.page.wait_for_function("!!window.__testStore.get().snap", timeout=15000)
        except PlaywrightError as e:
            body = self.page.evaluate("document.body.innerText.slice(0, 400)")
            raise AssertionError(f"boot failed at {self.page.url}: {body!r} errors={self.errors}") from e

    def eval_store(self, body):
        """Run `body` (JS statements) with m = store module, L = logic, st, api, snap."""
        return self.page.evaluate(
            f"async () => {{ const m = await import({STORE_JS}); const L = await import({LOGIC_JS});"
            f" const st = m.store.get(); const api = st.api; const snap = st.snap; {body} }}"
        )

    def act_as(self, display_name):
        """Demo only: re-link this browser's user to another member of the trip, then refresh."""
        self.eval_store(
            f"const t = snap.members.find((x) => x.display_name === {display_name!r});"
            " await api.demo.actAs(t.id); await m.actions.refresh();"
        )

    def wait_js(self, predicate_body, timeout=5000):
        """Wait until `predicate_body` (JS expression over snap / L) is truthy.

        wait_for_function does not await promises (a pending Promise counts as truthy), so the
        modules are imported once up front and the predicate itself stays synchronous."""
        self.page.evaluate(
            f"async () => {{ window.__socialT = {{ m: await import({STORE_JS}), L: await import({LOGIC_JS}) }}; }}"
        )
        self.page.wait_for_function(
            f"""() => {{
              const {{ m, L }} = window.__socialT;
              const snap = m.store.get().snap; if (!snap) return false;
              return Boolean({predicate_body});
            }}""",
            timeout=timeout,
        )

    # --- navigation ---------------------------------------------------------

    def open_tab(self, key, ready):
        self.page.locator(f".bottom-nav [data-tab={key}]").click()
        expect(self.page.locator(ready)).to_be_visible()

    def open_messages(self):
        self.open_tab("messages", ".msg-head")

    def open_people(self):
        self.open_tab("people", ".ppl-hero")

    def open_me(self):
        self.page.locator(".topbar__me").click()
        expect(self.page.locator(".me-hero")).to_be_visible()

    # --- ui helpers ---------------------------------------------------------

    def toast(self, text):
        t = self.page.locator(".toast", has_text=text)
        expect(t.first).to_be_visible(timeout=5000)
        return t

    def sheet(self, title):
        d = self.page.get_by_role("dialog", name=title)
        expect(d).to_be_visible()
        return d

    def confirm(self, title, button):
        d = self.page.get_by_role("alertdialog", name=title)
        expect(d).to_be_visible()
        d.get_by_role("button", name=button, exact=True).click()
        expect(d).to_have_count(0)

    def shot(self, name, full_page=True):
        self.page.evaluate("document.fonts.ready")
        if full_page:
            self.page.evaluate("window.scrollTo(0, 0)")  # sticky chrome sits at the top of the capture
        self.page.wait_for_timeout(700)
        self.page.screenshot(path=str(ART / f"{name}.png"), full_page=full_page)

    def no_hscroll(self):
        width = self.page.evaluate("document.documentElement.clientWidth")
        scroll = self.page.evaluate("document.documentElement.scrollWidth")
        assert scroll <= width, f"horizontal overflow: scrollWidth {scroll} > {width}"


@pytest.fixture
def owner(social_edge, social_server):
    s = Session(social_edge, social_server)
    s.boot()
    yield s
    s.close()


@pytest.fixture
def member(social_edge, social_server):
    s = Session(social_edge, social_server)
    s.boot()
    s.act_as(MEMBER)
    expect(s.page.locator(".topbar__me")).to_be_visible()
    yield s
    s.close()


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------


def test_messages_feed_marks_read_once_and_shows_receipts(owner):
    s, page = owner, owner.page
    unread = s.eval_store("return L.unreadCount(snap);")
    assert unread > 0, "the seed should leave the owner with unread notices"
    expect(page.locator(".topbar__bell .badge")).to_have_text(str(unread))

    s.open_messages()
    # Header counts the fresh ones; each fresh notice carries the "חדש" dot.
    expect(page.locator(".msg-head__fresh")).to_contain_text(str(unread))
    expect(page.locator(".msg-notice.is-fresh")).to_have_count(unread)

    # mark_read ran for everything visible → the bell badge disappears, and it runs only once.
    s.wait_js("L.unreadCount(snap) === 0")
    expect(page.locator(".topbar__bell .badge")).to_have_count(0)
    rev1 = s.eval_store("return snap.trip.rev;")
    page.wait_for_timeout(1500)
    rev2 = s.eval_store("return snap.trip.rev;")
    assert rev1 == rev2, f"mark_read refresh loop: rev {rev1} -> {rev2}"
    # Still highlighted as new for this visit.
    expect(page.locator(".msg-notice.is-fresh")).to_have_count(unread)

    # Announcement: author avatar + name, time ago, body.
    ann = page.locator("article.msg-notice--ann", has_text="יוצאים ב-09:00 מהחניון")
    expect(ann.locator(".msg-notice__who")).to_have_text(ADMIN)
    expect(ann.locator(".avatar")).to_be_visible()
    expect(ann.locator("time")).to_contain_text("לפני")
    expect(ann).to_contain_text("מי שצריך/ה טרמפ")

    # Urgent + targeted announcement (authored by me): ember style + pills.
    urgent = page.locator("article.msg-notice--urgent", has_text="חסרים כסאות ומחצלות")
    expect(urgent).to_be_visible()
    expect(urgent).to_contain_text("🔴 דחוף")
    expect(urgent).to_contain_text("🎯 רק ל-2")

    # Read receipts (admins/author): Maya's announcement went to everyone but her → 4 recipients,
    # read by יואב + שירה וטל in the seed, plus me just now.
    rec = ann.locator(".msg-receipts__toggle")
    expect(rec).to_contain_text("נקרא ע״י")
    expect(rec).to_contain_text("3/4")
    rec.click()
    expect(rec).to_have_attribute("aria-expanded", "true")
    panel = ann.locator(".msg-receipts__panel")
    expect(panel.locator(".msg-receipt.is-read")).to_have_count(3)
    expect(panel.locator(".msg-receipt:not(.is-read)")).to_have_count(1)
    expect(panel.locator(".msg-receipt:not(.is-read)")).to_contain_text("אורי")

    # My urgent one: 1 of 2 read (שירה וטל), יואב still pending.
    urec = urgent.locator(".msg-receipts__toggle")
    expect(urec).to_contain_text("1/2")
    urec.click()
    expect(urgent.locator(".msg-receipt:not(.is-read)")).to_contain_text(MEMBER)
    expect(urgent.get_by_role("link", name="להזכיר בוואטסאפ")).to_have_attribute("href", re.compile(r"^https://wa\.me/\?text="))

    # System notices link inside the app.
    sys_link = page.locator("article.msg-notice--sys a.msg-notice__title", has_text="הצעה חדשה: כנפיים")
    expect(sys_link).to_have_attribute("href", re.compile(r"^#/t/[^/]+/lists\?item="))

    # Filter chips.
    page.get_by_role("button", name="⚙️ עדכוני מערכת").click()
    expect(page.locator("article.msg-notice--ann")).to_have_count(0)
    page.get_by_role("button", name="📣 מהמנהלים").click()
    expect(page.locator("article.msg-notice--sys")).to_have_count(0)
    expect(page.locator("article.msg-notice--ann")).to_have_count(2)
    s.assert_clean()


def test_messages_composer_audience_urgent_share_and_delete(owner):
    s, page = owner, owner.page
    s.open_messages()
    page.locator(".msg-compose-prompt").click()
    composer = page.locator(".msg-composer")
    expect(composer).to_be_visible()

    # Empty title is blocked.
    composer.get_by_role("button", name="שליחה").click()
    expect(composer.locator(".field__error")).to_contain_text("מה הכותרת")

    composer.get_by_label("כותרת").fill("מביאים פנסים לכולם 🔦")
    composer.get_by_label("פרטים (לא חובה)").fill("בלילה חשוך בחוף — כל אחד/ת עם פנס ראש")

    # "Only some" with nobody picked → blocked with a clear error, nothing is sent.
    before = s.eval_store("return snap.notifications.length;")
    composer.get_by_role("tab", name="🎯 רק לחלק").click()
    composer.get_by_role("button", name="שליחה").click()
    expect(composer.locator(".field__error")).to_contain_text("בחרו לפחות חבר/ה אחד/ת")
    assert s.eval_store("return snap.notifications.length;") == before

    # Pick יואב, mark urgent, send.
    composer.locator(".member-opt", has_text=MEMBER).click()
    expect(composer.locator(".field__error")).to_have_count(0)
    urgent_switch = composer.get_by_role("switch", name="🔴 הודעה דחופה")
    urgent_switch.click()
    expect(urgent_switch).to_have_attribute("aria-checked", "true")
    composer.get_by_role("button", name="שליחה דחופה").click()
    s.toast("ההודעה הדחופה נשלחה 🔴")

    # Offer to share on WhatsApp too.
    sent = page.locator(".msg-sent")
    expect(sent).to_contain_text("ההודעה יצאה לדרך!")
    share = sent.get_by_role("link", name="שתף גם בוואטסאפ")
    expect(share).to_have_attribute("href", re.compile(r"^https://wa\.me/\?text=.*%F0%9F%94%B4"))

    notice = page.locator("article.msg-notice", has_text="מביאים פנסים לכולם")
    expect(notice).to_contain_text("🔴 דחוף")
    expect(notice).to_contain_text(f"🎯 רק ל{MEMBER}")
    expect(notice.locator(".msg-receipts__toggle")).to_contain_text("0/1")
    ids = s.eval_store(
        "const n = snap.notifications.find((x) => x.title.startsWith('מביאים פנסים'));"
        " return {urgent: n.urgent, audience: n.audience, yoav: snap.members.find((x) => x.display_name === 'יואב').id};"
    )
    assert ids["urgent"] is True and ids["audience"] == [ids["yoav"]]

    # "הודעה נוספת" re-opens an empty composer.
    sent.get_by_role("button", name="הודעה נוספת").click()
    expect(page.locator(".msg-composer").get_by_label("כותרת")).to_have_value("")

    # Admin/author can delete it (with confirm).
    notice.get_by_role("button", name="מחיקת ההודעה").click()
    s.confirm("למחוק את ההודעה?", "מחיקה")
    s.toast("ההודעה נמחקה 🗑️")
    expect(page.locator("article.msg-notice", has_text="מביאים פנסים לכולם")).to_have_count(0)
    s.assert_clean()


def test_messages_member_view_has_no_admin_controls(member):
    s, page = member, member.page
    s.open_messages()
    expect(page.locator(".msg-compose-prompt")).to_have_count(0)
    expect(page.locator(".msg-composer")).to_have_count(0)
    urgent = page.locator("article.msg-notice--urgent", has_text="חסרים כסאות ומחצלות")
    expect(urgent).to_contain_text("נשלח אליך אישית")
    expect(urgent.locator(".msg-notice__who")).to_have_text(OWNER)
    expect(page.locator(".msg-receipts__toggle")).to_have_count(0)
    expect(page.get_by_role("button", name="מחיקת ההודעה")).to_have_count(0)
    s.wait_js("L.unreadCount(snap) === 0")
    expect(page.locator(".topbar__bell .badge")).to_have_count(0)
    s.assert_clean()


def test_polls_vote_create_close_delete_as_member(member):
    s, page = member, member.page
    s.open_messages()
    page.get_by_role("tab", name=re.compile("סקרים")).click()
    poll = page.locator("article.msg-poll", has_text="מה עושים בלילה אחרי על האש")
    expect(poll).to_be_visible()
    # Maya's poll: a member can vote but not close/delete it.
    expect(poll.get_by_role("button", name="🔒 סגירה")).to_have_count(0)
    expect(poll.get_by_role("button", name="מחיקת הסקר")).to_have_count(0)

    opt_fire = poll.get_by_role("radio", name=re.compile("^מדורה ושירים"))
    opt_swim = poll.get_by_role("radio", name=re.compile("^טבילת לילה"))
    expect(opt_swim).to_have_attribute("aria-checked", "true")  # seed: יואב voted o3
    opt_fire.click()
    expect(opt_fire).to_have_attribute("aria-checked", "true")
    expect(opt_swim).to_have_attribute("aria-checked", "false")
    s.wait_js("snap.poll_votes.some((v) => v.member_id === snap.me.member_id && v.option_id === 'o1')")
    exp = s.eval_store(
        "const p = snap.polls.find((x) => x.question.startsWith('מה עושים בלילה'));"
        " return L.pollResults(p, snap.poll_votes.filter((v) => v.poll_id === p.id));"
    )
    fire = next(r for r in exp if r["id"] == "o1")
    expect(opt_fire.locator(".msg-opt__count")).to_have_text(f"{fire['pct']}%")
    expect(opt_fire.locator(".avatar-stack .avatar")).to_have_count(fire["count"])
    expect(poll.locator(".msg-poll__votes")).to_contain_text("הצביעו 3 מתוך 5")

    # Create a poll: validation, then publish.
    page.get_by_role("button", name="סקר חדש").first.click()
    sheet = s.sheet("📊 סקר חדש")
    sheet.get_by_label("השאלה").fill("מה אוכלים בבוקר? 🍳")
    sheet.get_by_role("textbox", name="אפשרות 1").fill("שקשוקה")
    sheet.get_by_role("button", name="פרסום הסקר").click()
    expect(sheet.locator(".field__error")).to_contain_text("צריך לפחות 2 אפשרויות")
    sheet.get_by_role("textbox", name="אפשרות 2").fill("פנקייקים")
    sheet.get_by_role("button", name="עוד אפשרות").click()
    sheet.get_by_role("textbox", name="אפשרות 3").fill("טוסטים")
    sheet.get_by_role("switch", name="אפשר לבחור כמה תשובות").click()
    sheet.get_by_role("button", name="פרסום הסקר").click()
    s.toast("הסקר באוויר! 📊")
    expect(sheet).to_have_count(0)

    mine = page.locator("article.msg-poll", has_text="מה אוכלים בבוקר")
    expect(mine).to_contain_text("אפשר לבחור כמה")
    expect(mine.get_by_role("checkbox")).to_have_count(3)
    mine.get_by_role("checkbox", name=re.compile("^שקשוקה")).click()
    mine.get_by_role("checkbox", name=re.compile("^טוסטים")).click()
    expect(mine.get_by_role("checkbox", name=re.compile("^שקשוקה"))).to_have_attribute("aria-checked", "true")
    expect(mine.get_by_role("checkbox", name=re.compile("^טוסטים"))).to_have_attribute("aria-checked", "true")
    s.wait_js("snap.poll_votes.filter((v) => v.member_id === snap.me.member_id).length === 3")

    # Creator can close (voting disabled) and delete it.
    mine.get_by_role("button", name="🔒 סגירה").click()
    s.toast("הסקר נסגר 🔒")
    expect(mine.locator(".msg-poll__head")).to_contain_text("🔒 נסגר")
    expect(mine.get_by_role("checkbox", name=re.compile("^פנקייקים"))).to_be_disabled()
    mine.get_by_role("button", name="מחיקת הסקר").click()
    s.confirm("למחוק את הסקר?", "מחיקה")
    s.toast("הסקר נמחק 🗑️")
    expect(page.locator("article.msg-poll", has_text="מה אוכלים בבוקר")).to_have_count(0)
    s.assert_clean()


def test_polls_admin_can_close_someone_elses_poll(owner):
    s, page = owner, owner.page
    s.open_messages()
    # The owner hasn't voted → a nudge on the feed leads to the polls tab.
    nudge = page.locator(".msg-nudge")
    expect(nudge).to_contain_text("סקר פתוח מחכה לקול שלך")
    nudge.click()
    poll = page.locator("article.msg-poll", has_text="מה עושים בלילה אחרי על האש")
    poll.get_by_role("button", name="🔒 סגירה").click()
    s.toast("הסקר נסגר 🔒")
    expect(poll.locator(".msg-opt.is-winner")).to_contain_text("🏆")
    poll.get_by_role("button", name="🔓 פתיחה מחדש").click()
    s.toast("הסקר נפתח מחדש 🔓")
    expect(poll.locator(".msg-poll__head")).to_contain_text("פתוח")
    s.assert_clean()


# ---------------------------------------------------------------------------
# People
# ---------------------------------------------------------------------------

PEOPLE_EXPECTED = """
  const byItem = new Map(snap.items.map((i) => [i.id, i]));
  const counts = {};
  for (const p of snap.pledges) {
    const it = byItem.get(p.item_id);
    if (!it || it.status === 'rejected' || it.type === 'each') continue;
    counts[p.member_id] = (counts[p.member_id] || 0) + 1;
  }
  const bals = Object.fromEntries(L.balances(snap).map((b) => [b.member_id, b.balance]));
  return snap.members.map((mm) => ({
    id: mm.id, name: L.displayName(mm), count: counts[mm.id] || 0, balance: bals[mm.id] || 0,
    abs: L.formatMoney(Math.abs(bals[mm.id] || 0)), claimed: mm.claimed, role: mm.role,
    chat: mm.phone ? L.whatsappChatUrl(mm.phone) : null,
  }));
"""


def test_people_cards_stats_and_member_sheet(owner):
    s, page = owner, owner.page
    s.open_people()
    expect(page.locator(".ppl-hero__line")).to_have_text("8 אנשים · 3 זוגות · 2 יחידים")

    exp = s.eval_store(PEOPLE_EXPECTED)
    cards = page.locator("article.ppl-card")
    expect(cards).to_have_count(len(exp))
    expect(cards.first).to_contain_text(OWNER)  # me first
    expect(cards.first).to_contain_text("את/ה")
    for m in exp:
        card = page.locator("article.ppl-card", has=page.locator(".ppl-card__name", has_text=re.compile(f"^{m['name']}$")))
        expect(card).to_have_count(1)
        if m["count"]:
            expect(card).to_contain_text(f"מביא/ה {m['count']} ")
        if m["balance"] >= 0.5:
            expect(card).to_contain_text(f"מגיע {m['abs']}")
        elif m["balance"] <= -0.5:
            expect(card).to_contain_text(f"צריך להעביר {m['abs']}")
        if not m["claimed"]:
            expect(card).to_contain_text("עוד לא נכנס/ה")
        if m["role"] == "owner":
            expect(card).to_contain_text("👑 יוצר/ת הטיול")
        elif m["role"] == "admin":
            expect(card).to_contain_text("👑 מנהל/ת")
        if m["chat"] and m["name"] != OWNER:
            expect(card.locator("a.ppl-card__chat")).to_have_attribute("href", m["chat"])

    # "Who has it at home?" search.
    page.get_by_label("חיפוש חברים או ציוד שיש להם בבית").fill("כסאות ים")
    expect(page.locator(".ppl-search__result")).to_contain_text("ל-2 חברים יש ״כסאות ים״ בבית")
    expect(page.locator("article.ppl-card")).to_have_count(2)
    page.get_by_label("חיפוש חברים או ציוד שיש להם בבית").fill("")

    # Member sheet: what they bring, WhatsApp, admin controls.
    page.locator(".ppl-card__name", has_text=ADMIN).click()
    sheet = s.sheet(ADMIN)
    expect(sheet.get_by_role("link", name="וואטסאפ")).to_have_attribute("href", re.compile(r"^https://wa\.me/972"))
    expect(sheet.locator(".ppl-take__row").first).to_be_visible()
    expect(sheet.get_by_role("button", name="הסר ניהול")).to_be_visible()
    expect(sheet.get_by_role("button", name="הסרה מהטיול")).to_be_visible()
    sheet.get_by_role("button", name="סגירה").click()
    expect(sheet).to_have_count(0)
    s.assert_clean()


def test_people_admin_election_promote_demote(owner):
    s, page = owner, owner.page
    s.open_people()
    card = page.locator(".ppl-elect")
    shira = card.locator(".ppl-elect__row", has_text="שירה וטל")
    yoav = card.locator(".ppl-elect__row", has_text=MEMBER)
    # Seed: שירה וטל has 2 votes (top) → highlighted; יואב has 1.
    expect(shira).to_have_class(re.compile("is-leading"))
    expect(shira.locator(".ppl-vote__count")).to_have_text("2")
    expect(yoav.locator(".ppl-vote__count")).to_have_text("1")

    vote = yoav.locator(".ppl-vote")
    expect(vote).to_have_attribute("aria-pressed", "false")
    vote.click()
    expect(vote).to_have_attribute("aria-pressed", "true")
    expect(yoav.locator(".ppl-vote__count")).to_have_text("2")
    s.wait_js("snap.admin_votes.some((v) => v.voter_id === snap.me.member_id)")
    expect(vote).not_to_have_attribute("aria-busy", "true")  # one call per candidate at a time
    vote.click()
    expect(vote).to_have_attribute("aria-pressed", "false")
    expect(yoav.locator(".ppl-vote__count")).to_have_text("1")
    s.wait_js("!snap.admin_votes.some((v) => v.voter_id === snap.me.member_id)")

    # Promote the top-voted, then demote.
    shira.get_by_role("button", name="👑 מנה למנהל/ת").click()
    s.toast("שירה וטל מנהל/ת עכשיו 👑")
    expect(shira.locator(".ppl-elect__sub")).to_contain_text("👑 מנהל/ת")
    expect(page.locator("article.ppl-card", has_text="שירה וטל")).to_contain_text("👑 מנהל/ת")
    shira.get_by_role("button", name="הסר ניהול").click()
    s.toast("שירה וטל כבר לא מנהל/ת")
    expect(shira.get_by_role("button", name="👑 מנה למנהל/ת")).to_be_visible()
    # The owner row has no role button.
    expect(card.locator(".ppl-elect__row", has_text=OWNER).locator(".ppl-elect__role")).to_have_count(0)
    s.assert_clean()


def test_people_invite_rotate_add_and_remove_profile(owner):
    s, page = owner, owner.page
    s.open_people()
    old = s.eval_store("return snap.trip.invite_code;")
    invite = page.locator(".ppl-invite")
    expect(invite.locator(".ppl-linkbox")).to_contain_text(f"#/join/{old}")
    expect(invite.get_by_role("link", name="שליחה בוואטסאפ")).to_have_attribute("href", re.compile(r"^https://wa\.me/\?text="))
    invite.get_by_role("button", name="העתקה").click()
    expect(invite.get_by_role("button", name="הועתק!")).to_be_visible()

    invite.get_by_role("button", name=re.compile("קישור חדש")).click()
    s.confirm("ליצור קישור הזמנה חדש?", "קישור חדש")
    s.toast("נוצר קישור חדש")
    new = s.eval_store("return snap.trip.invite_code;")
    assert new != old
    expect(invite.locator(".ppl-linkbox")).to_contain_text(f"#/join/{new}")

    # Add a placeholder profile.
    page.get_by_role("button", name=re.compile("הוספת פרופיל לחבר")).click()
    sheet = s.sheet("➕ פרופיל לחבר/ה")
    sheet.get_by_role("button", name="הוספה").click()
    expect(sheet.locator(".field__error")).to_contain_text("איך קוראים לך")
    sheet.get_by_label("שם", exact=True).fill("דני")
    sheet.get_by_role("button", name="הוספה").click()
    s.toast("הפרופיל של דני נוסף 🎉")
    card = page.locator("article.ppl-card", has=page.locator(".ppl-card__name", has_text=re.compile("^דני$")))
    expect(card).to_contain_text("עוד לא נכנס/ה")

    # The new member's sheet opens: personal invite + remove.
    dani = s.sheet("דני")
    expect(dani.get_by_role("link", name="שליחת הזמנה לדני")).to_have_attribute("href", re.compile(r"^https://wa\.me/\?text="))
    dani.get_by_role("button", name="הסרה מהטיול").click()
    s.confirm("להסיר את דני מהטיול?", "הסרה")
    s.toast("דני הוסר/ה מהטיול")
    expect(card).to_have_count(0)
    expect(page.locator(".ppl-hero__line")).to_have_text("8 אנשים · 3 זוגות · 2 יחידים")
    s.assert_clean()


def test_people_member_view_hides_admin_tools(member):
    s, page = member, member.page
    s.open_people()
    expect(page.locator(".ppl-tools")).to_have_count(0)
    expect(page.locator(".ppl-elect__role")).to_have_count(0)
    expect(page.locator(".ppl-invite").get_by_role("button", name=re.compile("קישור חדש"))).to_have_count(0)
    # Can still share the invite and vote.
    expect(page.locator(".ppl-invite").get_by_role("link", name="שליחה בוואטסאפ")).to_be_visible()
    row = page.locator(".ppl-elect__row", has_text=OWNER)
    row.locator(".ppl-vote").click()
    expect(row.locator(".ppl-vote")).to_have_attribute("aria-pressed", "true")
    s.wait_js(
        "snap.admin_votes.some((v) => v.voter_id === snap.me.member_id"
        " && v.candidate_id === snap.members.find((x) => x.role === 'owner').id)"
    )
    page.locator(".ppl-card__name", has_text=ADMIN).click()
    sheet = s.sheet(ADMIN)
    expect(sheet.locator(".ppl-sheet__admin")).to_have_count(0)
    expect(sheet.get_by_role("button", name="הסרה מהטיול")).to_have_count(0)
    s.assert_clean()


# ---------------------------------------------------------------------------
# Me
# ---------------------------------------------------------------------------


def test_me_profile_edit_couple_and_single(owner):
    s, page = owner, owner.page
    s.open_me()
    expect(page.locator(".me-hero__name")).to_have_text(OWNER)
    expect(page.locator(".me-hero")).to_contain_text("👑 יוצר/ת הטיול")

    page.locator(".me-hero").get_by_role("button", name="עריכה").click()
    sheet = s.sheet("✏️ עריכת פרופיל")
    expect(sheet.get_by_role("radio", name=re.compile("זוג"))).to_have_attribute("aria-checked", "true")
    sheet.get_by_label("ושל בן/בת הזוג").fill("איתן")
    expect(sheet.get_by_label("שם תצוגה")).to_have_value("נועה ואיתן")
    sheet.locator(".emoji-opt").nth(3).click()
    expect(sheet.locator(".emoji-opt").nth(3)).to_have_attribute("aria-pressed", "true")
    sheet.get_by_role("button", name="שמירה").click()
    s.toast("הפרופיל עודכן ✨")
    expect(sheet).to_have_count(0)
    expect(page.locator(".me-hero__name")).to_have_text("נועה ואיתן")

    # Switch to single; bad phone is blocked, a good one saves.
    page.locator(".me-hero").get_by_role("button", name="עריכה").click()
    sheet = s.sheet("✏️ עריכת פרופיל")
    sheet.get_by_role("radio", name=re.compile("יחיד")).click()
    expect(sheet.get_by_label("ושל בן/בת הזוג")).to_have_count(0)
    expect(sheet.get_by_label("שם תצוגה")).to_have_value("נועה")
    sheet.get_by_label("טלפון (לא חובה)").fill("abc")
    sheet.get_by_role("button", name="שמירה").click()
    expect(sheet.locator(".field__error")).to_contain_text("המספר לא נראה תקין")
    sheet.get_by_label("טלפון (לא חובה)").fill("052-555-1234")
    sheet.get_by_role("button", name="שמירה").click()
    s.toast("הפרופיל עודכן ✨")
    expect(page.locator(".me-hero__name")).to_have_text("נועה")
    expect(page.locator(".me-hero")).to_contain_text("🧍 יחיד/ה")
    got = s.eval_store("const me = snap.members.find((x) => x.id === snap.me.member_id); return [me.headcount, me.people, me.phone];")
    assert got == [1, ["נועה"], "052-555-1234"]
    s.assert_clean()


def test_me_inventory_diet_and_notification_prefs(owner):
    s, page = owner, owner.page
    s.open_me()
    inv = page.locator(".me-inv")
    speaker = inv.get_by_role("button", name=re.compile("רמקול"))
    expect(speaker).to_have_attribute("aria-pressed", "false")
    speaker.click()
    expect(speaker).to_have_attribute("aria-pressed", "true")
    s.wait_js("snap.members.find((x) => x.id === snap.me.member_id).inventory.includes('רמקול')")

    inv.get_by_label("פריט נוסף שיש לי בבית").fill("ערסל")
    inv.get_by_role("button", name="הוספה").click()
    custom = inv.get_by_role("button", name="הסרת ערסל")
    expect(custom).to_be_visible()
    s.wait_js("snap.members.find((x) => x.id === snap.me.member_id).inventory.includes('ערסל')")
    custom.click()
    expect(custom).to_have_count(0)
    s.wait_js("!snap.members.find((x) => x.id === snap.me.member_id).inventory.includes('ערסל')")

    # Diet → prefs.diet
    diet = page.locator(".me-diet")
    area = diet.get_by_label("מה חשוב לדעת עליכם?")
    expect(area).to_have_value("איתי צמחוני 🥦")
    diet.get_by_role("button", name="🌾 בלי גלוטן").click()
    expect(area).to_have_value("איתי צמחוני 🥦, 🌾 בלי גלוטן")
    diet.get_by_role("button", name="שמירה").click()
    s.toast("ההעדפות נשמרו 🍽️")
    s.wait_js("snap.members.find((x) => x.id === snap.me.member_id).prefs.diet.includes('בלי גלוטן')")
    expect(diet.get_by_role("button", name="שמירה")).to_have_count(0)

    # Notification prefs, quiet hours, reminders → prefs.
    notify = page.locator(".me-notify")
    ann = notify.get_by_role("switch", name="📣 הודעות מהמנהלים")
    expect(ann).to_have_attribute("aria-checked", "true")
    ann.click()
    expect(ann).to_have_attribute("aria-checked", "false")
    expect(notify.locator(".me-saved")).to_contain_text("נשמר")
    notify.get_by_role("switch", name="🚗 בוקר היציאה").click()
    quiet = notify.get_by_role("switch", name="🌙 שעות שקט")
    quiet.click()
    expect(quiet).to_have_attribute("aria-checked", "true")
    expect(notify.get_by_label("מ-")).to_have_value("23:00")
    notify.get_by_label("עד").fill("07:30")
    notify.get_by_label("עד").dispatch_event("change")
    s.wait_js(
        "(() => { const p = snap.members.find((x) => x.id === snap.me.member_id).prefs;"
        " return p.notify?.announcements === false && p.reminders?.departure_morning === false"
        " && p.quiet_hours && p.quiet_hours.from === '23:00' && p.quiet_hours.to === '07:30'"
        " && String(p.diet).includes('בלי גלוטן'); })()"
    )

    # Survives a reload (it's in the snapshot, not local state). The reload also installs a
    # phone-like Notification permission flow (headless Edge reports "denied" and never asks):
    # "default" until requestPermission() is called, then "granted".
    s.ctx.add_init_script(
        """(() => {
          if (!('Notification' in window)) return;
          let perm = 'default';
          Object.defineProperty(Notification, 'permission', { configurable: true, get: () => perm });
          Notification.requestPermission = () => { perm = 'granted'; return Promise.resolve(perm); };
        })();"""
    )
    page.reload()
    page.wait_for_selector(".me-hero", timeout=15000)
    notify = page.locator(".me-notify")
    expect(notify.get_by_role("switch", name="📣 הודעות מהמנהלים")).to_have_attribute("aria-checked", "false")
    expect(notify.get_by_role("switch", name="🚗 בוקר היציאה")).to_have_attribute("aria-checked", "false")
    expect(notify.get_by_label("עד")).to_have_value("07:30")

    # This device: no VAPID key yet → permission only, friendly "בקרוב".
    notify.get_by_role("button", name="הפעל התראות למכשיר הזה").click()
    s.toast("התראות לטלפון יגיעו בקרוב")
    expect(notify.locator(".me-push")).to_contain_text("בקרוב")
    s.assert_clean()


def test_me_theme_device_link_trips_and_demo_switch(owner):
    s, page = owner, owner.page
    s.open_me()
    theme = page.locator(".me-theme")
    theme.get_by_role("tab", name="🌙 כהה").click()
    expect(page.locator("html")).to_have_attribute("data-theme", "dark")
    theme.get_by_role("tab", name="☀️ בהיר").click()
    expect(page.locator("html")).to_have_attribute("data-theme", "light")
    theme.get_by_role("tab", name="🌗 אוטומטי").click()
    expect(theme.get_by_role("tab", name="🌗 אוטומטי")).to_have_attribute("aria-selected", "true")

    device = page.locator(".me-device")
    device.get_by_role("button", name="יצירת קישור חיבור").click()
    expect(device.locator(".me-linkbox")).to_contain_text("#/link/")
    expect(device.get_by_role("link", name="שליחה בוואטסאפ")).to_have_attribute("href", re.compile(r"^https://wa\.me/\?text=.*%23%2Flink%2F"))

    expect(page.locator(".me-trip.is-current")).to_contain_text("כאן עכשיו")

    demo = page.locator(".me-demo")
    expect(demo).to_contain_text("החלף משתמש")
    demo.locator(".me-demo__opt", has_text=MEMBER).click()
    s.toast(f"עכשיו את/ה {MEMBER} 🎭")
    expect(page.locator(".me-hero__name")).to_have_text(MEMBER)
    expect(page.locator(".me-hero")).not_to_contain_text("👑")
    s.assert_clean()


def test_me_member_leaves_trip(member):
    s, page = member, member.page
    s.open_me()
    expect(page.locator(".me-hero__name")).to_have_text(MEMBER)
    page.get_by_role("button", name="יציאה מהטיול").click()
    s.confirm("לצאת מהטיול?", "יציאה")
    s.toast("יצאת מהטיול 👋")
    page.wait_for_function("location.hash === '#/' || location.hash === ''", timeout=5000)
    expect(page.locator(".bottom-nav")).to_have_count(0)
    s.assert_clean()


# ---------------------------------------------------------------------------
# Layout: light / dark at 390, and 360 without horizontal scroll
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_social_screens_render_cleanly(social_edge, social_server, scheme):
    s = Session(social_edge, social_server, scheme=scheme)
    try:
        s.boot()
        s.open_messages()
        s.no_hscroll()
        s.shot(f"messages-{scheme}")
        s.page.locator(".msg-compose-prompt").click()
        s.page.get_by_role("tab", name=re.compile("סקרים")).click()
        expect(s.page.locator("article.msg-poll").first).to_be_visible()
        s.no_hscroll()
        s.shot(f"messages-polls-{scheme}")
        s.open_people()
        s.no_hscroll()
        s.shot(f"people-{scheme}")
        s.open_me()
        s.no_hscroll()
        s.shot(f"me-{scheme}")
        s.assert_clean()
    finally:
        s.close()


def test_social_screens_at_360(social_edge, social_server):
    s = Session(social_edge, social_server, viewport=SMALL)
    try:
        s.boot()
        s.open_messages()
        s.page.locator(".msg-compose-prompt").click()
        s.page.get_by_role("tab", name="🎯 רק לחלק").click()
        s.no_hscroll()
        s.shot("messages-360")
        s.open_people()
        s.page.locator(".ppl-card__name", has_text=ADMIN).click()
        s.sheet(ADMIN)
        s.no_hscroll()
        s.shot("people-sheet-360", full_page=False)
        s.page.keyboard.press("Escape")
        s.no_hscroll()
        s.shot("people-360")
        s.open_me()
        s.page.locator(".me-hero").get_by_role("button", name="עריכה").click()
        s.sheet("✏️ עריכת פרופיל")
        s.no_hscroll()
        s.shot("me-edit-360", full_page=False)
        s.page.keyboard.press("Escape")
        s.no_hscroll()
        s.shot("me-360")
        s.assert_clean()
    finally:
        s.close()


def test_deep_links_boot_straight_into_each_screen(owner):
    """A cold load on each route shows the skeleton, then the screen (and honours its query)."""
    s, page = owner, owner.page
    trip = s.eval_store("return snap.trip.id;")
    cases = [
        (f"#/t/{trip}/messages?tab=polls", "article.msg-poll"),
        (f"#/t/{trip}/messages?compose=1", ".msg-composer"),
        (f"#/t/{trip}/people", ".ppl-hero"),
        (f"#/t/{trip}/me", ".me-hero"),
    ]
    for hash_, ready in cases:
        page.goto(f"{s.base}index.html?demo=1{hash_}")
        page.reload()
        expect(page.locator(ready).first).to_be_visible(timeout=15000)
        s.no_hscroll()
    member_id = s.eval_store("return snap.members.find((x) => x.display_name === 'יואב').id;")
    page.goto(f"{s.base}index.html?demo=1#/t/{trip}/people?member={member_id}")
    page.reload()
    s.sheet(MEMBER)
    s.assert_clean()
