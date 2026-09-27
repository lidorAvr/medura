"""Expenses (split modes, permissions, validation, limit) and payments (sent/confirmed flows,
notifications, delete rules)."""
from decimal import Decimal

from conftest import new_trip, raises


def note_titles(db, member_id):
    return [n["title"] for n in db.sql(
        "select title from notifications where %s = any(audience) order by created_at", [member_id])]


# --- expenses --------------------------------------------------------------------------

def test_add_expense_defaults(db):
    t = new_trip(db)
    guest = t.join("אורח", 2)
    exp = guest.rpc("add_expense", p_trip=t.id, p_exp={"title": " סופר ", "amount": "412.456"})
    snap = t.owner.snap(t.id)
    [row] = snap["expenses"]
    assert row["id"] == exp and row["title"] == "סופר"
    assert row["amount"] == 412.46, "rounded to agorot, JSON number"
    assert row["paid_by"] == guest.mid and row["created_by"] == guest.mid
    assert row["split_mode"] == "all" and row["category_id"] is None
    assert isinstance(row["spent_on"], str) and len(row["spent_on"]) == 10
    assert snap["expense_shares"] == []


def test_expense_paid_by_other_requires_admin(db):
    t = new_trip(db)
    a = t.join("א")
    b = t.join("ב")
    with raises("forbidden"):
        a.rpc("add_expense", p_trip=t.id, p_exp={"title": "גז", "amount": 50, "paid_by": b.mid})
    exp = t.owner.rpc("add_expense", p_trip=t.id,
                      p_exp={"title": "גז", "amount": 50, "paid_by": b.mid,
                             "category_id": t.category("מנגל ובישול"), "note": "בלון",
                             "spent_on": "2026-09-30"})
    row = db.one("select * from expenses where id = %s", [exp])
    assert row["paid_by"] == b.mid and row["created_by"] == t.owner.mid
    assert str(row["spent_on"]) == "2026-09-30" and row["note"] == "בלון"
    with raises("invalid_input"):
        t.owner.rpc("add_expense", p_trip=t.id, p_exp={
            "title": "x", "amount": 1, "paid_by": new_trip(db, name="ב").owner.mid})


def test_expense_members_split(db):
    t = new_trip(db, headcount=2)
    a = t.join("א")
    b = t.join("ב", 2)
    exp = a.rpc("add_expense", p_trip=t.id, p_exp={
        "title": "אלכוהול", "amount": 300, "split_mode": "members",
        "members": [{"member_id": a.mid}, {"member_id": b.mid, "weight": 1.5}]})
    shares = {s["member_id"]: s["weight"] for s in a.snap(t.id)["expense_shares"]
              if s["expense_id"] == exp}
    assert shares == {a.mid: 1, b.mid: 1.5}, "weight defaults to headcount"
    # members given as plain ids are accepted too
    exp2 = a.rpc("add_expense", p_trip=t.id, p_exp={"title": "קרח", "amount": 20,
                                                     "split_mode": "members",
                                                     "members": [b.mid]})
    assert db.val("select weight from expense_shares where expense_id = %s", [exp2]) == 2
    bad_members = [None, [], [{"member_id": a.mid}, {"member_id": a.mid}],
                   [{"member_id": new_trip(db, name="ב").owner.mid}],
                   [{"member_id": a.mid, "weight": 0}], [{"weight": 1}]]
    for members in bad_members:
        with raises("invalid_input"):
            a.rpc("add_expense", p_trip=t.id, p_exp={"title": "x", "amount": 10,
                                                      "split_mode": "members", "members": members})
    assert db.count("expenses") == 2


def test_expense_validation(db):
    t = new_trip(db)
    other_cat = db.val("select id from categories where trip_id = %s limit 1",
                       [new_trip(db, name="ב").id])
    bad = [{"title": "", "amount": 10}, {"title": "x" * 81, "amount": 10}, {"title": "x"},
           {"title": "x", "amount": 0}, {"title": "x", "amount": -5},
           {"title": "x", "amount": 100000.01}, {"title": "x", "amount": "NaN"},
           {"title": "x", "amount": 10, "split_mode": "some"},
           {"title": "x", "amount": 10, "category_id": other_cat},
           {"title": "x", "amount": 10, "spent_on": "2026-13-45"},
           {"title": "x", "amount": 10, "spent_on": "infinity"}]
    for exp in bad:
        with raises("invalid_input"):
            t.owner.rpc("add_expense", p_trip=t.id, p_exp=exp)
    assert db.count("expenses") == 0


