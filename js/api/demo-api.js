// In-browser fake backend (SPEC §7.2 "Demo impl").
// Mirrors the SQL contract of SPEC §3–§5: same RPC semantics, permission rules, validations,
// error codes, system notifications, visibility rules and snapshot shape.
//
// Storage: the whole database lives as one JSON document in localStorage['medura:demo:v1'];
// the demo "auth user" id lives in localStorage['medura:demo:uid'].
// Every call loads a fresh copy, runs one RPC against it, and saves only on success —
// so a failed call never leaves partial changes behind (like a SQL transaction).

import { ApiError } from './errors.js?v=71bed20';
import {
  DEMO_VERSION,
  DEFAULT_CATEGORIES,
  DEFAULT_TRIP_INFO,
  DEFAULT_TRIP_SETTINGS,
  PERSONAL_TEMPLATE,
  buildDemoSeed,
  jerusalemYmd,
} from './demo-seed.js?v=71bed20';

export const DEMO_STORAGE_KEY = 'medura:demo:v1';
export const DEMO_UID_KEY = 'medura:demo:uid';

const LIMITS = Object.freeze({ members: 60, items: 600, expenses: 300, personal: 100, bulk: 150 });
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ITEM_TYPES = ['buy', 'bring', 'each', 'task'];
const PAY_METHODS = ['bit', 'paybox', 'cash', 'transfer', 'other'];
const SPLIT_MODES = ['all', 'members'];
const MAX_MONEY = 100000;

const TABLES = [
  'trips', 'members', 'member_secrets', 'member_users', 'categories', 'items', 'pledges',
  'expenses', 'expense_shares', 'payments', 'notifications', 'notification_reads',
  'admin_votes', 'polls', 'poll_votes', 'personal_items', 'push_subscriptions',
  'user_contacts', 'email_codes', 'member_emails', 'rides', 'ride_seats', 'profile_requests', 'accounts',
];

// Snapshot projections (SPEC §5) — the exact key sets.
const K = {
  trip: ['id', 'name', 'emoji', 'location', 'location_url', 'lat', 'lon', 'starts_at', 'ends_at', 'info', 'settings', 'invite_code', 'rev', 'created_at'],
  tripBrief: ['id', 'name', 'emoji', 'location', 'starts_at', 'ends_at'],
  memberBrief: ['id', 'display_name', 'emoji', 'color', 'role'],
  unclaimed: ['id', 'display_name', 'headcount', 'people', 'emoji', 'color'],
  category: ['id', 'name', 'emoji', 'sort', 'default_buyer_id', 'note'],
  item: ['id', 'category_id', 'title', 'note', 'type', 'qty', 'unit', 'per_person', 'needed', 'status', 'done', 'done_at', 'reject_reason', 'created_by', 'approved_by', 'sort', 'created_at', 'updated_at'],
  pledge: ['id', 'item_id', 'member_id', 'qty', 'done', 'assigned_by', 'accepted_at', 'created_at'],
  expense: ['id', 'title', 'amount', 'paid_by', 'category_id', 'note', 'split_mode', 'created_by', 'spent_on', 'created_at', 'currency', 'orig_amount', 'rate'],
  share: ['expense_id', 'member_id', 'weight'],
  payment: ['id', 'from_member', 'to_member', 'amount', 'method', 'note', 'status', 'created_by', 'created_at', 'confirmed_at'],
  notification: ['id', 'kind', 'title', 'body', 'audience', 'author_member', 'urgent', 'link', 'created_at'],
  read: ['notification_id', 'member_id', 'read_at'],
  vote: ['voter_id', 'candidate_id'],
  pollVote: ['poll_id', 'member_id', 'option_id'],
  personal: ['id', 'title', 'done', 'sort', 'created_at'],
  ride: ['id', 'driver_member', 'seats', 'from_text', 'depart_at', 'note', 'kind', 'to_text', 'created_at'],
  rideSeat: ['ride_id', 'member_id', 'seats', 'status', 'requested_by'],
  profileRequest: ['id', 'member_id', 'name', 'person', 'email', 'merging', 'created_at'],
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s.]{2,}$/;

const fail = (code) => {
  throw new ApiError(code);
};
const bad = () => fail('invalid_input');

const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const pick = (row, keys) => {
  const out = {};
  for (const k of keys) out[k] = row[k] === undefined ? null : row[k];
  return out;
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const given = (o, k) => has(o, k) && o[k] !== null; // present and non-null (coalesce semantics)
const cpLen = (s) => [...s].length;
const clip = (s, max) => (cpLen(s) > max ? [...s].slice(0, max - 1).join('') + '…' : s);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const isAdmin = (m) => !!m && (m.role === 'owner' || m.role === 'admin');
const byId = (rows, id) => (typeof id === 'string' ? rows.find((r) => r.id === id) : undefined);
const remove = (rows, pred) => {
  for (let i = rows.length - 1; i >= 0; i--) if (pred(rows[i])) rows.splice(i, 1);
};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byCreated = (a, b) => cmp(a.created_at, b.created_at);
const bySort = (a, b) => (a.sort ?? 0) - (b.sort ?? 0) || byCreated(a, b);
const newest = (a, b) => cmp(b.created_at, a.created_at);
const nextSort = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0) + 1;

function formatAmount(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function randomBytes(n) {
  const arr = new Uint8Array(n);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(arr);
  else for (let i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
  return arr;
}

function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function randomCode() {
  return [...randomBytes(10)].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}

const normCode = (code) => (typeof code === 'string' ? code.trim().toLowerCase() : '');

// Strictly increasing ISO timestamps so created_at ordering is stable within this tab.
let lastMs = 0;
function stamp() {
  let t = Date.now();
  if (t <= lastMs) t = lastMs + 1;
  lastMs = t;
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// Validation (every failure → invalid_input)
// ---------------------------------------------------------------------------

function reqText(v, min, max) {
  if (typeof v !== 'string') bad();
  const t = v.trim();
  const n = cpLen(t);
  if (n < min || n > max) bad();
  return t;
}

function optText(v, max) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') bad();
  const t = v.trim();
  if (cpLen(t) > max) bad();
  return t === '' ? null : t;
}

function toNumber(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) bad();
  return n;
}

function toInt(v, min, max) {
  const n = toNumber(v);
  if (!Number.isInteger(n) || n < min || n > max) bad();
  return n;
}

function toBool(v) {
  if (typeof v !== 'boolean') bad();
  return v;
}

function oneOf(v, allowed) {
  if (!allowed.includes(v)) bad();
  return v;
}

function reqObj(v) {
  if (!isObj(v)) bad();
  return v;
}

function moneyVal(v) {
  const n = round2(toNumber(v));
  if (n <= 0 || n > MAX_MONEY) bad();
  return n;
}

function textList(v, maxItems, maxLen) {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) bad();
  const out = v.map((s) => optText(s, maxLen)).filter((s) => s !== null);
  if (out.length > maxItems) bad();
  return out;
}

function colorVal(v) {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v.trim())) bad();
  return v.trim();
}

function phoneVal(v) {
  const t = optText(v, 20);
  if (t !== null && !/^[0-9+\-\s().]+$/.test(t)) bad();
  return t;
}

function timestampVal(v) {
  if (v === null || v === '') return null;
  if (typeof v !== 'string') bad();
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) bad();
  return d.toISOString();
}

function dateVal(v) {
  if (typeof v !== 'string') bad();
  const s = v.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) bad();
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) bad();
  return s;
}

function urlVal(v) {
  const t = optText(v, 1000);
  if (t !== null && !/^https?:\/\/\S+$/i.test(t)) bad();
  return t;
}

function jsonSize(v, max) {
  if (JSON.stringify(v).length > max) bad();
  return v;
}

function tripFields(p, creating) {
  reqObj(p);
  const out = {};
  if (creating || given(p, 'name')) out.name = reqText(p.name, 1, 60);
  if (given(p, 'emoji')) out.emoji = reqText(p.emoji, 1, 16);
  if (has(p, 'location')) out.location = optText(p.location, 200);
  if (has(p, 'location_url')) out.location_url = urlVal(p.location_url);
  if (has(p, 'lat')) out.lat = p.lat === null ? null : toNumber(p.lat);
  if (has(p, 'lon')) out.lon = p.lon === null ? null : toNumber(p.lon);
  if (out.lat != null && (out.lat < -90 || out.lat > 90)) bad();
  if (out.lon != null && (out.lon < -180 || out.lon > 180)) bad();
  if (has(p, 'starts_at')) out.starts_at = timestampVal(p.starts_at);
  if (has(p, 'ends_at')) out.ends_at = timestampVal(p.ends_at);
  if (given(p, 'info')) out.info = infoVal(p.info);
  if (given(p, 'settings')) out.settings = settingsVal(p.settings);
  return out;
}

function infoVal(v) {
  reqObj(v);
  const out = {};
  if (given(v, 'schedule')) {
    if (!Array.isArray(v.schedule) || v.schedule.length > 60 || !v.schedule.every(isObj)) bad();
    out.schedule = v.schedule;
  }
  if (given(v, 'rules')) {
    if (!Array.isArray(v.rules) || v.rules.length > 60 || !v.rules.every(isObj)) bad();
    out.rules = v.rules;
  }
  if (has(v, 'notes')) {
    if (v.notes !== null && typeof v.notes !== 'string') bad();
    out.notes = v.notes ?? '';
    if (cpLen(out.notes) > 4000) bad();
  }
  if (has(v, 'album_url')) {
    const u = v.album_url === '' ? null : v.album_url;
    if (u !== null && (typeof u !== 'string' || u.length > 500 || !/^https?:\/\/\S+$/.test(u))) bad();
    out.album_url = u;
  }
  for (const key of ['bookings', 'costs', 'rooms']) {
    if (given(v, key)) {
      if (!Array.isArray(v[key]) || v[key].length > 30 || !v[key].every(isObj)) bad();
      out[key] = v[key];
    }
  }
  if (given(v, 'packing')) {
    if (!Array.isArray(v.packing) || v.packing.length > 60
        || !v.packing.every((x) => typeof x === 'string' && cpLen(x) >= 1 && cpLen(x) <= 80)) bad();
    out.packing = v.packing;
  }
  return jsonSize(out, 40000);
}

function settingsVal(v) {
  reqObj(v);
  const out = {};
  if (given(v, 'require_approval')) out.require_approval = toBool(v.require_approval);
  if (given(v, 'type')) {
    if (typeof v.type !== 'string' || !/^[a-z_]{1,20}$/.test(v.type)) bad();
    out.type = v.type;
  }
  if (given(v, 'modules')) {
    if (!isObj(v.modules) || !Object.values(v.modules).every((x) => typeof x === 'boolean')) bad();
    out.modules = { ...v.modules };
  }
  if (given(v, 'arrival')) {
    const a = v.arrival;
    if (!isObj(a)) bad();
    if (given(a, 'modes') && (!Array.isArray(a.modes) || !a.modes.every((m) => ['car', 'taxi', 'meet', 'own'].includes(m)))) bad();
    if (given(a, 'flights') && typeof a.flights !== 'boolean') bad();
    out.arrival = { ...a };
  }
  if (given(v, 'money')) {
    const m = v.money;
    if (!isObj(m)) bad();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (given(m, 'exempt') && (!Array.isArray(m.exempt) || m.exempt.length > 50 || !m.exempt.every((x) => typeof x === 'string' && uuid.test(x)))) bad();
    if (given(m, 'currencies') && (!Array.isArray(m.currencies) || m.currencies.length > 6 || !m.currencies.every((x) => typeof x === 'string' && /^[A-Z]{3}$/.test(x)))) bad();
    out.money = { ...m };
  }
  return jsonSize(out, 4000);
}

function profileFields(p, creating) {
  reqObj(p);
  const out = {};
  if (creating || given(p, 'display_name')) out.display_name = reqText(p.display_name, 1, 40);
  if (given(p, 'headcount')) out.headcount = toInt(p.headcount, 1, 8);
  if (has(p, 'people')) out.people = textList(p.people, 8, 40);
  if (given(p, 'emoji')) out.emoji = reqText(p.emoji, 1, 16);
  if (given(p, 'color')) out.color = colorVal(p.color);
  if (has(p, 'phone')) out.phone = phoneVal(p.phone);
  if (given(p, 'prefs')) out.prefs = jsonSize(reqObj(p.prefs), 8000);
  if (has(p, 'inventory')) out.inventory = textList(p.inventory, 60, 40);
  return out;
}

function applyProfile(member, f) {
  for (const [k, v] of Object.entries(f)) {
    member[k] = k === 'prefs' ? { ...(member.prefs || {}), ...v } : v;
  }
}

