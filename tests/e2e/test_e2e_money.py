"""Money screen E2E (SPEC §8.7) — the real app in demo mode, driven through the UI.

Runs in Microsoft Edge (Playwright channel "msedge", falling back to "chrome") at a phone
viewport (390x844, touch). Every test uses a fresh browser context, so the demo backend
re-seeds "טיול לדוגמה בכנרת 🌊" for it. page.evaluate is only used for setup (actAs,
createTrip) and to read the expected numbers straight from js/lib/logic.js.

Screenshots land in tests/e2e/artifacts/money/.

    .venv\\Scripts\\python.exe -m pytest tests/e2e/test_money.py -q
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

ART = ROOT / "tests" / "e2e" / "artifacts" / "money"
PHONE = {"width": 390, "height": 844}
SMALL = {"width": 360, "height": 780}
IGNORED_ERROR_HOSTS = ("fonts.googleapis.com", "fonts.gstatic.com")

STORE_JS = "new URL('js/store.js', location.href).href"
LOGIC_JS = "new URL('js/lib/logic.js', location.href).href"

# Everything the screen should show, computed by logic.js from the live snapshot.
EXPECTED_JS = f"""async () => {{
  const S = await import({STORE_JS});
  const L = await import({LOGIC_JS});
  const snap = S.store.get().snap;
  const me = snap.me.member_id;
  const byId = L.membersById(snap.members);
  const nm = (id) => (id === me ? 'את/ה' : L.displayName(byId.get(id)));
  const bals = L.balances(snap);
  const plan = L.settlePlan(bals);
  const totals = L.tripTotals(snap);
  const mine = bals.find((b) => b.member_id === me);
  const signed = (n) => (n >= 0.005 ? '+' : '') + L.formatMoney(n);
  return {{
    total: L.formatMoney(totals.spent),
    perHead: L.formatMoney(totals.perHead),
    heads: String(totals.heads),
    balance: mine.balance,
    balanceText: L.formatMoney(Math.abs(mine.balance)),
    plan: plan.map((t) => ({{
      from: nm(t.from), to: nm(t.to), amount: L.formatMoney(t.amount),
      rank: t.from === me ? 0 : t.to === me ? 1 : 2,
    }})),
    rows: bals.map((b) => ({{ id: b.member_id, paid: L.formatMoney(b.paid), owed: L.formatMoney(b.owed), balance: signed(b.balance) }})),
    expenses: snap.expenses.length,
    payments: snap.payments.length,
  }};
}}"""


# ---------------------------------------------------------------------------
# fixtures & helpers
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def money_server():
    srv, base = start_server()
    yield base
    srv.shutdown()


@pytest.fixture(scope="module")
def money_edge():
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

    def boot(self, hash_=""):
        self.page.goto(f"{self.base}index.html?demo=1{hash_}")
        self.page.wait_for_selector(".bottom-nav", timeout=15000)
        self.page.evaluate(f"import({STORE_JS}).then((m) => {{ window.__testStore = m.store; }})")
        self.page.wait_for_function("!!window.__testStore.get().snap", timeout=15000)

    def eval_store(self, body):
        """Run `body` (JS statements) with m = store module, st = store.get(), api, snap."""
        return self.page.evaluate(
            f"async () => {{ const m = await import({STORE_JS}); const st = m.store.get();"
            f" const api = st.api; const snap = st.snap; {body} }}"
        )

    def trip_id(self):
        return self.eval_store("return snap.trip.id;")

    def act_as(self, display_name):
        """Demo only: re-link this browser's user to another member of the trip, then refresh."""
        self.eval_store(
            f"const t = snap.members.find((x) => x.display_name === {display_name!r});"
            " await api.demo.actAs(t.id); await m.actions.refresh();"
        )

    def open_money(self):
        self.page.locator(".bottom-nav [data-tab=money]").click()
        expect(self.page.get_by_test_id("money-hero")).to_be_visible()

    def expected(self):
        return self.page.evaluate(EXPECTED_JS)

    def shot(self, name, full_page=False):
        self.page.evaluate("document.fonts.ready")
        self.page.wait_for_timeout(800)  # count-up + entrance animations
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


