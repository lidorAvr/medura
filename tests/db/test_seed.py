"""private/seed_trip.sql: loads on top of the schema, has the expected content, and works
with the real onboarding flow (first joiner becomes owner, friends claim their profiles).

The friends' real names and the real place never go into the repo: they are read from
private/seed_names.json, {"trip_name": ..., "location": ..., "members": [the 5 seeded display names,
in seed order]}. Without it (or the seed) this module skips.
"""
import json
from collections import Counter

import pytest

from conftest import SEED_SQL, profile, raises

NAMES_FILE = SEED_SQL.with_name("seed_names.json")
pytestmark = pytest.mark.skipif(not (SEED_SQL.exists() and NAMES_FILE.exists()),
                                reason="private seed files not present")

PRIVATE = json.loads(NAMES_FILE.read_text(encoding="utf-8")) if NAMES_FILE.exists() else {}
TRIP_NAME = PRIVATE.get("trip_name", "")
LOCATION = PRIVATE.get("location", "")
PLACEHOLDERS = PRIVATE.get("members", [""] * 5)
# A..E = the seeded profiles in seed order; B is the couple buying most of the food, C proposed items,
# D and E are the smaller families.
A, B, C, D, E = PLACEHOLDERS
ITEMS_PER_CATEGORY = {
    "בשר ועוף": 6, "ירקות ופירות": 9, "מזווה ורטבים": 6, "נשנושים ומתוקים": 5, "חד־פעמי": 11,
    "שתייה ואלכוהול": 6, "מנגל ובישול": 15, "ציוד קבוצתי": 5, "כיף ומשחקים": 3, "משימות": 3,
}
PLEDGES_PER_MEMBER = {B: 37, C: 12, A: 12, D: 2, E: 4}


def run_seed(db):
    """Runs the seed file like the SQL editor does; returns (last result rows, notices)."""
    notices = []

    def on_notice(diag):
        notices.append(diag.message_primary)

    db.conn.add_notice_handler(on_notice)
    try:
        cur = db.conn.execute(SEED_SQL.read_text(encoding="utf-8"))
        rows = cur.fetchall() if cur.description else []
        while cur.nextset():
            if cur.description:
                rows = cur.fetchall()
    finally:
        db.conn.remove_notice_handler(on_notice)
    return rows, notices


@pytest.fixture
def seeded(db):
    rows, notices = run_seed(db)
    trip = db.one("select * from trips where name = %s", [TRIP_NAME])
    return {"db": db, "trip": trip, "rows": rows, "notices": notices}


def test_seed_prints_invite_link(seeded):
    code = seeded["trip"]["invite_code"]
    assert len(code) == 10
    assert seeded["rows"] == [{"invite_code": code,
                               "invite_link": f"https://lidoravr.github.io/medura/#/join/{code}"}]
    assert any(code in n and "#/join/" in n for n in seeded["notices"])


def test_seed_is_rerunnable(seeded):
    db = seeded["db"]
    rows, notices = run_seed(db)
    assert db.count("trips") == 1 and db.count("items") == 69
    assert rows[0]["invite_code"] == seeded["trip"]["invite_code"]
    assert any("Already seeded" in n for n in notices)


def test_seed_trip_members_categories(seeded):
    db, trip = seeded["db"], seeded["trip"]
    assert trip["created_by"] is None
    assert trip["location"] == LOCATION and trip["location_url"].startswith("https://waze.com/")
    assert trip["settings"] == {"require_approval": True}
    assert len(trip["info"]["schedule"]) == 7 and len(trip["info"]["rules"]) == 7
    assert trip["info"]["notes"].startswith("חישוב בשר")
    members = db.sql("select * from members order by created_at")
    assert [m["display_name"] for m in members] == PLACEHOLDERS
    assert all(m["claimed_at"] is None and m["role"] == "member" for m in members)
    assert sum(m["headcount"] for m in members) == 9
    inventory = {m["display_name"]: m["inventory"] for m in members}
    assert "נפנף" in inventory[D] and "גזיבו" in inventory[E]
    buyers = {r["name"]: r["buyer"] for r in db.sql(
        """select c.name, m.display_name as buyer from categories c
           left join members m on m.id = c.default_buyer_id order by c.sort""")}
    assert len(buyers) == 10
    assert [n for n, b in buyers.items() if b == B] == [
        "בשר ועוף", "ירקות ופירות", "מזווה ורטבים", "נשנושים ומתוקים", "חד־פעמי"]
    assert [n for n, b in buyers.items() if b == C] == ["שתייה ואלכוהול", "מנגל ובישול"]
    assert db.count("notifications") == 1 and db.count("polls") == 2
    multi = {p["question"]: p["multi"] for p in db.sql("select question, multi from polls")}
    assert multi == {"כמה ארוחות על האש מחשבים?": False, "חוץ מבירה ובריזר — מה עוד?": True}


