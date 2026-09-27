// Scenario tests for the demo backend, driven only through the public API (SPEC §3–§5, §7.2).
// Runs in a real browser via tests/web/api.html (see tests/test_api.py).

import { createDemoApi, DEMO_STORAGE_KEY, DEMO_UID_KEY } from '../../js/api/demo-api.js';
import { ApiError } from '../../js/api/errors.js';
import { DEFAULT_CATEGORIES, PERSONAL_TEMPLATE, SAMPLE_TRIP_NAME } from '../../js/api/demo-seed.js';

// ---------- tiny harness ----------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

class AssertionError extends Error {}
const show = (v) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};
function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new AssertionError(msg);
}
function eq(actual, expected, msg = 'eq') {
  if (actual !== expected) throw new AssertionError(`${msg}: expected ${show(expected)}, got ${show(actual)}`);
}
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
function deepEq(actual, expected, msg = 'deepEq') {
  const a = show(canon(actual));
  const b = show(canon(expected));
  if (a !== b) throw new AssertionError(`${msg}: expected ${b}, got ${a}`);
}
function sameKeys(obj, keys, msg = 'keys') {
  deepEq(Object.keys(obj).sort(), [...keys].sort(), msg);
}
async function rejects(promise, code, msg = 'rejects') {
  try {
    await promise;
  } catch (e) {
    if (!(e instanceof ApiError)) throw new AssertionError(`${msg}: expected ApiError(${code}), got ${e && e.stack}`);
    eq(e.code, code, msg);
    assert(/[֐-׿]/.test(e.message), `${msg}: error message should be Hebrew`);
    return e;
  }
  throw new AssertionError(`${msg}: expected rejection with '${code}', but it resolved`);
}
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
    } catch (e) {
      failed++;
      failures.push({ name: t.name, error: String((e && e.stack) || e) });
    }
  }
  return { passed, failed, failures };
}

// ---------- fixtures ----------

const api = createDemoApi({ latency: [0, 2] });
const newUid = () => crypto.randomUUID();
const as = (uid) => api.demo.switchUser(uid);
const snap = (tripId) => api.getSnapshot(tripId);
const byName = (s, name) => s.members.find((m) => m.display_name === name);
const itemOf = (s, id) => s.items.find((i) => i.id === id);
const pledgesOf = (s, itemId) => s.pledges.filter((p) => p.item_id === itemId);

/** Reset the demo DB and return the sample trip as seen by its owner. */
async function fresh() {
  await as(newUid());
  await api.demo.reset();
  const [row] = await api.myTrips();
  return { tripId: row.trip.id, meId: row.member.id };
}

/** Reset, then create a new trip (owner) + two joined members B and C (all distinct users). */
async function newTrip({ requireApproval = true } = {}) {
  await api.demo.reset();
  const owner = newUid();
  await as(owner);
  const { trip_id: tripId, member_id: ownerMember } = await api.createTrip(
    { name: 'טיול בדיקה', settings: { require_approval: requireApproval } },
    { display_name: 'הבעלים', headcount: 2, people: ['אלון', 'בר'] },
  );
  const code = (await snap(tripId)).trip.invite_code;
  const join = async (name, headcount) => {
    const uid = newUid();
    await as(uid);
    const r = await api.joinTrip(code, { profile: { display_name: name, headcount } });
    return { uid, memberId: r.member_id };
  };
  const B = await join('בני', 1);
  const C = await join('כרמל', 2);
  await as(owner);
  return { tripId, code, owner: { uid: owner, memberId: ownerMember }, B, C };
}

// SPEC §5 — exact key sets.
const SHAPE = {
  top: ['trip', 'me', 'members', 'categories', 'items', 'pledges', 'expenses', 'expense_shares', 'payments', 'notifications', 'reads', 'admin_votes', 'polls', 'poll_votes', 'personal_items'],
  trip: ['id', 'name', 'emoji', 'location', 'location_url', 'lat', 'lon', 'starts_at', 'ends_at', 'info', 'settings', 'invite_code', 'rev', 'created_at'],
  info: ['schedule', 'rules', 'notes'],
  settings: ['require_approval'],
  me: ['member_id', 'role', 'user_id'],
  members: ['id', 'display_name', 'headcount', 'people', 'emoji', 'color', 'role', 'phone', 'prefs', 'inventory', 'claimed', 'created_at'],
  categories: ['id', 'name', 'emoji', 'sort', 'default_buyer_id', 'note'],
  items: ['id', 'category_id', 'title', 'note', 'type', 'qty', 'unit', 'per_person', 'needed', 'status', 'done', 'done_at', 'reject_reason', 'created_by', 'approved_by', 'sort', 'created_at', 'updated_at'],
  pledges: ['id', 'item_id', 'member_id', 'qty', 'done', 'assigned_by', 'created_at'],
  expenses: ['id', 'title', 'amount', 'paid_by', 'category_id', 'note', 'split_mode', 'created_by', 'spent_on', 'created_at'],
  expense_shares: ['expense_id', 'member_id', 'weight'],
  payments: ['id', 'from_member', 'to_member', 'amount', 'method', 'note', 'status', 'created_by', 'created_at', 'confirmed_at'],
  notifications: ['id', 'kind', 'title', 'body', 'audience', 'author_member', 'urgent', 'link', 'created_at'],
  reads: ['notification_id', 'member_id', 'read_at'],
  admin_votes: ['voter_id', 'candidate_id'],
  polls: ['id', 'question', 'options', 'multi', 'closed', 'created_by', 'created_at'],
  poll_options: ['id', 'label'],
  poll_votes: ['poll_id', 'member_id', 'option_id'],
  personal_items: ['id', 'title', 'done', 'sort', 'created_at'],
};

const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && v.includes('T');
const jlmYmd = (d) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// ---------- seed ----------

test('seed: sample trip owned by the demo user, 4 days ahead at 09:00 Jerusalem', async () => {
  const { tripId } = await fresh();
  const trips = await api.myTrips();
  eq(trips.length, 1, 'one trip');
  sameKeys(trips[0], ['trip', 'member']);
  sameKeys(trips[0].trip, ['id', 'name', 'emoji', 'location', 'starts_at', 'ends_at']);
  sameKeys(trips[0].member, ['id', 'display_name', 'emoji', 'color', 'role']);
  eq(trips[0].trip.name, SAMPLE_TRIP_NAME);
  eq(trips[0].member.display_name, 'נועה ואיתי');
  eq(trips[0].member.role, 'owner');

  const s = await snap(tripId);
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(s.trip.starts_at));
  eq(hhmm, '09:00', 'starts 09:00 Jerusalem');
  const days = (Date.parse(jlmYmd(new Date(s.trip.starts_at))) - Date.parse(jlmYmd(new Date()))) / 86400000;
  eq(days, 4, 'starts 4 days from today');
  assert(Date.parse(s.trip.ends_at) > Date.parse(s.trip.starts_at), 'ends after start');
  assert(s.trip.info.schedule.length > 0 && s.trip.info.rules.length > 0 && s.trip.info.notes, 'info filled');

  deepEq(s.members.map((m) => m.headcount), [2, 2, 1, 2, 1], 'headcounts');
  eq(s.members.filter((m) => !m.claimed).length, 1, 'one unclaimed placeholder');
  eq(s.members.filter((m) => m.role === 'admin').length, 1, 'one other admin');
  eq(s.me.member_id, byName(s, 'נועה ואיתי').id);
  deepEq(s.categories.map((c) => c.name), DEFAULT_CATEGORIES.map((c) => c.name), 'default categories');

  assert(s.items.length >= 25, `~25 items (got ${s.items.length})`);
  for (const type of ['buy', 'bring', 'each', 'task']) assert(s.items.some((i) => i.type === type), `type ${type}`);
  for (const st of ['active', 'proposed', 'rejected']) assert(s.items.some((i) => i.status === st), `status ${st}`);
  assert(s.items.some((i) => i.per_person && i.unit === 'גרם'), 'per_person grams');
  assert(s.items.some((i) => i.needed > 1), 'needed > 1');
  const sum = (id) => pledgesOf(s, id).reduce((a, p) => a + p.qty, 0);
  const bring = s.items.filter((i) => i.type === 'bring' && i.status === 'active');
  assert(bring.some((i) => sum(i.id) === 0), 'bring missing');
  assert(bring.some((i) => sum(i.id) > 0 && sum(i.id) < i.needed), 'bring partial');
  assert(bring.some((i) => sum(i.id) >= i.needed && pledgesOf(s, i.id).some((p) => !p.done)), 'bring covered');
  assert(bring.some((i) => sum(i.id) >= i.needed && pledgesOf(s, i.id).every((p) => p.done)), 'bring done');
  const buy = s.items.filter((i) => i.type === 'buy' && i.status === 'active');
  assert(buy.some((i) => i.done) && buy.some((i) => !i.done && sum(i.id) > 0) && buy.some((i) => sum(i.id) === 0), 'buy done/covered/missing');
  const each = s.items.filter((i) => i.type === 'each');
  assert(each.some((i) => pledgesOf(s, i.id).some((p) => p.done)) && each.some((i) => pledgesOf(s, i.id).length === 0), 'each partial/missing');
  assert(s.items.some((i) => i.type === 'task' && i.done), 'task done');
  assert(s.pledges.some((p) => p.assigned_by), 'an assigned pledge');

  eq(s.expenses.length, 3);
  assert(s.expenses.some((e) => e.split_mode === 'members') && s.expense_shares.length > 0, 'members split');
  deepEq(s.payments.map((p) => p.status).sort(), ['confirmed', 'sent']);
  const ann = s.notifications.filter((n) => n.kind === 'announcement');
  eq(ann.length, 2, 'two announcements');
  assert(ann.some((n) => Array.isArray(n.audience)) && ann.some((n) => n.audience === null), 'one targeted');
  assert(s.notifications.some((n) => n.kind === 'system'), 'system notifications');
  eq(s.polls.length, 1);
  eq(s.polls[0].closed, false);
  assert(s.poll_votes.length > 0, 'poll votes');
  assert(s.personal_items.length > 0, 'personal items');
  assert(s.admin_votes.length > 0, 'admin votes');
  assert(s.members.some((m) => m.inventory.length > 0), 'inventory');
});