def assert_matches_logic(s: Session):
    """Every number on the screen equals what logic.js computes from the current snapshot."""
    page = s.page
    exp = s.expected()
    expect(page.get_by_test_id("money-total")).to_have_text(exp["total"])
    expect(page.get_by_test_id("money-per-head")).to_have_text(exp["perHead"])
    expect(page.get_by_test_id("money-heads")).to_have_text(exp["heads"])

    b = exp["balance"]
    state = "credit" if b >= 1 else "debt" if b <= -1 else "even"
    expect(page.get_by_test_id("money-hero")).to_have_attribute("data-state", state)
    label = page.get_by_test_id("money-balance-label")
    if state == "even":
        expect(label).to_have_text("את/ה מאוזנ/ת ✨")
    else:
        expect(label).to_have_text("מגיע לך" if state == "credit" else "עליך להעביר")
        expect(page.get_by_test_id("money-balance-amount")).to_have_text(exp["balanceText"])

    plan = sorted(exp["plan"], key=lambda t: t["rank"])  # stable: mine first, then plan order
    rows = page.get_by_test_id("settle-row")
    expect(rows).to_have_count(len(plan))
    for i, t in enumerate(plan):
        row = rows.nth(i)
        expect(row.locator(".settle-row__amount")).to_have_text(t["amount"])
        expect(row.locator(".settle-row__who")).to_contain_text(t["from"])
        expect(row.locator(".settle-row__who")).to_contain_text(t["to"])
    if not plan:
        expect(page.get_by_test_id("settle-empty")).to_contain_text("כולם מאוזנים")

    for r in exp["rows"]:
        tr = page.locator(f'[data-testid=member-balance-row][data-member-id="{r["id"]}"]')
        expect(tr.locator("td[data-col=paid]")).to_have_text(r["paid"])
        expect(tr.locator("td[data-col=owed]")).to_have_text(r["owed"])
        expect(tr.locator("td[data-col=balance]")).to_have_text(r["balance"])

    expect(page.get_by_test_id("expense-row")).to_have_count(exp["expenses"])
    expect(page.get_by_test_id("payment-row")).to_have_count(exp["payments"])
    return exp


@pytest.fixture
def owner(money_edge, money_server):
    s = Session(money_edge, money_server)
    s.boot()
    yield s
    s.close()


# ---------------------------------------------------------------------------
# seed numbers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("scheme", "viewport"), [("light", PHONE), ("dark", SMALL)], ids=["light-390", "dark-360"])
def test_seed_numbers_match_logic(money_edge, money_server, scheme, viewport):
    s = Session(money_edge, money_server, scheme=scheme, viewport=viewport)
    try:
        s.boot()
        s.open_money()
        page = s.page
        exp = assert_matches_logic(s)

        # The demo seed, worked out by hand (5 units, 8 heads, 3 expenses, 2 payments).
        assert (exp["total"], exp["perHead"], exp["heads"]) == ("₪940", "₪117.50", "8")
        assert exp["balanceText"] == "₪152.50" and exp["balance"] < 0
        expect(page.get_by_test_id("money-balance-label")).to_have_text("עליך להעביר")
        expect(page.get_by_test_id("money-breakdown")).to_contain_text("החלק שלך ₪242.50")
        expect(page.get_by_test_id("money-breakdown")).to_contain_text("שילמת ₪90")
        amounts = page.locator("[data-testid=settle-row] .settle-row__amount").all_inner_texts()
        assert amounts == ["₪153", "₪95", "₪11", "₪3"]
        first = page.get_by_test_id("settle-row").first
        expect(first.locator(".settle-row__who")).to_contain_text("את/ה")
        expect(first.locator(".settle-row__who")).to_contain_text("מאיה ורון")
        expect(first).to_contain_text("ההעברה שלך")
        expect(page.get_by_test_id("money-progress")).to_contain_text("הועברו ₪240 מתוך ₪502")

        # Expenses: newest first, with split text; payments with statuses.
        splits = page.get_by_test_id("expense-split").all_inner_texts()
        assert sorted(splits) == sorted(["3 משתתפים", "כולם · 8 אנשים", "כולם · 8 אנשים"])
        expect(page.get_by_test_id("expense-row").first).to_contain_text("חניה בחוף")
        expect(page.get_by_test_id("expense-row").first).to_contain_text("חלקך ₪30")
        expect(page.locator("[data-testid=payment-row][data-status=sent]")).to_contain_text("נשלח ⏳")
        expect(page.locator("[data-testid=payment-row][data-status=confirmed]")).to_contain_text("אושר ✅")

        # The owner is an admin: admin-only controls are present.
        expect(page.get_by_role("button", name="סימון ששולם")).to_have_count(3)
        expect(page.get_by_role("button", name="אישור קבלה")).to_have_count(1)

        # Share text is the logic.js 'settle' summary.
        share = page.get_by_role("link", name="שתף התחשבנות")
        href = share.get_attribute("href")
        summary = page.evaluate(f"async () => (await import({LOGIC_JS})).buildSummaryText((await import({STORE_JS})).store.get().snap, 'settle')")
        assert href == "https://wa.me/?text=" + page.evaluate("(t) => encodeURIComponent(t)", summary)

        s.no_hscroll()
        s.shot(f"owner-{scheme}-{viewport['width']}", full_page=True)
        page.evaluate("window.scrollTo(0, 0)")
        s.shot(f"owner-top-{scheme}-{viewport['width']}")

        # Skeleton while the snapshot is missing, then the real screen again.
        s.eval_store("m.store.set({ snap: null, loading: true });")
        expect(page.locator(".money-hero--loading")).to_be_visible()
        s.eval_store("await m.actions.refresh();")
        expect(page.get_by_test_id("money-hero")).to_have_attribute("data-state", "debt")
        s.assert_clean()
    finally:
        s.close()


