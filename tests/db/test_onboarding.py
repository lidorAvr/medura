"""create_trip, preview_invite, join_trip, link_device, get_device_code, my_trips, leave_trip."""
from conftest import DEFAULT_CATEGORIES, new_trip, profile, raises


def test_create_trip_makes_owner_and_default_categories(db):
    owner = db.user()
    res = owner.rpc("create_trip",
                    p_trip={"name": "  פארק החבשושיות  ", "emoji": "🏕️", "location": "פארק החבשושיות",
                            "starts_at": "2026-10-01T09:00:00+03:00",
                            "ends_at": "2026-10-02T12:00:00+03:00",
                            "settings": {"require_approval": False}},
                    p_profile=profile("לידור ונועה", 2, people=["לידור", "נועה"],
                                      emoji="🔥", color="#F28C28", phone="050-1234567"))
    snap = owner.snap(res["trip_id"])
    assert snap["trip"]["name"] == "פארק החבשושיות"
    assert snap["trip"]["emoji"] == "🏕️"
    assert snap["trip"]["settings"] == {"require_approval": False}
    assert snap["trip"]["info"] == {"schedule": [], "rules": [], "notes": ""}
    assert len(snap["trip"]["invite_code"]) == 10
    assert snap["me"] == {"member_id": res["member_id"], "role": "owner", "user_id": owner.uid}
    [me] = snap["members"]
    assert me["role"] == "owner" and me["claimed"] is True
    assert me["headcount"] == 2 and me["people"] == ["לידור", "נועה"]
    assert me["phone"] == "050-1234567" and me["color"] == "#F28C28"
    cats = [(c["name"], c["emoji"], c["sort"]) for c in snap["categories"]]
    assert cats == [(n, e, i + 1) for i, (n, e) in enumerate(DEFAULT_CATEGORIES)]
    assert db.val("select created_by from trips where id = %s", [res["trip_id"]]) == owner.uid


def test_create_trip_validation(db):
    user = db.user()
    with raises("invalid_input"):
        user.rpc("create_trip", p_trip={"name": ""}, p_profile=profile("א"))
    with raises("invalid_input"):
        user.rpc("create_trip", p_trip={"name": "x" * 61}, p_profile=profile("א"))
    with raises("invalid_input"):
        user.rpc("create_trip", p_trip={"name": "טיול"}, p_profile=None)
    with raises("invalid_input"):
        user.rpc("create_trip", p_trip={"name": "טיול", "location_url": "javascript:alert(1)"},
                 p_profile=profile("א"))
    with raises("invalid_input"):
        user.rpc("create_trip", p_trip={"name": "טיול", "starts_at": "2026-10-02T00:00:00Z",
                                        "ends_at": "2026-10-01T00:00:00Z"}, p_profile=profile("א"))
    with raises("invalid_input"):
        user.rpc("create_trip", p_trip={"name": "טיול"}, p_profile=profile("א", headcount=9))
    with raises("invalid_input"):
        user.rpc("create_trip", p_trip={"name": "טיול"}, p_profile=profile("א", color="red"))
    with raises("invalid_input"):
        user.rpc("create_trip", p_trip={"name": "טיול", "lat": "north"}, p_profile=profile("א"))
    assert db.count("trips") == 0, "failed calls must not leave partial trips"


def test_create_trip_derives_display_name_from_people(db):
    user = db.user()
    res = user.rpc("create_trip", p_trip={"name": "טיול"},
                   p_profile={"people": ["הדס", "עידו"], "headcount": 2})
    assert db.val("select display_name from members where id = %s", [res["member_id"]]) == "הדס ועידו"


