// In-browser fake backend (SPEC §7.2 "Demo impl").
// Mirrors the SQL contract of SPEC §3–§5: same RPC semantics, permission rules, validations,
// error codes, system notifications, visibility rules and snapshot shape.
//
// Storage: the whole database lives as one JSON document in localStorage['medura:demo:v1'];
// the demo "auth user" id lives in localStorage['medura:demo:uid'].
// Every call loads a fresh copy, runs one RPC against it, and saves only on success —
// so a failed call never leaves partial changes behind (like a SQL transaction).

import { ApiError, flightFailure, flightInput } from './errors.js?v=56bbb9a';
import { balances, eachSplitOf, expenseShares, partyBalances, splitsItems, splitsMoney } from '../lib/logic.js?v=56bbb9a';
import {
  DEMO_VERSION,
  DEFAULT_CATEGORIES,
  DEFAULT_TRIP_INFO,
  DEFAULT_TRIP_SETTINGS,
  PERSONAL_TEMPLATE,
  addDaysYmd,
  buildDemoSeed,
  demoFlight,
  jerusalemYmd,
} from './demo-seed.js?v=56bbb9a';

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
  'user_contacts', 'email_codes', 'member_emails', 'rides', 'ride_seats', 'profile_requests', 'accounts', 'money_requests', 'money_request_members',
  'trip_invites', 'money_request_parts',
];