test('snapshot: key sets and value types exactly match SPEC §5', async () => {
  const { tripId } = await fresh();
  const s = await snap(tripId);
  sameKeys(s, SHAPE.top, 'top-level');
  sameKeys(s.trip, SHAPE.trip, 'trip');
  sameKeys(s.trip.info, SHAPE.info, 'trip.info');
  sameKeys(s.trip.settings, SHAPE.settings, 'trip.settings');
  sameKeys(s.me, SHAPE.me, 'me');
  for (const key of SHAPE.top.filter((k) => k !== 'trip' && k !== 'me')) {
    assert(Array.isArray(s[key]), `${key} is an array`);
    assert(s[key].length > 0, `seed has ${key}`);
    for (const row of s[key]) sameKeys(row, SHAPE[key], key);
  }
  for (const p of s.polls) for (const o of p.options) sameKeys(o, SHAPE.poll_options, 'poll option');

  eq(typeof s.trip.rev, 'number');
  eq(typeof s.trip.lat, 'number');
  assert(isIso(s.trip.starts_at) && isIso(s.trip.created_at), 'trip ISO timestamps');
  eq(s.me.user_id, api.getUserId());
  for (const m of s.members) {
    assert(typeof m.headcount === 'number' && Array.isArray(m.people) && Array.isArray(m.inventory), 'member types');
    assert(typeof m.claimed === 'boolean' && typeof m.prefs === 'object' && m.prefs !== null, 'member claimed/prefs');
  }
  for (const i of s.items) {
    assert(i.qty === null || typeof i.qty === 'number', 'item qty number|null');
    assert(typeof i.per_person === 'boolean' && typeof i.done === 'boolean' && typeof i.needed === 'number', 'item types');
    assert(isIso(i.created_at) && isIso(i.updated_at), 'item timestamps');
  }
  for (const e of s.expenses) assert(typeof e.amount === 'number' && /^\d{4}-\d{2}-\d{2}$/.test(e.spent_on), 'expense types');
  for (const x of s.expense_shares) eq(typeof x.weight, 'number');
  for (const p of s.payments) eq(typeof p.amount, 'number');
  for (const n of s.notifications) assert(n.audience === null || Array.isArray(n.audience), 'audience null|array');
  for (let i = 1; i < s.notifications.length; i++) {
    assert(s.notifications[i - 1].created_at >= s.notifications[i].created_at, 'notifications newest first');
  }
});

test('snapshot: a plain member sees only own personal items / reads and no rejected items of others', async () => {
  const { tripId } = await fresh();
  const owner = await snap(tripId);
  const shira = byName(owner, 'שירה וטל');
  await api.demo.actAs(shira.id);
  const s = await snap(tripId);
  eq(s.me.member_id, shira.id);
  eq(s.me.role, 'member');
  eq(s.personal_items.length, 0, 'no personal items of others');
  assert(!s.items.some((i) => i.status === 'rejected'), 'rejected items of others hidden');
  assert(owner.items.some((i) => i.status === 'rejected'), 'owner sees them');
  assert(s.reads.every((r) => r.member_id === shira.id), 'only own reads');
  assert(s.notifications.every((n) => n.audience === null || n.audience.includes(shira.id)), 'only visible notifications');
  const ownerOnly = owner.notifications.filter((n) => n.audience && !n.audience.includes(shira.id) && n.author_member !== shira.id);
  assert(ownerOnly.length > 0 && ownerOnly.every((n) => !s.notifications.some((x) => x.id === n.id)), 'admin-only notifications hidden');
});

// ---------- trips & joining ----------

