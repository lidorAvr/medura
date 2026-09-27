"""Categories, items (status rules, bulk import, edit/delete/review), pledges, assignments,
done flags and the private personal packing list."""
from conftest import new_trip, raises


def item_row(db, item_id):
    return db.one("select * from items where id = %s", [item_id])


def notes_for(db, member_id, prefix=""):
    return db.sql("""select * from notifications where %s = any(audience) and title like %s
                     order by created_at""", [member_id, prefix + "%"])


# --- categories ------------------------------------------------------------------------

def test_categories_crud_admin_only(db):
    t = new_trip(db)
    guest = t.join("אורח")
    with raises("forbidden"):
        guest.rpc("upsert_category", p_trip=t.id, p_cat={"name": "שלי"})
    cid = t.owner.rpc("upsert_category", p_trip=t.id,
                      p_cat={"name": "קפה", "emoji": "☕", "default_buyer_id": guest.mid,
                             "note": "פקל"})
    cat = next(c for c in guest.snap(t.id)["categories"] if c["id"] == cid)
    assert cat == {"id": cid, "name": "קפה", "emoji": "☕", "sort": 11,
                   "default_buyer_id": guest.mid, "note": "פקל"}
    # partial update keeps other fields
    assert t.owner.rpc("upsert_category", p_trip=t.id, p_cat={"id": cid, "sort": 0}) == cid
    cat = next(c for c in guest.snap(t.id)["categories"] if c["id"] == cid)
    assert cat["sort"] == 0 and cat["name"] == "קפה" and cat["default_buyer_id"] == guest.mid
    assert guest.snap(t.id)["categories"][0]["id"] == cid, "sorted by sort"
    with raises("invalid_input"):
        t.owner.rpc("upsert_category", p_trip=t.id, p_cat={"emoji": "☕"})      # name required
    with raises("invalid_input"):
        t.owner.rpc("upsert_category", p_trip=t.id,
                    p_cat={"name": "x", "default_buyer_id": new_trip(db, name="ב").owner.mid})
    with raises("not_found"):
        t.owner.rpc("upsert_category", p_trip=t.id,
                    p_cat={"id": "00000000-0000-0000-0000-000000000000", "name": "x"})
    item = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "פולים", "category_id": cid})
    with raises("forbidden"):
        guest.rpc("delete_category", p_category=cid)
    t.owner.rpc("delete_category", p_category=cid)
    assert item_row(db, item)["category_id"] is None, "items keep, category_id -> null"
    with raises("not_found"):
        t.owner.rpc("delete_category", p_category=cid)


def test_default_buyer_cleared_when_member_removed(db):
    t = new_trip(db)
    guest = t.join("אורח")
    cid = t.category("בשר ועוף")
    t.owner.rpc("upsert_category", p_trip=t.id, p_cat={"id": cid, "default_buyer_id": guest.mid})
    t.owner.rpc("remove_member", p_member=guest.mid)
    assert db.val("select default_buyer_id from categories where id = %s", [cid]) is None


# --- add_item --------------------------------------------------------------------------

def test_member_item_is_proposed_and_admins_notified(db):
    t = new_trip(db)
    admin = t.admin("מנהל")
    guest = t.join("אסף")
    cid = t.category("בשר ועוף")
    item = guest.rpc("add_item", p_trip=t.id, p_item={
        "title": "כנפיים", "type": "buy", "qty": 1, "unit": 'ק"ג', "note": "אם אוהבים",
        "category_id": cid, "pledge_qty": 1})
    row = item_row(db, item)
    assert row["status"] == "proposed" and row["created_by"] == guest.mid
    assert row["approved_by"] is None and row["category_id"] == cid
    assert row["qty"] == 1 and row["unit"] == 'ק"ג'
    assert db.count("pledges", "item_id = %s and member_id = %s", [item, guest.mid]) == 1
    note = db.one("select * from notifications where title = 'הצעה חדשה: כנפיים'")
    assert set(note["audience"]) == {t.owner.mid, admin.mid}
    assert note["link"] == f"#/t/{t.id}/lists?item={item}"
    assert "אסף" in note["body"]
    # proposed items are visible to every member
    other = t.join("אחר")
    assert any(i["id"] == item and i["status"] == "proposed" for i in other.snap(t.id)["items"])


