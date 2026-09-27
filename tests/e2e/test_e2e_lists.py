"""Lists, shopping mode and import E2E (SPEC §8.4–§8.6) — the real app in demo mode, driven through the UI.

Runs in Microsoft Edge (Playwright channel "msedge", falling back to "chrome") at a phone
viewport (390x844, touch). Every test uses a fresh browser context, so the demo backend
re-seeds "טיול לדוגמה בכנרת 🌊" for it (the demo user is the owner "נועה ואיתי"; "מאיה ורון"
is an admin; "יואב" and "שירה וטל" are regular members). page.evaluate is only used for setup
(api.demo.actAs) and to read expected values from js/lib/logic.js. Any console error or page
error fails the test (Google Fonts network errors are ignored).

Screenshots land in tests/e2e/artifacts/lists/.

    .venv\\Scripts\\python.exe -m pytest tests/e2e/test_lists.py -q
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from devserver import start_server  # noqa: E402

ART = ROOT / "tests" / "e2e" / "artifacts" / "lists"
PHONE = {"width": 390, "height": 844}
SMALL = {"width": 360, "height": 780}
IGNORED_ERROR_HOSTS = ("fonts.googleapis.com", "fonts.gstatic.com")

STORE_JS = "new URL('js/store.js', location.href).href"
LOGIC_JS = "new URL('js/lib/logic.js', location.href).href"

IMPORT_TEXT = """🥩 בשרים
פרגיות - פר אדם 300 גרם
קבבים - פר אדם 8 יחידות

🥤 שתייה
2 שישיות סודה

חלוקה של כל אחד מהבית
3 פנסים
צידנית גדולה"""


# ---------------------------------------------------------------------------
# fixtures & helpers
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def lists_server():
    srv, base = start_server()
    yield base
    srv.shutdown()


@pytest.fixture(scope="module")
def lists_edge():
    ART.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        try:
            b = p.chromium.launch(channel="msedge")
        except PlaywrightError:
            b = p.chromium.launch(channel="chrome")
        yield b
        b.close()


def exact(text: str) -> re.Pattern:
    return re.compile(rf"^\s*{re.escape(text)}\s*$")


def press_on(chip):
    """Chips toggle; the title may already have auto-selected this one."""
    if chip.get_attribute("aria-pressed") != "true":
        chip.click()
    expect(chip).to_have_attribute("aria-pressed", "true")


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

    # -- setup ---------------------------------------------------------------

    def boot(self):
        self.page.goto(f"{self.base}index.html?demo=1")
        self.page.wait_for_selector(".bottom-nav", timeout=30000)
        self.page.evaluate(f"import({STORE_JS}).then((m) => {{ window.__testStore = m.store; }})")
        self.page.wait_for_function("!!window.__testStore.get().snap", timeout=15000)

    def eval_store(self, body):
        """Run `body` (JS statements) with m = store module, L = logic, st, api, snap in scope."""
        return self.page.evaluate(
            f"async () => {{ const m = await import({STORE_JS}); const L = await import({LOGIC_JS});"
            f" const st = m.store.get(); const api = st.api; const snap = st.snap; {body} }}"
        )

    def act_as(self, display_name):
        """Demo only: re-link this browser's user to another member of the trip, then refresh."""
        self.eval_store(
            f"const t = snap.members.find((x) => x.display_name === {json.dumps(display_name)});"
            " await api.demo.actAs(t.id); await m.actions.refresh();"
        )

    # -- expected values from logic.js --------------------------------------

    def readiness(self):
        return self.eval_store("const r = L.tripReadiness(snap); return { pct: r.pct, total: r.total };")

    def category_count(self, name):
        """'covered/total' over the active items of a category, per logic.itemProgress."""
        return self.eval_store(
            f"const c = snap.categories.find((x) => x.name === {json.dumps(name)});"
            " const its = snap.items.filter((i) => i.category_id === c.id && i.status === 'active');"
            " const cov = its.filter((i) => ['covered', 'done'].includes("
            "   L.itemProgress(i, snap.pledges.filter((p) => p.item_id === i.id), snap.members).state)).length;"
            " return `${cov}/${its.length}`;"
        )

    def per_person_math(self, qty, unit):
        return self.eval_store(
            f"const heads = L.headcountTotal(snap.members);"
            f" const eff = L.itemEffectiveQty({{ qty: {qty}, unit: {json.dumps(unit)}, per_person: true }}, heads).text;"
            f" return {{ heads, eff, one: L.formatQty({qty}, {json.dumps(unit)}) }};"
        )

    # -- navigation / locators -----------------------------------------------

    def open_lists(self):
        self.page.locator(".bottom-nav [data-tab=lists]").click()
        expect(self.page.locator(".ls-head__title")).to_have_text("רשימות")
        expect(self.page.locator(".ls-row").first).to_be_visible()

    def tab(self, label):
        t = self.page.get_by_role("tab", name=re.compile(re.escape(label)))
        t.click()
        expect(t).to_have_attribute("aria-selected", "true")
        return t

    def row(self, title):
        return self.page.locator(".ls-row").filter(has=self.page.locator(".ls-row__name", has_text=exact(title)))

    def open_item(self, title):
        self.row(title).locator(".ls-row__open").click()
        return self.sheet(title)

    def sheet(self, title):
        d = self.page.get_by_role("dialog", name=title)
        expect(d).to_be_visible()
        return d

    def close_sheet(self):
        self.page.keyboard.press("Escape")
        expect(self.page.get_by_role("dialog")).to_have_count(0)

    def confirm(self, button):
        dlg = self.page.get_by_role("alertdialog")
        expect(dlg).to_be_visible()
        dlg.get_by_role("button", name=button, exact=True).click()
        expect(dlg).to_have_count(0)

    def toast(self, text):
        t = self.page.locator(".toast", has_text=text)
        expect(t.first).to_be_visible(timeout=5000)
        return t

    def shot(self, name):
        self.page.evaluate("document.fonts.ready")
        self.page.wait_for_timeout(500)  # entrance animations settle
        self.page.screenshot(path=str(ART / f"{name}.png"))

    def no_hscroll(self):
        width = self.page.evaluate("document.documentElement.clientWidth")
        scroll = self.page.evaluate("document.documentElement.scrollWidth")
        assert scroll <= width, f"horizontal overflow: scrollWidth {scroll} > {width}"


