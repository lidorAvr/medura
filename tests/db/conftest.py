"""pytest harness for supabase/schema.sql on an embedded Postgres 16 (pgserver).

* One Postgres server per test session.
* Template databases: ``medura_stub`` (Supabase emulation only) and ``medura_tpl``
  (stub + schema). Every test module gets its own database cloned from ``medura_tpl``;
  every test starts from empty tables (``truncate trips cascade``).
* ``db.user()`` returns an :class:`Actor` — a fresh auth user (random uuid) that runs SQL
  inside its own transaction with ``set local role authenticated`` and the JWT ``sub`` claim,
  exactly like PostgREST does for supabase-js. ``actor.rpc(name, **params)`` calls an RPC the
  way supabase-js ``rpc(name, {params})`` does: params travel as one JSON document and are
  cast to the declared argument types (omitted params use the SQL defaults).
"""
from __future__ import annotations

import json
import re
import uuid
from contextlib import contextmanager
from pathlib import Path

import pgserver
import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.string import TextLoader

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_SQL = ROOT / "supabase" / "schema.sql"
STUB_SQL = Path(__file__).resolve().with_name("supabase_stub.sql")
SEED_SQL = ROOT / "private" / "seed_trip.sql"

PERMISSION_DENIED = "42501"   # insufficient_privilege (missing grant or RLS WITH CHECK)

# Every table of the schema (SPEC §3).
ALL_TABLES = [
    "trips", "members", "member_secrets", "member_users", "categories", "items", "pledges",
    "expenses", "expense_shares", "payments", "notifications", "notification_reads",
    "admin_votes", "polls", "poll_votes", "personal_items", "push_subscriptions",
]
# Every public RPC of SPEC §4.
EXPECTED_RPCS = {
    "my_trips", "create_trip", "preview_invite", "join_trip", "link_device", "get_device_code",
    "get_trip_snapshot", "update_trip", "rotate_invite", "update_member", "create_member",
    "set_role", "remove_member", "leave_trip", "vote_admin", "upsert_category",
    "delete_category", "add_item", "add_items_bulk", "update_item", "review_item", "delete_item",
    "pledge", "assign", "set_pledge_done", "set_item_done", "add_personal",
    "add_personal_template", "update_personal", "delete_personal", "add_expense",
    "update_expense", "delete_expense", "add_payment", "confirm_payment", "delete_payment",
    "send_announcement", "delete_notification", "mark_read", "create_poll", "vote_poll",
    "close_poll", "delete_poll", "save_push_subscription", "delete_push_subscription",
}
RLS_HELPERS = {"_my_member", "_is_member", "_is_admin"}
DEFAULT_CATEGORIES = [
    ("בשר ועוף", "🥩"), ("ירקות ופירות", "🥗"), ("מזווה ורטבים", "🥫"),
    ("נשנושים ומתוקים", "🍿"), ("שתייה ואלכוהול", "🥤"), ("מנגל ובישול", "🔥"),
    ("חד־פעמי", "🍽️"), ("ציוד קבוצתי", "⛺"), ("כיף ומשחקים", "🎲"), ("משימות", "📋"),
]


class RpcError(Exception):
    """A failed call. ``code`` is the RPC error code (raise exception '<code>') or the SQLSTATE."""

    def __init__(self, code: str, sqlstate: str | None, message: str):
        super().__init__(f"{code} ({sqlstate}): {message}")
        self.code = code
        self.sqlstate = sqlstate

    @classmethod
    def from_pg(cls, err: psycopg.Error) -> "RpcError":
        message = (err.diag.message_primary if err.diag else None) or str(err)
        code = message if err.sqlstate == "P0001" else (err.sqlstate or "unknown")
        return cls(code, err.sqlstate, message)


@contextmanager
def raises(code: str):
    """``with raises('forbidden'): actor.rpc(...)``"""
    try:
        yield
    except RpcError as err:
        assert err.code == code, f"expected {code!r}, got {err.code!r}: {err}"
    else:
        raise AssertionError(f"expected error {code!r}, but the call succeeded")


