"""LIVE smoke test against the real Supabase project (opt-in: set MEDURA_LIVE=1).

Every Playwright browser context is a separate device => a separate anonymous Supabase user.
Exercises the real client (js/api/supabase-api.js + vendored supabase-js) against the deployed schema:
auth, create/preview/join, proposal → approval, pledges, expenses, RLS isolation for an outsider,
direct table writes blocked, and realtime notifications on the trips row.

Creates trips named 'LIVE TEST …'. Clean up afterwards in the SQL editor:
    delete from public.trips where name like 'LIVE TEST%';
"""
from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from devserver import start_server  # noqa: E402

pytestmark = pytest.mark.skipif(os.environ.get("MEDURA_LIVE") != "1", reason="live test: set MEDURA_LIVE=1")


def _config() -> tuple[str, str]:
    for p in (ROOT / "config.js", ROOT / "private" / "config.supabase.js"):
        txt = p.read_text(encoding="utf-8")
        url = re.search(r'supabaseUrl:\s*"([^"]*)"', txt).group(1)
        key = re.search(r'supabaseAnonKey:\s*"([^"]*)"', txt).group(1)
        if url and key:
            return url, key
    pytest.skip("no Supabase config found")


@pytest.fixture(scope="module")
def env():
    from playwright.sync_api import sync_playwright

    url, key = _config()
    srv, base = start_server()
    pw = sync_playwright().start()
    try:
        browser = pw.chromium.launch(channel="msedge")
    except Exception:
        browser = pw.chromium.launch(channel="chrome")
    pages = []

    def device():
        ctx = browser.new_context()
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base + "tests/live/live.html")
        page.wait_for_function("window.__ready === true")
        page.evaluate("([u, k]) => { window.__url = u; window.__key = k; return makeApi(u, k); }", [url, key])
        page.evaluate("async () => { await api.init(); return (await api.ensureSession()).userId; }")
        page.errors = errors
        pages.append(page)
        return page

    yield device
    for p in pages:
        assert not p.errors, p.errors
    browser.close()
    pw.stop()
    srv.shutdown()


def call(page, method: str, *args):
    """Call api.<method>(...args); returns {ok, data} or {ok:false, code}."""
    return page.evaluate(
        """async ([m, args]) => {
            try { return { ok: true, data: await api[m](...args) }; }
            catch (e) { return { ok: false, code: e.code || String(e) }; }
        }""",
        [method, list(args)],
    )


def ok(res):
    assert res["ok"], res
    return res["data"]