# ---------------------------------------------------------------------------
# expenses
# ---------------------------------------------------------------------------


def test_owner_adds_expense_split_by_heads(owner):
    s, page = owner, owner.page
    trip = s.trip_id()
    # Deep link from other screens opens the sheet directly.
    page.goto(f"{s.base}index.html?demo=1#/t/{trip}/money?new=1")
    sheet = s.sheet("הוצאה חדשה 🧾")
    expect(page).to_have_url(re.compile(r"/money$"))

    # Validation first: nothing filled.
    page.get_by_test_id("expense-save").click()
    expect(sheet.locator(".field__error")).to_have_text(["הקלידו סכום 🙂", "על מה ההוצאה?"])

    sheet.get_by_label("כמה זה עלה?").fill("160")
    expect(sheet.get_by_test_id("split-per-head")).to_have_text("₪20")  # 160 / 8 heads
    expect(sheet.get_by_test_id("split-share")).to_have_count(5)
    shares = page.evaluate(
        f"""async () => {{
          const L = await import({LOGIC_JS}); const S = await import({STORE_JS});
          const snap = S.store.get().snap;
          return L.expenseShares({{ amount: 160, split_mode: 'all' }}, snap).map((x) => [x.member_id, L.formatMoney(x.amount)]);
        }}"""
    )
    for member_id, amount in shares:
        expect(sheet.locator(f'[data-testid=split-share][data-member-id="{member_id}"] .split-chip__amount')).to_have_text(amount)

    sheet.get_by_label("על מה?").fill("פחמים ועצים")
    sheet.get_by_role("button", name=re.compile("מנגל ובישול")).click()
    expect(sheet.locator(".member-picker")).to_have_count(1)  # admins choose who paid
    s.shot("expense-sheet-light")
    page.get_by_test_id("expense-save").click()
    s.toast("ההוצאה נוספה")
    expect(sheet).to_have_count(0)

    row = page.get_by_test_id("expense-row").filter(has_text="פחמים ועצים")
    expect(row).to_be_visible()
    expect(row.get_by_test_id("expense-split")).to_have_text("כולם · 8 אנשים")
    expect(row.get_by_test_id("expense-amount")).to_have_text("₪160")
    exp = assert_matches_logic(s)
    assert (exp["total"], exp["perHead"]) == ("₪1,100", "₪137.50")
    saved = s.eval_store(
        "const e = snap.expenses.find((x) => x.title === 'פחמים ועצים');"
        " const c = snap.categories.find((x) => x.id === e.category_id);"
        " return { amount: e.amount, mode: e.split_mode, cat: c && c.name, mine: e.paid_by === snap.me.member_id };"
    )
    assert saved == {"amount": 160, "mode": "all", "cat": "מנגל ובישול", "mine": True}
    s.assert_clean()


