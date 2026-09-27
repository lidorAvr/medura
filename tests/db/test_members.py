"""update_trip, rotate_invite, update_member, create_member, set_role, remove_member, vote_admin."""
from conftest import new_trip, profile, raises


def test_update_trip_admin_only(db):
    t = new_trip(db)
    guest = t.join("אורח")
    with raises("forbidden"):
        guest.rpc("update_trip", p_trip=t.id, p_patch={"name": "שלי"})
    t.owner.rpc("update_trip", p_trip=t.id, p_patch={
        "name": "קמפינג סוכות", "emoji": "🔥", "location": "פארק החבשושיות",
        "location_url": "https://waze.com/ul?q=x", "lat": 32.09, "lon": 34.78,
        "starts_at": "2026-10-01T09:00:00+03:00", "ends_at": "2026-10-02T12:00:00+03:00",
        "info": {"schedule": [{"time": "09:00", "label": "הגעה", "emoji": "🚗"}],
                 "rules": [{"emoji": "🚫", "text": "בלי מוזיקה"}]},
        "settings": {"require_approval": False},
        "invite_code": "hacked", "rev": 999, "unknown": 1})
    trip = guest.snap(t.id)["trip"]
    assert trip["name"] == "קמפינג סוכות" and trip["emoji"] == "🔥"
    assert trip["lat"] == 32.09 and trip["lon"] == 34.78
    assert trip["location_url"] == "https://waze.com/ul?q=x"
    assert trip["info"] == {"schedule": [{"time": "09:00", "label": "הגעה", "emoji": "🚗"}],
                            "rules": [{"emoji": "🚫", "text": "בלי מוזיקה"}], "notes": ""}
    assert trip["settings"] == {"require_approval": False}
    assert trip["invite_code"] != "hacked" and trip["rev"] < 999
    # partial patches keep the other fields; info keys merge
    t.owner.rpc("update_trip", p_trip=t.id, p_patch={"info": {"notes": "להביא סבלנות"}})
    trip = guest.snap(t.id)["trip"]
    assert trip["name"] == "קמפינג סוכות"
    assert trip["info"]["notes"] == "להביא סבלנות" and len(trip["info"]["schedule"]) == 1
    # clearing optional fields
    t.owner.rpc("update_trip", p_trip=t.id, p_patch={"lat": None, "location": ""})
    trip = guest.snap(t.id)["trip"]
    assert trip["lat"] is None and trip["location"] is None


def test_update_trip_validation(db):
    t = new_trip(db)
    bad = [{"name": None}, {"name": "x" * 61}, {"lat": 91}, {"lon": -181},
           {"location_url": "http://insecure.example"}, {"info": "text"},
           {"info": {"schedule": "no"}}, {"settings": {"require_approval": "yes"}},
           {"starts_at": "not a date"}, {"starts_at": "2026-10-03T00:00:00Z",
                                         "ends_at": "2026-10-01T00:00:00Z"}]
    for patch in bad:
        with raises("invalid_input"):
            t.owner.rpc("update_trip", p_trip=t.id, p_patch=patch)


def test_rotate_invite(db):
    t = new_trip(db)
    guest = t.join("אורח")
    old = t.code
    with raises("forbidden"):
        guest.rpc("rotate_invite", p_trip=t.id)
    new = t.owner.rpc("rotate_invite", p_trip=t.id)
    assert new != old and len(new) == 10 and new == t.code
    with raises("invalid_code"):
        db.user().rpc("preview_invite", p_code=old)
    with raises("invalid_code"):
        db.user().rpc("join_trip", p_code=old, p_profile=profile("x"))
    assert db.user().rpc("preview_invite", p_code=new)["trip"]["id"] == t.id


