"""RLS isolation, blocked direct writes, unreadable secrets, anon lockout."""
import json

import psycopg
import pytest

from conftest import (ALL_TABLES, EXPECTED_RPCS, PERMISSION_DENIED, RpcError, new_trip, profile,
                      raises)

READABLE = [t for t in ALL_TABLES if t not in ("member_secrets", "push_subscriptions")]


def populate(db, t):
    """Creates at least one row in every table of trip t. Returns the other member."""
    owner = t.owner
    guest = t.join("אורח", 2)
    cat = t.category("בשר ועוף")
    item = owner.rpc("add_item", p_trip=t.id, p_item={"title": "קבב", "type": "buy",
                                                      "category_id": cat})
    owner.rpc("assign", p_item=item, p_member=guest.mid)
    exp = owner.rpc("add_expense", p_trip=t.id, p_exp={
        "title": "סופר", "amount": 300, "split_mode": "members",
        "members": [{"member_id": owner.mid}, {"member_id": guest.mid}]})
    assert exp
    guest.rpc("add_payment", p_trip=t.id, p_pay={"to_member": owner.mid, "amount": 50})
    note = owner.rpc("send_announcement", p_trip=t.id, p_title="שלום", p_body="היי")
    guest.rpc("mark_read", p_trip=t.id, p_ids=[note])
    guest.rpc("vote_admin", p_candidate=guest.mid, p_on=True)
    poll = owner.rpc("create_poll", p_trip=t.id, p_question="מתי?", p_options=["א", "ב"])
    guest.rpc("vote_poll", p_poll=poll, p_option_ids=["o1"])
    guest.rpc("add_personal", p_trip=t.id, p_title="מגבת")
    guest.rpc("get_device_code", p_member=guest.mid)
    guest.rpc("save_push_subscription", p_trip=t.id, p_sub={
        "endpoint": f"https://push.example/{guest.uid}", "keys": {"p256dh": "k", "auth": "a"}})
    for table in ALL_TABLES:
        assert db.count(table, "trip_id = %s" if table != "trips" else "id = %s", [t.id]) > 0, table
    return guest


@pytest.fixture
def two_trips(db):
    a = new_trip(db, name="טיול א")
    b = new_trip(db, name="טיול ב")
    a_guest = populate(db, a)
    b_guest = populate(db, b)
    return a, a_guest, b, b_guest


def test_members_read_only_their_trip(db, two_trips):
    a, a_guest, b, b_guest = two_trips
    for actor in (a.owner, a_guest):
        for table in READABLE:
            key = "id" if table == "trips" else "trip_id"
            rows = actor.query(f"select {key} as trip from public.{table}")
            assert all(r["trip"] == a.id for r in rows), (actor, table)
            assert not any(r["trip"] == b.id for r in rows)
        # the RLS view matches what the member is allowed to see
        assert len(actor.query("select * from public.members")) == 2
        assert len(actor.query("select * from public.items")) == 1


def test_snapshot_of_other_trip_is_forbidden(db, two_trips):
    a, a_guest, b, _ = two_trips
    with raises("forbidden"):
        a.owner.snap(b.id)
    with raises("forbidden"):
        a_guest.snap(b.id)
    with raises("forbidden"):
        db.user().snap(a.id)