test('createTrip: creator is the claimed owner, default categories, invite code', async () => {
  await api.demo.reset();
  await as(newUid());
  deepEq(await api.myTrips(), [], 'new user has no trips');
  const r = await api.createTrip(
    { name: '  סופ"ש בגליל  ', emoji: '🌲', location: 'גליל', starts_at: '2026-10-08T06:00:00.000Z', ends_at: '2026-10-09T09:00:00.000Z' },
    { display_name: 'הדס ועידו', headcount: 2, people: ['הדס', 'עידו'], emoji: '🦊', color: '#E4572E', phone: '050-1234567' },
  );
  sameKeys(r, ['trip_id', 'member_id']);
  const s = await snap(r.trip_id);
  eq(s.trip.name, 'סופ"ש בגליל', 'trimmed name');
  eq(s.trip.emoji, '🌲');
  eq(s.trip.starts_at, '2026-10-08T06:00:00.000Z');
  eq(s.me.role, 'owner');
  eq(s.me.member_id, r.member_id);
  eq(s.members.length, 1);
  eq(s.members[0].claimed, true);
  deepEq(s.members[0].people, ['הדס', 'עידו']);
  deepEq(s.categories.map((c) => `${c.emoji} ${c.name}`), DEFAULT_CATEGORIES.map((c) => `${c.emoji} ${c.name}`));
  deepEq(s.categories.map((c) => c.sort), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert(/^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/.test(s.trip.invite_code), 'invite code alphabet');
  deepEq(s.trip.settings, { require_approval: true });
  deepEq(s.trip.info, { schedule: [], rules: [], notes: '' });
  eq(s.items.length, 0);

  await rejects(api.createTrip({ name: '' }, { display_name: 'x' }), 'invalid_input', 'empty name');
  await rejects(api.createTrip({ name: 'א'.repeat(61) }, { display_name: 'x' }), 'invalid_input', 'name > 60');
  await rejects(api.createTrip({ name: 'ok' }, { display_name: '' }), 'invalid_input', 'empty display name');
  await rejects(api.createTrip({ name: 'ok' }, { display_name: 'x', headcount: 9 }), 'invalid_input', 'headcount 9');
  await rejects(api.createTrip({ name: 'ok' }, { display_name: 'x', color: 'red' }), 'invalid_input', 'bad color');
  await rejects(api.createTrip({ name: 'ok', location_url: 'javascript:alert(1)' }, { display_name: 'x' }), 'invalid_input', 'unsafe url');
  await rejects(api.createTrip({ name: 'ok', starts_at: 'not a date' }, { display_name: 'x' }), 'invalid_input', 'bad date');
  eq((await api.myTrips()).length, 1, 'failed calls leave nothing behind');
});

test('preview → join → claim, idempotent join, already_claimed, join notice to admins', async () => {
  await api.demo.reset();
  const owner = newUid();
  await as(owner);
  const { trip_id: tripId, member_id: ownerMember } = await api.createTrip({ name: 'פארק החבשושיות' }, { display_name: 'לידור', headcount: 1 });
  const placeholder = await api.createMember(tripId, { display_name: 'תומר ושקד', headcount: 2, people: ['תומר', 'שקד'] });
  const code = (await snap(tripId)).trip.invite_code;

  const B = newUid();
  await as(B);
  const pv = await api.previewInvite(` ${code.toUpperCase()} `);
  sameKeys(pv, ['trip', 'member_count', 'headcount', 'unclaimed', 'my_member_id']);
  sameKeys(pv.trip, ['id', 'name', 'emoji', 'location', 'starts_at', 'ends_at']);
  eq(pv.member_count, 2);
  eq(pv.headcount, 3);
  eq(pv.my_member_id, null);
  eq(pv.unclaimed.length, 1);
  sameKeys(pv.unclaimed[0], ['id', 'display_name', 'headcount', 'people', 'emoji', 'color']);
  eq(pv.unclaimed[0].id, placeholder);
  await rejects(snap(tripId), 'forbidden', 'not a member yet');

  const j = await api.joinTrip(code, { claimMemberId: placeholder, profile: { phone: '0501111111', emoji: '👑' } });
  deepEq(j, { trip_id: tripId, member_id: placeholder });
  const pv2 = await api.previewInvite(code);
  eq(pv2.my_member_id, placeholder);
  eq(pv2.unclaimed.length, 0);
  deepEq(await api.joinTrip(code, { profile: { display_name: 'שוב אני' } }), j, 'already linked → same member');
  let s = await snap(tripId);
  const me = s.members.find((m) => m.id === placeholder);
  eq(me.claimed, true);
  eq(me.phone, '0501111111');
  eq(me.emoji, '👑');
  eq(me.display_name, 'תומר ושקד', 'claim keeps the seeded name');
  eq(s.me.role, 'member');
  eq(s.members.length, 2, 'no duplicate member');

  await as(newUid());
  await rejects(api.joinTrip(code, { claimMemberId: placeholder }), 'already_claimed');
  await rejects(api.joinTrip(code, { claimMemberId: newUid() }), 'not_found');
  await rejects(api.joinTrip(code, {}), 'invalid_input', 'no claim and no profile');
  await rejects(api.joinTrip('nope234567', { profile: { display_name: 'x' } }), 'invalid_code');
  await rejects(api.previewInvite('nope234567'), 'invalid_code');
  await api.joinTrip(code, { profile: { display_name: 'אסף ועלמה', headcount: 2, people: ['אסף', 'עלמה'] } });
  s = await snap(tripId);
  eq(s.me.role, 'member');
  eq(s.notifications.filter((n) => n.title.includes('הצטרפ')).length, 0, 'members do not see join notices');

  await as(owner);
  s = await snap(tripId);
  const joined = s.notifications.filter((n) => n.kind === 'system' && n.title.endsWith('הצטרפ/ה לטיול 🎉'));
  deepEq(joined.map((n) => n.title).sort(), ['אסף ועלמה הצטרפ/ה לטיול 🎉', 'תומר ושקד הצטרפ/ה לטיול 🎉'].sort());
  for (const n of joined) deepEq(n.audience, [ownerMember], 'audience = admins');
  eq(s.members.length, 3);
});

test('join: first joiner of a seeded trip without any admin becomes owner', async () => {
  await api.demo.reset();
  await as(newUid());
  const { trip_id: tripId } = await api.createTrip({ name: 'טיול מזרע' }, { display_name: 'יוצר' });
  const ph = await api.createMember(tripId, { display_name: 'זיו' });
  const ph2 = await api.createMember(tripId, { display_name: 'הדס ועידו', headcount: 2 });
  const code = (await snap(tripId)).trip.invite_code;
  // Reproduce the SQL seed (private/seed_trip.sql): only unclaimed placeholders, nobody linked, no admin.
  const db = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY));
  db.members = db.members.filter((m) => m.trip_id !== tripId || m.id === ph || m.id === ph2);
  db.member_users = db.member_users.filter((l) => l.trip_id !== tripId);
  localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(db));

  await as(newUid());
  await api.joinTrip(code, { claimMemberId: ph });
  eq((await snap(tripId)).me.role, 'owner', 'first joiner → owner');
  await as(newUid());
  await api.joinTrip(code, { claimMemberId: ph2 });
  const s = await snap(tripId);
  eq(s.me.role, 'member', 'second joiner → member');
  assert(!s.notifications.some((n) => n.title.includes('הצטרפ')), 'member does not get the join notice');
});

// ---------- permissions & roles ----------

test('permissions: members cannot do admin actions (forbidden); non-members are locked out', async () => {
  const t = await newTrip();
  const s0 = await snap(t.tripId);
  await as(t.B.uid);
  const itemId = await api.addItem(t.tripId, { title: 'כסאות', type: 'bring', needed: 4 });
  await rejects(api.reviewItem(itemId, true), 'forbidden', 'review');
  await rejects(api.assign(itemId, t.C.memberId, 1), 'forbidden', 'assign');
  await rejects(api.sendAnnouncement(t.tripId, { title: 'שלום' }), 'forbidden', 'announce');
  await rejects(api.setRole(t.C.memberId, 'admin'), 'forbidden', 'set_role');
  await rejects(api.updateTrip(t.tripId, { name: 'x' }), 'forbidden', 'update_trip');
  await rejects(api.rotateInvite(t.tripId), 'forbidden', 'rotate_invite');
  await rejects(api.createMember(t.tripId, { display_name: 'x' }), 'forbidden', 'create_member');
  await rejects(api.upsertCategory(t.tripId, { name: 'x' }), 'forbidden', 'upsert_category');
  await rejects(api.deleteCategory(s0.categories[0].id), 'forbidden', 'delete_category');
  await rejects(api.removeMember(t.C.memberId), 'forbidden', 'remove_member');
  await rejects(api.updateMember(t.C.memberId, { emoji: '🐢' }), 'forbidden', 'update other member');
  await rejects(api.getDeviceCode(t.C.memberId), 'forbidden', 'device code of other');
  await api.updateMember(t.B.memberId, { emoji: '🐢', headcount: 2, people: ['בני', 'בת'], prefs: { diet: 'צמחוני' } });
  await api.updateMember(t.B.memberId, { prefs: { notify: { money: false } } });

  await as(newUid());
  await rejects(snap(t.tripId), 'forbidden', 'non-member snapshot');
  await rejects(api.addItem(t.tripId, { title: 'x' }), 'forbidden', 'non-member add_item');
  await rejects(api.pledge(itemId, 1), 'forbidden', 'non-member pledge');
  await rejects(api.pledge(newUid(), 1), 'not_found', 'unknown item');

  await as(t.owner.uid);
  await api.updateMember(t.C.memberId, { headcount: 3 });
  await api.updateTrip(t.tripId, { name: 'שם חדש', info: { notes: 'הערה' }, settings: { require_approval: false }, bogus_key: 1 });
  const s = await snap(t.tripId);
  eq(s.trip.name, 'שם חדש');
  eq(s.trip.info.notes, 'הערה');
  deepEq(s.trip.info.schedule, [], 'info patch keeps other keys');
  eq(s.trip.settings.require_approval, false);
  const b = s.members.find((m) => m.id === t.B.memberId);
  eq(b.emoji, '🐢');
  eq(b.headcount, 2);
  deepEq(b.prefs, { diet: 'צמחוני', notify: { money: false } }, 'prefs patch merges top-level keys');
  eq(s.members.find((m) => m.id === t.C.memberId).headcount, 3);
  const oldCode = s.trip.invite_code;
  const code = await api.rotateInvite(t.tripId);
  assert(code !== oldCode && /^[a-z2-9]{10}$/.test(code), 'new code');
  await rejects(api.previewInvite(oldCode), 'invalid_code', 'old code dead');
  eq((await api.previewInvite(code)).trip.id, t.tripId);
});

test('roles: set_role (owner_locked, promotion notice), leave_trip (last_admin), admin votes', async () => {
  const t = await newTrip();
  await rejects(api.setRole(t.owner.memberId, 'member'), 'owner_locked');
  await rejects(api.removeMember(t.owner.memberId), 'owner_locked');
  await rejects(api.setRole(t.B.memberId, 'owner'), 'invalid_input');
  await api.setRole(t.B.memberId, 'admin');

  await as(t.B.uid);
  let s = await snap(t.tripId);
  eq(s.me.role, 'admin');
  const promo = s.notifications.find((n) => n.title === 'מונית למנהל/ת 👑');
  assert(promo, 'promotion notice');
  deepEq(promo.audience, [t.B.memberId]);
  await api.setRole(t.C.memberId, 'admin'); // new admin can manage roles
  await api.setRole(t.C.memberId, 'member');
  await rejects(api.removeMember(t.owner.memberId), 'owner_locked');

  await as(t.owner.uid);
  await api.setRole(t.B.memberId, 'member');
  await rejects(api.leaveTrip(t.tripId), 'last_admin', 'owner is the only admin');
  await api.setRole(t.B.memberId, 'admin');
  await api.leaveTrip(t.tripId);
  deepEq(await api.myTrips(), [], 'left');
  await rejects(snap(t.tripId), 'forbidden');

  await as(t.B.uid);
  s = await snap(t.tripId);
  const ownerRow = s.members.find((m) => m.id === t.owner.memberId);
  eq(ownerRow.claimed, false, 'no users left → unclaimed');
  eq(ownerRow.role, 'owner', 'still the owner');

  await as(t.C.uid);
  await api.voteAdmin(t.B.memberId, true);
  await api.voteAdmin(t.B.memberId, true); // idempotent
  await api.voteAdmin(t.owner.memberId, true);
  s = await snap(t.tripId);
  deepEq(s.admin_votes, [
    { voter_id: t.C.memberId, candidate_id: t.B.memberId },
    { voter_id: t.C.memberId, candidate_id: t.owner.memberId },
  ]);
  await api.voteAdmin(t.B.memberId, false);
  s = await snap(t.tripId);
  deepEq(s.admin_votes, [{ voter_id: t.C.memberId, candidate_id: t.owner.memberId }]);
  await rejects(api.voteAdmin(newUid(), true), 'not_found');
});

