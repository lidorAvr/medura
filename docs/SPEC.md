# מדורה (Medura) — Build Spec v1 (the contract)

Group-trip organizer PWA. First real use: friends' Sukkot camping at **פארק החבשושיות**, overnight **Thu 2026‑10‑01 09:00 → Fri 2026‑10‑02 ~11:00**. It replaces a chaotic WhatsApp group where lists, "who brings what", shopping split and money get lost.

Every agent MUST follow this file exactly. If something is missing, choose the simplest option consistent with this spec and **report it in your final answer under "SPEC GAPS"**. Never rename anything defined here.

---

## 0. Product goals (from the user, verbatim intent)

1. One central, beautiful, **fun** interface. High UX. Mobile first (everyone opens it from a WhatsApp link on a phone).
2. Everyone invited enters and sets a **profile: single (יחיד) or couple (זוג)**.
3. All lists, shopping, items and responsibilities divided among everyone, **by category** (personal gear, group gear, food, ...).
4. Group chooses **admin(s)** ("מנהלים") who manage responsibilities, lists, who brings what, and **approve** details. But **every user can propose items and declare what they bring**.
5. **Money**: collection list + shared costs after shopping, **split automatically** between participants (couple = 2 shares).
6. Admin can send **"push" messages to everyone or to specific people**.
7. Personal customization in profile (notification/reminder settings, and more).
8. Reusable for future trips (multi-trip; each trip has its own invite link).

Non-goals v1: real money transfer (we show who pays whom + phone for Bit/PayBox and track "paid/confirmed"), chat (WhatsApp stays for chat), receipts upload.

Phase 1 (this build): everything except real Web Push delivery and scheduled reminders. Phase 2: Web Push (edge function + service worker) and reminders (pg_cron). Phase‑1 code must already contain: `push_subscriptions` table + RPCs, prefs UI for notifications/reminders (saved in `members.prefs`), service worker with `push` + `notificationclick` handlers.

---

## 1. Stack & constraints

- **No build step. No Node.** Static files served as-is. ES modules + import map. Must work under a sub-path (`https://lidoravr.github.io/medura/`) → **all URLs relative** (never leading `/`). Hash routing.
- UI: **Preact 10 + htm** (vendored in `js/vendor/`), hooks from `preact/hooks`. No other UI libs. No signals.
- Backend: **Supabase** (Postgres + anonymous auth + realtime + later edge functions). `supabase-js` v2 vendored as UMD: `js/vendor/supabase.umd.js` → `window.supabase.createClient`.
- `config.js` sets `window.MEDURA_CONFIG = { supabaseUrl: "", supabaseAnonKey: "", vapidPublicKey: "" }`. Empty `supabaseUrl` **or** `?demo=1` in `location.search` ⇒ **demo mode** (in-browser fake backend, localStorage).
- Language: Hebrew UI, `<html lang="he" dir="rtl">`. Use CSS logical properties. Wrap numbers/Latin text in `<bdi>` where mixed.
- Security: never use `dangerouslySetInnerHTML`. All user text rendered via htm (auto-escaped). URLs we build are `https:`/`tel:`/`https://wa.me/` only.
- Currency ILS `₪`. Timezone Asia/Jerusalem for display (`Intl.DateTimeFormat('he-IL', {timeZone:'Asia/Jerusalem'})`).

### Import map (in `index.html`)
```html
<script type="importmap">{"imports":{
  "preact":"./js/vendor/preact.module.js",
  "preact/hooks":"./js/vendor/hooks.module.js",
  "htm":"./js/vendor/htm.module.js",
  "htm/preact":"./js/vendor/htm-preact.module.js"}}</script>
<script src="./js/vendor/supabase.umd.js"></script>
<script src="./config.js"></script>
<script type="module" src="./js/main.js"></script>
```
Components use: `import { html } from 'htm/preact'; import { useState, useEffect, useMemo, useRef } from 'preact/hooks';`

---

## 2. File layout & ownership

```
index.html, manifest.webmanifest, sw.js, config.js, favicon.svg      (UI-foundation agent)
assets/icons/icon-192.png, icon-512.png, maskable-512.png            (UI-foundation agent)
css/styles.css                         (UI-foundation: tokens + ALL shared component styles + layout)
css/home.css css/lists.css css/money.css css/messages.css css/people.css css/me.css css/trip.css css/onboarding.css
                                       (one per screen; UI-foundation creates them EMPTY and links them all in index.html;
                                        each screen agent owns its own file)
js/main.js js/app.js js/router.js js/store.js      (UI-foundation)
js/ui/components.js js/ui/icons.js                 (UI-foundation)
js/screens/onboarding.js                           (UI-foundation)
js/screens/home.js js/screens/trip.js              (screen agent "home")
js/screens/lists.js js/screens/shopping.js js/screens/import.js   (screen agent "lists")
js/screens/money.js                                (screen agent "money")
js/screens/messages.js js/screens/people.js js/screens/me.js      (screen agent "social")
js/lib/logic.js                                    (logic agent) — pure functions, no DOM, no imports except none
js/api/index.js js/api/errors.js js/api/supabase-api.js js/api/demo-api.js js/api/demo-seed.js  (api agent)
supabase/schema.sql                                (db agent) — single file, safe to paste into Supabase SQL editor once on a fresh project; re-runnable where practical (create or replace functions; `if not exists` tables)
tests/db/**  (db agent, pytest + embedded Postgres via `pgserver`)
tests/web/logic.test.js, tests/web/logic.html, tests/test_logic.py   (logic agent; pytest runs the JS tests in Chromium via Playwright)
tests/e2e/**  (integration phase)
private/**    (gitignored: real seed data for the group's trip)
```
**Stage‑2 screen agents must not edit files they don't own.** If a shared component/store/api function is missing, implement a local helper inside your own file and list it under SPEC GAPS.
UI-foundation creates every screen file as a working placeholder so the app runs before screens are filled in.