def test_admin_item_is_active(db):
    t = new_trip(db)
    item = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "פחמים", "qty": 3,
                                                        "unit": "חבילות"})
    row = item_row(db, item)
    assert row["status"] == "active" and row["approved_by"] == t.owner.mid
    assert row["type"] == "buy", "type defaults to buy"
    assert db.count("notifications", "title like 'הצעה חדשה%%'") == 0


def test_no_approval_setting_makes_member_items_active(db):
    t = new_trip(db)
    t.settings(require_approval=False)
    guest = t.join("אורח")
    item = guest.rpc("add_item", p_trip=t.id, p_item={"title": "מטקות", "type": "bring"})
    row = item_row(db, item)
    assert row["status"] == "active" and row["approved_by"] is None
    assert db.count("notifications", "title like 'הצעה חדשה%%'") == 0


def test_add_item_validation(db):
    t = new_trip(db)
    other_cat = db.val("select id from categories where trip_id = %s limit 1",
                       [new_trip(db, name="ב").id])
    bad = [{"title": ""}, {"title": "x" * 121}, {"title": "x", "type": "steal"},
           {"title": "x", "qty": -1}, {"title": "x", "qty": "many"}, {"title": "x", "needed": 0},
           {"title": "x", "needed": 201}, {"title": "x", "unit": "u" * 21},
           {"title": "x", "note": "n" * 501}, {"title": "x", "category_id": other_cat},
           {"title": "x", "pledge_qty": 201}, {"title": "x", "per_person": "maybe"}]
    for item in bad:
        with raises("invalid_input"):
            t.owner.rpc("add_item", p_trip=t.id, p_item=item)
    with raises("invalid_input"):
        t.owner.rpc("add_item", p_trip=t.id, p_item=None)
    with raises("forbidden"):
        db.user().rpc("add_item", p_trip=t.id, p_item={"title": "x"})
    assert db.count("items") == 0


def test_add_item_stores_all_fields(db):
    t = new_trip(db)
    item = t.owner.rpc("add_item", p_trip=t.id, p_item={
        "title": "  סטייק אנטריקוט ", "type": "buy", "qty": 300, "unit": "גרם",
        "per_person": True, "note": "", "needed": 3, "unknown": "ignored"})
    snap_item = next(i for i in t.owner.snap(t.id)["items"] if i["id"] == item)
    assert snap_item["title"] == "סטייק אנטריקוט"
    assert snap_item["qty"] == 300 and snap_item["unit"] == "גרם"
    assert snap_item["per_person"] is True and snap_item["note"] is None
    assert snap_item["needed"] == 3 and snap_item["done"] is False
    zero = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "בלי כמות", "qty": 0})
    assert item_row(db, zero)["qty"] is None


def test_each_item_ignores_pledge_qty(db):
    t = new_trip(db)
    item = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "קרש חיתוך", "type": "each",
                                                        "pledge_qty": 1})
    assert db.count("pledges", "item_id = %s", [item]) == 0


# --- add_items_bulk --------------------------------------------------------------------

def test_bulk_admin_creates_unknown_categories(db):
    t = new_trip(db)
    items = [
        {"title": "סטייק", "qty": 300, "unit": "גרם", "per_person": True,
         "category_name": "בשרים ועופות", "category_emoji": "🥩"},
        {"title": "פרגיות", "category_name": "בשרים ועופות", "category_emoji": "🥩"},
        {"title": "עגבניות", "qty": 12, "category_name": "ירקות ופירות"},
        {"title": "קרש חיתוך", "type": "each"},
    ]
    assert t.owner.rpc("add_items_bulk", p_trip=t.id, p_items=items) == 4
    cats = {c["name"]: c for c in t.owner.snap(t.id)["categories"]}
    assert "בשרים ועופות" in cats and cats["בשרים ועופות"]["emoji"] == "🥩"
    assert cats["בשרים ועופות"]["sort"] == 11
    assert db.count("categories", "trip_id = %s", [t.id]) == 11, "created once, reused"
    rows = db.sql("select title, category_id, status from items order by created_at")
    assert [r["title"] for r in rows] == ["סטייק", "פרגיות", "עגבניות", "קרש חיתוך"], "order kept"
    assert rows[0]["category_id"] == rows[1]["category_id"] == cats["בשרים ועופות"]["id"]
    assert rows[2]["category_id"] == cats["ירקות ופירות"]["id"], "matched existing category"
    assert rows[3]["category_id"] is None
    assert {r["status"] for r in rows} == {"active"}