test('remove_member: cascades pledges/votes/personal, unlinks users, keeps items', async () => {
  const t = await newTrip({ requireApproval: false });
  await as(t.B.uid);
  const item = await api.addItem(t.tripId, { title: 'מטקות', type: 'bring', pledge_qty: 1 });
  await api.voteAdmin(t.C.memberId, true);
  await api.addPersonal(t.tripId, 'משקפת');
  const poll = await api.createPoll(t.tripId, { question: 'מתי יוצאים?', options: ['8', '9'] });
  await api.votePoll(poll, ['o1']);
  await as(t.owner.uid);
  await api.removeMember(t.B.memberId);
  const s = await snap(t.tripId);
  assert(!s.members.some((m) => m.id === t.B.memberId), 'member gone');
  eq(pledgesOf(s, item).length, 0, 'pledges gone');
  eq(itemOf(s, item).created_by, null, 'item kept, creator cleared');
  eq(s.admin_votes.length, 0, 'votes gone');
  eq(s.poll_votes.length, 0, 'poll votes gone');
  eq(s.polls[0].created_by, null, 'poll kept');
  await as(t.B.uid);
  deepEq(await api.myTrips(), [], 'removed user unlinked');
  await rejects(snap(t.tripId), 'forbidden');
});

// ---------- items ----------

test('items: proposal → approve/reject flow with notifications and visibility', async () => {
  const t = await newTrip();
  await as(t.B.uid);
  const id = await api.addItem(t.tripId, { title: 'כנפיים', type: 'buy', qty: 1, unit: 'ק"ג', note: 'אם אוהבים', pledge_qty: 1 });
  let s = await snap(t.tripId);
  let item = itemOf(s, id);
  eq(item.status, 'proposed');
  eq(item.created_by, t.B.memberId);
  eq(item.approved_by, null);
  eq(item.qty, 1);
  eq(pledgesOf(s, id).length, 1, 'pledge_qty → my pledge');
  eq(s.notifications.filter((n) => n.title.startsWith('הצעה חדשה')).length, 0, 'proposer does not get the admin notice');

  await as(t.owner.uid);
  s = await snap(t.tripId);
  const notice = s.notifications.find((n) => n.title === 'הצעה חדשה: כנפיים');
  assert(notice, 'admins notified');
  eq(notice.kind, 'system');
  deepEq(notice.audience, [t.owner.memberId]);
  assert(notice.link.includes(`#/t/${t.tripId}/lists`) && notice.link.includes(id), 'deep link');

  await as(t.C.uid);
  s = await snap(t.tripId);
  eq(itemOf(s, id).status, 'proposed', 'others see pending proposals');
  await rejects(api.updateItem(id, { title: 'x' }), 'forbidden', 'others cannot edit');
  await rejects(api.pledge(id, 1), 'not_allowed_state', 'cannot pledge others’ proposals');
  await rejects(api.deleteItem(id), 'forbidden');

  await as(t.B.uid);
  await api.updateItem(id, { qty: 2, note: null });
  await api.pledge(id, 2);
  s = await snap(t.tripId);
  eq(itemOf(s, id).qty, 2);
  eq(itemOf(s, id).note, null);
  eq(pledgesOf(s, id)[0].qty, 2);

  await as(t.owner.uid);
  await api.reviewItem(id, true);
  s = await snap(t.tripId);
  item = itemOf(s, id);
  eq(item.status, 'active');
  eq(item.approved_by, t.owner.memberId);
  await rejects(api.reviewItem(id, false, 'x'), 'not_allowed_state', 'only from proposed');

  await as(t.B.uid);
  s = await snap(t.tripId);
  assert(s.notifications.some((n) => n.title === 'ההצעה אושרה ✅: כנפיים' && n.audience[0] === t.B.memberId), 'approval notice');
  await rejects(api.updateItem(id, { title: 'y' }), 'forbidden', 'creator cannot edit once active');
  await rejects(api.deleteItem(id), 'forbidden', 'creator cannot delete once active');

  const id2 = await api.addItem(t.tripId, { title: 'רמקול', type: 'bring' });
  await as(t.owner.uid);
  await api.reviewItem(id2, false, 'אסור מוזיקה במתחם');
  s = await snap(t.tripId);
  eq(itemOf(s, id2).status, 'rejected');
  eq(itemOf(s, id2).reject_reason, 'אסור מוזיקה במתחם');
  await as(t.C.uid);
  assert(!itemOf(await snap(t.tripId), id2), 'rejected hidden from other members');
  await as(t.B.uid);
  s = await snap(t.tripId);
  eq(itemOf(s, id2).status, 'rejected', 'creator still sees it');
  const rej = s.notifications.find((n) => n.title === 'ההצעה נדחתה: רמקול');
  assert(rej && rej.body === 'אסור מוזיקה במתחם', 'rejection notice with reason');
  await rejects(api.pledge(id2, 1), 'not_allowed_state');
  await api.deleteItem(id2);
  assert(!itemOf(await snap(t.tripId), id2), 'creator deleted own rejected item');

  await as(t.owner.uid);
  const id3 = await api.addItem(t.tripId, { title: 'מנגל', type: 'bring' });
  s = await snap(t.tripId);
  eq(itemOf(s, id3).status, 'active', 'admin items are active');
  eq(itemOf(s, id3).approved_by, t.owner.memberId);
  await api.updateTrip(t.tripId, { settings: { require_approval: false } });
  await as(t.C.uid);
  const id4 = await api.addItem(t.tripId, { title: 'מחצלת', type: 'bring', needed: 2 });
  eq(itemOf(await snap(t.tripId), id4).status, 'active', 'approval off → active');
});

test('items: validation of add_item / update_item', async () => {
  const t = await newTrip();
  const other = await newTripCategoryElsewhere();
  await as(t.owner.uid);
  await rejects(api.addItem(t.tripId, { title: '' }), 'invalid_input', 'empty title');
  await rejects(api.addItem(t.tripId, { title: 'א'.repeat(121) }), 'invalid_input', 'title > 120');
  await rejects(api.addItem(t.tripId, { title: 'x', type: 'borrow' }), 'invalid_input', 'bad type');
  await rejects(api.addItem(t.tripId, { title: 'x', needed: 0 }), 'invalid_input', 'needed 0');
  await rejects(api.addItem(t.tripId, { title: 'x', needed: 201 }), 'invalid_input', 'needed 201');
  await rejects(api.addItem(t.tripId, { title: 'x', qty: -1 }), 'invalid_input', 'negative qty');
  await rejects(api.addItem(t.tripId, { title: 'x', unit: 'י'.repeat(21) }), 'invalid_input', 'unit > 20');
  await rejects(api.addItem(t.tripId, { title: 'x', note: 'n'.repeat(501) }), 'invalid_input', 'note > 500');
  await rejects(api.addItem(t.tripId, { title: 'x', category_id: newUid() }), 'invalid_input', 'unknown category');
  await rejects(api.addItem(t.tripId, { title: 'x', category_id: other }), 'invalid_input', 'category of another trip');
  const id = await api.addItem(t.tripId, { title: '  פיתות  ', qty: '40', unit: 'יח׳', unknown_key: true });
  const s = await snap(t.tripId);
  const item = itemOf(s, id);
  eq(item.title, 'פיתות');
  eq(item.qty, 40);
  eq(item.type, 'buy', 'default type');
  eq(item.needed, 1);
  eq(item.per_person, false);
  await api.updateItem(id, { qty: null, unit: null, sort: 5, category_id: s.categories[2].id });
  const s2 = await snap(t.tripId);
  eq(itemOf(s2, id).qty, null);
  eq(itemOf(s2, id).sort, 5);
  eq(itemOf(s2, id).category_id, s.categories[2].id);
  assert(itemOf(s2, id).updated_at > item.updated_at, 'updated_at bumped');
  await rejects(api.updateItem(id, { title: '' }), 'invalid_input');
  await rejects(api.updateItem(newUid(), { title: 'x' }), 'not_found');
});