// ---------------------------------------------------------------------------
// Database access helpers (operate on ctx = { db, uid, now(), dirty, touched })
// ---------------------------------------------------------------------------

function emptyDb() {
  const db = { version: DEMO_VERSION };
  for (const t of TABLES) db[t] = [];
  return db;
}

function validDb(db) {
  return isObj(db) && db.version === DEMO_VERSION && TABLES.every((t) => Array.isArray(db[t]));
}

function need(rows, id) {
  const row = byId(rows, id);
  if (!row) fail('not_found');
  return row;
}

/** Approved seats taken in a ride (optionally not counting one member). */
function approvedSeats(db, rideId, exceptMember = null) {
  return db.ride_seats
    .filter((s) => s.ride_id === rideId && s.status === 'approved' && s.member_id !== exceptMember)
    .reduce((n, s) => n + s.seats, 0);
}

function membersOf(db, tripId) {
  return db.members.filter((m) => m.trip_id === tripId);
}

function myMember(db, tripId, uid) {
  const link = db.member_users.find((l) => l.user_id === uid && l.trip_id === tripId);
  return link ? byId(db.members, link.member_id) || null : null;
}

function requireMember(ctx, tripId) {
  const me = typeof tripId === 'string' ? myMember(ctx.db, tripId, ctx.uid) : null;
  if (!me) fail('forbidden');
  return me;
}

function requireAdmin(ctx, tripId) {
  const me = requireMember(ctx, tripId);
  if (!isAdmin(me)) fail('forbidden');
  return me;
}

function tripByCode(db, code) {
  const c = normCode(code);
  return c ? db.trips.find((t) => t.invite_code === c) : undefined;
}

function uniqueCode(db) {
  for (;;) {
    const c = randomCode();
    if (!db.trips.some((t) => t.invite_code === c) && !db.member_secrets.some((s) => s.device_code === c)) return c;
  }
}

function memberRef(db, tripId, id) {
  const m = byId(db.members, id);
  if (!m || m.trip_id !== tripId) bad();
  return m.id;
}

function categoryRef(db, tripId, id) {
  if (id === null || id === undefined || id === '') return null;
  const c = byId(db.categories, id);
  if (!c || c.trip_id !== tripId) bad();
  return c.id;
}

function bump(ctx, tripId) {
  const trip = byId(ctx.db.trips, tripId);
  if (trip) {
    trip.rev = (Number(trip.rev) || 0) + 1;
    trip.updated_at = ctx.now();
  }
  ctx.dirty = true;
  ctx.touched.add(tripId);
}

