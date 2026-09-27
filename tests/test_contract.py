"""Cross-check: every rpc() call in js/api/supabase-api.js matches a function in supabase/schema.sql.

The API wrapper and the SQL were written independently against SPEC §4; a mismatch in an RPC name or
a parameter name only shows up at runtime against the real Supabase (PostgREST returns 404 / PGRST202).
This test catches that offline.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8")
JS = (ROOT / "js" / "api" / "supabase-api.js").read_text(encoding="utf-8")

FUNC_RE = re.compile(
    r"create\s+or\s+replace\s+function\s+public\.([a-z_][a-z0-9_]*)\s*\((.*?)\)\s*returns",
    re.IGNORECASE | re.DOTALL,
)
RPC_RE = re.compile(r"rpc\(\s*'([a-z_]+)'\s*,\s*\{(.*?)\}\s*\)", re.DOTALL)


def sql_functions() -> dict[str, dict[str, bool]]:
    """name -> {param_name: has_default} for public, non-underscore functions."""
    out: dict[str, dict[str, bool]] = {}
    for name, args in FUNC_RE.findall(SQL):
        if name.startswith("_"):
            continue
        params: dict[str, bool] = {}
        for raw in filter(None, (a.strip() for a in args.split(","))):
            pname = raw.split()[0]
            params[pname] = bool(re.search(r"\bdefault\b|=", raw, re.IGNORECASE))
        out[name] = params
    return out


def js_calls() -> dict[str, set[str]]:
    calls: dict[str, set[str]] = {}
    for name, body in RPC_RE.findall(JS):
        keys = set(re.findall(r"\b(p_[a-z_]+)\s*:", body))
        calls.setdefault(name, set()).update(keys)
    return calls


def test_every_js_rpc_exists_in_sql_with_matching_params():
    funcs, calls = sql_functions(), js_calls()
    assert len(calls) >= 45, f"expected >=45 rpc calls in supabase-api.js, found {len(calls)}"
    problems = []
    for name, keys in sorted(calls.items()):
        if name not in funcs:
            problems.append(f"{name}: not defined in schema.sql")
            continue
        params = funcs[name]
        unknown = keys - params.keys()
        missing_required = {p for p, has_default in params.items() if not has_default} - keys
        if unknown:
            problems.append(f"{name}: JS sends unknown params {sorted(unknown)}")
        if missing_required:
            problems.append(f"{name}: JS omits required params {sorted(missing_required)}")
    assert not problems, "\n".join(problems)


def test_every_granted_sql_rpc_is_used_by_the_client():
    granted = set(re.findall(r"public\.([a-z][a-z0-9_]*)\(", SQL.split("grant execute on function", 1)[1].split(";", 1)[0]))
    unused = granted - js_calls().keys()
    assert not unused, f"RPCs granted to clients but never called by supabase-api.js: {sorted(unused)}"
