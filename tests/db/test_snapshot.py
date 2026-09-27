"""get_trip_snapshot returns exactly the SPEC §5 shape (key sets), arrays never null."""
from conftest import new_trip

TOP_KEYS = {"trip", "me", "members", "categories", "items", "pledges", "expenses",
            "expense_shares", "payments", "notifications", "reads", "admin_votes", "polls",
            "poll_votes", "personal_items"}
SHAPES = {
    "trip": {"id", "name", "emoji", "location", "location_url", "lat", "lon", "starts_at",
             "ends_at", "info", "settings", "invite_code", "rev", "created_at"},
    "me": {"member_id", "role", "user_id"},
    "members": {"id", "display_name", "headcount", "people", "emoji", "color", "role", "phone",
                "prefs", "inventory", "claimed", "created_at"},
    "categories": {"id", "name", "emoji", "sort", "default_buyer_id", "note"},
    "items": {"id", "category_id", "title", "note", "type", "qty", "unit", "per_person", "needed",
              "status", "done", "done_at", "reject_reason", "created_by", "approved_by", "sort",
              "created_at", "updated_at"},
    "pledges": {"id", "item_id", "member_id", "qty", "done", "assigned_by", "created_at"},
    "expenses": {"id", "title", "amount", "paid_by", "category_id", "note", "split_mode",
                 "created_by", "spent_on", "created_at"},
    "expense_shares": {"expense_id", "member_id", "weight"},
    "payments": {"id", "from_member", "to_member", "amount", "method", "note", "status",
                 "created_by", "created_at", "confirmed_at"},
    "notifications": {"id", "kind", "title", "body", "audience", "author_member", "urgent", "link",
                      "created_at"},
    "reads": {"notification_id", "member_id", "read_at"},
    "admin_votes": {"voter_id", "candidate_id"},
    "polls": {"id", "question", "options", "multi", "closed", "created_by", "created_at"},
    "poll_votes": {"poll_id", "member_id", "option_id"},
    "personal_items": {"id", "title", "done", "sort", "created_at"},
}


def test_empty_trip_snapshot_has_arrays_not_nulls(db):
    t = new_trip(db)
    snap = t.owner.snap(t.id)
    assert set(snap) == TOP_KEYS
    for key in TOP_KEYS - {"trip", "me"}:
        assert isinstance(snap[key], list), key
    assert len(snap["members"]) == 1 and len(snap["categories"]) == 10
    for key in ("items", "pledges", "expenses", "expense_shares", "payments", "notifications",
                "reads", "admin_votes", "polls", "poll_votes", "personal_items"):
        assert snap[key] == [], key
    assert set(snap["trip"]) == SHAPES["trip"]
    assert set(snap["me"]) == SHAPES["me"]


def test_full_snapshot_key_sets_match_spec(db):
    t = new_trip(db, starts_at="2026-10-01T09:00:00+03:00", lat=32.09, lon=34.78)
    g = t.join("אורח", 2, people=["אסף", "עלמה"], inventory=["מטקות"])
    item = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "בשר", "qty": 300,
                                                        "unit": "גרם", "per_person": True,
                                                        "category_id": t.category("בשר ועוף")})
    g.rpc("pledge", p_item=item)
    exp = t.owner.rpc("add_expense", p_trip=t.id, p_exp={
        "title": "סופר", "amount": 99.9, "split_mode": "members", "members": [g.mid]})
    assert exp
    g.rpc("add_payment", p_trip=t.id, p_pay={"to_member": t.owner.mid, "amount": 20})
    nid = t.owner.rpc("send_announcement", p_trip=t.id, p_title="שלום", p_body="")
    g.rpc("mark_read", p_trip=t.id, p_ids=[nid])
    g.rpc("vote_admin", p_candidate=g.mid, p_on=True)
    poll = g.rpc("create_poll", p_trip=t.id, p_question="?", p_options=["כן", "לא"])
    g.rpc("vote_poll", p_poll=poll, p_option_ids=["o1"])
    g.rpc("add_personal", p_trip=t.id, p_title="כובע")

    snap = g.snap(t.id)
    assert set(snap) == TOP_KEYS
    for key, shape in SHAPES.items():
        rows = snap[key] if isinstance(snap[key], list) else [snap[key]]
        assert rows, f"expected data in {key}"
        for row in rows:
            assert set(row) == shape, (key, set(row) ^ shape)

    assert snap["me"] == {"member_id": g.mid, "role": "member", "user_id": g.uid}
    trip = snap["trip"]
    assert trip["lat"] == 32.09 and isinstance(trip["rev"], int)
    assert trip["starts_at"].startswith("2026-10-01T06:00:00")      # ISO, UTC offset
    member = next(m for m in snap["members"] if m["id"] == g.mid)
    assert member["people"] == ["אסף", "עלמה"] and member["inventory"] == ["מטקות"]
    assert member["prefs"] == {} and member["claimed"] is True
    snap_item = next(i for i in snap["items"] if i["id"] == item)
    assert snap_item["qty"] == 300 and snap_item["per_person"] is True
    assert snap["expenses"][0]["amount"] == 99.9
    assert snap["expense_shares"][0]["weight"] == 2
    assert snap["polls"][0]["options"] == [{"id": "o1", "label": "כן"}, {"id": "o2", "label": "לא"}]
    note = next(n for n in snap["notifications"] if n["id"] == nid)
    assert note["audience"] is None


def test_every_mutation_bumps_rev_seen_in_snapshot(db):
    t = new_trip(db)
    rev0 = t.owner.snap(t.id)["trip"]["rev"]
    item = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "א"})
    t.owner.rpc("pledge", p_item=item)
    t.owner.rpc("set_item_done", p_item=item, p_done=True)
    assert t.owner.snap(t.id)["trip"]["rev"] == rev0 + 3