def test_bulk_member_matches_categories_and_proposes(db):
    t = new_trip(db)
    guest = t.join("אורח")
    items = [{"title": "מלפפונים", "category_name": "  ירקות ופירות "},
             {"title": "וודקה", "category_name": "אלכוהול חזק"},
             {"title": "גרעינים", "category_id": t.category("נשנושים ומתוקים")}]
    assert guest.rpc("add_items_bulk", p_trip=t.id, p_items=items) == 3
    assert db.count("categories", "trip_id = %s", [t.id]) == 10, "members never create categories"
    rows = {r["title"]: r for r in db.sql("select * from items")}
    assert rows["מלפפונים"]["category_id"] == t.category("ירקות ופירות")
    assert rows["וודקה"]["category_id"] is None
    assert rows["גרעינים"]["category_id"] == t.category("נשנושים ומתוקים")
    assert {r["status"] for r in rows.values()} == {"proposed"}
    [note] = notes_for(db, t.owner.mid, "3 הצעות")
    assert note["title"] == "3 הצעות חדשות מחכות לאישור"
    assert "מלפפונים" in note["body"] and "וודקה" in note["body"]


def test_bulk_limits_and_validation(db):
    t = new_trip(db)
    with raises("limit_reached"):
        t.owner.rpc("add_items_bulk", p_trip=t.id, p_items=[{"title": f"i{n}"} for n in range(151)])
    assert t.owner.rpc("add_items_bulk", p_trip=t.id,
                       p_items=[{"title": f"i{n}"} for n in range(150)]) == 150
    assert t.owner.rpc("add_items_bulk", p_trip=t.id, p_items=[]) == 0
    with raises("invalid_input"):
        t.owner.rpc("add_items_bulk", p_trip=t.id, p_items={"title": "not an array"})
    with raises("invalid_input"):
        t.owner.rpc("add_items_bulk", p_trip=t.id, p_items=[{"title": "ok"}, {"title": ""}])
    assert db.count("items") == 150, "a bad element rolls back the whole import"


def test_item_limit(db):
    t = new_trip(db)
    db.sql("""insert into items (trip_id, title, type)
              select %s, 'i' || g, 'buy' from generate_series(1, 599) g""", [t.id])
    t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "600"})
    with raises("limit_reached"):
        t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "601"})
    with raises("limit_reached"):
        t.owner.rpc("add_items_bulk", p_trip=t.id, p_items=[{"title": "601"}])


# --- update / delete / review ----------------------------------------------------------

def test_update_item_permissions(db):
    t = new_trip(db)
    creator = t.join("יוצר")
    other = t.join("אחר")
    item = creator.rpc("add_item", p_trip=t.id, p_item={"title": "רמקול", "type": "bring"})
    creator.rpc("update_item", p_item=item, p_patch={"title": "רמקול נייד", "needed": 2})
    assert item_row(db, item)["title"] == "רמקול נייד"
    with raises("forbidden"):
        other.rpc("update_item", p_item=item, p_patch={"title": "שלי"})
    t.owner.rpc("review_item", p_item=item, p_approve=True)
    with raises("forbidden"):
        creator.rpc("update_item", p_item=item, p_patch={"title": "אחרי אישור"})
    t.owner.rpc("update_item", p_item=item, p_patch={
        "title": "רמקול", "type": "buy", "qty": 1, "unit": "יח׳", "per_person": False,
        "needed": 1, "sort": 5, "note": "קטן", "category_id": t.category("כיף ומשחקים"),
        "status": "rejected", "done": True})
    row = item_row(db, item)
    assert (row["title"], row["type"], row["sort"], row["note"]) == ("רמקול", "buy", 5, "קטן")
    assert row["status"] == "active" and row["done"] is False, "status/done not patchable"
    assert row["updated_at"] > row["created_at"]
    with raises("invalid_input"):
        t.owner.rpc("update_item", p_item=item, p_patch={"type": "gift"})
    with raises("invalid_input"):
        t.owner.rpc("update_item", p_item=item, p_patch={"title": None})
    with raises("not_found"):
        t.owner.rpc("update_item", p_item="00000000-0000-0000-0000-000000000000", p_patch={})