function fmtShekel(amount) {
  const n = Number(amount) || 0;
  return `₪${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function notify(ctx, tripId, { title, body = null, audience = null, link = null }) {
  ctx.db.notifications.push({
    id: newId(),
    trip_id: tripId,
    kind: 'system',
    title: clip(title, 80),
    body: body ? clip(body, 2000) : null,
    audience,
    author_member: null,
    urgent: false,
    link,
    created_at: ctx.now(),
  });
}

function canSeeNotification(n, me) {
  return (
    n.audience == null ||
    n.audience.includes(me.id) ||
    n.author_member === me.id ||
    (n.kind === 'announcement' && isAdmin(me))
  );
}

function canSeeItem(item, me) {
  return item.status !== 'rejected' || isAdmin(me) || item.created_by === me.id;
}

const itemLink = (tripId, itemId) => `#/t/${tripId}/lists?item=${itemId}`;

function newMemberRow(ctx, tripId, prof, role, claimed) {
  const now = ctx.now();
  return {
    id: newId(),
    trip_id: tripId,
    display_name: prof.display_name,
    headcount: prof.headcount ?? 1,
    people: prof.people ?? [],
    emoji: prof.emoji ?? '🙂',
    color: prof.color ?? '#2F6B4F',
    role,
    phone: prof.phone ?? null,
    prefs: prof.prefs ?? {},
    inventory: prof.inventory ?? [],
    claimed_at: claimed ? now : null,
    created_at: now,
  };
}

function linkUser(ctx, tripId, memberId, person = null) {
  ctx.db.member_users.push({ user_id: ctx.uid, trip_id: tripId, member_id: memberId, person, created_at: ctx.now() });
}

/** The people of a profile already in (linked with a person). */
function joinedPeople(db, memberId) {
  return [...new Set(db.member_users.filter((l) => l.member_id === memberId && l.person).map((l) => l.person))];
}

/** After a user link was removed: a member with no linked users becomes claimable again. */
function releaseIfOrphan(db, memberId) {
  const m = byId(db.members, memberId);
  if (m && !db.member_users.some((l) => l.member_id === memberId)) m.claimed_at = null;
}

function itemFields(db, tripId, p, creating) {
  reqObj(p);
  const out = {};
  if (creating || given(p, 'title')) out.title = reqText(p.title, 1, 120);
  if (has(p, 'note')) out.note = optText(p.note, 500);
  if (creating) out.type = given(p, 'type') ? oneOf(p.type, ITEM_TYPES) : 'buy';
  else if (given(p, 'type')) out.type = oneOf(p.type, ITEM_TYPES);
  if (has(p, 'qty')) {
    if (p.qty === null || p.qty === '') out.qty = null;
    else {
      out.qty = toNumber(p.qty);
      if (out.qty <= 0 || out.qty > 1000000) bad();
    }
  }
  if (has(p, 'unit')) out.unit = optText(p.unit, 20);
  if (given(p, 'per_person')) out.per_person = toBool(p.per_person);
  if (given(p, 'needed')) out.needed = toInt(p.needed, 1, 200);
  if (has(p, 'category_id')) out.category_id = categoryRef(db, tripId, p.category_id);
  if (!creating && given(p, 'sort')) out.sort = toInt(p.sort, -1000000, 1000000);
  return out;
}

function pledgeQtyVal(p) {
  return given(p, 'pledge_qty') ? toInt(p.pledge_qty, -1000000, 200) : 0;
}

function insertItem(ctx, trip, me, f, pledgeQty, sort) {
  const auto = trip.settings?.require_approval === false || isAdmin(me);
  const now = ctx.now();
  const item = {
    id: newId(),
    trip_id: trip.id,
    category_id: f.category_id ?? null,
    title: f.title,
    note: f.note ?? null,
    type: f.type,
    qty: f.qty ?? null,
    unit: f.unit ?? null,
    per_person: f.per_person ?? false,
    needed: f.needed ?? 1,
    status: auto ? 'active' : 'proposed',
    done: false,
    done_at: null,
    reject_reason: null,
    created_by: me.id,
    approved_by: auto && isAdmin(me) ? me.id : null,
    sort,
    created_at: now,
    updated_at: now,
  };
  ctx.db.items.push(item);
  if (pledgeQty > 0 && item.type !== 'each') {
    ctx.db.pledges.push({
      id: newId(), trip_id: trip.id, item_id: item.id, member_id: me.id,
      qty: pledgeQty, done: false, assigned_by: null, created_at: ctx.now(),
    });
  }
  return item;
}

function expenseFields(db, tripId, p, creating) {
  reqObj(p);
  const out = {};
  if (creating || given(p, 'title')) out.title = reqText(p.title, 1, 80);
  const cur = typeof p.currency === 'string' ? p.currency.trim().toUpperCase() : '';
  if (cur && cur !== 'ILS') {
    // a foreign sum: converted to ₪ here (amount = orig × rate), like the server
    if (!/^[A-Z]{3}$/.test(cur)) bad();
    const orig = Math.round(toNumber(p.orig_amount) * 100) / 100;
    const rate = Math.round(toNumber(p.rate) * 1e6) / 1e6;
    if (!(orig > 0 && orig <= 10000000 && rate > 0 && rate <= 100000)) bad();
    out.currency = cur;
    out.orig_amount = orig;
    out.rate = rate;
    out.amount = moneyVal(Math.round(orig * rate * 100) / 100);
  } else {
    if (has(p, 'currency') || (!creating && given(p, 'amount'))) {
      out.currency = null;
      out.orig_amount = null;
      out.rate = null;
    }
    if (creating || given(p, 'amount')) out.amount = moneyVal(p.amount);
  }
  if (given(p, 'paid_by')) out.paid_by = memberRef(db, tripId, p.paid_by);
  if (has(p, 'category_id')) out.category_id = categoryRef(db, tripId, p.category_id);
  if (has(p, 'note')) out.note = optText(p.note, 500);
  if (given(p, 'spent_on')) out.spent_on = dateVal(p.spent_on);
  if (given(p, 'split_mode')) out.split_mode = oneOf(p.split_mode, SPLIT_MODES);
  if (given(p, 'members')) out.members = sharesVal(db, tripId, p.members);
  return out;
}

function sharesVal(db, tripId, list) {
  if (!Array.isArray(list)) bad();
  const seen = new Set();
  return list.map((s) => {
    reqObj(s);
    const memberId = memberRef(db, tripId, s.member_id);
    if (seen.has(memberId)) bad();
    seen.add(memberId);
    let weight;
    if (given(s, 'weight')) {
      weight = toNumber(s.weight);
      if (weight <= 0 || weight > 1000) bad();
    } else {
      weight = byId(db.members, memberId).headcount;
    }
    return { member_id: memberId, weight };
  });
}

function replaceShares(ctx, expense, shares) {
  remove(ctx.db.expense_shares, (s) => s.expense_id === expense.id);
  for (const s of shares) {
    ctx.db.expense_shares.push({ expense_id: expense.id, trip_id: expense.trip_id, member_id: s.member_id, weight: s.weight });
  }
}

// ---------------------------------------------------------------------------
// The RPCs (SPEC §4). Each takes ctx + the RPC params in order.
// ---------------------------------------------------------------------------

const RPC = {
  my_trips(ctx) {
    const { db } = ctx;
    const rows = [];
    for (const l of db.member_users) {
      if (l.user_id !== ctx.uid) continue;
      const trip = byId(db.trips, l.trip_id);
      const member = byId(db.members, l.member_id);
      if (trip && member) rows.push({ trip: pick(trip, K.tripBrief), member: pick(member, K.memberBrief) });
    }
    rows.sort((a, b) => {
      const x = a.trip.starts_at;
      const y = b.trip.starts_at;
      if (x === y) return cmp(a.trip.name, b.trip.name);
      if (x == null) return 1;
      if (y == null) return -1;
      return cmp(x, y);
    });
    return rows;
  },

  create_trip(ctx, pTrip, pProfile) {
    const { db } = ctx;
    const { categories: cats, ...tripOnly } = pTrip && typeof pTrip === 'object' ? pTrip : {};
    const t = tripFields(pTrip && typeof pTrip === 'object' ? tripOnly : pTrip, true);
    const prof = profileFields(pProfile, true);
    // a trip type brings its own categories; otherwise the camping defaults
    let startCats = DEFAULT_CATEGORIES;
    if (Array.isArray(cats) && cats.length) {
      if (cats.length > 20 || !cats.every((c) => isObj(c) && typeof c.name === 'string' && cpLen(c.name) >= 1
          && cpLen(c.name) <= 40 && (c.emoji == null || (typeof c.emoji === 'string' && cpLen(c.emoji) <= 16)))) bad();
      const seen = new Set();
      startCats = cats.filter((c) => !seen.has(c.name) && seen.add(c.name)).map((c) => ({ name: c.name, emoji: c.emoji || null }));
    }
    const now = ctx.now();
    const trip = {
      id: newId(),
      name: t.name,
      emoji: t.emoji ?? '⛺',
      location: t.location ?? null,
      location_url: t.location_url ?? null,
      lat: t.lat ?? null,
      lon: t.lon ?? null,
      starts_at: t.starts_at ?? null,
      ends_at: t.ends_at ?? null,
      info: { ...clone(DEFAULT_TRIP_INFO), ...(t.info || {}) },
      settings: { ...DEFAULT_TRIP_SETTINGS, ...(t.settings || {}) },
      invite_code: uniqueCode(db),
      rev: 0,
      created_by: ctx.uid,
      created_at: now,
      updated_at: now,
    };
    db.trips.push(trip);
    const member = newMemberRow(ctx, trip.id, prof, 'owner', true);
    db.members.push(member);
    linkUser(ctx, trip.id, member.id, (member.people || [])[0] || null);
    startCats.forEach((c, i) => {
      db.categories.push({
        id: newId(), trip_id: trip.id, name: c.name, emoji: c.emoji, sort: i + 1,
        default_buyer_id: null, note: null, created_at: ctx.now(),
      });
    });
    bump(ctx, trip.id);
    return { trip_id: trip.id, member_id: member.id };
  },

  preview_invite(ctx, code) {
    const { db } = ctx;
    const trip = tripByCode(db, code);
    if (!trip) fail('invalid_code');
    const members = membersOf(db, trip.id).sort(byCreated);
    const mine = myMember(db, trip.id, ctx.uid);
    return {
      trip: pick(trip, K.tripBrief),
      member_count: members.length,
      headcount: members.reduce((s, m) => s + m.headcount, 0),
      unclaimed: members.filter((m) => !m.claimed_at).map((m) => pick(m, K.unclaimed)),
      claimed: members.filter((m) => m.claimed_at).map((m) => ({ ...pick(m, K.unclaimed), joined: joinedPeople(db, m.id) })),
      my_request: (() => {
        const r = db.profile_requests.filter((x) => x.user_id === ctx.uid && x.trip_id === trip.id).sort(newest)[0];
        return r ? { status: r.status, member_id: r.member_id } : null;
      })(),
      my_member_id: mine ? mine.id : null,
    };
  },

  join_trip(ctx, code, claimMemberId, profile, personArg = null) {
    const { db } = ctx;
    const trip = tripByCode(db, code);
    if (!trip) fail('invalid_code');
    const existing = myMember(db, trip.id, ctx.uid);
    if (existing) return { trip_id: trip.id, member_id: existing.id };

    const members = membersOf(db, trip.id);
    const hadAdmin = members.some(isAdmin);
    let member;
    let person = typeof personArg === 'string' && personArg.trim() ? personArg.trim() : null;
    if (claimMemberId != null) {
      member = byId(db.members, claimMemberId);
      if (!member || member.trip_id !== trip.id) fail('not_found');
      const people = member.people || [];
      if (person && !people.includes(person)) bad();
      if (!person && people.length === 1) [person] = people;
      if (member.claimed_at) {
        // one of its other people steps in — their slot is free
        if (!person || people.length < 2 || joinedPeople(db, member.id).includes(person)) fail('already_claimed');
      } else {
        if (profile != null) applyProfile(member, profileFields(profile, false));
        member.claimed_at = ctx.now();
      }
    } else {
      if (profile == null) bad();
      const prof = profileFields(profile, true);
      if (members.length >= LIMITS.members) fail('limit_reached');
      member = newMemberRow(ctx, trip.id, prof, 'member', true);
      db.members.push(member);
      person = person || (member.people || [])[0] || null;
    }
    if (!hadAdmin) member.role = 'owner';
    linkUser(ctx, trip.id, member.id, person);

    const admins = membersOf(db, trip.id).filter((m) => isAdmin(m) && m.id !== member.id).map((m) => m.id);
    if (admins.length) {
      notify(ctx, trip.id, {
        title: `${claimMemberId != null && person ? person : member.display_name} הצטרפ/ה לטיול 🎉`,
        audience: admins,
        link: `#/t/${trip.id}/people`,
      });
    }
    bump(ctx, trip.id);
    return { trip_id: trip.id, member_id: member.id };
  },

  link_device(ctx, deviceCode) {
    const { db } = ctx;
    const c = normCode(deviceCode);
    const secret = c ? db.member_secrets.find((s) => s.device_code === c) : null;
    const member = secret ? byId(db.members, secret.member_id) : null;
    if (!member) fail('invalid_code');
    const prev = db.member_users.find((l) => l.user_id === ctx.uid && l.trip_id === member.trip_id);
    if (!(prev && prev.member_id === member.id)) {
      if (prev) {
        remove(db.member_users, (l) => l === prev);
        releaseIfOrphan(db, prev.member_id);
      }
      linkUser(ctx, member.trip_id, member.id);
      if (!member.claimed_at) member.claimed_at = ctx.now();
    }
    bump(ctx, member.trip_id);
    return { trip_id: member.trip_id, member_id: member.id };
  },

  get_device_code(ctx, memberId) {
    const { db } = ctx;
    const member = need(db.members, memberId);
    const me = myMember(db, member.trip_id, ctx.uid);
    if (!me || me.id !== member.id) fail('forbidden');
    let secret = db.member_secrets.find((s) => s.member_id === member.id);
    if (!secret) {
      secret = { member_id: member.id, trip_id: member.trip_id, device_code: uniqueCode(db) };
      db.member_secrets.push(secret);
      ctx.dirty = true;
    }
    return secret.device_code;
  },

  get_trip_snapshot(ctx, tripId) {
    const { db, uid } = ctx;
    if (!myMember(db, tripId, uid) && !byId(db.trips, tripId)) fail('not_found'); // deleted trip
    const me = requireMember(ctx, tripId);
    const admin = isAdmin(me);
    const trip = byId(db.trips, tripId);
    const inTrip = (r) => r.trip_id === tripId;

    const itemRows = db.items.filter((i) => inTrip(i) && canSeeItem(i, me)).sort(bySort);
    const visibleItems = new Set(itemRows.map((i) => i.id));
    const authored = new Set(db.notifications.filter((n) => inTrip(n) && n.author_member === me.id).map((n) => n.id));

    return {
      trip: { ...pick(trip, K.trip), info: { ...clone(DEFAULT_TRIP_INFO), ...(trip.info || {}) }, settings: { ...DEFAULT_TRIP_SETTINGS, ...(trip.settings || {}) } },
      me: { member_id: me.id, role: me.role, user_id: uid,
        person: db.member_users.find((l) => l.user_id === uid && l.trip_id === tripId)?.person ?? null },
      members: membersOf(db, tripId).sort(byCreated).map((m) => ({
        id: m.id,
        display_name: m.display_name,
        headcount: m.headcount,
        people: m.people || [],
        emoji: m.emoji,
        color: m.color,
        role: m.role,
        phone: m.phone ?? null,
        prefs: m.prefs || {},
        inventory: m.inventory || [],
        claimed: Boolean(m.claimed_at),
        joined: joinedPeople(db, m.id),
        created_at: m.created_at,
      })),
      categories: db.categories.filter(inTrip).sort(bySort).map((c) => pick(c, K.category)),
      items: itemRows.map((i) => pick(i, K.item)),
      pledges: db.pledges.filter((p) => inTrip(p) && visibleItems.has(p.item_id)).sort(byCreated).map((p) => pick(p, K.pledge)),
      expenses: db.expenses
        .filter(inTrip)
        .sort((a, b) => cmp(b.spent_on, a.spent_on) || newest(a, b))
        .map((e) => pick(e, K.expense)),
      expense_shares: db.expense_shares.filter(inTrip).map((s) => pick(s, K.share)),
      payments: db.payments.filter(inTrip).sort(newest).map((p) => pick(p, K.payment)),
      notifications: db.notifications
        .filter((n) => inTrip(n) && canSeeNotification(n, me))
        .sort(newest)
        .slice(0, 200)
        .map((n) => pick(n, K.notification)),
      reads: db.notification_reads
        .filter((r) => inTrip(r) && (admin || r.member_id === me.id || authored.has(r.notification_id)))
        .map((r) => pick(r, K.read)),
      admin_votes: db.admin_votes.filter(inTrip).sort(byCreated).map((v) => pick(v, K.vote)),
      polls: db.polls.filter(inTrip).sort(newest).map((p) => ({
        id: p.id,
        question: p.question,
        options: p.options.map((o) => ({ id: o.id, label: o.label })),
        multi: p.multi,
        closed: p.closed,
        created_by: p.created_by ?? null,
        created_at: p.created_at,
      })),
      poll_votes: db.poll_votes.filter(inTrip).map((v) => pick(v, K.pollVote)),
      personal_items: db.personal_items
        .filter((p) => inTrip(p) && p.member_id === me.id)
        .sort(bySort)
        .map((p) => pick(p, K.personal)),
      rides: db.rides
        .filter(inTrip)
        .sort((a, b) => cmp(a.depart_at ?? '￿', b.depart_at ?? '￿') || byCreated(a, b))
        .map((r) => pick(r, K.ride)),
      ride_seats: db.ride_seats.filter(inTrip).sort(byCreated).map((s) => pick(s, K.rideSeat)),
      profile_requests: db.profile_requests
        .filter((r) => inTrip(r) && r.status === 'pending' && (r.member_id === me.id || admin))
        .sort(byCreated)
        .map((r) => pick({ ...r, merging: Boolean(r.from_member) }, K.profileRequest)),
    };
  },

  update_trip(ctx, tripId, patch) {
    requireAdmin(ctx, tripId);
    const trip = byId(ctx.db.trips, tripId);
    const f = tripFields(patch, false);
    for (const [k, v] of Object.entries(f)) {
      if (k === 'info') trip.info = { ...clone(DEFAULT_TRIP_INFO), ...(trip.info || {}), ...v };
      else if (k === 'settings') trip.settings = { ...DEFAULT_TRIP_SETTINGS, ...(trip.settings || {}), ...v };
      else trip[k] = v;
    }
    bump(ctx, tripId);
    return null;
  },

  rotate_invite(ctx, tripId) {
    requireAdmin(ctx, tripId);
    const trip = byId(ctx.db.trips, tripId);
    trip.invite_code = uniqueCode(ctx.db);
    bump(ctx, tripId);
    return trip.invite_code;
  },

  delete_trip(ctx, tripId) {
    const { db } = ctx;
    requireAdmin(ctx, tripId);
    bump(ctx, tripId); // marks the DB dirty + tells open subscribers to refetch (→ not_found)
    const memberIds = new Set(membersOf(db, tripId).map((m) => m.id));
    remove(db.member_secrets, (s) => memberIds.has(s.member_id));
    for (const t of TABLES) if (t !== 'member_secrets') remove(db[t], (r) => (t === 'trips' ? r.id : r.trip_id) === tripId);
    return null;
  },

  // ---- e-mail (demo: the "sent" code comes back so the UI can show it) ----

  my_email(ctx) {
    const row = ctx.db.user_contacts.find((c) => c.user_id === ctx.uid);
    return { email: row ? row.email : null, verified: Boolean(row) };
  },

  request_email_code(ctx, email) {
    const { db } = ctx;
    const e = String(email ?? '').trim().toLowerCase();
    if (e.length > 254 || !EMAIL_RE.test(e)) bad();
    const prev = db.email_codes.find((c) => c.user_id === ctx.uid);
    const hourAgo = Date.parse(ctx.now()) - 3600000;
    const recent = (prev?.sent_at || []).filter((s) => Date.parse(s) > hourAgo);
    if (recent.length >= 5) fail('rate_limited');
    const code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
    remove(db.email_codes, (c) => c.user_id === ctx.uid);
    db.email_codes.push({
      user_id: ctx.uid, email: e, code, attempts: 0, sent_at: [...recent, ctx.now()],
      expires_at: new Date(Date.parse(ctx.now()) + 15 * 60000).toISOString(),
    });
    ctx.dirty = true;
    return { demo_code: code };
  },

  verify_email_code(ctx, code) {
    const { db } = ctx;
    const row = db.email_codes.find((c) => c.user_id === ctx.uid);
    if (!row || Date.parse(row.expires_at) < Date.parse(ctx.now()) || row.attempts >= 5) fail('code_expired');
    ctx.dirty = true;
    if (String(code ?? '').replace(/\D/g, '') !== row.code) {
      row.attempts += 1;
      return { email: null, verified: false };
    }
    remove(db.user_contacts, (c) => c.user_id === ctx.uid);
    db.user_contacts.push({ user_id: ctx.uid, email: row.email, verified_at: ctx.now() });
    remove(db.email_codes, (c) => c === row);
    return { email: row.email, verified: true };
  },

  get_member_emails(ctx, memberId) {
    const member = need(ctx.db.members, memberId);
    const me = requireMember(ctx, member.trip_id);
    if (me.id !== member.id && !isAdmin(me)) fail('forbidden');
    return ctx.db.member_emails.filter((e) => e.member_id === member.id).map((e) => e.email);
  },

  set_my_person(ctx, tripId, person) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    const p = typeof person === 'string' ? person.trim() : '';
    if (!p || !(me.people || []).includes(p)) bad();
    const myEmail = db.user_contacts.find((c) => c.user_id === ctx.uid)?.email;
    const taken = db.member_users.some((l) => l.member_id === me.id && l.person === p && l.user_id !== ctx.uid
      && !(myEmail && db.user_contacts.some((c) => c.user_id === l.user_id && c.email === myEmail)));
    if (taken) fail('already_claimed');
    db.member_users.filter((l) => l.user_id === ctx.uid && l.trip_id === tripId).forEach((l) => { l.person = p; });
    bump(ctx, tripId);
    return null;
  },

  my_account(ctx) {
    const email = ctx.db.user_contacts.find((c) => c.user_id === ctx.uid)?.email || null;
    if (!email) return { email: null, verified: false };
    const a = ctx.db.accounts.find((x) => x.email === email) || {};
    return { email, verified: true, name: a.name ?? null, phone: a.phone ?? null, prefs: { ...(a.prefs || {}) } };
  },

  save_account(ctx, patch) {
    const { db } = ctx;
    const email = db.user_contacts.find((c) => c.user_id === ctx.uid)?.email;
    if (!email) fail('email_not_verified');
    reqObj(patch);
    let a = db.accounts.find((x) => x.email === email);
    if (!a) {
      a = { email, name: null, phone: null, prefs: {}, created_at: ctx.now() };
      db.accounts.push(a);
    }
    if (has(patch, 'name')) a.name = optText(patch.name, 40);
    if (has(patch, 'phone')) a.phone = optText(patch.phone, 20);
    if (has(patch, 'prefs')) {
      if (!isObj(patch.prefs)) bad();
      a.prefs = jsonSize({ ...a.prefs, ...patch.prefs }, 4000);
    }
    ctx.dirty = true;
    return RPC.my_account(ctx);
  },

  member_details(ctx, memberId) {
    const { db } = ctx;
    const member = need(db.members, memberId);
    const me = requireMember(ctx, member.trip_id);
    if (me.id !== member.id && !isAdmin(me)) fail('forbidden');
    const users = new Set(db.member_users.filter((l) => l.member_id === member.id).map((l) => l.user_id));
    return {
      verified: [...new Set(db.user_contacts.filter((c) => users.has(c.user_id)).map((c) => c.email))],
      emails: db.member_emails.filter((e) => e.member_id === member.id).map((e) => e.email),
      devices: users.size,
      push: db.push_subscriptions.filter((s) => s.member_id === member.id).length,
    };
  },

  set_member_emails(ctx, memberId, emails) {
    const { db } = ctx;
    const member = need(db.members, memberId);
    const me = requireMember(ctx, member.trip_id);
    if (me.id !== member.id && !isAdmin(me)) fail('forbidden');
    if (emails != null && !Array.isArray(emails)) bad();
    const list = [...new Set((emails || []).map((e) => String(e ?? '').trim().toLowerCase()).filter(Boolean))];
    if (list.length > 6 || list.some((e) => e.length > 254 || !EMAIL_RE.test(e))) bad();
    remove(db.member_emails, (e) => e.member_id === member.id && !list.includes(e.email));
    for (const email of list) {
      if (!db.member_emails.some((e) => e.member_id === member.id && e.email === email)) {
        db.member_emails.push({ member_id: member.id, trip_id: member.trip_id, email, token: newId(), created_at: ctx.now() });
      }
    }
    bump(ctx, member.trip_id);
    return null;
  },

  // ---- rides ----

  upsert_ride(ctx, tripId, ride) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    reqObj(ride);
    let kind = ride.kind == null ? null : ride.kind;
    if (kind !== null && !['car', 'taxi', 'meet'].includes(kind)) bad();
    if (given(ride, 'id')) kind = kind ?? db.rides.find((r) => r.id === ride.id)?.kind ?? null;
    let seats;
    if (has(ride, 'seats')) {
      seats = Number(ride.seats);
      if (!Number.isInteger(seats) || seats < 1 || seats > ((kind || 'car') === 'meet' ? 40 : 8)) bad();
    }
    let row;
    if (given(ride, 'id')) {
      row = db.rides.find((r) => r.id === ride.id && r.trip_id === tripId);
      if (!row) fail('not_found');
      if (row.driver_member !== me.id && !isAdmin(me)) fail('forbidden');
      const taken = approvedSeats(db, row.id);
      if (seats != null && seats < taken) fail('ride_full');
      if (seats != null) row.seats = seats;
      if (has(ride, 'from_text')) row.from_text = optText(ride.from_text, 80);
      if (has(ride, 'depart_at')) row.depart_at = ride.depart_at == null || ride.depart_at === '' ? null : timestampVal(ride.depart_at);
      if (has(ride, 'note')) row.note = optText(ride.note, 200);
      if (kind) row.kind = kind;
      if (has(ride, 'to_text')) row.to_text = optText(ride.to_text, 80);
    } else {
      if (db.rides.some((r) => r.trip_id === tripId && r.driver_member === me.id)) fail('not_allowed_state');
      remove(db.ride_seats, (s) => s.trip_id === tripId && s.member_id === me.id);
      row = {
        id: newId(), trip_id: tripId, driver_member: me.id, seats: seats ?? 3,
        from_text: optText(ride.from_text, 80),
        depart_at: ride.depart_at == null || ride.depart_at === '' ? null : timestampVal(ride.depart_at),
        note: optText(ride.note, 200), kind: kind || 'car', to_text: optText(ride.to_text, 80), created_at: ctx.now(),
      };
      db.rides.push(row);
    }
    bump(ctx, tripId);
    return row.id;
  },

  delete_ride(ctx, rideId) {
    const { db } = ctx;
    const ride = need(db.rides, rideId);
    const me = requireMember(ctx, ride.trip_id);
    if (ride.driver_member !== me.id && !isAdmin(me)) fail('forbidden');
    const passengers = db.ride_seats.filter((s) => s.ride_id === ride.id).map((s) => s.member_id);
    remove(db.ride_seats, (s) => s.ride_id === ride.id);
    remove(db.rides, (r) => r === ride);
    if (passengers.length) {
      notify(ctx, ride.trip_id, {
        title: `ההסעה עם ${byId(db.members, ride.driver_member)?.display_name ?? ''} בוטלה 🚗`,
        body: 'צריך למצוא הסעה אחרת — אפשר להצטרף לרכב אחר במסך הטיול.',
        audience: passengers, link: `#/t/${ride.trip_id}/trip`,
      });
    }
    bump(ctx, ride.trip_id);
    return null;
  },

  take_seat(ctx, rideId, seats = 1) {
    const { db } = ctx;
    const ride = need(db.rides, rideId);
    const me = requireMember(ctx, ride.trip_id);
    const n = Number(seats ?? 1);
    if (!Number.isInteger(n) || n < 1 || n > 8) bad();
    if (db.rides.some((r) => r.trip_id === ride.trip_id && r.driver_member === me.id)) fail('not_allowed_state');
    if (db.ride_seats.some((s) => s.trip_id === ride.trip_id && s.member_id === me.id && s.status === 'approved' && s.ride_id !== ride.id)) {
      fail('not_allowed_state');
    }
    if (approvedSeats(db, ride.id, me.id) + n > ride.seats) fail('ride_full');
    remove(db.ride_seats, (s) => s.trip_id === ride.trip_id && s.member_id === me.id && s.ride_id !== ride.id);
    let seat = db.ride_seats.find((s) => s.ride_id === ride.id && s.member_id === me.id);
    if (seat) seat.seats = n;
    else {
      seat = { ride_id: ride.id, trip_id: ride.trip_id, member_id: me.id, seats: n, status: 'pending', requested_by: 'passenger', created_at: ctx.now() };
      db.ride_seats.push(seat);
    }
    if (ride.kind === 'meet') {
      // a meeting point needs no approval
      seat.status = 'approved';
      notify(ctx, ride.trip_id, {
        title: `${me.display_name} מצטרף/ת לנקודת המפגש 🚆`, audience: [ride.driver_member], link: `#/t/${ride.trip_id}/rides`,
      });
    } else if (seat.status === 'pending') {
      notify(ctx, ride.trip_id, {
        title: `${me.display_name} מבקש/ת להצטרף לרכב שלך 🚗`,
        body: `${n > 1 ? `${n} מקומות · ` : ''}אפשר לאשר או לדחות במסך הבית`,
        audience: [ride.driver_member], link: `#/t/${ride.trip_id}`,
      });
    }
    bump(ctx, ride.trip_id);
    return null;
  },

  invite_to_ride(ctx, rideId, memberId, seats = null) {
    const { db } = ctx;
    const ride = need(db.rides, rideId);
    const me = requireMember(ctx, ride.trip_id);
    if (ride.driver_member !== me.id && !isAdmin(me)) fail('forbidden');
    const target = byId(db.members, memberId);
    if (!target || target.trip_id !== ride.trip_id || target.id === ride.driver_member) bad();
    if (db.rides.some((r) => r.trip_id === ride.trip_id && r.driver_member === target.id)
        || db.ride_seats.some((s) => s.trip_id === ride.trip_id && s.member_id === target.id && s.status === 'approved')) {
      fail('not_allowed_state');
    }
    const n = Number(seats ?? Math.max(1, Number(target.headcount) || 1));
    if (!Number.isInteger(n) || n < 1 || n > 8) bad();
    if (approvedSeats(db, ride.id) + n > ride.seats) fail('ride_full');
    remove(db.ride_seats, (s) => s.trip_id === ride.trip_id && s.member_id === target.id && s.status === 'pending');
    db.ride_seats.push({ ride_id: ride.id, trip_id: ride.trip_id, member_id: target.id, seats: n, status: 'pending', requested_by: 'driver', created_at: ctx.now() });
    const driver = byId(db.members, ride.driver_member);
    notify(ctx, ride.trip_id, {
      title: `${driver?.display_name ?? ''} מזמין/ה אותך לרכב 🚗`,
      body: [ride.from_text && `יוצאים מ${ride.from_text}`, 'אפשר לאשר במסך הבית'].filter(Boolean).join(' · '),
      audience: [target.id], link: `#/t/${ride.trip_id}`,
    });
    bump(ctx, ride.trip_id);
    return null;
  },

  respond_seat(ctx, rideId, memberId, approve) {
    const { db } = ctx;
    const ride = need(db.rides, rideId);
    const seat = db.ride_seats.find((s) => s.ride_id === ride.id && s.member_id === memberId);
    if (!seat) fail('not_found');
    if (seat.status !== 'pending') fail('not_allowed_state');
    const me = requireMember(ctx, ride.trip_id);
    if ((seat.requested_by === 'passenger' && me.id !== ride.driver_member && !isAdmin(me))
        || (seat.requested_by === 'driver' && me.id !== memberId)) fail('forbidden');
    const driver = byId(db.members, ride.driver_member)?.display_name ?? '';
    const pass = byId(db.members, memberId)?.display_name ?? '';
    const link = `#/t/${ride.trip_id}/trip`;
    if (toBool(approve)) {
      if (approvedSeats(db, ride.id) + seat.seats > ride.seats) fail('ride_full');
      remove(db.ride_seats, (s) => s.trip_id === ride.trip_id && s.member_id === memberId && s.ride_id !== ride.id);
      seat.status = 'approved';
      if (seat.requested_by === 'passenger') notify(ctx, ride.trip_id, { title: `${driver} אישר/ה — את/ה ברכב! 🚗`, audience: [memberId], link });
      else notify(ctx, ride.trip_id, { title: `${pass} מצטרפ/ת לרכב שלך ✅`, audience: [ride.driver_member], link });
    } else {
      remove(db.ride_seats, (s) => s === seat);
      if (seat.requested_by === 'passenger') {
        notify(ctx, ride.trip_id, { title: `${driver} לא יכול/ה לקחת אותך הפעם`, body: 'אפשר לבקש מקום ברכב אחר במסך הטיול 🙏', audience: [memberId], link });
      } else notify(ctx, ride.trip_id, { title: `${pass} לא מצטרפ/ת לרכב שלך`, audience: [ride.driver_member], link });
    }
    bump(ctx, ride.trip_id);
    return null;
  },

  leave_seat(ctx, tripId) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    const seat = db.ride_seats.find((s) => s.trip_id === tripId && s.member_id === me.id);
    if (!seat) return null;
    const ride = byId(db.rides, seat.ride_id);
    remove(db.ride_seats, (s) => s === seat);
    if (ride && seat.status === 'approved') {
      notify(ctx, tripId, { title: `${me.display_name} כבר לא נוסע/ת איתך`, audience: [ride.driver_member], link: `#/t/${tripId}/trip` });
    }
    bump(ctx, tripId);
    return null;
  },

  link_by_email(ctx) {
    const { db } = ctx;
    const mine = db.user_contacts.find((c) => c.user_id === ctx.uid);
    if (!mine) fail('forbidden');
    const email = mine.email;
    const byOtherDevice = new Set(db.member_users
      .filter((l) => db.user_contacts.some((c) => c.user_id === l.user_id && c.email === email))
      .map((l) => l.member_id));
    const listed = new Set(db.member_emails.filter((e) => e.email === email).map((e) => e.member_id));
    const out = [];
    for (const m of db.members) {
      if (!byOtherDevice.has(m.id) && !listed.has(m.id)) continue;
      if (db.member_users.some((l) => l.user_id === ctx.uid && l.trip_id === m.trip_id)) continue;
      if (out.some((o) => o.trip_id === m.trip_id)) continue;
      const same = db.member_users.find((l) => l.member_id === m.id && l.person
        && db.user_contacts.some((c) => c.user_id === l.user_id && c.email === email));
      db.member_users.push({ user_id: ctx.uid, trip_id: m.trip_id, member_id: m.id, person: same?.person ?? null, created_at: ctx.now() });
      if (!m.claimed_at) m.claimed_at = ctx.now();
      if (!membersOf(db, m.trip_id).some((x) => isAdmin(x))) m.role = 'owner';
      bump(ctx, m.trip_id);
      out.push({ trip_id: m.trip_id, member_id: m.id });
    }
    return out;
  },

  request_profile_join(ctx, code, memberId, person = null, name = null) {
    const { db } = ctx;
    const contact = db.user_contacts.find((c) => c.user_id === ctx.uid);
    if (!contact) fail('forbidden');
    const trip = tripByCode(db, code);
    if (!trip) fail('invalid_code');
    const target = db.members.find((m) => m.id === memberId && m.trip_id === trip.id);
    if (!target) fail('not_found');
    const from = myMember(db, trip.id, ctx.uid);
    if (from && from.id === target.id) fail('already_member');
    const who = optText(person, 30);
    const nm = optText(name, 40);
    if (who && !(target.people || []).includes(who)) bad();
    if (!who && !nm) bad();
    remove(db.profile_requests, (r) => r.user_id === ctx.uid && r.trip_id === trip.id);
    const row = {
      id: newId(), trip_id: trip.id, member_id: target.id, user_id: ctx.uid, email: contact.email, person: who,
      name: who || nm, from_member: from ? from.id : null, status: 'pending', created_at: ctx.now(), answered_at: null,
    };
    db.profile_requests.push(row);
    notify(ctx, trip.id, {
      title: `${row.name} מבקש/ת להצטרף לפרופיל שלכם 🙋`, body: `${contact.email} · אפשר לאשר או לדחות במסך הבית`,
      audience: [target.id], link: `#/t/${trip.id}`,
    });
    bump(ctx, trip.id);
    return row.id;
  },

  cancel_profile_request(ctx, tripId) {
    remove(ctx.db.profile_requests, (r) => r.user_id === ctx.uid && r.trip_id === tripId && r.status === 'pending');
    bump(ctx, tripId);
    return null;
  },

  respond_profile_request(ctx, requestId, approve) {
    const { db } = ctx;
    const q = db.profile_requests.find((r) => r.id === requestId);
    if (!q || q.status !== 'pending') fail('not_allowed_state');
    const me = requireMember(ctx, q.trip_id);
    if (me.id !== q.member_id && !isAdmin(me)) fail('forbidden');
    const t = byId(db.members, q.member_id);
    if (!toBool(approve)) {
      q.status = 'declined';
      q.answered_at = ctx.now();
      if (q.from_member) notify(ctx, q.trip_id, { title: `${t.display_name} לא אישרו את ההצטרפות לפרופיל`, audience: [q.from_member], link: `#/t/${q.trip_id}` });
      bump(ctx, q.trip_id);
      return null;
    }
    let addHeads = 0;
    let addPeople = [];
    const f = q.from_member ? byId(db.members, q.from_member) : null;
    if (f) {
      if (db.expenses.some((e) => e.paid_by === f.id || e.created_by === f.id)
          || db.expense_shares.some((s) => s.member_id === f.id)
          || db.payments.some((p) => p.from_member === f.id || p.to_member === f.id)) fail('has_money_records');
      for (const p of db.pledges.filter((x) => x.member_id === f.id)) {
        const same = db.pledges.find((x) => x.item_id === p.item_id && x.member_id === t.id);
        if (same) same.qty = Math.min(200, same.qty + p.qty);
        else p.member_id = t.id;
      }
      remove(db.pledges, (x) => x.member_id === f.id);
      db.personal_items.filter((x) => x.member_id === f.id).forEach((x) => { x.member_id = t.id; });
      const targetRides = db.rides.some((r) => r.driver_member === t.id);
      if (targetRides || db.ride_seats.some((s) => s.member_id === t.id)) remove(db.ride_seats, (s) => s.member_id === f.id);
      else db.ride_seats.filter((s) => s.member_id === f.id).forEach((s) => { s.member_id = t.id; });
      if (targetRides) remove(db.rides, (r) => r.driver_member === f.id);
      else db.rides.filter((r) => r.driver_member === f.id).forEach((r) => { r.driver_member = t.id; });
      for (const e of db.member_emails.filter((x) => x.member_id === f.id)) {
        if (!db.member_emails.some((x) => x.member_id === t.id && x.email === e.email)) e.member_id = t.id;
      }
      remove(db.member_emails, (x) => x.member_id === f.id);
      db.member_users.filter((l) => l.member_id === f.id).forEach((l) => { l.member_id = t.id; });
      const rank = (r) => (r === 'owner' ? 0 : r === 'admin' ? 1 : 2);
      if (rank(f.role) < rank(t.role)) t.role = f.role;
      if (!q.person) {
        addHeads = Math.max(1, f.headcount || 1);
        addPeople = f.people && f.people.length ? f.people : [q.name];
      }
      for (const table of ['poll_votes', 'notification_reads', 'admin_votes', 'reminders_sent']) {
        if (Array.isArray(db[table])) remove(db[table], (x) => x.member_id === f.id || x.voter_id === f.id || x.candidate_id === f.id);
      }
      remove(db.members, (m) => m === f);
    } else {
      remove(db.member_users, (l) => l.user_id === q.user_id && l.trip_id === q.trip_id);
      db.member_users.push({ user_id: q.user_id, trip_id: q.trip_id, member_id: t.id, person: q.person || q.name || null, created_at: ctx.now() });
      if (!q.person) {
        addHeads = 1;
        addPeople = [q.name];
      }
    }
    t.headcount = Math.min(20, (t.headcount || 1) + addHeads);
    t.people = [...(t.people || []), ...addPeople];
    if (!t.claimed_at) t.claimed_at = ctx.now();
    if (!db.member_emails.some((x) => x.member_id === t.id && x.email === q.email)) {
      db.member_emails.push({ member_id: t.id, trip_id: q.trip_id, email: q.email, token: newId(), created_at: ctx.now() });
    }
    q.status = 'approved';
    q.answered_at = ctx.now();
    notify(ctx, q.trip_id, {
      title: `${q.name} הצטרפ/ה לפרופיל ${t.display_name} ✅`, body: 'מעכשיו אתם יחד בפרופיל — הרשימות, ההסעה והכסף משותפים.',
      audience: [t.id], link: `#/t/${q.trip_id}`,
    });
    bump(ctx, q.trip_id);
    return null;
  },

  pending_view(ctx, tripId) {
    const { db } = ctx;
    const q = db.profile_requests.filter((r) => r.user_id === ctx.uid && r.trip_id === tripId).sort(newest)[0];
    if (!q || myMember(db, tripId, ctx.uid)) fail('forbidden');
    const trip = byId(db.trips, tripId);
    const cats = new Map(db.categories.filter((c) => c.trip_id === tripId).map((c) => [c.id, c]));
    return {
      request: { id: q.id, status: q.status, name: q.name, created_at: q.created_at, profile: byId(db.members, q.member_id)?.display_name ?? null },
      trip: { id: trip.id, name: trip.name, emoji: trip.emoji, location: trip.location, starts_at: trip.starts_at, ends_at: trip.ends_at, info: trip.info },
      members: membersOf(db, tripId).sort(byCreated).map((m) => ({ display_name: m.display_name, emoji: m.emoji, color: m.color, headcount: m.headcount })),
      items: db.items.filter((i) => i.trip_id === tripId && i.status === 'active').sort(bySort).map((i) => ({
        title: i.title, category: cats.get(i.category_id)?.name ?? null, emoji: cats.get(i.category_id)?.emoji ?? null,
        who: db.pledges.filter((p) => p.item_id === i.id).map((p) => byId(db.members, p.member_id)?.display_name).filter(Boolean).join(', ') || null,
      })),
    };
  },

  send_test_notification(ctx, tripId) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    const title = 'בדיקה 🔔 ההתראות עובדות!';
    const hourAgo = Date.parse(ctx.now()) - 3600000;
    const recent = db.notifications.filter((n) => n.trip_id === tripId && n.title === title && Date.parse(n.created_at) > hourAgo
      && Array.isArray(n.audience) && n.audience.length === 1 && n.audience[0] === me.id).length;
    if (recent >= 3) fail('rate_limited');
    notify(ctx, tripId, { title, body: 'ככה ייראו העדכונים מהטיול — גם בטלפון וגם במייל.', audience: [me.id], link: `#/t/${tripId}/me` });
    bump(ctx, tripId);
    return null;
  },

  respond_assignment(ctx, itemId, accept, reason = null) {
    const { db } = ctx;
    const item = need(db.items, itemId);
    const me = requireMember(ctx, item.trip_id);
    const why = optText(reason, 200);
    const p = db.pledges.find((x) => x.item_id === item.id && x.member_id === me.id);
    if (!p || !p.assigned_by || p.assigned_by === me.id) fail('not_allowed_state');
    const link = itemLink(item.trip_id, item.id);
    if (toBool(accept)) {
      p.accepted_at = ctx.now();
      notify(ctx, item.trip_id, { title: `${me.display_name} אישר/ה: ${item.title} ✅`, audience: [p.assigned_by], link });
    } else {
      remove(db.pledges, (x) => x === p);
      notify(ctx, item.trip_id, { title: `${me.display_name} לא יכול/ה: ${item.title}`, body: why || 'אפשר לשבץ מישהו אחר', audience: [p.assigned_by], link });
    }
    bump(ctx, item.trip_id);
    return null;
  },

  update_member(ctx, memberId, patch) {
    const member = need(ctx.db.members, memberId);
    const me = requireMember(ctx, member.trip_id);
    if (me.id !== member.id && !isAdmin(me)) fail('forbidden');
    applyProfile(member, profileFields(patch, false));
    bump(ctx, member.trip_id);
    return null;
  },

  create_member(ctx, tripId, profile) {
    requireAdmin(ctx, tripId);
    const prof = profileFields(profile, true);
    if (membersOf(ctx.db, tripId).length >= LIMITS.members) fail('limit_reached');
    const member = newMemberRow(ctx, tripId, prof, 'member', false);
    ctx.db.members.push(member);
    bump(ctx, tripId);
    return member.id;
  },

  set_role(ctx, memberId, role) {
    const { db } = ctx;
    const member = need(db.members, memberId);
    requireAdmin(ctx, member.trip_id);
    oneOf(role, ['admin', 'member']);
    if (member.role === 'owner') fail('owner_locked');
    if (role === 'member' && isAdmin(member)) {
      const others = membersOf(db, member.trip_id).some((m) => m.id !== member.id && isAdmin(m));
      if (!others) fail('last_admin');
    }
    const promoted = role === 'admin' && member.role !== 'admin';
    member.role = role;
    if (promoted) {
      notify(ctx, member.trip_id, { title: 'מונית למנהל/ת 👑', audience: [member.id], link: `#/t/${member.trip_id}/people` });
    }
    bump(ctx, member.trip_id);
    return null;
  },

  remove_member(ctx, memberId) {
    const { db } = ctx;
    const member = need(db.members, memberId);
    requireAdmin(ctx, member.trip_id);
    if (member.role === 'owner') fail('owner_locked');
    if (isAdmin(member) && !membersOf(db, member.trip_id).some((m) => m.id !== member.id && isAdmin(m))) fail('last_admin');
    const id = member.id;
    const hasMoney =
      db.expenses.some((e) => e.paid_by === id || e.created_by === id) ||
      db.expense_shares.some((s) => s.member_id === id) ||
      db.payments.some((p) => p.from_member === id || p.to_member === id || p.created_by === id);
    if (hasMoney) fail('has_money_records');

    remove(db.pledges, (p) => p.member_id === id);
    remove(db.admin_votes, (v) => v.voter_id === id || v.candidate_id === id);
    remove(db.notification_reads, (r) => r.member_id === id);
    remove(db.poll_votes, (v) => v.member_id === id);
    remove(db.personal_items, (p) => p.member_id === id);
    remove(db.member_users, (l) => l.member_id === id);
    remove(db.member_secrets, (s) => s.member_id === id);
    remove(db.push_subscriptions, (s) => s.member_id === id);
    for (const c of db.categories) if (c.default_buyer_id === id) c.default_buyer_id = null;
    for (const i of db.items) if (i.created_by === id) i.created_by = null;
    for (const p of db.polls) if (p.created_by === id) p.created_by = null;
    remove(db.members, (m) => m.id === id);
    bump(ctx, member.trip_id);
    return null;
  },

  leave_trip(ctx, tripId) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    if (isAdmin(me) && !membersOf(db, tripId).some((m) => m.id !== me.id && isAdmin(m))) fail('last_admin');
    remove(db.member_users, (l) => l.user_id === ctx.uid && l.trip_id === tripId);
    releaseIfOrphan(db, me.id);
    bump(ctx, tripId);
    return null;
  },

  vote_admin(ctx, candidateId, on) {
    const { db } = ctx;
    const candidate = need(db.members, candidateId);
    const me = requireMember(ctx, candidate.trip_id);
    const wanted = toBool(on);
    const existing = db.admin_votes.find((v) => v.voter_id === me.id && v.candidate_id === candidate.id);
    if (wanted && !existing) {
      db.admin_votes.push({ trip_id: candidate.trip_id, voter_id: me.id, candidate_id: candidate.id, created_at: ctx.now() });
    } else if (!wanted && existing) {
      remove(db.admin_votes, (v) => v === existing);
    }
    bump(ctx, candidate.trip_id);
    return null;
  },

  upsert_category(ctx, tripId, cat) {
    const { db } = ctx;
    requireAdmin(ctx, tripId);
    reqObj(cat);
    const f = {};
    if (given(cat, 'name')) f.name = reqText(cat.name, 1, 40);
    if (given(cat, 'emoji')) f.emoji = reqText(cat.emoji, 1, 16);
    if (given(cat, 'sort')) f.sort = toInt(cat.sort, -1000000, 1000000);
    if (has(cat, 'default_buyer_id')) f.default_buyer_id = cat.default_buyer_id === null ? null : memberRef(db, tripId, cat.default_buyer_id);
    if (has(cat, 'note')) f.note = optText(cat.note, 500);

    let row;
    if (given(cat, 'id')) {
      row = byId(db.categories, cat.id);
      if (!row || row.trip_id !== tripId) fail('not_found');
      Object.assign(row, f);
    } else {
      if (!f.name) bad();
      const siblings = db.categories.filter((c) => c.trip_id === tripId);
      row = {
        id: newId(), trip_id: tripId, name: f.name, emoji: f.emoji ?? '📦', sort: f.sort ?? nextSort(siblings),
        default_buyer_id: f.default_buyer_id ?? null, note: f.note ?? null, created_at: ctx.now(),
      };
      db.categories.push(row);
    }
    bump(ctx, tripId);
    return row.id;
  },

  delete_category(ctx, categoryId) {
    const { db } = ctx;
    const cat = need(db.categories, categoryId);
    requireAdmin(ctx, cat.trip_id);
    remove(db.categories, (c) => c.id === cat.id);
    for (const i of db.items) if (i.category_id === cat.id) i.category_id = null;
    for (const e of db.expenses) if (e.category_id === cat.id) e.category_id = null;
    bump(ctx, cat.trip_id);
    return null;
  },

  add_item(ctx, tripId, p) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    const trip = byId(db.trips, tripId);
    const f = itemFields(db, tripId, p, true);
    const pledgeQty = pledgeQtyVal(p);
    const tripItems = db.items.filter((i) => i.trip_id === tripId);
    if (tripItems.length >= LIMITS.items) fail('limit_reached');
    const item = insertItem(ctx, trip, me, f, pledgeQty, nextSort(tripItems));
    if (item.status === 'proposed') {
      const admins = membersOf(db, tripId).filter(isAdmin).map((m) => m.id);
      if (admins.length) {
        notify(ctx, tripId, {
          title: `הצעה חדשה: ${item.title}`,
          body: `${me.display_name} הציע/ה להוסיף לרשימה`,
          audience: admins,
          link: itemLink(tripId, item.id),
        });
      }
    }
    bump(ctx, tripId);
    return item.id;
  },

  add_items_bulk(ctx, tripId, list) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    const trip = byId(db.trips, tripId);
    if (!Array.isArray(list) || list.length > LIMITS.bulk) bad();
    const tripItems = db.items.filter((i) => i.trip_id === tripId);
    if (tripItems.length + list.length > LIMITS.items) fail('limit_reached');

    // Validate everything first (all-or-nothing).
    const prepared = list.map((raw) => {
      reqObj(raw);
      const { category_id: catId, category_name: catName, category_emoji: catEmoji, ...rest } = raw;
      const f = itemFields(db, tripId, rest, true);
      let category = null;
      if (catId !== undefined && catId !== null && catId !== '') category = { id: categoryRef(db, tripId, catId) };
      else if (typeof catName === 'string' && catName.trim()) {
        category = { name: reqText(catName, 1, 40), emoji: catEmoji ? reqText(catEmoji, 1, 16) : null };
      } else if (catName != null && typeof catName !== 'string') bad();
      return { f, category, pledgeQty: pledgeQtyVal(raw) };
    });

    const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const resolved = new Map();
    const resolveCategory = (c) => {
      if (!c) return null;
      if (c.id !== undefined) return c.id;
      const key = norm(c.name);
      if (resolved.has(key)) return resolved.get(key);
      const found = db.categories.find((x) => x.trip_id === tripId && norm(x.name) === key);
      let id = found ? found.id : null;
      if (!found && isAdmin(me)) {
        const siblings = db.categories.filter((x) => x.trip_id === tripId);
        id = newId();
        db.categories.push({
          id, trip_id: tripId, name: c.name, emoji: c.emoji || '📦', sort: nextSort(siblings),
          default_buyer_id: null, note: null, created_at: ctx.now(),
        });
      }
      resolved.set(key, id);
      return id;
    };

    let sort = nextSort(tripItems);
    for (const { f, category, pledgeQty } of prepared) {
      f.category_id = resolveCategory(category);
      insertItem(ctx, trip, me, f, pledgeQty, sort++);
    }
    if (prepared.length) bump(ctx, tripId);
    return prepared.length;
  },

  update_item(ctx, itemId, patch) {
    const { db } = ctx;
    const item = need(db.items, itemId);
    const me = requireMember(ctx, item.trip_id);
    if (!(isAdmin(me) || (item.created_by === me.id && item.status === 'proposed'))) fail('forbidden');
    Object.assign(item, itemFields(db, item.trip_id, patch, false));
    item.updated_at = ctx.now();
    bump(ctx, item.trip_id);
    return null;
  },

  review_item(ctx, itemId, approve, reason) {
    const { db } = ctx;
    const item = need(db.items, itemId);
    const me = requireAdmin(ctx, item.trip_id);
    const ok = toBool(approve);
    const why = optText(reason, 500);
    if (item.status !== 'proposed') fail('not_allowed_state');
    if (ok) {
      item.status = 'active';
      item.approved_by = me.id;
      item.reject_reason = null;
    } else {
      item.status = 'rejected';
      item.reject_reason = why;
    }
    item.updated_at = ctx.now();
    if (item.created_by && item.created_by !== me.id) {
      notify(ctx, item.trip_id, {
        title: ok ? `ההצעה אושרה ✅: ${item.title}` : `ההצעה נדחתה: ${item.title}`,
        body: ok ? null : why,
        audience: [item.created_by],
        link: itemLink(item.trip_id, item.id),
      });
    }
    bump(ctx, item.trip_id);
    return null;
  },

  delete_item(ctx, itemId) {
    const { db } = ctx;
    const item = need(db.items, itemId);
    const me = requireMember(ctx, item.trip_id);
    const own = item.created_by === me.id && (item.status === 'proposed' || item.status === 'rejected');
    if (!isAdmin(me) && !own) fail('forbidden');
    remove(db.pledges, (p) => p.item_id === item.id);
    remove(db.items, (i) => i.id === item.id);
    bump(ctx, item.trip_id);
    return null;
  },

  pledge(ctx, itemId, qty) {
    const { db } = ctx;
    const item = need(db.items, itemId);
    const me = requireMember(ctx, item.trip_id);
    const q = qty == null ? 1 : toInt(qty, -1000000, 200);
    if (item.type === 'each') bad();
    const allowed = item.status === 'active' || (item.status === 'proposed' && item.created_by === me.id);
    if (!allowed) fail('not_allowed_state');
    const existing = db.pledges.find((p) => p.item_id === item.id && p.member_id === me.id);
    if (q <= 0) {
      if (existing) remove(db.pledges, (p) => p === existing);
    } else if (existing) {
      existing.qty = q;
    } else {
      db.pledges.push({
        id: newId(), trip_id: item.trip_id, item_id: item.id, member_id: me.id,
        qty: q, done: false, assigned_by: null, created_at: ctx.now(),
      });
    }
    bump(ctx, item.trip_id);
    return null;
  },

  assign(ctx, itemId, memberId, qty) {
    const { db } = ctx;
    const item = need(db.items, itemId);
    const me = requireAdmin(ctx, item.trip_id);
    const target = byId(db.members, memberId);
    if (!target || target.trip_id !== item.trip_id) fail('not_found');
    const q = qty == null ? 1 : toInt(qty, -1000000, 200);
    if (item.type === 'each') bad();
    if (item.status === 'rejected') fail('not_allowed_state');
    const existing = db.pledges.find((p) => p.item_id === item.id && p.member_id === target.id);
    if (q <= 0) {
      if (existing) remove(db.pledges, (p) => p === existing);
    } else {
      const acceptedAt = target.id === me.id ? ctx.now() : null; // someone else's assignment waits for an answer
      if (existing) {
        existing.qty = q;
        existing.assigned_by = me.id;
        existing.accepted_at = acceptedAt;
      } else {
        db.pledges.push({
          id: newId(), trip_id: item.trip_id, item_id: item.id, member_id: target.id,
          qty: q, done: false, assigned_by: me.id, accepted_at: acceptedAt, created_at: ctx.now(),
        });
      }
      if (target.id !== me.id) {
        notify(ctx, item.trip_id, {
          title: `שובצת: ${item.title}`, body: 'אפשר לאשר או להגיד שלא מסתדר — במסך הבית',
          audience: [target.id], link: itemLink(item.trip_id, item.id),
        });
      }
    }
    bump(ctx, item.trip_id);
    return null;
  },

  set_pledge_done(ctx, itemId, done) {
    const { db } = ctx;
    const item = need(db.items, itemId);
    const me = requireMember(ctx, item.trip_id);
    const d = toBool(done);
    if (item.status === 'rejected') fail('not_allowed_state');
    const existing = db.pledges.find((p) => p.item_id === item.id && p.member_id === me.id);
    if (existing) existing.done = d;
    else if (item.type === 'each') {
      db.pledges.push({
        id: newId(), trip_id: item.trip_id, item_id: item.id, member_id: me.id,
        qty: 1, done: d, assigned_by: null, created_at: ctx.now(),
      });
    } else fail('not_found');
    bump(ctx, item.trip_id);
    return null;
  },

  set_item_done(ctx, itemId, done) {
    const { db } = ctx;
    const item = need(db.items, itemId);
    const me = requireMember(ctx, item.trip_id);
    const d = toBool(done);
    if (item.type !== 'buy' && item.type !== 'task') bad();
    if (item.status === 'rejected') fail('not_allowed_state');
    const pledger = db.pledges.some((p) => p.item_id === item.id && p.member_id === me.id);
    if (!pledger && !isAdmin(me)) fail('forbidden');
    item.done = d;
    item.done_at = d ? ctx.now() : null;
    item.updated_at = ctx.now();
    bump(ctx, item.trip_id);
    return null;
  },

  add_personal(ctx, tripId, title) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    const t = reqText(title, 1, 80);
    const mine = db.personal_items.filter((p) => p.member_id === me.id);
    if (mine.length >= LIMITS.personal) fail('limit_reached');
    const row = { id: newId(), trip_id: tripId, member_id: me.id, title: t, done: false, sort: nextSort(mine), created_at: ctx.now() };
    db.personal_items.push(row);
    bump(ctx, tripId);
    return row.id;
  },

  add_personal_template(ctx, tripId) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    const mine = db.personal_items.filter((p) => p.member_id === me.id);
    const have = new Set(mine.map((p) => p.title.trim()));
    const trip = db.trips.find((x) => x.id === tripId);
    const list = Array.isArray(trip?.info?.packing) && trip.info.packing.length ? trip.info.packing : PERSONAL_TEMPLATE;
    const toAdd = list.filter((t) => !have.has(t));
    if (mine.length + toAdd.length > LIMITS.personal) fail('limit_reached');
    let sort = nextSort(mine);
    for (const title of toAdd) {
      db.personal_items.push({ id: newId(), trip_id: tripId, member_id: me.id, title, done: false, sort: sort++, created_at: ctx.now() });
    }
    if (toAdd.length) bump(ctx, tripId);
    return toAdd.length;
  },

  update_personal(ctx, id, patch) {
    const { db } = ctx;
    const row = need(db.personal_items, id);
    const me = myMember(db, row.trip_id, ctx.uid);
    if (!me || me.id !== row.member_id) fail('forbidden');
    reqObj(patch);
    if (given(patch, 'title')) row.title = reqText(patch.title, 1, 80);
    if (given(patch, 'done')) row.done = toBool(patch.done);
    if (given(patch, 'sort')) row.sort = toInt(patch.sort, -1000000, 1000000);
    bump(ctx, row.trip_id);
    return null;
  },

  delete_personal(ctx, id) {
    const { db } = ctx;
    const row = need(db.personal_items, id);
    const me = myMember(db, row.trip_id, ctx.uid);
    if (!me || me.id !== row.member_id) fail('forbidden');
    remove(db.personal_items, (p) => p.id === row.id);
    bump(ctx, row.trip_id);
    return null;
  },

  add_expense(ctx, tripId, exp) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    const f = expenseFields(db, tripId, exp, true);
    const paidBy = f.paid_by ?? me.id;
    if (paidBy !== me.id && !isAdmin(me)) fail('forbidden');
    const mode = f.split_mode ?? 'all';
    if (mode === 'members' && !(f.members && f.members.length)) bad();
    if (db.expenses.filter((e) => e.trip_id === tripId).length >= LIMITS.expenses) fail('limit_reached');
    const row = {
      id: newId(),
      trip_id: tripId,
      title: f.title,
      amount: f.amount,
      paid_by: paidBy,
      category_id: f.category_id ?? null,
      note: f.note ?? null,
      split_mode: mode,
      created_by: me.id,
      spent_on: f.spent_on ?? jerusalemYmd(new Date()),
      created_at: ctx.now(),
      currency: f.currency ?? null,
      orig_amount: f.orig_amount ?? null,
      rate: f.rate ?? null,
    };
    db.expenses.push(row);
    if (mode === 'members') replaceShares(ctx, row, f.members);
    // no ping per receipt: in the app now, push/e-mail in the next daily summary
    const payer = db.members.find((m) => m.id === paidBy);
    ctx.db.notifications.push({
      id: newId(), trip_id: tripId, kind: 'system',
      title: clip(`💸 ${payer ? payer.display_name : ''} שילמ/ה: ${row.title} · ${fmtShekel(row.amount)}`, 80),
      body: 'החלק של כל אחד — במסך הכסף.',
      audience: mode === 'members' ? db.expense_shares.filter((s) => s.expense_id === row.id).map((s) => s.member_id) : null,
      author_member: me.id, urgent: false, link: `#/t/${tripId}/money`, topic: 'money', delivery: 'digest',
      created_at: ctx.now(),
    });
    bump(ctx, tripId);
    return row.id;
  },

  update_expense(ctx, id, patch) {
    const { db } = ctx;
    const exp = need(db.expenses, id);
    const me = requireMember(ctx, exp.trip_id);
    if (!(isAdmin(me) || exp.created_by === me.id || exp.paid_by === me.id)) fail('forbidden');
    const f = expenseFields(db, exp.trip_id, patch, false);
    if (f.paid_by !== undefined && f.paid_by !== exp.paid_by && f.paid_by !== me.id && !isAdmin(me)) fail('forbidden');
    const mode = f.split_mode ?? exp.split_mode;
    if (mode === 'members') {
      const shares = f.members ?? (exp.split_mode === 'members' ? db.expense_shares.filter((s) => s.expense_id === exp.id) : []);
      if (!shares.length) bad();
    }
    for (const k of ['title', 'amount', 'paid_by', 'category_id', 'note', 'spent_on', 'currency', 'orig_amount', 'rate']) {
      if (f[k] !== undefined) exp[k] = f[k];
    }
    exp.split_mode = mode;
    if (mode === 'all') replaceShares(ctx, exp, []);
    else if (f.members) replaceShares(ctx, exp, f.members);
    bump(ctx, exp.trip_id);
    return null;
  },

  delete_expense(ctx, id) {
    const { db } = ctx;
    const exp = need(db.expenses, id);
    const me = requireMember(ctx, exp.trip_id);
    if (!(isAdmin(me) || exp.created_by === me.id || exp.paid_by === me.id)) fail('forbidden');
    remove(db.expense_shares, (s) => s.expense_id === exp.id);
    remove(db.expenses, (e) => e.id === exp.id);
    bump(ctx, exp.trip_id);
    return null;
  },

  add_payment(ctx, tripId, pay) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    reqObj(pay);
    const from = given(pay, 'from_member') ? memberRef(db, tripId, pay.from_member) : me.id;
    if (!given(pay, 'to_member')) bad();
    const to = memberRef(db, tripId, pay.to_member);
    if (from === to) bad();
    const amount = moneyVal(pay.amount);
    const method = given(pay, 'method') ? oneOf(pay.method, PAY_METHODS) : 'bit';
    const note = optText(pay.note, 500);
    let status = 'sent';
    if (from !== me.id) {
      if (to === me.id) status = 'confirmed';
      else if (!isAdmin(me)) fail('forbidden');
    }
    const now = ctx.now();
    const row = {
      id: newId(), trip_id: tripId, from_member: from, to_member: to, amount, method, note, status,
      created_by: me.id, created_at: now, confirmed_at: status === 'confirmed' ? now : null,
    };
    db.payments.push(row);

    const fromName = byId(db.members, from).display_name;
    const toName = byId(db.members, to).display_name;
    const link = `#/t/${tripId}/money`;
    if (from !== me.id && to === me.id) {
      notify(ctx, tripId, { title: `${toName} אישר/ה שקיבל/ה ₪${formatAmount(amount)} ✅`, audience: [from], link });
    } else {
      notify(ctx, tripId, { title: `${fromName} סימן/ה שהעביר/ה לך ₪${formatAmount(amount)}`, audience: [to], link });
    }
    bump(ctx, tripId);
    return row.id;
  },

  confirm_payment(ctx, id) {
    const { db } = ctx;
    const pay = need(db.payments, id);
    const me = requireMember(ctx, pay.trip_id);
    if (pay.to_member !== me.id && !isAdmin(me)) fail('forbidden');
    if (pay.status !== 'confirmed') {
      pay.status = 'confirmed';
      pay.confirmed_at = ctx.now();
      if (pay.from_member !== me.id) {
        const toName = byId(db.members, pay.to_member).display_name;
        notify(ctx, pay.trip_id, {
          title: `${toName} אישר/ה שקיבל/ה ₪${formatAmount(pay.amount)} ✅`,
          audience: [pay.from_member],
          link: `#/t/${pay.trip_id}/money`,
        });
      }
    }
    bump(ctx, pay.trip_id);
    return null;
  },

  delete_payment(ctx, id) {
    const { db } = ctx;
    const pay = need(db.payments, id);
    const me = requireMember(ctx, pay.trip_id);
    if (!isAdmin(me)) {
      if (pay.created_by !== me.id) fail('forbidden');
      if (pay.status === 'confirmed') fail('not_allowed_state');
    }
    remove(db.payments, (p) => p.id === pay.id);
    bump(ctx, pay.trip_id);
    return null;
  },

  send_announcement(ctx, tripId, title, body, audience, urgent, digest) {
    const { db } = ctx;
    const me = requireAdmin(ctx, tripId);
    const t = reqText(title, 1, 80);
    const b = optText(body, 2000);
    let aud = null;
    if (audience != null) {
      if (!Array.isArray(audience)) bad();
      const ids = [...new Set(audience)].map((id) => memberRef(db, tripId, id));
      aud = ids.length ? ids : null;
    }
    const row = {
      id: newId(), trip_id: tripId, kind: 'announcement', title: t, body: b, audience: aud,
      author_member: me.id, urgent: urgent == null ? false : toBool(urgent), link: null, created_at: ctx.now(),
      delivery: toBool(digest ?? false) && !toBool(urgent ?? false) ? 'digest' : 'now',
    };
    db.notifications.push(row);
    bump(ctx, tripId);
    return row.id;
  },

  delete_notification(ctx, id) {
    const { db } = ctx;
    const n = need(db.notifications, id);
    const me = requireMember(ctx, n.trip_id);
    if (!isAdmin(me) && n.author_member !== me.id) fail('forbidden');
    remove(db.notification_reads, (r) => r.notification_id === n.id);
    remove(db.notifications, (x) => x.id === n.id);
    bump(ctx, n.trip_id);
    return null;
  },

  mark_read(ctx, tripId, ids) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    if (ids != null && !Array.isArray(ids)) bad();
    let added = 0;
    for (const id of new Set(ids || [])) {
      const n = byId(db.notifications, id);
      if (!n || n.trip_id !== tripId || !canSeeNotification(n, me)) continue;
      if (db.notification_reads.some((r) => r.notification_id === n.id && r.member_id === me.id)) continue;
      db.notification_reads.push({ notification_id: n.id, trip_id: tripId, member_id: me.id, read_at: ctx.now() });
      added++;
    }
    // Only bump when something changed, so "open screen → mark read → refresh" can't loop.
    if (added) bump(ctx, tripId);
    return null;
  },

  create_poll(ctx, tripId, question, options, multi) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    const q = reqText(question, 1, 140);
    if (!Array.isArray(options) || options.length < 2 || options.length > 8) bad();
    const labels = options.map((o) => reqText(o, 1, 80));
    const row = {
      id: newId(), trip_id: tripId, question: q,
      options: labels.map((label, i) => ({ id: `o${i + 1}`, label })),
      multi: multi == null ? false : toBool(multi), closed: false, created_by: me.id, created_at: ctx.now(),
    };
    db.polls.push(row);
    bump(ctx, tripId);
    return row.id;
  },

  vote_poll(ctx, pollId, optionIds) {
    const { db } = ctx;
    const poll = need(db.polls, pollId);
    const me = requireMember(ctx, poll.trip_id);
    if (poll.closed) fail('not_allowed_state');
    if (optionIds != null && !Array.isArray(optionIds)) bad();
    const ids = [...new Set(optionIds || [])];
    const valid = new Set(poll.options.map((o) => o.id));
    if (ids.some((x) => !valid.has(x))) bad();
    if (!poll.multi && ids.length > 1) bad();
    remove(db.poll_votes, (v) => v.poll_id === poll.id && v.member_id === me.id);
    for (const optionId of ids) {
      db.poll_votes.push({ poll_id: poll.id, trip_id: poll.trip_id, member_id: me.id, option_id: optionId });
    }
    bump(ctx, poll.trip_id);
    return null;
  },

  close_poll(ctx, pollId, closed) {
    const { db } = ctx;
    const poll = need(db.polls, pollId);
    const me = requireMember(ctx, poll.trip_id);
    if (!isAdmin(me) && poll.created_by !== me.id) fail('forbidden');
    poll.closed = toBool(closed);
    bump(ctx, poll.trip_id);
    return null;
  },

  delete_poll(ctx, pollId) {
    const { db } = ctx;
    const poll = need(db.polls, pollId);
    const me = requireMember(ctx, poll.trip_id);
    if (!isAdmin(me) && poll.created_by !== me.id) fail('forbidden');
    remove(db.poll_votes, (v) => v.poll_id === poll.id);
    remove(db.polls, (p) => p.id === poll.id);
    bump(ctx, poll.trip_id);
    return null;
  },

  save_push_subscription(ctx, tripId, sub) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    reqObj(sub);
    const endpoint = reqText(sub.endpoint, 1, 2000);
    if (!/^https:\/\//i.test(endpoint)) bad();
    const keys = reqObj(sub.keys);
    const p256dh = reqText(keys.p256dh, 1, 500);
    const auth = reqText(keys.auth, 1, 500);
    const existing = db.push_subscriptions.find((s) => s.endpoint === endpoint);
    if (existing) Object.assign(existing, { trip_id: tripId, member_id: me.id, user_id: ctx.uid, p256dh, auth });
    else {
      db.push_subscriptions.push({ id: newId(), trip_id: tripId, member_id: me.id, user_id: ctx.uid, endpoint, p256dh, auth, created_at: ctx.now() });
    }
    ctx.dirty = true; // not part of the snapshot → no rev bump needed
    return null;
  },

  delete_push_subscription(ctx, endpoint) {
    const { db } = ctx;
    if (typeof endpoint !== 'string') bad();
    const before = db.push_subscriptions.length;
    remove(db.push_subscriptions, (s) => s.endpoint === endpoint && s.user_id === ctx.uid);
    if (db.push_subscriptions.length !== before) ctx.dirty = true;
    return null;
  },
};