@pytest.fixture
def owner(lists_edge, lists_server):
    s = Session(lists_edge, lists_server)
    s.boot()
    yield s
    s.close()


@pytest.fixture
def member(lists_edge, lists_server):
    """The same seed, but this browser acts as the regular member "יואב"."""
    s = Session(lists_edge, lists_server)
    s.boot()
    s.act_as("יואב")
    yield s
    s.close()


# ---------------------------------------------------------------------------
# §8.4 lists — overview, tabs, search, filter
# ---------------------------------------------------------------------------


def test_overview_tabs_search_and_missing_filter(owner):
    s, page = owner, owner.page
    s.open_lists()

    exp = s.readiness()
    sub = page.locator(".ls-head__sub")
    expect(sub).to_contain_text(f"{exp['total']} פריטים")
    expect(sub).to_contain_text(f"{exp['pct']}% מכוסה")
    expect(sub).to_contain_text("2 ממתינים לאישור")
    expect(page.get_by_role("tab", name=re.compile("לאישור"))).to_contain_text("2")

    # category sections: emoji + name + covered/total from logic.js
    meat = page.locator(".ls-cat").filter(has_text="בשר ועוף")
    expect(meat.locator(".section__count")).to_have_text(s.category_count("בשר ועוף"))
    expect(page.locator(".ls-cat").filter(has_text="ציוד קבוצתי").locator(".section__count")).to_have_text(
        s.category_count("ציוד קבוצתי")
    )

    # rows: status pill, effective qty, pledger avatars, quick action
    steak_qty = s.eval_store(
        "const it = snap.items.find((i) => i.title === 'סטייק אנטריקוט');"
        " return L.itemEffectiveQty(it, L.headcountTotal(snap.members)).text;"
    )
    expect(s.row("סטייק אנטריקוט").locator(".ls-qty")).to_have_text(steak_qty)
    expect(s.row("סטייק אנטריקוט").locator(".avatar-stack, .avatar").first).to_be_visible()
    expect(s.row("נקניקיות")).to_contain_text("חסר")
    expect(s.row("נקניקיות").get_by_role("button", name="אני על זה: נקניקיות")).to_be_visible()
    expect(s.row("פרגיות")).to_contain_text("נקנה ✓")
    expect(s.row("כסאות קמפינג")).to_contain_text("חלקי 5/8")
    expect(s.row("כסאות קמפינג").locator(".ls-qty")).to_have_text("×8")
    expect(s.row("כנפיים")).to_contain_text("ממתין לאישור")
    expect(s.row("פנס ראש")).to_contain_text("0/5 ארזו")
    # my own pledges are marked
    expect(s.row("פחמים")).to_contain_text("⭐ שלי")

    # search (matches titles, notes and category names)
    search = page.get_by_label("חיפוש ברשימות")
    search.fill("מלק")
    expect(page.locator(".ls-row")).to_have_count(1)
    expect(s.row("מלקחיים")).to_be_visible()
    search.fill("קייאק")
    expect(page.get_by_text('לא מצאנו "קייאק"')).to_be_visible()
    page.get_by_role("button", name='להוסיף את "קייאק"').click()
    d = s.sheet("פריט חדש ✨")
    expect(d.get_by_label("מה צריך?")).to_have_value("קייאק")
    s.close_sheet()
    page.get_by_role("button", name="ניקוי החיפוש").click()
    expect(search).to_have_value("")

    # "רק מה שחסר"
    missing = page.get_by_role("button", name="רק מה שחסר")
    missing.click()
    expect(missing).to_have_attribute("aria-pressed", "true")
    expect(s.row("נקניקיות")).to_be_visible()
    expect(s.row("כסאות קמפינג")).to_be_visible()  # partial still needs people
    expect(s.row("סטייק אנטריקוט")).to_have_count(0)
    expect(s.row("פרגיות")).to_have_count(0)
    missing.click()
    expect(s.row("סטייק אנטריקוט")).to_be_visible()

    # type tabs
    s.tab("🎒 מהבית")
    expect(s.row("כסאות קמפינג")).to_be_visible()
    expect(s.row("נקניקיות")).to_have_count(0)
    s.tab("✅ משימות")
    expect(s.row("להזמין כרטיסי כניסה לחוף")).to_be_visible()
    expect(s.row("כסאות קמפינג")).to_have_count(0)
    s.tab("🙋 כל אחד")
    expect(s.row("פנס ראש")).to_be_visible()
    s.tab("🛒 קניות")
    expect(s.row("נקניקיות")).to_be_visible()
    expect(s.row("פנס ראש")).to_have_count(0)
    s.no_hscroll()

    # deep link to an item that isn't there any more
    trip = s.eval_store("return snap.trip.id;")
    page.goto(f"{s.base}index.html?demo=1#/t/{trip}/lists?item=00000000-0000-0000-0000-000000000000")
    s.toast("הפריט הזה כבר לא ברשימה")
    s.assert_clean()


