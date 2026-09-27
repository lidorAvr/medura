"""Apply SQL files to the live Supabase database and verify the result.

The connection string is read from the DATABASE_URL environment variable and is never stored.
Get it in the Supabase dashboard: Connect → "Session pooler" → URI, and put the database
password in place of [YOUR-PASSWORD] (Project Settings → Database → Reset password if unknown).

Usage (Windows PowerShell, from the project root):
    $env:DATABASE_URL = "postgresql://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"
    .venv\\Scripts\\python.exe tools\\db_deploy.py verify                      # read-only checks
    .venv\\Scripts\\python.exe tools\\db_deploy.py apply supabase\\schema.sql   # schema (safe to re-run)
    .venv\\Scripts\\python.exe tools\\db_deploy.py apply private\\seed_trip.sql
    Remove-Item Env:DATABASE_URL

Every file runs in one transaction: it either applies completely or not at all.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parent.parent

TABLES = [
    "trips", "members", "member_secrets", "member_users", "categories", "items", "pledges",
    "expenses", "expense_shares", "payments", "notifications", "notification_reads",
    "admin_votes", "polls", "poll_votes", "personal_items", "push_subscriptions",
]


def expected_rpcs() -> set[str]:
    """The RPC list the DB tests check (tests/db/conftest.py), without importing pytest."""
    src = (ROOT / "tests" / "db" / "conftest.py").read_text(encoding="utf-8")
    block = src.split("EXPECTED_RPCS = {", 1)[1].split("}", 1)[0]
    return {w.strip().strip('"') for w in block.replace("\n", " ").split(",") if w.strip()}


def connect() -> psycopg.Connection:
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        sys.exit("DATABASE_URL is not set (see the docstring at the top of this file).")
    return psycopg.connect(url, connect_timeout=15)


def apply(paths: list[str]) -> None:
    with connect() as conn:
        for p in paths:
            path = Path(p)
            sql = path.read_text(encoding="utf-8")
            print(f"→ applying {path} ({len(sql.splitlines())} lines)…", flush=True)
            with conn.transaction():
                conn.execute(sql)
            print(f"  ✓ {path.name} applied")
    verify()


def verify() -> None:
    problems: list[str] = []
    with connect() as conn:
        q = lambda sql: conn.execute(sql).fetchall()  # noqa: E731

        rls = dict(q("""select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                        where n.nspname = 'public' and c.relkind = 'r'"""))
        missing = [t for t in TABLES if t not in rls]
        no_rls = [t for t in TABLES if t in rls and not rls[t]]
        print(f"tables: {len(TABLES) - len(missing)}/{len(TABLES)}" + (f"  missing: {missing}" if missing else ""))
        problems += [f"missing table {t}" for t in missing] + [f"RLS off on {t}" for t in no_rls]

        funcs = {r[0] for r in q("""select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                    where n.nspname = 'public'""")}
        want = expected_rpcs()
        lost = sorted(want - funcs)
        print(f"rpcs: {len(want) - len(lost)}/{len(want)}" + (f"  missing: {lost}" if lost else ""))
        problems += [f"missing rpc {f}" for f in lost]

        exec_ok = q("select has_function_privilege('authenticated', 'public.get_trip_snapshot(uuid)', 'execute'), "
                    "has_function_privilege('anon', 'public.get_trip_snapshot(uuid)', 'execute'), "
                    "has_schema_privilege('authenticated', 'public', 'usage')") if "get_trip_snapshot" in funcs else [(False, False, False)]
        auth_exec, anon_exec, usage = exec_ok[0]
        print(f"grants: authenticated can call RPCs={auth_exec}, anon blocked={not anon_exec}, schema usage={usage}")
        if not auth_exec:
            problems.append("authenticated cannot execute RPCs")
        if anon_exec:
            problems.append("anon can execute RPCs")
        if not usage:
            problems.append("authenticated lacks USAGE on schema public")

        writable = q("""select table_name, privilege_type from information_schema.role_table_grants
                        where table_schema = 'public' and grantee in ('anon', 'authenticated')
                          and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')""")
        print(f"direct table writes for clients: {len(writable)} (want 0)")
        problems += [f"client can {p} {t}" for t, p in writable]

        realtime = q("select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'")
        rt = sorted(r[0] for r in realtime)
        print(f"realtime publication: {rt}")
        if "trips" not in rt:
            problems.append("trips is not in the supabase_realtime publication")

        if "trips" in rls:
            for name, code, members, items in q("""select t.name, t.invite_code,
                    (select count(*) from public.members m where m.trip_id = t.id),
                    (select count(*) from public.items i where i.trip_id = t.id)
                    from public.trips t where t.name not like 'LIVE TEST%' order by t.created_at"""):
                print(f"trip: {name} · invite {code} · {members} members · {items} items")
            live = q("select count(*) from public.trips where name like 'LIVE TEST%'")[0][0]
            if live:
                print(f"note: {live} leftover 'LIVE TEST' trips — delete them with: delete from public.trips where name like 'LIVE TEST%';")

    if problems:
        print("\n✗ PROBLEMS:\n  - " + "\n  - ".join(problems))
        sys.exit(1)
    print("\n✓ database looks good")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "verify":
        verify()
    elif len(sys.argv) >= 3 and sys.argv[1] == "apply":
        apply(sys.argv[2:])
    else:
        sys.exit(__doc__)