/** A category id that belongs to a different trip (created by an unrelated user). */
async function newTripCategoryElsewhere() {
  const keep = api.demo.currentUserId();
  await as(newUid());
  const { trip_id: tripId } = await api.createTrip({ name: 'אחר' }, { display_name: 'זר' });
  const id = (await snap(tripId)).categories[0].id;
  await as(keep);
  return id;
}

test('pledges: bring/each/buy/task rules, set_pledge_done, set_item_done, assign', async () => {
  const t = await newTrip({ requireApproval: false });
  const bring = await api.addItem(t.tripId, { title: 'כסאות ים', type: 'bring', needed: 5 });
  const each = await api.addItem(t.tripId, { title: 'קרש חיתוך', type: 'each' });
  const buy = await api.addItem(t.tripId, { title: 'פחמים', type: 'buy', qty: 3, unit: 'חבילות' });
  const task = await api.addItem(t.tripId, { title: 'לשריין מקרר', type: 'task' });

  await as(t.B.uid);
  await rejects(api.pledge(each, 1), 'invalid_input', 'no pledging each-items');
  await api.pledge(bring, 3);
  let s = await snap(t.tripId);
  eq(pledgesOf(s, bring).length, 1);
  const p = pledgesOf(s, bring)[0];
  eq(p.member_id, t.B.memberId);
  eq(p.qty, 3);
  eq(p.done, false);
  eq(p.assigned_by, null);
  await api.pledge(bring, 2);
  s = await snap(t.tripId);
  eq(pledgesOf(s, bring).length, 1, 'upsert, not duplicate');
  eq(pledgesOf(s, bring)[0].qty, 2);
  await rejects(api.pledge(bring, 201), 'invalid_input', 'qty > 200');
  await rejects(api.pledge(bring, 1.5), 'invalid_input', 'qty must be an integer');
  await api.setPledgeDone(bring, true);
  eq(pledgesOf(await snap(t.tripId), bring)[0].done, true, 'packed');
  await api.pledge(bring, 0);
  eq(pledgesOf(await snap(t.tripId), bring).length, 0, 'qty 0 removes');
  await rejects(api.setPledgeDone(bring, true), 'not_found', 'no pledge to mark');

  await api.setPledgeDone(each, true);
  s = await snap(t.tripId);
  eq(pledgesOf(s, each).length, 1, 'each: row created lazily');
  eq(pledgesOf(s, each)[0].done, true);
  await api.setPledgeDone(each, false);
  s = await snap(t.tripId);
  eq(pledgesOf(s, each).length, 1);
  eq(pledgesOf(s, each)[0].done, false);

  await rejects(api.setItemDone(bring, true), 'invalid_input', 'only buy/task');
  await rejects(api.setItemDone(buy, true), 'forbidden', 'not the buyer');
  await api.pledge(buy);
  await api.setItemDone(buy, true);
  s = await snap(t.tripId);
  eq(itemOf(s, buy).done, true);
  assert(isIso(itemOf(s, buy).done_at), 'done_at set');
  await api.setItemDone(buy, false);
  s = await snap(t.tripId);
  eq(itemOf(s, buy).done, false);
  eq(itemOf(s, buy).done_at, null);

  await as(t.owner.uid);
  await api.assign(task, t.C.memberId);
  s = await snap(t.tripId);
  eq(pledgesOf(s, task).length, 1);
  eq(pledgesOf(s, task)[0].member_id, t.C.memberId);
  eq(pledgesOf(s, task)[0].assigned_by, t.owner.memberId);
  await rejects(api.assign(each, t.C.memberId, 1), 'invalid_input', 'no assigning each-items');
  await rejects(api.assign(task, newUid(), 1), 'not_found', 'unknown member');
  await api.setItemDone(task, true); // admins may mark anything done
  eq(itemOf(await snap(t.tripId), task).done, true);

  await as(t.C.uid);
  s = await snap(t.tripId);
  const n = s.notifications.find((x) => x.title === 'שובצת: לשריין מקרר');
  assert(n, 'assignee notified');
  deepEq(n.audience, [t.C.memberId]);

  await as(t.owner.uid);
  await api.assign(task, t.C.memberId, 0);
  eq(pledgesOf(await snap(t.tripId), task).length, 0, 'assign 0 removes');
});

test('categories: upsert (create/update), delete keeps items uncategorized', async () => {
  const t = await newTrip();
  const cid = await api.upsertCategory(t.tripId, { name: 'צילום ומצלמות', emoji: '📷', default_buyer_id: t.B.memberId });
  let s = await snap(t.tripId);
  let c = s.categories.find((x) => x.id === cid);
  eq(c.sort, 11, 'appended');
  eq(c.default_buyer_id, t.B.memberId);
  eq(c.note, null);
  await api.upsertCategory(t.tripId, { id: cid, name: 'צילום', note: 'מצלמות וחצובות' });
  s = await snap(t.tripId);
  c = s.categories.find((x) => x.id === cid);
  eq(c.name, 'צילום');
  eq(c.emoji, '📷', 'emoji unchanged');
  eq(c.note, 'מצלמות וחצובות');
  await rejects(api.upsertCategory(t.tripId, { id: newUid(), name: 'x' }), 'not_found');
  await rejects(api.upsertCategory(t.tripId, { emoji: '📷' }), 'invalid_input', 'name required');
  await rejects(api.upsertCategory(t.tripId, { name: 'x', default_buyer_id: newUid() }), 'invalid_input', 'buyer must be a member');
  const item = await api.addItem(t.tripId, { title: 'חצובה', type: 'bring', category_id: cid });
  await api.deleteCategory(cid);
  s = await snap(t.tripId);
  assert(!s.categories.some((x) => x.id === cid), 'deleted');
  eq(itemOf(s, item).category_id, null, 'item kept, uncategorized');
  await rejects(api.deleteCategory(cid), 'not_found');
});

test('add_items_bulk: categories by name (admins create, members match), atomic, limits', async () => {
  const t = await newTrip();
  const n = await api.addItemsBulk(t.tripId, [
    { title: 'סטייק אנטריקוט', qty: 300, unit: 'גרם', per_person: true, type: 'buy', category_name: 'בשר ועוף', category_emoji: '🥩' },
    { title: 'גזיבו', type: 'bring', category_name: 'צל ונוחות', category_emoji: '⛱️' },
    { title: 'כיסא נוסף', type: 'bring', category_name: '  צל   ונוחות ' },
    { title: 'ללא קטגוריה', type: 'buy', pledge_qty: 1 },
  ]);
  eq(n, 4);
  let s = await snap(t.tripId);
  eq(s.categories.length, 11, 'one new category');
  const created = s.categories.find((c) => c.name === 'צל ונוחות');
  eq(created.emoji, '⛱️');
  const by = (title) => s.items.find((i) => i.title === title);
  eq(by('גזיבו').category_id, created.id);
  eq(by('כיסא נוסף').category_id, created.id, 'reuses the category created in the same call');
  eq(by('סטייק אנטריקוט').category_id, s.categories.find((c) => c.name === 'בשר ועוף').id, 'matched existing');
  eq(by('סטייק אנטריקוט').per_person, true);
  eq(by('ללא קטגוריה').category_id, null);
  eq(pledgesOf(s, by('ללא קטגוריה').id).length, 1, 'pledge_qty honored');
  assert(s.items.every((i) => i.status === 'active'), 'admin → active');

  await as(t.B.uid);
  const m = await api.addItemsBulk(t.tripId, [
    { title: 'מרשמלו', category_name: 'קטגוריה שלא קיימת' },
    { title: 'מטקות', type: 'bring', category_name: 'כיף ומשחקים' },
  ]);
  eq(m, 2);
  s = await snap(t.tripId);
  eq(s.categories.length, 11, 'members never create categories');
  eq(by('מרשמלו').category_id, null);
  eq(by('מטקות').category_id, s.categories.find((c) => c.name === 'כיף ומשחקים').id);
  eq(by('מרשמלו').status, 'proposed');
  const before = s.items.length;
  await rejects(api.addItemsBulk(t.tripId, Array.from({ length: 151 }, (_, i) => ({ title: `x${i}` }))), 'invalid_input', '> 150 per call');
  await rejects(api.addItemsBulk(t.tripId, [{ title: 'תקין' }, { title: '' }]), 'invalid_input', 'one bad row');
  await rejects(api.addItemsBulk(t.tripId, 'not an array'), 'invalid_input');
  eq((await snap(t.tripId)).items.length, before, 'atomic: nothing inserted');
  eq(await api.addItemsBulk(t.tripId, []), 0);

  await as(t.owner.uid);
  const count = () => snap(t.tripId).then((x) => x.items.length);
  const batch = (k) => Array.from({ length: k }, (_, i) => ({ title: `פריט ${i}`, type: 'buy' }));
  while ((await count()) + 150 <= 600) await api.addItemsBulk(t.tripId, batch(150));
  await api.addItemsBulk(t.tripId, batch(600 - (await count())));
  eq(await count(), 600);
  await rejects(api.addItem(t.tripId, { title: 'עוד אחד' }), 'limit_reached', '600 items/trip');
  await rejects(api.addItemsBulk(t.tripId, batch(1)), 'limit_reached');
});