def test_split_between_chosen_members_then_edit_and_delete(owner):
    s, page = owner, owner.page
    s.open_money()
    page.locator(".fab").click()
    sheet = s.sheet("הוצאה חדשה 🧾")
    sheet.get_by_label("כמה זה עלה?").fill("100")
    sheet.get_by_label("על מה?").fill("יין לערב")
    sheet.get_by_role("tab", name=re.compile("רק חלק")).click()
    picker = sheet.locator(".member-picker").last
    expect(picker.locator(".member-opt.is-on")).to_have_count(1)  # the payer is pre-selected
    picker.locator(".member-opt", has_text="יואב").click()
    # Me (a couple, 2 heads) + יואב (1 head): ₪66.67 / ₪33.33.
    expect(sheet.get_by_test_id("split-share")).to_have_count(2)
    expect(sheet.get_by_test_id("split-per-head")).to_have_text("₪33.33")
    chips = sheet.locator("[data-testid=split-share] .split-chip__amount").all_inner_texts()
    assert sorted(chips) == ["₪33.33", "₪66.67"]
    s.shot("expense-sheet-members-light")
    page.get_by_test_id("expense-save").click()
    s.toast("ההוצאה נוספה")

    row = page.get_by_test_id("expense-row").filter(has_text="יין לערב")
    expect(row.get_by_test_id("expense-split")).to_have_text("2 משתתפים")
    expect(row).to_contain_text("חלקך ₪66.67")
    expect(row).to_have_class(re.compile("is-new"))
    assert_matches_logic(s)

    # Edit: tap the row → edit sheet, change the amount.
    row.click()
    edit = s.sheet("עריכת הוצאה ✏️")
    amount = edit.get_by_label("כמה זה עלה?")
    expect(amount).to_have_value("100")
    expect(edit.locator(".member-opt.is-on")).to_have_count(3)  # payer (admin picker) + 2 participants
    amount.fill("120")
    expect(edit.get_by_test_id("split-per-head")).to_have_text("₪40")
    page.get_by_test_id("expense-save").click()
    s.toast("ההוצאה עודכנה")
    expect(row.get_by_test_id("expense-amount")).to_have_text("₪120")
    expect(row).to_contain_text("חלקך ₪80")
    assert_matches_logic(s)

    # Delete (with confirmation).
    row.click()
    edit = s.sheet("עריכת הוצאה ✏️")
    edit.get_by_role("button", name="מחיקת ההוצאה").click()
    dialog = page.get_by_role("alertdialog")
    expect(dialog).to_contain_text("יין לערב")
    dialog.get_by_role("button", name="כן, למחוק").click()
    s.toast("ההוצאה נמחקה")
    expect(page.get_by_test_id("expense-row").filter(has_text="יין לערב")).to_have_count(0)
    exp = assert_matches_logic(s)
    assert exp["total"] == "₪940"
    s.assert_clean()


# ---------------------------------------------------------------------------
# settle plan & payments
# ---------------------------------------------------------------------------


