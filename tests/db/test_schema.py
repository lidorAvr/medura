"""Schema-level guarantees: loads on a fresh "Supabase", re-runs cleanly, RLS everywhere,
no write policies, correct privileges, realtime publication."""
import pytest

from conftest import (ALL_TABLES, EXPECTED_RPCS, RLS_HELPERS, SCHEMA_SQL, create_database,
                      drop_database, new_trip, profile)



def test_every_table_exists_with_rls_enabled(db):
    rows = db.sql("""select c.relname, c.relrowsecurity from pg_class c
                     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'""")
    tables = {r["relname"]: r["relrowsecurity"] for r in rows}
    assert set(tables) == set(ALL_TABLES)
    assert all(tables.values()), tables


def test_only_select_policies_exist(db):
    policies = db.sql("select tablename, cmd from pg_policies where schemaname = 'public'")
    assert policies, "expected SELECT policies"
    assert {p["cmd"] for p in policies} == {"SELECT"}
    covered = {p["tablename"] for p in policies}
    assert covered == set(ALL_TABLES) - {"member_secrets", "push_subscriptions"}


def test_rpc_signatures_are_security_definer_with_pinned_search_path(db):
    rows = db.sql("""select p.proname, p.prosecdef, p.proconfig
                     from pg_proc p where p.pronamespace = 'public'::regnamespace""")
    funcs = {r["proname"]: r for r in rows}
    assert EXPECTED_RPCS <= set(funcs)
    for name in EXPECTED_RPCS | RLS_HELPERS:
        assert funcs[name]["prosecdef"], f"{name} must be SECURITY DEFINER"
        assert "search_path=public, pg_temp" in (funcs[name]["proconfig"] or []), name


def test_exact_rpc_parameter_names(db):
    sig = {r["proname"]: r["args"] for r in db.sql(
        """select p.proname, pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p where p.pronamespace = 'public'::regnamespace""")}
    assert sig["join_trip"] == "p_code text, p_claim_member uuid, p_profile jsonb"
    assert sig["review_item"] == "p_item uuid, p_approve boolean, p_reason text"
    assert sig["send_announcement"] == (
        "p_trip uuid, p_title text, p_body text, p_audience uuid[], p_urgent boolean")
    assert sig["create_poll"] == "p_trip uuid, p_question text, p_options text[], p_multi boolean"
    assert sig["assign"] == "p_item uuid, p_member uuid, p_qty integer"
    assert sig["mark_read"] == "p_trip uuid, p_ids uuid[]"
    assert sig["my_trips"] == ""


def test_function_privileges(db):
    rows = db.sql("""select p.proname,
                            has_function_privilege('anon', p.oid, 'execute') as anon,
                            has_function_privilege('authenticated', p.oid, 'execute') as auth
                     from pg_proc p where p.pronamespace = 'public'::regnamespace""")
    for r in rows:
        assert not r["anon"], f"anon can execute {r['proname']}"
        expected = r["proname"] in EXPECTED_RPCS | RLS_HELPERS
        assert r["auth"] == expected, f"authenticated execute on {r['proname']}"


def test_table_privileges(db):
    for table in ALL_TABLES:
        for priv in ("INSERT", "UPDATE", "DELETE", "TRUNCATE"):
            assert not db.val("select has_table_privilege('authenticated', %s, %s)",
                              [f"public.{table}", priv]), (table, priv)
        assert not db.val("select has_table_privilege('anon', %s, 'SELECT')", [f"public.{table}"])
        readable = table not in ("member_secrets", "push_subscriptions")
        assert db.val("select has_table_privilege('authenticated', %s, 'SELECT')",
                      [f"public.{table}"]) == readable, table


def test_only_trips_in_realtime_publication(db):
    rows = db.sql("select schemaname, tablename from pg_publication_tables "
                  "where pubname = 'supabase_realtime'")
    assert rows == [{"schemaname": "public", "tablename": "trips"}]


def test_schema_is_rerunnable_on_fresh_supabase(pg_server, templates):
    fresh = create_database(pg_server, "t_rerun", templates["stub"])
    try:
        fresh.run_file(SCHEMA_SQL)
        user = fresh.user()
        res = user.rpc("create_trip", p_trip={"name": "לפני"}, p_profile=profile("א"))
        fresh.run_file(SCHEMA_SQL)          # second run must succeed and keep data
        fresh.run_file(SCHEMA_SQL)
        assert fresh.count("trips") == 1
        snap = user.snap(res["trip_id"])
        assert snap["trip"]["name"] == "לפני"
        assert len(snap["categories"]) == 10
        rows = fresh.sql("select tablename from pg_publication_tables "
                         "where pubname = 'supabase_realtime'")
        assert rows == [{"tablename": "trips"}]
        assert not fresh.val("select has_function_privilege('anon', 'public.my_trips()', 'execute')")
    finally:
        fresh.conn.close()
        drop_database(pg_server, "t_rerun")


def test_schema_creates_publication_when_missing(pg_server, templates):
    fresh = create_database(pg_server, "t_nopub", templates["stub"])
    try:
        fresh.conn.execute("drop publication supabase_realtime")
        fresh.run_file(SCHEMA_SQL)
        assert fresh.val("select count(*) from pg_publication_tables "
                         "where pubname = 'supabase_realtime' and tablename = 'trips'") == 1
    finally:
        fresh.conn.close()
        drop_database(pg_server, "t_nopub")


def test_no_psql_meta_commands_needed(db):
    # The file is executed by psycopg as one plain SQL string in these tests (like the
    # Supabase SQL editor); this asserts the codes generator works without pgcrypto.
    assert not db.val("select exists (select 1 from pg_extension where extname = 'pgcrypto')")
    codes = {db.val("select public._gen_code()") for _ in range(50)}
    assert len(codes) == 50
    for code in codes:
        assert len(code) == 10
        assert set(code) <= set("abcdefghjkmnpqrstuvwxyz23456789")


def test_bump_increments_rev(db):
    t = new_trip(db)
    before = db.val("select rev from trips where id = %s", [t.id])
    t.owner.rpc("update_trip", p_trip=t.id, p_patch={"location": "פארק החבשושיות"})
    assert db.val("select rev from trips where id = %s", [t.id]) == before + 1