// ---------- personal ----------

test('personal items: private to the member, template, limit', async () => {
  const t = await newTrip();
  await as(t.B.uid);
  const pid = await api.addPersonal(t.tripId, 'משקפת');
  eq(await api.addPersonalTemplate(t.tripId), PERSONAL_TEMPLATE.length);
  eq(await api.addPersonalTemplate(t.tripId), 0, 'template items not duplicated');
  let s = await snap(t.tripId);
  deepEq(s.personal_items.map((p) => p.title), ['משקפת', ...PERSONAL_TEMPLATE]);
  await api.updatePersonal(pid, { done: true, title: 'משקפת שדה' });
  s = await snap(t.tripId);
  eq(s.personal_items[0].title, 'משקפת שדה');
  eq(s.personal_items[0].done, true);
  await rejects(api.addPersonal(t.tripId, ''), 'invalid_input');
  await rejects(api.addPersonal(t.tripId, 'א'.repeat(81)), 'invalid_input');

  await as(t.C.uid);
  eq((await snap(t.tripId)).personal_items.length, 0, 'others see none');
  await rejects(api.updatePersonal(pid, { done: false }), 'forbidden');
  await rejects(api.deletePersonal(pid), 'forbidden');
  await as(t.owner.uid);
  eq((await snap(t.tripId)).personal_items.length, 0, 'admins see none either');
  await rejects(api.updatePersonal(pid, { done: false }), 'forbidden', 'admins cannot edit');

  await as(t.B.uid);
  await api.deletePersonal(pid);
  const left = (await snap(t.tripId)).personal_items.length;
  eq(left, PERSONAL_TEMPLATE.length);
  for (let i = left; i < 100; i++) await api.addPersonal(t.tripId, `פריט ${i}`);
  await rejects(api.addPersonal(t.tripId, 'אחד יותר מדי'), 'limit_reached', '100 personal items');
});

// ---------- money ----------

test('expenses: who may add/edit/delete, split modes, shares, has_money_records', async () => {
  const t = await newTrip();
  await as(t.B.uid);
  const e1 = await api.addExpense(t.tripId, { title: 'קניות בסופר', amount: 250.456 });
  let s = await snap(t.tripId);
  let e = s.expenses.find((x) => x.id === e1);
  eq(e.amount, 250.46, 'rounded to agorot');
  eq(e.paid_by, t.B.memberId, 'paid_by defaults to me');
  eq(e.created_by, t.B.memberId);
  eq(e.split_mode, 'all');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(e.spent_on), 'spent_on date');
  eq(s.expense_shares.filter((x) => x.expense_id === e1).length, 0, 'no rows for split all');

  await rejects(api.addExpense(t.tripId, { title: 'x', amount: 10, paid_by: t.C.memberId }), 'forbidden', 'paid_by other needs admin');
  await rejects(api.addExpense(t.tripId, { title: 'x', amount: 0 }), 'invalid_input', 'amount 0');
  await rejects(api.addExpense(t.tripId, { title: 'x', amount: 100000.01 }), 'invalid_input', 'amount > 100000');
  await rejects(api.addExpense(t.tripId, { title: '', amount: 5 }), 'invalid_input', 'title');
  await rejects(api.addExpense(t.tripId, { title: 'x', amount: 5, split_mode: 'members' }), 'invalid_input', 'members required');
  await rejects(api.addExpense(t.tripId, { title: 'x', amount: 5, split_mode: 'members', members: [] }), 'invalid_input', 'members non-empty');
  await rejects(api.addExpense(t.tripId, { title: 'x', amount: 5, split_mode: 'members', members: [{ member_id: newUid() }] }), 'invalid_input', 'unknown member');
  await rejects(api.addExpense(t.tripId, { title: 'x', amount: 5, split_mode: 'members', members: [{ member_id: t.B.memberId, weight: 0 }] }), 'invalid_input', 'weight > 0');

  const e2 = await api.addExpense(t.tripId, {
    title: 'חניה', amount: 90, split_mode: 'members', spent_on: '2026-10-01',
    members: [{ member_id: t.B.memberId }, { member_id: t.C.memberId, weight: 1 }],
  });
  s = await snap(t.tripId);
  deepEq(s.expense_shares.filter((x) => x.expense_id === e2), [
    { expense_id: e2, member_id: t.B.memberId, weight: 1 },
    { expense_id: e2, member_id: t.C.memberId, weight: 1 },
  ], 'weights: default = headcount, explicit kept');
  eq(s.expenses.find((x) => x.id === e2).spent_on, '2026-10-01');

  await as(t.owner.uid);
  const e3 = await api.addExpense(t.tripId, { title: 'גז', amount: 40, paid_by: t.C.memberId });
  s = await snap(t.tripId);
  e = s.expenses.find((x) => x.id === e3);
  eq(e.paid_by, t.C.memberId, 'admins record for others');
  eq(e.created_by, t.owner.memberId);

  await as(t.C.uid);
  await rejects(api.updateExpense(e1, { amount: 1 }), 'forbidden', 'not creator/payer/admin');
  await rejects(api.deleteExpense(e1), 'forbidden');
  await api.updateExpense(e3, { title: 'בלון גז' });
  eq((await snap(t.tripId)).expenses.find((x) => x.id === e3).title, 'בלון גז', 'payer may edit');

  await as(t.B.uid);
  await api.updateExpense(e2, { members: [{ member_id: t.owner.memberId }] });
  s = await snap(t.tripId);
  deepEq(s.expense_shares.filter((x) => x.expense_id === e2), [{ expense_id: e2, member_id: t.owner.memberId, weight: 2 }], 'members replaced');
  await api.updateExpense(e2, { split_mode: 'all' });
  s = await snap(t.tripId);
  eq(s.expenses.find((x) => x.id === e2).split_mode, 'all');
  eq(s.expense_shares.filter((x) => x.expense_id === e2).length, 0, 'shares cleared');
  await rejects(api.updateExpense(e2, { split_mode: 'members' }), 'invalid_input', 'members needed again');
  await rejects(api.updateExpense(e2, { paid_by: t.C.memberId }), 'forbidden', 'cannot move payer to someone else');
  await api.deleteExpense(e2);
  assert(!(await snap(t.tripId)).expenses.some((x) => x.id === e2), 'deleted');

  await as(t.owner.uid);
  await rejects(api.removeMember(t.B.memberId), 'has_money_records');
  await api.deleteExpense(e1);
  await api.removeMember(t.B.memberId);
  assert(!(await snap(t.tripId)).members.some((m) => m.id === t.B.memberId), 'removable once no money records');
});