def test_update_member_self_or_admin(db):
    t = new_trip(db)
    a = t.join("א")
    b = t.join("ב")
    a.rpc("update_member", p_member=a.mid, p_patch={
        "display_name": "אלון והדס", "headcount": 2, "people": ["אלון", " הדס ", ""],
        "emoji": "🦊", "color": "#3A86FF", "phone": "+972 50-123-4567",
        "prefs": {"diet": "צמחוני", "notify": {"money": True}},
        "inventory": ["מנגל", "רמקול", "מנגל"], "role": "owner", "claimed_at": None})
    m = db.one("select * from members where id = %s", [a.mid])
    assert m["display_name"] == "אלון והדס" and m["headcount"] == 2
    assert m["people"] == ["אלון", "הדס"]
    assert m["inventory"] == ["מנגל", "רמקול"]
    assert m["prefs"] == {"diet": "צמחוני", "notify": {"money": True}}
    assert m["role"] == "member" and m["claimed_at"] is not None
    # prefs merge key by key
    a.rpc("update_member", p_member=a.mid, p_patch={"prefs": {"quiet_hours": None}})
    assert db.val("select prefs from members where id = %s", [a.mid]) == {
        "diet": "צמחוני", "notify": {"money": True}, "quiet_hours": None}
    with raises("forbidden"):
        b.rpc("update_member", p_member=a.mid, p_patch={"display_name": "גנב"})
    t.owner.rpc("update_member", p_member=a.mid, p_patch={"headcount": 5})
    assert db.val("select headcount from members where id = %s", [a.mid]) == 5
    with raises("not_found"):
        a.rpc("update_member", p_member="00000000-0000-0000-0000-000000000000", p_patch={})


def test_update_member_validation(db):
    t = new_trip(db)
    bad = [{"display_name": ""}, {"display_name": "x" * 41}, {"headcount": 0},
           {"headcount": 9}, {"headcount": 1.5}, {"people": "הדס"}, {"people": ["x"] * 9},
           {"color": "#12345"}, {"phone": "call me"}, {"prefs": []}, {"emoji": None},
           {"inventory": [{"x": 1}]}]
    for patch in bad:
        with raises("invalid_input"):
            t.owner.rpc("update_member", p_member=t.owner.mid, p_patch=patch)


def test_create_member_placeholder(db):
    t = new_trip(db)
    guest = t.join("אורח")
    with raises("forbidden"):
        guest.rpc("create_member", p_trip=t.id, p_profile=profile("זיו"))
    mid = t.owner.rpc("create_member", p_trip=t.id,
                      p_profile=profile("זיו", inventory=["גזיבו", "תאורה"]))
    m = next(x for x in guest.snap(t.id)["members"] if x["id"] == mid)
    assert m["claimed"] is False and m["role"] == "member"
    assert m["inventory"] == ["גזיבו", "תאורה"]
    assert [u["id"] for u in db.user().rpc("preview_invite", p_code=t.code)["unclaimed"]] == [mid]


def test_set_role_promote_and_demote(db):
    t = new_trip(db)
    a = t.join("א")
    with raises("forbidden"):
        a.rpc("set_role", p_member=a.mid, p_role="admin")
    with raises("invalid_input"):
        t.owner.rpc("set_role", p_member=a.mid, p_role="owner")
    t.owner.rpc("set_role", p_member=a.mid, p_role="admin")
    snap = a.snap(t.id)
    assert snap["me"]["role"] == "admin"
    note = next(n for n in snap["notifications"] if n["title"] == "מונית למנהל/ת 👑")
    assert note["audience"] == [a.mid] and note["kind"] == "system"
    # promoting again is a no-op (no duplicate notification)
    t.owner.rpc("set_role", p_member=a.mid, p_role="admin")
    assert db.count("notifications", "title = 'מונית למנהל/ת 👑'") == 1
    # the new admin can manage, and can step down while the owner remains
    a.rpc("update_trip", p_trip=t.id, p_patch={"emoji": "🌲"})
    a.rpc("set_role", p_member=a.mid, p_role="member")
    assert db.val("select role from members where id = %s", [a.mid]) == "member"


def test_owner_is_locked(db):
    t = new_trip(db)
    a = t.admin("א")
    with raises("owner_locked"):
        a.rpc("set_role", p_member=t.owner.mid, p_role="member")
    with raises("owner_locked"):
        a.rpc("remove_member", p_member=t.owner.mid)
    with raises("owner_locked"):
        t.owner.rpc("set_role", p_member=t.owner.mid, p_role="member")