def _connect(uri: str) -> psycopg.Connection:
    conn = psycopg.connect(uri, autocommit=True, row_factory=dict_row)
    conn.adapters.register_loader("uuid", TextLoader)   # uuids come back as str
    return conn


class Db:
    """A test database. Plain methods run as the superuser (bypassing RLS)."""

    def __init__(self, conn: psycopg.Connection):
        self.conn = conn
        self._signatures: dict[str, dict[str, str]] = {}

    # --- superuser helpers -------------------------------------------------------------
    def sql(self, query: str, params=None) -> list[dict]:
        cur = self.conn.execute(query, params)
        return cur.fetchall() if cur.description else []

    def one(self, query: str, params=None) -> dict | None:
        rows = self.sql(query, params)
        assert len(rows) <= 1, rows
        return rows[0] if rows else None

    def val(self, query: str, params=None):
        row = self.one(query, params)
        return None if row is None else next(iter(row.values()))

    def count(self, table: str, where: str = "true", params=None) -> int:
        return self.val(f"select count(*) as n from public.{table} where {where}", params)

    def reset(self) -> None:
        self.conn.execute("truncate table public.trips cascade")

    def run_file(self, path: Path) -> None:
        self.conn.execute(path.read_text(encoding="utf-8"))

    # --- actors ----------------------------------------------------------------------
    def user(self, label: str = "") -> "Actor":
        return Actor(self, str(uuid.uuid4()), "authenticated", label)

    def anon(self) -> "Actor":
        return Actor(self, None, "anon", "anon")

    def signature(self, fn: str) -> dict[str, str]:
        if fn not in self._signatures:
            row = self.one(
                """select p.proargnames as names,
                          array(select format_type(t, null)
                                from unnest(p.proargtypes::oid[]) with ordinality u(t, o)
                                order by o) as types
                   from pg_proc p
                   where p.proname = %s and p.pronamespace = 'public'::regnamespace""",
                [fn])
            assert row, f"function public.{fn} does not exist"
            self._signatures[fn] = dict(zip(row["names"] or [], row["types"]))
        return self._signatures[fn]


def _arg_expr(name: str, typ: str) -> str:
    src = f"(%(payload)s::jsonb -> '{name}')"
    if typ in ("jsonb", "json"):
        return f"nullif({src}, 'null'::jsonb)"
    if typ.endswith("[]"):
        return (f"(case when jsonb_typeof({src}) = 'array' "
                f"then array(select jsonb_array_elements_text({src})) end)::{typ}")
    return f"(%(payload)s::jsonb ->> '{name}')::{typ}"


class Actor:
    """An auth user (role authenticated) or anon."""

    def __init__(self, db: Db, uid: str | None, role: str, label: str = ""):
        self.db = db
        self.uid = uid
        self.role = role
        self.label = label
        self.mid: str | None = None     # member id in the "current" test trip (set by helpers)

    def __repr__(self) -> str:
        return f"Actor({self.label or self.uid})"

    @contextmanager
    def _session(self):
        conn = self.db.conn
        try:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("select set_config('request.jwt.claim.sub', %s, true)",
                                [self.uid or ""])
                    cur.execute(f"set local role {self.role}")
                    yield cur
        except psycopg.Error as err:
            raise RpcError.from_pg(err) from None

    def rpc(self, fn: str, **params):
        signature = self.db.signature(fn)
        unknown = set(params) - set(signature)
        assert not unknown, f"{fn} has no parameter(s) {unknown}"
        args = ", ".join(f"{name} => {_arg_expr(name, signature[name])}" for name in params)
        payload = json.dumps(params, default=str, ensure_ascii=False)
        with self._session() as cur:
            cur.execute(f"select public.{fn}({args}) as result", {"payload": payload})
            return cur.fetchone()["result"]

    def query(self, sql: str, params=None) -> list[dict]:
        """Arbitrary SQL as this user (subject to grants + RLS)."""
        with self._session() as cur:
            cur.execute(sql, params)
            return cur.fetchall() if cur.description else []

    def execute(self, sql: str, params=None) -> int:
        """Arbitrary statement as this user; returns rowcount."""
        with self._session() as cur:
            cur.execute(sql, params)
            return cur.rowcount

    def snap(self, trip_id: str) -> dict:
        return self.rpc("get_trip_snapshot", p_trip=trip_id)


