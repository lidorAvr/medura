"""Announcements & visibility, delete_notification, mark_read & reads visibility, polls,
push subscriptions."""
from conftest import new_trip, raises


def visible_ids(actor, trip_id):
    return [n["id"] for n in actor.snap(trip_id)["notifications"]]


# --- announcements ---------------------------------------------------------------------

def test_announcement_admin_only_and_to_everyone(db):
    t = new_trip(db)
    a = t.join("א")
    with raises("forbidden"):
        a.rpc("send_announcement", p_trip=t.id, p_title="היי", p_body="")
    nid = t.owner.rpc("send_announcement", p_trip=t.id, p_title="  יוצאים ב-9 🚗 ",
                      p_body="נפגשים בתחנת דלק\nלא לאחר!", p_urgent=True)
    [note] = [n for n in a.snap(t.id)["notifications"] if n["id"] == nid]
    assert note == {"id": nid, "kind": "announcement", "title": "יוצאים ב-9 🚗",
                    "body": "נפגשים בתחנת דלק\nלא לאחר!", "audience": None,
                    "author_member": t.owner.mid, "urgent": True, "link": None,
                    "created_at": note["created_at"]}


def test_targeted_announcement_visibility(db):
    t = new_trip(db)
    admin = t.admin("מנהלת")
    a = t.join("א")
    b = t.join("ב")
    nid = t.owner.rpc("send_announcement", p_trip=t.id, p_title="רק לא", p_body="סוד",
                      p_audience=[a.mid, a.mid])
    assert db.val("select audience from notifications where id = %s", [nid]) == [a.mid]
    assert nid in visible_ids(a, t.id)
    assert nid not in visible_ids(b, t.id), "non-audience members don't see it"
    assert nid in visible_ids(t.owner, t.id), "author sees it"
    assert nid in visible_ids(admin, t.id), "admins see all announcements"
    # but admins do not see system notifications addressed to others
    sys_note = db.val("select id from notifications where kind = 'system' and %s = any(audience) "
                      "limit 1", [admin.mid])      # "מונית למנהל/ת"
    assert sys_note in visible_ids(admin, t.id)
    assert sys_note not in visible_ids(t.owner, t.id)


def test_announcement_validation(db):
    t = new_trip(db)
    stranger = new_trip(db, name="ב").owner
    for kwargs in (dict(p_title="", p_body="x"), dict(p_title="x" * 81, p_body=""),
                   dict(p_title="x", p_body="y" * 2001), dict(p_title="x", p_body="", p_audience=[]),
                   dict(p_title="x", p_body="", p_audience=[stranger.mid])):
        with raises("invalid_input"):
            t.owner.rpc("send_announcement", p_trip=t.id, **kwargs)
    assert db.count("notifications", "kind = 'announcement'") == 0


def test_delete_notification(db):
    t = new_trip(db)
    admin = t.admin("מנהלת")
    a = t.join("א")
    mine = admin.rpc("send_announcement", p_trip=t.id, p_title="של המנהלת", p_body="")
    owners = t.owner.rpc("send_announcement", p_trip=t.id, p_title="של הבעלים", p_body="")
    with raises("forbidden"):
        a.rpc("delete_notification", p_notification=mine)
    admin.rpc("delete_notification", p_notification=mine)
    admin.rpc("delete_notification", p_notification=owners)     # any admin
    with raises("not_found"):
        admin.rpc("delete_notification", p_notification=owners)
    assert db.count("notifications", "kind = 'announcement'") == 0


def test_snapshot_notifications_newest_first_and_capped(db):
    t = new_trip(db)
    db.sql("""insert into notifications (trip_id, kind, title, created_at)
              select %s, 'announcement', 'n' || g, now() - make_interval(mins => g)
              from generate_series(1, 230) g""", [t.id])
    notes = t.owner.snap(t.id)["notifications"]
    assert len(notes) == 200
    assert [n["title"] for n in notes[:3]] == ["n1", "n2", "n3"]
    stamps = [n["created_at"] for n in notes]
    assert stamps == sorted(stamps, reverse=True)


# --- reads -----------------------------------------------------------------------------