def test_delete_item_permissions(db):
    t = new_trip(db)
    creator = t.join("יוצר")
    other = t.join("אחר")
    proposed = creator.rpc("add_item", p_trip=t.id, p_item={"title": "א"})
    rejected = creator.rpc("add_item", p_trip=t.id, p_item={"title": "ב"})
    approved = creator.rpc("add_item", p_trip=t.id, p_item={"title": "ג"})
    t.owner.rpc("review_item", p_item=rejected, p_approve=False)
    t.owner.rpc("review_item", p_item=approved, p_approve=True)
    with raises("forbidden"):
        other.rpc("delete_item", p_item=proposed)
    with raises("forbidden"):
        creator.rpc("delete_item", p_item=approved)
    creator.rpc("delete_item", p_item=proposed)
    creator.rpc("delete_item", p_item=rejected)
    t.owner.rpc("delete_item", p_item=approved)
    assert db.count("items") == 0


def test_review_item(db):
    t = new_trip(db)
    guest = t.join("אסף")
    other = t.join("אחר")
    a = guest.rpc("add_item", p_trip=t.id, p_item={"title": "כנפיים"})
    b = guest.rpc("add_item", p_trip=t.id, p_item={"title": "רמקול נייד"})
    with raises("forbidden"):
        other.rpc("review_item", p_item=a, p_approve=True)
    t.owner.rpc("review_item", p_item=a, p_approve=True)
    t.owner.rpc("review_item", p_item=b, p_approve=False,
                p_reason=" המקום לא מרשה להשמיע מוזיקה ")
    ra, rb = item_row(db, a), item_row(db, b)
    assert ra["status"] == "active" and ra["approved_by"] == t.owner.mid
    assert rb["status"] == "rejected" and rb["reject_reason"] == "המקום לא מרשה להשמיע מוזיקה"
    titles = {n["title"]: n for n in notes_for(db, guest.mid, "ההצעה")}
    assert "ההצעה אושרה ✅: כנפיים" in titles
    rejected_note = titles["ההצעה נדחתה: רמקול נייד"]
    assert rejected_note["body"] == "המקום לא מרשה להשמיע מוזיקה"
    assert rejected_note["link"] == f"#/t/{t.id}/lists?item={b}"
    with raises("not_allowed_state"):
        t.owner.rpc("review_item", p_item=a, p_approve=False)
    with raises("not_allowed_state"):
        t.owner.rpc("review_item", p_item=b, p_approve=True)
    # rejected items: visible to admins and their creator only
    assert any(i["id"] == b for i in guest.snap(t.id)["items"])
    assert any(i["id"] == b for i in t.owner.snap(t.id)["items"])
    assert not any(i["id"] == b for i in other.snap(t.id)["items"])


def test_rejected_item_pledges_hidden_from_others(db):
    t = new_trip(db)
    guest = t.join("אסף")
    other = t.join("אחר")
    item = guest.rpc("add_item", p_trip=t.id, p_item={"title": "רמקול", "pledge_qty": 1})
    t.owner.rpc("review_item", p_item=item, p_approve=False)
    assert any(p["item_id"] == item for p in guest.snap(t.id)["pledges"])
    assert not any(p["item_id"] == item for p in other.snap(t.id)["pledges"])


# --- pledges ---------------------------------------------------------------------------

