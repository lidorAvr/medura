// Unit tests for js/lib/logic.js — run in a real browser by tests/web/logic.html
// (pytest drives it through tests/test_logic.py). Tiny in-file harness, no deps.
import * as L from '../../js/lib/logic.js';

// ───────────────────────── harness ─────────────────────────

const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });

function show(v) {
  try {
    return JSON.stringify(v, (_, x) => (x instanceof Map ? { Map: [...x.entries()] } : x === undefined ? '«undefined»' : x));
  } catch {
    return String(v);
  }
}

function deepEqual(a, b) {
  if (Object.is(a, b) || (a === 0 && b === 0)) return true;
  if (a instanceof Map && b instanceof Map) return deepEqual([...a.entries()], [...b.entries()]);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function eq(actual, expected, msg = '') {
  if (!deepEqual(actual, expected)) throw new Error(`${msg ? `${msg}: ` : ''}expected ${show(expected)}, got ${show(actual)}`);
}
function ok(cond, msg = 'expected condition to hold') {
  if (!cond) throw new Error(msg);
}
function has(text, needle, msg = '') {
  if (!String(text).includes(needle)) throw new Error(`${msg ? `${msg}: ` : ''}missing ${show(needle)} in:\n${text}`);
}
function hasLine(text, line) {
  if (!String(text).split('\n').includes(line)) throw new Error(`missing line ${show(line)} in:\n${text}`);
}

export function run() {
  const results = { passed: 0, failed: 0, failures: [], total: TESTS.length };
  for (const t of TESTS) {
    try {
      t.fn();
      results.passed++;
    } catch (e) {
      results.failed++;
      results.failures.push(`${t.name} — ${e && e.message ? e.message : e}`);
    }
  }
  return results;
}

/** Deterministic PRNG (mulberry32) for the property-style money tests. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RLM = String.fromCharCode(0x200f);
const LRM = String.fromCharCode(0x200e);
const NBSP = String.fromCharCode(0xa0);
const MAQAF = String.fromCharCode(0x05be);

// ───────────────────────── sample trip (fictional names) ─────────────────────────

function makeSnap(meId = 'mA') {
  const members = [
    { id: 'mA', display_name: 'איתי ונועה', headcount: 2, people: ['איתי', 'נועה'], role: 'owner', phone: '050-1111111', created_at: '2026-09-20T10:00:00Z' },
    { id: 'mB', display_name: 'מאיה ורון', headcount: 2, people: ['מאיה', 'רון'], role: 'admin', phone: '052-2222222', created_at: '2026-09-20T10:01:00Z' },
    { id: 'mC', display_name: 'יואב', headcount: 1, people: ['יואב'], role: 'member', phone: null, created_at: '2026-09-20T10:02:00Z' },
    { id: 'mD', display_name: 'שירה וטל', headcount: 2, people: ['שירה', 'טל'], role: 'member', phone: null, created_at: '2026-09-20T10:03:00Z' },
    { id: 'mE', display_name: 'אורי', headcount: 1, people: ['אורי'], role: 'member', phone: null, created_at: '2026-09-20T10:04:00Z' },
  ];
  const categories = [
    { id: 'c1', name: 'בשר ועוף', emoji: '🥩', sort: 1 },
    { id: 'c6', name: 'מנגל ובישול', emoji: '🔥', sort: 6 },
    { id: 'c8', name: 'ציוד קבוצתי', emoji: '⛺', sort: 8 },
    { id: 'c9', name: 'כיף ומשחקים', emoji: '🎲', sort: 9 },
    { id: 'c10', name: 'משימות', emoji: '📋', sort: 10 },
  ];
  const it = (id, o) => ({
    id, category_id: null, note: null, qty: null, unit: null, per_person: false, needed: 1, status: 'active',
    done: false, done_at: null, reject_reason: null, created_by: 'mA', approved_by: null, sort: 0,
    created_at: '2026-09-21T10:00:00Z', updated_at: '2026-09-21T10:00:00Z', ...o,
  });
  const items = [
    it('i1', { category_id: 'c1', title: 'סטייק אנטריקוט', type: 'buy', qty: 300, unit: 'גרם', per_person: true, sort: 1 }),
    it('i2', { category_id: 'c1', title: 'פרגיות', type: 'buy', qty: 400, unit: 'גרם', per_person: true, sort: 2 }),
    it('i3', { category_id: 'c1', title: 'כנפיים', type: 'buy', qty: 1, unit: 'ק"ג', status: 'proposed', created_by: 'mC', sort: 3 }),
    it('i4', { category_id: 'c8', title: 'כסאות ים', type: 'bring', needed: 10, sort: 1 }),
    it('i5', { category_id: 'c6', title: 'מלקחיים', type: 'bring', needed: 2, sort: 1 }),
    it('i6', { category_id: 'c6', title: 'מחבת גדולה', type: 'bring', needed: 2, sort: 2 }),
    it('i7', { category_id: 'c6', title: 'קרש חיתוך + סכין + מזלג', type: 'each', sort: 3 }),
    it('i8', { category_id: 'c10', title: 'לשריין מקרר', type: 'task', sort: 1 }),
    it('i9', { category_id: 'c10', title: 'להזמין כרטיסים', type: 'task', done: true, sort: 2 }),
    it('i10', { category_id: 'c9', title: 'רמקול נייד', type: 'bring', status: 'rejected', reject_reason: 'אסור מוזיקה', created_by: 'mC' }),
    it('i11', { category_id: 'c6', title: 'תבלין על האש', type: 'bring', sort: 5 }),
    it('i12', { category_id: 'c6', title: 'פחמים', type: 'buy', qty: 3, unit: 'חבילות', done: true, sort: 0 }),
    it('i13', { category_id: null, title: 'גזיבו', type: 'bring' }),
    it('i14', { category_id: null, title: 'קפה טורקי', type: 'bring', created_at: '2026-09-21T11:00:00Z' }),
  ];
  const pl = (id, item_id, member_id, qty = 1, done = false) => ({ id, item_id, member_id, qty, done, assigned_by: null, created_at: `2026-09-22T10:0${id.length % 10}:00Z` });
  const pledges = [
    pl('p1', 'i1', 'mB'),
    pl('p2', 'i4', 'mA', 2, true),
    pl('p3', 'i4', 'mC', 2),
    pl('p4', 'i5', 'mA', 1, true),
    pl('p5', 'i5', 'mB', 1, true),
    pl('p6', 'i6', 'mB', 1),
    pl('p7', 'i6', 'mC', 1),
    pl('p8', 'i7', 'mA', 1, true),
    pl('p9', 'i7', 'mB', 1, false),
    pl('p10', 'i8', 'mA'),
    pl('p11', 'i9', 'mA'),
    pl('p12', 'i12', 'mA'),
    pl('p13', 'i13', 'mE'),
    pl('p14', 'i3', 'mC'),
    pl('p15', 'i10', 'mC'),
  ];
  const expenses = [
    { id: 'e1', title: 'קניות בשר', amount: 480, paid_by: 'mB', category_id: 'c1', note: null, split_mode: 'all', created_by: 'mB', spent_on: '2026-09-30', created_at: '2026-09-30T10:00:00Z' },
    { id: 'e2', title: 'פחמים ומצתים', amount: 90, paid_by: 'mA', category_id: 'c6', note: null, split_mode: 'members', created_by: 'mA', spent_on: '2026-09-30', created_at: '2026-09-30T11:00:00Z' },
    { id: 'e3', title: 'קרח', amount: 100, paid_by: 'mC', category_id: null, note: null, split_mode: 'members', created_by: 'mC', spent_on: '2026-10-01', created_at: '2026-10-01T08:00:00Z' },
  ];
  const expense_shares = [
    { expense_id: 'e2', member_id: 'mA', weight: null },
    { expense_id: 'e2', member_id: 'mC', weight: 1 },
    { expense_id: 'e2', member_id: 'mE', weight: 1 },
    { expense_id: 'e3', member_id: 'mE', weight: 1 },
    { expense_id: 'e3', member_id: 'mD', weight: 1 },
    { expense_id: 'e3', member_id: 'mC', weight: 1 },
  ];
  const payments = [
    { id: 'pay1', from_member: 'mD', to_member: 'mB', amount: 100, method: 'bit', note: null, status: 'sent', created_by: 'mD', created_at: '2026-10-02T10:00:00Z', confirmed_at: null },
    { id: 'pay2', from_member: 'mE', to_member: 'mB', amount: 50, method: 'paybox', note: null, status: 'confirmed', created_by: 'mE', created_at: '2026-10-02T11:00:00Z', confirmed_at: '2026-10-02T12:00:00Z' },
  ];
  const n = (id, o) => ({ id, kind: 'announcement', title: id, body: '', audience: null, author_member: null, urgent: false, link: null, ...o });
  const notifications = [
    n('n1', { author_member: 'mB', created_at: '2026-09-27T10:00:00Z' }),
    n('n2', { kind: 'system', audience: ['mA'], created_at: '2026-09-27T11:00:00Z' }),
    n('n3', { kind: 'system', audience: ['mC'], created_at: '2026-09-27T12:00:00Z' }),
    n('n4', { audience: ['mC'], author_member: 'mA', created_at: '2026-09-27T13:00:00Z' }),
    n('n5', { audience: ['mD'], author_member: 'mB', created_at: '2026-09-27T14:00:00Z' }),
  ];
  const reads = [
    { notification_id: 'n1', member_id: 'mA', read_at: '2026-09-27T10:05:00Z' },
    { notification_id: 'n2', member_id: 'mB', read_at: '2026-09-27T11:05:00Z' },
  ];
  const me = members.find((m) => m.id === meId);
  return {
    trip: {
      id: 't1', name: 'טיול לפארק החבשושיות', emoji: '⛺', location: 'פארק החבשושיות', location_url: null, lat: 32.0853, lon: 34.7818,
      starts_at: '2026-10-01T09:00:00+03:00', ends_at: '2026-10-02T12:00:00+03:00',
      info: { schedule: [], rules: [], notes: '' }, settings: { require_approval: true }, invite_code: 'abc234xyz9', rev: 7, created_at: '2026-09-20T10:00:00Z',
    },
    me: { member_id: meId, role: me ? me.role : 'member', user_id: 'u1' },
    members, categories, items, pledges, expenses, expense_shares, payments, notifications, reads,
    admin_votes: [
      { voter_id: 'mA', candidate_id: 'mC' },
      { voter_id: 'mB', candidate_id: 'mC' },
      { voter_id: 'mD', candidate_id: 'mC' },
      { voter_id: 'mA', candidate_id: 'mE' },
      { voter_id: 'mA', candidate_id: 'mC' },
    ],
    polls: [], poll_votes: [], personal_items: [],
  };
}
const byId = (arr, id) => arr.find((x) => x.id === id);

// ───────────────────────── members ─────────────────────────

test('headcountTotal: empty and null', () => {
  eq(L.headcountTotal([]), 0);
  eq(L.headcountTotal(null), 0);
  eq(L.headcountTotal(undefined), 0);
});
test('headcountTotal: couples count double, missing/invalid headcount = 1', () => {
  eq(L.headcountTotal([{ headcount: 2 }, { headcount: 1 }, {}, { headcount: '2' }, { headcount: 0 }]), 7);
  eq(L.headcountTotal(makeSnap().members), 8);
});
test('membersById builds a Map by id', () => {
  const map = L.membersById(makeSnap().members);
  ok(map instanceof Map, 'returns a Map');
  eq(map.size, 5);
  eq(map.get('mC').display_name, 'יואב');
  eq(L.membersById(null).size, 0);
});
test('isAdmin: owner/admin true, member/null false', () => {
  eq(L.isAdmin({ role: 'owner' }), true);
  eq(L.isAdmin({ role: 'admin' }), true);
  eq(L.isAdmin({ role: 'member' }), false);
  eq(L.isAdmin(null), false);
  eq(L.isAdmin(undefined), false);
});
test('displayName: display_name, people fallback, generic fallback', () => {
  eq(L.displayName({ display_name: '  מאיה ורון ' }), 'מאיה ורון');
  eq(L.displayName({ display_name: '', people: ['הדס', 'עידו'] }), 'הדס ועידו');
  eq(L.displayName({ display_name: null, people: ['יואב'] }), 'יואב');
  eq(L.displayName({ display_name: '', people: [] }), 'חבר/ה');
  eq(L.displayName(null), 'חבר/ה');
});

// ───────────────────────── quantities ─────────────────────────

test('itemEffectiveQty: 300 גרם per person × 11 = 3.3 ק"ג', () => {
  eq(L.itemEffectiveQty({ qty: 300, unit: 'גרם', per_person: true }, 11), { value: 3.3, unit: 'ק"ג', text: '3.3 ק"ג' });
});
test('itemEffectiveQty: whole kilos drop the .0', () => {
  eq(L.itemEffectiveQty({ qty: 400, unit: 'גרם', per_person: true }, 10), { value: 4, unit: 'ק"ג', text: '4 ק"ג' });
});
test('itemEffectiveQty: under 1000 גרם stays in grams', () => {
  eq(L.itemEffectiveQty({ qty: 300, unit: 'גרם', per_person: true }, 3), { value: 900, unit: 'גרם', text: '900 גרם' });
});
test('itemEffectiveQty: grams round half-up to one decimal kilo', () => {
  eq(L.itemEffectiveQty({ qty: 335, unit: 'גרם', per_person: true }, 10).text, '3.4 ק"ג');
  eq(L.itemEffectiveQty({ qty: 1000, unit: 'גרם' }, 5).text, '1 ק"ג');
});
test('itemEffectiveQty: per-person counts are integers', () => {
  eq(L.itemEffectiveQty({ qty: 8, unit: 'יח׳', per_person: true }, 11), { value: 88, unit: 'יח׳', text: '88 יח׳' });
  eq(L.itemEffectiveQty({ qty: 0.5, unit: 'בקבוקים', per_person: true }, 11).value, 6);
});
test('itemEffectiveQty: plain counts and unitless numbers', () => {
  eq(L.itemEffectiveQty({ qty: 12, unit: null }, 11), { value: 12, unit: null, text: '12' });
  eq(L.itemEffectiveQty({ qty: '50', unit: '' }, 11).text, '50');
  eq(L.itemEffectiveQty({ qty: 2, unit: 'חבילות' }, 11).text, '2 חבילות');
  eq(L.itemEffectiveQty({ qty: 1, unit: 'חבילות' }, 11).text, '1 חבילה');
});
test('itemEffectiveQty: null qty / unit are handled', () => {
  eq(L.itemEffectiveQty({ qty: null, unit: null }, 11), { value: null, unit: null, text: '' });
  eq(L.itemEffectiveQty({ qty: null, unit: 'חבילות', per_person: true }, 11).text, '');
  eq(L.itemEffectiveQty({}, 11).text, '');
});
test('itemEffectiveQty: per person with 0 heads is 0, non per-person ignores heads', () => {
  eq(L.itemEffectiveQty({ qty: 300, unit: 'גרם', per_person: true }, 0).value, 0);
  eq(L.itemEffectiveQty({ qty: 3, unit: 'חבילות', per_person: false }, 40).text, '3 חבילות');
});
test('itemEffectiveQty: unit aliases normalise (קילו → ק"ג)', () => {
  eq(L.itemEffectiveQty({ qty: 2, unit: 'קילו' }, 5), { value: 2, unit: 'ק"ג', text: '2 ק"ג' });
});
test('formatQty: conversions, singular/plural, empty', () => {
  eq(L.formatQty(1500, 'מ"ל'), '1.5 ליטר');
  eq(L.formatQty(2, 'גליל'), '2 גלילים');
  eq(L.formatQty(1, 'גליל'), '1 גליל');
  eq(L.formatQty(1, 'בקבוקים'), '1 בקבוק');
  eq(L.formatQty(2.5, null), '2.5');
  eq(L.formatQty(1234, null), '1,234');
  eq(L.formatQty(null, 'גרם'), '');
  eq(L.formatQty(3300, 'גרם'), '3.3 ק"ג');
  eq(L.formatQty(2, 'חבילות של 12'), '2 חבילות של 12');
});

// ───────────────────────── item progress ─────────────────────────

const member3 = [{ id: 'a', headcount: 2 }, { id: 'b', headcount: 1 }, { id: 'c', headcount: 2 }];

test('itemProgress buy: missing → covered → done', () => {
  const item = { id: 'x', type: 'buy', status: 'active', done: false };
  eq(L.itemProgress(item, [], member3).state, 'missing');
  const p = [{ item_id: 'x', member_id: 'a', qty: 1, done: false }];
  const r = L.itemProgress(item, p, member3);
  eq(r.state, 'covered');
  eq(r.pledgers, [{ member_id: 'a', qty: 1, done: false }]);
  eq([r.pledged, r.needed, r.doneCount, r.total], [1, 1, 0, 1]);
  eq(L.itemProgress({ ...item, done: true }, p, member3).state, 'done');
  eq(L.itemProgress({ ...item, done: true }, [], member3).state, 'done', 'done wins even without a pledge');
});
test('itemProgress task behaves like buy', () => {
  const item = { id: 't', type: 'task', status: 'active', done: false };
  eq(L.itemProgress(item, null, member3).state, 'missing');
  eq(L.itemProgress(item, [{ item_id: 't', member_id: 'b', qty: 1 }], member3).state, 'covered');
  eq(L.itemProgress({ ...item, done: true }, [], member3).doneCount, 1);
});
test('itemProgress bring: missing / partial / covered / done', () => {
  const item = { id: 'ch', type: 'bring', status: 'active', needed: 10 };
  eq(L.itemProgress(item, [], member3).state, 'missing');
  const partial = L.itemProgress(item, [{ item_id: 'ch', member_id: 'a', qty: 2, done: true }, { item_id: 'ch', member_id: 'b', qty: 2 }], member3);
  eq([partial.state, partial.pledged, partial.needed, partial.doneCount, partial.total], ['partial', 4, 10, 1, 2]);
  const covered = L.itemProgress(item, [{ item_id: 'ch', member_id: 'a', qty: 6, done: true }, { item_id: 'ch', member_id: 'b', qty: 4 }], member3);
  eq(covered.state, 'covered', 'covered while one pledge is not packed');
  const done = L.itemProgress(item, [{ item_id: 'ch', member_id: 'a', qty: 6, done: true }, { item_id: 'ch', member_id: 'b', qty: 5, done: true }], member3);
  eq([done.state, done.pledged], ['done', 11]);
});
test('itemProgress bring: needed defaults to 1', () => {
  eq(L.itemProgress({ id: 'g', type: 'bring', status: 'active' }, [{ item_id: 'g', member_id: 'a', qty: 1 }], member3).state, 'covered');
});
test('itemProgress each: total = members, done only when everyone done', () => {
  const item = { id: 'e', type: 'each', status: 'active' };
  const r0 = L.itemProgress(item, [], member3);
  eq([r0.state, r0.total, r0.doneCount], ['missing', 3, 0]);
  const r1 = L.itemProgress(item, [{ item_id: 'e', member_id: 'a', done: true }, { item_id: 'e', member_id: 'b', done: false }], member3);
  eq([r1.state, r1.doneCount, r1.total, r1.needed], ['partial', 1, 3, 3]);
  const all = member3.map((m) => ({ item_id: 'e', member_id: m.id, done: true }));
  eq(L.itemProgress(item, all, member3).state, 'done');
  const ghost = [{ item_id: 'e', member_id: 'ghost', done: true }];
  eq(L.itemProgress(item, ghost, member3).doneCount, 0, 'pledges of unknown members are ignored');
});
test('itemProgress each with 0 members is missing (never auto-done)', () => {
  const r = L.itemProgress({ id: 'e', type: 'each', status: 'active' }, [], []);
  eq([r.state, r.total], ['missing', 0]);
});
test('itemProgress: proposed/rejected override state; other items ignored', () => {
  const pledges = [{ item_id: 'p', member_id: 'a', qty: 1 }, { item_id: 'other', member_id: 'b', qty: 3 }];
  const r = L.itemProgress({ id: 'p', type: 'bring', status: 'proposed', needed: 1 }, pledges, member3);
  eq([r.state, r.pledged], ['proposed', 1]);
  eq(L.itemProgress({ id: 'p', type: 'buy', status: 'rejected' }, pledges, member3).state, 'rejected');
});

// ───────────────────────── readiness / agenda / missing ─────────────────────────

test('tripReadiness on the sample trip', () => {
  eq(L.tripReadiness(makeSnap()), { pct: 58, total: 12, covered: 7, missing: 3, partial: 2, proposed: 1, done: 3 });
});
test('tripReadiness: empty / null snapshot', () => {
  eq(L.tripReadiness({ items: [], members: [], pledges: [] }), { pct: 0, total: 0, covered: 0, missing: 0, partial: 0, proposed: 0, done: 0 });
  eq(L.tripReadiness(null).pct, 0);
});
test('tripReadiness: 100% only when everything is covered; floor otherwise', () => {
  const items = [0, 1, 2].map((i) => ({ id: `b${i}`, type: 'buy', status: 'active' }));
  const pledges = [{ item_id: 'b0', member_id: 'a' }, { item_id: 'b1', member_id: 'a' }];
  eq(L.tripReadiness({ items, pledges, members: member3 }).pct, 66);
  pledges.push({ item_id: 'b2', member_id: 'b' });
  eq(L.tripReadiness({ items, pledges, members: member3 }).pct, 100);
});
test('tripReadiness: each-items count as covered only when done', () => {
  const items = [{ id: 'e', type: 'each', status: 'active' }];
  const almost = { items, members: member3, pledges: [{ item_id: 'e', member_id: 'a', done: true }, { item_id: 'e', member_id: 'b', done: true }] };
  eq(L.tripReadiness(almost), { pct: 0, total: 1, covered: 0, missing: 0, partial: 1, proposed: 0, done: 0 });
  almost.pledges.push({ item_id: 'e', member_id: 'c', done: true });
  eq(L.tripReadiness(almost).pct, 100);
});
test('myAgenda: buckets, order, each done flags, packedPct', () => {
  const a = L.myAgenda(makeSnap(), 'mA');
  eq(a.bring.map((x) => x.item.id), ['i5', 'i4'], 'bring sorted by category sort');
  eq(a.bring[1].pledge.qty, 2);
  eq(a.buy.map((x) => x.item.id), ['i12']);
  eq(a.tasks.map((x) => x.item.id), ['i8', 'i9']);
  eq(a.each.map((x) => [x.item.id, x.done]), [['i7', true]]);
  eq(a.packedPct, 83);
});
test('myAgenda: includes my proposed items, excludes rejected, each not done', () => {
  const a = L.myAgenda(makeSnap(), 'mC');
  eq(a.buy.map((x) => x.item.id), ['i3']);
  eq(a.bring.map((x) => x.item.id), ['i6', 'i4']);
  eq(a.each.map((x) => [x.item.id, x.done]), [['i7', false]]);
  ok(![...a.bring, ...a.buy, ...a.tasks].some((x) => x.item.id === 'i10'), 'rejected item must not appear');
  eq(a.packedPct, 0);
});
test('myAgenda: defaults to snap.me and handles no member', () => {
  eq(L.myAgenda(makeSnap('mA')).tasks.length, 2);
  eq(L.myAgenda({ items: [], pledges: [] }, null), { bring: [], buy: [], tasks: [], each: [], packedPct: 0 });
});
test('missingItems: active missing/partial sorted by category then item sort', () => {
  eq(L.missingItems(makeSnap()).map((i) => i.id), ['i2', 'i7', 'i11', 'i4', 'i14']);
  eq(L.missingItems(null), []);
});

// ───────────────────────── money ─────────────────────────

const singles3 = { members: [{ id: 'a', headcount: 1 }, { id: 'b', headcount: 1 }, { id: 'c', headcount: 1 }] };
const sumCents = (shares) => shares.reduce((s, x) => s + Math.round(x.amount * 100), 0);

test('expenseShares: ₪100 three ways → 33.34 / 33.33 / 33.33', () => {
  const s = L.expenseShares({ id: 'x', amount: 100, split_mode: 'all' }, singles3);
  eq(s, [{ member_id: 'a', amount: 33.34 }, { member_id: 'b', amount: 33.33 }, { member_id: 'c', amount: 33.33 }]);
  eq(sumCents(s), 10000);
});
test('expenseShares: couples weigh 2 (split all)', () => {
  const snap = { members: [{ id: 'a', headcount: 2 }, { id: 'b', headcount: 1 }, { id: 'c', headcount: 2 }, { id: 'd', headcount: 1 }] };
  eq(L.expenseShares({ id: 'x', amount: 100, split_mode: 'all' }, snap).map((s) => s.amount), [33.33, 16.67, 33.33, 16.67]);
});
test('expenseShares: split "all" includes members who joined later', () => {
  const snap = makeSnap();
  const before = L.expenseShares(snap.expenses[0], snap);
  eq(before.map((s) => s.amount), [120, 120, 60, 120, 60]);
  snap.members.push({ id: 'mF', display_name: 'חדש', headcount: 4 });
  const after = L.expenseShares(snap.expenses[0], snap);
  eq(after.length, 6);
  eq(after.find((s) => s.member_id === 'mF').amount, 160);
});
test('expenseShares: custom split uses expense_shares weights (default = headcount)', () => {
  const snap = makeSnap();
  eq(L.expenseShares(snap.expenses[1], snap), [{ member_id: 'mA', amount: 45 }, { member_id: 'mC', amount: 22.5 }, { member_id: 'mE', amount: 22.5 }]);
  eq(L.expenseShares(snap.expenses[2], snap), [{ member_id: 'mC', amount: 33.34 }, { member_id: 'mD', amount: 33.33 }, { member_id: 'mE', amount: 33.33 }], 'ordered by member order');
});
test('expenseShares: explicit weights and live preview via expense.members', () => {
  const snap = { members: singles3.members, expense_shares: [] };
  const preview = { amount: 10, split_mode: 'members', members: [{ member_id: 'b', weight: 3 }, { member_id: 'c' }] };
  eq(L.expenseShares(preview, snap), [{ member_id: 'b', amount: 7.5 }, { member_id: 'c', amount: 2.5 }]);
});
test('expenseShares: no participants → []', () => {
  eq(L.expenseShares({ id: 'x', amount: 50, split_mode: 'all' }, { members: [] }), []);
  eq(L.expenseShares({ id: 'x', amount: 50, split_mode: 'members' }, { members: singles3.members, expense_shares: [] }), []);
  eq(L.expenseShares(null, singles3), []);
});
test('expenseShares: 400 random splits always sum exactly and stay within 1 agora of fair', () => {
  const rand = rng(42);
  for (let k = 0; k < 400; k++) {
    const n = 1 + Math.floor(rand() * 9);
    const members = Array.from({ length: n }, (_, i) => ({ id: `m${i}`, headcount: 1 + Math.floor(rand() * 4) }));
    const cents = 1 + Math.floor(rand() * 5000000);
    const amount = cents / 100;
    const shares = L.expenseShares({ id: 'x', amount, split_mode: 'all' }, { members });
    const W = members.reduce((s, m) => s + m.headcount, 0);
    if (sumCents(shares) !== cents) throw new Error(`sum mismatch for ${amount} over ${show(members)}`);
    shares.forEach((s, i) => {
      const exact = (cents * members[i].headcount) / W;
      const got = Math.round(s.amount * 100);
      if (got < Math.floor(exact) || got > Math.ceil(exact)) throw new Error(`unfair share ${got} vs ${exact}`);
    });
  }
});
test('balances: sample trip (payments count when sent, confirmed or not)', () => {
  const b = L.balances(makeSnap());
  eq(b, [
    { member_id: 'mA', paid: 90, owed: 165, sent: 0, received: 0, balance: -75 },
    { member_id: 'mB', paid: 480, owed: 120, sent: 0, received: 150, balance: 210 },
    { member_id: 'mC', paid: 100, owed: 115.84, sent: 0, received: 0, balance: -15.84 },
    { member_id: 'mD', paid: 0, owed: 153.33, sent: 100, received: 0, balance: -53.33 },
    { member_id: 'mE', paid: 0, owed: 115.83, sent: 50, received: 0, balance: -65.83 },
  ]);
  eq(Math.round(b.reduce((s, x) => s + x.balance, 0) * 100), 0, 'balances sum to zero');
});
test('balances: partial payment settles only part of the debt', () => {
  const snap = {
    members: singles3.members,
    expenses: [{ id: 'x', amount: 90, paid_by: 'a', split_mode: 'all' }],
    expense_shares: [],
    payments: [{ from_member: 'b', to_member: 'a', amount: 10, status: 'sent' }],
  };
  eq(L.balances(snap).map((x) => x.balance), [50, -20, -30]);
});
test('balances: null snapshot → []', () => {
  eq(L.balances(null), []);
});
test('settlePlan: sample trip, greedy largest-first, whole shekels', () => {
  eq(L.settlePlan(L.balances(makeSnap())), [
    { from: 'mA', to: 'mB', amount: 75 },
    { from: 'mE', to: 'mB', amount: 66 },
    { from: 'mD', to: 'mB', amount: 53 },
    { from: 'mC', to: 'mB', amount: 16 },
  ]);
});
test('settlePlan: two creditors, largest debtor pays largest creditor first', () => {
  const plan = L.settlePlan([
    { member_id: 'a', balance: 100 },
    { member_id: 'b', balance: 50 },
    { member_id: 'c', balance: -120 },
    { member_id: 'd', balance: -30 },
  ]);
  // after c→a, d (owes 30) is now the largest debtor
  eq(plan, [
    { from: 'c', to: 'a', amount: 100 },
    { from: 'd', to: 'b', amount: 30 },
    { from: 'c', to: 'b', amount: 20 },
  ]);
});
test('settlePlan: transfers under ₪1 are omitted; balanced group → []', () => {
  eq(L.settlePlan([{ member_id: 'a', balance: 0.6 }, { member_id: 'b', balance: -0.6 }]), []);
  eq(L.settlePlan([{ member_id: 'a', balance: 0 }, { member_id: 'b', balance: 0 }]), []);
  eq(L.settlePlan([]), []);
  eq(L.settlePlan(null), []);
});
test('settlePlan: 3-way ₪100 split rounds to whole shekels', () => {
  const snap = { members: singles3.members, expenses: [{ id: 'x', amount: 100, paid_by: 'a', split_mode: 'all' }], payments: [] };
  eq(L.settlePlan(L.balances(snap)), [{ from: 'b', to: 'a', amount: 33 }, { from: 'c', to: 'a', amount: 33 }]);
});
test('settlePlan: 300 random groups — valid transfers, total ≈ debt, residuals tiny', () => {
  const rand = rng(7);
  for (let k = 0; k < 300; k++) {
    const n = 2 + Math.floor(rand() * 10);
    const cents = Array.from({ length: n - 1 }, () => Math.round((rand() - 0.5) * 200000));
    cents.push(-cents.reduce((s, c) => s + c, 0));
    const bal = cents.map((c, i) => ({ member_id: `m${i}`, balance: c / 100 }));
    const plan = L.settlePlan(bal);
    const debt = cents.filter((c) => c < 0).reduce((s, c) => s - c, 0) / 100;
    const moved = plan.reduce((s, p) => s + p.amount, 0);
    const left = new Map(bal.map((b) => [b.member_id, b.balance]));
    for (const p of plan) {
      if (p.from === p.to) throw new Error('self transfer');
      if (!Number.isInteger(p.amount) || p.amount < 1) throw new Error(`bad amount ${p.amount}`);
      if (!(bal.find((b) => b.member_id === p.from).balance < 0)) throw new Error('payer is not a debtor');
      if (!(bal.find((b) => b.member_id === p.to).balance > 0)) throw new Error('payee is not a creditor');
      left.set(p.from, left.get(p.from) + p.amount);
      left.set(p.to, left.get(p.to) - p.amount);
    }
    if (plan.length > n - 1) throw new Error(`too many transfers: ${plan.length} for ${n}`);
    if (Math.abs(moved - debt) > n * 0.5 + 1e-9) throw new Error(`moved ${moved} vs debt ${debt}`);
    for (const v of left.values()) if (Math.abs(v) > n) throw new Error(`residual ${v} too large`);
  }
});
test('tripTotals: spent, heads, per head', () => {
  eq(L.tripTotals(makeSnap()), { spent: 670, perHead: 83.75, heads: 8 });
  eq(L.tripTotals({ members: [], expenses: [{ amount: 10 }] }), { spent: 10, perHead: 0, heads: 0 });
  eq(L.tripTotals(null), { spent: 0, perHead: 0, heads: 0 });
});
test('formatMoney', () => {
  eq(L.formatMoney(1234), '₪1,234');
  eq(L.formatMoney(12.5), '₪12.50');
  eq(L.formatMoney(0), '₪0');
  eq(L.formatMoney(-12.5), '-₪12.50');
  eq(L.formatMoney(null), '₪0');
  eq(L.formatMoney('99.999'), '₪100');
  eq(L.formatMoney(1234.567), '₪1,234.57');
  eq(L.formatMoney(-0.001), '₪0');
});

// ───────────────────────── list parser: real-list fixture (SPEC §9) ─────────────────────────

const FIXTURE = [
  "רשימה 1: קניות בסופר ",
  "🥩 בשרים ועופות",
  " סטייק אנטריקוט-פר אדם 300 גרם",
  " פרגיות-פר אדם 400 גרם",
  "נקניקיות- 2 חבילות",
  "מרגז- פר אדם- 8 יחידות ",
  " קבבים-פר אדם -8 יחידות",
  "",
  "🥗 ירקות, פירות וסלטים",
  "12-עגבניות",
  "10 מלפפונים",
  "5 בצל",
  "8 פלפל חריף",
  "חבילת שום",
  "אבטיח",
  "מיץ לימון",
  "סלטים מוכנים: חומוס, טחינה, מטבוחה, סלט טורקי (מגוון סלטים)",
  "",
  "קטשופ ",
  "מיונז",
  "50 פיתות",
  "2 חבילות ביצים של 12",
  "4 קילו מולטי עגבניות מרוסקות",
  "2 בקבוקי שמן קנולה ",
  "15 חטיפים ",
  "עוגיות לבוקר שוקולד צ׳יפס ",
  "",
  "🍽️ חד-פעמי",
  "צלחות גדולות 100 יחידות",
  "4 חבילות של כוסות חד״פ גדולות ",
  "100 מזלגות ",
  "100 סכינים",
  "100 כפות",
  "קשים",
  "חבילת תבניות אלומניום ",
  "גליל שקיות זבל ",
  "חבילה קטנה נייר כסף",
  "1 חבילת נייר סופג",
  "",
  "רשימה 2:",
  "☕ שתייה, אלכוהול ומצרכים למנגל",
  " 2 שישיות מים",
  "15 בקבוקים שתיה מתוקה ",
  "36 בקבוקים של בירות",
  "12 בקבוקים בריזר ",
  "2 יין לבן (מבעבע כי נועה אוהבת)",
  " 3 חבילות פחמים ",
  "חומר מדליק",
  "בלון גז לגזיה",
  "",
  "חלוקה של כל אחד מהבית",
  "4 קרשי חיתוך -כל זוג ",
  "4 סכינים -כל זוג",
  "4 מזלגות -כל זוג",
  "2 מלקחיים (רון ומאיה) (איתי ונועה)",
  "2 מחבתות גדולות- (רון ומאיה) ועוד זוג ",
  "פינג׳אן לקפה וגזייה ומנגל (איתי ונועה)",
  "מנגל נוסף (אם יש למישהו מנגל קטן שיביא)",
  "",
  "תבלינים -פלפל שחור, פפריקה מתוקה וחריפה, מלח, צ׳ילי גרוס, סוכר, תבלין על האש, מלח גס ",
  "קפה טורקי",
  "(מי יכול להביא ?)",
  "",
  "נפנף- למי יש ויכול להביא ?",
  "",
].join('\n');

// [category name | null, type, title, qty, unit, per_person, note]
const FIXTURE_EXPECTED = [
  ['בשר ועוף', 'buy', 'סטייק אנטריקוט', 300, 'גרם', true, null],
  ['בשר ועוף', 'buy', 'פרגיות', 400, 'גרם', true, null],
  ['בשר ועוף', 'buy', 'נקניקיות', 2, 'חבילות', false, null],
  ['בשר ועוף', 'buy', 'מרגז', 8, 'יח׳', true, null],
  ['בשר ועוף', 'buy', 'קבבים', 8, 'יח׳', true, null],
  ['ירקות ופירות', 'buy', 'עגבניות', 12, null, false, null],
  ['ירקות ופירות', 'buy', 'מלפפונים', 10, null, false, null],
  ['ירקות ופירות', 'buy', 'בצל', 5, null, false, null],
  ['ירקות ופירות', 'buy', 'פלפל חריף', 8, null, false, null],
  ['ירקות ופירות', 'buy', 'שום', 1, 'חבילות', false, null],
  ['ירקות ופירות', 'buy', 'אבטיח', null, null, false, null],
  ['ירקות ופירות', 'buy', 'מיץ לימון', null, null, false, null],
  ['ירקות ופירות', 'buy', 'סלטים מוכנים', null, null, false, 'חומוס, טחינה, מטבוחה, סלט טורקי · מגוון סלטים'],
  ['ירקות ופירות', 'buy', 'קטשופ', null, null, false, null],
  ['ירקות ופירות', 'buy', 'מיונז', null, null, false, null],
  ['ירקות ופירות', 'buy', 'פיתות', 50, null, false, null],
  ['ירקות ופירות', 'buy', 'ביצים של 12', 2, 'חבילות', false, null],
  ['ירקות ופירות', 'buy', 'מולטי עגבניות מרוסקות', 4, 'ק"ג', false, null],
  ['ירקות ופירות', 'buy', 'שמן קנולה', 2, 'בקבוקים', false, null],
  ['ירקות ופירות', 'buy', 'חטיפים', 15, null, false, null],
  ['ירקות ופירות', 'buy', 'עוגיות לבוקר שוקולד צ׳יפס', null, null, false, null],
  [`חד${MAQAF}פעמי`, 'buy', 'צלחות גדולות', 100, 'יח׳', false, null],
  [`חד${MAQAF}פעמי`, 'buy', 'כוסות חד״פ גדולות', 4, 'חבילות', false, null],
  [`חד${MAQAF}פעמי`, 'buy', 'מזלגות', 100, null, false, null],
  [`חד${MAQAF}פעמי`, 'buy', 'סכינים', 100, null, false, null],
  [`חד${MAQAF}פעמי`, 'buy', 'כפות', 100, null, false, null],
  [`חד${MAQAF}פעמי`, 'buy', 'קשים', null, null, false, null],
  [`חד${MAQAF}פעמי`, 'buy', 'תבניות אלומניום', 1, 'חבילות', false, null],
  [`חד${MAQAF}פעמי`, 'buy', 'שקיות זבל', 1, 'גליל', false, null],
  [`חד${MAQAF}פעמי`, 'buy', 'נייר כסף', 1, 'חבילות', false, 'חבילה קטנה'],
  [`חד${MAQAF}פעמי`, 'buy', 'נייר סופג', 1, 'חבילות', false, null],
  ['שתייה ואלכוהול', 'buy', 'מים', 2, 'שישיות', false, null],
  ['שתייה ואלכוהול', 'buy', 'שתיה מתוקה', 15, 'בקבוקים', false, null],
  ['שתייה ואלכוהול', 'buy', 'בירות', 36, 'בקבוקים', false, null],
  ['שתייה ואלכוהול', 'buy', 'בריזר', 12, 'בקבוקים', false, null],
  ['שתייה ואלכוהול', 'buy', 'יין לבן', 2, null, false, 'מבעבע כי נועה אוהבת'],
  ['מנגל ובישול', 'buy', 'פחמים', 3, 'חבילות', false, null],
  ['מנגל ובישול', 'buy', 'חומר מדליק', null, null, false, null],
  ['מנגל ובישול', 'buy', 'בלון גז לגזיה', null, null, false, null],
  ['מנגל ובישול', 'each', 'קרשי חיתוך', null, null, false, null],
  ['מנגל ובישול', 'each', 'סכינים', null, null, false, null],
  ['מנגל ובישול', 'each', 'מזלגות', null, null, false, null],
  ['מנגל ובישול', 'bring', 'מלקחיים', 2, null, false, 'רון ומאיה · איתי ונועה'],
  ['מנגל ובישול', 'bring', 'מחבתות גדולות', 2, null, false, 'רון ומאיה · ועוד זוג'],
  ['מנגל ובישול', 'bring', 'פינג׳אן לקפה וגזייה ומנגל', null, null, false, 'איתי ונועה'],
  ['מנגל ובישול', 'bring', 'מנגל נוסף', null, null, false, 'אם יש למישהו מנגל קטן שיביא'],
  ['מנגל ובישול', 'bring', 'תבלינים', null, null, false, 'פלפל שחור, פפריקה מתוקה וחריפה, מלח, צ׳ילי גרוס, סוכר, תבלין על האש, מלח גס'],
  [null, 'bring', 'קפה טורקי', null, null, false, 'מי יכול להביא?'],
  ['מנגל ובישול', 'bring', 'נפנף', null, null, false, 'למי יש ויכול להביא?'],
];

const parsedFixture = () => L.parseListText(FIXTURE);
const findItem = (items, title) => {
  const it = items.find((x) => x.title === title);
  if (!it) throw new Error(`no item titled ${show(title)}; titles: ${show(items.map((x) => x.title))}`);
  return it;
};

test('fixture: uses the real group message with names replaced', () => {
  has(FIXTURE, 'רשימה 1: קניות בסופר');
  has(FIXTURE, 'חלוקה של כל אחד מהבית');
  ['נועה', 'רון', 'מאיה', 'איתי'].forEach((n) => ok(FIXTURE.includes(n), `fictional name ${n} is used`));
});
test(`fixture: parses exactly ${FIXTURE_EXPECTED.length} items`, () => {
  eq(parsedFixture().length, FIXTURE_EXPECTED.length);
});
FIXTURE_EXPECTED.forEach(([cat, type, title, qty, unit, pp, note], idx) => {
  test(`fixture item #${idx + 1}: ${title}`, () => {
    const it = parsedFixture()[idx];
    ok(it, 'item exists');
    eq([it.category ? it.category.name : null, it.type, it.title, it.qty, it.unit, it.per_person, it.note], [cat, type, title, qty, unit, pp, note]);
  });
});
test('fixture: headers with a leading emoji map to default categories (emoji + name)', () => {
  const items = parsedFixture();
  eq(findItem(items, 'סטייק אנטריקוט').category, { emoji: '🥩', name: 'בשר ועוף' });
  eq(findItem(items, 'עגבניות').category, { emoji: '🥗', name: 'ירקות ופירות' });
  eq(findItem(items, 'קשים').category, { emoji: '🍽️', name: `חד${MAQAF}פעמי` });
  eq(findItem(items, 'בירות').category, { emoji: '🥤', name: 'שתייה ואלכוהול' });
  eq(findItem(items, 'פחמים').category, { emoji: '🔥', name: 'מנגל ובישול' }, 'multi-topic header routes grill items to 🔥');
});
test('fixture: "רשימה N:" lines and the bring-section header are never items', () => {
  const titles = parsedFixture().map((i) => i.title);
  ok(!titles.some((t) => /רשימה|חלוקה|מהבית/.test(t)), `unexpected header item in ${show(titles)}`);
});
test('fixture: "חלוקה של כל אחד מהבית" switches following lines to bring', () => {
  const items = parsedFixture();
  const start = items.findIndex((i) => i.title === 'קרשי חיתוך');
  ok(start > 0, 'bring section found');
  ok(items.slice(0, start).every((i) => i.type === 'buy'), 'everything before is buy');
  ok(items.slice(start).every((i) => i.type === 'bring' || i.type === 'each'), 'everything after is bring/each');
});
test('fixture: "-כל זוג" ⇒ each (and the couple-count is not a quantity)', () => {
  const it = findItem(parsedFixture(), 'קרשי חיתוך');
  eq([it.type, it.qty], ['each', null]);
});
test('fixture: "12-עגבניות" ⇒ qty 12 title עגבניות', () => {
  const it = findItem(parsedFixture(), 'עגבניות');
  eq([it.qty, it.unit], [12, null]);
});
test('fixture: "סטייק אנטריקוט-פר אדם 300 גרם" ⇒ per person 300 גרם', () => {
  const it = findItem(parsedFixture(), 'סטייק אנטריקוט');
  eq([it.qty, it.unit, it.per_person, it.type], [300, 'גרם', true, 'buy']);
});
test('fixture: "2 חבילות ביצים של 12" keeps the 12 in the title', () => {
  const it = findItem(parsedFixture(), 'ביצים של 12');
  eq([it.qty, it.unit], [2, 'חבילות']);
});
test('fixture: "4 קילו ..." ⇒ 4 ק"ג', () => {
  eq(findItem(parsedFixture(), 'מולטי עגבניות מרוסקות').unit, 'ק"ג');
});
test('fixture: "חבילת שום" ⇒ 1 חבילות', () => {
  const it = findItem(parsedFixture(), 'שום');
  eq([it.qty, it.unit], [1, 'חבילות']);
});
test('fixture: standalone "(מי יכול להביא ?)" attaches to the previous item', () => {
  eq(findItem(parsedFixture(), 'קפה טורקי').note, 'מי יכול להביא?');
});
test('fixture: "נפנף- למי יש ויכול להביא ?" ⇒ title נפנף + note', () => {
  const it = findItem(parsedFixture(), 'נפנף');
  eq(it.note, 'למי יש ויכול להביא?');
});
test('fixture: no item title is empty, a question, or carries stray whitespace', () => {
  for (const it of parsedFixture()) {
    ok(it.title && it.title === it.title.trim() && !/\s{2}/.test(it.title), `bad title ${show(it.title)}`);
    ok(!it.title.includes('?'), `question became an item: ${it.title}`);
  }
});
test('fixture: raw keeps the original line', () => {
  eq(findItem(parsedFixture(), 'מרגז').raw, 'מרגז- פר אדם- 8 יחידות');
});

// ───────────────────────── list parser: behaviour ─────────────────────────

const one = (line) => {
  const items = L.parseListText(line);
  if (items.length !== 1) throw new Error(`expected 1 item for ${show(line)}, got ${show(items)}`);
  return items[0];
};

test('parser: empty / null / blank lines → []', () => {
  eq(L.parseListText(''), []);
  eq(L.parseListText(null), []);
  eq(L.parseListText('\n\n   \n\t\n'), []);
});
test('parser: items have exactly the contract keys', () => {
  eq(Object.keys(one('3 חבילות פחמים')).sort(), ['category', 'note', 'per_person', 'qty', 'raw', 'title', 'type', 'unit']);
});
test('parser: bullets, checkmarks and numbering are stripped', () => {
  const items = L.parseListText('- פחמים\n• מים\n* קרח\n✅ מנגל\n1. כסאות\n2) שולחן מתקפל\n– מחצלת');
  eq(items.map((i) => i.title), ['פחמים', 'מים', 'קרח', 'מנגל', 'כסאות', 'שולחן מתקפל', 'מחצלת']);
});
test('parser: RTL marks, NBSP and stray spaces are cleaned', () => {
  const it = one(`${RLM}  פחמים${NBSP}-${NBSP}3   חבילות ${LRM}`);
  eq([it.title, it.qty, it.unit], ['פחמים', 3, 'חבילות']);
});
[
  ['3 שישיות מים', 'מים', 3, 'שישיות'],
  ['שישיית בירה', 'בירה', 1, 'שישיות'],
  ['2 ליטר שמן זית', 'שמן זית', 2, 'ליטר'],
  ['1.5 ליטר מיץ', 'מיץ', 1.5, 'ליטר'],
  ['500 גרם גבינה צהובה', 'גבינה צהובה', 500, 'גרם'],
  ['2 ק״ג עגבניות', 'עגבניות', 2, 'ק"ג'],
  ['3 קג אנטריקוט', 'אנטריקוט', 3, 'ק"ג'],
  ['קילו עגבניות', 'עגבניות', 1, 'ק"ג'],
  ['6 יח׳ לחמניות', 'לחמניות', 6, 'יח׳'],
  ["6 יח' לחמניות", 'לחמניות', 6, 'יח׳'],
  ['4 בקבוק יין', 'יין', 4, 'בקבוקים'],
  ['2 בקבוקים קולה', 'קולה', 2, 'בקבוקים'],
  ['קולה - 2 בקבוקים', 'קולה', 2, 'בקבוקים'],
  ['גליל נייר טואלט', 'נייר טואלט', 1, 'גליל'],
  ['חומוס 3 קופסאות', 'חומוס', 3, 'קופסאות'],
  ['שתי חבילות פחמים', 'פחמים', 2, 'חבילות'],
  ['חצי קילו גבינה', 'גבינה', 0.5, 'ק"ג'],
  ['250 מ"ל שמנת', 'שמנת', 250, 'מ"ל'],
  ['פחמים x3', 'פחמים', 3, null],
  ['3x פחמים', 'פחמים', 3, null],
  ['פיתות 10', 'פיתות', 10, null],
  ['10 פיתות', 'פיתות', 10, null],
  ['ביצים - חבילה', 'ביצים', 1, 'חבילות'],
  ['נקניקיות-2 חבילות', 'נקניקיות', 2, 'חבילות'],
].forEach(([line, title, qty, unit]) => {
  test(`parser qty/unit: ${line}`, () => {
    const it = one(line);
    eq([it.title, it.qty, it.unit], [title, qty, unit]);
  });
});
[
  ['קבב - 3 לאדם', 'קבב', 3, null],
  ['סטייק 300 גרם פר אדם', 'סטייק', 300, 'גרם'],
  ['300 גרם סטייק לכל אחד', 'סטייק', 300, 'גרם'],
  ['פרגיות - לנפש 250 גרם', 'פרגיות', 250, 'גרם'],
].forEach(([line, title, qty, unit]) => {
  test(`parser per person: ${line}`, () => {
    const it = one(line);
    eq([it.title, it.qty, it.unit, it.per_person, it.type], [title, qty, unit, true, 'buy']);
  });
});
[
  ['כל זוג - צידנית', 'צידנית', null],
  ['4 סכינים -כל זוג', 'סכינים', null],
  ['2 בקבוקי יין לכל זוג', 'יין', 2],
  ['כל אחד מביא כיסא', 'כיסא', null],
  ['כל אחד מביא 2 כסאות', 'כסאות', 2],
  ['מגבת - כל אחד', 'מגבת', null],
  ['כסא לכל אחד', 'כסא', null],
].forEach(([line, title, qty]) => {
  test(`parser each: ${line}`, () => {
    const it = one(line);
    eq([it.title, it.qty, it.type, it.per_person], [title, qty, 'each', false]);
  });
});
test('parser: question-only lines never become items', () => {
  eq(L.parseListText('מי מביא?'), []);
  eq(L.parseListText('מה עוד חסר?'), []);
  eq(L.parseListText('(מי יכול להביא?)'), []);
  eq(L.parseListText('מי יכול להביא ?'), []);
});
test('parser: "יש למישהו רמקול?" ⇒ bring item רמקול with the question as note', () => {
  const it = one('יש למישהו רמקול?');
  eq([it.title, it.type, it.note], ['רמקול', 'bring', 'יש למישהו רמקול?']);
  eq(one('למי יש נפנף ויכול להביא?').title, 'נפנף');
  eq(one('מי קונה פחמים?').type, 'buy');
});
test('parser: standalone note attaches only to an adjacent item', () => {
  eq(L.parseListText('קפה טורקי\n(מי יכול להביא ?)')[0].note, 'מי יכול להביא?');
  eq(L.parseListText('קפה טורקי\n\n(מי יכול להביא ?)')[0].note, null);
  eq(L.parseListText('(מגוון סלטים)\nחומוס').map((i) => [i.title, i.note]), [['חומוס', null]]);
});
test('parser: parentheses become notes (joined in order)', () => {
  const it = one('מחצלת (גדולה) (אם יש)');
  eq([it.title, it.note], ['מחצלת', 'גדולה · אם יש']);
});
test('parser: ranges keep the upper bound and note the range', () => {
  const it = one('2-3 חבילות פחמים');
  eq([it.title, it.qty, it.unit, it.note], ['פחמים', 3, 'חבילות', '2–3']);
});
test('parser: word-internal hyphens are not separators', () => {
  const it = one('כוסות חד-פעמיות');
  eq([it.title, it.qty], ['כוסות חד-פעמיות', null]);
});
test('parser: bold / colon / emoji headers → categories', () => {
  eq(L.parseListText('*שתייה*\nקולה')[0].category, { emoji: '🥤', name: 'שתייה ואלכוהול' });
  eq(L.parseListText('ירקות:\nעגבניות')[0].category, { emoji: '🥗', name: 'ירקות ופירות' });
  eq(L.parseListText('בשרים 🥩\nסטייק')[0].category, { emoji: '🥩', name: 'בשר ועוף' });
  const fun = L.parseListText('🎲 משחקים\nמטקות')[0];
  eq([fun.category.name, fun.type], ['כיף ומשחקים', 'bring']);
});
test('parser: unknown headers are kept as-is', () => {
  eq(L.parseListText('🏊 בריכה\nמצופים')[0].category, { name: 'בריכה', emoji: '🏊' });
  eq(L.parseListText('שונות:\nמטריה')[0].category, { name: 'שונות', emoji: '📦' });
});
test('parser: emoji "headers" with nothing under them are items', () => {
  const items = L.parseListText('🍉 אבטיח\n🍋 לימון');
  eq(items.map((i) => [i.title, i.category && i.category.name]), [['אבטיח', 'ירקות ופירות'], ['לימון', 'ירקות ופירות']]);
  const meat = L.parseListText('🥩 בשר\n🍗 פרגיות\n🌭 נקניקיות');
  eq(meat.map((i) => [i.title, i.category.name]), [['פרגיות', 'בשר ועוף'], ['נקניקיות', 'בשר ועוף']]);
  const gear = L.parseListText('🎒 ציוד\n🔦 פנס\n🪑 כיסא');
  eq(gear.map((i) => [i.title, i.category.name, i.type]), [['פנס', 'ציוד קבוצתי', 'bring'], ['כיסא', 'ציוד קבוצתי', 'bring']]);
  const mixed = L.parseListText('🍋 לימון\n🍉 2 אבטיחים');
  eq(mixed.map((i) => [i.title, i.qty]), [['לימון', null], ['אבטיחים', 2]]);
});
test('parser: section headers switch the type', () => {
  eq(L.parseListText('מהבית:\nמחצלת')[0].type, 'bring');
  eq(L.parseListText('להביא מהבית\nמחצלת')[0].type, 'bring');
  eq(L.parseListText('קניות:\nכסאות')[0].type, 'buy');
  eq(L.parseListText('ציוד אישי:\nמגבת')[0].type, 'each');
  eq(L.parseListText('כל אחד מביא:\nפנס')[0].type, 'each');
});
test('parser: a second realistic list (sections, questions, bold each-section, tasks)', () => {
  const items = L.parseListText([
    'מה צריך לקנות:',
    '- פחמים x3',
    '- 2 שקיות קרח',
    '- חומוס (גדול)',
    '- 3 ק"ג פרגיות',
    'יש למישהו גזיבו?',
    '',
    'מה להביא:',
    'כסאות',
    'מחצלות - 3',
    '*ציוד אישי*',
    'מגבת',
    '',
    '📋 משימות',
    'להזמין כרטיסים',
  ].join('\n'));
  eq(items.map((i) => [i.category && i.category.name, i.type, i.title, i.qty, i.unit, i.note]), [
    ['מנגל ובישול', 'buy', 'פחמים', 3, null, null],
    ['שתייה ואלכוהול', 'buy', 'שקיות קרח', 2, null, null],
    ['מזווה ורטבים', 'buy', 'חומוס', null, null, 'גדול'],
    ['בשר ועוף', 'buy', 'פרגיות', 3, 'ק"ג', null],
    ['ציוד קבוצתי', 'bring', 'גזיבו', null, null, 'יש למישהו גזיבו?'],
    ['ציוד קבוצתי', 'bring', 'כסאות', null, null, null],
    ['ציוד קבוצתי', 'bring', 'מחצלות', 3, null, null],
    [null, 'each', 'מגבת', null, null, null],
    ['משימות', 'buy', 'להזמין כרטיסים', null, null, null],
  ]);
});
test('parser: headerless lists infer category and bring/buy from the item', () => {
  const items = L.parseListText('כסאות\nמטקות\nפחמים\nמשהו אחר');
  eq(items.map((i) => [i.title, i.type, i.category && i.category.name]), [
    ['כסאות', 'bring', 'ציוד קבוצתי'],
    ['מטקות', 'bring', 'כיף ומשחקים'],
    ['פחמים', 'buy', 'מנגל ובישול'],
    ['משהו אחר', 'buy', null],
  ]);
});
test('parser: WhatsApp export prefixes are stripped, system lines skipped', () => {
  const items = L.parseListText([
    '[27/09/2026, 11:16:03] איתי: 2 שישיות מים',
    '27.9.2026, 11:16 - מאיה: פחמים',
    '[11:16, 27/09/2026] רון: 3 חבילות פיתות',
    '27.9.2026, 11:16 - איתי יצר/ה את הקבוצה "קמפינג"',
  ].join('\n'));
  eq(items.map((i) => [i.title, i.qty]), [['מים', 2], ['פחמים', null], ['פיתות', 3]]);
});
test('parser: media, links, chatter and emoji-only lines are skipped', () => {
  eq(L.parseListText('<המדיה לא נכללה>\nhttps://waze.com/ul?q=x\nתודה!\n🔥🔥🔥\nסבבה\n👍'), []);
});
test('parser: long chat sentences are not items', () => {
  eq(L.parseListText('היי חברים אני חושב שכדאי שנחליט כבר מה עושים עם האוכל לערב של יום חמישי'), []);
});
test('parser: huge pastes stay fast (no regex blow-up)', () => {
  const longLine = 'בלה '.repeat(5000);
  const bigList = Array.from({ length: 3000 }, (_, i) => `${i % 9 + 1} חבילות פריט ${i}`).join('\n');
  const t0 = performance.now();
  eq(L.parseListText(longLine), []);
  eq(L.parseListText(bigList).length, 3000);
  const ms = performance.now() - t0;
  ok(ms < 1500, `parsing took ${Math.round(ms)}ms`);
});
test('parser: title capped at 120 chars, raw trimmed', () => {
  eq(one('א'.repeat(200)).title.length, 120);
  eq(one('   3 חבילות פחמים   ').raw, '3 חבילות פחמים');
});
test('parser: category objects are independent copies', () => {
  const items = L.parseListText('🥩 בשר\nסטייק\nקבב');
  ok(items[0].category !== items[1].category, 'distinct objects');
  items[0].category.name = 'changed';
  eq(items[1].category.name, 'בשר ועוף');
  eq(L.parseListText('🥩 בשר\nסטייק')[0].category.name, 'בשר ועוף');
});
test('parser: CRLF input works like LF', () => {
  eq(L.parseListText(FIXTURE.replace(/\n/g, '\r\n')).length, FIXTURE_EXPECTED.length);
});

// ───────────────────────── WhatsApp summaries ─────────────────────────

test('summary missing: exact text grouped by category', () => {
  eq(L.buildSummaryText(makeSnap(), 'missing'), [
    '🙋 *מה עוד חסר?*',
    '⛺ טיול לפארק החבשושיות',
    '',
    '🥩 *בשר ועוף*',
    '• פרגיות — 3.2 ק"ג',
    '',
    '🔥 *מנגל ובישול*',
    '• קרש חיתוך + סכין + מזלג — כל אחד מביא (1/5)',
    '• תבלין על האש',
    '',
    '⛺ *ציוד קבוצתי*',
    '• כסאות ים — חסרים 6 מתוך 10',
    '',
    '📦 *שונות*',
    '• קפה טורקי',
    '',
    'סה״כ: 5 פריטים',
    'מי לוקח? ✋',
  ].join('\n'));
});
test('summary missing: nothing missing → celebration', () => {
  const snap = makeSnap();
  snap.items = snap.items.filter((i) => ['i1', 'i5', 'i12'].includes(i.id));
  const text = L.buildSummaryText(snap, 'missing');
  hasLine(text, '🎉 *הכל מכוסה!*');
  ok(!text.includes('מי לוקח'), 'no call to action when nothing is missing');
});
test('summary mine: exact text with checkboxes, qty and packed %', () => {
  eq(L.buildSummaryText(makeSnap(), 'mine', 'mA'), [
    '🎒 *הרשימה של איתי ונועה*',
    '⛺ טיול לפארק החבשושיות',
    '',
    '🧺 *מביאים מהבית*',
    '✅ מלקחיים',
    '✅ כסאות ים ×2',
    '',
    '🛒 *קונים*',
    '✅ פחמים · 3 חבילות',
    '',
    '📋 *משימות*',
    '⬜ לשריין מקרר',
    '✅ להזמין כרטיסים',
    '',
    '🙋 *כל אחד מביא*',
    '✅ קרש חיתוך + סכין + מזלג',
    '',
    '💪 מוכנות אישית: 83%',
  ].join('\n'));
});
test('summary mine: per-person qty, pending marker, default member = me', () => {
  const b = L.buildSummaryText(makeSnap('mB'), 'mine');
  hasLine(b, '🎒 *הרשימה של מאיה ורון*');
  hasLine(b, '⬜ סטייק אנטריקוט · 2.4 ק"ג');
  hasLine(b, '⬜ מחבת גדולה');
  const c = L.buildSummaryText(makeSnap(), 'mine', 'mC');
  hasLine(c, '⬜ כנפיים · 1 ק"ג ⏳');
  ok(!c.includes('רמקול'), 'rejected item hidden');
});
test('summary mine: empty agenda gets a friendly nudge', () => {
  const snap = makeSnap();
  snap.items = snap.items.filter((i) => i.type !== 'each');
  has(L.buildSummaryText(snap, 'mine', 'mD'), 'עוד לא לקחת שום פריט');
});
test('summary settle: exact transfer lines, total and per head', () => {
  eq(L.buildSummaryText(makeSnap(), 'settle'), [
    '💸 *התחשבנות*',
    '⛺ טיול לפארק החבשושיות',
    '',
    '🧾 סה״כ הוצאות: ₪670',
    '👥 לאדם: ₪83.75 (8 אנשים)',
    '',
    '*מי מעביר למי:*',
    '• איתי ונועה ← מאיה ורון ₪75',
    '• אורי ← מאיה ורון ₪66',
    '• שירה וטל ← מאיה ורון ₪53',
    '• יואב ← מאיה ורון ₪16',
    '',
    'אחרי ההעברה מסמנים ״שילמתי״ במדורה ✅',
  ].join('\n'));
});
test('summary settle: balanced group and no expenses', () => {
  const snap = makeSnap();
  snap.expenses = [{ id: 'z', amount: 80, paid_by: 'mA', split_mode: 'members' }];
  snap.expense_shares = [{ expense_id: 'z', member_id: 'mA', weight: 1 }];
  snap.payments = [];
  hasLine(L.buildSummaryText(snap, 'settle'), '🎉 כולם מאוזנים — אין צורך בהעברות');
  snap.expenses = [];
  has(L.buildSummaryText(snap, 'settle'), 'עוד לא נרשמו הוצאות');
});
test('summary status: readiness, missing, pending approval, money per head', () => {
  const text = L.buildSummaryText(makeSnap(), 'status');
  ok(text.startsWith('⛺ *טיול לפארק החבשושיות*\n'), `bad header: ${text.split('\n')[0]}`);
  hasLine(text, '📍 פארק החבשושיות');
  hasLine(text, '📊 *מוכנות: 58%*');
  hasLine(text, '✅ מכוסים: 7 מתוך 12');
  hasLine(text, '🙋 חסרים: 3 · 🟡 חלקיים: 2');
  hasLine(text, '⏳ ממתינים לאישור: 1');
  hasLine(text, '*עדיין חסר:*');
  hasLine(text, '• כסאות ים — חסרים 6 מתוך 10');
  hasLine(text, 'הוצאות עד עכשיו: ₪670');
  hasLine(text, 'לאדם: ₪83.75 (8 אנשים)');
  has(text, '📅 ');
  has(text, '09:00');
});
test('summary status: caps the missing list at 8 lines', () => {
  const snap = makeSnap();
  for (let k = 0; k < 10; k++) snap.items.push({ id: `x${k}`, title: `פריט ${k}`, type: 'bring', status: 'active', needed: 1, category_id: 'c8', sort: 50 + k });
  const text = L.buildSummaryText(snap, 'status');
  hasLine(text, '…ועוד 7');
});
test('summaries never print undefined / null / NaN, even for a bare snapshot', () => {
  const bare = { trip: { name: 'טיול' }, me: { member_id: 'x' }, members: [], items: [], pledges: [], expenses: [], expense_shares: [], payments: [] };
  for (const kind of ['status', 'missing', 'mine', 'settle']) {
    for (const snap of [makeSnap(), bare, null]) {
      const t = L.buildSummaryText(snap, kind, 'mA');
      ok(typeof t === 'string' && t.length > 0, `${kind} returns text`);
      ok(!/undefined|null|NaN/.test(t), `${kind} leaked a raw value:\n${t}`);
    }
  }
});
test('buildInviteText: name, date, location and link', () => {
  const trip = makeSnap().trip;
  const text = L.buildInviteText(trip, 'https://lidoravr.github.io/medura/#/join/abc234xyz9');
  hasLine(text, '⛺ *טיול לפארק החבשושיות*');
  hasLine(text, '📍 פארק החבשושיות');
  has(text, '09:00');
  has(text, 'חמישי');
  hasLine(text, '👈 https://lidoravr.github.io/medura/#/join/abc234xyz9');
  ok(!/undefined|null/.test(L.buildInviteText({}, '')), 'handles empty trip');
});

// ───────────────────────── dates ─────────────────────────

const START = '2026-10-01T09:00:00+03:00';
const END = '2026-10-02T12:00:00+03:00';
test('countdown: "בעוד 4 ימים" with exact days/hours/minutes', () => {
  eq(L.countdown(START, new Date('2026-09-27T12:00:00+03:00')), { days: 3, hours: 21, minutes: 0, past: false, label: 'בעוד 4 ימים' });
});
test('countdown: two days → "בעוד יומיים"', () => {
  eq(L.countdown(START, new Date('2026-09-29T08:00:00+03:00')).label, 'בעוד יומיים');
});
test('countdown: tomorrow/today use the Jerusalem calendar, not UTC', () => {
  eq(L.countdown(START, new Date('2026-09-30T23:30:00+03:00')).label, 'מחר!');
  eq(L.countdown(START, new Date('2026-10-01T00:30:00+03:00')).label, 'היום!');
  const soon = L.countdown(START, new Date('2026-10-01T08:59:00+03:00'));
  eq([soon.label, soon.days, soon.hours, soon.minutes, soon.past], ['היום!', 0, 0, 1, false]);
});
test('countdown: during the trip and after it', () => {
  const during = L.countdown(START, new Date('2026-10-01T09:00:00+03:00'), END);
  eq([during.label, during.past], ['עכשיו בטיול 🔥', true]);
  eq(L.countdown(START, new Date('2026-10-02T11:59:00+03:00'), END).label, 'עכשיו בטיול 🔥');
  eq(L.countdown(START, new Date('2026-10-02T12:00:00+03:00'), END).label, 'הטיול הסתיים');
});
test('countdown: without an end the trip is assumed to last one day', () => {
  eq(L.countdown(START, new Date('2026-10-02T08:00:00+03:00')).label, 'עכשיו בטיול 🔥');
  eq(L.countdown(START, new Date('2026-10-02T10:00:00+03:00')).label, 'הטיול הסתיים');
});
test('countdown: accepts ISO strings for now; null start → empty label', () => {
  eq(L.countdown(START, '2026-09-27T12:00:00+03:00').label, 'בעוד 4 ימים');
  eq(L.countdown(null), { days: 0, hours: 0, minutes: 0, past: false, label: '' });
});
test('formatTime / formatDate / formatDateTime in Asia/Jerusalem', () => {
  eq(L.formatTime('2026-10-01T06:00:00Z'), '09:00');
  eq(L.formatTime('2026-12-01T07:00:00Z'), '09:00', 'winter time (+02:00)');
  const d = L.formatDate(START);
  has(d, 'חמישי');
  has(d, 'באוקטובר');
  has(d, '1');
  has(L.formatDateTime(START), '09:00');
  has(L.formatDate(START, { day: 'numeric', month: 'numeric' }), '1');
  eq([L.formatDate(null), L.formatTime('nope'), L.formatDateTime(undefined)], ['', '', '']);
});
test('timeAgo ladder', () => {
  const now = new Date('2026-10-01T12:00:00+03:00');
  const ago = (ms) => L.timeAgo(new Date(now.getTime() - ms).toISOString(), now);
  eq(ago(10 * 1000), 'עכשיו');
  eq(ago(-60 * 1000), 'עכשיו', 'future timestamps (clock skew)');
  eq(ago(60 * 1000), 'לפני דקה');
  eq(ago(5 * 60 * 1000), 'לפני 5 דק׳');
  eq(ago(60 * 60 * 1000), 'לפני שעה');
  eq(ago(2 * 3600 * 1000), 'לפני שעתיים');
  eq(ago(5 * 3600 * 1000), 'לפני 5 שעות');
  eq(L.timeAgo('2026-09-30T10:00:00+03:00', now), 'אתמול');
  eq(L.timeAgo('2026-09-29T10:00:00+03:00', now), 'לפני יומיים');
  eq(L.timeAgo('2026-09-27T10:00:00+03:00', now), 'לפני 4 ימים');
  has(L.timeAgo('2026-09-10T10:00:00+03:00', now), 'ספט');
  eq(L.timeAgo(null, now), '');
});
test('hebrewCount', () => {
  eq(L.hebrewCount(1, 'פריט', 'פריטים'), '1 פריט');
  eq(L.hebrewCount(3, 'פריט', 'פריטים'), '3 פריטים');
  eq(L.hebrewCount(0, 'פריט', 'פריטים'), '0 פריטים');
  eq(L.hebrewCount(1200, 'איש', 'אנשים'), '1,200 אנשים');
});

// ───────────────────────── links ─────────────────────────

test('inviteUrl / deviceLinkUrl', () => {
  eq(L.inviteUrl('https://lidoravr.github.io/medura/', 'abc234xyz9'), 'https://lidoravr.github.io/medura/#/join/abc234xyz9');
  eq(L.inviteUrl('https://lidoravr.github.io/medura/#/t/1', 'abc'), 'https://lidoravr.github.io/medura/#/join/abc', 'old hash dropped');
  eq(L.deviceLinkUrl('http://127.0.0.1:5178/', 'dev7code22'), 'http://127.0.0.1:5178/#/link/dev7code22');
});
test('whatsappShareUrl encodes the text', () => {
  eq(L.whatsappShareUrl('שלום & bye\nשורה'), `https://wa.me/?text=${encodeURIComponent('שלום & bye\nשורה')}`);
  eq(L.whatsappShareUrl('a b'), 'https://wa.me/?text=a%20b');
});
[
  ['050-123-4567', '972501234567'],
  ['0501234567', '972501234567'],
  ['+972 50 123 4567', '972501234567'],
  ['+972-50-1234567', '972501234567'],
  ['972501234567', '972501234567'],
  ['00972 50 123 4567', '972501234567'],
  ['+972 (0)50-1234567', '972501234567'],
  ['501234567', '972501234567'],
  [' 052 555 1234 ', '972525551234'],
  ['03-1234567', '97231234567'],
  ['077-1234567', '972771234567'],
  ['+1 (415) 555-2671', '14155552671'],
].forEach(([phone, digits]) => {
  test(`whatsappChatUrl valid: ${phone}`, () => {
    eq(L.whatsappChatUrl(phone), `https://wa.me/${digits}`);
  });
});
['', null, undefined, 'abc', '123', '050-123', '05012345678', '+972 50 123', 'נייד 050'].forEach((phone) => {
  test(`whatsappChatUrl invalid: ${show(phone)}`, () => {
    eq(L.whatsappChatUrl(phone), null);
  });
});
test('whatsappChatUrl with text', () => {
  eq(L.whatsappChatUrl('050-123-4567', 'היי, העברתי ₪75'), `https://wa.me/972501234567?text=${encodeURIComponent('היי, העברתי ₪75')}`);
  eq(L.whatsappChatUrl('050-123-4567', ''), 'https://wa.me/972501234567');
});

// ───────────────────────── notifications, polls, votes ─────────────────────────

test('visibleNotifications: audience, author and admin rules, newest first', () => {
  eq(L.visibleNotifications(makeSnap('mA')).map((n) => n.id), ['n5', 'n4', 'n2', 'n1']);
  eq(L.visibleNotifications(makeSnap('mC')).map((n) => n.id), ['n4', 'n3', 'n1']);
  eq(L.visibleNotifications(makeSnap('mD')).map((n) => n.id), ['n5', 'n1']);
  eq(L.visibleNotifications(null), []);
});
test('unreadCount: visible, not read by me, not authored by me', () => {
  eq(L.unreadCount(makeSnap('mA')), 2);
  eq(L.unreadCount(makeSnap('mC')), 3);
  const snap = makeSnap('mA');
  snap.reads.push({ notification_id: 'n5', member_id: 'mA' }, { notification_id: 'n2', member_id: 'mA' });
  eq(L.unreadCount(snap), 0);
  eq(L.unreadCount({ ...makeSnap(), me: { member_id: null } }), 0);
  eq(L.unreadCount(null), 0);
});
test('pollResults: single choice counts, pct and voters', () => {
  const poll = { id: 'p1', options: [{ id: 'o1', label: '2 ארוחות' }, { id: 'o2', label: '3 ארוחות' }], multi: false };
  const votes = [
    { poll_id: 'p1', member_id: 'mA', option_id: 'o1' },
    { poll_id: 'p1', member_id: 'mB', option_id: 'o1' },
    { poll_id: 'p1', member_id: 'mC', option_id: 'o2' },
    { poll_id: 'other', member_id: 'mD', option_id: 'o2' },
    { poll_id: 'p1', member_id: 'mE', option_id: 'o9' },
  ];
  eq(L.pollResults(poll, votes), [
    { id: 'o1', label: '2 ארוחות', count: 2, pct: 67, voters: ['mA', 'mB'] },
    { id: 'o2', label: '3 ארוחות', count: 1, pct: 33, voters: ['mC'] },
  ]);
});
test('pollResults: multi choice pct is of voters; no votes → 0', () => {
  const poll = { id: 'p2', options: [{ id: 'o1', label: 'וודקה' }, { id: 'o2', label: 'ערק' }, { id: 'o3', label: 'רק יין' }], multi: true };
  const votes = [
    { poll_id: 'p2', member_id: 'mA', option_id: 'o1' },
    { poll_id: 'p2', member_id: 'mA', option_id: 'o2' },
    { poll_id: 'p2', member_id: 'mB', option_id: 'o2' },
  ];
  eq(L.pollResults(poll, votes).map((r) => [r.count, r.pct]), [[1, 50], [2, 100], [0, 0]]);
  eq(L.pollResults(poll, []).map((r) => r.pct), [0, 0, 0]);
});
test('adminVoteCounts: Map of candidate → votes (duplicates ignored)', () => {
  eq(L.adminVoteCounts(makeSnap()), new Map([['mC', 3], ['mE', 1]]));
  eq(L.adminVoteCounts(null).size, 0);
});

// ───────────────────────── similar items ─────────────────────────

test('titleSimilarity: plural / singular, ה/ו prefix, spelling and typos are the same item', () => {
  const same = [
    ['פחמים', 'פחם'], ['נקניקיות', 'נקניקייה'], ['כסאות', 'כיסא'], ['הפחמים', 'פחמים'], ['אוהל', 'אוהלים'],
    ['בירה', 'בירות'], ['צלחות', 'צלחת'], ['ביצים', 'ביצה'], ['חומוס', 'חמוס'], ['מנגל', 'מנגאל'],
    ['2 בקבוקי קולה', 'קולה'], ['פחמים!!', 'פחמים'], ['🔥 פחמים', 'פחמים'],
  ];
  for (const [a, b] of same) eq(L.titleSimilarity(a, b), 'same', `${a} ~ ${b}`);
});
test('titleSimilarity: one title inside the other, or most words shared → similar', () => {
  const similar = [['פחם', 'פחם למנגל'], ['קולה', 'קוקה קולה'], ['מים', 'מים מינרליים'], ['שמן', 'שמן זית'], ['שקית קרח', 'קרח']];
  for (const [a, b] of similar) eq(L.titleSimilarity(a, b), 'similar', `${a} ~ ${b}`);
});
test('titleSimilarity: different things are not flagged', () => {
  const different = [
    ['כוסות חד פעמיות', 'צלחות חד פעמיות'], ['שקיות זבל', 'שקיות אוכל'], ['במבה', 'ביסלי'], ['קרח', 'קרם הגנה'],
    ['לחמניות', 'לחם'], ['כיסא', 'כיס'], ['פחית', 'פח'], ['מים', 'מיץ'], ['', 'פחם'], ['3', '33'],
  ];
  for (const [a, b] of different) eq(L.titleSimilarity(a, b), null, `${a} ≁ ${b}`);
});
test('similarItems: same first, rejected and the excluded item ignored, limited', () => {
  const items = [
    { id: 'i1', title: 'פחם למנגל', status: 'active' },
    { id: 'i2', title: 'פחמים', status: 'active' },
    { id: 'i3', title: 'פחם', status: 'rejected' },
    { id: 'i4', title: 'כסאות', status: 'active' },
    { id: 'i5', title: 'פחם', status: 'proposed' },
  ];
  eq(L.similarItems('פחם', items).map((r) => [r.item.id, r.match]), [['i2', 'same'], ['i5', 'same'], ['i1', 'similar']]);
  eq(L.similarItems('פחם', items, { excludeId: 'i5' }).map((r) => r.item.id), ['i2', 'i1']);
  eq(L.similarItems('פחם', items, { limit: 1 }).map((r) => r.item.id), ['i2']);
  eq(L.similarItems('  ', items), []);
  eq(L.similarItems('פחם', null), []);
});

// ───────────────────────── module contract ─────────────────────────

test('logic.js exports exactly the SPEC §7.1 names', () => {
  const expected = [
    'headcountTotal', 'membersById', 'isAdmin', 'displayName', 'itemEffectiveQty', 'itemProgress', 'tripReadiness',
    'myAgenda', 'missingItems', 'expenseShares', 'balances', 'settlePlan', 'tripTotals', 'parseListText', 'formatMoney',
    'formatQty', 'countdown', 'formatDate', 'formatDateTime', 'formatTime', 'timeAgo', 'hebrewCount', 'inviteUrl',
    'deviceLinkUrl', 'whatsappShareUrl', 'whatsappChatUrl', 'buildInviteText', 'buildSummaryText',
    'visibleNotifications', 'unreadCount', 'pollResults', 'adminVoteCounts', 'titleSimilarity', 'similarItems',
  ];
  eq(Object.keys(L).sort(), [...expected].sort());
  expected.forEach((name) => ok(typeof L[name] === 'function', `${name} is a function`));
});