def test_other_trip_rpcs_are_forbidden(db, two_trips):
    a, a_guest, b, b_guest = two_trips
    b_item = db.val("select id from items where trip_id = %s", [b.id])
    b_expense = db.val("select id from expenses where trip_id = %s", [b.id])
    b_payment = db.val("select id from payments where trip_id = %s", [b.id])
    b_poll = db.val("select id from polls where trip_id = %s", [b.id])
    b_note = db.val("select id from notifications where trip_id = %s limit 1", [b.id])
    b_personal = db.val("select id from personal_items where trip_id = %s", [b.id])
    attacker = a.owner       # admin of A, stranger to B
    calls = [
        ("update_trip", dict(p_trip=b.id, p_patch={"name": "x"})),
        ("rotate_invite", dict(p_trip=b.id)),
        ("update_member", dict(p_member=b_guest.mid, p_patch={"display_name": "x"})),
        ("create_member", dict(p_trip=b.id, p_profile=profile("x"))),
        ("set_role", dict(p_member=b_guest.mid, p_role="admin")),
        ("remove_member", dict(p_member=b_guest.mid)),
        ("leave_trip", dict(p_trip=b.id)),
        ("vote_admin", dict(p_candidate=b_guest.mid, p_on=True)),
        ("upsert_category", dict(p_trip=b.id, p_cat={"name": "x"})),
        ("add_item", dict(p_trip=b.id, p_item={"title": "x"})),
        ("add_items_bulk", dict(p_trip=b.id, p_items=[{"title": "x"}])),
        ("update_item", dict(p_item=b_item, p_patch={"title": "x"})),
        ("review_item", dict(p_item=b_item, p_approve=True)),
        ("delete_item", dict(p_item=b_item)),
        ("pledge", dict(p_item=b_item)),
        ("assign", dict(p_item=b_item, p_member=a.owner.mid)),
        ("set_pledge_done", dict(p_item=b_item, p_done=True)),
        ("set_item_done", dict(p_item=b_item, p_done=True)),
        ("add_personal", dict(p_trip=b.id, p_title="x")),
        ("add_personal_template", dict(p_trip=b.id)),
        ("update_personal", dict(p_id=b_personal, p_patch={"done": True})),
        ("delete_personal", dict(p_id=b_personal)),
        ("add_expense", dict(p_trip=b.id, p_exp={"title": "x", "amount": 1})),
        ("update_expense", dict(p_expense=b_expense, p_patch={"title": "x"})),
        ("delete_expense", dict(p_expense=b_expense)),
        ("add_payment", dict(p_trip=b.id, p_pay={"to_member": b.owner.mid, "amount": 1})),
        ("confirm_payment", dict(p_payment=b_payment)),
        ("delete_payment", dict(p_payment=b_payment)),
        ("send_announcement", dict(p_trip=b.id, p_title="x", p_body="y")),
        ("delete_notification", dict(p_notification=b_note)),
        ("mark_read", dict(p_trip=b.id, p_ids=[b_note])),
        ("create_poll", dict(p_trip=b.id, p_question="x", p_options=["a", "b"])),
        ("vote_poll", dict(p_poll=b_poll, p_option_ids=["o1"])),
        ("close_poll", dict(p_poll=b_poll, p_closed=True)),
        ("delete_poll", dict(p_poll=b_poll)),
        ("save_push_subscription", dict(p_trip=b.id, p_sub={
            "endpoint": "https://push.example/x", "keys": {"p256dh": "k", "auth": "a"}})),
        ("get_device_code", dict(p_member=b_guest.mid)),
    ]
    before = {t: db.count(t) for t in ALL_TABLES}
    rev = db.val("select rev from trips where id = %s", [b.id])
    for fn, params in calls:
        with raises("forbidden"):
            attacker.rpc(fn, **params)
    assert {t: db.count(t) for t in ALL_TABLES} == before
    assert db.val("select rev from trips where id = %s", [b.id]) == rev


def _sample_row(db, table, trip_id):
    key = "id" if table == "trips" else "trip_id"
    return db.one(f"select to_jsonb(x) as j from public.{table} x where {key} = %s limit 1",
                  [trip_id])["j"]


@pytest.mark.parametrize("table", ALL_TABLES)
def test_direct_writes_are_blocked(db, table):
    t = new_trip(db)
    guest = populate(db, t)
    row = _sample_row(db, table, t.id)
    before = db.count(table)
    snapshot_before = db.sql(f"select to_jsonb(x) as j from public.{table} x order by 1")
    for actor in (t.owner, guest, db.user(), db.anon()):
        copy = dict(row)
        if "id" in copy:
            copy["id"] = "11111111-1111-1111-1111-111111111111"
        attempts = [
            (f"insert into public.{table} select * from jsonb_populate_record(null::public.{table}, %s::jsonb)",
             [json.dumps(copy)]),
            (f"update public.{table} set trip_id = trip_id" if table != "trips"
             else "update public.trips set rev = rev + 100", None),
            (f"delete from public.{table}", None),
        ]
        for sql, params in attempts:
            try:
                affected = actor.execute(sql, params)
            except RpcError as err:
                assert err.code == PERMISSION_DENIED, (table, actor, sql, err)
            else:
                assert affected == 0, (table, actor, sql)
        try:
            actor.execute(f"truncate public.{table} cascade")
        except RpcError as err:
            assert err.code == PERMISSION_DENIED
        else:
            raise AssertionError(f"truncate {table} succeeded for {actor}")
    assert db.count(table) == before
    assert db.sql(f"select to_jsonb(x) as j from public.{table} x order by 1") == snapshot_before