Python env: `C:\Users\lidor\Projects\medura\.venv` (pytest, pgserver, psycopg, playwright, pillow). **Playwright's bundled Chromium is NOT installed (download blocked) — always launch with `p.chromium.launch(channel="msedge")` (fallback `channel="chrome"`)**; with pytest-playwright pass `--browser-channel msedge`. Run tests with `.venv\Scripts\python.exe -m pytest ...` from the project root. Static server: **use `tools/devserver.py`** (no-cache, correct MIME). In pytest: `sys.path.insert(0, r'C:\Users\lidor\Projects\medura\tools'); from devserver import start_server; srv, base = start_server()` (free port, background thread; `srv.shutdown()` in teardown). Manual: `.venv\Scripts\python.exe tools\devserver.py 5178`.

---

## 3. Data model (Postgres, schema `public`)

All ids `uuid default gen_random_uuid()`. All timestamps `timestamptz default now()`. Every child table carries `trip_id` (needed for RLS & snapshot).

| table | columns |
|---|---|
| `trips` | id, name text (1..60), emoji text default '⛺', location text, location_url text, lat double, lon double, starts_at timestamptz, ends_at timestamptz, info jsonb default `{"schedule":[],"rules":[],"notes":""}`, settings jsonb default `{"require_approval":true}`, invite_code text unique not null, rev bigint default 0, created_by uuid (auth user), created_at, updated_at |
| `members` (a *unit*: single or couple) | id, trip_id, display_name text (1..40), headcount int default 1 check 1..8, people text[] default '{}', emoji text default '🙂', color text default '#2F6B4F', role text check in ('owner','admin','member') default 'member', phone text, prefs jsonb default '{}', inventory text[] default '{}', claimed_at timestamptz null, created_at |
| `member_secrets` | member_id pk → members on delete cascade, trip_id, device_code text unique | (NO select policy — only via RPC)
| `member_users` | user_id uuid, trip_id, member_id → members on delete cascade, created_at, **pk(user_id, trip_id)** (one member per user per trip; many users (devices/partner) per member) |
| `categories` | id, trip_id, name (1..40), emoji default '📦', sort int default 0, default_buyer_id uuid null → members on delete set null, note text, created_at |
| `items` | id, trip_id, category_id null → categories on delete set null, title (1..120), note text (≤500), type text check in ('buy','bring','each','task'), qty numeric null, unit text null (≤20), per_person bool default false, needed int default 1 check 1..200, status text check in ('proposed','active','rejected') default 'active', done bool default false, done_at, reject_reason text, created_by uuid → members on delete set null, approved_by uuid null, sort int default 0, created_at, updated_at |
| `pledges` | id, trip_id, item_id → items on delete cascade, member_id → members on delete cascade, qty int default 1 check 1..200, done bool default false, assigned_by uuid null (member who assigned), created_at, **unique(item_id, member_id)** |
| `expenses` | id, trip_id, title (1..80), amount numeric(10,2) check >0 and ≤100000, paid_by → members, category_id null, note, split_mode text check in ('all','members') default 'all', created_by → members, spent_on date default current_date, created_at |
| `expense_shares` | expense_id → expenses on delete cascade, trip_id, member_id → members on delete cascade, weight numeric check >0, pk(expense_id, member_id) | (only for split_mode='members')
| `payments` | id, trip_id, from_member → members, to_member → members, amount numeric(10,2) check >0, method text check in ('bit','paybox','cash','transfer','other') default 'bit', note, status text check in ('sent','confirmed') default 'sent', created_by → members, created_at, confirmed_at |
| `notifications` | id, trip_id, kind text check in ('announcement','system','reminder'), title (1..80), body text (≤2000), audience uuid[] null (null = everyone), author_member uuid null, urgent bool default false, link text null (hash route like `#/t/<trip>/lists`), created_at |
| `notification_reads` | notification_id → notifications on delete cascade, trip_id, member_id → members on delete cascade, read_at, pk(notification_id, member_id) |
| `admin_votes` | trip_id, voter_id → members cascade, candidate_id → members cascade, created_at, pk(voter_id, candidate_id) |
| `polls` | id, trip_id, question (1..140), options jsonb (array of `{id:text,label:text}`, 2..8), multi bool default false, closed bool default false, created_by → members, created_at |
| `poll_votes` | poll_id → polls cascade, trip_id, member_id → members cascade, option_id text, pk(poll_id, member_id, option_id) |
| `personal_items` | id, trip_id, member_id → members cascade, title (1..80), done bool default false, sort int default 0, created_at | (private to the member)
| `push_subscriptions` | id, trip_id, member_id → members cascade, user_id uuid, endpoint text unique, p256dh text, auth text, created_at | (no select policy)

Limits (enforce in RPCs, raise `limit_reached`): 60 members/trip, 600 items/trip, 300 expenses/trip, 100 personal items/member.

### Semantics
- **headcount**: single = 1, couple = 2 (UI toggle writes 1 or 2; admins may set up to 8 for families). Money splits and per-person quantities use headcount.
- **Item types**
  - `buy` — shopping list. Assignee = the *buyer* (pledge row, usually one). `items.done` = bought. Cost is recorded later as an expense.
  - `bring` — from home. `needed` = how many units the group needs (e.g. beach chairs 10). Many pledges with qty. Covered when Σqty ≥ needed. Each pledge has its own `done` (= packed).
  - `each` — everyone (every member unit) brings their own (e.g. "cutting board, knife, fork — every couple"). Per-member done via a pledge row with `done=true` (created lazily by `set_pledge_done`).
  - `task` — a to‑do (e.g. "call to reserve the big fridge"). Assignee via pledge; `items.done` = completed.