# ---------------------------------------------------------------------------
# §8.4 member: quick pledge, item sheet, stepper, done, unpledge, inventory hint
# ---------------------------------------------------------------------------


def test_member_pledges_and_manages_own_part(member):
    s, page = member, member.page
    s.open_lists()

    # quick action on a missing item; it also completes the meat category → celebration
    s.row("נקניקיות").get_by_role("button", name="אני על זה: נקניקיות").click()
    s.toast("סגור! הקנייה עליך 🛒")
    s.toast("בשר ועוף — הכל מכוסה! 🎉")
    row = s.row("נקניקיות")
    expect(row).to_contain_text("⭐ שלי")
    expect(row).to_contain_text("מכוסה")
    done = row.get_by_role("checkbox", name="קניתי: נקניקיות")
    expect(done).to_have_attribute("aria-checked", "false")
    done.click()
    expect(done).to_have_attribute("aria-checked", "true")
    expect(row).to_contain_text("נקנה ✓")

    # item sheet: bring item with needed 8 (noa 2 + יואב 1 + shira 2)
    d = s.open_item("כסאות קמפינג")
    expect(d).to_contain_text("5 מתוך 8")
    expect(d).to_contain_text("חסרים 3")
    expect(d).to_contain_text("⭐ זה עליך")
    expect(d.locator(".ls-pledge")).to_have_count(3)
    expect(d.locator(".ls-pledge").filter(has_text="נועה ואיתי")).to_contain_text("×2")
    # members never see admin tools
    expect(d.get_by_text("שיבוץ חבר/ה")).to_have_count(0)
    expect(d.get_by_role("button", name="עריכה")).to_have_count(0)
    expect(d.get_by_role("button", name="מחיקה")).to_have_count(0)
    expect(d.get_by_role("button", name=re.compile("^הסרת "))).to_have_count(0)

    # my qty Stepper → update
    d.get_by_role("group", name="כמה אני מביא/ה").get_by_role("button", name="עוד").click()
    d.get_by_role("button", name="עדכון").click()
    s.toast("הכמות עודכנה ✓")
    expect(d).to_contain_text("6 מתוך 8")
    expect(d.locator(".ls-pledge").filter(has_text="יואב")).to_contain_text("×2")

    # packed toggle
    packed = d.get_by_role("switch", name="ארזתי ✓")
    packed.click()
    expect(packed).to_have_attribute("aria-checked", "true")
    expect(d.locator(".ls-pledge").filter(has_text="יואב")).to_contain_text("ארוז ✓")

    # unpledge (confirm) → back to the pledge button
    d.get_by_role("button", name="לא מביא/ה בסוף").click()
    s.confirm("כן, לוותר")
    s.toast("הורדנו אותך מהפריט")
    expect(d).to_contain_text("4 מתוך 8")
    expect(d.get_by_role("button", name="אני מביא/ה 🎒")).to_be_visible()
    s.close_sheet()

    # "💡 למי יש בבית?" — שירה וטל have a מחצלת at home; members get a WhatsApp nudge, not "שיבוץ"
    d = s.open_item("מחצלות")
    inv = d.locator(".ls-inventory")
    expect(inv).to_contain_text("💡 למי יש בבית?")
    expect(inv).to_contain_text("שירה וטל")
    expect(inv).to_contain_text("יש בבית: מחצלת")
    expect(inv.get_by_role("button", name="שיבוץ")).to_have_count(0)
    wa = inv.get_by_role("link", name="לבקש משירה וטל בוואטסאפ")
    expect(wa).to_have_attribute("href", re.compile(r"^https://wa\.me/"))
    # pledge 2 of 2 from the sheet
    d.get_by_role("button", name="אני מביא/ה 🎒").click()
    s.toast("מעולה! רשמנו שאת/ה מביא/ה 🎒")
    expect(d).to_contain_text("2 מתוך 2")
    expect(d.locator(".ls-inventory")).to_have_count(0)  # covered → no more hint
    s.close_sheet()
    expect(s.row("מחצלות")).to_contain_text("מכוסה")
    s.assert_clean()


# ---------------------------------------------------------------------------
# §8.4 add item — member proposal, then an admin approves it
# ---------------------------------------------------------------------------


def test_member_proposes_item_and_admin_approves(member):
    s, page = member, member.page
    s.open_lists()
    page.locator(".fab").click()
    d = s.sheet("הצעת פריט ✨")
    expect(d.get_by_text("ההצעה תישלח לאישור מנהל")).to_be_visible()

    # validation
    d.get_by_role("button", name="שליחת הצעה").click()
    expect(d.get_by_text("איך קוראים לזה? 🙂")).to_be_visible()

    d.get_by_label("מה צריך?").fill("קרח")
    d.get_by_role("tab", name="🛒 לקנות").click()
    d.get_by_label("כמות").fill("2")
    press_on(d.get_by_role("group", name="יחידה").get_by_role("button", name="חבילות"))
    press_on(d.get_by_role("group", name="קטגוריה").get_by_role("button", name=re.compile("שתייה ואלכוהול")))
    d.get_by_role("switch", name="✋ אני קונה את זה").click()
    d.get_by_role("button", name="שליחת הצעה").click()
    s.toast("ההצעה נשלחה למנהלים ⏳")
    expect(page.get_by_role("dialog")).to_have_count(0)

    row = s.row("קרח")
    expect(row).to_contain_text("ממתין לאישור")
    expect(row).to_contain_text("⭐ שלי")
    expect(row.locator(".ls-qty")).to_have_text("2 חבילות")
    expect(page.locator(".ls-cat").filter(has_text="שתייה ואלכוהול")).to_contain_text("קרח")
    expect(page.get_by_role("tab", name=re.compile("לאישור"))).to_contain_text("3")

    # the member's pending tab has no approve buttons
    s.tab("⏳ לאישור")
    expect(page.get_by_text("הצעות שמחכות לאישור של מנהל/ת הטיול")).to_be_visible()
    expect(page.locator(".ls-approve")).to_have_count(0)

    # the owner approves it inline
    s.act_as("נועה ואיתי")
    expect(page.get_by_text("הצעות של החבר'ה")).to_be_visible()
    page.get_by_role("button", name="אישור: קרח").click()
    s.toast("אושר ✅ קרח ברשימה")
    expect(s.row("קרח")).to_have_count(0)
    expect(page.get_by_role("tab", name=re.compile("לאישור"))).to_contain_text("2")
    s.tab("הכל")
    expect(s.row("קרח")).to_contain_text("מכוסה")
    s.assert_clean()