def test_i_paid_my_transfer(money_edge, money_server):
    s = Session(money_edge, money_server)
    try:
        s.ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=money_server.rstrip("/"))
        s.boot()
        s.open_money()
        page = s.page
        mine = page.get_by_test_id("settle-row").first
        expect(mine.locator(".settle-row__amount")).to_have_text("₪153")

        # Recipient's phone: copy + WhatsApp chat.
        copy = mine.get_by_role("button", name="050-000-0002")
        copy.click()
        expect(mine.get_by_role("button", name="הועתק!")).to_be_visible()
        assert page.evaluate("navigator.clipboard.readText()") == "0500000002"
        wa = mine.get_by_role("link", name="וואטסאפ")
        assert wa.get_attribute("href").startswith("https://wa.me/972500000002?text=")
        assert wa.get_attribute("target") == "_blank"

        mine.get_by_role("button", name="שילמתי ✓").click()
        sheet = s.sheet("סימון תשלום 💸")
        expect(sheet.get_by_test_id("pay-hero")).to_contain_text("מאיה ורון")
        expect(sheet.get_by_label("כמה?")).to_have_value("153")
        sheet.get_by_role("button", name=re.compile("מזומן")).click()
        sheet.get_by_label("הערה").fill("על הבשר 🥩")
        s.shot("pay-sheet-light")
        page.get_by_test_id("payment-save").click()
        s.toast("סימנת ששילמת ₪153 למאיה ורון")
        expect(page.locator(".confetti-canvas")).to_have_count(1, timeout=3000)  # debt settled → party

        # -152.50 + 153 → balanced; my transfer is gone from the plan.
        expect(page.get_by_test_id("money-hero")).to_have_attribute("data-state", "even")
        expect(page.get_by_test_id("money-balance-label")).to_have_text("את/ה מאוזנ/ת ✨")
        expect(page.get_by_test_id("settle-row").filter(has_text="את/ה")).to_have_count(0)
        newest = page.get_by_test_id("payment-row").first
        expect(newest).to_contain_text("נשלח ⏳")
        expect(newest).to_contain_text("מזומן")
        expect(newest).to_contain_text("על הבשר")
        assert_matches_logic(s)
        pay = s.eval_store(
            "const p = snap.payments.find((x) => x.note === 'על הבשר 🥩');"
            " return [p.amount, p.method, p.status, p.from_member === snap.me.member_id];"
        )
        assert pay == [153, "cash", "sent", True]
        page.evaluate("window.scrollTo(0, 0)")
        s.shot("after-paid-light")
        s.assert_clean()
    finally:
        s.close()


def test_admin_records_payments_for_others_and_deletes(owner):
    s, page = owner, owner.page
    s.open_money()
    row = page.get_by_test_id("settle-row").filter(has_text="אורי").filter(has_text="מאיה ורון")
    expect(row.locator(".settle-row__amount")).to_have_text("₪95")
    row.get_by_role("button", name="סימון ששולם").click()
    sheet = s.sheet("רישום העברה 📝")
    expect(sheet.get_by_label("כמה?")).to_have_value("95")
    expect(sheet).to_contain_text("נשלח למאיה ורון התראה לאישור קבלה")
    page.get_by_test_id("payment-save").click()
    s.toast("ההעברה נרשמה ✅")
    expect(page.get_by_test_id("settle-row").filter(has_text="אורי").filter(has_text="מאיה ורון")).to_have_count(0)
    assert_matches_logic(s)

    # Free-form: "I received ₪5 from יואב" → recorded as confirmed.
    page.get_by_role("button", name="רישום העברה").click()
    sheet = s.sheet("רישום העברה 📝")
    sheet.get_by_role("tab", name=re.compile("קיבלתי מ")).click()
    page.get_by_test_id("payment-save").click()
    expect(sheet.locator(".field__error")).to_have_text(["ממי קיבלת?", "הקלידו סכום 🙂"])
    sheet.locator(".member-opt", has_text="יואב").click()
    sheet.get_by_label("כמה?").fill("5")
    expect(sheet.get_by_test_id("pay-hero")).to_contain_text("יואב")
    page.get_by_test_id("payment-save").click()
    s.toast("נרשם שקיבלת ₪5 מיואב")
    newest = page.get_by_test_id("payment-row").first
    expect(newest).to_have_attribute("data-status", "confirmed")
    expect(newest).to_contain_text("יואב")
    assert_matches_logic(s)

    # Admin confirms someone else's pending payment, then deletes one.
    pending = page.locator("[data-testid=payment-row][data-status=sent]").filter(has_text="שירה וטל")
    pending.get_by_role("button", name="אישור קבלה").click()
    s.toast("ההעברה אושרה")
    expect(page.locator("[data-testid=payment-row][data-status=sent]").filter(has_text="שירה וטל")).to_have_count(0)
    before = page.get_by_test_id("payment-row").count()
    page.get_by_test_id("payment-row").first.get_by_role("button", name="מחיקת ההעברה").click()
    page.get_by_role("alertdialog").get_by_role("button", name="כן, למחוק").click()
    s.toast("ההעברה נמחקה")
    expect(page.get_by_test_id("payment-row")).to_have_count(before - 1)
    assert_matches_logic(s)
    s.assert_clean()