- **per_person**: `qty` is per head (e.g. 300 גרם); effective total = qty × total headcount of the trip (all members).
- **status**: `proposed` (awaiting admin approval) → `active` or `rejected`. If `settings.require_approval` is false, or the creator is admin/owner, new items are `active` immediately.
- **Admins** = role in ('owner','admin'). Owner = first member of a trip (creator, or first joiner of a seeded trip that has no owner/admin). Owner cannot be demoted or removed. There must always be ≥1 owner/admin.
- **Admin election**: any member can toggle a vote for any member (`admin_votes`). Vote counts are visible to all. Admins promote/demote via `set_role` (UI highlights the top-voted non-admins).
- **Money**
  - Expense share: `split_mode='all'` ⇒ every *current* member participates with weight = headcount (members who join later are included automatically). `split_mode='members'` ⇒ only `expense_shares` rows, weight default = that member's headcount.
  - Member balance = paid (Σ expenses paid_by) − owed (Σ shares) + sent payments (Σ payments from, any status) − received payments (Σ payments to, any status). Positive ⇒ the group owes them. Payments count immediately when `sent`; `confirmed` is a trust marker only.
  - Settle plan: greedy (largest debtor pays largest creditor), amounts rounded to whole shekels, drop transfers < ₪1.
- **Notifications**: `audience` null ⇒ all members. Visible to a member if audience is null, or contains them, or they are the author, or (kind='announcement' and they are admin). System notifications are created inside RPCs (list in §4).

### RLS
RLS **enabled on every table**. **No insert/update/delete policies at all** — every write goes through `SECURITY DEFINER` RPCs (`set search_path = public, pg_temp`). SELECT policies (defense-in-depth + Realtime):
- `trips`: member of the trip. `members, categories, items, pledges, expenses, expense_shares, payments, admin_votes, polls, poll_votes`: member of the trip.
- `notifications`: visibility rule above. `notification_reads`: own rows, or trip admins.
- `personal_items`: own member only. `member_users`: own rows only. `member_secrets`, `push_subscriptions`: none.
Helper SQL functions (SECURITY DEFINER, stable): `_my_member(p_trip uuid) returns uuid` (member id of auth.uid() in the trip or null), `_is_member(p_trip)`, `_is_admin(p_trip)`.
`revoke all on all functions in schema public from public, anon;` then `grant execute` on the public RPCs **to authenticated only**. Every RPC raises `not_authenticated` if `auth.uid()` is null.
Every mutating RPC ends with `perform _bump(trip_id)` → `update trips set rev = rev + 1, updated_at = now()`. Add **only `trips`** to `supabase_realtime` publication (clients subscribe to their trip row and refetch the snapshot).
Invite/device codes: 10 chars from alphabet `abcdefghjkmnpqrstuvwxyz23456789` generated with `gen_random_bytes` (pgcrypto; in Supabase it lives in schema `extensions` → call `extensions.gen_random_bytes` if present else `gen_random_bytes`; simplest: use `gen_random_uuid()`-derived randomness, `md5(gen_random_uuid()::text)` is acceptable).

### Errors
RPCs raise `raise exception '<code>'` with these exact codes (the client maps them to Hebrew): `not_authenticated, forbidden, not_found, invalid_input, invalid_code, already_claimed, already_member, last_admin, owner_locked, has_money_records, limit_reached, not_allowed_state`.

---

## 4. RPC contract (exact names & param names — supabase-js calls `rpc(name, {params})`)

All return types jsonb/uuid/void/int/text as noted. `p_*` jsonb patches ignore unknown keys; validate lengths/ranges → `invalid_input`.