def test_mark_read_and_reads_visibility(db):
    t = new_trip(db)
    admin = t.admin("מנהלת")
    a = t.join("א")
    b = t.join("ב")
    everyone = admin.rpc("send_announcement", p_trip=t.id, p_title="לכולם", p_body="")
    only_b = t.owner.rpc("send_announcement", p_trip=t.id, p_title="רק לב", p_body="",
                         p_audience=[b.mid])
    rev = db.val("select rev from trips where id = %s", [t.id])
    a.rpc("mark_read", p_trip=t.id, p_ids=[everyone, only_b, "00000000-0000-0000-0000-000000000000"])
    assert db.sql("select notification_id from notification_reads where member_id = %s",
                  [a.mid]) == [{"notification_id": everyone}], "ignores ids not visible to me"
    a.rpc("mark_read", p_trip=t.id, p_ids=[everyone])           # idempotent
    assert db.count("notification_reads", "member_id = %s", [a.mid]) == 1
    assert db.val("select rev from trips where id = %s", [t.id]) == rev + 1, "bump only on change"
    b.rpc("mark_read", p_trip=t.id, p_ids=[everyone, only_b])
    a.rpc("mark_read", p_trip=t.id, p_ids=[])

    def reads(actor):
        return sorted((r["notification_id"], r["member_id"]) for r in actor.snap(t.id)["reads"])

    assert reads(t.owner) == sorted([(everyone, a.mid), (everyone, b.mid), (only_b, b.mid)])
    # author (admin anyway) sees reads of her announcement
    assert (everyone, a.mid) in reads(admin)
    # members: own reads only
    assert reads(a) == [(everyone, a.mid)]
    assert reads(b) == sorted([(everyone, b.mid), (only_b, b.mid)])
    snap_read = a.snap(t.id)["reads"][0]
    assert set(snap_read) == {"notification_id", "member_id", "read_at"}


def test_member_author_sees_reads_of_own_notifications(db):
    """A demoted former admin keeps seeing who read what she authored."""
    t = new_trip(db)
    author = t.admin("כותבת")
    a = t.join("א")
    nid = author.rpc("send_announcement", p_trip=t.id, p_title="הודעה", p_body="")
    t.owner.rpc("set_role", p_member=author.mid, p_role="member")
    a.rpc("mark_read", p_trip=t.id, p_ids=[nid])
    assert (nid, a.mid) in {(r["notification_id"], r["member_id"])
                            for r in author.snap(t.id)["reads"]}
    assert nid in visible_ids(author, t.id)


# --- polls -----------------------------------------------------------------------------

def test_single_choice_poll(db):
    t = new_trip(db)
    a = t.join("א")
    b = t.join("ב")
    pid = a.rpc("create_poll", p_trip=t.id, p_question="כמה ארוחות על האש?",
                p_options=[" 2 — צהריים וערב ", "", "3 — כולל נשנוש לילה"])
    poll = next(p for p in b.snap(t.id)["polls"] if p["id"] == pid)
    assert poll["options"] == [{"id": "o1", "label": "2 — צהריים וערב"},
                               {"id": "o2", "label": "3 — כולל נשנוש לילה"}]
    assert poll["multi"] is False and poll["closed"] is False and poll["created_by"] == a.mid
    b.rpc("vote_poll", p_poll=pid, p_option_ids=["o1"])
    b.rpc("vote_poll", p_poll=pid, p_option_ids=["o2"])        # replaces
    assert [(v["member_id"], v["option_id"]) for v in a.snap(t.id)["poll_votes"]] == [
        (b.mid, "o2")]
    with raises("invalid_input"):
        b.rpc("vote_poll", p_poll=pid, p_option_ids=["o1", "o2"])
    with raises("invalid_input"):
        b.rpc("vote_poll", p_poll=pid, p_option_ids=["o9"])
    b.rpc("vote_poll", p_poll=pid, p_option_ids=[])             # clears
    assert db.count("poll_votes") == 0