def test_preview_invite(db):
    t = new_trip(db, name="פארק החבשושיות", headcount=2)
    placeholder = t.owner.rpc("create_member", p_trip=t.id,
                              p_profile=profile("הדס ועידו", 2, people=["הדס", "עידו"]))
    stranger = db.user()
    preview = stranger.rpc("preview_invite", p_code=f"  {t.code.upper()} ")
    assert set(preview) == {"trip", "member_count", "headcount", "unclaimed", "my_member_id"}
    assert preview["trip"]["id"] == t.id and preview["trip"]["name"] == "פארק החבשושיות"
    assert set(preview["trip"]) == {"id", "name", "emoji", "location", "starts_at", "ends_at"}
    assert preview["member_count"] == 2
    assert preview["headcount"] == 4
    assert preview["unclaimed"] == [{"id": placeholder, "display_name": "הדס ועידו", "headcount": 2,
                                     "people": ["הדס", "עידו"], "emoji": "🙂",
                                     "color": "#2F6B4F"}]
    assert preview["my_member_id"] is None
    assert t.owner.rpc("preview_invite", p_code=t.code)["my_member_id"] == t.owner.mid
    with raises("invalid_code"):
        stranger.rpc("preview_invite", p_code="nope123456")
    with raises("invalid_code"):
        stranger.rpc("preview_invite", p_code=None)


def test_join_new_profile_notifies_admins(db):
    t = new_trip(db)
    admin = t.admin("מנהלת")
    guest = db.user()
    res = guest.rpc("join_trip", p_code=t.code,
                    p_profile=profile("אסף ועלמה", 2, people=["אסף", "עלמה"], emoji="🍺"))
    assert res["trip_id"] == t.id
    member = db.one("select * from members where id = %s", [res["member_id"]])
    assert member["role"] == "member" and member["claimed_at"] is not None
    assert member["headcount"] == 2 and member["emoji"] == "🍺"
    note = db.one("select * from notifications where title like %s", ["אסף ועלמה%"])
    assert note["title"] == "אסף ועלמה הצטרפ/ה לטיול 🎉"
    assert note["kind"] == "system"
    assert set(note["audience"]) == {t.owner.mid, admin.mid}
    assert note["link"] == f"#/t/{t.id}/people"
    # the admins see it, the new member does not
    assert any(n["id"] == note["id"] for n in admin.snap(t.id)["notifications"])
    assert all(n["id"] != note["id"] for n in guest.snap(t.id)["notifications"])


def test_join_requires_profile_when_not_claiming(db):
    t = new_trip(db)
    with raises("invalid_input"):
        db.user().rpc("join_trip", p_code=t.code)
    with raises("invalid_code"):
        db.user().rpc("join_trip", p_code="aaaaaaaaaa", p_profile=profile("x"))


def test_join_claim_placeholder(db):
    t = new_trip(db)
    placeholder = t.owner.rpc("create_member", p_trip=t.id,
                              p_profile=profile("הדס ועידו", 2, people=["הדס", "עידו"]))
    dana = db.user()
    res = dana.rpc("join_trip", p_code=t.code, p_claim_member=placeholder,
                   p_profile={"phone": "0521234567", "emoji": "🛒", "role": "owner"})
    assert res == {"trip_id": t.id, "member_id": placeholder}
    member = db.one("select * from members where id = %s", [placeholder])
    assert member["claimed_at"] is not None
    assert member["phone"] == "0521234567" and member["emoji"] == "🛒"
    assert member["role"] == "member", "role cannot be set through a profile patch"
    assert member["display_name"] == "הדס ועידו"
    # already claimed by someone else
    with raises("already_claimed"):
        db.user().rpc("join_trip", p_code=t.code, p_claim_member=placeholder)
    # a member id of another trip
    other = new_trip(db, name="אחר")
    with raises("not_found"):
        db.user().rpc("join_trip", p_code=t.code, p_claim_member=other.owner.mid)


def test_rejoin_is_idempotent(db):
    t = new_trip(db)
    guest = t.join("אורח")
    again = guest.rpc("join_trip", p_code=t.code, p_profile=profile("שם אחר"))
    assert again == {"trip_id": t.id, "member_id": guest.mid}
    assert db.count("members", "trip_id = %s", [t.id]) == 2
    assert db.val("select display_name from members where id = %s", [guest.mid]) == "אורח"


def _seeded_trip_without_owner(db):
    trip_id = db.val("""insert into trips (name, invite_code) values ('סידור מראש', 'seedcode22')
                        returning id""")
    ids = [db.val("""insert into members (trip_id, display_name, headcount)
                     values (%s, %s, 2) returning id""", [trip_id, name])
           for name in ("תומר ושקד", "הדס ועידו")]
    return trip_id, ids