test('payments: sent → confirmed, recipient-recorded, notifications, delete rules', async () => {
  const t = await newTrip();
  await as(t.B.uid);
  const p1 = await api.addPayment(t.tripId, { to_member: t.owner.memberId, amount: 50 });
  let s = await snap(t.tripId);
  let p = s.payments.find((x) => x.id === p1);
  eq(p.status, 'sent');
  eq(p.method, 'bit', 'default method');
  eq(p.from_member, t.B.memberId);
  eq(p.created_by, t.B.memberId);
  eq(p.confirmed_at, null);

  await as(t.owner.uid);
  s = await snap(t.tripId);
  const sentNote = s.notifications.find((n) => n.title === 'בני סימן/ה שהעביר/ה לך ₪50');
  assert(sentNote, 'recipient notified');
  deepEq(sentNote.audience, [t.owner.memberId]);

  await as(t.C.uid);
  await rejects(api.confirmPayment(p1), 'forbidden', 'only recipient/admin confirms');
  await rejects(api.deletePayment(p1), 'forbidden', 'not the creator');
  await rejects(api.addPayment(t.tripId, { from_member: t.B.memberId, to_member: t.owner.memberId, amount: 5 }), 'forbidden', 'third party');
  await rejects(api.addPayment(t.tripId, { to_member: t.C.memberId, amount: 5 }), 'invalid_input', 'to self');
  await rejects(api.addPayment(t.tripId, { to_member: t.B.memberId, amount: 5, method: 'crypto' }), 'invalid_input', 'method');
  await rejects(api.addPayment(t.tripId, { to_member: t.B.memberId, amount: -5 }), 'invalid_input', 'amount');
  await rejects(api.addPayment(t.tripId, { amount: 5 }), 'invalid_input', 'to_member required');

  await as(t.owner.uid);
  await api.confirmPayment(p1);
  s = await snap(t.tripId);
  p = s.payments.find((x) => x.id === p1);
  eq(p.status, 'confirmed');
  assert(isIso(p.confirmed_at), 'confirmed_at');
  await as(t.B.uid);
  s = await snap(t.tripId);
  assert(s.notifications.some((n) => n.title === 'הבעלים אישר/ה שקיבל/ה ₪50 ✅' && n.audience[0] === t.B.memberId), 'payer notified');
  await rejects(api.deletePayment(p1), 'not_allowed_state', 'creator cannot delete confirmed');

  await as(t.C.uid);
  const p2 = await api.addPayment(t.tripId, { from_member: t.B.memberId, to_member: t.C.memberId, amount: 20.5, method: 'cash', note: 'מזומן בחניון' });
  s = await snap(t.tripId);
  p = s.payments.find((x) => x.id === p2);
  eq(p.status, 'confirmed', 'recipient-recorded → confirmed');
  eq(p.from_member, t.B.memberId);
  eq(p.method, 'cash');
  await as(t.B.uid);
  assert((await snap(t.tripId)).notifications.some((n) => n.title === 'כרמל אישר/ה שקיבל/ה ₪20.50 ✅'), 'payer told');
  const p3 = await api.addPayment(t.tripId, { to_member: t.C.memberId, amount: 10, method: 'paybox' });
  await api.deletePayment(p3);
  await as(t.owner.uid);
  await api.deletePayment(p1);
  s = await snap(t.tripId);
  deepEq(s.payments.map((x) => x.id), [p2], 'admin may delete confirmed');
});

// ---------- notifications ----------

test('announcements: audience visibility, validation, delete permissions', async () => {
  const t = await newTrip();
  const all = await api.sendAnnouncement(t.tripId, { title: 'יוצאים ב-9', body: 'לא לאחר!' });
  const targeted = await api.sendAnnouncement(t.tripId, { title: 'להביא כסאות', audience: [t.B.memberId, t.B.memberId], urgent: true });
  const empty = await api.sendAnnouncement(t.tripId, { title: 'לכולם', audience: [] });
  await rejects(api.sendAnnouncement(t.tripId, { title: '' }), 'invalid_input', 'title');
  await rejects(api.sendAnnouncement(t.tripId, { title: 'א'.repeat(81) }), 'invalid_input', 'title > 80');
  await rejects(api.sendAnnouncement(t.tripId, { title: 'x', body: 'ב'.repeat(2001) }), 'invalid_input', 'body > 2000');
  await rejects(api.sendAnnouncement(t.tripId, { title: 'x', audience: [newUid()] }), 'invalid_input', 'audience outside trip');

  let s = await snap(t.tripId);
  const n = s.notifications.find((x) => x.id === targeted);
  eq(n.kind, 'announcement');
  deepEq(n.audience, [t.B.memberId], 'deduped audience');
  eq(n.urgent, true);
  eq(n.author_member, t.owner.memberId);
  eq(s.notifications.find((x) => x.id === all).body, 'לא לאחר!');
  eq(s.notifications.find((x) => x.id === empty).audience, null, 'empty audience = everyone');
  eq(s.notifications[0].id, empty, 'newest first');

  await as(t.B.uid);
  s = await snap(t.tripId);
  for (const id of [all, targeted, empty]) assert(s.notifications.some((x) => x.id === id), `B sees ${id}`);
  await as(t.C.uid);
  s = await snap(t.tripId);
  assert(s.notifications.some((x) => x.id === all), 'C sees broadcast');
  assert(!s.notifications.some((x) => x.id === targeted), 'C does not see B’s message');
  await rejects(api.deleteNotification(all), 'forbidden');

  await as(t.owner.uid);
  await api.setRole(t.C.memberId, 'admin');
  await as(t.C.uid);
  s = await snap(t.tripId);
  assert(s.notifications.some((x) => x.id === targeted), 'admins see every announcement');
  await api.deleteNotification(targeted);
  assert(!(await snap(t.tripId)).notifications.some((x) => x.id === targeted), 'deleted');
  await rejects(api.deleteNotification(targeted), 'not_found');
});

test('mark_read: only visible ids, no duplicates, read visibility (admin / own / authored)', async () => {
  const t = await newTrip();
  const a = await api.sendAnnouncement(t.tripId, { title: 'לכולם' });
  const x = await api.sendAnnouncement(t.tripId, { title: 'רק לכרמל', audience: [t.C.memberId] });
  await api.setRole(t.C.memberId, 'admin');
  await as(t.C.uid);
  const y = await api.sendAnnouncement(t.tripId, { title: 'מכרמל', audience: [t.B.memberId] });
  await as(t.owner.uid);
  await api.setRole(t.C.memberId, 'member');

  await as(t.B.uid);
  const rev0 = (await snap(t.tripId)).trip.rev;
  await api.markRead(t.tripId, [a, x, y, newUid()]);
  let s = await snap(t.tripId);
  eq(s.trip.rev, rev0 + 1, 'bumped once');
  deepEq(s.reads.map((r) => r.notification_id).sort(), [a, y].sort(), 'only visible ids');
  for (const r of s.reads) {
    sameKeys(r, SHAPE.reads);
    eq(r.member_id, t.B.memberId);
  }
  await api.markRead(t.tripId, [a]);
  s = await snap(t.tripId);
  eq(s.reads.length, 2, 'no duplicates');
  eq(s.trip.rev, rev0 + 1, 'no-op mark_read does not bump rev');

  await as(t.C.uid);
  s = await snap(t.tripId);
  deepEq(s.reads.map((r) => `${r.notification_id}:${r.member_id}`), [`${y}:${t.B.memberId}`], 'author sees reads of own message only');
  await as(t.owner.uid);
  eq((await snap(t.tripId)).reads.length, 2, 'admins see all reads');
});

test('polls: options, single/multi voting, close/reopen, delete permissions', async () => {
  const t = await newTrip();
  await as(t.B.uid);
  await rejects(api.createPoll(t.tripId, { question: 'מה?', options: ['רק אחת'] }), 'invalid_input', '< 2 options');
  await rejects(api.createPoll(t.tripId, { question: 'מה?', options: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }), 'invalid_input', '> 8 options');
  await rejects(api.createPoll(t.tripId, { question: '', options: ['a', 'b'] }), 'invalid_input', 'question');
  await rejects(api.createPoll(t.tripId, { question: 'מה?', options: ['a', ''] }), 'invalid_input', 'empty option');
  const pid = await api.createPoll(t.tripId, { question: 'כמה ארוחות על האש?', options: ['2 — צהריים וערב', '3 — כולל לילה'] });
  let s = await snap(t.tripId);
  const poll = s.polls.find((p) => p.id === pid);
  deepEq(poll.options, [{ id: 'o1', label: '2 — צהריים וערב' }, { id: 'o2', label: '3 — כולל לילה' }]);
  eq(poll.multi, false);
  eq(poll.closed, false);
  eq(poll.created_by, t.B.memberId);

  await rejects(api.votePoll(pid, ['o1', 'o2']), 'invalid_input', 'single choice');
  await rejects(api.votePoll(pid, ['o9']), 'invalid_input', 'unknown option');
  await api.votePoll(pid, ['o1']);
  await api.votePoll(pid, ['o2']);
  s = await snap(t.tripId);
  deepEq(s.poll_votes.filter((v) => v.poll_id === pid), [{ poll_id: pid, member_id: t.B.memberId, option_id: 'o2' }], 'replaced');

  await as(t.C.uid);
  await api.votePoll(pid, ['o2']);
  await rejects(api.closePoll(pid, true), 'forbidden');
  await rejects(api.deletePoll(pid), 'forbidden');
  await as(t.B.uid);
  await api.closePoll(pid, true);
  eq((await snap(t.tripId)).polls.find((p) => p.id === pid).closed, true);
  await as(t.C.uid);
  await rejects(api.votePoll(pid, []), 'not_allowed_state', 'closed');
  await as(t.owner.uid);
  await api.closePoll(pid, false);
  await as(t.C.uid);
  await api.votePoll(pid, []);
  eq((await snap(t.tripId)).poll_votes.filter((v) => v.poll_id === pid).length, 1, 'empty clears my votes');

  const multi = await api.createPoll(t.tripId, { question: 'מה עוד חוץ מבירה?', options: ['וודקה', 'ערק', 'יין'], multi: true });
  await api.votePoll(multi, ['o1', 'o3', 'o3']);
  s = await snap(t.tripId);
  deepEq(s.poll_votes.filter((v) => v.poll_id === multi).map((v) => v.option_id).sort(), ['o1', 'o3']);
  eq(s.polls[0].id, multi, 'newest first');

  await as(t.owner.uid);
  await api.deletePoll(pid);
  s = await snap(t.tripId);
  assert(!s.polls.some((p) => p.id === pid) && !s.poll_votes.some((v) => v.poll_id === pid), 'poll + votes deleted');
});