/** Demo-only (api.demo.actAs): re-link the current user to `memberId` within its trip. */
function actAsMember(ctx, memberId) {
  const { db } = ctx;
  const member = need(db.members, memberId);
  remove(db.member_users, (l) => l.user_id === ctx.uid && l.trip_id === member.trip_id);
  linkUser(ctx, member.trip_id, member.id, (member.people || [])[0] || null);
  bump(ctx, member.trip_id);
  return { trip_id: member.trip_id, member_id: member.id };
}

// ---------------------------------------------------------------------------
// Change bus (one per tab, shared by all demo api instances) + cross-tab events
// ---------------------------------------------------------------------------

const bus = typeof EventTarget === 'function' ? new EventTarget() : null;
let storageHooked = false;

function emit(tripIds) {
  if (!bus) return;
  // Deliver after the current call resolves, like a realtime message after the RPC reply.
  setTimeout(() => bus.dispatchEvent(new CustomEvent('change', { detail: { tripIds } })), 0);
}

function changedTrips(oldRaw, newRaw) {
  let before;
  let after;
  try {
    before = oldRaw ? JSON.parse(oldRaw) : null;
    after = newRaw ? JSON.parse(newRaw) : null;
  } catch {
    return '*';
  }
  if (!validDb(before) || !validDb(after)) return '*';
  const oldRev = new Map(before.trips.map((t) => [t.id, t.rev]));
  const changed = after.trips.filter((t) => oldRev.get(t.id) !== t.rev).map((t) => t.id);
  const gone = before.trips.some((t) => !after.trips.some((x) => x.id === t.id));
  return gone ? '*' : changed;
}