| RPC | params | returns | who | notes / side effects |
|---|---|---|---|---|
| `my_trips` | – | jsonb array `[{trip:{id,name,emoji,location,starts_at,ends_at}, member:{id,display_name,emoji,color,role}}]` ordered by starts_at | any authed | |
| `create_trip` | p_trip jsonb, p_profile jsonb | jsonb `{trip_id, member_id}` | any authed | creator = owner, claimed; creates default categories (§6) |
| `preview_invite` | p_code text | jsonb `{trip:{id,name,emoji,location,starts_at,ends_at}, member_count, headcount, unclaimed:[{id,display_name,headcount,people,emoji,color}], my_member_id}` | any authed | `invalid_code` if unknown. `my_member_id` null if not joined |
| `join_trip` | p_code text, p_claim_member uuid default null, p_profile jsonb default null | jsonb `{trip_id, member_id}` | any authed | if already linked → return existing. Claim: member unclaimed & in trip else `already_claimed`/`not_found`; sets claimed_at, may apply p_profile patch. Else create member from p_profile (required). If trip has no owner/admin → new member role 'owner'. Notify admins (system): "<name> הצטרפ/ה לטיול 🎉" |
| `link_device` | p_device_code text | jsonb `{trip_id, member_id}` | any authed | adds member_users row (replaces this user's existing link in that trip) |
| `get_device_code` | p_member uuid | text | self | creates if missing |
| `get_trip_snapshot` | p_trip uuid | jsonb (§5) | member | `forbidden` otherwise |
| `update_trip` | p_trip uuid, p_patch jsonb | void | admin | keys: name, emoji, location, location_url, lat, lon, starts_at, ends_at, info, settings |
| `rotate_invite` | p_trip uuid | text | admin | |
| `update_member` | p_member uuid, p_patch jsonb | void | self or admin | keys: display_name, headcount, people, emoji, color, phone, prefs, inventory |
| `create_member` | p_trip uuid, p_profile jsonb | uuid | admin | unclaimed placeholder |
| `set_role` | p_member uuid, p_role text ('admin'\|'member') | void | admin | `owner_locked` for owner; `last_admin` if it would leave none; notify member when promoted: "מונית למנהל/ת 👑" |
| `remove_member` | p_member uuid | void | admin | `owner_locked`; `has_money_records` if any expense/payment references them; deletes pledges, votes, reads… |
| `leave_trip` | p_trip uuid | void | member | deletes my member_users row; if no users remain linked, member.claimed_at = null. Owner leaving: allowed only if another admin exists else `last_admin` |
| `vote_admin` | p_candidate uuid, p_on boolean | void | member | candidate in same trip |
| `upsert_category` | p_trip uuid, p_cat jsonb | uuid | admin | keys: id?, name, emoji, sort, default_buyer_id, note |
| `delete_category` | p_category uuid | void | admin | items keep, category_id → null |
| `add_item` | p_trip uuid, p_item jsonb | uuid | member | keys: category_id, title, note, type, qty, unit, per_person, needed, pledge_qty. Status per §3. If `pledge_qty>0` create my pledge. If status proposed → notify admins (audience = admin ids): "הצעה חדשה: <title>" |
| `add_items_bulk` | p_trip uuid, p_items jsonb (array of add_item objects; may carry `category_name`,`category_emoji` instead of `category_id`) | int | member | admins: unknown category names are created; non-admins: matched by name else null. Max 150 per call |
| `update_item` | p_item uuid, p_patch jsonb | void | admin, or creator while proposed | keys: category_id,title,note,type,qty,unit,per_person,needed,sort |
| `review_item` | p_item uuid, p_approve boolean, p_reason text default null | void | admin | only from proposed (`not_allowed_state`). Notify creator: "ההצעה אושרה ✅: <title>" / "ההצעה נדחתה: <title>" (+reason in body) |
| `delete_item` | p_item uuid | void | admin, or creator while proposed/rejected | |
| `pledge` | p_item uuid, p_qty int default 1 | void | member | self. qty ≤ 0 removes my pledge. Allowed if item active, or proposed & created by me. Not for `each` (`invalid_input`) |
| `assign` | p_item uuid, p_member uuid, p_qty int default 1 | void | admin | qty ≤ 0 removes; sets assigned_by. Notify member: "שובצת: <title>" |
| `set_pledge_done` | p_item uuid, p_done boolean | void | member | self; for `each` creates the pledge row if missing |
| `set_item_done` | p_item uuid, p_done boolean | void | pledger or admin | only type buy/task; sets done_at |
| `add_personal` | p_trip uuid, p_title text | uuid | member | |
| `add_personal_template` | p_trip uuid | int | member | inserts §6 template titles not already present |
| `update_personal` | p_id uuid, p_patch jsonb | void | owner of row | keys: title, done, sort |
| `delete_personal` | p_id uuid | void | owner of row | |
| `add_expense` | p_trip uuid, p_exp jsonb | uuid | member | keys: title, amount, paid_by (default me; ≠ me requires admin), category_id, note, spent_on, split_mode, members:[{member_id, weight?}] (required non-empty if split_mode='members') |
| `update_expense` | p_expense uuid, p_patch jsonb | void | creator, payer or admin | same keys; replacing `members` replaces shares |
| `delete_expense` | p_expense uuid | void | creator, payer or admin | |
| `add_payment` | p_trip uuid, p_pay jsonb | uuid | member | keys: from_member (default me), to_member, amount, method, note. from ≠ me allowed if admin, or if to_member = me (recipient records it; then status = confirmed). Notify the other side: "<from> סימן/ה שהעביר/ה לך ₪<amount>" |
| `confirm_payment` | p_payment uuid | void | recipient or admin | notify payer: "<to> אישר/ה שקיבל/ה ₪<amount> ✅" |
| `delete_payment` | p_payment uuid | void | creator (if not confirmed) or admin | |
| `send_announcement` | p_trip uuid, p_title text, p_body text, p_audience uuid[] default null, p_urgent boolean default false | uuid | admin | audience ids must be trip members |
| `delete_notification` | p_notification uuid | void | admin or author | |
| `mark_read` | p_trip uuid, p_ids uuid[] | void | member | ignores ids not visible to me |
| `create_poll` | p_trip uuid, p_question text, p_options text[], p_multi boolean default false | uuid | member | option ids 'o1'..'oN' |
| `vote_poll` | p_poll uuid, p_option_ids text[] | void | member | replaces my votes; empty clears; not when closed; single-choice ⇒ max 1 |
| `close_poll` | p_poll uuid, p_closed boolean | void | creator or admin | |
| `delete_poll` | p_poll uuid | void | creator or admin | |
| `save_push_subscription` | p_trip uuid, p_sub jsonb (`{endpoint, keys:{p256dh, auth}}`) | void | member | upsert by endpoint |
| `delete_push_subscription` | p_endpoint text | void | any authed | own rows only |

---

## 5. Snapshot shape (`get_trip_snapshot` → jsonb; the demo API returns the identical shape)

snake_case keys everywhere, numbers as JSON numbers, timestamps ISO strings, arrays never null (use `[]`).
```jsonc
{
  "trip": {"id","name","emoji","location","location_url","lat","lon","starts_at","ends_at","info":{"schedule":[{"time":"09:00","label":"הגעה","emoji":"🚗"}],"rules":[{"emoji":"🚫","text":"..."}],"notes":""},"settings":{"require_approval":true},"invite_code","rev","created_at"},
  "me": {"member_id","role","user_id"},
  "members": [{"id","display_name","headcount","people":[],"emoji","color","role","phone","prefs":{},"inventory":[],"claimed":true,"created_at"}],
  "categories": [{"id","name","emoji","sort","default_buyer_id","note"}],
  "items": [{"id","category_id","title","note","type","qty","unit","per_person","needed","status","done","done_at","reject_reason","created_by","approved_by","sort","created_at","updated_at"}],
  "pledges": [{"id","item_id","member_id","qty","done","assigned_by","created_at"}],
  "expenses": [{"id","title","amount","paid_by","category_id","note","split_mode","created_by","spent_on","created_at"}],
  "expense_shares": [{"expense_id","member_id","weight"}],
  "payments": [{"id","from_member","to_member","amount","method","note","status","created_by","created_at","confirmed_at"}],
  "notifications": [{"id","kind","title","body","audience":null,"author_member","urgent","link","created_at"}],   // only visible ones, newest first, max 200
  "reads": [{"notification_id","member_id","read_at"}],     // admins: all; members: own + reads of notifications they authored
  "admin_votes": [{"voter_id","candidate_id"}],
  "polls": [{"id","question","options":[{"id","label"}],"multi","closed","created_by","created_at"}],
  "poll_votes": [{"poll_id","member_id","option_id"}],
  "personal_items": [{"id","title","done","sort","created_at"}]   // mine only
}
```
Proposed items: visible to everyone (members see "ממתין לאישור"). Rejected items: visible to admins and to their creator only.

---

## 6. Defaults

**Default categories** (create_trip; also demo seed), sort 1..10:
`🥩 בשר ועוף` · `🥗 ירקות ופירות` · `🥫 מזווה ורטבים` · `🍿 נשנושים ומתוקים` · `🥤 שתייה ואלכוהול` · `🔥 מנגל ובישול` · `🍽️ חד־פעמי` · `⛺ ציוד קבוצתי` · `🎲 כיף ומשחקים` · `📋 משימות`

**Personal gear template** (add_personal_template, in this order):
אוהל · מזרן / מזרן מתנפח + משאבה · שק שינה / שמיכה · כרית · מגבת · בגד ים · כפכפים · קרם הגנה · כובע · פנס ראש / פנס · סוללה ניידת + מטען · בגדים חמים ללילה · ביגוד להחלפה · מברשת שיניים ומשחה · תרופות אישיות · בקבוק מים אישי · תעודה מזהה / כרטיסי כניסה

**Emoji palette for profiles**: ⛺ 🔥 🌲 🦊 🐻 🦉 🦔 🐢 🦎 🌙 ⭐ 🍉 🥩 🍺 🎸 🏕️ 🌈 🐬 🦄 🌵
**Color swatches**: #2F6B4F #F28C28 #E4572E #3A86FF #8E44AD #16A085 #D4A017 #C0392B #2C3E50 #FF6B9A

---

## 7. JS module contracts

### 7.1 `js/lib/logic.js` (pure; exported names exactly)
```
headcountTotal(members) -> number
membersById(members) -> Map<id, member>
isAdmin(member) -> bool                                  // role owner|admin
displayName(member) -> string                            // display_name, fallback people.join(' ו')
itemEffectiveQty(item, totalHeads) -> {value:number|null, unit:string|null, text:string}   // per_person scaling; 'גרם' >= 1000 -> 'ק"ג' (1 decimal); text like '3.3 ק"ג' or '12' or ''
itemProgress(item, pledges, members) -> {state, pledged, needed, doneCount, total, pledgers:[{member_id, qty, done}]}
     // state ∈ 'proposed'|'rejected'|'missing'|'partial'|'covered'|'done'
     // buy/task: missing (no pledge) | covered (has pledge) | done (item.done)
     // bring: missing (0) | partial (0<Σ<needed) | covered (Σ>=needed) | done (covered && every pledge done)
     // each: total = members.length, doneCount = #pledges done; done when doneCount==total, partial when >0, else missing
tripReadiness(snap) -> {pct:0..100, total, covered, missing, partial, proposed, done}   // over active items; each-items count covered when done
myAgenda(snap, memberId) -> {bring:[{item, pledge}], buy:[{item, pledge}], tasks:[{item, pledge}], each:[{item, done}], packedPct}
missingItems(snap) -> [item]                        // active, state missing|partial, sorted by category sort then item sort
expenseShares(expense, snap) -> [{member_id, amount}]   // exact cents, sum == amount (largest-remainder rounding to 0.01)
balances(snap) -> [{member_id, paid, owed, sent, received, balance}]   // rounded to 0.01
settlePlan(balancesArr) -> [{from, to, amount}]    // whole shekels, greedy, omit < 1
tripTotals(snap) -> {spent, perHead, heads}
parseListText(text) -> [{category:{name, emoji}|null, title, qty, unit, per_person, note, type:'buy'|'bring'|'each', raw}]
formatMoney(n) -> '₪1,234' (no decimals when whole) / '₪12.50'
formatQty(value, unit) -> string
countdown(startsAt, now=new Date()) -> {days, hours, minutes, past:bool, label}   // label Hebrew: 'בעוד 4 ימים', 'מחר!', 'היום!', 'עכשיו בטיול 🔥', 'הטיול הסתיים'
formatDate(iso, opts) / formatDateTime(iso) / formatTime(iso)   // he-IL, Asia/Jerusalem
timeAgo(iso, now) -> 'לפני 5 דק׳' ...
hebrewCount(n, singular, plural) -> '1 פריט' / '3 פריטים'
inviteUrl(baseUrl, code) -> `${baseUrl}#/join/${code}`   // baseUrl = location.origin + location.pathname
deviceLinkUrl(baseUrl, code) -> `${baseUrl}#/link/${code}`
whatsappShareUrl(text) -> 'https://wa.me/?text=' + encodeURIComponent(text)
whatsappChatUrl(phone, text?) -> 'https://wa.me/972XXXXXXXXX' (normalize IL numbers: 05X… → 9725X…; returns null if invalid)
buildInviteText(trip, url) -> string
buildSummaryText(snap, kind, memberId?) -> string   // kind: 'status' | 'missing' | 'mine' | 'settle' — WhatsApp-formatted (*bold*, emojis, bullet lines)
visibleNotifications(snap) / unreadCount(snap) -> number
pollResults(poll, votes) -> [{id, label, count, pct, voters:[member_id]}]
adminVoteCounts(snap) -> Map<candidate_id, count>
titleSimilarity(a, b) -> 'same' | 'similar' | null          // plural/prefix/typo-tolerant Hebrew title match
similarItems(title, items, {excludeId?, limit=3}) -> [{item, match}]   // non-rejected look-alikes, 'same' first
```
Tests: `tests/web/logic.test.js` (tiny in-file assert harness, exported `run()` returning `{passed, failed, failures:[...]}`), `tests/web/logic.html` loads it; `tests/test_logic.py` serves the project root over HTTP, opens the page in Playwright Chromium, asserts `failed == 0`. Must include the real group's list text (from §9) as a parser fixture.

### 7.2 `js/api/*`
`js/api/index.js`: `export async function createApi() -> api` (reads `window.MEDURA_CONFIG`; demo if no URL or `?demo=1`).
`js/api/errors.js`: `export class ApiError extends Error { code }`, `export function hebrewError(code) -> string`, `export function toApiError(err) -> ApiError` (maps Postgres/Supabase error message codes of §3 + network errors → code `network`).
Both implementations expose **exactly** these async methods (camelCase wrappers of §4, arguments in this order) and properties:
```
mode ('supabase'|'demo'), init(), ensureSession() -> {userId}, getUserId(),
myTrips(), createTrip(trip, profile), previewInvite(code), joinTrip(code, {claimMemberId, profile}), linkDevice(code), getDeviceCode(memberId),
getSnapshot(tripId), subscribe(tripId, onChange) -> unsubscribe,
updateTrip(tripId, patch), rotateInvite(tripId), updateMember(memberId, patch), createMember(tripId, profile), setRole(memberId, role),
removeMember(memberId), leaveTrip(tripId), voteAdmin(candidateId, on),
upsertCategory(tripId, cat), deleteCategory(categoryId),
addItem(tripId, item), addItemsBulk(tripId, items), updateItem(itemId, patch), reviewItem(itemId, approve, reason), deleteItem(itemId),
pledge(itemId, qty), assign(itemId, memberId, qty), setPledgeDone(itemId, done), setItemDone(itemId, done),
addPersonal(tripId, title), addPersonalTemplate(tripId), updatePersonal(id, patch), deletePersonal(id),
addExpense(tripId, exp), updateExpense(id, patch), deleteExpense(id),
addPayment(tripId, pay), confirmPayment(id), deletePayment(id),
sendAnnouncement(tripId, {title, body, audience, urgent}), deleteNotification(id), markRead(tripId, ids),
createPoll(tripId, {question, options, multi}), votePoll(pollId, optionIds), closePoll(pollId, closed), deletePoll(pollId),
savePushSubscription(tripId, sub), deletePushSubscription(endpoint)
```
Supabase impl: `createClient(url, anonKey, {auth:{persistSession:true, autoRefreshToken:true, storageKey:'medura-auth'}})`; `ensureSession` uses `auth.signInAnonymously()` when no session. `subscribe` = channel `trip-<id>` on `postgres_changes` UPDATE `public.trips` filter `id=eq.<id>` → `onChange()`; plus `visibilitychange`/`online` → `onChange()`; plus a 45 s poll fallback. All errors → `toApiError`.
Demo impl (`demo-api.js` + `demo-seed.js`): full in-memory model persisted in `localStorage['medura:demo:v1']`, **same permission rules and error codes as the SQL**, same snapshot shape, same system notifications. Seeds one sample trip ("טיול לדוגמה בכנרת 🌊", fictional names, ~25 items across all types/states, 3 expenses, 1 payment, 2 announcements, 1 poll) on first run; the demo user is linked as owner of the sample trip. `subscribe` fires on same-tab mutations (EventTarget) and cross-tab `storage` events. Extra: `api.demo = { reset(), actAs(memberId) }` (re-link the current demo user to another member of the current trip — used by E2E tests and a "🎭 החלף משתמש" control shown only in demo mode). Simulate latency 60–120 ms.

### 7.3 `js/store.js` (UI-foundation)
```
export const store  // { get(), set(patch), subscribe(fn) }
   state: { api, mode, userId, ready, trips:[], tripId:null, snap:null, loading:false, error:null, online:true, toasts:[], theme:'auto' }
export function useStore(selector)                 // hook; re-renders on selected value change (shallow compare)
export const actions = {
  boot(),                                          // createApi, init, ensureSession, load myTrips, route-aware
  loadTrips(), openTrip(tripId), refresh(),        // refresh = getSnapshot for current trip (dedup concurrent calls)
  run(fn, {success, error, refresh=true}),         // await fn(api); toast success (Hebrew) / error (hebrewError); refresh snapshot; returns result or undefined on error
  toast(text, kind='info'|'success'|'error', ms=2600),
  setTheme(theme)
}
export function useTrip()   // -> { snap, me (member obj), isAdmin, tripId }
```
Realtime: `openTrip` subscribes via `api.subscribe` and debounces refresh (250 ms). After each refresh, detect **new notifications visible to me** (id not seen before in this session and created after boot) → toast them (title) + `navigator.vibrate?.(30)` for urgent.

### 7.4 `js/router.js`
`useRoute() -> {path, params, query}`, `navigate(hash)`, `href(path)` → `'#' + path`. Routes:
`/` landing/trip picker · `/new` create trip · `/join/:code` · `/link/:code` · `/t/:tripId` home · `/t/:tripId/lists` (query `tab`, `item`) · `/t/:tripId/shop` (query `buyer`) · `/t/:tripId/import` · `/t/:tripId/money` · `/t/:tripId/messages` · `/t/:tripId/people` · `/t/:tripId/me` · `/t/:tripId/trip`.

### 7.5 Screen module contract
Each `js/screens/<name>.js` exports `default function <Name>Screen({ route })`. Use `useTrip()`, `actions.run(api => api.xxx(...), {success:'...'})`, components from `../ui/components.js`, logic from `../lib/logic.js`. Screens must render sensibly while `snap` is null (skeleton).

### 7.6 `js/ui/components.js` (exact exports)
`Button({variant:'primary'|'secondary'|'ghost'|'danger'|'accent', size:'sm'|'md'|'lg', icon, block, loading, disabled, onClick, type, children})`,
`IconButton({icon, label, onClick, badge})`, `Card({title, emoji, action, tone:'default'|'accent'|'success'|'warning'|'danger', onClick, children, class})`,
`Sheet({open, onClose, title, children, footer})` (bottom sheet, ESC/backdrop closes, focus trap light, `inert` background not required),
`confirmDialog({title, text, confirmText, danger}) -> Promise<boolean>` (imperative, renders into a portal root),
`Avatar({member, size})` (emoji on color circle; couples (headcount≥2) get a small "2" badge), `AvatarStack({members, max, size})`,
`Chip({active, onClick, children, tone})`, `Segmented({options:[{value,label,badge}], value, onChange})`,
`ProgressRing({value, size, stroke, children})`, `ProgressBar({value, tone})`, `Pill({tone, children})`,
`Stepper({value, min, max, onChange})`, `Field({label, hint, error, children})`, `TextInput(props)`, `TextArea(props)`, `MoneyInput({value, onChange})`, `Toggle({checked, onChange, label, hint})`,
`EmptyState({emoji, title, text, action})`, `Section({title, emoji, count, right, collapsible, defaultOpen, children})`, `Skeleton({lines})`,
`EmojiPicker({value, onChange, options})`, `ColorPicker({value, onChange})`, `MemberPicker({members, value, onChange, multi})`,
`Fab({icon, label, onClick})`, `ShareButton({text, label})` (opens `whatsappShareUrl`; uses `navigator.share` when available with fallback), `CopyButton({text, label})`,
`fireConfetti()` (lightweight canvas confetti, respects prefers-reduced-motion).
`js/ui/icons.js`: inline SVG icon functions (`Icon({name, size})`) for: home, list, wallet, bell, users, user, plus, check, x, edit, trash, share, copy, cart, chevron-left, chevron-right, chevron-down, settings, map-pin, calendar, clock, sun, moon, flame, tent, search, filter, send, crown, sparkles, receipt, arrow-left-right, download, link, logout.

---

## 8. UX & visual design

Brand: **מדורה 🔥** — "כל החבר'ה סביב המדורה". Mood: warm campfire at dusk + pine forest; playful, rounded, generous spacing, delightful micro-interactions (button press scale, check animation, confetti when a list completes / trip reaches 100%), emoji-forward. Never cluttered; one primary action per screen region.

Tokens (CSS custom properties on `:root`, dark overrides via `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])` and `:root[data-theme="dark"]`):
- light: `--bg #FBF6EE` `--surface #FFFFFF` `--surface-2 #F4EDE1` `--ink #1E2A23` `--muted #6B776F` `--line #E8DFD0` `--primary #2F6B4F` `--primary-ink #FFFFFF` `--accent #F28C28` `--ember #E4572E` `--success #2E9E6A` `--warning #D99A1E` `--danger #D64545` `--info #3A86FF`
- dark ("night camp"): `--bg #0E1512` `--surface #16201B` `--surface-2 #1D2A23` `--ink #EEF3EF` `--muted #9AA89F` `--line #26352D` `--primary #62C08F` `--primary-ink #0E1512` `--accent #FFA64D` `--ember #FF7A50` …
- radius 18px cards / 14px controls / 999px chips; shadows soft & warm; spacing 4/8/12/16/24/32.
- Font: Google Fonts **Rubik** (400,500,700,800) via `<link>` with `display=swap`, fallback `system-ui, "Segoe UI", Arial`. Numbers `font-variant-numeric: tabular-nums`.
- Layout: max-width 560px centered column; sticky top bar (trip emoji+name, unread bell with badge, avatar → me); **bottom nav** with 5 tabs: 🏕️ בית · 📋 רשימות · 💸 כסף · 🔔 הודעות · 👥 חבר'ה (active tab pill, safe-area insets). FAB on lists/money. 16px side gutters. Tap targets ≥ 44px. No horizontal scroll at 360px width.
- Motion: 150–250ms ease-out; `prefers-reduced-motion` disables confetti and transforms.
- Every action gives feedback (toast / check animation). Destructive actions use `confirmDialog`. Loading uses skeletons, not spinners, for screens.

### Screens (what each must contain)
1. **Onboarding** (`onboarding.js`, routes `/`, `/new`, `/join/:code`, `/link/:code`)
   - Landing: logo + tagline, list of my trips (cards), "צור טיול חדש", "יש לי קישור / קוד" (paste full link or code → navigates to join). If exactly one trip → auto-open it.
   - Join: trip preview card (emoji, name, date, location, "X משתתפים"), then **"מי אתם?"** grid of unclaimed seeded profiles ("זה אנחנו!") + "אנחנו חדשים ✨" → profile form: big toggle 🧍 יחיד / 👫 זוג, name field(s) (1 or 2), auto display name ("הדס ועידו"), EmojiPicker, ColorPicker, phone (optional, "בשביל Bit — יוצג רק לחברי הטיול"). Claiming a seeded profile shows the same form prefilled. Submit "יאללה, נכנסים! 🔥" → confetti → trip home. Already a member → straight to trip.
   - Link device: "מחברים מכשיר נוסף לפרופיל של <name>" → confirm → home.
   - New trip: name, emoji, location, start date+time, end date+time, then the creator's profile form → created → **share invite** screen (WhatsApp share of `buildInviteText`, copy link) → home.
2. **Home** (`home.js`): hero (trip emoji, name, countdown label, date, location chip → trip screen); **readiness ring** (tripReadiness pct) with "X חסרים · Y ממתינים לאישור"; **"המשימות שלי"** (myAgenda: what I bring/buy/do + each-items, with inline done checkboxes, packedPct bar) ; **"עדיין חסר 🙋"** (top 6 missingItems with one-tap "אני מביא ✋" (pledge 1)) + "לכל הרשימות"; **my money chip** (balance → money screen); **latest announcement** card (unread highlighted); quick actions row: ➕ הצע פריט · 🧾 הוצאה חדשה · 📣 הודעה (admins) · 📤 סיכום לוואטסאפ (buildSummaryText 'status'); admins: "ממתינים לאישור" card with approve/reject inline.
3. **Trip** (`trip.js`): hero, dates, Waze (`https://waze.com/ul?q=<location>&navigate=yes` or ll=lat,lon) + Google Maps links, **schedule timeline** (info.schedule), **rules & tips** (info.rules), notes, weather (Open-Meteo `https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=Asia%2FJerusalem&start_date=..&end_date=..`, only when lat/lon set and trip within 14 days; fail silently), invite link (copy/share), admin edit sheet for all trip fields incl. schedule/rules editors and `settings.require_approval` toggle.
4. **Lists** (`lists.js`): Segmented tabs: `הכל` · `🛒 קניות` · `🎒 מהבית` · `🙋 כל אחד` · `✅ משימות` · `⏳ לאישור (n)` · `⭐ שלי` ; search box; "רק מה שחסר" toggle. Category sections (emoji, name, "x/y", mini progress, default buyer avatar). Item row: title, effective qty pill (per-person shows "300 גרם × 11 = 3.3 ק"ג" in sheet), type icon, status pill (חסר / חלקי 2/10 / מכוסה / נקנה ✓ / ארוז ✓ / ממתין לאישור), pledger AvatarStack, quick action (✋ אני / ✓ שלי / ☐ each-done). Tap → **item sheet**: all details, pledges list, Stepper for my qty, "אני מביא/ה" / "אני קונה" / "אני לוקח/ת את זה", done toggles, "💡 למי יש בבית?" (members whose `inventory` fuzzy-matches the title), admin: assign MemberPicker+qty, edit, approve/reject(with reason), delete. **FAB ➕ add item sheet**: title, category chips, type (לקנות / להביא מהבית / כל אחד מביא / משימה), qty+unit (unit chips: יח׳, ק"ג, גרם, חבילות, בקבוקים, שישיות, ליטר), "לאדם" toggle, needed (bring), note, "אני לוקח/ת את זה" checkbox; members see "ההצעה תישלח לאישור מנהל" when approval is on. Overflow menu: "📥 ייבוא רשימה מוואטסאפ" → `#/t/:id/import`, "🛒 מצב קנייה" → `#/t/:id/shop`, "📤 שתף מה חסר" (buildSummaryText 'missing'). Personal tab lives in **Me**? No — put **"🎒 הציוד האישי שלי"** as a collapsible section at the top of the `⭐ שלי` tab (personal_items + template button + add input; private badge "רק את/ה רואה").
5. **Shopping mode** (`shopping.js`): full-screen focused list of `buy` items for a buyer (default me; chips to switch buyer / "לא משובץ"), grouped by category, huge rows, tap toggles bought (strike + check animation + moves to bottom), progress bar, Screen Wake Lock while open, "סיימתי! 🧾 הוסף את הקבלה" → expense sheet prefilled title "קניות — <category names>" → add_expense → confetti. Back button.
6. **Import** (`import.js`): textarea "הדביקו כאן רשימה מוואטסאפ", live preview grouped by detected category (parseListText) with per-row include checkbox, editable category (chips), type toggle (buy/bring/each); "ייבוא X פריטים" → add_items_bulk → lists.
7. **Money** (`money.js`): summary hero (total spent, per head, my balance big: green "מגיע לך ₪X" / orange "עליך להעביר ₪X" / "את/ה מאוזנ/ת ✨"); **"איך מתחשבנים"** settle plan rows (from→to, amount; for my rows: "שילמתי ✓" (add_payment) + recipient phone copy + "פתח וואטסאפ" ; for rows to me: "קיבלתי"), payments list with status (נשלח ⏳ / אושר ✅) + confirm button for recipient/admin; **expenses list** (title, payer avatar, amount, split text "כולם · 11 אנשים" / "5 משתתפים", date; tap → edit sheet); **per-member table** (paid / share / balance); FAB "🧾 הוצאה חדשה" sheet: title, MoneyInput amount, paid by (default me; admins may pick), category chips, split: "כולם (לפי ראשים)" or MemberPicker multi; live per-head preview; "📤 שתף התחשבנות" (buildSummaryText 'settle').
8. **Messages** (`messages.js`): feed (announcements + system + reminders visible to me), unread dot, urgent style (ember border + 🔴), author avatar, time ago; opening the screen marks visible as read (mark_read). Admin composer card: title, body, audience (כולם / choose members via MemberPicker multi), urgent toggle, send → also "שתף גם בוואטסאפ" button. For announcements the author/admins see "נקרא ע״י 6/11" expandable to names. **Polls** section: create poll sheet (question, 2–8 options, multi toggle), poll cards with vote buttons, result bars, voters' avatars, close/delete for creator/admin.
9. **People** (`people.js`): header stats ("11 אנשים · 5 זוגות · 1 יחיד"); member cards (Avatar, name, people names, 👑 badge, "מביא/ה N פריטים", balance chip, phone → wa.me chat, "unclaimed" badge "עוד לא נכנס/ה" for placeholders); **"בחירת מנהלים 👑"** card: each member row with vote toggle (👍 count), admins see "מנה למנהל/ת"/"הסר ניהול" (set_role), highlight top-voted; admin tools: invite link (copy/share/rotate), "הוסף פרופיל לחבר/ה" (create_member), remove member.
10. **Me** (`me.js`): profile edit (single/couple toggle, names, display name, emoji, color, phone); **"מה יש לי בבית"** inventory chips (suggestions: מנגל, נפנף, גזיבו, רמקול, מחצלת, כסאות ים, צידנית, פקל קפה, גזייה, פנס/תאורה, מטקות, כדור, שש בש, קלפים, אוהל גדול, שולחן מתקפל) + custom; **dietary/preferences** text ("צמחוני", "אוהבת יין מבעבע"…) in prefs.diet; **notifications** toggles (prefs.notify.announcements/assignments/money/reminders), quiet hours (prefs.quiet_hours {from,to} or null), reminders (prefs.reminders.pack_evening_before / departure_morning / pay_after_trip), "הפעל התראות למכשיר הזה" button (Phase‑1: requests Notification permission, registers SW push subscription if `vapidPublicKey` is set and saves it; else explains "בקרוב"); theme (אוטומטי/בהיר/כהה); **"חיבור מכשיר נוסף / בן-בת זוג"** (get_device_code → link + copy/share + short explanation); my trips switcher; leave trip; demo-only "🎭 החלף משתמש" (api.demo.actAs) list.

Microcopy tone: friendly Hebrew, gender-inclusive where cheap ("את/ה", "מביא/ה"), short. Empty states with emoji art.

---

## 9. Real trip seed — see `private/seed_data.md` (db agent turns it into `private/seed_trip.sql`). Parser fixture text for logic tests: the "רשימה 1 / רשימה 2 / חלוקה של כל אחד מהבית" message in `private/seed_data.md` §Raw list (copy it into the test file with every real first name replaced by a fictional one — no real names in the repo). `tests/db/test_seed.py` reads the real profile names from `private/seed_names.json` and skips without it.
