"""API layer tests (js/api/*), executed in a real browser (Edge via Playwright).

- tests/web/supabase_api.test.js : contract of the Supabase wrapper (fake client), errors.js, index.js
- tests/web/demo_api.test.js     : scenario tests of the in-browser demo backend
- cross-tab realtime of the demo backend (two pages, one browser context)
- the real vendored supabase-js talking HTTP to a fake Supabase (Playwright request interception)

Run:  .venv\\Scripts\\python.exe -m pytest tests/test_api.py -q
"""
from __future__ import annotations

import base64
import json
import sys
import time
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from devserver import start_server  # noqa: E402

FAKE_SUPABASE = "https://medura-fake.supabase.co"


@pytest.fixture(scope="module")
def server_url():
    srv, base = start_server()
    yield base
    srv.shutdown()
    srv.server_close()


@pytest.fixture(scope="module")
def edge_browser():
    with sync_playwright() as p:
        try:
            b = p.chromium.launch(channel="msedge")
        except Exception:  # Edge missing → Chrome
            b = p.chromium.launch(channel="chrome")
        yield b
        b.close()


@pytest.fixture
def api_context(edge_browser):
    ctx = edge_browser.new_context()
    yield ctx
    ctx.close()


def open_page(ctx, url):
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url)
    page.wait_for_function("() => window.__RESULTS__ !== undefined", timeout=240_000)
    return page, errors


@pytest.mark.parametrize("suite", ["supabase", "demo"])
def test_web_suite(api_context, server_url, suite):
    page, errors = open_page(api_context, f"{server_url}tests/web/api.html?suite={suite}")
    res = page.evaluate("() => window.__RESULTS__")
    assert "fatal" not in res, res.get("fatal")
    r = res[suite]
    print(f"\n[{suite}] passed={r['passed']} failed={r['failed']}")
    assert r["failed"] == 0, json.dumps(r["failures"], ensure_ascii=False, indent=2)
    assert r["passed"] > 0
    assert errors == []


def test_demo_cross_tab_storage_event(api_context, server_url):
    url = f"{server_url}tests/web/api.html?suite=none"
    mod = f"{server_url}js/api/demo-api.js"
    tab_a, errors_a = open_page(api_context, url)
    tab_b, errors_b = open_page(api_context, url)

    trip_id = tab_a.evaluate(
        """async (mod) => {
            const { createDemoApi } = await import(mod);
            const api = createDemoApi({ latency: 0 });
            await api.init();
            await api.demo.reset();
            const [row] = await api.myTrips();
            window.__hits = 0;
            window.__api = api;
            window.__unsub = api.subscribe(row.trip.id, () => { window.__hits++; });
            return row.trip.id;
        }""",
        mod,
    )
    add_from_b = """async ([mod, tripId, title]) => {
        const { createDemoApi } = await import(mod);
        const api = createDemoApi({ latency: 0 });
        await api.init();
        await api.addPersonal(tripId, title);
    }"""
    tab_b.evaluate(add_from_b, [mod, trip_id, "מטאב אחר"])
    tab_a.wait_for_function("() => window.__hits >= 1", timeout=5_000)
    titles = tab_a.evaluate(
        "async (tripId) => (await window.__api.getSnapshot(tripId)).personal_items.map(p => p.title)", trip_id
    )
    assert "מטאב אחר" in titles, "tab A reads the data written by tab B"

    tab_a.evaluate("() => window.__unsub()")
    hits = tab_a.evaluate("() => window.__hits")
    tab_b.evaluate(add_from_b, [mod, trip_id, "אחרי ביטול"])
    tab_a.wait_for_timeout(300)
    assert tab_a.evaluate("() => window.__hits") == hits, "no events after unsubscribe"
    assert errors_a == [] and errors_b == []


def _fake_jwt(sub: str) -> str:
    def b64(obj) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()

    now = int(time.time())
    claims = {"sub": sub, "role": "authenticated", "aud": "authenticated", "iat": now, "exp": now + 3600, "is_anonymous": True}
    return f"{b64({'alg': 'HS256', 'typ': 'JWT'})}.{b64(claims)}.c2lnbmF0dXJl"