# ---------------------------------------------------------------------------
# §8.4 admin: reject with reason, inventory assign, MemberPicker assign, edit, delete
# ---------------------------------------------------------------------------


def test_admin_reviews_assigns_edits_and_deletes(owner):
    s, page = owner, owner.page
    s.open_lists()
    s.tab("⏳ לאישור")

    # reject a proposal with a reason
    d = s.open_item("מרשמלו למדורה")
    expect(d).to_contain_text("ממתין לאישור מנהל")
    d.get_by_role("button", name="דחייה").first.click()
    d = s.sheet('דחיית "מרשמלו למדורה"')
    d.get_by_label("סיבת הדחייה").fill("יש כבר מספיק מתוקים 🙂")
    d.get_by_role("button", name="דחיית ההצעה").click()
    s.toast("ההצעה נדחתה")
    d = s.sheet("מרשמלו למדורה")
    expect(d).to_contain_text("ההצעה נדחתה")
    expect(d).to_contain_text("יש כבר מספיק מתוקים 🙂")
    s.close_sheet()
    rejected = page.locator(".ls-rejected")
    expect(rejected.locator(".section__count")).to_have_text("2")

    # approve the last one → pending tab empty state
    page.get_by_role("button", name="אישור: כנפיים").click()
    s.toast("אושר ✅ כנפיים ברשימה")
    expect(page.get_by_text("אין הצעות שמחכות")).to_be_visible()

    s.tab("הכל")
    d = s.open_item("מחצלות")
    expect(d).to_contain_text("0 מתוך 2")
    # "💡 למי יש בבית?" → one-tap assign for admins
    inv = d.locator(".ls-inventory")
    inv.locator(".ls-inv-row").filter(has_text="שירה וטל").get_by_role("button", name="שיבוץ").click()
    s.toast("שובץ לשירה וטל 👍")
    expect(d).to_contain_text("1 מתוך 2")
    expect(d.locator(".ls-pledge").filter(has_text="שירה וטל")).to_contain_text("שובץ/ה ע״י נועה ואיתי")

    # admin assign: MemberPicker + qty
    d.get_by_text("שיבוץ חבר/ה").click()
    d.get_by_role("group", name="למי לשבץ").get_by_role("button", name=re.compile("יואב")).click()
    d.get_by_role("button", name="שיבוץ ליואב").click()
    s.toast("שובץ ליואב 👍")
    expect(d).to_contain_text("2 מתוך 2")
    expect(d).to_contain_text("מכוסה 🎉")

    # remove a pledger (admin ✕ → confirm)
    d.get_by_role("button", name="הסרת יואב מהפריט").click()
    s.confirm("הסרה")
    s.toast("הוסר מהפריט")
    expect(d).to_contain_text("1 מתוך 2")

    # edit
    d.get_by_role("button", name="עריכה").click()
    e = s.sheet("עריכת פריט")
    e.get_by_label("מה צריך?").fill("מחצלות גדולות")
    e.get_by_role("button", name="שמירה").click()
    s.toast("נשמר ✓")
    d = s.sheet("מחצלות גדולות")

    # delete (confirmDialog)
    d.get_by_role("button", name="מחיקה").click()
    s.confirm("מחיקה")
    s.toast("הפריט נמחק")
    expect(page.get_by_role("dialog")).to_have_count(0)
    expect(s.row("מחצלות גדולות")).to_have_count(0)
    s.assert_clean()


# ---------------------------------------------------------------------------
# §8.4 add item as admin: per-person math, bring "needed", self pledge
# ---------------------------------------------------------------------------