def test_multi_choice_poll_and_closing(db):
    t = new_trip(db)
    a = t.join("א")
    b = t.join("ב")
    pid = t.owner.rpc("create_poll", p_trip=t.id, p_question="חוץ מבירה ובריזר — מה עוד?",
                      p_options=["וודקה", "ערק", "רק יין", "מספיק מה שיש"], p_multi=True)
    a.rpc("vote_poll", p_poll=pid, p_option_ids=["o1", "o2", "o2"])
    assert sorted(v["option_id"] for v in a.snap(t.id)["poll_votes"]) == ["o1", "o2"]
    with raises("forbidden"):
        b.rpc("close_poll", p_poll=pid, p_closed=True)
    t.owner.rpc("close_poll", p_poll=pid, p_closed=True)
    with raises("not_allowed_state"):
        b.rpc("vote_poll", p_poll=pid, p_option_ids=["o3"])
    t.owner.rpc("close_poll", p_poll=pid, p_closed=False)
    b.rpc("vote_poll", p_poll=pid, p_option_ids=["o3"])
    with raises("forbidden"):
        b.rpc("delete_poll", p_poll=pid)
    t.owner.rpc("delete_poll", p_poll=pid)
    assert db.count("polls") == 0 and db.count("poll_votes") == 0


def test_poll_creator_can_close_and_delete(db):
    t = new_trip(db)
    a = t.join("א")
    pid = a.rpc("create_poll", p_trip=t.id, p_question="מתי יוצאים?", p_options=["8", "9"])
    a.rpc("close_poll", p_poll=pid, p_closed=True)
    a.rpc("delete_poll", p_poll=pid)
    assert db.count("polls") == 0


def test_poll_validation(db):
    t = new_trip(db)
    bad = [dict(p_question="", p_options=["a", "b"]), dict(p_question="x" * 141, p_options=["a", "b"]),
           dict(p_question="x", p_options=["a"]), dict(p_question="x", p_options=["a", " "]),
           dict(p_question="x", p_options=[str(n) for n in range(9)]),
           dict(p_question="x", p_options=["a", "b" * 81]), dict(p_question="x", p_options=None)]
    for kwargs in bad:
        with raises("invalid_input"):
            t.owner.rpc("create_poll", p_trip=t.id, **kwargs)
    with raises("forbidden"):
        db.user().rpc("create_poll", p_trip=t.id, p_question="x", p_options=["a", "b"])


# --- push subscriptions ----------------------------------------------------------------

def test_push_subscription_save_and_delete_own(db):
    t = new_trip(db)
    a = t.join("א")
    sub = {"endpoint": "https://fcm.googleapis.com/fcm/send/abc", "keys": {"p256dh": "P", "auth": "A"}}
    a.rpc("save_push_subscription", p_trip=t.id, p_sub=sub)
    a.rpc("save_push_subscription", p_trip=t.id,
          p_sub={**sub, "keys": {"p256dh": "P2", "auth": "A2"}})   # upsert by endpoint
    row = db.one("select * from push_subscriptions")
    assert (row["member_id"], row["user_id"], row["p256dh"], row["auth"]) == (
        a.mid, a.uid, "P2", "A2")
    t.owner.rpc("delete_push_subscription", p_endpoint=sub["endpoint"])   # not the owner
    assert db.count("push_subscriptions") == 1
    a.rpc("delete_push_subscription", p_endpoint=sub["endpoint"])
    assert db.count("push_subscriptions") == 0
    for bad in ({"endpoint": "http://insecure", "keys": {"p256dh": "P", "auth": "A"}},
                {"endpoint": "https://x"}, {"endpoint": "https://x", "keys": {"auth": "A"}}, None):
        with raises("invalid_input"):
            a.rpc("save_push_subscription", p_trip=t.id, p_sub=bad)
    with raises("forbidden"):
        db.user().rpc("save_push_subscription", p_trip=t.id, p_sub=sub)


def test_leaving_removes_my_push_subscriptions(db):
    t = new_trip(db)
    a = t.join("א")
    a.rpc("save_push_subscription", p_trip=t.id,
          p_sub={"endpoint": "https://push.example/a", "keys": {"p256dh": "P", "auth": "A"}})
    a.rpc("leave_trip", p_trip=t.id)
    assert db.count("push_subscriptions") == 0