function hookStorage() {
  if (storageHooked || typeof window === 'undefined') return;
  storageHooked = true;
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== DEMO_STORAGE_KEY) return;
    const tripIds = e.key === null ? '*' : changedTrips(e.oldValue, e.newValue);
    if (tripIds === '*' || tripIds.length) emit(tripIds);
  });
}

// ---------------------------------------------------------------------------
// The API object
// ---------------------------------------------------------------------------

function defaultStorage() {
  try {
    const s = globalThis.localStorage;
    const probe = '__medura_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function latencyRange(opt) {
  if (typeof opt === 'number') return [opt, opt];
  if (Array.isArray(opt) && opt.length === 2) return [Number(opt[0]) || 0, Number(opt[1]) || 0];
  return [60, 120];
}

/**
 * @param {object} [options]
 * @param {Storage|null} [options.storage]  defaults to localStorage (falls back to memory when blocked)
 * @param {number|[number, number]} [options.latency]  simulated latency in ms (default 60–120)
 */
export function createDemoApi(options = {}) {
  let storage = options.storage !== undefined ? options.storage : defaultStorage();
  const [latMin, latMax] = latencyRange(options.latency);
  let memoryRaw = null;
  let memoryUid = null;
  let uid = null;
  let initialized = false;

  const sleep = () => {
    const ms = latMin + Math.random() * Math.max(0, latMax - latMin);
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  };

  function readKey(key) {
    if (storage) {
      try {
        return storage.getItem(key);
      } catch {
        storage = null;
      }
    }
    return key === DEMO_UID_KEY ? memoryUid : memoryRaw;
  }

  function writeKey(key, value) {
    if (key === DEMO_UID_KEY) memoryUid = value;
    else memoryRaw = value;
    if (storage) {
      try {
        storage.setItem(key, value);
      } catch (err) {
        console.warn('[medura demo] storage unavailable, continuing in memory', err);
        storage = null;
      }
    }
  }

  function load() {
    const raw = readKey(DEMO_STORAGE_KEY);
    if (!raw) return null;
    try {
      const db = JSON.parse(raw);
      return validDb(db) ? db : null;
    } catch {
      return null;
    }
  }

  function save(db) {
    writeKey(DEMO_STORAGE_KEY, JSON.stringify(db));
  }

  function seed() {
    const db = { ...emptyDb(), ...buildDemoSeed({ userId: uid, newId, newCode: randomCode }) };
    save(db);
    return db;
  }

  function ensureUid() {
    if (!uid) uid = readKey(DEMO_UID_KEY);
    if (!uid) {
      uid = newId();
      writeKey(DEMO_UID_KEY, uid);
    }
    return uid;
  }

  async function exec(fn, args, { mutating = true } = {}) {
    if (!initialized) await api.init();
    await sleep();
    if (!uid) throw new ApiError('not_authenticated');
    const db = load() || seed();
    const ctx = { db, uid, now: stamp, dirty: false, touched: new Set() };
    const out = fn(ctx, ...args);
    if (mutating && ctx.dirty) {
      save(db);
      if (ctx.touched.size) emit([...ctx.touched]);
    }
    return clone(out);
  }

  const call = (name, ...args) => exec(RPC[name], args);
  const read = (name, ...args) => exec(RPC[name], args, { mutating: false });

  const api = {
    mode: 'demo',

    async init() {
      if (initialized) return api;
      ensureUid();
      if (!load()) seed();
      hookStorage();
      initialized = true;
      return api;
    },

    async ensureSession() {
      if (!initialized) await api.init();
      return { userId: ensureUid() };
    },

    /** Synchronous: the demo user id (null before init on a fresh browser). */
    getUserId() {
      return uid || readKey(DEMO_UID_KEY) || null;
    },

    myTrips: () => read('my_trips'),
    createTrip: (trip, profile) => call('create_trip', trip, profile),
    previewInvite: (code) => read('preview_invite', code),
    joinTrip: (code, { claimMemberId, profile, person } = {}) => call('join_trip', code, claimMemberId ?? null, profile ?? null, person ?? null),
    linkDevice: (code) => call('link_device', code),
    getDeviceCode: (memberId) => call('get_device_code', memberId),

    getSnapshot: (tripId) => read('get_trip_snapshot', tripId),

    /** Fires onChange on same-tab mutations of the trip and on cross-tab storage changes. */
    subscribe(tripId, onChange) {
      hookStorage();
      if (!bus) return () => {};
      let active = true;
      const listener = (e) => {
        const ids = e.detail && e.detail.tripIds;
        if (!active || !(ids === '*' || (Array.isArray(ids) && ids.includes(tripId)))) return;
        try {
          onChange();
        } catch (err) {
          console.error('[medura demo] subscribe callback failed', err);
        }
      };
      bus.addEventListener('change', listener);
      return function unsubscribe() {
        active = false;
        bus.removeEventListener('change', listener);
      };
    },

    updateTrip: (tripId, patch) => call('update_trip', tripId, patch),
    rotateInvite: (tripId) => call('rotate_invite', tripId),
    deleteTrip: (tripId) => call('delete_trip', tripId),
    updateMember: (memberId, patch) => call('update_member', memberId, patch),
    createMember: (tripId, profile) => call('create_member', tripId, profile),
    setRole: (memberId, role) => call('set_role', memberId, role),
    removeMember: (memberId) => call('remove_member', memberId),
    leaveTrip: (tripId) => call('leave_trip', tripId),
    voteAdmin: (candidateId, on) => call('vote_admin', candidateId, Boolean(on)),

    upsertCategory: (tripId, cat) => call('upsert_category', tripId, cat),
    deleteCategory: (categoryId) => call('delete_category', categoryId),

    addItem: (tripId, item) => call('add_item', tripId, item),
    addItemsBulk: (tripId, items) => call('add_items_bulk', tripId, items),
    updateItem: (itemId, patch) => call('update_item', itemId, patch),
    reviewItem: (itemId, approve, reason) => call('review_item', itemId, Boolean(approve), reason ?? null),
    deleteItem: (itemId) => call('delete_item', itemId),

    pledge: (itemId, qty) => call('pledge', itemId, qty ?? 1),
    assign: (itemId, memberId, qty) => call('assign', itemId, memberId, qty ?? 1),
    setPledgeDone: (itemId, done) => call('set_pledge_done', itemId, Boolean(done)),
    setItemDone: (itemId, done) => call('set_item_done', itemId, Boolean(done)),

    addPersonal: (tripId, title) => call('add_personal', tripId, title),
    addPersonalTemplate: (tripId) => call('add_personal_template', tripId),
    updatePersonal: (id, patch) => call('update_personal', id, patch),
    deletePersonal: (id) => call('delete_personal', id),

    addExpense: (tripId, exp) => call('add_expense', tripId, exp),
    updateExpense: (id, patch) => call('update_expense', id, patch),
    deleteExpense: (id) => call('delete_expense', id),

    addPayment: (tripId, pay) => call('add_payment', tripId, pay),
    confirmPayment: (id) => call('confirm_payment', id),
    deletePayment: (id) => call('delete_payment', id),

    sendAnnouncement: (tripId, { title, body, audience, urgent, digest } = {}) =>
      call('send_announcement', tripId, title, body ?? null, Array.isArray(audience) && audience.length ? audience : null, Boolean(urgent), Boolean(digest)),
    deleteNotification: (id) => call('delete_notification', id),
    markRead: (tripId, ids) => call('mark_read', tripId, ids || []),

    createPoll: (tripId, { question, options, multi } = {}) => call('create_poll', tripId, question, options, Boolean(multi)),
    votePoll: (pollId, optionIds) => call('vote_poll', pollId, optionIds || []),
    closePoll: (pollId, closed) => call('close_poll', pollId, closed !== false),
    deletePoll: (pollId) => call('delete_poll', pollId),

    savePushSubscription: (tripId, sub) =>
      call('save_push_subscription', tripId, sub && typeof sub.toJSON === 'function' ? sub.toJSON() : sub),
    deletePushSubscription: (endpoint) => call('delete_push_subscription', endpoint),

    myEmail: () => read('my_email'),
    requestEmailCode: (email) => call('request_email_code', email).then((r) => ({ sent: true, ...r })),
    verifyEmailCode: (code) => call('verify_email_code', code),
    getMemberEmails: (memberId) => read('get_member_emails', memberId),
    memberDetails: (memberId) => read('member_details', memberId),
    setMemberEmails: (memberId, emails) => call('set_member_emails', memberId, emails || []),

    upsertRide: (tripId, ride) => call('upsert_ride', tripId, ride),
    deleteRide: (rideId) => call('delete_ride', rideId),
    takeSeat: (rideId, seats = 1) => call('take_seat', rideId, seats),
    leaveSeat: (tripId) => call('leave_seat', tripId),
    sendTestNotification: (tripId) => call('send_test_notification', tripId),
    linkByEmail: () => call('link_by_email'),
    setMyPerson: (tripId, person) => call('set_my_person', tripId, person),
    myAccount: () => read('my_account'),
    saveAccount: (patch) => call('save_account', patch),
    requestProfileJoin: (code, memberId, { person = null, name = null } = {}) => call('request_profile_join', code, memberId, person, name),
    cancelProfileRequest: (tripId) => call('cancel_profile_request', tripId),
    respondProfileRequest: (requestId, approve) => call('respond_profile_request', requestId, Boolean(approve)),
    pendingView: (tripId) => read('pending_view', tripId),
    inviteToRide: (rideId, memberId, seats = null) => call('invite_to_ride', rideId, memberId, seats),
    respondSeat: (rideId, memberId, approve) => call('respond_seat', rideId, memberId, Boolean(approve)),
    respondAssignment: (itemId, accept, reason = null) => call('respond_assignment', itemId, Boolean(accept), reason ?? null),

    /** Demo-only tools (the "🎭 החלף משתמש" control and E2E tests). */
    demo: {
      /** Wipe all demo data and re-seed the sample trip, owned by the current demo user. */
      async reset() {
        ensureUid();
        await sleep();
        seed();
        initialized = true;
        hookStorage();
        emit('*');
      },

      /** Re-link the current demo user to another member (of that member's trip). */
      actAs(memberId) {
        return exec(actAsMember, [memberId]);
      },

      /** Become a different person/device; a new id is created when none is given. */
      async switchUser(userId) {
        if (!initialized) await api.init();
        uid = typeof userId === 'string' && userId ? userId : newId();
        writeKey(DEMO_UID_KEY, uid);
        emit('*');
        return { userId: uid };
      },

      currentUserId() {
        return api.getUserId();
      },
    },
  };

  return api;
}