def test_admin_adds_per_person_and_bring_items(owner):
    s, page = owner, owner.page
    s.open_lists()
    math = s.per_person_math(8, "יח׳")

    page.locator(".fab").click()
    d = s.sheet("פריט חדש ✨")
    expect(d.get_by_text("ההצעה תישלח לאישור מנהל")).to_have_count(0)
    d.get_by_label("מה צריך?").fill("קבבים")
    d.get_by_role("tab", name="🛒 לקנות").click()
    d.get_by_label("כמות").fill("8")
    press_on(d.get_by_role("group", name="יחידה").get_by_role("button", name="יח׳"))
    d.get_by_role("switch", name="לאדם").click()
    expect(d.get_by_text(f"{math['one']} × {math['heads']} אנשים = {math['eff']}")).to_be_visible()
    press_on(d.get_by_role("group", name="קטגוריה").get_by_role("button", name=re.compile("בשר ועוף")))
    d.get_by_role("button", name="הוספה לרשימה").click()
    s.toast("נוסף לרשימה ✨")

    row = s.row("קבבים")
    expect(row.locator(".ls-qty")).to_have_text(math["eff"])
    expect(page.locator(".ls-cat").filter(has_text="בשר ועוף")).to_contain_text("קבבים")
    d = s.open_item("קבבים")
    expect(d.locator(".ls-qtybox__formula")).to_have_text(f"{math['one']} לאדם × {math['heads']} אנשים = {math['eff']}")
    expect(d.get_by_role("button", name="אני קונה 🛒")).to_be_visible()
    s.close_sheet()

    # a bring item: needed 3, I bring 1 of them
    page.locator(".fab").click()
    d = s.sheet("פריט חדש ✨")
    d.get_by_role("tab", name="🎒 מהבית").click()
    d.get_by_label("מה צריך?").fill("ערסל")
    more = d.get_by_role("group", name="כמה צריך").get_by_role("button", name="עוד")
    more.click()
    more.click()
    d.get_by_role("switch", name="✋ אני מביא/ה את זה").click()
    mine = d.get_by_role("group", name="כמה אני מביא/ה")
    expect(mine.locator("output")).to_have_text("3")
    mine.get_by_role("button", name="פחות").click()
    mine.get_by_role("button", name="פחות").click()
    d.get_by_role("button", name="הוספה לרשימה").click()
    s.toast("נוסף לרשימה ✨")
    row = s.row("ערסל")
    expect(row.locator(".ls-qty")).to_have_text("×3")
    expect(row).to_contain_text("חלקי 1/3")
    expect(row).to_contain_text("⭐ שלי")
    s.assert_clean()


# ---------------------------------------------------------------------------
# §8.4 "⭐ שלי": private personal gear + my agenda
# ---------------------------------------------------------------------------


def test_mine_tab_personal_gear_and_agenda(owner):
    s, page = owner, owner.page
    s.open_lists()
    s.tab("⭐ שלי")

    gear = page.locator(".ls-personal")
    expect(gear).to_contain_text("הציוד האישי שלי")
    expect(gear).to_contain_text("רק את/ה רואה את הרשימה הזו")
    count = gear.locator(".section__count")
    expect(count).to_have_text("2/5")
    towel = gear.get_by_role("checkbox", name="ארזתי: מגבת")
    towel.click()
    expect(towel).to_have_attribute("aria-checked", "true")
    expect(count).to_have_text("3/5")

    add = gear.get_by_label("פריט חדש לציוד האישי")
    add.fill("כובע")
    add.press("Enter")
    expect(gear.get_by_role("checkbox", name="ארזתי: כובע")).to_be_visible()
    expect(count).to_have_text("3/6")
    expect(add).to_have_value("")
    gear.get_by_role("button", name="הסרה: כובע").click()
    expect(gear.get_by_role("checkbox", name="ארזתי: כובע")).to_have_count(0)
    expect(count).to_have_text("3/5")
    gear.get_by_role("button", name="השלמה מהרשימה המוכנה").click()
    s.toast(re.compile(r"נוספו \d+ פריטים לציוד האישי|כבר אצלך"))

    # my agenda: what I bring / buy / do / each
    expect(page.get_by_text("מה עליי לטיול")).to_be_visible()
    bring = page.locator(".section").filter(has=page.locator(".section__text", has_text=exact("מביא/ה מהבית")))
    expect(bring).to_contain_text("מנגל עם רשת")
    expect(bring).to_contain_text("כסאות קמפינג")
    buy = page.locator(".section").filter(has=page.locator(".section__text", has_text=exact("קונה")))
    expect(buy).to_contain_text("פחמים")
    each = page.locator(".section").filter(has=page.locator(".section__text", has_text=exact("כל אחד מביא")))
    lamp = each.get_by_role("checkbox", name="ארזתי את שלי: פנס ראש")
    lamp.click()
    expect(lamp).to_have_attribute("aria-checked", "true")
    expect(s.row("פנס ראש")).to_contain_text("1/5 ארזו")

    # a member with no personal list yet gets the template button (and never sees the owner's list)
    s.act_as("שירה וטל")
    gear = page.locator(".ls-personal")
    expect(gear.get_by_role("checkbox", name="ארזתי: מגבת")).to_have_count(0)
    gear.get_by_role("button", name="להוסיף רשימת ציוד מוכנה").click()
    s.toast(re.compile(r"נוספו \d+ פריטים לציוד האישי"))
    expect(gear.get_by_role("checkbox").first).to_be_visible()
    s.assert_clean()


# ---------------------------------------------------------------------------
# §8.5 shopping mode
# ---------------------------------------------------------------------------