# --- fixtures ------------------------------------------------------------------------

@pytest.fixture(scope="session")
def pg_server(tmp_path_factory):
    server = pgserver.get_server(tmp_path_factory.mktemp("pg") / "data", cleanup_mode="stop")
    with _connect(server.get_uri()) as admin:
        # Throwaway test cluster: durability is irrelevant, speed is not.
        for setting in ("fsync", "synchronous_commit", "full_page_writes"):
            admin.execute(f"alter system set {setting} = off")
        admin.execute("select pg_reload_conf()")
    yield server
    server.cleanup()


@pytest.fixture(scope="session")
def templates(pg_server):
    """Creates medura_stub (Supabase emulation) and medura_tpl (stub + schema)."""
    with _connect(pg_server.get_uri()) as admin:
        for name in ("medura_tpl", "medura_stub"):
            admin.execute(f"drop database if exists {name}")
        admin.execute("create database medura_stub")
        with _connect(pg_server.get_uri("medura_stub")) as conn:
            conn.execute(STUB_SQL.read_text(encoding="utf-8"))
        admin.execute("create database medura_tpl template medura_stub")
        with _connect(pg_server.get_uri("medura_tpl")) as conn:
            conn.execute(SCHEMA_SQL.read_text(encoding="utf-8"))
    return {"stub": "medura_stub", "schema": "medura_tpl"}


def create_database(pg_server, name: str, template: str) -> Db:
    with _connect(pg_server.get_uri()) as admin:
        admin.execute(f"drop database if exists {name} with (force)")
        admin.execute(f"create database {name} template {template}")
    return Db(_connect(pg_server.get_uri(name)))


def drop_database(pg_server, name: str) -> None:
    with _connect(pg_server.get_uri()) as admin:
        admin.execute(f"drop database if exists {name} with (force)")


@pytest.fixture(scope="module")
def module_db(pg_server, templates, request):
    name = "t_" + re.sub(r"\W", "_", request.module.__name__.rsplit(".", 1)[-1]).lower()[:50]
    db = create_database(pg_server, name, templates["schema"])
    yield db
    db.conn.close()
    drop_database(pg_server, name)


@pytest.fixture
def db(module_db) -> Db:
    module_db.reset()
    return module_db


# --- scenario helpers ----------------------------------------------------------------

def profile(name: str, headcount: int = 1, **extra) -> dict:
    return {"display_name": name, "headcount": headcount, **extra}


class Trip:
    def __init__(self, db: Db, trip_id: str, owner: Actor):
        self.db = db
        self.id = trip_id
        self.owner = owner

    @property
    def code(self) -> str:
        return self.db.val("select invite_code from trips where id = %s", [self.id])

    def join(self, name: str, headcount: int = 1, **extra) -> Actor:
        actor = self.db.user(name)
        res = actor.rpc("join_trip", p_code=self.code, p_profile=profile(name, headcount, **extra))
        actor.mid = res["member_id"]
        return actor

    def admin(self, name: str = "admin", headcount: int = 1) -> Actor:
        actor = self.join(name, headcount)
        self.owner.rpc("set_role", p_member=actor.mid, p_role="admin")
        return actor

    def category(self, name: str) -> str:
        return self.db.val("select id from categories where trip_id = %s and name = %s",
                           [self.id, name])

    def settings(self, **settings) -> None:
        self.owner.rpc("update_trip", p_trip=self.id, p_patch={"settings": settings})


def new_trip(db: Db, name: str = "קמפינג בדיקה", owner_name: str = "מארגנ/ת",
             headcount: int = 2, **trip_fields) -> Trip:
    owner = db.user(owner_name)
    res = owner.rpc("create_trip", p_trip={"name": name, **trip_fields},
                    p_profile=profile(owner_name, headcount))
    owner.mid = res["member_id"]
    return Trip(db, res["trip_id"], owner)


@pytest.fixture
def trip(db) -> Trip:
    return new_trip(db)