// ---------- devices ----------

test('device link: code for self only, partner device joins the same member, relink releases', async () => {
  const t = await newTrip();
  await as(t.B.uid);
  const code = await api.getDeviceCode(t.B.memberId);
  assert(/^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/.test(code), 'code format');
  eq(await api.getDeviceCode(t.B.memberId), code, 'stable');
  await rejects(api.getDeviceCode(newUid()), 'not_found');

  const partner = newUid();
  await as(partner);
  deepEq(await api.linkDevice(` ${code.toUpperCase()} `), { trip_id: t.tripId, member_id: t.B.memberId });
  let s = await snap(t.tripId);
  eq(s.me.member_id, t.B.memberId);
  eq(s.me.user_id, partner);
  eq((await api.myTrips())[0].member.id, t.B.memberId);
  await rejects(api.linkDevice('zzzzzzzzzz'), 'invalid_code');
  await api.leaveTrip(t.tripId);
  await as(t.B.uid);
  eq((await snap(t.tripId)).members.find((m) => m.id === t.B.memberId).claimed, true, 'still claimed by the other device');

  await as(t.C.uid);
  await api.linkDevice(code);
  s = await snap(t.tripId);
  eq(s.me.member_id, t.B.memberId, 'relinked');
  eq(s.members.find((m) => m.id === t.C.memberId).claimed, false, 'previous member released');
});

// ---------- push subscriptions ----------

test('push subscriptions: validate + upsert by endpoint; delete own rows only', async () => {
  const t = await newTrip();
  const sub = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'BPk', auth: 'xyz' } };
  eq(await api.savePushSubscription(t.tripId, sub), null);
  await api.savePushSubscription(t.tripId, { ...sub, keys: { p256dh: 'BPk2', auth: 'xyz2' } });
  await rejects(api.savePushSubscription(t.tripId, { endpoint: 'http://insecure', keys: sub.keys }), 'invalid_input');
  await rejects(api.savePushSubscription(t.tripId, { endpoint: sub.endpoint }), 'invalid_input', 'keys required');
  let db = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY));
  eq(db.push_subscriptions.length, 1, 'upsert by endpoint');
  eq(db.push_subscriptions[0].p256dh, 'BPk2');
  await as(t.B.uid);
  await api.deletePushSubscription(sub.endpoint);
  db = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY));
  eq(db.push_subscriptions.length, 1, 'cannot delete someone else’s');
  await as(t.owner.uid);
  await api.deletePushSubscription(sub.endpoint);
  db = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY));
  eq(db.push_subscriptions.length, 0);
  await as(newUid());
  await rejects(api.savePushSubscription(t.tripId, sub), 'forbidden');
});

// ---------- realtime, rev, demo tools ----------

test('rev is bumped by every mutation and subscribe fires for that trip only', async () => {
  const { tripId } = await fresh();
  const other = await api.createTrip({ name: 'טיול אחר' }, { display_name: 'אני' });
  let hits = 0;
  const unsub = api.subscribe(tripId, () => hits++);
  const rev0 = (await snap(tripId)).trip.rev;
  await api.addPersonal(tripId, 'בדיקה');
  await tick();
  eq(hits, 1, 'same-tab mutation fires');
  eq((await snap(tripId)).trip.rev, rev0 + 1, 'rev + 1');
  await api.addPersonal(other.trip_id, 'לא קשור');
  await snap(tripId);
  await tick();
  eq(hits, 1, 'other trips and reads do not fire');
  await rejects(api.addPersonal(tripId, ''), 'invalid_input');
  await tick();
  eq(hits, 1, 'failed calls do not fire');
  eq((await snap(tripId)).trip.rev, rev0 + 1, 'failed calls do not bump');

  const second = createDemoApi({ latency: 0 });
  await second.init();
  await second.addPersonal(tripId, 'ממופע אחר');
  await tick();
  eq(hits, 2, 'another api instance in the same tab');
  unsub();
  unsub();
  await api.addPersonal(tripId, 'אחרי ביטול');
  await tick();
  eq(hits, 2, 'unsubscribed');
});

test('demo.actAs relinks the current user; switchUser simulates another person', async () => {
  const { tripId, meId } = await fresh();
  const s = await snap(tripId);
  const maya = byName(s, 'מאיה ורון');
  const yoav = byName(s, 'יואב');
  deepEq(await api.demo.actAs(maya.id), { trip_id: tripId, member_id: maya.id });
  let s2 = await snap(tripId);
  eq(s2.me.member_id, maya.id);
  eq(s2.me.role, 'admin');
  deepEq(s2.personal_items.map((p) => p.title), ['משקפת לציפורים'], 'her private list');
  await api.demo.actAs(yoav.id);
  s2 = await snap(tripId);
  eq(s2.me.role, 'member');
  assert(s2.items.some((i) => i.status === 'rejected' && i.created_by === yoav.id), 'sees own rejected proposal');
  await rejects(api.sendAnnouncement(tripId, { title: 'x' }), 'forbidden');
  await api.demo.actAs(meId);
  eq((await snap(tripId)).me.role, 'owner');
  await rejects(api.demo.actAs(newUid()), 'not_found');

  const me = api.demo.currentUserId();
  const stranger = newUid();
  deepEq(await api.demo.switchUser(stranger), { userId: stranger });
  eq(api.getUserId(), stranger);
  eq(localStorage.getItem(DEMO_UID_KEY), stranger, 'persisted');
  deepEq(await api.ensureSession(), { userId: stranger });
  deepEq(await api.myTrips(), []);
  const created = await api.demo.switchUser();
  assert(created.userId && created.userId !== stranger, 'new id generated');
  await api.demo.switchUser(me);
  eq((await api.myTrips()).length, 1);
});

test('demo.reset wipes everything and re-seeds the sample trip for the current user', async () => {
  const { tripId } = await fresh();
  await api.createTrip({ name: 'זמני' }, { display_name: 'אני' });
  await api.addPersonal(tripId, 'עוד משהו');
  eq((await api.myTrips()).length, 2);
  let fired = 0;
  const unsub = api.subscribe(tripId, () => fired++);
  await api.demo.reset();
  await tick();
  unsub();
  assert(fired >= 1, 'subscribers told to refetch');
  const trips = await api.myTrips();
  eq(trips.length, 1);
  eq(trips[0].trip.name, SAMPLE_TRIP_NAME);
  eq(trips[0].member.role, 'owner');
  assert(trips[0].trip.id !== tripId, 'fresh ids');
  eq((await snap(trips[0].trip.id)).personal_items.length, 5, 'seed personal items');
});

test('default latency is 60–120 ms; storage-less mode still works (in memory)', async () => {
  const slow = createDemoApi();
  await slow.init();
  const t0 = performance.now();
  await slow.myTrips();
  const dt = performance.now() - t0;
  assert(dt >= 55 && dt < 1000, `latency ${dt.toFixed(0)}ms`);

  const before = localStorage.getItem(DEMO_STORAGE_KEY);
  const mem = createDemoApi({ storage: null, latency: 0 });
  await mem.init();
  const { userId } = await mem.ensureSession();
  assert(userId, 'has a user');
  const trips = await mem.myTrips();
  eq(trips.length, 1, 'seeded in memory');
  await mem.addPersonal(trips[0].trip.id, 'בזיכרון');
  eq(localStorage.getItem(DEMO_STORAGE_KEY), before, 'localStorage untouched');
});