def test_update_expense_permissions(db):
    t = new_trip(db)
    creator = t.join("יוצר")
    payer = t.join("משלם")
    other = t.join("אחר")
    exp = t.owner.rpc("add_expense", p_trip=t.id,
                      p_exp={"title": "סופר", "amount": 100, "paid_by": payer.mid})
    mine = creator.rpc("add_expense", p_trip=t.id, p_exp={"title": "שלי", "amount": 40})
    with raises("forbidden"):
        other.rpc("update_expense", p_expense=exp, p_patch={"amount": 1})
    payer.rpc("update_expense", p_expense=exp, p_patch={"amount": 120.5, "title": "סופר גדול"})
    row = db.one("select * from expenses where id = %s", [exp])
    assert (row["amount"], row["title"]) == (Decimal("120.50"), "סופר גדול")
    creator.rpc("update_expense", p_expense=mine, p_patch={"note": "קבלה אצלי"})
    # a non-admin cannot move the payment to someone else
    with raises("forbidden"):
        creator.rpc("update_expense", p_expense=mine, p_patch={"paid_by": other.mid})
    t.owner.rpc("update_expense", p_expense=mine, p_patch={"paid_by": other.mid})
    assert db.val("select paid_by from expenses where id = %s", [mine]) == other.mid
    with raises("invalid_input"):
        payer.rpc("update_expense", p_expense=exp, p_patch={"amount": 0})
    with raises("not_found"):
        payer.rpc("update_expense", p_expense="00000000-0000-0000-0000-000000000000",
                  p_patch={})


def test_update_expense_split_changes(db):
    t = new_trip(db)
    a = t.join("א")
    exp = t.owner.rpc("add_expense", p_trip=t.id, p_exp={"title": "גז", "amount": 90})
    with raises("invalid_input"):
        t.owner.rpc("update_expense", p_expense=exp, p_patch={"split_mode": "members"})
    t.owner.rpc("update_expense", p_expense=exp,
                p_patch={"split_mode": "members", "members": [{"member_id": a.mid}]})
    assert db.count("expense_shares", "expense_id = %s", [exp]) == 1
    t.owner.rpc("update_expense", p_expense=exp,
                p_patch={"members": [{"member_id": a.mid}, {"member_id": t.owner.mid}]})
    assert db.count("expense_shares", "expense_id = %s", [exp]) == 2, "members replace shares"
    t.owner.rpc("update_expense", p_expense=exp, p_patch={"title": "גז ופחמים"})
    assert db.count("expense_shares", "expense_id = %s", [exp]) == 2, "kept when not given"
    t.owner.rpc("update_expense", p_expense=exp, p_patch={"split_mode": "all"})
    assert db.count("expense_shares", "expense_id = %s", [exp]) == 0


def test_delete_expense_permissions(db):
    t = new_trip(db)
    creator = t.join("יוצר")
    payer = t.join("משלם")
    other = t.join("אחר")
    e1 = creator.rpc("add_expense", p_trip=t.id, p_exp={"title": "א", "amount": 10})
    e2 = t.owner.rpc("add_expense", p_trip=t.id,
                     p_exp={"title": "ב", "amount": 10, "paid_by": payer.mid,
                            "split_mode": "members", "members": [other.mid]})
    e3 = creator.rpc("add_expense", p_trip=t.id, p_exp={"title": "ג", "amount": 10})
    with raises("forbidden"):
        other.rpc("delete_expense", p_expense=e1)
    creator.rpc("delete_expense", p_expense=e1)
    payer.rpc("delete_expense", p_expense=e2)
    assert db.count("expense_shares") == 0, "shares cascade"
    t.owner.rpc("delete_expense", p_expense=e3)
    assert db.count("expenses") == 0


def test_expense_limit(db):
    t = new_trip(db)
    db.sql("""insert into expenses (trip_id, title, amount, paid_by)
              select %s, 'e' || g, 1, %s from generate_series(1, 300) g""", [t.id, t.owner.mid])
    with raises("limit_reached"):
        t.owner.rpc("add_expense", p_trip=t.id, p_exp={"title": "301", "amount": 1})


# --- payments --------------------------------------------------------------------------