def test_first_joiner_of_ownerless_trip_becomes_owner(db):
    trip_id, _ = _seeded_trip_without_owner(db)
    first = db.user()
    res = first.rpc("join_trip", p_code="seedcode22", p_profile=profile("לידור", 2))
    assert db.val("select role from members where id = %s", [res["member_id"]]) == "owner"
    assert db.count("notifications", "trip_id = %s", [trip_id]) == 0, "nobody else to notify"
    second = db.user()
    res2 = second.rpc("join_trip", p_code="seedcode22", p_profile=profile("זיו"))
    assert db.val("select role from members where id = %s", [res2["member_id"]]) == "member"
    note = db.one("select * from notifications where trip_id = %s", [trip_id])
    assert note["audience"] == [res["member_id"]]


def test_first_claimer_of_ownerless_trip_becomes_owner(db):
    trip_id, (omer, dana) = _seeded_trip_without_owner(db)
    db.user().rpc("join_trip", p_code="seedcode22", p_claim_member=omer)
    db.user().rpc("join_trip", p_code="seedcode22", p_claim_member=dana)
    roles = {r["id"]: r["role"] for r in db.sql("select id, role from members")}
    assert roles == {omer: "owner", dana: "member"}


def test_device_code_and_link_device(db):
    t = new_trip(db, headcount=2)
    code = t.owner.rpc("get_device_code", p_member=t.owner.mid)
    assert len(code) == 10
    assert t.owner.rpc("get_device_code", p_member=t.owner.mid) == code, "stable per member"
    partner = db.user()
    res = partner.rpc("link_device", p_device_code=code.upper())
    assert res == {"trip_id": t.id, "member_id": t.owner.mid}
    assert partner.snap(t.id)["me"]["member_id"] == t.owner.mid
    assert partner.snap(t.id)["me"]["role"] == "owner"
    assert db.count("member_users", "member_id = %s", [t.owner.mid]) == 2
    # linking twice is harmless
    assert partner.rpc("link_device", p_device_code=code) == res
    with raises("invalid_code"):
        partner.rpc("link_device", p_device_code="zzzzzzzzzz")


def test_get_device_code_only_for_self(db):
    t = new_trip(db)
    guest = t.join("אורח")
    with raises("forbidden"):
        guest.rpc("get_device_code", p_member=t.owner.mid)
    with raises("forbidden"):
        t.owner.rpc("get_device_code", p_member=guest.mid)      # not even admins
    with raises("forbidden"):
        db.user().rpc("get_device_code", p_member=guest.mid)
    with raises("not_found"):
        guest.rpc("get_device_code", p_member="00000000-0000-0000-0000-000000000000")


def test_link_device_moves_user_and_releases_old_profile(db):
    t = new_trip(db)
    couple = t.join("הדס ועידו", 2)
    code = couple.rpc("get_device_code", p_member=couple.mid)
    gabi = t.join("עידו")                     # joined separately by mistake
    gabi.rpc("link_device", p_device_code=code)
    assert gabi.snap(t.id)["me"]["member_id"] == couple.mid
    old = db.one("select * from members where id = %s", [gabi.mid])
    assert old["claimed_at"] is None, "abandoned profile becomes unclaimed"
    assert db.count("member_users", "user_id = %s", [gabi.uid]) == 1


def test_link_device_carries_owner_role(db):
    t = new_trip(db, owner_name="לידור")
    couple = t.join("לידור ונועה", 2)
    code = couple.rpc("get_device_code", p_member=couple.mid)
    t.owner.rpc("link_device", p_device_code=code)
    roles = {r["id"]: r["role"] for r in db.sql("select id, role from members")}
    assert roles[couple.mid] == "owner"
    assert roles[t.owner.mid] == "member"