def test_pledge_rules(db):
    t = new_trip(db)
    a = t.join("א")
    b = t.join("ב")
    chairs = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "כסאות", "type": "bring",
                                                          "needed": 11})
    a.rpc("pledge", p_item=chairs, p_qty=2)
    b.rpc("pledge", p_item=chairs)                         # default qty 1
    a.rpc("pledge", p_item=chairs, p_qty=3)                # update, not duplicate
    pledges = {p["member_id"]: p["qty"] for p in a.snap(t.id)["pledges"]}
    assert pledges == {a.mid: 3, b.mid: 1}
    a.rpc("pledge", p_item=chairs, p_qty=0)                # removes
    assert db.count("pledges", "member_id = %s", [a.mid]) == 0
    b.rpc("pledge", p_item=chairs, p_qty=-1)
    assert db.count("pledges") == 0
    with raises("invalid_input"):
        a.rpc("pledge", p_item=chairs, p_qty=201)
    each = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "סכין", "type": "each"})
    with raises("invalid_input"):
        a.rpc("pledge", p_item=each)
    with raises("not_found"):
        a.rpc("pledge", p_item="00000000-0000-0000-0000-000000000000")


def test_pledge_on_proposed_only_by_creator(db):
    t = new_trip(db)
    a = t.join("א")
    b = t.join("ב")
    mine = a.rpc("add_item", p_trip=t.id, p_item={"title": "נפנף", "type": "bring"})
    a.rpc("pledge", p_item=mine)
    with raises("not_allowed_state"):
        b.rpc("pledge", p_item=mine)
    t.owner.rpc("review_item", p_item=mine, p_approve=False)
    with raises("not_allowed_state"):
        a.rpc("pledge", p_item=mine, p_qty=2)
    a.rpc("pledge", p_item=mine, p_qty=0)                  # un-pledging always works
    assert db.count("pledges") == 0


def test_assign(db):
    t = new_trip(db)
    admin = t.admin("מנהל")
    guest = t.join("הדס")
    item = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "פיתות", "qty": 50})
    with raises("forbidden"):
        guest.rpc("assign", p_item=item, p_member=guest.mid)
    admin.rpc("assign", p_item=item, p_member=guest.mid, p_qty=2)
    pledge = db.one("select * from pledges where item_id = %s", [item])
    assert (pledge["member_id"], pledge["qty"], pledge["assigned_by"]) == (guest.mid, 2, admin.mid)
    [note] = notes_for(db, guest.mid, "שובצת")
    assert note["title"] == "שובצת: פיתות" and note["link"] == f"#/t/{t.id}/lists?item={item}"
    assert any(n["id"] == note["id"] for n in guest.snap(t.id)["notifications"])
    # assigning myself does not notify me
    admin.rpc("assign", p_item=item, p_member=admin.mid)
    assert notes_for(db, admin.mid, "שובצת") == []
    admin.rpc("assign", p_item=item, p_member=guest.mid, p_qty=0)
    assert db.count("pledges", "member_id = %s", [guest.mid]) == 0
    with raises("not_found"):
        admin.rpc("assign", p_item=item, p_member=new_trip(db, name="ב").owner.mid)
    each = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "מזלג", "type": "each"})
    with raises("invalid_input"):
        admin.rpc("assign", p_item=each, p_member=guest.mid)


def test_set_pledge_done(db):
    t = new_trip(db)
    a = t.join("א")
    board = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "קרש חיתוך", "type": "each"})
    grill = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "מנגל", "type": "bring"})
    a.rpc("set_pledge_done", p_item=board, p_done=True)    # lazy row for "each"
    row = db.one("select * from pledges where item_id = %s", [board])
    assert (row["member_id"], row["qty"], row["done"]) == (a.mid, 1, True)
    a.rpc("set_pledge_done", p_item=board, p_done=False)
    assert db.val("select done from pledges where item_id = %s", [board]) is False
    with raises("not_found"):
        a.rpc("set_pledge_done", p_item=grill, p_done=True)  # no pledge on a bring item
    a.rpc("pledge", p_item=grill)
    a.rpc("set_pledge_done", p_item=grill, p_done=True)
    assert db.val("select done from pledges where item_id = %s", [grill]) is True
    proposed_each = a.rpc("add_item", p_trip=t.id, p_item={"title": "כוס", "type": "each"})
    with raises("not_allowed_state"):
        a.rpc("set_pledge_done", p_item=proposed_each, p_done=True)