def test_shopping_mode_owner_buys_and_records_receipt(owner):
    s, page = owner, owner.page
    s.open_lists()
    page.get_by_role("link", name="מצב קנייה").click()
    expect(page.get_by_role("heading", name="🛒 מצב קנייה")).to_be_visible()
    me_chip = page.locator(".shop-buyers").get_by_role("button", name=re.compile(r"^אני"))
    expect(me_chip).to_have_attribute("aria-pressed", "true")
    expect(page.locator(".shop-head__sub")).to_have_text("טיול לדוגמה בכנרת 🌊")  # the name already has the emoji
    progress = page.locator(".shop-progress")
    expect(progress).to_contain_text("0 מתוך 2 בעגלה")

    coals = page.get_by_role("checkbox", name=re.compile("פחמים"))
    coals.click()
    expect(coals).to_have_attribute("aria-checked", "true")
    expect(progress).to_contain_text("1 מתוך 2 בעגלה")

    # Maya's list (admins may tick it): a ticked row moves below the open ones
    page.locator(".shop-buyers").get_by_role("button", name=re.compile("מאיה ורון")).click()
    meat = page.locator(".shop-group").filter(has_text="בשר ועוף")
    expect(meat.locator(".shop-row").first).to_contain_text("סטייק אנטריקוט")
    meat.get_by_role("checkbox", name=re.compile("סטייק אנטריקוט")).click()
    expect(meat.get_by_role("checkbox", name=re.compile("סטייק אנטריקוט"))).to_have_attribute("aria-checked", "true")
    expect(meat.locator(".shop-row").first).to_contain_text("נקניקיות", timeout=4000)
    expect(meat.locator(".shop-row").last).to_contain_text(re.compile("פרגיות|סטייק"))

    # back to my list and finish → expense sheet prefilled
    me_chip.click()
    page.get_by_role("button", name=re.compile("סיימתי!")).click()
    d = s.sheet("הקבלה 🧾")
    expect(d.get_by_label("על מה")).to_have_value("קניות — מנגל ובישול")
    d.get_by_role("button", name="שמירת ההוצאה").click()
    expect(d.get_by_text("כמה יצא? 🙂")).to_be_visible()
    d.get_by_label("כמה יצא?").fill("120")
    expect(d.locator(".shop-split-preview")).to_contain_text("לאדם")
    expect(d.locator(".member-picker")).to_be_visible()  # admins may pick the payer
    d.get_by_role("button", name="שמירת ההוצאה").click()
    s.toast("הקבלה נשמרה")
    expect(page.get_by_role("dialog")).to_have_count(0)

    # own back button → lists (shopping tab)
    page.get_by_role("link", name="חזרה לרשימות").click()
    expect(page.get_by_role("tab", name="🛒 קניות")).to_have_attribute("aria-selected", "true")
    expect(s.row("פחמים")).to_contain_text("נקנה ✓")
    page.locator(".bottom-nav [data-tab=money]").click()
    expect(page.get_by_text("קניות — מנגל ובישול").first).to_be_visible()
    s.assert_clean()


def test_shopping_mode_member_view(member):
    s, page = member, member.page
    s.open_lists()
    page.get_by_role("link", name="מצב קנייה").click()
    expect(page.get_by_role("heading", name="🛒 מצב קנייה")).to_be_visible()
    progress = page.locator(".shop-progress")
    expect(progress).to_contain_text("1 מתוך 4 בעגלה")  # מים, בירות, יין + חטיפים (already bought)
    wine = page.get_by_role("checkbox", name=re.compile("יין לבן מבעבע"))
    expect(wine).to_contain_text("עוד בלי קונה")  # default buyer of 🥤, nobody pledged yet
    wine.click()
    expect(wine).to_have_attribute("aria-checked", "true")
    expect(progress).to_contain_text("2 מתוך 4 בעגלה")

    # someone else's list is read-only for members
    page.locator(".shop-buyers").get_by_role("button", name=re.compile("מאיה ורון")).click()
    expect(page.get_by_text("זו הרשימה של מאיה ורון — רק לצפייה")).to_be_visible()
    steak = page.get_by_role("checkbox", name=re.compile("סטייק אנטריקוט"))
    expect(steak).to_have_attribute("aria-disabled", "true")
    steak.click(force=True)  # a real tap on a read-only row explains why nothing happens
    s.toast("רק מאיה ורון (או מנהל/ת) מסמנים את זה")
    expect(steak).to_have_attribute("aria-checked", "false")

    # unassigned items: take one by ticking it
    page.locator(".shop-buyers").get_by_role("button", name=re.compile("לא משובץ")).click()
    eggs = page.get_by_role("checkbox", name=re.compile("ביצים"))
    eggs.click()
    expect(eggs).to_have_attribute("aria-checked", "true")

    # receipt as a member: payer is me, no picker
    page.get_by_role("button", name=re.compile("סיימתי!")).click()
    d = s.sheet("הקבלה 🧾")
    expect(d).to_contain_text("שולם ע״י: את/ה")
    expect(d.locator(".member-picker")).to_have_count(0)
    s.close_sheet()
    page.get_by_role("link", name="חזרה לרשימות").click()
    expect(s.row("ביצים")).to_contain_text("⭐ שלי")
    s.assert_clean()


# ---------------------------------------------------------------------------
# §8.6 import
# ---------------------------------------------------------------------------