def test_live_end_to_end(env):
    stamp = time.strftime("%H%M%S")
    owner, friend, outsider = env(), env(), env()

    # --- owner creates a trip -------------------------------------------------------------
    created = ok(call(owner, "createTrip",
                      {"name": f"LIVE TEST {stamp}", "emoji": "🧪", "location": "פארק החבשושיות",
                       "starts_at": "2026-10-01T09:00:00+03:00", "ends_at": "2026-10-02T12:00:00+03:00"},
                      {"display_name": "בודק ובודקת", "headcount": 2, "people": ["בודק", "בודקת"], "emoji": "🧪"}))
    trip_id, owner_mid = created["trip_id"], created["member_id"]
    snap = ok(call(owner, "getSnapshot", trip_id))
    assert snap["me"]["role"] == "owner"
    assert len(snap["categories"]) == 10
    code = snap["trip"]["invite_code"]
    assert re.fullmatch(r"[a-z2-9]{10}", code), code

    # --- realtime: owner listens on the trips row ---------------------------------------------
    owner.evaluate("(t) => { window.__changes = 0; window.__unsub = api.subscribe(t, () => { window.__changes++; }); }", trip_id)
    time.sleep(3)  # let the channel join
    owner.evaluate("() => { window.__changes = 0; }")

    # --- friend previews + joins with a fresh profile ------------------------------------------------
    prev = ok(call(friend, "previewInvite", code.upper() + "  "))  # case/space-insensitive
    assert prev["trip"]["id"] == trip_id and prev["my_member_id"] is None
    joined = ok(call(friend, "joinTrip", code, {"profile": {"display_name": "חבר", "headcount": 1, "people": ["חבר"]}}))
    friend_mid = joined["member_id"]
    assert ok(call(friend, "joinTrip", code, {"profile": {"display_name": "שוב"}}))["member_id"] == friend_mid  # idempotent

    # realtime fired on the owner's device because of the friend's join
    owner.wait_for_function("window.__changes > 0", timeout=20000)

    # --- proposal → approval → pledge -----------------------------------------------------------------
    fsnap = ok(call(friend, "getSnapshot", trip_id))
    meat = next(c for c in fsnap["categories"] if "בשר" in c["name"])
    item_id = ok(call(friend, "addItem", trip_id, {"category_id": meat["id"], "title": "כנפיים", "type": "buy",
                                                    "qty": 1, "unit": 'ק"ג'}))
    fsnap = ok(call(friend, "getSnapshot", trip_id))
    assert next(i for i in fsnap["items"] if i["id"] == item_id)["status"] == "proposed"
    assert call(friend, "reviewItem", item_id, True, None) == {"ok": False, "code": "forbidden"}
    osnap = ok(call(owner, "getSnapshot", trip_id))
    assert any(n["title"].startswith("הצעה חדשה") for n in osnap["notifications"]), osnap["notifications"]
    ok(call(owner, "reviewItem", item_id, True, None))
    ok(call(friend, "pledge", item_id, 1))
    fsnap = ok(call(friend, "getSnapshot", trip_id))
    assert next(i for i in fsnap["items"] if i["id"] == item_id)["status"] == "active"
    assert any(p["item_id"] == item_id and p["member_id"] == friend_mid for p in fsnap["pledges"])
    assert any("אושרה" in n["title"] for n in fsnap["notifications"])

    # --- money: friend pays 90 for everyone (3 heads) → owner owes 60 ----------------------------------
    ok(call(friend, "addExpense", trip_id, {"title": "סופר", "amount": 90, "split_mode": "all"}))
    assert call(friend, "addExpense", trip_id, {"title": "x", "amount": 10, "paid_by": owner_mid}) == \
        {"ok": False, "code": "forbidden"}
    ok(call(owner, "addPayment", trip_id, {"to_member": friend_mid, "amount": 60, "method": "bit"}))
    fsnap = ok(call(friend, "getSnapshot", trip_id))
    assert len(fsnap["expenses"]) == 1 and fsnap["payments"][0]["status"] == "sent"

    # --- announcements with audience ------------------------------------------------------------------
    ok(call(owner, "sendAnnouncement", trip_id, {"title": "רק לבודק", "body": "סוד", "audience": [owner_mid], "urgent": False}))
    fsnap = ok(call(friend, "getSnapshot", trip_id))
    assert not any(n["title"] == "רק לבודק" for n in fsnap["notifications"])

    # --- outsider: nothing readable, nothing writable -----------------------------------------------------
    assert call(outsider, "getSnapshot", trip_id) == {"ok": False, "code": "forbidden"}
    leak = outsider.evaluate("""async (t) => {
        const c = rawClient(); const out = {};
        for (const tbl of ['trips','members','items','pledges','expenses','payments','notifications','personal_items','member_secrets','push_subscriptions']) {
          const r = await c.from(tbl).select('*').limit(5);
          out[tbl] = r.error ? 'ERR:' + (r.error.code || r.error.message) : r.data.length;
        }
        const ins = await c.from('items').insert({ trip_id: t, title: 'hack', type: 'buy' });
        out.insert = ins.error ? 'blocked' : 'ALLOWED';
        const upd = await c.from('trips').update({ name: 'pwned' }).eq('id', t).select();
        out.update = upd.error ? 'blocked' : ('rows:' + upd.data.length);
        return out;
    }""", trip_id)
    for tbl in ("trips", "members", "items", "pledges", "expenses", "payments", "notifications", "personal_items"):
        assert leak[tbl] == 0 or str(leak[tbl]).startswith("ERR"), leak
    assert str(leak["member_secrets"]).startswith("ERR") and str(leak["push_subscriptions"]).startswith("ERR"), leak
    assert leak["insert"] == "blocked", leak
    assert leak["update"] in ("blocked", "rows:0"), leak
    # the friend (a member!) also cannot write directly
    member_write = friend.evaluate("""async (t) => {
        const c = rawClient();
        const r = await c.from('items').insert({ trip_id: t, title: 'direct', type: 'buy' });
        return r.error ? 'blocked' : 'ALLOWED';
    }""", trip_id)
    assert member_write == "blocked"

    owner.evaluate("() => window.__unsub && window.__unsub()")