def test_set_item_done(db):
    t = new_trip(db)
    buyer = t.join("קונה")
    other = t.join("אחר")
    buy = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "בירות", "type": "buy"})
    task = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "לשריין מקרר", "type": "task"})
    bring = t.owner.rpc("add_item", p_trip=t.id, p_item={"title": "גזיבו", "type": "bring"})
    buyer.rpc("pledge", p_item=buy)
    with raises("forbidden"):
        other.rpc("set_item_done", p_item=buy, p_done=True)
    buyer.rpc("set_item_done", p_item=buy, p_done=True)
    row = item_row(db, buy)
    assert row["done"] is True and row["done_at"] is not None
    buyer.rpc("set_item_done", p_item=buy, p_done=False)
    row = item_row(db, buy)
    assert row["done"] is False and row["done_at"] is None
    t.owner.rpc("set_item_done", p_item=task, p_done=True)      # admin without pledge
    assert item_row(db, task)["done"] is True
    with raises("invalid_input"):
        t.owner.rpc("set_item_done", p_item=bring, p_done=True)


# --- personal items --------------------------------------------------------------------

def test_personal_items_are_private(db):
    t = new_trip(db)
    guest = t.join("אורח")
    pid = guest.rpc("add_personal", p_trip=t.id, p_title="  כרית ")
    assert [p["title"] for p in guest.snap(t.id)["personal_items"]] == ["כרית"]
    assert set(guest.snap(t.id)["personal_items"][0]) == {"id", "title", "done", "sort",
                                                         "created_at"}
    assert t.owner.snap(t.id)["personal_items"] == [], "not even admins"
    with raises("forbidden"):
        t.owner.rpc("update_personal", p_id=pid, p_patch={"done": True})
    with raises("forbidden"):
        t.owner.rpc("delete_personal", p_id=pid)
    guest.rpc("update_personal", p_id=pid, p_patch={"done": True, "title": "כרית גדולה",
                                                   "sort": 7, "member_id": t.owner.mid})
    row = db.one("select * from personal_items where id = %s", [pid])
    assert (row["done"], row["title"], row["sort"], row["member_id"]) == (
        True, "כרית גדולה", 7, guest.mid)
    with raises("invalid_input"):
        guest.rpc("update_personal", p_id=pid, p_patch={"title": ""})
    with raises("invalid_input"):
        guest.rpc("add_personal", p_trip=t.id, p_title="x" * 81)
    guest.rpc("delete_personal", p_id=pid)
    with raises("not_found"):
        guest.rpc("delete_personal", p_id=pid)


def test_personal_template_is_idempotent(db):
    t = new_trip(db)
    guest = t.join("אורח")
    guest.rpc("add_personal", p_trip=t.id, p_title="מגבת")
    assert guest.rpc("add_personal_template", p_trip=t.id) == 16
    titles = [p["title"] for p in guest.snap(t.id)["personal_items"]]
    assert titles[:3] == ["מגבת", "אוהל", "מזרן / מזרן מתנפח + משאבה"]
    assert titles[-1] == "תעודה מזהה / כרטיסי כניסה" and len(titles) == 17
    assert guest.rpc("add_personal_template", p_trip=t.id) == 0
    assert db.count("personal_items") == 17
    assert t.owner.rpc("add_personal_template", p_trip=t.id) == 17, "per member"


def test_personal_limit(db):
    t = new_trip(db)
    db.sql("""insert into personal_items (trip_id, member_id, title)
              select %s, %s, 'p' || g from generate_series(1, 99) g""", [t.id, t.owner.mid])
    t.owner.rpc("add_personal", p_trip=t.id, p_title="100")
    with raises("limit_reached"):
        t.owner.rpc("add_personal", p_trip=t.id, p_title="101")
    with raises("limit_reached"):
        t.owner.rpc("add_personal_template", p_trip=t.id)