def test_import_owner_preview_edit_and_bulk_add(owner):
    s, page = owner, owner.page
    s.open_lists()
    page.get_by_role("button", name="עוד אפשרויות").click()
    menu = s.sheet("עוד אפשרויות")
    expect(menu.get_by_role("link", name=re.compile("שתף מה חסר"))).to_have_attribute("href", re.compile(r"wa\.me"))
    menu.get_by_role("button", name=re.compile("ייבוא רשימה מוואטסאפ")).click()
    expect(page.get_by_role("heading", name=re.compile("ייבוא רשימה"))).to_be_visible()
    expect(page.get_by_text("איך זה עובד?")).to_be_visible()

    parsed = page.evaluate(
        f"async (t) => {{ const L = await import({LOGIC_JS}); return L.parseListText(t).map((r) => r.title); }}",
        IMPORT_TEXT,
    )
    page.get_by_label("הדביקו כאן רשימה מוואטסאפ").fill(IMPORT_TEXT)
    expect(page.locator(".imp-summary")).to_contain_text(f"{len(parsed)} פריטים")
    rows = page.locator(".imp-row")
    expect(rows).to_have_count(len(parsed))
    for title in parsed:
        expect(page.locator(".imp-row__name", has_text=exact(title))).to_have_count(1)

    def imp_row(title):
        return rows.filter(has=page.locator(".imp-row__name", has_text=exact(title)))

    # an item that already exists is flagged and left out by default
    dup = imp_row("פרגיות")
    expect(dup).to_contain_text("כבר ברשימה")
    expect(dup.get_by_role("checkbox")).to_have_attribute("aria-checked", "false")
    n = len(parsed) - 1
    submit = page.locator(".imp-footer").get_by_role("button")
    expect(submit).to_have_text(f"ייבוא {n} פריטים")

    # per-row include
    imp_row("צידנית גדולה").get_by_role("checkbox").click()
    expect(submit).to_have_text(f"ייבוא {n - 1} פריטים")

    # bring qty → needed; category edit via chips
    lamps = imp_row("פנסים")
    expect(lamps).to_contain_text("צריך 3")
    expect(lamps.get_by_role("radio", name="מהבית")).to_have_attribute("aria-checked", "true")
    lamps.locator(".imp-cat").click()
    picker = s.sheet('קטגוריה ל"פנסים"')
    picker.get_by_role("button", name=re.compile("ציוד קבוצתי")).click()
    expect(page.get_by_role("dialog")).to_have_count(0)
    expect(lamps.locator(".imp-cat")).to_contain_text("ציוד קבוצתי")

    # type edit
    soda = imp_row("סודה")
    soda.get_by_role("radio", name="כל אחד").click()
    expect(soda.get_by_role("radio", name="כל אחד")).to_have_attribute("aria-checked", "true")
    soda.get_by_role("radio", name="קנייה").click()

    submit.click()
    s.toast(f"נוספו {n - 1} פריטים לרשימה 🎉")
    expect(page.locator(".ls-head__title")).to_have_text("רשימות")
    lamps_row = s.row("פנסים")
    expect(lamps_row.locator(".ls-qty")).to_have_text("×3")
    expect(page.locator(".ls-cat").filter(has_text="ציוד קבוצתי")).to_contain_text("פנסים")
    expect(s.row("סודה").locator(".ls-qty")).to_have_text("2 שישיות")
    expect(s.row("צידנית גדולה")).to_have_count(0)
    s.assert_clean()


def test_import_member_sends_proposals(member):
    s, page = member, member.page
    s.open_lists()
    page.get_by_role("button", name="עוד אפשרויות").click()
    s.sheet("עוד אפשרויות").get_by_role("button", name=re.compile("ייבוא רשימה מוואטסאפ")).click()
    page.get_by_role("button", name="לנסות עם דוגמה").click()
    expect(page.get_by_text("הפריטים יישלחו לאישור מנהל")).to_be_visible()
    submit = page.locator(".imp-footer").get_by_role("button")
    expect(submit).to_have_text(re.compile(r"^שליחת \d+ הצעות$"))
    n = int(re.search(r"\d+", submit.inner_text()).group())
    submit.click()
    s.toast(f"{n} הצעות נשלחו לאישור ⏳")
    expect(page.get_by_role("tab", name=re.compile("לאישור"))).to_have_attribute("aria-selected", "true")
    expect(page.get_by_role("tab", name=re.compile("לאישור"))).to_contain_text(str(n + 2))
    s.assert_clean()


# ---------------------------------------------------------------------------
# duplicates: "🔁 כבר ברשימה?" while adding, in the import and in the approval queue
# ---------------------------------------------------------------------------


def test_add_item_warns_about_duplicates(owner):
    s, page = owner, owner.page
    s.open_lists()
    before = s.eval_store("return snap.items.length;")
    page.locator(".fab").click()
    sheet = s.sheet("פריט חדש ✨")
    title = sheet.get_by_placeholder("למשל: פחמים, כסאות, מטקות…")
    notice = sheet.get_by_test_id("dup-notice")

    # nothing alike → no notice
    title.fill("שמן זית")
    expect(notice).to_have_count(0)

    # "פחם" is the seed's "פחמים" → warned, and adding asks first
    title.fill("פחם")
    expect(notice).to_contain_text("זה כבר ברשימה")
    expect(notice.get_by_role("button", name="לפתוח את פחמים")).to_contain_text("מכוסה")
    sheet.get_by_role("button", name="הוספה לרשימה").click()
    dlg = page.get_by_role("alertdialog")
    expect(dlg).to_contain_text('"פחמים" כבר ברשימה')
    s.confirm("חזרה")
    expect(sheet).to_be_visible()
    assert s.eval_store("return snap.items.length;") == before

    # a look-alike ("כסאות" ~ "כסאות קמפינג") is only a hint — adding goes straight through
    title.fill("כסאות")
    expect(notice).to_contain_text("אולי זה כבר ברשימה?")
    expect(notice).to_contain_text("כסאות קמפינג")
    sheet.get_by_role("button", name="הוספה לרשימה").click()
    s.toast("נוסף לרשימה")
    assert s.eval_store("return snap.items.length;") == before + 1

    # tapping the existing item opens it instead of adding a copy
    page.locator(".fab").click()
    sheet = s.sheet("פריט חדש ✨")
    sheet.get_by_placeholder("למשל: פחמים, כסאות, מטקות…").fill("נקניקייה")
    sheet.get_by_test_id("dup-notice").get_by_role("button", name="לפתוח את נקניקיות").click()
    s.sheet("נקניקיות")
    expect(page).to_have_url(re.compile(r"item="))
    s.assert_clean()