def test_real_supabase_js_over_http(api_context, server_url):
    """The vendored supabase-js + our wrapper produce the exact PostgREST requests, and real
    PostgREST/transport errors map to ApiError codes."""
    user_id = "11111111-2222-4333-8444-555555555555"
    token = _fake_jwt(user_id)
    seen: list[dict] = []
    cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
        "content-type": "application/json",
    }

    def handle(route, request):
        path = request.url.split(FAKE_SUPABASE, 1)[1].split("?", 1)[0]
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=cors)
        seen.append({"path": path, "method": request.method, "body": request.post_data, "headers": request.headers})
        if path == "/auth/v1/signup":
            session = {
                "access_token": token,
                "token_type": "bearer",
                "expires_in": 3600,
                "expires_at": int(time.time()) + 3600,
                "refresh_token": "refresh-1",
                "user": {
                    "id": user_id, "aud": "authenticated", "role": "authenticated", "is_anonymous": True,
                    "app_metadata": {}, "user_metadata": {}, "created_at": "2026-09-27T00:00:00Z",
                },
            }
            return route.fulfill(status=200, headers=cors, body=json.dumps(session))
        if path == "/rest/v1/rpc/join_trip":
            return route.fulfill(status=200, headers=cors, body=json.dumps({"trip_id": "t-1", "member_id": "m-1"}))
        if path == "/rest/v1/rpc/mark_read":
            return route.fulfill(status=204, headers=cors, body="")
        if path == "/rest/v1/rpc/get_trip_snapshot":
            err = {"code": "P0001", "message": "forbidden", "details": None, "hint": None}
            return route.fulfill(status=400, headers=cors, body=json.dumps(err))
        if path == "/rest/v1/rpc/my_trips":
            return route.abort("internetdisconnected")
        err = {"code": "PGRST202", "message": "Could not find the function", "details": None, "hint": None}
        return route.fulfill(status=404, headers=cors, body=json.dumps(err))

    api_context.route(f"{FAKE_SUPABASE}/**", handle)
    page, errors = open_page(api_context, f"{server_url}tests/web/api.html?suite=none")
    out = page.evaluate(
        """async ([mod, url]) => {
            const { createSupabaseApi } = await import(mod);
            const api = createSupabaseApi({ url, anonKey: 'anon-key-123' });
            await api.init();
            const failure = async (p) => {
                try { await p; return null; } catch (e) { return { name: e.name, code: e.code, message: e.message }; }
            };
            const session = await api.ensureSession();
            const joined = await api.joinTrip(' ABC234DEFG ', { profile: { display_name: 'לידור', headcount: 1 } });
            const read = await api.markRead('t-1', ['n-1']);
            return {
                session, joined, read,
                snapErr: await failure(api.getSnapshot('t-1')),
                netErr: await failure(api.myTrips()),
                otherErr: await failure(api.rotateInvite('t-1')),
                stored: localStorage.getItem('medura-auth') !== null,
                userId: api.getUserId(),
            };
        }""",
        [f"{server_url}js/api/supabase-api.js", FAKE_SUPABASE],
    )
    assert out["session"] == {"userId": user_id}
    assert out["userId"] == user_id
    assert out["stored"], "session persisted under storageKey 'medura-auth'"
    assert out["joined"] == {"trip_id": "t-1", "member_id": "m-1"}
    assert out["read"] is None
    assert out["snapErr"]["name"] == "ApiError" and out["snapErr"]["code"] == "forbidden"
    assert out["netErr"]["code"] == "network"
    assert out["otherErr"]["code"] == "unknown"

    posts = {r["path"]: r for r in seen if r["method"] == "POST"}
    assert "/auth/v1/signup" in posts, "anonymous sign-in"
    join = posts["/rest/v1/rpc/join_trip"]
    assert json.loads(join["body"]) == {
        "p_code": "abc234defg",
        "p_claim_member": None,
        "p_profile": {"display_name": "לידור", "headcount": 1},
    }
    assert join["headers"].get("apikey") == "anon-key-123"
    assert join["headers"].get("authorization") == f"Bearer {token}"
    assert json.loads(posts["/rest/v1/rpc/mark_read"]["body"]) == {"p_trip": "t-1", "p_ids": ["n-1"]}
    assert json.loads(posts["/rest/v1/rpc/get_trip_snapshot"]["body"]) == {"p_trip": "t-1"}
    assert errors == []