def test_my_trips(db):
    user = db.user()
    later = user.rpc("create_trip", p_trip={"name": "מאוחר", "starts_at": "2027-01-01T10:00:00Z"},
                     p_profile=profile("אני"))
    sooner = user.rpc("create_trip", p_trip={"name": "קרוב", "starts_at": "2026-10-01T10:00:00Z"},
                      p_profile=profile("אני", emoji="🦊"))
    new_trip(db, name="של מישהו אחר")
    trips = user.rpc("my_trips")
    assert [x["trip"]["name"] for x in trips] == ["קרוב", "מאוחר"]
    first = trips[0]
    assert set(first["trip"]) == {"id", "name", "emoji", "location", "starts_at", "ends_at"}
    assert first["member"] == {"id": sooner["member_id"], "display_name": "אני", "emoji": "🦊",
                               "color": "#2F6B4F", "role": "owner"}
    assert trips[1]["trip"]["id"] == later["trip_id"]
    assert db.user().rpc("my_trips") == []


def test_leave_trip(db):
    t = new_trip(db)
    guest = t.join("אורח")
    old_code = guest.rpc("get_device_code", p_member=guest.mid)
    guest.rpc("leave_trip", p_trip=t.id)
    assert db.val("select claimed_at from members where id = %s", [guest.mid]) is None
    with raises("invalid_code"):
        db.user().rpc("link_device", p_device_code=old_code)   # released profile: code revoked
    assert guest.rpc("my_trips") == []
    with raises("forbidden"):
        guest.snap(t.id)
    with raises("forbidden"):
        guest.rpc("leave_trip", p_trip=t.id)
    # the profile can be claimed again
    back = db.user()
    back.rpc("join_trip", p_code=t.code, p_claim_member=guest.mid)
    assert back.snap(t.id)["me"]["member_id"] == guest.mid


def test_leave_keeps_claim_while_another_device_is_linked(db):
    t = new_trip(db)
    couple = t.join("זוג", 2)
    partner = db.user()
    partner.rpc("link_device", p_device_code=couple.rpc("get_device_code", p_member=couple.mid))
    partner.rpc("leave_trip", p_trip=t.id)
    assert db.val("select claimed_at from members where id = %s", [couple.mid]) is not None


def test_owner_leaving_requires_another_admin(db):
    t = new_trip(db)
    guest = t.join("אורח")
    with raises("last_admin"):
        t.owner.rpc("leave_trip", p_trip=t.id)
    t.owner.rpc("set_role", p_member=guest.mid, p_role="admin")
    t.owner.rpc("leave_trip", p_trip=t.id)
    assert t.owner.rpc("my_trips") == []
    roles = {r["id"]: (r["role"], r["claimed_at"] is None) for r in db.sql(
        "select id, role, claimed_at from members")}
    assert roles == {guest.mid: ("owner", False), t.owner.mid: ("member", True)},         "ownership passes to the remaining admin"
    # whoever claims the abandoned profile later gets no special powers
    claimer = db.user()
    claimer.rpc("join_trip", p_code=t.code, p_claim_member=t.owner.mid)
    assert claimer.snap(t.id)["me"]["role"] == "member"


def test_admin_leaving_last_device_is_demoted(db):
    t = new_trip(db)
    admin = t.admin("מנהלת")
    admin.rpc("leave_trip", p_trip=t.id)
    assert db.val("select role from members where id = %s", [admin.mid]) == "member"
    assert db.val("select role from members where id = %s", [t.owner.mid]) == "owner"


def test_owner_with_linked_partner_can_leave(db):
    t = new_trip(db)
    partner = db.user()
    partner.rpc("link_device", p_device_code=t.owner.rpc("get_device_code", p_member=t.owner.mid))
    t.owner.rpc("leave_trip", p_trip=t.id)
    assert partner.snap(t.id)["me"]["role"] == "owner"


def test_member_limit(db):
    t = new_trip(db)
    db.sql("""insert into members (trip_id, display_name)
              select %s, 'm' || g from generate_series(1, 59) g""", [t.id])
    with raises("limit_reached"):
        db.user().rpc("join_trip", p_code=t.code, p_profile=profile("61"))
    with raises("limit_reached"):
        t.owner.rpc("create_member", p_trip=t.id, p_profile=profile("61"))