def test_last_admin_is_protected(db):
    """Only possible without an owner (e.g. seeded trip after the owner left)."""
    t = new_trip(db)
    a = t.admin("א")
    b = t.join("ב")
    db.sql("update members set role = 'admin' where id = %s", [t.owner.mid])   # no owner left
    t.owner.rpc("set_role", p_member=t.owner.mid, p_role="member")
    with raises("last_admin"):
        a.rpc("set_role", p_member=a.mid, p_role="member")
    with raises("last_admin"):
        a.rpc("remove_member", p_member=a.mid)
    a.rpc("set_role", p_member=b.mid, p_role="admin")
    a.rpc("set_role", p_member=a.mid, p_role="member")
    assert db.val("select role from members where id = %s", [b.mid]) == "admin"


def test_remove_member(db):
    t = new_trip(db)
    a = t.join("א")
    b = t.join("ב")
    item = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "כסאות", "type": "bring",
                                                        "needed": 4})
    a.rpc("pledge", p_item=item, p_qty=2)
    a.rpc("vote_admin", p_candidate=b.mid, p_on=True)
    b.rpc("vote_admin", p_candidate=a.mid, p_on=True)
    a.rpc("add_personal", p_trip=t.id, p_title="מגבת")
    a_item = a.rpc("add_item", p_trip=t.id, p_item={"title": "הצעה", "type": "buy"})
    note = t.owner.rpc("send_announcement", p_trip=t.id, p_title="היי", p_body="")
    a.rpc("mark_read", p_trip=t.id, p_ids=[note])
    with raises("forbidden"):
        b.rpc("remove_member", p_member=a.mid)
    t.owner.rpc("remove_member", p_member=a.mid)
    assert db.count("members", "id = %s", [a.mid]) == 0
    for table in ("pledges", "admin_votes", "personal_items", "notification_reads", "member_users"):
        where = "voter_id = %s or candidate_id = %s" if table == "admin_votes" else "member_id = %s"
        params = [a.mid, a.mid] if table == "admin_votes" else [a.mid]
        assert db.count(table, where, params) == 0, table
    assert db.val("select created_by from items where id = %s", [a_item]) is None
    with raises("forbidden"):
        a.snap(t.id)
    with raises("not_found"):
        t.owner.rpc("remove_member", p_member=a.mid)


def test_remove_member_with_money_records(db):
    t = new_trip(db)
    payer = t.join("משלם")
    debtor = t.join("חייב")
    sharer = t.join("שותף")
    t.owner.rpc("add_expense", p_trip=t.id, p_exp={"title": "סופר", "amount": 100,
                                                    "paid_by": payer.mid})
    t.owner.rpc("add_expense", p_trip=t.id, p_exp={"title": "גז", "amount": 30,
                                                    "split_mode": "members",
                                                    "members": [{"member_id": sharer.mid}]})
    debtor.rpc("add_payment", p_trip=t.id, p_pay={"to_member": t.owner.mid, "amount": 20})
    for m in (payer, debtor, sharer):
        with raises("has_money_records"):
            t.owner.rpc("remove_member", p_member=m.mid)


def test_vote_admin(db):
    t = new_trip(db)
    a = t.join("א")
    b = t.join("ב")
    a.rpc("vote_admin", p_candidate=b.mid, p_on=True)
    a.rpc("vote_admin", p_candidate=b.mid, p_on=True)       # idempotent
    b.rpc("vote_admin", p_candidate=b.mid, p_on=True)       # self vote allowed
    votes = t.owner.snap(t.id)["admin_votes"]
    assert sorted((v["voter_id"], v["candidate_id"]) for v in votes) == sorted(
        [(a.mid, b.mid), (b.mid, b.mid)])
    a.rpc("vote_admin", p_candidate=b.mid, p_on=False)
    assert [(v["voter_id"], v["candidate_id"]) for v in a.snap(t.id)["admin_votes"]] == [
        (b.mid, b.mid)]
    other = new_trip(db, name="אחר")
    with raises("forbidden"):
        a.rpc("vote_admin", p_candidate=other.owner.mid, p_on=True)
    with raises("not_found"):
        a.rpc("vote_admin", p_candidate="00000000-0000-0000-0000-000000000000", p_on=True)
    with raises("invalid_input"):
        a.rpc("vote_admin", p_candidate=b.mid, p_on=None)