// Snapshot projections (SPEC §5) — the exact key sets.
const K = {
  trip: ['id', 'name', 'emoji', 'location', 'address', 'location_url', 'lat', 'lon', 'starts_at', 'ends_at', 'info', 'settings', 'invite_code', 'rev', 'created_at'],
  tripBrief: ['id', 'name', 'emoji', 'location', 'starts_at', 'ends_at'],
  memberBrief: ['id', 'display_name', 'emoji', 'color', 'role'],
  unclaimed: ['id', 'display_name', 'headcount', 'people', 'emoji', 'color'],
  category: ['id', 'name', 'emoji', 'sort', 'default_buyer_id', 'note'],
  item: ['id', 'category_id', 'title', 'note', 'type', 'qty', 'unit', 'per_person', 'needed', 'status', 'done', 'done_at', 'reject_reason', 'created_by', 'approved_by', 'sort', 'created_at', 'updated_at', 'due_at', 'by_person', 'each_qty'],
  pledge: ['id', 'item_id', 'member_id', 'qty', 'done', 'assigned_by', 'accepted_at', 'created_at', 'by_person', 'split', 'person_qty', 'done_people'],
  expense: ['id', 'title', 'amount', 'paid_by', 'category_id', 'note', 'split_mode', 'created_by', 'spent_on', 'created_at', 'currency', 'orig_amount', 'rate', 'tag', 'paid_by_person'],
  share: ['expense_id', 'member_id', 'weight'],
  payment: ['id', 'from_member', 'to_member', 'amount', 'method', 'note', 'status', 'created_by', 'created_at', 'confirmed_at', 'from_person', 'to_person'],
  notification: ['id', 'kind', 'title', 'body', 'audience', 'author_member', 'urgent', 'link', 'created_at', 'by_person'],
  read: ['notification_id', 'member_id', 'read_at'],
  vote: ['voter_id', 'candidate_id'],
  pollVote: ['poll_id', 'member_id', 'option_id', 'by_person'],
  personal: ['id', 'title', 'done', 'sort', 'created_at'],
  ride: ['id', 'driver_member', 'seats', 'from_text', 'depart_at', 'note', 'kind', 'to_text', 'created_at', 'from_lat', 'from_lon', 'to_lat', 'to_lon'],
  rideSeat: ['ride_id', 'member_id', 'seats', 'status', 'requested_by'],
  profileRequest: ['id', 'member_id', 'name', 'person', 'email', 'merging', 'created_at'],
  moneyRequest: ['id', 'requested_by', 'title', 'note', 'due', 'methods', 'status', 'created_at', 'expense_id', 'self_amount', 'linked_expense', 'by_person', 'pot'],
  moneyRequestMember: ['request_id', 'member_id', 'amount', 'payment_id'],
  moneyRequestPart: ['request_id', 'member_id', 'person', 'amount', 'payment_id'],
  invite: ['id', 'name', 'member_id', 'invited_by', 'invited_by_name', 'created_at', 'email_hint'],
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
/** The profile holds rights (owner/admin). Who of its people/devices uses them: personAdmin(). */
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
  if (has(p, 'address')) out.address = optText(p.address, 200);
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
    // a row may say which day of the trip it is (1..60); without it, time order decides
    if (v.schedule.some((r) => r.day != null && !(Number.isInteger(r.day) && r.day >= 1 && r.day <= 60))) bad();
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

const SETTINGS_KEYS = ['require_approval', 'type', 'subtype', 'where', 'custom', 'modules', 'arrival', 'money'];
const ARRIVAL_MODE_KEYS = ['car', 'taxi', 'meet', 'own', 'drop', 'transit', 'park'];

function settingsVal(v) {
  reqObj(v);
  // like SQL (settings || patch): keys this backend doesn't know are kept as they are
  const out = Object.fromEntries(Object.entries(v).filter(([k, x]) => !SETTINGS_KEYS.includes(k) && x !== undefined));
  if (given(v, 'require_approval')) out.require_approval = toBool(v.require_approval);
  if (given(v, 'type')) {
    if (typeof v.type !== 'string' || !/^[a-z_]{1,20}$/.test(v.type)) bad();
    out.type = v.type;
  }
  // family sub-type (type = the family), in Israel or abroad, and a custom sub-type's own name
  if (has(v, 'subtype')) {
    if (v.subtype !== null && (typeof v.subtype !== 'string' || !/^[a-z_]{1,20}$/.test(v.subtype))) bad();
    out.subtype = v.subtype;
  }
  if (has(v, 'where')) {
    if (v.where !== null && !['il', 'abroad'].includes(v.where)) bad();
    out.where = v.where;
  }
  if (has(v, 'custom')) {
    const c = v.custom;
    if (c !== null) {
      if (!isObj(c)) bad();
      if (has(c, 'label') && (typeof c.label !== 'string' || cpLen(c.label.trim()) < 1 || cpLen(c.label.trim()) > 30)) bad();
      if (given(c, 'emoji') && (typeof c.emoji !== 'string' || cpLen(c.emoji) > 8)) bad();
    }
    out.custom = c === null ? null : { ...c };
  }
  if (given(v, 'modules')) {
    if (!isObj(v.modules) || !Object.values(v.modules).every((x) => typeof x === 'boolean')) bad();
    out.modules = { ...v.modules };
  }
  if (given(v, 'arrival')) {
    const a = v.arrival;
    if (!isObj(a)) bad();
    if (given(a, 'modes') && (!Array.isArray(a.modes) || !a.modes.every((m) => ARRIVAL_MODE_KEYS.includes(m)))) bad();
    if (given(a, 'flights') && typeof a.flights !== 'boolean') bad();
    // the airport the group flies from (IATA; the client defaults to TLV)
    if (given(a, 'airport') && (typeof a.airport !== 'string' || !/^[A-Z]{3}$/.test(a.airport))) bad();
    out.arrival = { ...a };
  }
  if (given(v, 'money')) {
    const m = v.money;
    if (!isObj(m)) bad();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (given(m, 'exempt') && (!Array.isArray(m.exempt) || m.exempt.length > 50 || !m.exempt.every((x) => typeof x === 'string' && uuid.test(x)))) bad();
    if (given(m, 'currencies') && (!Array.isArray(m.currencies) || m.currencies.length > 6 || !m.currencies.every((x) => typeof x === 'string' && /^[A-Z]{3}$/.test(x)))) bad();
    // expense tags of this trip type: [{e: emoji, n: name}]
    if (given(m, 'tags') && (!Array.isArray(m.tags) || m.tags.length > 12 || !m.tags.every((t) => isObj(t)
        && typeof t.n === 'string' && cpLen(t.n.trim()) >= 1 && cpLen(t.n.trim()) <= 20
        && (t.e == null || (typeof t.e === 'string' && cpLen(t.e) <= 8))))) bad();
    out.money = { ...m };
  }
  return jsonSize(out, 4000);
}

/** Ride end points picked from the map: only the keys given; null clears; lat ±90, lon ±180. */
function rideCoords(ride) {
  const out = {};
  for (const [k, max] of [['from_lat', 90], ['from_lon', 180], ['to_lat', 90], ['to_lon', 180]]) {
    if (!has(ride, k)) continue;
    if (ride[k] === null || ride[k] === '') {
      out[k] = null;
      continue;
    }
    const n = toNumber(ride[k]);
    if (n < -max || n > max) bad();
    out[k] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Flights (design §4): fixtures instead of AeroDataBox — no network, ever.
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' of a booking / travel leg ({date} or the date part of {at}), or null. */
function legDate(x) {
  const d = typeof x?.date === 'string' && x.date ? x.date : typeof x?.at === 'string' ? x.at : '';
  return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}

/** Distinct flights a trip watches: the group's bookings + members' prefs.travel.{out,back}. */
function watchedFlights(db, tripId) {
  const trip = byId(db.trips, tripId);
  const keys = new Map();
  const add = (leg) => {
    const input = leg && flightInput(leg.flight, legDate(leg));
    if (input) keys.set(`${input.number}|${input.date}`, input);
  };
  for (const b of Array.isArray(trip?.info?.bookings) ? trip.info.bookings : []) if (b?.kind === 'flight') add(b);
  for (const m of membersOf(db, tripId)) {
    add(m.prefs?.travel?.out);
    add(m.prefs?.travel?.back);
  }
  return [...keys.values()].sort((a, b) => cmp(a.date, b.date) || cmp(a.number, b.number));
}

/** snapshot.flights: the "cache rows" of the watched flights (fixtures only; others have no row yet). */
function snapshotFlights(ctx, tripId) {
  const now = new Date(ctx.now());
  const checked = new Date(now.getTime() - 12 * 60e3).toISOString();
  return watchedFlights(ctx.db, tripId)
    .map((k) => ({ number: k.number, date: k.date, data: demoFlight(k.number, k.date, now), checked_at: checked }))
    .filter((r) => r.data);
}

function profileFields(p, creating) {
  reqObj(p);
  const out = {};
  if (creating || given(p, 'display_name')) out.display_name = reqText(p.display_name, 1, 40);
  if (given(p, 'headcount')) out.headcount = toInt(p.headcount, 1, 8);
  if (has(p, 'people')) out.people = [...new Set(textList(p.people, 8, 40))]; // names are keys: no duplicates
  if (given(p, 'emoji')) out.emoji = reqText(p.emoji, 1, 16);
  if (given(p, 'color')) out.color = colorVal(p.color);
  if (has(p, 'phone')) out.phone = phoneVal(p.phone);
  if (given(p, 'prefs')) {
    out.prefs = jsonSize(reqObj(p.prefs), 8000);
    // how a couple settles / brings (SPEC §19): 'together' | 'each'
    for (const k of ['pay', 'bring']) if (has(p.prefs, k) || (isObj(p.prefs) && k in p.prefs)) oneOf(p.prefs[k], ['together', 'each']);
  }
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

// ---- admin per person (SQL _person_admin / _my_role / _is_admin / _admin_devices) ----
// members.admin_people: null = all of the profile's people and devices hold its rights; a list = only
// those people (plus its `legacy` devices that never said who they are).

/** SQL _person_admin(role, admin_people, person, legacy). */
function personAdminOf(role, admins, person, legacy) {
  return (role === 'owner' || role === 'admin')
    && (admins == null || (person != null && admins.includes(person)) || (person == null && Boolean(legacy)));
}

/** Does this device (link) of profile `m` hold the profile's rights? */
function personAdmin(m, link) {
  return !!m && !!link && personAdminOf(m.role, m.admin_people ?? null, link.person ?? null, link.legacy);
}

function myLink(db, tripId, uid) {
  return db.member_users.find((l) => l.user_id === uid && l.trip_id === tripId) || null;
}

const linksOf = (db, memberId) => db.member_users.filter((l) => l.member_id === memberId);

/** SQL _my_role: this device's effective role in the trip (null when not a member). */
function myRole(ctx, tripId) {
  const link = myLink(ctx.db, tripId, ctx.uid);
  const m = link ? byId(ctx.db.members, link.member_id) : null;
  if (!m) return null;
  return personAdmin(m, link) ? m.role : 'member';
}

/** SQL _is_admin: this device (not just its profile) holds owner/admin rights. */
function amAdmin(ctx, me) {
  return !!me && personAdmin(me, myLink(ctx.db, me.trip_id, ctx.uid));
}

/** SQL _actor_name: whoever acts on this device — its person (one of a couple / family), else the profile's name. */
function actorName(ctx, me) {
  const p = me ? myLink(ctx.db, me.trip_id, ctx.uid)?.person : null;
  return (typeof p === 'string' && p.trim()) || me?.display_name || '';
}

// SQL trigger _stamp_person: a new item / pledge / notification / money request remembers which person of the
// acting device's profile did it (by_person) — "נוסף ע״י נועה", not "נועה ואיתי".
const STAMPED = ['items', 'pledges', 'notifications', 'money_requests', 'poll_votes', 'personal_items'];
const rowKey = (r) => r.id ?? `${r.poll_id}:${r.member_id}:${r.option_id}`;   // poll votes have no id
function stampKnown(db) {
  return new Set(STAMPED.flatMap((t) => (db[t] || []).map(rowKey)));
}
function stampPerson(db, uid, known) {
  for (const t of STAMPED) {
    for (const r of db[t] || []) {
      if (known.has(rowKey(r)) || r.by_person !== undefined) continue;
      r.by_person = db.member_users.find((l) => l.user_id === uid && l.trip_id === r.trip_id)?.person ?? null;
    }
  }
}

/** A personal-list row is this device's: its person's, or the profile's shared one from before (by_person null). */
function mineByPerson(row, person) {
  return row.by_person == null || !person || row.by_person === person;
}

/** A read row counts for this device: my profile's, and read by my person (or by the whole profile). */
function readByMe(r, me, person) {
  if (r.member_id !== me.id) return true;
  return !Array.isArray(r.persons) || !person || r.persons.includes(person);
}

/** SQL _exempt_ids: the trip's exempt profiles (settings.money.exempt). */
function exemptIds(db, tripId) {
  const ex = db.trips.find((t) => t.id === tripId)?.settings?.money?.exempt;
  return new Set(Array.isArray(ex) ? ex : []);
}

/** SQL _admin_devices: how many devices of the trip hold admin rights. */
function adminDevices(db, tripId) {
  return db.member_users.filter((l) => l.trip_id === tripId && personAdmin(byId(db.members, l.member_id), l)).length;
}

const hasAdminDevice = (db, m) => linksOf(db, m.id).some((l) => personAdmin(m, l));
/** How many devices of profile `m` hold its rights (SQL: count of _person_admin over its member_users). */
const rightsDevices = (db, m) => linksOf(db, m.id).filter((l) => personAdmin(m, l)).length;

/** I5: a call that removes rights may not leave the trip without an admin device. */
function assertAdminLeft(db, tripId, had) {
  if (had && adminDevices(db, tripId) === 0) fail('last_admin');
}

/** The profile's people (each once, in their order) that pass `keep` — how admin lists are kept. */
const peopleWhere = (m, keep) => (m.people || []).filter((p, i, all) => all.indexOf(p) === i && keep(p));

/** A profile loses its rights: role member, no list, no legacy devices (I3). */
function demote(db, m) {
  m.role = 'member';
  m.admin_people = null;
  for (const l of linksOf(db, m.id)) l.legacy = false;
}

/**
 * SQL _freeze_admins: before a profile's rights narrow (someone steps in, a crown changes), today's holders are
 * written down — the people with a device (not `without`) — and its unidentified devices keep theirs (legacy).
 */
function freezeAdmins(db, m, without = null) {
  if (!isAdmin(m)) return;
  if (m.admin_people == null) {
    const links = linksOf(db, m.id);
    for (const l of links) if (l.person != null && !(m.people || []).includes(l.person)) l.person = null; // a stale name
    for (const l of links) if (l.person == null) l.legacy = true;
    m.admin_people = (m.people || []).filter((p) => p !== without && links.some((l) => l.person === p));
  } else if (without != null) {
    m.admin_people = m.admin_people.filter((p) => p !== without);
  }
}

/** SQL _release_person: a person with no device left drops off the list; an admin profile nobody can use is demoted. */
function releasePerson(db, m, person) {
  if (!m) return;
  if (person != null && m.admin_people != null && !linksOf(db, m.id).some((l) => l.person === person)) {
    m.admin_people = m.admin_people.filter((p) => p !== person);
  }
  if (m.role === 'admin' && m.admin_people != null && !hasAdminDevice(db, m)) demote(db, m);
}

/** SQL _release_member: a profile with no devices is free to claim again — without any rights. */
function releaseMember(db, m) {
  m.claimed_at = null;
  m.role = 'member';
  m.admin_people = null;
  remove(db.member_secrets, (s) => s.member_id === m.id);
}

/** After a user link was removed: a member with no linked users becomes claimable again. */
function releaseIfOrphan(db, m) {
  if (m && !linksOf(db, m.id).length) releaseMember(db, m);
}

/**
 * SQL _ensure_owner (I4): when the owner profile has no device that can act, the admin profile that can
 * (claimed first) becomes the owner and the old owner profile a member. No heir → unchanged (callers check I5).
 */
function ensureOwner(db, tripId) {
  const members = membersOf(db, tripId);
  const owner = members.find((m) => m.role === 'owner');
  if (owner && hasAdminDevice(db, owner)) return;
  const heir = members
    .filter((m) => m.role === 'admin' && hasAdminDevice(db, m))
    // SQL: order by claimed_at nulls last, created_at, id
    .sort((a, b) => (a.claimed_at == null) - (b.claimed_at == null) || cmp(a.claimed_at, b.claimed_at)
      || cmp(a.created_at, b.created_at) || cmp(a.id, b.id))[0];
  if (!heir) return;
  if (owner) demote(db, owner);
  heir.role = 'owner';
}

function requireAdmin(ctx, tripId) {
  const me = requireMember(ctx, tripId);
  if (!amAdmin(ctx, me)) fail('forbidden');
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

function notify(ctx, tripId, { title, body = null, audience = null, link = null, kind = 'system' }) {
  ctx.db.notifications.push({
    id: newId(),
    trip_id: tripId,
    kind,
    title: clip(title, 80),
    body: body ? clip(body, 2000) : null,
    audience,
    author_member: null,
    urgent: false,
    link,
    created_at: ctx.now(),
  });
}

/** `admin`: this device holds admin rights (amAdmin), like RLS's _is_admin. */
function canSeeNotification(n, me, admin) {
  return (
    n.audience == null ||
    n.audience.includes(me.id) ||
    n.author_member === me.id ||
    (n.kind === 'announcement' && admin)
  );
}

function canSeeItem(item, me, admin) {
  return item.status !== 'rejected' || admin || item.created_by === me.id;
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
    admin_people: null,
    phone: prof.phone ?? null,
    prefs: prof.prefs ?? {},
    inventory: prof.inventory ?? [],
    claimed_at: claimed ? now : null,
    created_at: now,
  };
}

/** A device link (member_users row): which person it is, `legacy` (holds rights unidentified), last seen. */
function linkUser(ctx, tripId, memberId, person = null, legacy = false) {
  ctx.db.member_users.push({
    user_id: ctx.uid, trip_id: tripId, member_id: memberId, person, legacy, last_seen_at: null, created_at: ctx.now(),
  });
}

/**
 * SQL _apply_member_patch for `people`: names are deduplicated (profileFields); a name that disappeared is
 * paired, in order, with one that appeared (a rename) — its devices, admin crown and pending requests follow;
 * a name gone with no pair leaves its devices unidentified (and loses the crown).
 */
function patchMember(db, m, f) {
  const before = m.people || [];
  applyProfile(m, f);
  if (!('people' in f)) return;
  const after = m.people || [];
  const gone = before.filter((p, i) => before.indexOf(p) === i && !after.includes(p));
  const added = after.filter((p) => !before.includes(p));
  gone.forEach((old, i) => {
    const links = linksOf(db, m.id).filter((l) => l.person === old);
    if (i < added.length) {
      const name = added[i];
      for (const l of links) l.person = name;
      if (m.admin_people) m.admin_people = m.admin_people.map((p) => (p === old ? name : p));
      for (const r of db.profile_requests) {
        if (r.member_id === m.id && r.status === 'pending' && r.person === old) {
          r.person = name;
          r.name = name;
        }
      }
      // what they paid / brought / owe per person (SPEC §19) is still theirs
      for (const e of db.expenses) if (e.paid_by === m.id && e.paid_by_person === old) e.paid_by_person = name;
      for (const y of db.payments) {
        if (y.from_member === m.id && y.from_person === old) y.from_person = name;
        if (y.to_member === m.id && y.to_person === old) y.to_person = name;
      }
      for (const pl of db.pledges.filter((x) => x.member_id === m.id)) {
        if (pl.person_qty && old in pl.person_qty) {
          const { [old]: q, ...rest } = pl.person_qty;
          pl.person_qty = { ...rest, [name]: q };
        }
        if (pl.done_people) pl.done_people = pl.done_people.map((n) => (n === old ? name : n));
      }
      for (const pt of db.money_request_parts) if (pt.member_id === m.id && pt.person === old) pt.person = name;
    } else {
      for (const l of links) {
        l.person = null;
        l.legacy = false;
      }
      releasePerson(db, m, old);
    }
  });
}

/** How someone likes to get paid: {bit, paybox, bank: text, cash: true}. */
function payMethods(p) {
  if (p == null) return {};
  if (!isObj(p)) bad();
  const out = {};
  for (const k of ['bit', 'paybox', 'bank']) {
    const v = typeof p[k] === 'string' ? p[k].trim() : '';
    if (v) {
      if (cpLen(v) > 160) bad();
      out[k] = v;
    }
  }
  if (p.cash === true) out.cash = true;
  return out;
}

/** After a confirmation: every share of its request paid and confirmed → closed, the requester told. */
/** SQL _module_on: a trip's feature is on unless switched off (settings.modules.<key> = false). */
const moduleOn = (trip, key) => trip?.settings?.modules?.[key] !== false;

/**
 * SQL _module_gaps: who is still missing per tracked feature that's on, over the profiles someone is in —
 * [{key, done, total, missing: [member ids]}] (rides, flights, polls, lists, money, rooms; only where
 * there's something to follow).
 */
function moduleGaps(db, tripId) {
  const trip = byId(db.trips, tripId);
  const out = [];
  if (!trip) return out;
  const inIds = membersOf(db, tripId).sort(byCreated).filter((m) => db.member_users.some((l) => l.member_id === m.id));
  const total = inIds.length;
  if (!total) return out;
  const row = (key, missing, tot = total) => out.push({ key, total: tot, done: tot - missing.length, missing: missing.map((m) => (typeof m === 'string' ? m : m.id)) });
  const inTrip = (r) => r.trip_id === tripId;
  if (moduleOn(trip, 'rides')) {
    row('rides', inIds.filter((m) => !m.prefs?.transport?.mode
      && !db.rides.some((r) => r.driver_member === m.id) && !db.ride_seats.some((s) => s.member_id === m.id)));
  }
  const bookings = Array.isArray(trip.info?.bookings) ? trip.info.bookings : [];
  if (moduleOn(trip, 'rides') && trip.settings?.arrival?.flights === true && !bookings.some((b) => b?.kind === 'flight' && b.flight)) {
    row('flights', inIds.filter((m) => !m.prefs?.travel?.out?.flight));
  }
  const open = db.polls.filter((pl) => inTrip(pl) && !pl.closed);
  if (moduleOn(trip, 'polls') && open.length) {
    row('polls', inIds.filter((m) => open.some((pl) => !db.poll_votes.some((v) => v.poll_id === pl.id && v.member_id === m.id))));
  }
  // the participant's own rule: something of a feature that's on waits for someone; took nothing of one
  const itemOn = (i) => moduleOn(trip, i.type === 'task' ? 'tasks' : 'lists');
  const items = db.items.filter((i) => inTrip(i) && i.status === 'active');
  if (items.some((i) => ['buy', 'bring', 'task'].includes(i.type) && itemOn(i) && !db.pledges.some((p) => p.item_id === i.id))) {
    row('lists', inIds.filter((m) => !db.pledges.some((p) => p.member_id === m.id
      && db.items.some((i) => i.id === p.item_id && itemOn(i)))));
  }
  if (moduleOn(trip, 'money')) {
    const shares = db.money_request_members.filter((x) => {
      const q = db.money_requests.find((r) => r.id === x.request_id);
      return q && q.trip_id === tripId && q.status === 'open' && x.member_id !== q.requested_by && inIds.some((m) => m.id === x.member_id);
    });
    const owing = [...new Set(shares.map((x) => x.member_id))];
    if (owing.length) {
      const missing = [...new Set(shares.filter((x) => {
        const q = db.money_requests.find((r) => r.id === x.request_id);
        return !x.payment_id && (!q.expense_id || memberBalance(db, tripId, x.member_id) < -1);
      }).map((x) => x.member_id))];
      row('money', missing, owing.length);
    }
  }
  const rooms = Array.isArray(trip.info?.rooms) ? trip.info.rooms : [];
  if (moduleOn(trip, 'rooms') && rooms.length) {
    const placed = new Set(rooms.flatMap((r) => (Array.isArray(r?.members) ? r.members : [])));
    row('rooms', inIds.filter((m) => !placed.has(m.id)));
  }
  return out;
}

const NUDGE = {
  rides: ['🚗 איך מגיעים? לחיצה אחת', 'נוהגים · צריכים מקום · באים לבד', '/rides'],
  flights: ['✈️ איזו טיסה שלך?', 'מסמנים — ונדע מי טס עם מי', '/rides'],
  polls: ['📊 מחכים לקול שלך', 'עוד לא הצבעת · לוקח שנייה', '/messages'],
  lists: ['🤲 יש דברים שמחכים למישהו', 'עוד לא לקחת כלום', '/lists'],
  money: ['💰 בקשת תשלום מחכה לך', 'פרטי העברה בלחיצה', '/money'],
};

/** A member's balance, the way the settle-up (logic.js balances) and the server's _member_balance count it. */
function memberBalance(db, tripId, memberId) {
  const inTrip = (r) => r.trip_id === tripId;
  const snap = {
    trip: db.trips.find((x) => x.id === tripId), members: db.members.filter(inTrip), expenses: db.expenses.filter(inTrip),
    expense_shares: db.expense_shares.filter(inTrip), payments: db.payments.filter(inTrip),
    money_requests: db.money_requests.filter(inTrip), money_request_members: db.money_request_members.filter(inTrip),
    money_request_parts: db.money_request_parts.filter(inTrip),
  };
  return balances(snap).find((b) => b.member_id === memberId)?.balance ?? 0;
}

/** A payment A→R also covers A's unpaid shares on R's open "already paid" requests (oldest first; ₪1 slack). */
function linkPaymentToRequests(ctx, pay) {
  const { db } = ctx;
  if (pay.from_member === pay.to_member) return;
  let left = Number(pay.amount) + 1;
  const reqs = db.money_requests
    .filter((q) => q.trip_id === pay.trip_id && q.status === 'open' && q.expense_id && q.requested_by === pay.to_member)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  for (const q of reqs) {
    const x = db.money_request_members.find((r) => r.request_id === q.id && r.member_id === pay.from_member && !r.payment_id);
    if (!x) continue;
    const parts = partsOf(db, q.id, pay.from_member);
    if (parts.length) {
      // from one person of a couple that pays each their own part (§19): that person's part
      const own = pay.from_person ? parts.find((pt) => pt.person === pay.from_person) : null;
      const take = own ? (own.payment_id ? [] : [own]) : parts.filter((pt) => !pt.payment_id);
      if (!take.length) continue;
      const amt = take.reduce((n, pt) => n + Number(pt.amount), 0);
      if (amt > left) break;
      for (const pt of take) pt.payment_id = pay.id;
      settleRequestRow(db, q.id, pay.from_member, pay.id);
      left -= amt;
      continue;
    }
    if (Number(x.amount) > left) break;
    x.payment_id = pay.id;
    left -= Number(x.amount);
  }
  coverIfEven(ctx, pay);
}

/** "Even" the way the server says it: the balance rounded to whole shekels (half away from zero) is ≥ −₪1. */
const isEven = (balance) => Math.sign(balance) * Math.round(Math.abs(balance)) >= -1;

/** SQL _in_pot: money collected on a request whose purchase isn't recorded yet (not a collection from before the
 *  pot rule — pot === false — whose payments count in the balances as they always did). */
function inPot(db, paymentId) {
  return [...db.money_request_members, ...db.money_request_parts].some((x) => x.payment_id === paymentId
    && db.money_requests.some((q) => q.id === x.request_id && !q.expense_id && q.pot !== false));
}

/**
 * SQL _cover_if_even — the settle-up's net transfer: when the payer (that person, in a couple that pays each their
 * own part) is even after a payment (≥ −₪1), it also covers whatever they still owe on the receiver's open
 * "already paid" requests, whatever the amounts (a ₪1,500 share settled with a ₪1,041 net transfer is paid).
 */
function coverIfEven(ctx, pay) {
  const { db } = ctx;
  if (pay.from_member === pay.to_member || inPot(db, pay.id)) return;
  if (!isEven(partyBalance(db, pay.trip_id, pay.from_member, pay.from_person))) return;
  const reqs = db.money_requests
    .filter((q) => q.trip_id === pay.trip_id && q.status === 'open' && q.expense_id && q.requested_by === pay.to_member)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  for (const q of reqs) {
    const x = db.money_request_members.find((r) => r.request_id === q.id && r.member_id === pay.from_member && !r.payment_id);
    if (!x) continue;
    const parts = partsOf(db, q.id, pay.from_member);
    if (parts.length) {
      const own = pay.from_person ? parts.find((pt) => pt.person === pay.from_person) : null;
      for (const pt of own ? [own] : parts) if (!pt.payment_id) pt.payment_id = pay.id;
      settleRequestRow(db, q.id, pay.from_member, pay.id);
    } else x.payment_id = pay.id;
  }
}

/** After a confirmation: the requests of that payment — and (SQL _close_money_request_if_done) every open "already
 *  paid" request of the trip, whose shares the settle-up may have covered meanwhile. */
function closeMoneyRequestIfDone(ctx, paymentId) {
  const { db } = ctx;
  const tripId = db.payments.find((y) => y.id === paymentId)?.trip_id;
  const linked = new Set([...db.money_request_members, ...db.money_request_parts].filter((r) => r.payment_id === paymentId).map((r) => r.request_id));
  const open = db.money_requests.filter((q) => q.status === 'open' && (linked.has(q.id) || (q.expense_id && q.trip_id === tripId)))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  for (const q of open) closeOneMoneyRequest(ctx, q);
}

/** SQL _money_request_done: every share paid and confirmed (a couple's: every part) — or, on an "already paid"
 *  request, not paid here but covered by the settle-up (that profile / person is even, ≥ −₪1). */
function moneyRequestDone(db, q) {
  const confirmed = (r) => Boolean(r.payment_id) && db.payments.find((y) => y.id === r.payment_id)?.status === 'confirmed';
  return db.money_request_members.filter((r) => r.request_id === q.id).every((r) => {
    const parts = partsOf(db, q.id, r.member_id);
    if (parts.length) {
      return parts.every((pt) => confirmed(pt)
        || (!pt.payment_id && Boolean(q.expense_id) && isEven(partyBalance(db, q.trip_id, pt.member_id, pt.person))));
    }
    return confirmed(r) || (!r.payment_id && Boolean(q.expense_id) && isEven(memberBalance(db, q.trip_id, r.member_id)));
  });
}

function closeOneMoneyRequest(ctx, q) {
  const { db } = ctx;
  if (!q || !moneyRequestDone(db, q)) return;
  q.status = 'closed';
  notify(ctx, q.trip_id, {
    title: `🎉 כולם שילמו על ${q.title}`,
    body: q.expense_id ? 'הבקשה נסגרה' : 'אחרי הקנייה — רושמים הוצאה 🧾',
    audience: [q.requested_by], link: `#/t/${q.trip_id}/money`,
  });
}

function joinedPeople(db, memberId) {
  return [...new Set(db.member_users.filter((l) => l.member_id === memberId && l.person).map((l) => l.person))];
}

// ---- couples & families inside one profile (SQL §19: _person_of, _each_recompute, _each_mode_changed,
// _build_request_parts, _sync_request_parts, _settle_request_row, _request_row_paid, _party_balance) ----

/** One of the profile's people (a name it has now), else null. */
function personOf(m, person) {
  return person != null && (m?.people || []).includes(person) ? person : null;
}

/** This device's person in `me`'s profile (a name it still has), else null. */
function myPersonIn(ctx, me) {
  return personOf(me, myLink(ctx.db, me.trip_id, ctx.uid)?.person ?? null);
}

/** SQL _party_name: the person when their profile pays each their own part, else the profile's name. */
function partyNameOf(m, person) {
  return person && personOf(m, person) && splitsMoney(m) ? person : m?.display_name ?? '';
}

/** SQL _each_fill: the open units go to the first of the profile's people. */
function eachFill(map, m, target) {
  const names = m.people || [];
  if (!names.length) return map;
  const sum = Object.values(map).reduce((a, b) => a + b, 0);
  return { ...map, [names[0]]: (map[names[0]] || 0) + Math.max(0, target - sum) };
}

/** SQL _each_recompute: a split row's profile-level done; person_qty re-normalized, done_people only its names. */
function eachRecompute(db, pledge) {
  const item = byId(db.items, pledge.item_id);
  const m = byId(db.members, pledge.member_id);
  if (!item || !m || item.type !== 'each' || !splitsItems(m, pledge)) return;
  const s = eachSplitOf(item, m, pledge);
  pledge.done = s.open === 0 && s.parts.every((x) => x.qty === 0 || x.done);
  if (pledge.person_qty != null) pledge.person_qty = Object.fromEntries(s.parts.map((x) => [x.person, x.qty]));
  pledge.done_people = (pledge.done_people || []).filter((n) => (m.people || []).includes(n));
}

/** SQL _each_mode_changed: a row packed together that is now split stays packed. */
function eachModeChanged(db, pledge, wasSplit) {
  const item = byId(db.items, pledge.item_id);
  const m = byId(db.members, pledge.member_id);
  if (item && m && item.type === 'each' && splitsItems(m, pledge) && !wasSplit && pledge.done) {
    const s = eachSplitOf(item, m, pledge);
    pledge.person_qty = eachFill(Object.fromEntries(s.parts.map((x) => [x.person, x.qty])), m, s.target);
    pledge.done_people = [...(m.people || [])];
  }
  eachRecompute(db, pledge);
}

/** A money request's rows of a profile that pays each their own part: one part per person (agorot to the first). */
function buildRequestParts(db, requestId, memberId) {
  const m = byId(db.members, memberId);
  const x = db.money_request_members.find((r) => r.request_id === requestId && r.member_id === memberId);
  if (!x || !splitsMoney(m)) return;
  const names = m.people;
  const cents = Math.round(Number(x.amount) * 100);
  names.forEach((person, i) => {
    const share = Math.floor(cents / names.length) + (i < cents % names.length ? 1 : 0);
    if (share > 0 && !db.money_request_parts.some((pt) => pt.request_id === requestId && pt.member_id === memberId && pt.person === person)) {
      db.money_request_parts.push({ request_id: requestId, trip_id: x.trip_id, member_id: memberId, person, amount: share / 100, payment_id: null });
    }
  });
}

const partsOf = (db, requestId, memberId) => db.money_request_parts.filter((pt) => pt.request_id === requestId && pt.member_id === memberId);

/** SQL _sync_request_parts: open rows with nothing paid are rebuilt; a gone name's unpaid part moves to who hasn't paid. */
function syncRequestParts(db, memberId) {
  const m = byId(db.members, memberId);
  if (!m) return;
  for (const x of db.money_request_members.filter((r) => r.member_id === memberId && !r.payment_id)) {
    const q = byId(db.money_requests, x.request_id);
    if (!q || q.status !== 'open') continue;
    const parts = partsOf(db, x.request_id, memberId);
    if (!parts.some((pt) => pt.payment_id)) {
      remove(db.money_request_parts, (pt) => pt.request_id === x.request_id && pt.member_id === memberId);
      buildRequestParts(db, x.request_id, memberId);
      continue;
    }
    const people = m.people || [];
    const gone = parts.filter((pt) => !pt.payment_id && !people.includes(pt.person));
    const stay = parts.filter((pt) => !pt.payment_id && people.includes(pt.person))
      .sort((a, b) => people.indexOf(a.person) - people.indexOf(b.person));
    const cents = gone.reduce((n, pt) => n + Math.round(Number(pt.amount) * 100), 0);
    if (!(cents > 0) || !stay.length) continue;
    remove(db.money_request_parts, (pt) => gone.includes(pt));
    stay.forEach((pt, i) => {
      pt.amount = Math.round(Number(pt.amount) * 100 + Math.floor(cents / stay.length) + (i < cents % stay.length ? 1 : 0)) / 100;
    });
  }
}

/** SQL _settle_request_row: the row is paid once its last part is (to that payment). */
function settleRequestRow(db, requestId, memberId, paymentId) {
  const x = db.money_request_members.find((r) => r.request_id === requestId && r.member_id === memberId);
  if (x && !x.payment_id && !partsOf(db, requestId, memberId).some((pt) => !pt.payment_id)) x.payment_id = paymentId;
}

/** SQL _request_row_paid: the whole row, or the parts paid so far. */
function requestRowPaid(db, x) {
  if (x.payment_id) return Number(x.amount);
  return partsOf(db, x.request_id, x.member_id).filter((pt) => pt.payment_id).reduce((n, pt) => n + Number(pt.amount), 0);
}

/** SQL _party_balance: one person's balance in a profile that pays each their own part (else the profile's). */
function partyBalance(db, tripId, memberId, person) {
  const m = byId(db.members, memberId);
  const key = person && personOf(m, person) && splitsMoney(m) ? `${memberId}::${person}` : memberId;
  const inTrip = (r) => r.trip_id === tripId;
  const snap = {
    trip: db.trips.find((x) => x.id === tripId), members: db.members.filter(inTrip), expenses: db.expenses.filter(inTrip),
    expense_shares: db.expense_shares.filter(inTrip), payments: db.payments.filter(inTrip),
    money_requests: db.money_requests.filter(inTrip), money_request_members: db.money_request_members.filter(inTrip),
    money_request_parts: db.money_request_parts.filter(inTrip),
  };
  return partyBalances(snap).find((b) => b.key === key)?.balance ?? 0;
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
  if (has(p, 'due_at')) out.due_at = p.due_at == null || p.due_at === '' ? null : timestampVal(p.due_at);
  // "כל אחד מביא": how many per couple / family (SPEC §19)
  if (has(p, 'each_qty')) out.each_qty = p.each_qty === null ? null : toInt(p.each_qty, 1, 20);
  return out;
}

function pledgeQtyVal(p) {
  return given(p, 'pledge_qty') ? toInt(p.pledge_qty, -1000000, 200) : 0;
}

function insertItem(ctx, trip, me, f, pledgeQty, sort) {
  const admin = amAdmin(ctx, me);
  const auto = trip.settings?.require_approval === false || admin;
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
    approved_by: auto && admin ? me.id : null,
    sort,
    created_at: now,
    updated_at: now,
    due_at: f.due_at ?? null,
    each_qty: f.type === 'each' ? f.each_qty ?? null : null,
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
  if (isObj(p) && 'paid_by_person' in p) out.paid_by_person = p.paid_by_person == null ? null : reqText(p.paid_by_person, 1, 40);
  if (has(p, 'category_id')) out.category_id = categoryRef(db, tripId, p.category_id);
  if (has(p, 'note')) out.note = optText(p.note, 500);
  if (has(p, 'tag')) out.tag = optText(p.tag, 20); // a light per-trip-type tag ("טיסות"); balances ignore it
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
      if (weight <= 0 || weight > 1000000) bad();
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

/** date_trunc('minute', ts) as an ISO string (presence is shown to the minute, no finer). */
function toMinute(iso) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(Math.floor(ms / 60000) * 60000).toISOString();
}

const latest = (list) => list.filter(Boolean).reduce((a, b) => (a == null || b > a ? b : a), null);
const optedOut = (prefs, key) => String(prefs?.[key]) === 'false';

/**
 * Snapshot members[].persons: one row per person (a profile without names is its display name) — joined,
 * verified e-mail, admin, mine (my verified e-mail is on that person), their phone (their account, unless hidden),
 * seen_at (to the minute, unless they turned presence off).
 */
function personRows(ctx, m) {
  const { db } = ctx;
  const links = linksOf(db, m.id);
  const emailOf = (userId) => db.user_contacts.find((c) => c.user_id === userId)?.email ?? null;
  const accountOf = (email) => (email ? db.accounts.find((a) => a.email === email) || null : null);
  const myEmail = emailOf(ctx.uid);
  const names = (m.people || []).length ? m.people : [m.display_name];
  return names.map((name) => {
    const devices = links.filter((l) => l.person === name);
    const verified = devices.filter((l) => emailOf(l.user_id));
    const accounts = verified.map((l) => accountOf(emailOf(l.user_id))).filter(Boolean);
    // their phone: the account of their most recently seen verified device (unless it hides it)
    const lastSeen = [...verified].sort((x, y) => cmp(y.last_seen_at ?? '', x.last_seen_at ?? '') || cmp(y.created_at, x.created_at))[0];
    const account = lastSeen ? accountOf(emailOf(lastSeen.user_id)) : null;
    const seen = latest(devices.map((l) => l.last_seen_at));
    const joined = devices.length > 0;
    return {
      name,
      joined,
      verified: verified.length > 0,
      admin: joined && personAdminOf(m.role, m.admin_people ?? null, name, false),
      mine: Boolean(myEmail) && verified.some((l) => emailOf(l.user_id) === myEmail),
      phone: account && !optedOut(account.prefs, 'share_phone') ? account.phone ?? null : null,
      phone_hidden: accounts.some((a) => optedOut(a.prefs, 'share_phone')),
      seen_at: seen && !accounts.some((a) => optedOut(a.prefs, 'presence')) ? toMinute(seen) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Invites from past trips + "הבית שלי" (SQL §9b: _email_hint, _contact_key, _my_emails_uids, _my_partners,
// _contacts, _invite_target)
// ---------------------------------------------------------------------------

/** SQL _email_hint: "h•••@gmail.com". */
const emailHint = (email) => `${[...String(email).split('@')[0]][0] ?? ''}•••@${String(email).split('@')[1] ?? ''}`;

/** SQL _contact_secret: the database's own secret (made once), so a key can't be matched against guessed e-mails. */
function contactSecret(db) {
  if (typeof db.contact_secret !== 'string' || !db.contact_secret) db.contact_secret = `${newId()}${newId()}`;
  return db.contact_secret;
}

/** SQL _contact_key: an opaque, stable per-trip key keyed with the database secret (clients treat it as opaque). */
function contactKey(db, email, tripId) {
  const s = `${contactSecret(db)}:${String(email).toLowerCase()}:${tripId}`;
  let out = '';
  for (const seed of [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]) {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

const emailOfUser = (db, userId) => db.user_contacts.find((c) => c.user_id === userId)?.email ?? null;

/** SQL _my_emails_uids: this device and every device verified with the same e-mail. */
function myEmailsUids(db, uid) {
  const email = emailOfUser(db, uid);
  const out = [uid];
  if (email) for (const c of db.user_contacts) if (c.email === email && !out.includes(c.user_id)) out.push(c.user_id);
  return out;
}

/** SQL _email_in_trip: a device with this verified e-mail is linked in the trip, or a claimed profile lists it. */
function emailInTrip(db, tripId, email) {
  return db.member_users.some((l) => l.trip_id === tripId && emailOfUser(db, l.user_id) === email)
    || db.member_emails.some((e) => e.trip_id === tripId && e.email === email && byId(db.members, e.member_id)?.claimed_at);
}

/** SQL triggers member_users_close_invites / user_contacts_close_invites: once a device with the invite's e-mail is
 *  in the trip (the link, link_device, sign-in with e-mail, a profile request, verifying later…), it's accepted. */
function closeJoinedInvites(ctx) {
  const { db } = ctx;
  for (const inv of db.trip_invites) {
    if (inv.status !== 'pending') continue;
    const link = db.member_users.find((l) => l.trip_id === inv.trip_id && !l.stand_in && emailOfUser(db, l.user_id) === inv.email);
    if (link) Object.assign(inv, { status: 'accepted', answered_at: ctx.now(), member_id: link.member_id });
  }
}

/** SQL _my_partners: the other people of profiles where a device with this e-mail said who it is (newest first, ≤7). */
function myPartners(db, email) {
  const mine = db.member_users.filter((l) => l.person != null && emailOfUser(db, l.user_id) === email);
  const myNames = new Set(mine.map((l) => l.person));
  const at = new Map();
  for (const l of mine) {
    const m = byId(db.members, l.member_id);
    if (!m) continue;
    for (const name of m.people || []) {
      if (myNames.has(name)) continue;
      if (!at.has(name) || cmp(m.created_at, at.get(name)) > 0) at.set(name, m.created_at);
    }
  }
  return [...at.entries()].sort((a, b) => cmp(b[1], a[1]) || cmp(a[0], b[0])).slice(0, 7).map(([name]) => name);
}

/** SQL _partners_for: my partners who aren't in that trip already (their verified e-mail is in there). */
function partnersFor(db, email, tripId) {
  const mine = db.member_users.filter((l) => l.person != null && emailOfUser(db, l.user_id) === email);
  return myPartners(db, email).filter((name) => !mine.some((me) => db.member_users.some((l) => l.member_id === me.member_id
    && l.person === name && (() => {
      const e = emailOfUser(db, l.user_id);
      return e && e !== email && emailInTrip(db, tripId, e);
    })())));
}

/** SQL _contacts: who I (any device of mine) travelled with — verified e-mails only, not me, not "invitable: false".
 *  The name never comes from the e-mail; state adds 'recent' (see invite_contacts' limits). */
function contactsOf(ctx, tripId) {
  const { db } = ctx;
  const uids = myEmailsUids(db, ctx.uid);
  const myEmails = new Set(uids.map((u) => emailOfUser(db, u)).filter(Boolean));
  const src = new Set(db.member_users.filter((l) => uids.includes(l.user_id) && l.trip_id !== tripId).map((l) => l.trip_id));
  const cand = [];
  for (const l of db.member_users) {
    if (!src.has(l.trip_id)) continue;
    const email = emailOfUser(db, l.user_id);
    if (!email || myEmails.has(email)) continue;
    if (String(db.accounts.find((a) => a.email === email)?.prefs?.invitable) === 'false') continue;
    cand.push({ email, trip_id: l.trip_id, member_id: l.member_id, person: l.person ?? null, created_at: l.created_at });
  }
  const tripSort = (a, b) => (a.starts_at == null) - (b.starts_at == null) || cmp(b.starts_at, a.starts_at) || cmp(b.created_at, a.created_at);
  const cutoff = Date.parse(ctx.now()) - 7 * 86400000;
  const dayAgo = Date.parse(ctx.now()) - 86400000;
  return [...new Set(cand.map((c) => c.email))].map((email) => {
    const mine = cand.filter((c) => c.email === email).sort((a, b) => cmp(b.created_at, a.created_at));
    const account = db.accounts.find((a) => a.email === email);
    const single = mine.map((c) => byId(db.members, c.member_id)).find((m) => m && (m.people || []).length <= 1);
    const trips = [...new Set(mine.map((c) => c.trip_id))].map((id) => byId(db.trips, id)).filter(Boolean).sort(tripSort);
    const name = [...((account?.name && account.name.trim()) || mine.find((c) => c.person)?.person || single?.display_name
      || `חבר/ה מ${trips[0]?.name ?? 'טיול קודם'}`)].slice(0, 40).join('');
    const invites = db.trip_invites.filter((i) => i.trip_id === tripId && i.email === email);
    const state = emailInTrip(db, tripId, email) ? 'member'
      : invites.some((i) => i.status === 'pending') ? 'invited'
        : invites.some((i) => i.status === 'declined' && Date.parse(i.answered_at) > cutoff) ? 'declined'
          : invites.some((i) => Date.parse(i.created_at) > cutoff)
            || db.trip_invites.some((i) => i.email === email && uids.includes(i.invited_by_user) && Date.parse(i.created_at) > dayAgo)
            ? 'recent' : null;
    const sortAt = trips.map((t) => t.starts_at ?? t.created_at).reduce((a, b) => (a == null || cmp(b, a) > 0 ? b : a), null);
    return { email, name, trips: trips.slice(0, 3).map((t) => ({ id: t.id, name: t.name, emoji: t.emoji })), state, sort_at: sortAt };
  }).sort((a, b) => (a.sort_at == null) - (b.sort_at == null) || cmp(b.sort_at, a.sort_at) || cmp(a.name, b.name) || cmp(a.email, b.email));
}

/**
 * SQL _invite_target: where accepting puts me without asking — another device of mine already in ('device'),
 * the placeholder I was invited onto ('placeholder'), a profile that lists my e-mail with my (or its only) slot free
 * ('listed'); null = a new profile.
 */
function inviteTarget(ctx, inv, email, name) {
  const { db } = ctx;
  const uids = myEmailsUids(db, ctx.uid).filter((u) => u !== ctx.uid);
  const other = db.member_users.filter((l) => l.trip_id === inv.trip_id && uids.includes(l.user_id))
    .sort((a, b) => (a.person == null) - (b.person == null) || cmp(a.person, b.person) || byCreated(a, b))[0];
  if (other) return { member_id: other.member_id, person: other.person ?? null, how: 'device' };
  const invited = inv.member_id ? db.members.find((m) => m.id === inv.member_id && m.trip_id === inv.trip_id) : null;
  if (invited && !invited.claimed_at) {
    // never silently its first person: the invite's person, my name, its only one — else I pick (person null)
    const people = invited.people || [];
    const person = people.includes(inv.person) ? inv.person : people.includes(name) ? name : people.length === 1 ? people[0] : null;
    return { member_id: invited.id, person, how: 'placeholder' };
  }
  if (invited && !linksOf(db, invited.id).some((l) => l.person == null)) {
    // claimed meanwhile (someone joined it by the link): my slot there, if still free
    const free = (invited.people || []).filter((p) => !linksOf(db, invited.id).some((l) => l.person === p));
    const mine = inv.person ?? name;
    if (free.includes(mine)) return { member_id: invited.id, person: mine, how: 'listed' };
  }
  const listed = membersOf(db, inv.trip_id)
    .filter((m) => m.claimed_at && db.member_emails.some((e) => e.member_id === m.id && e.email === email)
      && !linksOf(db, m.id).some((l) => l.person == null))
    .sort((a, b) => byCreated(a, b) || cmp(a.id, b.id));
  for (const m of listed) {
    const free = (m.people || []).filter((p) => !linksOf(db, m.id).some((l) => l.person === p));
    if (free.includes(name) || free.length === 1) return { member_id: m.id, person: free.includes(name) ? name : free[0], how: 'listed' };
  }
  return null;
}

const pledgeOpen = (type, itemDone, pledgeDone) => !(pledgeDone || (['buy', 'task'].includes(type) && itemDone));
const itemOnIn = (trip, type) => moduleOn(trip, type === 'task' ? 'tasks' : 'lists');

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
      // role = this device's effective role (a partner who isn't crowned is a member here)
      if (trip && member) {
        rows.push({ trip: pick(trip, K.tripBrief), member: { ...pick(member, K.memberBrief), role: personAdmin(member, l) ? member.role : 'member' } });
      }
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
      address: t.address ?? null,
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
    // a couple's creator is the admin; the partner is crowned later (set_person_admin)
    if ((member.people || []).length > 1) member.admin_people = [member.people[0]];
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
      claimed: members.filter((m) => m.claimed_at).map((m) => {
        const joined = joinedPeople(db, m.id);
        const unknown = db.member_users.filter((l) => l.member_id === m.id && !l.person).length;
        // names you can take in one tap (never with rights — I2); with an unidentified device, ask instead
        const open = unknown ? [] : (m.people || []).filter((x) => !joined.includes(x));
        return { ...pick(m, K.unclaimed), joined, unknown, open };
      }),
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
      let people = member.people || [];
      const wasClaimed = Boolean(member.claimed_at);
      if (!wasClaimed) {
        // claiming a placeholder may rename its people: a name from after the patch, or the one at the same place
        const idx = person ? people.indexOf(person) : -1;
        member.claimed_at = ctx.now();
        if (profile != null) patchMember(db, member, profileFields(profile, false));
        people = member.people || [];
        if (person && !people.includes(person)) {
          person = idx >= 0 && idx < people.length ? people[idx] : null;
          if (!person) bad();
        }
      } else if (person && !people.includes(person)) bad();
      if (!person && people.length === 1) [person] = people;
      if (wasClaimed) {
        // one of its other people steps in — their slot is free
        if (!person || people.length < 2 || joinedPeople(db, member.id).includes(person)) fail('already_claimed');
        // a device that never said who it is: we can't tell which name is free — its people approve instead
        if (db.member_users.some((l) => l.member_id === member.id && !l.person)) fail('needs_approval');
        // I2: the invite never brings the profile's rights along
        freezeAdmins(db, member, person);
      }
    } else {
      if (profile == null) bad();
      const prof = profileFields(profile, true);
      if (members.length >= LIMITS.members) fail('limit_reached');
      member = newMemberRow(ctx, trip.id, prof, 'member', true);
      db.members.push(member);
      person = (member.people || []).includes(person) ? person : (member.people || [])[0] || null;
    }
    const steppedIn = claimMemberId != null && Boolean(byId(db.members, claimMemberId)?.claimed_at) && db.member_users.some((l) => l.member_id === member.id);
    if (!hadAdmin) {
      // the first to join a trip without admins owns it — as a person, not the whole couple
      member.role = 'owner';
      member.admin_people = (member.people || []).length > 1 && person != null ? [person] : null;
    }
    linkUser(ctx, trip.id, member.id, person);
    remove(db.profile_requests, (r) => r.user_id === ctx.uid && r.trip_id === trip.id && r.status === 'pending');

    const admins = membersOf(db, trip.id).filter((m) => isAdmin(m) && m.id !== member.id).map((m) => m.id);
    if (admins.length) {
      notify(ctx, trip.id, {
        title: `🎉 ${claimMemberId != null && person ? person : member.display_name} איתנו בטיול`,
        audience: admins,
        link: `#/t/${trip.id}/people`,
      });
    }
    if (steppedIn) {
      notify(ctx, trip.id, {
        title: `🙋 ${person || member.display_name} בפרופיל שלכם עכשיו`, body: 'לא מכירים? מסירים במסך החבר׳ה',
        audience: [member.id], link: `#/t/${trip.id}/people`,
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
    const tripId = member.trip_id;
    const prev = myLink(db, tripId, ctx.uid);
    if (prev && prev.member_id === member.id) return { trip_id: tripId, member_id: member.id };
    let moved = false;
    if (prev) {
      const old = byId(db.members, prev.member_id);
      const oldPerson = prev.person ?? null;
      const oldRole = old ? old.role : null;
      const mine = personAdmin(old, prev) ? oldRole : 'member';
      remove(db.member_users, (l) => l === prev);
      if (old && (mine === 'owner' || mine === 'admin') && !hasAdminDevice(db, old)) {
        // my powers move with me (this device) when nobody left there can use them
        demote(db, old);
        const had = isAdmin(member);
        member.role = oldRole === 'owner' || member.role === 'owner' ? 'owner' : 'admin';
        member.admin_people = had ? member.admin_people ?? null : [];
        moved = true;
      }
      releasePerson(db, old, oldPerson);
      releaseIfOrphan(db, old);
    }
    linkUser(ctx, tripId, member.id, null, moved);
    if (!member.claimed_at) member.claimed_at = ctx.now();
    ensureOwner(db, tripId);
    bump(ctx, tripId);
    return { trip_id: tripId, member_id: member.id };
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
    const link = myLink(db, tripId, uid);
    const role = personAdmin(me, link) ? me.role : 'member'; // this device's role, not just its profile's
    const admin = role === 'owner' || role === 'admin';
    const trip = byId(db.trips, tripId);
    const inTrip = (r) => r.trip_id === tripId;

    const itemRows = db.items.filter((i) => inTrip(i) && canSeeItem(i, me, admin)).sort(bySort);
    const visibleItems = new Set(itemRows.map((i) => i.id));
    const authored = new Set(db.notifications.filter((n) => inTrip(n) && n.author_member === me.id).map((n) => n.id));

    return {
      trip: { ...pick(trip, K.trip), info: { ...clone(DEFAULT_TRIP_INFO), ...(trip.info || {}) }, settings: { ...DEFAULT_TRIP_SETTINGS, ...(trip.settings || {}) } },
      me: { member_id: me.id, role, user_id: uid, person: link?.person ?? null, admin, server_now: ctx.now() },
      members: membersOf(db, tripId).sort(byCreated).map((m) => {
        const unknown = linksOf(db, m.id).filter((l) => l.person == null);
        const hidesPresence = (l) => {
          const email = db.user_contacts.find((c) => c.user_id === l.user_id)?.email;
          return Boolean(email) && optedOut(db.accounts.find((a) => a.email === email)?.prefs, 'presence');
        };
        const unknownSeen = latest(unknown.filter((l) => !hidesPresence(l)).map((l) => l.last_seen_at));
        return {
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
          admin_people: m.admin_people ?? null,
          persons: personRows(ctx, m),
          unknown_devices: unknown.length,
          unknown_seen_at: unknownSeen ? toMinute(unknownSeen) : null,
        };
      }),
      categories: db.categories.filter(inTrip).sort(bySort).map((c) => pick(c, K.category)),
      items: itemRows.map((i) => pick(i, K.item)),
      pledges: db.pledges.filter((p) => inTrip(p) && visibleItems.has(p.item_id)).sort(byCreated)
        .map((p) => ({ ...pick(p, K.pledge), done_people: p.done_people || [] })),
      expenses: db.expenses
        .filter(inTrip)
        .sort((a, b) => cmp(b.spent_on, a.spent_on) || newest(a, b))
        .map((e) => pick(e, K.expense)),
      expense_shares: db.expense_shares.filter(inTrip).map((s) => pick(s, K.share)),
      payments: db.payments.filter(inTrip).sort(newest).map((p) => pick(p, K.payment)),
      notifications: db.notifications
        .filter((n) => inTrip(n) && canSeeNotification(n, me, admin))
        .sort(newest)
        .slice(0, 200)
        .map((n) => ({ ...pick(n, K.notification), by_person: n.author_member ? n.by_person ?? null : null })),
      reads: db.notification_reads
        .filter((r) => inTrip(r) && readByMe(r, me, myLink(db, tripId, ctx.uid)?.person)
          && (admin || r.member_id === me.id || authored.has(r.notification_id)))
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
        .filter((p) => inTrip(p) && p.member_id === me.id && mineByPerson(p, myLink(db, tripId, ctx.uid)?.person))
        .sort(bySort)
        .map((p) => pick(p, K.personal)),
      rides: db.rides
        .filter(inTrip)
        .sort((a, b) => cmp(a.depart_at ?? '￿', b.depart_at ?? '￿') || byCreated(a, b))
        .map((r) => pick(r, K.ride)),
      ride_seats: db.ride_seats.filter(inTrip).sort(byCreated).map((s) => pick(s, K.rideSeat)),
      money_requests: db.money_requests.filter(inTrip).sort(byCreated).map((q) => pick(q, K.moneyRequest)),
      money_request_members: db.money_request_members.filter(inTrip).map((x) => pick(x, K.moneyRequestMember)),
      money_request_parts: db.money_request_parts.filter(inTrip).map((x) => pick(x, K.moneyRequestPart)),
      profile_requests: db.profile_requests
        .filter((r) => inTrip(r) && r.status === 'pending' && (r.member_id === me.id || admin))
        .sort(byCreated)
        .map((r) => pick({ ...r, merging: Boolean(r.from_member) }, K.profileRequest)),
      status: admin ? moduleGaps(db, tripId) : null,
      // invited from past trips, not answered yet; the e-mail hint only for admins
      invites: db.trip_invites
        .filter((i) => inTrip(i) && i.status === 'pending' && !emailInTrip(db, tripId, i.email))
        .sort((a, b) => newest(a, b) || cmp(a.id, b.id))
        .map((i) => pick({ ...i, email_hint: admin ? emailHint(i.email) : null }, K.invite)),
      flights: snapshotFlights(ctx, tripId),
    };
  },

  // The `flight` edge function's member lookup (design §4.4) — answers like it, never throws for flight errors.
  flight_lookup(ctx, tripId, number, date) {
    const input = flightInput(number, date);
    if (!input || typeof tripId !== 'string') return flightFailure('bad_input');
    if (!myMember(ctx.db, tripId, ctx.uid)) return flightFailure('not_member');
    const today = jerusalemYmd(new Date(ctx.now()));
    if (input.date < addDaysYmd(today, -1) || input.date > addDaysYmd(today, 330)) return flightFailure('too_far');
    const flight = demoFlight(input.number, input.date, new Date(ctx.now()));
    if (!flight) return flightFailure('not_found');
    return { ok: true, cached: false, flight };
  },

  nudge_members(ctx, tripId, module) {
    const { db } = ctx;
    requireAdmin(ctx, tripId);
    if (!Object.prototype.hasOwnProperty.call(NUDGE, module)) bad();
    const trip = byId(db.trips, tripId);
    const gap = moduleGaps(db, tripId).find((g) => g.key === module);
    if (!gap) return 0;
    const day = new Date(ctx.now()).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    const kind = `nudge:${module}:${day}`;
    if (!Array.isArray(db.reminders_sent)) db.reminders_sent = [];
    const [title, body, path] = NUDGE[module];
    let count = 0;
    for (const id of gap.missing) {
      // money notifications switched off: a money nudge is one of them (SQL nudge_members)
      if (module === 'money' && byId(db.members, id)?.prefs?.notify?.money === false) continue;
      if (db.reminders_sent.some((r) => r.trip_id === tripId && r.kind === kind && r.member_id === id)) continue;
      db.reminders_sent.push({ trip_id: tripId, kind, member_id: id, sent_at: ctx.now() });
      const m = byId(db.members, id);
      if (m?.prefs?.notify?.reminders === false || m?.prefs?.reminders?.nudge === false) continue;
      // SQL nudge_members: personal where it can be — the poll I haven't voted in, the money I owe
      let t = title;
      let b = body;
      if (module === 'polls') {
        const pl = db.polls.filter((x) => x.trip_id === tripId && !x.closed
          && !db.poll_votes.some((v) => v.poll_id === x.id && v.member_id === id)).sort(byCreated)[0];
        if (pl) t = `📊 ${pl.question}`;
      } else if (module === 'lists') {
        const open = db.items.filter((i) => i.trip_id === tripId && i.status === 'active' && ['buy', 'bring', 'task'].includes(i.type)
          && !i.done && itemOnIn(trip, i.type) && !db.pledges.some((p) => p.item_id === i.id)).length;
        b = `${body} · ${open} פנויים`;
      } else if (module === 'money') {
        const mine = db.money_request_members
          .filter((x) => x.member_id === id && !x.payment_id)
          .map((x) => ({ x, q: byId(db.money_requests, x.request_id) }))
          .filter(({ q }) => q && q.trip_id === tripId && q.status === 'open')
          .sort((a, c) => cmp(a.q.due || '9999', c.q.due || '9999') || byCreated(a.q, c.q))[0];
        if (mine) {
          t = `💰 ${fmtShekel(mine.x.amount)} ל${byId(db.members, mine.q.requested_by)?.display_name ?? ''} · ${mine.q.title}`;
          b = [mine.q.due && `עד ${mine.q.due.slice(8, 10)}.${mine.q.due.slice(5, 7)}`, 'פרטי העברה בלחיצה'].filter(Boolean).join(' · ');
        }
      }
      notify(ctx, tripId, { title: t, body: b, audience: [id], link: `#/t/${tripId}${path}`, kind: 'reminder' });
      count += 1;
    }
    if (count) bump(ctx, tripId);
    return count;
  },

  update_trip(ctx, tripId, patch) {
    requireAdmin(ctx, tripId);
    const trip = byId(ctx.db.trips, tripId);
    const oldStart = trip.starts_at;
    const oldEnd = trip.ends_at;
    const f = tripFields(patch, false);
    for (const [k, v] of Object.entries(f)) {
      if (k === 'info') trip.info = { ...clone(DEFAULT_TRIP_INFO), ...(trip.info || {}), ...v };
      else if (k === 'settings') trip.settings = { ...DEFAULT_TRIP_SETTINGS, ...(trip.settings || {}), ...v };
      else trip[k] = v;
    }
    // the trip moved to other days: the cars' departures move with it (same hour, same day relative to the start)
    if (oldStart && trip.starts_at && oldStart !== trip.starts_at) {
      const dayN = (iso) => Date.parse(`${jerusalemYmd(new Date(iso))}T00:00:00Z`) / 86400000;
      const days = Math.round(dayN(trip.starts_at) - dayN(oldStart));
      if (days) {
        for (const r of ctx.db.rides) {
          if (r.trip_id === tripId && r.depart_at) r.depart_at = new Date(Date.parse(r.depart_at) + days * 86400000).toISOString();
        }
        // … and when the WHOLE trip moved (its end by the same number of days; a trip that only got longer or shorter
        // moves nothing) so do the flights and the lodging (SQL _shift_bookings / _shift_travel) — unless this save set
        // the bookings
        const whole = !(oldEnd && trip.ends_at) || Math.round(dayN(trip.ends_at) - dayN(oldEnd)) === days;
        const shift = (v) => {
          const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v) : null;
          if (!m) return v;
          const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
          return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10) + v.slice(10);
        };
        const shiftKeys = (obj, keys) => {
          for (const k of keys) if (typeof obj[k] === 'string') obj[k] = shift(obj[k]);
        };
        if (whole && !(f.info && has(f.info, 'bookings')) && Array.isArray(trip.info?.bookings)) {
          trip.info.bookings = trip.info.bookings.map((b) => {
            if (!b || typeof b !== 'object') return b;
            const next = { ...b };
            shiftKeys(next, ['date', 'at', 'arr_at', 'check_in', 'check_out']);
            return next;
          });
        }
        for (const m of whole ? ctx.db.members : []) {
          if (m.trip_id !== tripId || !m.prefs?.travel || typeof m.prefs.travel !== 'object') continue;
          const travel = { ...m.prefs.travel };
          for (const leg of ['out', 'back']) {
            if (travel[leg] && typeof travel[leg] === 'object') {
              travel[leg] = { ...travel[leg] };
              shiftKeys(travel[leg], ['date', 'at']);
            }
          }
          m.prefs = { ...m.prefs, travel };
        }
      }
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
    if (me.id !== member.id && !amAdmin(ctx, me)) fail('forbidden');
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
    const link = myLink(db, tripId, ctx.uid);
    const old = link.person ?? null;
    if (old === p) return null;
    const had = adminDevices(db, tripId) > 0;
    const legacy = Boolean(link.legacy);
    link.person = p;
    link.legacy = false;
    // an unidentified device that held the profile's rights: they follow the person it turns out to be
    if (legacy && isAdmin(me) && me.admin_people != null) {
      const list = me.admin_people;
      me.admin_people = peopleWhere(me, (x) => list.includes(x) || x === p);
    }
    releasePerson(db, me, old);
    ensureOwner(db, tripId);
    assertAdminLeft(db, tripId, had);
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
    if (me.id !== member.id && !amAdmin(ctx, me)) fail('forbidden');
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
    if (me.id !== member.id && !amAdmin(ctx, me)) fail('forbidden');
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
    const coords = rideCoords(ride);
    let row;
    if (given(ride, 'id')) {
      row = db.rides.find((r) => r.id === ride.id && r.trip_id === tripId);
      if (!row) fail('not_found');
      if (row.driver_member !== me.id && !amAdmin(ctx, me)) fail('forbidden');
      const taken = approvedSeats(db, row.id);
      if (seats != null && seats < taken) fail('ride_full');
      if (seats != null) row.seats = seats;
      if (has(ride, 'from_text')) row.from_text = optText(ride.from_text, 80);
      if (has(ride, 'depart_at')) row.depart_at = ride.depart_at == null || ride.depart_at === '' ? null : timestampVal(ride.depart_at);
      if (has(ride, 'note')) row.note = optText(ride.note, 200);
      if (kind) row.kind = kind;
      if (has(ride, 'to_text')) row.to_text = optText(ride.to_text, 80);
      Object.assign(row, coords);
    } else {
      if (db.rides.some((r) => r.trip_id === tripId && r.driver_member === me.id)) fail('not_allowed_state');
      remove(db.ride_seats, (s) => s.trip_id === tripId && s.member_id === me.id);
      row = {
        id: newId(), trip_id: tripId, driver_member: me.id, seats: seats ?? 3,
        from_text: optText(ride.from_text, 80),
        depart_at: ride.depart_at == null || ride.depart_at === '' ? null : timestampVal(ride.depart_at),
        note: optText(ride.note, 200), kind: kind || 'car', to_text: optText(ride.to_text, 80), created_at: ctx.now(),
        from_lat: null, from_lon: null, to_lat: null, to_lon: null, ...coords,
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
    if (ride.driver_member !== me.id && !amAdmin(ctx, me)) fail('forbidden');
    const passengers = db.ride_seats.filter((s) => s.ride_id === ride.id).map((s) => s.member_id);
    remove(db.ride_seats, (s) => s.ride_id === ride.id);
    remove(db.rides, (r) => r === ride);
    if (passengers.length) {
      notify(ctx, ride.trip_id, {
        title: `🚗 ההסעה עם ${byId(db.members, ride.driver_member)?.display_name ?? ''} בוטלה`,
        body: 'צריך הסעה אחרת',
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
        title: `🚆 ${actorName(ctx, me)} בנקודת המפגש שלך`, audience: [ride.driver_member], link: `#/t/${ride.trip_id}/rides`,
      });
    } else if (seat.status === 'pending') {
      notify(ctx, ride.trip_id, {
        title: `🚗 ${actorName(ctx, me)} רוצה להצטרף לרכב שלך`,
        body: `${n > 1 ? `${n} מקומות · ` : ''}לאשר?`,
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
    if (ride.driver_member !== me.id && !amAdmin(ctx, me)) fail('forbidden');
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
      title: `🚗 מקום בשבילך ברכב של ${driver?.display_name ?? ''}`,
      body: [ride.from_text && `יוצאים מ${ride.from_text}`, 'לאשר?'].filter(Boolean).join(' · '),
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
    if ((seat.requested_by === 'passenger' && me.id !== ride.driver_member && !amAdmin(ctx, me))
        || (seat.requested_by === 'driver' && me.id !== memberId)) fail('forbidden');
    const driver = byId(db.members, ride.driver_member)?.display_name ?? '';
    const pass = byId(db.members, memberId)?.display_name ?? '';
    const link = `#/t/${ride.trip_id}/trip`;
    if (toBool(approve)) {
      if (approvedSeats(db, ride.id) + seat.seats > ride.seats) fail('ride_full');
      remove(db.ride_seats, (s) => s.trip_id === ride.trip_id && s.member_id === memberId && s.ride_id !== ride.id);
      seat.status = 'approved';
      if (seat.requested_by === 'passenger') notify(ctx, ride.trip_id, { title: `🚗 יש לך מקום ברכב של ${driver}`, audience: [memberId], link });
      else notify(ctx, ride.trip_id, { title: `✅ ${pass} ברכב שלך`, audience: [ride.driver_member], link });
    } else {
      remove(db.ride_seats, (s) => s === seat);
      if (seat.requested_by === 'passenger') {
        notify(ctx, ride.trip_id, { title: `אין מקום ברכב של ${driver} הפעם`, body: 'אפשר לבקש ברכב אחר', audience: [memberId], link });
      } else notify(ctx, ride.trip_id, { title: `הפעם ${pass} לא ברכב שלך`, audience: [ride.driver_member], link });
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
      notify(ctx, tripId, { title: '🚗 מקום התפנה ברכב שלך', body: `${actorName(ctx, me)} כבר לא ברשימת הנוסעים`, audience: [ride.driver_member], link: `#/t/${tripId}/trip` });
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
      // my person comes along (another device of my e-mail said who I am); unidentified → no rights until WhoAmI
      db.member_users.push({
        user_id: ctx.uid, trip_id: m.trip_id, member_id: m.id, person: same?.person ?? null, legacy: false, last_seen_at: null, created_at: ctx.now(),
      });
      if (!m.claimed_at) m.claimed_at = ctx.now();
      if (!membersOf(db, m.trip_id).some((x) => isAdmin(x))) {
        m.role = 'owner';
        m.admin_people = null;
      }
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
    if (who && from && (from.people || []).length > 1) bad(); // a couple merges in as its people, not as one of them
    if (!who && !nm) bad();
    // someone new (or my whole profile, merging in) brings no name it already has: ask as that person instead
    if (!who && (from && from.people && from.people.length ? from.people : [nm]).some((n) => (target.people || []).includes(n))) fail('name_taken');
    remove(db.profile_requests, (r) => r.user_id === ctx.uid && r.trip_id === trip.id);
    const row = {
      id: newId(), trip_id: trip.id, member_id: target.id, user_id: ctx.uid, email: contact.email, person: who,
      name: who || nm, from_member: from ? from.id : null, status: 'pending', created_at: ctx.now(), answered_at: null,
    };
    db.profile_requests.push(row);
    notify(ctx, trip.id, {
      title: `🙋 ${row.name} רוצה להצטרף לפרופיל שלכם`, body: `${contact.email} · לאשר?`,
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
    if (me.id !== q.member_id && !amAdmin(ctx, me)) fail('forbidden');
    const t = byId(db.members, q.member_id);
    if (!toBool(approve)) {
      q.status = 'declined';
      q.answered_at = ctx.now();
      if (q.from_member) notify(ctx, q.trip_id, { title: `הבקשה לפרופיל ${t.display_name} לא אושרה`, audience: [q.from_member], link: `#/t/${q.trip_id}` });
      bump(ctx, q.trip_id);
      return null;
    }
    let addHeads = 0;
    let addPeople = [];
    let mergedAdmins; // set by a merge: null (no lists) or both profiles' admins
    const f = q.from_member ? byId(db.members, q.from_member) : null;
    // the asker is still where they asked from (they may have joined, left or moved meanwhile)
    const now = myLink(db, q.trip_id, q.user_id);
    if ((now ? now.member_id : null) !== (f ? f.id : null)) fail('not_allowed_state');
    if (q.person && f && (f.people || []).length > 1) fail('not_allowed_state');
    const had = adminDevices(db, q.trip_id) > 0;
    // who they come in as must still fit: their person is still one of its people and no other e-mail is
    // them; someone new brings no name the profile already has (it would share that person's rights)
    if (q.person) {
      if (!(t.people || []).includes(q.person)) fail('not_allowed_state');
      if (db.member_users.some((l) => l.member_id === t.id && l.person === q.person && l.user_id !== q.user_id
          && !db.user_contacts.some((c) => c.user_id === l.user_id && c.email === q.email))) fail('already_claimed');
    } else if ((f && f.people && f.people.length ? f.people : [q.name]).some((n) => (t.people || []).includes(n))) {
      fail('name_taken');
    }
    if (f) {
      if (db.expenses.some((e) => e.paid_by === f.id || e.created_by === f.id)
          || db.expense_shares.some((s) => s.member_id === f.id)
          || db.payments.some((p) => p.from_member === f.id || p.to_member === f.id)
          || db.money_requests.some((r) => r.requested_by === f.id && r.status === 'open')
          || db.money_request_members.some((a) => a.member_id === f.id && !a.payment_id
            && (db.money_request_members.some((b) => b.request_id === a.request_id && b.member_id === t.id && b.payment_id)
              // …or where one of t's people already paid their part (§19)
              || db.money_request_parts.some((b) => b.request_id === a.request_id && b.member_id === t.id && b.payment_id)))) {
        fail('has_money_records');
      }
      for (const x of db.money_request_members.filter((r) => r.member_id === f.id && !r.payment_id)) {
        const q = db.money_requests.find((r) => r.id === x.request_id);
        if (!q || q.status !== 'open' || q.requested_by === t.id) continue;
        const mine = db.money_request_members.find((r) => r.request_id === x.request_id && r.member_id === t.id);
        if (mine) mine.amount = Math.min(100000, Math.round((Number(mine.amount) + Number(x.amount)) * 100) / 100);
        else db.money_request_members.push({ ...x, member_id: t.id });
      }
      remove(db.money_request_members, (r) => r.member_id === f.id);
      remove(db.money_request_parts, (r) => r.member_id === f.id);
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
      // rights: both lists are pinned to who holds them now (the devices moving in widen nobody's rights);
      // f's devices become the person they join as; then the better role and both lists together
      const fRights = hasAdminDevice(db, f);
      freezeAdmins(db, f, null);
      freezeAdmins(db, t, null);
      if (q.person) {
        for (const l of linksOf(db, f.id)) {
          l.person = q.person;
          l.legacy = false;
        }
        f.admin_people = fRights ? [q.person] : [];
      }
      for (const l of linksOf(db, f.id)) l.member_id = t.id; // legacy flags travel with the devices
      mergedAdmins = f.role === 'member' && t.role === 'member' ? null : [...(t.admin_people || []), ...(f.admin_people || [])];
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
      // I2: an approval never brings the profile's rights — a newcomer is kept off the list; a person already
      // in (my other phone, same e-mail) keeps theirs
      const newcomer = q.person || q.name;
      freezeAdmins(db, t, linksOf(db, t.id).some((l) => l.person === newcomer) ? null : newcomer);
      remove(db.member_users, (l) => l.user_id === q.user_id && l.trip_id === q.trip_id);
      db.member_users.push({
        user_id: q.user_id, trip_id: q.trip_id, member_id: t.id, person: q.person || q.name || null, legacy: false, last_seen_at: null, created_at: ctx.now(),
      });
      if (!q.person) {
        addHeads = 1;
        addPeople = [q.name];
      }
    }
    t.headcount = Math.min(20, (t.headcount || 1) + addHeads);
    t.people = [...(t.people || []), ...addPeople];
    // more of us: the split "each" rows and the per-person request parts follow (§19)
    for (const pl of db.pledges.filter((x) => x.member_id === t.id)) eachRecompute(db, pl);
    syncRequestParts(db, t.id);
    if (mergedAdmins !== undefined) t.admin_people = mergedAdmins === null ? null : peopleWhere(t, (x) => mergedAdmins.includes(x));
    if (!t.claimed_at) t.claimed_at = ctx.now();
    if (!db.member_emails.some((x) => x.member_id === t.id && x.email === q.email)) {
      db.member_emails.push({ member_id: t.id, trip_id: q.trip_id, email: q.email, token: newId(), created_at: ctx.now() });
    }
    q.status = 'approved';
    q.answered_at = ctx.now();
    notify(ctx, q.trip_id, {
      title: `✅ ${q.name} בפרופיל ${t.display_name}`, body: 'רשימות, הסעה וכסף — ביחד',
      audience: [t.id], link: `#/t/${q.trip_id}`,
    });
    ensureOwner(db, q.trip_id);
    assertAdminLeft(db, q.trip_id, had);
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
    const title = '🔔 ההתראות עובדות';
    const hourAgo = Date.parse(ctx.now()) - 3600000;
    const recent = db.notifications.filter((n) => n.trip_id === tripId && n.title === title && Date.parse(n.created_at) > hourAgo
      && Array.isArray(n.audience) && n.audience.length === 1 && n.audience[0] === me.id).length;
    if (recent >= 3) fail('rate_limited');
    notify(ctx, tripId, { title, body: 'ככה ייראו העדכונים מהטיול — בטלפון ובמייל', audience: [me.id], link: `#/t/${tripId}/me` });
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
      notify(ctx, item.trip_id, { title: `✅ ${item.title} סגור — ${actorName(ctx, me)} על זה`, audience: [p.assigned_by], link });
    } else {
      remove(db.pledges, (x) => x === p);
      notify(ctx, item.trip_id, { title: `↩️ ${item.title} חזר לרשימה`, body: `${actorName(ctx, me)}: ${why || 'לא מסתדר'} · לשבץ מישהו אחר?`, audience: [p.assigned_by], link });
    }
    bump(ctx, item.trip_id);
    return null;
  },

  update_member(ctx, memberId, patch) {
    const { db } = ctx;
    const member = need(db.members, memberId);
    const me = requireMember(ctx, member.trip_id);
    if (me.id !== member.id && !amAdmin(ctx, me)) fail('forbidden');
    // how a couple / family settles money and brings "each" items is the profile's own choice (SPEC §19)
    if (isObj(patch) && isObj(patch.prefs) && ('pay' in patch.prefs || 'bring' in patch.prefs) && me.id !== member.id) fail('forbidden');
    const old = { people: [...(member.people || [])], prefs: { ...(member.prefs || {}) }, headcount: member.headcount };
    const wasSplit = new Set(db.pledges.filter((pl) => pl.member_id === member.id && byId(db.items, pl.item_id)?.type === 'each'
      && splitsItems(old, pl)).map((pl) => pl.id));
    const had = adminDevices(db, member.trip_id) > 0;
    const ownerCould = member.role === 'owner' && hasAdminDevice(db, member);
    const iAdmin = amAdmin(ctx, me);
    const rights = rightsDevices(db, member);
    const heads = member.headcount;
    patchMember(db, member, profileFields(patch, false));
    // removing the owner's own name(s) would leave the trip's owner unable to act
    if (ownerCould && member.role === 'owner' && !hasAdminDevice(db, member)) fail('owner_locked');
    // a partner who isn't an admin can't take an admin partner's rights away by removing their name
    if (!iAdmin && rightsDevices(db, byId(db.members, member.id)) < rights) fail('forbidden');
    ensureOwner(db, member.trip_id);
    assertAdminLeft(db, member.trip_id, had);
    // a member (not an admin) changing how many they are moves everyone's split once there are expenses
    if (!iAdmin && member.headcount !== heads && db.expenses.some((e) => e.trip_id === member.trip_id && e.split_mode === 'all')) {
      const admins = membersOf(db, member.trip_id).filter((m) => isAdmin(m) && m.id !== me.id).map((m) => m.id);
      if (admins.length) {
        notify(ctx, member.trip_id, {
          title: `👥 ${member.display_name}: עכשיו ${member.headcount} אנשים (היו ${heads})`,
          body: `עודכן ע״י ${actorName(ctx, me)} · חלוקת ההוצאות מתעדכנת`,
          audience: admins, link: `#/t/${member.trip_id}/money`,
        });
      }
    }
    // couples (§19): the rows that follow the choices / names, and the partner hears about a change
    if (JSON.stringify(old.people) !== JSON.stringify(member.people || []) || JSON.stringify(old.prefs) !== JSON.stringify(member.prefs || {})
        || old.headcount !== member.headcount) {
      for (const pl of db.pledges.filter((x) => x.member_id === member.id && byId(db.items, x.item_id)?.type === 'each')) {
        eachModeChanged(db, pl, wasSplit.has(pl.id));
      }
      syncRequestParts(db, member.id);
    }
    if ((member.people || []).length >= 2) {
      const who = actorName(ctx, me);
      const link = `#/t/${member.trip_id}/me`;
      if ((member.prefs?.pay ?? 'together') !== (old.prefs.pay ?? 'together')) {
        notify(ctx, member.trip_id, { title: `💑 ${who} בחר/ה: ${member.prefs.pay === 'each' ? 'כל אחד משלם את החלק שלו' : 'משלמים ביחד'}`,
          body: 'אפשר לשנות בכל רגע במסך ״אני״', audience: [member.id], link });
      }
      if ((member.prefs?.bring ?? 'together') !== (old.prefs.bring ?? 'together')) {
        notify(ctx, member.trip_id, { title: `💑 ${who} בחר/ה: ${member.prefs.bring === 'each' ? 'כל אחד מביא את שלו' : 'מביאים ביחד'}`,
          body: 'ב״כל אחד מביא״ · אפשר לשנות בכל רגע במסך ״אני״', audience: [member.id], link });
      }
    }
    bump(ctx, member.trip_id);
    return null;
  },

  create_member(ctx, tripId, profile) {
    requireAdmin(ctx, tripId);
    const prof = profileFields(profile, true);
    if (prof.prefs) {
      // how a couple settles / brings is theirs to choose, not the admin's who adds them (§19)
      const { pay, bring, ...rest } = prof.prefs;
      prof.prefs = rest;
    }
    if (membersOf(ctx.db, tripId).length >= LIMITS.members) fail('limit_reached');
    const member = newMemberRow(ctx, tripId, prof, 'member', false);
    ctx.db.members.push(member);
    bump(ctx, tripId);
    return member.id;
  },

  /** The whole profile (all its people) — kept for single profiles and old clients; couples use set_person_admin. */
  set_role(ctx, memberId, role) {
    const { db } = ctx;
    oneOf(role, ['admin', 'member']);
    const member = need(db.members, memberId);
    requireAdmin(ctx, member.trip_id);
    const tripId = member.trip_id;
    if (member.role === 'owner') fail('owner_locked');
    if (member.role === role) return null;
    if (role === 'admin' && !member.claimed_at) fail('not_allowed_state'); // nobody there to use it
    const had = adminDevices(db, tripId) > 0;
    if (role === 'admin') {
      member.role = 'admin';
      member.admin_people = null;
      notify(ctx, tripId, {
        title: '👑 קיבלת הרשאות ניהול', body: 'לאשר הצעות, לשבץ ולשלוח הודעות לכולם',
        audience: [member.id], link: `#/t/${tripId}/people`,
      });
    } else {
      demote(db, member);
    }
    ensureOwner(db, tripId);
    assertAdminLeft(db, tripId, had);
    bump(ctx, tripId);
    return null;
  },

  /** Crown / uncrown one person of a profile (SPEC §14). */
  set_person_admin(ctx, memberId, person, admin) {
    const { db } = ctx;
    const m = need(db.members, memberId);
    requireAdmin(ctx, m.trip_id);
    const tripId = m.trip_id;
    if (typeof admin !== 'boolean') bad();
    const p = typeof person === 'string' ? person.trim() : '';
    if (!p || !(m.people || []).includes(p)) bad();
    if (m.role === 'owner' && myRole(ctx, tripId) !== 'owner') fail('owner_locked');
    // I1: only someone with a device can hold rights
    if (!m.claimed_at || (admin && !linksOf(db, m.id).some((l) => l.person === p))) fail('not_allowed_state');
    if (personAdminOf(m.role, m.admin_people ?? null, p, false) === admin) return null; // already so
    const had = adminDevices(db, tripId) > 0;
    if (!isAdmin(m)) {
      m.role = 'admin';
      m.admin_people = [p];
    } else {
      freezeAdmins(db, m, null);
      const list = m.admin_people;
      m.admin_people = peopleWhere(m, (x) => (x === p ? admin : list.includes(x)));
      if (!m.admin_people.length && !linksOf(db, m.id).some((l) => l.person == null && l.legacy)) {
        if (m.role === 'owner') fail('owner_locked'); // the owner profile always keeps someone in charge
        demote(db, m);
      }
    }
    ensureOwner(db, tripId);
    assertAdminLeft(db, tripId, had);
    if (admin) {
      notify(ctx, tripId, {
        title: `👑 ${p}: הרשאות ניהול`, body: 'לאשר הצעות, לשבץ ולשלוח הודעות לכולם',
        audience: [m.id], link: `#/t/${tripId}/people`,
      });
    }
    bump(ctx, tripId);
    return null;
  },

  remove_member(ctx, memberId) {
    const { db } = ctx;
    const member = need(db.members, memberId);
    requireAdmin(ctx, member.trip_id);
    if (member.role === 'owner') fail('owner_locked');
    const had = adminDevices(db, member.trip_id) > 0;
    const id = member.id;
    const hasMoney =
      db.expenses.some((e) => e.paid_by === id || e.created_by === id) ||
      db.expense_shares.some((s) => s.member_id === id) ||
      db.payments.some((p) => p.from_member === id || p.to_member === id || p.created_by === id) ||
      db.money_requests.some((r) => r.requested_by === id && r.status === 'open');
    if (hasMoney) fail('has_money_records');
    const theirs = db.money_requests.filter((r) => r.requested_by === id).map((r) => r.id);
    remove(db.money_request_members, (x) => x.member_id === id || theirs.includes(x.request_id));
    remove(db.money_request_parts, (x) => x.member_id === id || theirs.includes(x.request_id));
    remove(db.money_requests, (r) => theirs.includes(r.id));

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
    for (const i of db.trip_invites) {
      if (i.invited_by === id) i.invited_by = null;
      if (i.member_id === id) i.member_id = null;
    }
    remove(db.members, (m) => m.id === id);
    ensureOwner(db, member.trip_id);
    assertAdminLeft(db, member.trip_id, had);
    bump(ctx, member.trip_id);
    return null;
  },

  leave_trip(ctx, tripId) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    const person = myLink(db, tripId, ctx.uid)?.person ?? null;
    const had = adminDevices(db, tripId) > 0;
    remove(db.member_users, (l) => l.user_id === ctx.uid && l.trip_id === tripId);
    remove(db.push_subscriptions, (s) => s.user_id === ctx.uid && s.trip_id === tripId);
    releasePerson(db, me, person);
    releaseIfOrphan(db, me); // unclaimed, code revoked, no rights
    ensureOwner(db, tripId); // the owner person left: an admin who can act takes over
    assertAdminLeft(db, tripId, had);
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
      // SQL _admin_ids(trip, me): not my own profile (a partner who isn't crowned can propose in an admin profile)
      const admins = membersOf(db, tripId).filter((m) => isAdmin(m) && m.id !== me.id).map((m) => m.id);
      if (admins.length) {
        notify(ctx, tripId, {
          title: `🙋 הצעה מ${actorName(ctx, me)}: ${item.title}`,
          body: 'לאשר או לדחות?',
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
      // SQL: a member who isn't in the trip (any more) is ignored
      const target = raw.assign_to != null && raw.assign_to !== '' ? byId(db.members, raw.assign_to) : null;
      const assignTo = target && target.trip_id === tripId ? target.id : null;
      return { f, category, pledgeQty: pledgeQtyVal(raw), assignTo, done: raw.done === true };
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
      if (!found && amAdmin(ctx, me)) {
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
    const admin = amAdmin(ctx, me);
    const assigned = new Map(); // member id → titles assigned by me in this batch
    for (const { f, category, pledgeQty, assignTo, done } of prepared) {
      f.category_id = resolveCategory(category);
      const before = new Set(db.items.map((i) => i.id));
      insertItem(ctx, trip, me, f, pledgeQty, sort++);
      const item = db.items.find((i) => !before.has(i.id));
      if (!item || item.status !== 'active') continue;
      // "✅" on the list: already bought / done
      if (done && (item.type === 'buy' || item.type === 'task')) {
        item.done = true;
        item.done_at = ctx.now();
      }
      // SQL: me → my pledge; someone else → an admin's assignment waiting for their answer (none when done)
      if (!assignTo || item.type === 'each' || !(assignTo === me.id || admin)) continue;
      if (db.pledges.some((p) => p.item_id === item.id && p.member_id === assignTo)) continue;
      const qty = item.type === 'bring' ? Math.min(200, Math.max(1, Number(item.needed) || 1)) : 1;
      const mine = assignTo === me.id;
      db.pledges.push({ id: newId(), trip_id: tripId, item_id: item.id, member_id: assignTo, qty, done,
        assigned_by: mine ? null : me.id, accepted_at: mine || done ? ctx.now() : null, created_at: ctx.now() });
      if (!mine && !done) assigned.set(assignTo, [...(assigned.get(assignTo) || []), item.title]);
    }
    for (const [id, titles] of assigned) {
      notify(ctx, tripId, {
        title: titles.length === 1 ? `📌 עליך: ${titles[0]}` : `📌 עליך: ${titles.length} דברים`,
        body: `${titles.length > 1 ? `${titles.slice(0, 3).join(' · ')}${titles.length > 3 ? ` ועוד ${titles.length - 3}` : ''}\n` : ''}שיבוץ מ${actorName(ctx, me)} · ✅ סגור או "לא מסתדר"`, audience: [id], link: `#/t/${tripId}/lists?tab=mine`,
      });
    }
    if (prepared.length) bump(ctx, tripId);
    return prepared.length;
  },

  update_item(ctx, itemId, patch) {
    const { db } = ctx;
    const item = need(db.items, itemId);
    const me = requireMember(ctx, item.trip_id);
    if (!(amAdmin(ctx, me) || (item.created_by === me.id && item.status === 'proposed'))) fail('forbidden');
    Object.assign(item, itemFields(db, item.trip_id, patch, false));
    if (item.type !== 'each') item.each_qty = null;                 // only "כל אחד מביא" counts per couple
    item.updated_at = ctx.now();
    for (const pl of db.pledges.filter((x) => x.item_id === item.id)) eachRecompute(db, pl);
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
        title: ok ? `✅ ${item.title} ברשימה` : `✖️ ${item.title} לא נכנס לרשימה`,
        body: ok ? 'ההצעה שלך אושרה' : why,
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
    if (!amAdmin(ctx, me) && !own) fail('forbidden');
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
          title: `📌 עליך: ${item.title}`, body: `שיבוץ מ${actorName(ctx, me)} · ✅ סגור או "לא מסתדר"`,
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
    let existing = db.pledges.find((p) => p.item_id === item.id && p.member_id === me.id);
    if (item.type === 'each') {
      if (item.status !== 'active') fail('not_allowed_state');
      if (!existing) {
        existing = { id: newId(), trip_id: item.trip_id, item_id: item.id, member_id: me.id, qty: 1, done: false,
          assigned_by: null, created_at: ctx.now(), split: null, person_qty: null, done_people: [] };
        db.pledges.push(existing);
      }
      if (!splitsItems(me, existing)) existing.done = d;                 // together: one tick (today)
      else {
        // a couple that brings it each their own (§19): my share; no person on this device → the whole row
        const person = myPersonIn(ctx, me);
        const s = eachSplitOf(item, me, existing);
        const map = Object.fromEntries(s.parts.map((x) => [x.person, x.qty]));
        const ticked = existing.done_people || [];
        if (!person) {
          if (d) existing.person_qty = eachFill(map, me, s.target);
          existing.done_people = d ? [...me.people] : [];
        } else if (d) {
          if (!map[person]) {
            if (s.open <= 0) fail('not_allowed_state');                    // nothing of it is mine
            existing.person_qty = { ...map, [person]: 1 };
          }
          existing.done_people = [...ticked.filter((n) => n !== person), person];
        } else existing.done_people = ticked.filter((n) => n !== person);
        eachRecompute(db, existing);
      }
    } else if (existing) existing.done = d;
    else fail('not_found');
    bump(ctx, item.trip_id);
    return null;
  },

  // A couple's own "each" row (§19): {split: 'together'|'each'|null} for this item, {claim: n} how many I bring.
  set_each_part(ctx, itemId, patch) {
    const { db } = ctx;
    const item = need(db.items, itemId);
    const me = requireMember(ctx, item.trip_id);
    if (!isObj(patch) || item.type !== 'each') bad();
    if (item.status !== 'active') fail('not_allowed_state');
    let split;
    if (has(patch, 'split') || (isObj(patch) && 'split' in patch)) split = patch.split === null ? null : oneOf(patch.split, ['together', 'each']);
    const claim = has(patch, 'claim') ? toInt(patch.claim, 0, 1000000) : undefined;
    if (patch.claim === null) bad();
    let row = db.pledges.find((p) => p.item_id === item.id && p.member_id === me.id);
    if (!row) {
      row = { id: newId(), trip_id: item.trip_id, item_id: item.id, member_id: me.id, qty: 1, done: false,
        assigned_by: null, created_at: ctx.now(), split: null, person_qty: null, done_people: [] };
      db.pledges.push(row);
    }
    if (split !== undefined) {
      const was = splitsItems(me, row);
      row.split = split;
      eachModeChanged(db, row, was);
    }
    if (claim !== undefined) {
      const person = myPersonIn(ctx, me);
      if (!person || !splitsItems(me, row)) bad();
      const s = eachSplitOf(item, me, row);
      const map = { ...Object.fromEntries(s.parts.map((x) => [x.person, x.qty])), [person]: claim };
      if (Object.values(map).reduce((a, b) => a + b, 0) > s.target) bad();
      row.person_qty = map;
      if (claim === 0) row.done_people = (row.done_people || []).filter((n) => n !== person);
      eachRecompute(db, row);
    }
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
    if (!pledger && !amAdmin(ctx, me)) fail('forbidden');
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
    const person = myLink(db, tripId, ctx.uid)?.person;
    const have = new Set(mine.filter((p) => mineByPerson(p, person)).map((p) => p.title.trim()));
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
    if (paidBy !== me.id && !amAdmin(ctx, me)) fail('forbidden');
    // who of the paying profile paid (§19): as given (null = together), else me when I'm the payer
    let paidByPerson = null;
    if (f.paid_by_person !== undefined) {
      if (f.paid_by_person !== null && !personOf(byId(db.members, paidBy), f.paid_by_person)) bad();
      paidByPerson = f.paid_by_person;
    } else if (paidBy === me.id) paidByPerson = myPersonIn(ctx, me);
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
      tag: f.tag ?? null,
      paid_by_person: paidByPerson,
    };
    db.expenses.push(row);
    if (mode === 'members') replaceShares(ctx, row, f.members);
    // no ping per receipt: in the app now, push/e-mail in the next daily summary
    const payer = db.members.find((m) => m.id === paidBy);
    ctx.db.notifications.push({
      id: newId(), trip_id: tripId, kind: 'system',
      title: clip(`🧾 ${row.title} · ${fmtShekel(row.amount)}`, 80),
      body: `שולם ע״י ${payer ? payer.display_name : ''}`,
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
    if (!(amAdmin(ctx, me) || exp.created_by === me.id || exp.paid_by === me.id)) fail('forbidden');
    const f = expenseFields(db, exp.trip_id, patch, false);
    if (f.paid_by !== undefined && f.paid_by !== exp.paid_by && f.paid_by !== me.id && !amAdmin(ctx, me)) fail('forbidden');
    const mode = f.split_mode ?? exp.split_mode;
    if (mode === 'members') {
      const shares = f.members ?? (exp.split_mode === 'members' ? db.expense_shares.filter((s) => s.expense_id === exp.id) : []);
      if (!shares.length) bad();
    }
    const oldPaidBy = exp.paid_by;
    for (const k of ['title', 'amount', 'paid_by', 'category_id', 'note', 'spent_on', 'currency', 'orig_amount', 'rate', 'tag']) {
      if (f[k] !== undefined) exp[k] = f[k];
    }
    if (f.paid_by_person !== undefined) {
      if (f.paid_by_person !== null && !personOf(byId(db.members, exp.paid_by), f.paid_by_person)) bad();
      exp.paid_by_person = f.paid_by_person;
    } else if (exp.paid_by !== oldPaidBy) exp.paid_by_person = exp.paid_by === me.id ? myPersonIn(ctx, me) : null;
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
    if (!(amAdmin(ctx, me) || exp.created_by === me.id || exp.paid_by === me.id)) fail('forbidden');
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
    // who of a profile sent / got it (§19); partner → partner inside one profile: both named, not the same
    const mine = myPersonIn(ctx, me);
    const personArg = (key, memberId) => {
      const v = pay[key] == null ? null : reqText(pay[key], 1, 40);
      if (v !== null && !personOf(byId(db.members, memberId), v)) bad();
      return v;
    };
    const fromPerson = 'from_person' in pay ? personArg('from_person', from) : from === me.id ? mine : null;
    const toPerson = 'to_person' in pay ? personArg('to_person', to) : to === me.id && from !== me.id ? mine : null;
    if (from === to && (!fromPerson || !toPerson || fromPerson === toPerson)) bad();
    const amount = moneyVal(pay.amount);
    const method = given(pay, 'method') ? oneOf(pay.method, PAY_METHODS) : 'bit';
    const note = optText(pay.note, 500);
    if (from !== me.id && to !== me.id && !amAdmin(ctx, me)) fail('forbidden');
    // the receiver saying it arrived — inside one profile: only the partner who got it
    const status = to === me.id && (from !== to || toPerson === mine) ? 'confirmed' : 'sent';
    const now = ctx.now();
    const row = {
      id: newId(), trip_id: tripId, from_member: from, to_member: to, amount, method, note, status,
      created_by: me.id, created_at: now, confirmed_at: status === 'confirmed' ? now : null,
      from_person: fromPerson, to_person: toPerson,
    };
    db.payments.push(row);
    linkPaymentToRequests(ctx, row);
    if (row.status === 'confirmed') closeMoneyRequestIfDone(ctx, row.id);

    const fromName = partyNameOf(byId(db.members, from), fromPerson);
    const toName = partyNameOf(byId(db.members, to), toPerson);
    const link = `#/t/${tripId}/money`;
    if (status === 'confirmed') {
      notify(ctx, tripId, { title: `✅ ${fmtShekel(amount)} הגיעו ל${toName}`, audience: [from], link });
    } else {
      notify(ctx, tripId, { title: `💰 ${fmtShekel(amount)} מ${fromName} — לאשר שהגיע?`, audience: [to], link });
    }
    bump(ctx, tripId);
    return row.id;
  },

  confirm_payment(ctx, id) {
    const { db } = ctx;
    const pay = need(db.payments, id);
    const me = requireMember(ctx, pay.trip_id);
    // the receiver confirms; an admin may confirm for them — but never the one who paid (even an admin).
    // Inside one profile (partner → partner, §19): only the partner who got it.
    const inside = pay.from_member === pay.to_member && myPersonIn(ctx, me) === pay.to_person;
    if ((pay.from_member === me.id && !inside) || (pay.to_member !== me.id && !amAdmin(ctx, me))) fail('forbidden');
    if (pay.status !== 'confirmed') {
      pay.status = 'confirmed';
      pay.confirmed_at = ctx.now();
      closeMoneyRequestIfDone(ctx, pay.id);
      if (pay.from_member !== me.id || pay.from_member === pay.to_member) {
        const toName = partyNameOf(byId(db.members, pay.to_member), pay.to_person);
        notify(ctx, pay.trip_id, {
          title: `✅ ${fmtShekel(pay.amount)} הגיעו ל${toName}`,
          audience: [pay.from_member],
          link: `#/t/${pay.trip_id}/money`,
        });
      }
    }
    bump(ctx, pay.trip_id);
    return null;
  },

  create_money_request(ctx, tripId, req) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    reqObj(req);
    if (db.money_requests.filter((q) => q.trip_id === tripId).length >= 100) fail('limit_reached');
    const title = reqText(req.title, 1, 80);
    const due = given(req, 'due') ? dateVal(req.due) : null;
    const methods = payMethods(req.methods);
    const per = req.per_person == null ? null : Number(req.per_person);
    const total = req.total == null ? null : Number(req.total);
    let linked = null;
    if (req.expense != null) {
      if (per != null || total != null) bad();                    // the expense says how much
      linked = db.expenses.find((e) => e.id === req.expense && e.trip_id === tripId);
      if (!linked) fail('not_found');
      if (linked.paid_by !== me.id) fail('forbidden');
      if (db.money_requests.some((q) => q.expense_id === linked.id && q.status === 'open')) fail('not_allowed_state');
    } else if ((per == null) === (total == null)) bad();
    const exempt = exemptIds(db, tripId);
    let ids = Array.isArray(req.members) ? [...new Set(req.members)]
      : membersOf(db, tripId).filter((m) => linked || !exempt.has(m.id)).map((m) => m.id);
    ids = ids.filter((id) => id !== me.id);
    if (!ids.every((id) => db.members.some((m) => m.id === id && m.trip_id === tripId))) bad();
    let linkedCents = null;
    if (linked) {                                                   // only who actually shares it
      const inTrip = (r) => r.trip_id === tripId;
      const snapNow = { trip: db.trips.find((t) => t.id === tripId), members: db.members.filter(inTrip), expense_shares: db.expense_shares.filter(inTrip) };
      linkedCents = new Map(expenseShares(linked, snapNow).map((x) => [x.member_id, Math.round(x.amount * 100)]));
      ids = ids.filter((id) => (linkedCents.get(id) || 0) > 0);
    }
    if (!ids.length) bad();
    const members = ids.map((id) => byId(db.members, id))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
    const heads = (m) => Math.max(1, Number(m.headcount) || 1);
    const selfH = total != null && req.include_me === true ? heads(me) : 0;
    const id = newId();
    const request = { id, trip_id: tripId, requested_by: me.id, title, note: optText(req.note, 500), due, methods, status: 'open',
      created_at: ctx.now(), expense_id: linked ? linked.id : null, self_amount: 0, linked_expense: !!linked, pot: true };
    db.money_requests.push(request);
    let shares;
    let self = 0;
    if (linked) {
      shares = members.map((m) => linkedCents.get(m.id));
    } else if (total != null) {
      const cents = Math.round(moneyVal(total) * 100);
      const all = members.reduce((n, m) => n + heads(m), 0) + selfH;
      const base = members.map((m) => Math.floor((cents * heads(m)) / all));
      self = Math.floor((cents * selfH) / all);
      let left = cents - self - base.reduce((a, b) => a + b, 0);
      self += Math.max(0, left - members.length);                 // the agorot go to the asked first
      shares = base.map((c) => (left-- > 0 ? c + 1 : c));
    } else {
      const p = moneyVal(per);
      shares = members.map((m) => Math.round(p * heads(m) * 100));
    }
    request.self_amount = self / 100;
    const who = actorName(ctx, me);
    const how = [due && `עד ${due.slice(8, 10)}.${due.slice(5, 7)}`, methods.bit && `ביט ${methods.bit}`, methods.paybox && `פייבוקס ${methods.paybox}`,
      methods.bank && 'העברה בנקאית', methods.cash && 'מזומן'].filter(Boolean).join(' · ');
    members.forEach((m, i) => {
      const amount = moneyVal(shares[i] / 100);
      db.money_request_members.push({ request_id: id, trip_id: tripId, member_id: m.id, amount, payment_id: null });
      buildRequestParts(db, id, m.id);                                  // a couple that pays each their own part (§19)
      const parts = partsOf(db, id, m.id).map((pt) => `${pt.person} ${fmtShekel(pt.amount)}`).join(' · ');
      notify(ctx, tripId, {
        title: `💰 ${fmtShekel(amount)} ל${who} · ${title}`,
        body: [parts, how].filter(Boolean).join('\n') || null,
        audience: [m.id], link: `#/t/${tripId}/money`,
      });
    });
    if (!linked && req.already_paid !== false) {
      // already paid: the shares (and my own part) are an expense of mine, so paying them settles it
      const rows = db.money_request_members.filter((x) => x.request_id === id);
      const exp = {
        id: newId(), trip_id: tripId, title, amount: moneyVal(rows.reduce((n, x) => n + Number(x.amount), 0) + self / 100), paid_by: me.id,
        category_id: null, note: 'בקשת תשלום 💰', split_mode: 'members', created_by: me.id, spent_on: jerusalemYmd(new Date()),
        created_at: ctx.now(), currency: null, orig_amount: null, rate: null, paid_by_person: myPersonIn(ctx, me),
      };
      db.expenses.push(exp);
      for (const x of rows) db.expense_shares.push({ expense_id: exp.id, trip_id: tripId, member_id: x.member_id, weight: Number(x.amount) });
      if (self > 0) db.expense_shares.push({ expense_id: exp.id, trip_id: tripId, member_id: me.id, weight: self / 100 });
      request.expense_id = exp.id;
    }
    bump(ctx, tripId);
    return id;
  },

  pay_money_request(ctx, requestId, method = null) {
    const { db } = ctx;
    const q = need(db.money_requests, requestId);
    const me = requireMember(ctx, q.trip_id);
    let m = typeof method === 'string' && method.trim() ? method.trim() : 'bit';
    if (m === 'bank') m = 'transfer';
    if (!PAY_METHODS.includes(m)) bad();
    const x = db.money_request_members.find((r) => r.request_id === q.id && r.member_id === me.id);
    if (!x || q.status !== 'open') fail('not_allowed_state');
    if (x.payment_id) return x.payment_id;
    // a couple that pays each their own part (§19): my part; no person on this device → what's left of the share
    const person = myPersonIn(ctx, me);
    const parts = partsOf(db, q.id, me.id);
    const own = person ? parts.find((pt) => pt.person === person) : null;
    let amount;
    if (own) {
      if (own.payment_id) return own.payment_id;
      if (q.expense_id && partyBalance(db, q.trip_id, me.id, person) >= -1) fail('already_settled');
      amount = Number(own.amount);
    } else if (parts.length) {
      amount = Math.round(parts.filter((pt) => !pt.payment_id).reduce((n, pt) => n + Number(pt.amount) * 100, 0)) / 100;
      if (!(amount > 0)) fail('not_allowed_state');
      if (q.expense_id && memberBalance(db, q.trip_id, me.id) >= -1) fail('already_settled');
    } else {
      if (q.expense_id && memberBalance(db, q.trip_id, me.id) >= -1) fail('already_settled');
      amount = Number(x.amount);
    }
    const pay = { id: newId(), trip_id: q.trip_id, from_member: me.id, to_member: q.requested_by, amount, method: m,
      note: q.title.slice(0, 200), status: 'sent', created_by: me.id, created_at: ctx.now(), confirmed_at: null,
      from_person: person, to_person: personOf(byId(db.members, q.requested_by), q.by_person ?? null) };
    db.payments.push(pay);
    if (own) own.payment_id = pay.id;
    else if (parts.length) {
      for (const pt of parts) if (!pt.payment_id) pt.payment_id = pay.id;
    } else x.payment_id = pay.id;
    settleRequestRow(db, q.id, me.id, pay.id);
    if (q.expense_id) coverIfEven(ctx, pay);                 // even now: my other shares on their requests are covered too
    notify(ctx, q.trip_id, {
      title: `💰 ${fmtShekel(amount)} מ${actorName(ctx, me)} על ${q.title}`,
      body: 'לאשר שקיבלת?', audience: [q.requested_by], link: `#/t/${q.trip_id}/money`,
    });
    bump(ctx, q.trip_id);
    return pay.id;
  },

  settle_money_request_share(ctx, requestId, memberId, person = null) {
    const { db } = ctx;
    const q = need(db.money_requests, requestId);
    const me = requireMember(ctx, q.trip_id);
    if (me.id !== q.requested_by) fail('forbidden');            // only who got the money says so
    const x = db.money_request_members.find((r) => r.request_id === q.id && r.member_id === memberId);
    if (!x || q.status !== 'open') fail('not_allowed_state');
    const toPerson = personOf(byId(db.members, q.requested_by), q.by_person ?? null);
    const cash = (amount, fromPerson) => {
      const y = { id: newId(), trip_id: q.trip_id, from_member: memberId, to_member: q.requested_by, amount, method: 'cash',
        note: q.title.slice(0, 200), status: 'confirmed', created_by: me.id, created_at: ctx.now(), confirmed_at: ctx.now(),
        from_person: fromPerson, to_person: toPerson };
      db.payments.push(y);
      return y;
    };
    const confirm = (y) => {
      y.status = 'confirmed';
      y.confirmed_at = y.confirmed_at || ctx.now();
      return y;
    };
    let pay;
    const all = partsOf(db, q.id, memberId);
    if (all.length) {
      // one person's part of a couple that pays each their own part (§19); no person = every part still open
      if (person != null && !all.some((pt) => pt.person === person)) fail('not_allowed_state');
      const people = byId(db.members, memberId)?.people || [];
      const parts = all.filter((pt) => person == null || pt.person === person)
        .sort((a, b) => people.indexOf(a.person) - people.indexOf(b.person));
      for (const pt of parts) {
        const y = pt.payment_id ? db.payments.find((z) => z.id === pt.payment_id) : null;
        pay = y ? confirm(y) : cash(pt.amount, pt.person);
        pt.payment_id = pay.id;
      }
      settleRequestRow(db, q.id, memberId, pay.id);
    } else {
      pay = x.payment_id ? db.payments.find((y) => y.id === x.payment_id) : null;
      if (pay) confirm(pay);
      else {
        pay = cash(x.amount, null);
        x.payment_id = pay.id;
      }
    }
    if (q.expense_id) coverIfEven(ctx, pay);
    closeMoneyRequestIfDone(ctx, pay.id);
    bump(ctx, q.trip_id);
    return pay.id;
  },

  cancel_money_request(ctx, requestId) {
    const { db } = ctx;
    const q = need(db.money_requests, requestId);
    const me = requireMember(ctx, q.trip_id);
    if (me.id !== q.requested_by && !amAdmin(ctx, me)) fail('forbidden');
    if (q.status === 'closed') return null;
    q.status = 'closed';
    if (q.expense_id && !q.linked_expense) {
      const rows = db.money_request_members.filter((x) => x.request_id === q.id);
      const paid = rows.filter((x) => requestRowPaid(db, x) > 0);
      if (paid.length) {
        // keep what was paid as my expense (a couple's paid part too, §19); drop the unpaid shares
        const unpaid = new Set(rows.filter((x) => !(requestRowPaid(db, x) > 0)).map((x) => x.member_id));
        remove(db.expense_shares, (s) => s.expense_id === q.expense_id && unpaid.has(s.member_id));
        for (const x of rows.filter((r) => !r.payment_id && requestRowPaid(db, r) > 0)) {
          const sh = db.expense_shares.find((s) => s.expense_id === q.expense_id && s.member_id === x.member_id);
          if (sh) sh.weight = requestRowPaid(db, x);
        }
        const exp = db.expenses.find((e) => e.id === q.expense_id);
        if (exp) exp.amount = moneyVal(Math.round(paid.reduce((n, x) => n + requestRowPaid(db, x) * 100, 0)) / 100 + Number(q.self_amount || 0));
      } else {
        remove(db.expense_shares, (s) => s.expense_id === q.expense_id);
        remove(db.expenses, (e) => e.id === q.expense_id);
        q.expense_id = null;
      }
    }
    const left = db.money_request_members.filter((x) => x.request_id === q.id && !x.payment_id).map((x) => x.member_id);
    if (left.length) {
      notify(ctx, q.trip_id, {
        title: q.linked_expense ? `✔️ ${q.title}: נשאר בהתחשבנות` : `✔️ ${q.title}: לא צריך להעביר`,
        body: 'הבקשה נסגרה',
        audience: left, link: `#/t/${q.trip_id}/money`,
      });
    }
    bump(ctx, q.trip_id);
    return null;
  },

  /** SQL add_money_request_member: someone who joined after the request is added to it by the requester / an admin. */
  add_money_request_member(ctx, requestId, memberId, amount = null) {
    const { db } = ctx;
    const q = need(db.money_requests, requestId);
    const me = requireMember(ctx, q.trip_id);
    if (me.id !== q.requested_by && !amAdmin(ctx, me)) fail('forbidden');
    if (q.status !== 'open') fail('not_allowed_state');
    if (!db.members.some((x) => x.id === memberId && x.trip_id === q.trip_id)) bad();
    if (memberId === q.requested_by || db.money_request_members.some((x) => x.request_id === q.id && x.member_id === memberId)) bad();
    let value;
    if (q.linked_expense && q.expense_id) {
      // the shares follow the expense as it splits now (an "everyone" expense re-splits when someone joins)
      const exp = db.expenses.find((x) => x.id === q.expense_id);
      const inTrip = (r) => r.trip_id === q.trip_id;
      const snapNow = { trip: db.trips.find((t) => t.id === q.trip_id), members: db.members.filter(inTrip), expense_shares: db.expense_shares.filter(inTrip) };
      const shares = new Map(expenseShares(exp, snapNow).map((x) => [x.member_id, x.amount]));
      for (const x of db.money_request_members.filter((r) => r.request_id === q.id && !r.payment_id)) {
        if (partsOf(db, q.id, x.member_id).some((pt) => pt.payment_id)) continue;
        const a = shares.get(x.member_id) || 0;
        if (!(a > 0)) continue;
        x.amount = a;
        remove(db.money_request_parts, (pt) => pt.request_id === q.id && pt.member_id === x.member_id);
        buildRequestParts(db, q.id, x.member_id);
      }
      value = shares.get(memberId) || 0;
      if (!(value > 0)) bad();                                       // they have no part in that expense
    } else value = moneyVal(amount);
    db.money_request_members.push({ request_id: q.id, trip_id: q.trip_id, member_id: memberId, amount: value, payment_id: null });
    buildRequestParts(db, q.id, memberId);
    if (q.expense_id && !q.linked_expense) {
      // "already paid": the request's own expense grows by the new share
      const sh = db.expense_shares.find((s) => s.expense_id === q.expense_id && s.member_id === memberId);
      if (sh) sh.weight = Number(sh.weight) + value;
      else db.expense_shares.push({ expense_id: q.expense_id, trip_id: q.trip_id, member_id: memberId, weight: value });
      const exp = db.expenses.find((x) => x.id === q.expense_id);
      if (exp) exp.amount = moneyVal(Math.round((Number(exp.amount) + value) * 100) / 100);
    }
    const who = (typeof q.by_person === 'string' && q.by_person.trim()) || byId(db.members, q.requested_by)?.display_name || '';
    const methods = q.methods || {};
    const how = [q.due && `עד ${q.due.slice(8, 10)}.${q.due.slice(5, 7)}`, methods.bit && `ביט ${methods.bit}`, methods.paybox && `פייבוקס ${methods.paybox}`,
      methods.bank && 'העברה בנקאית', methods.cash && 'מזומן'].filter(Boolean).join(' · ');
    const parts = partsOf(db, q.id, memberId).map((pt) => `${pt.person} ${fmtShekel(pt.amount)}`).join(' · ');
    notify(ctx, q.trip_id, {
      title: `💰 ${fmtShekel(value)} ל${who} · ${q.title}`,
      body: [parts, how].filter(Boolean).join('\n') || null,
      audience: [memberId], link: `#/t/${q.trip_id}/money`,
    });
    bump(ctx, q.trip_id);
    return null;
  },

  record_money_request_expense(ctx, requestId, amount = null) {
    const { db } = ctx;
    const q = need(db.money_requests, requestId);
    const me = requireMember(ctx, q.trip_id);
    if (me.id !== q.requested_by && !amAdmin(ctx, me)) fail('forbidden');
    if (q.expense_id) fail('not_allowed_state');
    if (db.expenses.filter((e) => e.trip_id === q.trip_id).length >= 300) fail('limit_reached');
    // while open: every share; after it closed: what was paid (a couple's paid parts too, §19)
    const rows = db.money_request_members.filter((x) => x.request_id === q.id)
      .map((x) => ({ member_id: x.member_id, weight: q.status === 'open' ? Number(x.amount) : requestRowPaid(db, x) }))
      .filter((x) => x.weight > 0);
    const self = Number(q.self_amount || 0);
    const sum = Math.round(rows.reduce((n, x) => n + x.weight * 100, 0)) / 100 + self;
    if (!(sum > 0)) fail('not_allowed_state');               // nothing collected
    const exp = {
      id: newId(), trip_id: q.trip_id, title: q.title, amount: amount == null ? moneyVal(sum) : moneyVal(amount), paid_by: q.requested_by,
      category_id: null, note: 'נאסף בבקשת תשלום 💰', split_mode: 'members', created_by: me.id, spent_on: jerusalemYmd(new Date()),
      created_at: ctx.now(), currency: null, orig_amount: null, rate: null,
      paid_by_person: personOf(byId(db.members, q.requested_by), q.by_person ?? null),
    };
    db.expenses.push(exp);
    for (const x of rows) db.expense_shares.push({ expense_id: exp.id, trip_id: q.trip_id, member_id: x.member_id, weight: x.weight });
    if (self > 0) db.expense_shares.push({ expense_id: exp.id, trip_id: q.trip_id, member_id: q.requested_by, weight: self });
    q.expense_id = exp.id;
    bump(ctx, q.trip_id);
    return exp.id;
  },

  delete_payment(ctx, id) {
    const { db } = ctx;
    const pay = need(db.payments, id);
    const me = requireMember(ctx, pay.trip_id);
    if (!amAdmin(ctx, me)) {
      if (pay.created_by !== me.id) fail('forbidden');
      if (pay.status === 'confirmed') fail('not_allowed_state');
    }
    for (const x of db.money_request_members) if (x.payment_id === pay.id) x.payment_id = null;
    for (const x of db.money_request_parts) {
      if (x.payment_id !== pay.id) continue;
      x.payment_id = null;
      // a couple's part (§19): the row was marked paid with its last part — one part open again, so is the row
      const row = db.money_request_members.find((r) => r.request_id === x.request_id && r.member_id === x.member_id);
      if (row) row.payment_id = null;
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
    if (!amAdmin(ctx, me) && n.author_member !== me.id) fail('forbidden');
    remove(db.notification_reads, (r) => r.notification_id === n.id);
    remove(db.notifications, (x) => x.id === n.id);
    bump(ctx, n.trip_id);
    return null;
  },

  mark_read(ctx, tripId, ids) {
    const { db } = ctx;
    const me = requireMember(ctx, tripId);
    if (ids != null && !Array.isArray(ids)) bad();
    const admin = amAdmin(ctx, me);
    let added = 0;
    const person = myLink(db, tripId, ctx.uid)?.person || null;
    for (const id of new Set(ids || [])) {
      const n = byId(db.notifications, id);
      if (!n || n.trip_id !== tripId || !canSeeNotification(n, me, admin)) continue;
      const row = db.notification_reads.find((r) => r.notification_id === n.id && r.member_id === me.id);
      if (row) {
        // per person: my name joins its readers (a device with no person reads it for the whole profile)
        if (!Array.isArray(row.persons) || (person && row.persons.includes(person))) continue;
        row.persons = person ? [...row.persons, person] : null;
        added++;
        continue;
      }
      db.notification_reads.push({ notification_id: n.id, trip_id: tripId, member_id: me.id, read_at: ctx.now(), persons: person ? [person] : null });
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
    if (!amAdmin(ctx, me) && poll.created_by !== me.id) fail('forbidden');
    poll.closed = toBool(closed);
    bump(ctx, poll.trip_id);
    return null;
  },

  delete_poll(ctx, pollId) {
    const { db } = ctx;
    const poll = need(db.polls, pollId);
    const me = requireMember(ctx, poll.trip_id);
    if (!amAdmin(ctx, me) && poll.created_by !== me.id) fail('forbidden');
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

  /** "Seen lately": at most once a minute per device; never bumps rev (no refetch for anyone). */
  // ---- invites from past trips + "הבית שלי" (SPEC §16.1) ----

  trip_contacts(ctx, tripId) {
    requireAdmin(ctx, tripId);
    return contactsOf(ctx, tripId).slice(0, 200).map((c) => ({
      key: contactKey(ctx.db, c.email, tripId), name: c.name, email_hint: emailHint(c.email), trips: c.trips, state: c.state,
    }));
  },

  invite_contacts(ctx, tripId, keys, memberId = null) {
    const { db } = ctx;
    const me = requireAdmin(ctx, tripId);
    const list = Array.isArray(keys) ? [...new Set(keys.filter((k) => typeof k === 'string' && k.trim()))] : [];
    if (!Array.isArray(keys) || !list.length || keys.length > 30) bad();
    if (memberId != null && (list.length !== 1 || !db.members.some((m) => m.id === memberId && m.trip_id === tripId && !m.claimed_at))) bad();
    if (memberId != null && db.trip_invites.some((i) => i.member_id === memberId && i.status === 'pending')) fail('not_allowed_state');
    const byKey = new Map(contactsOf(ctx, tripId).map((c) => [contactKey(db, c.email, tripId), c]));
    const skipped = [];
    const add = [];
    for (const key of list) {
      const c = byKey.get(key);
      if (!c) skipped.push({ key, reason: 'unknown' });
      else if (c.state) skipped.push({ key, reason: c.state });
      else add.push(c);
    }
    const pending = db.trip_invites.filter((i) => i.trip_id === tripId && i.status === 'pending' && !emailInTrip(db, tripId, i.email)).length;
    if (membersOf(db, tripId).length + pending + add.length > LIMITS.members) fail('limit_reached');
    const uids = myEmailsUids(db, ctx.uid);
    const dayAgo = Date.parse(ctx.now()) - 86400000;
    const today = db.trip_invites.filter((i) => uids.includes(i.invited_by_user) && Date.parse(i.created_at) > dayAgo).length;
    if (add.length && today + add.length > 30) fail('rate_limited');
    const placeholder = memberId ? byId(db.members, memberId) : null;
    const trip = byId(db.trips, tripId);
    const by = [...(myLink(db, tripId, ctx.uid)?.person ?? me.display_name)].slice(0, 40).join('');
    for (const c of add) {
      const inv = {
        id: newId(), trip_id: tripId, email: c.email, name: c.name, member_id: memberId ?? null, invited_by: me.id,
        invited_by_name: by, status: 'pending', created_at: ctx.now(), answered_at: null, invited_by_user: ctx.uid,
        person: !placeholder ? null : (placeholder.people || []).includes(c.name) ? c.name
          : (placeholder.people || []).length === 1 ? placeholder.people[0] : null,
        stop_token: newId(),
      };
      db.trip_invites.push(inv);
      // push + e-mail to the invitee only: nobody in the trip sees it (audience [])
      db.notifications.push({
        id: newId(), trip_id: tripId, kind: 'system', title: [...`${trip.emoji || '⛺'} הזמנה מ${by}: ${trip.name}`].slice(0, 80).join(''),
        body: 'להצטרף בלחיצה', audience: [], author_member: null, urgent: false,
        link: `#/invite/${inv.id}`, topic: 'assignments', invite_id: inv.id, created_at: ctx.now(),
      });
    }
    bump(ctx, tripId);
    return { invited: add.length, skipped };
  },

  my_invites(ctx) {
    const { db } = ctx;
    const email = emailOfUser(db, ctx.uid);
    if (!email) return [];
    const accountName = db.accounts.find((a) => a.email === email)?.name?.trim() || null;
    const now = Date.parse(ctx.now());
    return db.trip_invites
      .filter((i) => i.email === email && i.status === 'pending')
      .map((i) => ({ i, t: byId(db.trips, i.trip_id) }))
      .filter(({ t }) => t && (!t.starts_at || Date.parse(t.ends_at ?? t.starts_at) + (t.ends_at ? 0 : 86400000) >= now))
      .filter(({ t }) => !myLink(db, t.id, ctx.uid))
      .sort((a, b) => (a.t.starts_at == null) - (b.t.starts_at == null) || cmp(a.t.starts_at, b.t.starts_at)
        || byCreated(a.i, b.i) || cmp(a.i.id, b.i.id))
      .map(({ i, t }) => {
        const members = membersOf(db, t.id);
        const target = inviteTarget(ctx, i, email, [...(accountName || i.name)].slice(0, 40).join(''));
        return {
          id: i.id, created_at: i.created_at, invited_by_name: i.invited_by_name, name: i.name,
          trip: pick(t, K.tripBrief),
          member_count: members.length,
          headcount: members.reduce((s, m) => s + m.headcount, 0),
          partners: target ? [] : partnersFor(db, email, t.id),
          joinable: target ? {
            member_id: target.member_id,
            display_name: byId(db.members, target.member_id)?.display_name ?? null,
            person: target.person ?? null,
            choose: target.how === 'placeholder' && target.person == null ? [...(byId(db.members, target.member_id)?.people || [])] : null,
          } : null,
        };
      });
  },

  respond_invite(ctx, inviteId, accept, withNames = null, pickPerson = null) {
    const { db } = ctx;
    const email = emailOfUser(db, ctx.uid);
    if (!email) fail('email_not_verified');
    const inv = typeof inviteId === 'string' ? db.trip_invites.find((i) => i.id === inviteId) : null;
    if (!inv) fail('not_found');
    if (inv.email !== email) fail('forbidden');
    if (inv.status !== 'pending') fail('not_allowed_state');
    if (accept == null) bad();
    const tripId = inv.trip_id;
    const account = db.accounts.find((a) => a.email === email) || null;
    const name = [...((account?.name && account.name.trim()) || inv.name)].slice(0, 40).join('');
    const link = `#/t/${tripId}/people`;
    const tell = (title, audience, body = null) => {
      if (audience.length) notify(ctx, tripId, { title, body, audience, link });
    };
    if (!accept) {
      inv.status = 'declined';
      inv.answered_at = ctx.now();
      if (inv.invited_by) tell(`הפעם בלי ${name}`, [inv.invited_by]);
      bump(ctx, tripId);
      return null;
    }
    const mine = myLink(db, tripId, ctx.uid);
    if (mine) {
      Object.assign(inv, { status: 'accepted', answered_at: ctx.now(), member_id: mine.member_id });
      bump(ctx, tripId);
      return { trip_id: tripId, member_id: mine.member_id };
    }
    const target = inviteTarget(ctx, inv, email, name);
    let member;
    let person;
    if (target) {
      member = byId(db.members, target.member_id);
      person = target.person;
      if (target.how === 'placeholder') {
        if (typeof pickPerson === 'string' && pickPerson.trim()) person = pickPerson.trim();
        if (person == null || !(member.people || []).includes(person)) bad();
        member.claimed_at = ctx.now();
      }
      if (target.how === 'listed') freezeAdmins(db, member, person); // stepping in never brings the profile's rights
    } else {
      const partners = partnersFor(db, email, tripId);
      const withList = [...new Set((Array.isArray(withNames) ? withNames : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];
      if (withList.some((x) => x === name || !partners.includes(x)) || 1 + withList.length > 8) bad();
      if (membersOf(db, tripId).length >= LIMITS.members) fail('limit_reached');
      const people = [name, ...withList];
      const last = db.member_users
        .filter((l) => myEmailsUids(db, ctx.uid).includes(l.user_id) && l.trip_id !== tripId)
        .map((l) => byId(db.members, l.member_id)).filter(Boolean).sort((a, b) => cmp(b.created_at, a.created_at))[0];
      const phone = people.length === 1 && String(account?.prefs?.share_phone) !== 'false' ? account?.phone ?? null : null;
      member = newMemberRow(ctx, tripId, {
        display_name: [...people.join(' ו')].slice(0, 40).join(''), people, headcount: people.length,
        emoji: last?.emoji, color: last?.color, phone,
      }, 'member', true);
      db.members.push(member);
      person = name;
      // the partners' verified e-mails (from the profiles we shared) → mail + "sign in with your e-mail"
      const myProfiles = new Set(db.member_users.filter((l) => l.person != null && emailOfUser(db, l.user_id) === email).map((l) => l.member_id));
      const emails = new Set(db.member_users
        .filter((l) => myProfiles.has(l.member_id) && withList.includes(l.person))
        .map((l) => emailOfUser(db, l.user_id)).filter((e) => e && e !== email));
      for (const e of emails) {
        if (!db.member_emails.some((x) => x.member_id === member.id && x.email === e)) {
          db.member_emails.push({ member_id: member.id, trip_id: tripId, email: e, token: newId(), created_at: ctx.now() });
        }
      }
    }
    for (const u of myEmailsUids(db, ctx.uid)) {
      if (db.member_users.some((l) => l.user_id === u && l.trip_id === tripId)) continue;
      db.member_users.push({ user_id: u, trip_id: tripId, member_id: member.id, person, legacy: false, last_seen_at: null, created_at: ctx.now() });
    }
    Object.assign(inv, { status: 'accepted', answered_at: ctx.now(), member_id: member.id });
    const uids = myEmailsUids(db, ctx.uid);
    remove(db.profile_requests, (r) => uids.includes(r.user_id) && r.trip_id === tripId && r.status === 'pending');
    if (target?.how !== 'device') {
      if (target?.how === 'listed') tell(`🙋 ${person} בפרופיל שלכם עכשיו`, [member.id], 'לא מכירים? מסירים במסך החבר׳ה');
      if (inv.invited_by && byId(db.members, inv.invited_by)) tell(`🎉 ההזמנה עבדה — ${name} בטיול`, [inv.invited_by]);
      tell(`🎉 ${name} איתנו בטיול`, membersOf(db, tripId).filter((m) => isAdmin(m) && m.id !== inv.invited_by && m.id !== member.id)
        .sort((a, b) => byCreated(a, b) || cmp(a.id, b.id)).map((m) => m.id));
    }
    bump(ctx, tripId);
    return { trip_id: tripId, member_id: member.id };
  },

  cancel_invite(ctx, inviteId) {
    const { db } = ctx;
    const inv = typeof inviteId === 'string' ? db.trip_invites.find((i) => i.id === inviteId) : null;
    if (!inv) fail('forbidden');
    requireAdmin(ctx, inv.trip_id);
    if (inv.status !== 'pending') fail('not_allowed_state');
    inv.status = 'cancelled';
    inv.answered_at = ctx.now();
    bump(ctx, inv.trip_id);
    return null;
  },

  my_overview(ctx) {
    const { db } = ctx;
    const today = jerusalemYmd(new Date(ctx.now()));
    return RPC.my_trips(ctx).map(({ trip: brief }) => {
      const trip = byId(db.trips, brief.id);
      const tripId = trip.id;
      const inTrip = (r) => r.trip_id === tripId;
      const link = myLink(db, tripId, ctx.uid);
      const m = byId(db.members, link.member_id);
      const admin = personAdmin(m, link);
      const money = moduleOn(trip, 'money');
      const rides = moduleOn(trip, 'rides');
      const items = new Map(db.items.filter(inTrip).map((i) => [i.id, i]));

      const visible = db.notifications.filter((n) => inTrip(n) && canSeeNotification(n, m, admin)).sort((a, b) => newest(a, b) || cmp(a.id, b.id)).slice(0, 200);
      const unread = visible.filter((n) => n.author_member !== m.id
        && !db.notification_reads.some((r) => r.notification_id === n.id && r.member_id === m.id && readByMe(r, m, link.person)));

      const hasMoney = db.expenses.some(inTrip) || db.payments.some(inTrip);
      const bal = () => Math.round(memberBalance(db, tripId, m.id));
      const owed = !money ? [] : db.money_request_members
        .filter((x) => x.member_id === m.id && !x.payment_id)
        .map((x) => ({ x, q: db.money_requests.find((r) => r.id === x.request_id) }))
        .filter(({ q }) => q && q.trip_id === tripId && q.status === 'open' && (!q.expense_id || bal() < -1))
        .sort((a, b) => (a.q.due == null) - (b.q.due == null) || cmp(a.q.due, b.q.due) || byCreated(a.q, b.q) || cmp(a.q.id, b.q.id));
      const dues = owed.map(({ q }) => q.due).filter(Boolean).sort();

      let arrival = null;
      const seats = db.ride_seats.filter((s) => inTrip(s) && s.member_id === m.id);
      if (rides && !db.rides.some((r) => inTrip(r) && r.driver_member === m.id) && !seats.some((s) => s.status === 'approved')) {
        const mode = m.prefs?.transport?.mode || null;
        if (seats.some((s) => s.status === 'pending' && s.requested_by === 'passenger')) arrival = 'waiting';
        else if (mode == null) arrival = 'missing';
        else if (mode === 'need') arrival = 'seeking';
      }
      const bookings = Array.isArray(trip.info?.bookings) ? trip.info.bookings : [];

      const myPledges = db.pledges.filter((p) => inTrip(p) && p.member_id === m.id);
      const open = myPledges.map((p) => ({ p, i: items.get(p.item_id) }))
        .filter(({ p, i }) => i && i.status === 'active' && pledgeOpen(i.type, i.done, p.done) && itemOnIn(trip, i.type))
        .sort((a, b) => bySort(a.i, b.i) || cmp(a.i.id, b.i.id));
      const unclaimed = [...items.values()].filter((i) => i.status === 'active' && ['buy', 'bring', 'task'].includes(i.type)
        && itemOnIn(trip, i.type) && !db.pledges.some((p) => p.item_id === i.id));

      return {
        trip: {
          ...pick(trip, K.tripBrief), type: trip.settings?.type ?? null,
          modules: isObj(trip.settings?.modules) ? { ...trip.settings.modules } : {},
          flights: trip.settings?.arrival?.flights === true,
        },
        member: { ...pick(m, K.memberBrief), role: admin ? m.role : 'member' },
        person: link.person ?? null,
        admin,
        unread: unread.length,
        urgent_unread: unread.filter((n) => n.urgent).length,
        balance: money && hasMoney ? bal() : null,
        owe: {
          count: owed.length,
          total: round2(owed.reduce((s, { x }) => s + Number(x.amount), 0)),
          overdue: owed.some(({ q }) => q.due && q.due < today),
          next_due: dues[0] ?? null,
          items: owed.slice(0, 3).map(({ x, q }) => ({
            request_id: q.id, title: q.title, amount: x.amount, due: q.due ?? null, to_name: byId(db.members, q.requested_by)?.display_name ?? null,
          })),
        },
        confirm: money ? db.payments.filter((y) => inTrip(y) && y.to_member === m.id && y.status === 'sent').length : 0,
        answers: {
          ride_asks: rides ? db.ride_seats.filter((s) => inTrip(s) && s.status === 'pending' && s.requested_by === 'passenger'
            && db.rides.some((r) => r.id === s.ride_id && r.driver_member === m.id)).length : 0,
          ride_invites: rides ? seats.filter((s) => s.status === 'pending' && s.requested_by === 'driver').length : 0,
          assignments: myPledges.filter((p) => p.assigned_by && p.assigned_by !== m.id && !p.accepted_at
            && items.get(p.item_id)?.status === 'active' && itemOnIn(trip, items.get(p.item_id).type)).length,
          profile_requests: db.profile_requests.filter((r) => inTrip(r) && r.member_id === m.id && r.status === 'pending').length,
        },
        arrival,
        flight_missing: rides && trip.settings?.arrival?.flights === true && !m.prefs?.travel?.out?.flight
          && !bookings.some((b) => b?.kind === 'flight' && b.flight),
        open: {
          count: open.length,
          titles: open.slice(0, 3).map(({ i }) => i.title),
          personal: moduleOn(trip, 'packing') ? db.personal_items.filter((pi) => inTrip(pi) && pi.member_id === m.id && !pi.done).length : 0,
        },
        took_nothing: !myPledges.some((p) => items.get(p.item_id) && itemOnIn(trip, items.get(p.item_id).type)) && unclaimed.length > 0,
        polls: moduleOn(trip, 'polls') ? db.polls.filter((pl) => inTrip(pl) && !pl.closed
          && !db.poll_votes.some((v) => v.poll_id === pl.id && v.member_id === m.id)).length : 0,
        admin_info: !admin ? null : {
          proposed: [...items.values()].filter((i) => i.status === 'proposed' && itemOnIn(trip, i.type)).length,
          unclaimed_items: unclaimed.filter((i) => !i.done).length,
          not_joined: membersOf(db, tripId).filter((x) => !x.claimed_at).length,
          profile_requests: db.profile_requests.filter((r) => inTrip(r) && r.status === 'pending').length,
          invites_pending: db.trip_invites.filter((i) => inTrip(i) && i.status === 'pending' && !emailInTrip(db, tripId, i.email)).length,
          gaps: moduleGaps(db, tripId).filter((g) => g.total > g.done).map((g) => ({ key: g.key, missing: g.total - g.done, total: g.total })),
        },
      };
    });
  },

  touch_presence(ctx, tripId) {
    const { db } = ctx;
    const link = typeof tripId === 'string' ? myLink(db, tripId, ctx.uid) : null;
    if (!link) return null;
    const email = db.user_contacts.find((c) => c.user_id === ctx.uid)?.email;
    const hidden = Boolean(email) && optedOut(db.accounts.find((a) => a.email === email)?.prefs, 'presence');
    if (hidden) {
      // turned off in "אני": cleared (right away), never written
      if (link.last_seen_at == null) return null;
      link.last_seen_at = null;
    } else {
      const now = ctx.now();
      if (link.last_seen_at && Date.parse(link.last_seen_at) >= Date.parse(now) - 30000) return null;
      link.last_seen_at = now;
    }
    ctx.dirty = true; // saved, but no bump → no change event
    return null;
  },
};

/**
 * Demo-only (api.demo.actAs): this device becomes `memberId` (as `person`, default its first) within its trip.
 * The profile it leaves keeps a stand-in device when nobody else is on it (its person is still "on their phone"),
 * so its rights stay where they were; acting as that person again takes the stand-in's place.
 */
function actAsMember(ctx, memberId, person = null) {
  const { db } = ctx;
  const member = need(db.members, memberId);
  const people = member.people || [];
  const given = typeof person === 'string' && person.trim() ? person.trim() : null;
  if (given && !people.includes(given)) bad();
  const who = given ?? people[0] ?? null;
  const prev = myLink(db, member.trip_id, ctx.uid);
  if (prev) {
    const left = byId(db.members, prev.member_id);
    remove(db.member_users, (l) => l === prev);
    if (left && left.claimed_at && !linksOf(db, left.id).length) db.member_users.push({ ...prev, user_id: newId(), stand_in: true });
  }
  const standIn = db.member_users.find((l) => l.member_id === member.id && l.stand_in && l.person === who);
  if (standIn) remove(db.member_users, (l) => l === standIn);
  db.member_users.push({
    user_id: ctx.uid, trip_id: member.trip_id, member_id: member.id, person: who,
    legacy: Boolean(standIn?.legacy), last_seen_at: standIn?.last_seen_at ?? null, created_at: ctx.now(),
  });
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
      // a demo database from before a new table (e.g. money_request_parts) just gets it, empty
      if (isObj(db) && db.version === DEMO_VERSION) for (const t of TABLES) if (db[t] === undefined) db[t] = [];
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
    if (!db.contact_secret) {
      contactSecret(db); // made once per demo database (like app_secrets 'contact_key')
      save(db);
    }
    const ctx = { db, uid, now: stamp, dirty: false, touched: new Set() };
    const known = mutating ? stampKnown(db) : null;
    const out = fn(ctx, ...args);
    if (mutating && ctx.dirty) {
      stampPerson(db, uid, known);
      closeJoinedInvites(ctx);
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
    setPersonAdmin: (memberId, person, admin) => call('set_person_admin', memberId, person, Boolean(admin)),
    touchPresence: (tripId) => call('touch_presence', tripId),
    nudgeMembers: (tripId, module) => call('nudge_members', tripId, module),
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
    setEachPart: (itemId, patch) => call('set_each_part', itemId, patch),
    setItemDone: (itemId, done) => call('set_item_done', itemId, Boolean(done)),

    addPersonal: (tripId, title) => call('add_personal', tripId, title),
    addPersonalTemplate: (tripId) => call('add_personal_template', tripId),
    updatePersonal: (id, patch) => call('update_personal', id, patch),
    deletePersonal: (id) => call('delete_personal', id),

    addExpense: (tripId, exp) => call('add_expense', tripId, exp),
    updateExpense: (id, patch) => call('update_expense', id, patch),
    deleteExpense: (id) => call('delete_expense', id),

    addPayment: (tripId, pay) => call('add_payment', tripId, pay),
    createMoneyRequest: (tripId, req) => call('create_money_request', tripId, req),
    payMoneyRequest: (requestId, method) => call('pay_money_request', requestId, method ?? null),
    cancelMoneyRequest: (requestId) => call('cancel_money_request', requestId),
    settleMoneyRequestShare: (requestId, memberId, person) => call('settle_money_request_share', requestId, memberId, person ?? null),
    recordMoneyRequestExpense: (requestId, amount) => call('record_money_request_expense', requestId, amount ?? null),
    addMoneyRequestMember: (requestId, memberId, amount) => call('add_money_request_member', requestId, memberId, amount ?? null),
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

    // "הבית שלי" + invites from past trips (SPEC §16.1)
    myOverview: () => read('my_overview'),
    myInvites: () => read('my_invites'),
    tripContacts: (tripId) => read('trip_contacts', tripId),
    inviteContacts: (tripId, keys, { memberId } = {}) => call('invite_contacts', tripId, keys || [], memberId ?? null),
    respondInvite: (inviteId, accept, { with: names, person } = {}) =>
      call('respond_invite', inviteId, Boolean(accept), names?.length ? names : null, person ?? null),
    cancelInvite: (inviteId) => call('cancel_invite', inviteId),

    /** Fixture flights (DEMO_FLIGHTS in demo-seed.js); resolves { ok, cached, flight } | { ok:false, error, message }. */
    lookupFlight: (tripId, number, date) => read('flight_lookup', tripId, number, date),

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

      /** Re-link the current demo user to another member (of that member's trip), as one of its people. */
      actAs(memberId, person = null) {
        return exec(actAsMember, [memberId, person ?? null]);
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