def test_import_flags_existing_lookalike_and_pasted_twice(owner):
    s, page = owner, owner.page
    s.open_lists()
    page.get_by_role("button", name="עוד אפשרויות").click()
    s.sheet("עוד אפשרויות").get_by_role("button", name=re.compile("ייבוא רשימה מוואטסאפ")).click()
    page.get_by_label("הדביקו כאן רשימה מוואטסאפ").fill("פחם\nכסאות\nשמן זית\nשמן זית\nמטקה")
    rows = page.locator(".imp-row")
    expect(rows).to_have_count(5)

    def row(title, nth=0):
        return rows.filter(has=page.locator(".imp-row__name", has_text=exact(title))).nth(nth)

    def checked(r):
        return r.get_by_role("checkbox").get_attribute("aria-checked")

    expect(row("פחם")).to_contain_text("כבר ברשימה")                  # פחמים
    expect(row("כסאות")).to_contain_text("דומה ל: כסאות קמפינג")
    expect(row("מטקה")).to_contain_text("כבר ברשימה")                 # מטקות
    olive = rows.filter(has=page.locator(".imp-row__name", has_text=exact("שמן זית")))
    expect(olive).to_have_count(2)
    expect(olive.filter(has_text="מופיע פעמיים ברשימה")).to_have_count(1)
    expect(olive.locator(".pill")).to_have_count(1)
    # same → left out; a look-alike stays in (only flagged) so nothing needed is dropped silently
    assert [checked(row(t)) for t in ("פחם", "כסאות", "מטקה")] == ["false", "true", "false"]
    assert sorted(checked(olive.nth(i)) for i in range(2)) == ["false", "true"]
    expect(page.get_by_text("לא סומנו, כדי שלא יגיעו פעמיים")).to_be_visible()
    expect(page.get_by_text("כדאי לבדוק שזה לא אותו דבר")).to_be_visible()
    s.assert_clean()


def test_admin_sees_lookalike_proposal(owner):
    s, page = owner, owner.page
    owner_name = s.eval_store("return snap.members.find((m) => m.id === snap.me.member_id).display_name;")
    s.act_as("יואב")
    s.eval_store("await api.addItem(snap.trip.id, { title: 'פחם למנגל', type: 'buy' }); await m.actions.refresh();")
    s.act_as(owner_name)
    s.open_lists()
    s.tab("לאישור")
    row = page.locator(".ls-row", has=page.locator(".ls-row__name", has_text=exact("פחם למנגל")))
    expect(row.locator(".ls-dup-pill")).to_have_text("🔁 דומה ל: פחמים")
    # an unrelated proposal is not flagged
    expect(page.locator(".ls-row", has=page.locator(".ls-row__name", has_text=exact("כנפיים"))).locator(".ls-dup-pill")).to_have_count(0)
    row.locator(".ls-row__open").click()
    banner = s.sheet("פחם למנגל").get_by_test_id("dup-banner")
    expect(banner).to_contain_text("דומה לפריט שכבר ברשימה")
    banner.get_by_role("button", name="פחמים").click()
    s.sheet("פחמים")
    page.keyboard.press("Escape")  # back to the proposal it came from
    s.sheet("פחם למנגל")
    s.close_sheet()
    # the home screen's approvals card flags it too
    page.locator(".bottom-nav [data-tab=home]").click()
    approve = page.locator(".approve-row", has_text="פחם למנגל")
    expect(approve.locator(".approve-row__dup")).to_have_text("🔁 דומה ל: פחמים")
    s.assert_clean()


# ---------------------------------------------------------------------------
# screenshots: light + dark at 390, light at 360; no horizontal scroll anywhere
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("scheme", "viewport", "tag"),
    [("light", PHONE, "light-390"), ("dark", PHONE, "dark-390"), ("light", SMALL, "light-360")],
    ids=["light-390", "dark-390", "light-360"],
)
def test_screens_render_without_overflow(lists_edge, lists_server, scheme, viewport, tag):
    s = Session(lists_edge, lists_server, scheme=scheme, viewport=viewport)
    page = s.page
    try:
        s.boot()
        s.open_lists()
        s.no_hscroll()
        s.shot(f"lists-{tag}")

        s.open_item("כסאות קמפינג")
        s.shot(f"item-sheet-{tag}")
        s.close_sheet()

        page.locator(".fab").click()
        d = s.sheet("פריט חדש ✨")
        d.get_by_label("מה צריך?").fill("קבבים")
        d.get_by_role("tab", name="🛒 לקנות").click()
        d.get_by_label("כמות").fill("8")
        d.get_by_role("switch", name="לאדם").click()
        assert d.locator(".ls-type-seg").evaluate("e => e.scrollWidth <= e.clientWidth + 1"), "item types don't fit"
        s.no_hscroll()
        s.shot(f"add-sheet-{tag}")
        s.close_sheet()

        s.tab("⭐ שלי")
        s.no_hscroll()
        s.shot(f"mine-{tag}")

        s.tab("⏳ לאישור")
        s.no_hscroll()
        s.shot(f"pending-{tag}")

        page.get_by_role("link", name="מצב קנייה").click()
        expect(page.get_by_role("heading", name="🛒 מצב קנייה")).to_be_visible()
        page.get_by_role("checkbox", name=re.compile("פחמים")).click()
        s.no_hscroll()
        s.shot(f"shop-{tag}")

        page.get_by_role("link", name="חזרה לרשימות").click()
        page.get_by_role("button", name="עוד אפשרויות").click()
        s.sheet("עוד אפשרויות").get_by_role("button", name=re.compile("ייבוא רשימה מוואטסאפ")).click()
        page.get_by_label("הדביקו כאן רשימה מוואטסאפ").fill(IMPORT_TEXT)
        expect(page.locator(".imp-row").first).to_be_visible()
        page.locator(".imp-summary").scroll_into_view_if_needed()
        s.no_hscroll()
        s.shot(f"import-{tag}")
        s.assert_clean()
    finally:
        s.close()