def test_payment_sent_then_confirmed(db):
    t = new_trip(db)
    payer = t.join("הדס ועידו", 2)
    receiver = t.join("אסף ועלמה", 2)
    pay = payer.rpc("add_payment", p_trip=t.id,
                    p_pay={"to_member": receiver.mid, "amount": 120, "note": "בירות"})
    row = db.one("select * from payments where id = %s", [pay])
    assert (row["from_member"], row["status"], row["method"], row["created_by"]) == (
        payer.mid, "sent", "bit", payer.mid)
    assert row["confirmed_at"] is None
    assert "הדס ועידו סימן/ה שהעביר/ה לך ₪120" in note_titles(db, receiver.mid)
    with raises("forbidden"):
        payer.rpc("confirm_payment", p_payment=pay)            # only recipient or admin
    receiver.rpc("confirm_payment", p_payment=pay)
    row = db.one("select * from payments where id = %s", [pay])
    assert row["status"] == "confirmed" and row["confirmed_at"] is not None
    assert "אסף ועלמה אישר/ה שקיבל/ה ₪120 ✅" in note_titles(db, payer.mid)
    receiver.rpc("confirm_payment", p_payment=pay)             # idempotent, no second note
    assert note_titles(db, payer.mid).count("אסף ועלמה אישר/ה שקיבל/ה ₪120 ✅") == 1
    snap_pay = payer.snap(t.id)["payments"][0]
    assert set(snap_pay) == {"id", "from_member", "to_member", "amount", "method", "note",
                             "status", "created_by", "created_at", "confirmed_at"}


def test_payment_recorded_by_recipient_is_confirmed(db):
    t = new_trip(db)
    payer = t.join("משלם")
    receiver = t.join("מקבל")
    pay = receiver.rpc("add_payment", p_trip=t.id, p_pay={
        "from_member": payer.mid, "to_member": receiver.mid, "amount": 12.5, "method": "cash"})
    row = db.one("select * from payments where id = %s", [pay])
    assert row["status"] == "confirmed" and row["confirmed_at"] is not None
    assert row["method"] == "cash" and row["created_by"] == receiver.mid
    assert "מקבל אישר/ה שקיבל/ה ₪12.50 ✅" in note_titles(db, payer.mid)


def test_payment_permissions_and_validation(db):
    t = new_trip(db)
    a = t.join("א")
    b = t.join("ב")
    c = t.join("ג")
    with raises("forbidden"):
        a.rpc("add_payment", p_trip=t.id, p_pay={"from_member": b.mid, "to_member": c.mid,
                                                  "amount": 10})
    pay = t.owner.rpc("add_payment", p_trip=t.id, p_pay={"from_member": b.mid,
                                                          "to_member": c.mid, "amount": 10})
    assert db.val("select status from payments where id = %s", [pay]) == "sent"
    bad = [{"to_member": a.mid, "amount": 10}, {"to_member": b.mid}, {"amount": 10},
           {"to_member": b.mid, "amount": -1}, {"to_member": b.mid, "amount": 10, "method": "btc"},
           {"to_member": new_trip(db, name="ב").owner.mid, "amount": 10}]
    for p in bad:
        with raises("invalid_input"):
            a.rpc("add_payment", p_trip=t.id, p_pay=p)


def test_delete_payment_rules(db):
    t = new_trip(db)
    a = t.join("א")
    b = t.join("ב")
    sent = a.rpc("add_payment", p_trip=t.id, p_pay={"to_member": b.mid, "amount": 10})
    with raises("forbidden"):
        b.rpc("delete_payment", p_payment=sent)                # recipient is not the creator
    a.rpc("delete_payment", p_payment=sent)
    confirmed = a.rpc("add_payment", p_trip=t.id, p_pay={"to_member": b.mid, "amount": 10})
    b.rpc("confirm_payment", p_payment=confirmed)
    with raises("not_allowed_state"):
        a.rpc("delete_payment", p_payment=confirmed)
    t.owner.rpc("confirm_payment", p_payment=confirmed)       # admin may confirm too (no-op)
    t.owner.rpc("delete_payment", p_payment=confirmed)
    assert db.count("payments") == 0
    with raises("not_found"):
        t.owner.rpc("delete_payment", p_payment=confirmed)


def test_admin_confirms_on_behalf(db):
    t = new_trip(db)
    a = t.join("א")
    b = t.join("ב")
    pay = a.rpc("add_payment", p_trip=t.id, p_pay={"to_member": b.mid, "amount": 30})
    t.owner.rpc("confirm_payment", p_payment=pay)
    assert db.val("select status from payments where id = %s", [pay]) == "confirmed"
    assert "ב אישר/ה שקיבל/ה ₪30 ✅" in note_titles(db, a.mid)