# ---------------------------------------------------------------------------
# a regular member
# ---------------------------------------------------------------------------


def test_member_view_confirm_and_receive(money_edge, money_server):
    s = Session(money_edge, money_server, scheme="dark")
    try:
        s.boot()
        s.act_as("יואב")
        s.open_money()
        page = s.page
        assert s.eval_store("return snap.members.find((x) => x.id === snap.me.member_id).role;") == "member"
        exp = assert_matches_logic(s)
        assert exp["balanceText"] == "₪13.75"
        expect(page.get_by_test_id("money-balance-label")).to_have_text("מגיע לך")

        # No admin controls for a member.
        expect(page.get_by_role("button", name="סימון ששולם")).to_have_count(0)
        expect(page.get_by_role("button", name="אישור קבלה")).to_have_count(0)
        expect(page.get_by_role("button", name="מחיקת ההעברה")).to_have_count(0)
        s.shot("member-dark", full_page=True)

        # The pending ₪90 from שירה וטל is mine to confirm.
        pending = page.locator("[data-testid=payment-row][data-status=sent]")
        expect(pending).to_have_count(1)
        pending.get_by_role("button", name="הכסף הגיע").click()
        s.toast("סימנת שהכסף הגיע")
        expect(page.locator("[data-testid=payment-row][data-status=sent]")).to_have_count(0)
        expect(page.locator("[data-testid=payment-row][data-status=confirmed]")).to_have_count(2)

        # A transfer owed to me: "קיבלתי ✓".
        row = page.get_by_test_id("settle-row").filter(has_text="שירה וטל")
        expect(row.locator(".settle-row__who")).to_contain_text("את/ה")
        expect(row).to_contain_text("מגיע לך")
        row.get_by_role("button", name="קיבלתי ✓").click()
        sheet = s.sheet("קיבלתי כסף 💰")
        expect(sheet.get_by_label("כמה?")).to_have_value("3")
        page.get_by_test_id("payment-save").click()
        s.toast("נרשם שקיבלת ₪3 משירה וטל")
        expect(page.get_by_test_id("settle-row").filter(has_text="שירה וטל")).to_have_count(0)
        assert_matches_logic(s)

        # Someone else's expense opens read-only; my own opens for editing.
        page.get_by_test_id("expense-row").filter(has_text="קניות בשר").click()
        ro = s.sheet("קניות בשר — הקצביה בכפר")
        expect(ro.get_by_test_id("expense-readonly")).to_be_visible()
        expect(ro.get_by_role("button", name="מחיקת ההוצאה")).to_have_count(0)
        expect(ro.get_by_test_id("split-share")).to_have_count(5)
        s.shot("expense-readonly-dark")
        page.keyboard.press("Escape")
        expect(ro).to_have_count(0)
        page.get_by_test_id("expense-row").filter(has_text="שתייה וקרח").click()
        edit = s.sheet("עריכת הוצאה ✏️")
        expect(edit.get_by_role("button", name="מחיקת ההוצאה")).to_be_visible()
        page.keyboard.press("Escape")
        expect(edit).to_have_count(0)

        # A member adds an expense: the payer is fixed to them (no picker).
        page.locator(".fab").click()
        sheet = s.sheet("הוצאה חדשה 🧾")
        expect(sheet.locator(".money-payer")).to_contain_text("את/ה (יואב)")
        expect(sheet.locator(".member-picker")).to_have_count(0)
        sheet.get_by_label("כמה זה עלה?").fill("40")
        sheet.get_by_label("על מה?").fill("קרח")
        expect(sheet.get_by_test_id("split-per-head")).to_have_text("₪5")
        s.shot("expense-sheet-member-dark")
        page.get_by_test_id("expense-save").click()
        s.toast("ההוצאה נוספה")
        expect(page.locator("[data-testid=expense-row] .list-row__title").get_by_text("קרח", exact=True)).to_be_visible()
        exp = assert_matches_logic(s)
        assert exp["total"] == "₪980"
        s.no_hscroll()
        s.assert_clean()
    finally:
        s.close()