def test_rls_blocks_writes_even_with_table_grants(db):
    """Defense in depth: if someone re-granted write privileges, RLS (no write policies)
    would still block every direct write."""
    t = new_trip(db)
    guest = populate(db, t)
    conn = db.conn
    with conn.transaction(force_rollback=True):
        conn.execute("grant insert, update, delete on all tables in schema public to authenticated")
        conn.execute("select set_config('request.jwt.claim.sub', %s, true)", [guest.uid])
        conn.execute("set local role authenticated")
        assert conn.execute("update public.items set title = 'hacked'").rowcount == 0
        assert conn.execute("delete from public.expenses").rowcount == 0
        assert conn.execute("update public.members set role = 'owner'").rowcount == 0
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with conn.transaction():
                conn.execute("insert into public.admin_votes (trip_id, voter_id, candidate_id) "
                             "values (%s, %s, %s)", [t.id, guest.mid, t.owner.mid])
        conn.execute("reset role")
    assert db.val("select count(*) from items where title = 'hacked'") == 0


def test_secrets_and_push_subscriptions_are_unreadable(db):
    t = new_trip(db)
    guest = populate(db, t)
    for actor in (t.owner, guest):
        for table in ("member_secrets", "push_subscriptions"):
            with raises(PERMISSION_DENIED):
                actor.query(f"select * from public.{table}")
    snap = guest.snap(t.id)
    text = json.dumps(snap, ensure_ascii=False)
    code = db.val("select device_code from member_secrets where member_id = %s", [guest.mid])
    assert code not in text
    assert "push.example" not in text


def test_member_users_only_own_rows(db):
    t = new_trip(db)
    guest = populate(db, t)
    rows = guest.query("select * from public.member_users")
    assert [r["user_id"] for r in rows] == [guest.uid]


def test_personal_items_rls_is_private(db):
    t = new_trip(db)
    guest = populate(db, t)
    assert t.owner.query("select * from public.personal_items") == []
    assert len(guest.query("select * from public.personal_items")) == 1


def test_notification_rls_matches_visibility_rule(db):
    t = new_trip(db)
    a = t.join("א")
    b = t.join("ב")
    only_a = t.owner.rpc("send_announcement", p_trip=t.id, p_title="רק לא", p_body="",
                         p_audience=[a.mid])
    assert only_a in {r["id"] for r in a.query("select id from public.notifications")}
    assert only_a not in {r["id"] for r in b.query("select id from public.notifications")}
    assert only_a in {r["id"] for r in t.owner.query("select id from public.notifications")}


def test_anon_cannot_execute_rpcs_or_read(db):
    t = new_trip(db)
    anon = db.anon()
    for fn in sorted(EXPECTED_RPCS):
        with raises(PERMISSION_DENIED):
            anon.query(f"select public.{fn}(" + ", ".join(
                ["null"] * len(db.signature(fn))) + ")")
    for table in ALL_TABLES:
        with raises(PERMISSION_DENIED):
            anon.query(f"select * from public.{table}")
    assert t.owner.snap(t.id)


def test_authenticated_without_uid_is_rejected(db):
    ghost = db.user()
    ghost.uid = None          # role authenticated but no JWT sub
    with raises("not_authenticated"):
        ghost.rpc("my_trips")
    with raises("not_authenticated"):
        ghost.rpc("create_trip", p_trip={"name": "x"}, p_profile=profile("x"))
    with raises("not_authenticated"):
        ghost.rpc("delete_push_subscription", p_endpoint="https://x")


def test_internal_helpers_are_not_callable(db):
    user = db.user()
    for call in ("public._bump(gen_random_uuid())", "public._gen_code()",
                 "public._notify(gen_random_uuid(), 't', null, null, null)",
                 "public._create_default_categories(gen_random_uuid())"):
        with raises(PERMISSION_DENIED):
            user.query(f"select {call}")


def test_jwt_claims_json_form_is_supported(db):
    """Supabase sets request.jwt.claims (JSON); auth.uid() must read it."""
    t = new_trip(db)
    conn = db.conn
    with conn.transaction(force_rollback=True):
        conn.execute("select set_config('request.jwt.claims', %s, true)",
                     [json.dumps({"sub": t.owner.uid, "role": "authenticated"})])
        conn.execute("set local role authenticated")
        snap = conn.execute("select public.get_trip_snapshot(%s::uuid) as s", [t.id]).fetchone()["s"]
        conn.execute("reset role")
    assert snap["me"]["member_id"] == t.owner.mid