def test_seed_item_counts(seeded):
    db = seeded["db"]
    items = db.sql("""select i.*, c.name as category from items i
                      join categories c on c.id = i.category_id""")
    assert len(items) == 69 == db.count("items"), "every item has a category"
    assert Counter(i["category"] for i in items) == ITEMS_PER_CATEGORY
    assert Counter(i["type"] for i in items) == {"buy": 46, "bring": 19, "each": 1, "task": 3}
    assert Counter(i["status"] for i in items) == {"active": 66, "proposed": 2, "rejected": 1}
    by_title = {i["title"]: i for i in items}
    assert {t for t, i in by_title.items() if i["per_person"]} == {
        "סטייק אנטריקוט", "פרגיות", "מרגז", "קבבים"}
    assert by_title["רמקול נייד"]["reject_reason"] == "המקום לא מרשה להשמיע מוזיקה"
    assert by_title["כסאות ים / קמפינג"]["needed"] == 11
    assert by_title[f"להזמין כרטיסים ל{D}"]["done"] is True
    assert by_title["ביצים"]["unit"] == "חבילות של 12"
    proposers = {db.val("select display_name from members where id = %s", [i["created_by"]])
                 for i in items if i["status"] != "active"}
    assert proposers == {C}
    pledges = db.sql("""select m.display_name, count(*) as n from pledges p
                        join members m on m.id = p.member_id group by 1""")
    assert {p["display_name"]: p["n"] for p in pledges} == PLEDGES_PER_MEMBER
    missing = db.sql("""select i.title from items i where i.status = 'active' and i.type <> 'each'
                        and not exists (select 1 from pledges p where p.item_id = i.id)
                        order by i.created_at""")
    assert [m["title"] for m in missing] == ["תבלין על האש", "קפה טורקי"]


def test_first_joiner_becomes_owner_and_sees_everything(seeded):
    db, trip = seeded["db"], seeded["trip"]
    me = db.user("לידור")
    preview = me.rpc("preview_invite", p_code=trip["invite_code"])
    assert preview["member_count"] == 5 and preview["headcount"] == 9
    assert [u["display_name"] for u in preview["unclaimed"]] == PLACEHOLDERS
    res = me.rpc("join_trip", p_code=trip["invite_code"],
                 p_profile=profile("לידור ושותפה", 2, people=["לידור", "שותפה"]))
    snap = me.snap(res["trip_id"])
    assert snap["me"]["role"] == "owner"
    assert len(snap["members"]) == 6 and sum(m["headcount"] for m in snap["members"]) == 11
    assert len(snap["items"]) == 69, "owner sees the rejected proposal too"
    assert len(snap["pledges"]) == 67
    per_person = {i["title"]: (i["qty"], i["unit"]) for i in snap["items"] if i["per_person"]}
    assert per_person == {"סטייק אנטריקוט": (300, "גרם"), "פרגיות": (400, "גרם"),
                          "מרגז": (8, "יח׳"), "קבבים": (8, "יח׳")}
    assert [n["title"] for n in snap["notifications"]] == ["ברוכים הבאים למדורה 🔥"]
    assert len(snap["polls"]) == 2 and snap["personal_items"] == []
    # the owner can manage the seeded proposals
    wings = next(i["id"] for i in snap["items"] if i["title"] == "כנפיים")
    me.rpc("review_item", p_item=wings, p_approve=True)
    assert db.val("select status from items where id = %s", [wings]) == "active"


def test_second_joiner_claims_their_profile(seeded):
    db, trip = seeded["db"], seeded["trip"]
    owner = db.user("לידור")
    owner_res = owner.rpc("join_trip", p_code=trip["invite_code"], p_profile=profile("לידור", 2))
    friend_id = db.val("select id from members where display_name = %s", [B])
    friend = db.user("friend")
    res = friend.rpc("join_trip", p_code=trip["invite_code"], p_claim_member=friend_id,
                   p_profile={"phone": "050-0000000"})
    assert res == {"trip_id": trip["id"], "member_id": friend_id}
    snap = friend.snap(trip["id"])
    assert snap["me"] == {"member_id": friend_id, "role": "member", "user_id": friend.uid}
    me = next(m for m in snap["members"] if m["id"] == friend_id)
    assert me["claimed"] is True and me["phone"] == "050-0000000"
    assert me["inventory"] == ["מלקחיים", "מחבת"]
    titles = {i["title"] for i in snap["items"]}
    assert "רמקול נייד" not in titles, "rejected item of someone else is hidden"
    assert {"כנפיים", "נס קפה עלית קטן"} <= titles, "proposals are visible to all"
    my_pledges = [p for p in snap["pledges"] if p["member_id"] == friend_id]
    assert len(my_pledges) == 37
    items = {i["id"]: i for i in snap["items"]}
    assert {items[p["item_id"]]["title"] for p in my_pledges} >= {
        "סטייק אנטריקוט", "פיתות", "צלחות גדולות", "מלקחיים", "מחבת גדולה"}
    # the owner was told
    owner_titles = [n["title"] for n in owner.snap(trip["id"])["notifications"]]
    assert f"{B} הצטרפ/ה לטיול 🎉" in owner_titles
    assert owner.snap(trip["id"])["me"]["member_id"] == owner_res["member_id"]
    # the friend marks the steak as bought
    steak = next(i["id"] for i in snap["items"] if i["title"] == "סטייק אנטריקוט")
    friend.rpc("set_item_done", p_item=steak, p_done=True)
    assert db.val("select done from items where id = %s", [steak]) is True
    with raises("already_claimed"):
        db.user().rpc("join_trip", p_code=trip["invite_code"], p_claim_member=friend_id)