def test_member_pays_undoes_then_recipient_confirms(money_edge, money_server):
    """A regular member who owes: "שילמתי ✓", undo (delete own pending), pay again,
    the recipient (also a regular member) confirms, and the payer can no longer delete it."""
    s = Session(money_edge, money_server, viewport=SMALL)
    try:
        s.boot()
        s.act_as("שירה וטל")
        s.open_money()
        page = s.page
        exp = assert_matches_logic(s)
        assert exp["balanceText"] == "₪2.50"
        expect(page.get_by_test_id("money-balance-label")).to_have_text("עליך להעביר")
        expect(page.get_by_role("button", name="סימון ששולם")).to_have_count(0)

        mine = page.get_by_test_id("settle-row").first
        expect(mine).to_contain_text("ההעברה שלך")
        expect(mine.locator(".settle-row__who")).to_contain_text("יואב")
        expect(mine.locator(".settle-row__amount")).to_have_text("₪3")
        expect(mine.get_by_role("button", name="050-000-0003")).to_be_visible()
        assert mine.get_by_role("link", name="וואטסאפ").get_attribute("href").startswith("https://wa.me/972500000003?text=")
        s.no_hscroll()

        def pay():
            page.get_by_test_id("settle-row").first.get_by_role("button", name="שילמתי ✓").click()
            sheet = s.sheet("סימון תשלום 💸")
            expect(sheet).to_contain_text("נשלח ליואב התראה לאישור קבלה")
            page.get_by_test_id("payment-save").click()
            s.toast("סימנת ששילמת ₪3 ליואב")
            expect(sheet).to_have_count(0)

        pay()
        # -2.50 + 3 → +0.50: under ₪1 counts as balanced.
        expect(page.get_by_test_id("money-hero")).to_have_attribute("data-state", "even")
        expect(page.get_by_test_id("settle-row").filter(has_text="את/ה")).to_have_count(0)
        mine_pay = page.locator("[data-testid=payment-row][data-status=sent]").filter(has_text="₪3")
        expect(mine_pay).to_have_count(1)
        expect(mine_pay.get_by_role("button", name="אישור קבלה")).to_have_count(0)  # not mine to confirm
        expect(mine_pay.get_by_role("button", name="הכסף הגיע")).to_have_count(0)
        assert_matches_logic(s)

        # Oops — undo: my own pending transfer can be deleted.
        mine_pay.get_by_role("button", name="מחיקת ההעברה").click()
        dialog = page.get_by_role("alertdialog")
        expect(dialog).to_contain_text("₪3")
        dialog.get_by_role("button", name="כן, למחוק").click()
        s.toast("ההעברה נמחקה")
        expect(page.get_by_test_id("money-hero")).to_have_attribute("data-state", "debt")
        expect(page.get_by_test_id("settle-row").first).to_contain_text("ההעברה שלך")
        assert_matches_logic(s)

        pay()
        assert_matches_logic(s)

        # The recipient (regular member יואב) confirms it.
        s.act_as("יואב")
        expect(page.get_by_test_id("money-balance-label")).to_have_text("מגיע לך")
        row = page.locator("[data-testid=payment-row][data-status=sent]").filter(has_text="₪3")
        expect(row).to_contain_text("נשלח ⏳")
        row.get_by_role("button", name="הכסף הגיע").click()
        s.toast("סימנת שהכסף הגיע")
        confirmed = page.locator("[data-testid=payment-row][data-status=confirmed]").filter(has_text="₪3")
        expect(confirmed).to_contain_text("אושר ✅")
        assert_matches_logic(s)

        # Back as the payer: confirmed → no delete for a regular member.
        s.act_as("שירה וטל")
        confirmed = page.locator("[data-testid=payment-row][data-status=confirmed]").filter(has_text="₪3")
        expect(confirmed).to_have_count(1)
        expect(confirmed.get_by_role("button", name="מחיקת ההעברה")).to_have_count(0)
        expect(page.get_by_test_id("money-hero")).to_have_attribute("data-state", "even")
        assert_matches_logic(s)
        s.shot("member-paid-light-360")
        s.assert_clean()
    finally:
        s.close()


def test_member_expense_sheet_closes_when_deleted_elsewhere(money_edge, money_server):
    s = Session(money_edge, money_server)
    try:
        s.boot()
        s.act_as("יואב")
        s.open_money()
        page = s.page
        page.get_by_test_id("expense-row").filter(has_text="שתייה וקרח").click()
        edit = s.sheet("עריכת הוצאה ✏️")
        # Setup: the same expense is deleted from "another phone" (a direct API call).
        s.eval_store(
            "const e = snap.expenses.find((x) => x.title === 'שתייה וקרח'); await api.deleteExpense(e.id);"
        )
        expect(edit).to_have_count(0)
        s.toast("ההוצאה הזו נמחקה בינתיים")
        expect(page.get_by_test_id("expense-row").filter(has_text="שתייה וקרח")).to_have_count(0)
        assert_matches_logic(s)

        # My own delete closes the sheet with a single toast (no "meanwhile" toast).
        page.locator(".fab").click()
        sheet = s.sheet("הוצאה חדשה 🧾")
        sheet.get_by_label("כמה זה עלה?").fill("30")
        sheet.get_by_label("על מה?").fill("קרח נוסף")
        page.get_by_test_id("expense-save").click()
        s.toast("ההוצאה נוספה")
        page.get_by_test_id("expense-row").filter(has_text="קרח נוסף").click()
        edit = s.sheet("עריכת הוצאה ✏️")
        edit.get_by_role("button", name="מחיקת ההוצאה").click()
        page.get_by_role("alertdialog").get_by_role("button", name="כן, למחוק").click()
        s.toast("ההוצאה נמחקה")
        expect(edit).to_have_count(0)
        page.wait_for_timeout(400)
        expect(page.locator(".toast", has_text="נמחקה בינתיים")).to_have_count(0)
        assert_matches_logic(s)
        s.assert_clean()
    finally:
        s.close()


# ---------------------------------------------------------------------------
# empty trip
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_empty_trip_then_first_expense(money_edge, money_server, scheme):
    s = Session(money_edge, money_server, scheme=scheme)
    try:
        s.boot()
        trip = s.eval_store(
            "const r = await api.createTrip({ name: 'ערב פיצה' },"
            " { display_name: 'דני', headcount: 1, people: ['דני'], emoji: '🦊', color: '#2F6B4F', phone: '0521234567' });"
            " return r.trip_id;"
        )
        page = s.page
        page.goto(f"{s.base}index.html?demo=1#/t/{trip}/money")
        hero = page.get_by_test_id("money-hero")
        expect(hero).to_have_attribute("data-state", "empty")
        expect(hero).to_contain_text("עוד לא נרשמו הוצאות")
        expect(page.get_by_text("איך זה עובד?")).to_be_visible()
        expect(page.get_by_text("עוד אין הוצאות")).to_be_visible()
        # One CTA in the hero (plus the FAB) — the empty expenses card doesn't repeat it.
        expect(page.get_by_role("button", name="הוספת הוצאה", exact=True)).to_have_count(0)
        expect(page.get_by_test_id("settle-row")).to_have_count(0)
        expect(page.get_by_test_id("members-table")).to_have_count(0)
        s.no_hscroll()
        s.shot(f"empty-{scheme}", full_page=True)

        hero.get_by_role("button", name="הוספת הוצאה ראשונה").click()
        sheet = s.sheet("הוצאה חדשה 🧾")
        sheet.get_by_label("כמה זה עלה?").fill("90")
        sheet.get_by_label("על מה?").fill("פיצה")
        page.get_by_test_id("expense-save").click()
        s.toast("ההוצאה נוספה")
        expect(page.get_by_test_id("money-hero")).to_have_attribute("data-state", "even")
        exp = assert_matches_logic(s)
        assert (exp["total"], exp["perHead"], exp["heads"]) == ("₪90", "₪90", "1")
        expect(page.get_by_test_id("settle-empty")).to_contain_text("כולם מאוזנים!")
        s.shot(f"single-expense-{scheme}", full_page=True)
        s.assert_clean()
    finally:
        s.close()
