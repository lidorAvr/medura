// מדורה — pure domain logic (SPEC §7.1). No DOM access, no imports.
// Money is computed in integer agorot to avoid float drift; dates are always
// displayed in he-IL / Asia/Jerusalem, whatever the device timezone is.

const TZ = 'Asia/Jerusalem';
const DAY_MS = 86400000;
const FALLBACK_NAME = 'חבר/ה';

// ───────────────────────── small utils ─────────────────────────

const list = (v) => (Array.isArray(v) ? v : []);

function toNum(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

const toCents = (v) => {
  const n = toNum(v);
  return n === null ? 0 : Math.round(n * 100);
};
const fromCents = (c) => c / 100 || 0; // `|| 0` folds -0 into 0

function headcountOf(member) {
  const h = Math.round(toNum(member?.headcount) ?? 1);
  return h >= 1 ? h : 1;
}

function timeOf(iso) {
  const d = toDate(iso);
  return d ? d.getTime() : 0;
}

const nfCache = new Map();
function formatNumber(n, maxFrac = 2, minFrac = 0) {
  const key = `${maxFrac}:${minFrac}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { maximumFractionDigits: maxFrac, minimumFractionDigits: minFrac });
    nfCache.set(key, f);
  }
  return f.format(n);
}

function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dtfCache = new Map();
function dtf(opts) {
  const key = JSON.stringify(opts);
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('he-IL', { ...opts, timeZone: TZ });
    dtfCache.set(key, f);
  }
  return f;
}

let dayPartsFmt = null;
/** Calendar-day number of `d` in Asia/Jerusalem (for "today / tomorrow" maths). */
function dayIndex(d) {
  dayPartsFmt ||= new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = {};
  for (const part of dayPartsFmt.formatToParts(d)) p[part.type] = part.value;
  return Math.round(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / DAY_MS);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordCount = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

// ───────────────────────── members ─────────────────────────

export function headcountTotal(members) {
  return list(members).reduce((sum, m) => sum + (m ? headcountOf(m) : 0), 0);
}

export function membersById(members) {
  const map = new Map();
  for (const m of list(members)) if (m && m.id != null) map.set(m.id, m);
  return map;
}

/** This profile holds admin rights (role owner|admin) — which of its people hold them: personsOf / adminPersons. */
export function isAdmin(member) {
  return !!member && (member.role === 'owner' || member.role === 'admin');
}

/**
 * One row per person of a profile, in `people` order (a profile without names is its display name):
 * {name, joined, verified, admin, mine, phone, seen_at} — the server's members[].persons, or, from an older
 * server, built from people / joined / claimed / role (joined people of an admin profile are its admins).
 */
export function personsOf(member) {
  if (!member) return [];
  if (Array.isArray(member.persons)) return member.persons.filter(Boolean);
  const names = [...new Set(list(member.people).map((p) => String(p ?? '').trim()).filter(Boolean))];
  const all = names.length ? names : [displayName(member)];
  const joined = new Set(list(member.joined));
  return all.map((name) => {
    const isIn = joined.has(name) || (all.length < 2 && Boolean(member.claimed));
    return { name, joined: isIn, verified: false, admin: isIn && isAdmin(member), mine: false, phone: null, seen_at: null };
  });
}

/**
 * The number to call / message for a person of `member` (`p` a personsOf row, or null): their own phone;
 * nothing when they hid it ("📞 הטלפון שלי" off); in a profile of one, the profile's phone. Never the
 * profile's phone for one person of a couple — it may be the partner's.
 */
export function personPhone(member, p) {
  if (p && p.phone) return p.phone;
  if ((p && p.phone_hidden) || personsOf(member).length > 1) return null;
  return (member && member.phone) || null;
}

/**
 * Who holds admin rights, per person, in members order: [{member, name, person, phone}] — `person` is the
 * personsOf row (null when the rights sit on a device that hasn't said who it is: the profile then appears
 * once, by its display name). `name` is the person's name in a profile of 2+, else the profile's name;
 * `phone` is the person's own phone, else the profile's.
 */
export function adminPersons(snap) {
  const out = [];
  for (const m of list(snap?.members)) {
    if (!m) continue;
    const persons = personsOf(m);
    const rows = persons.filter((p) => p.admin);
    const phone = (p) => personPhone(m, p);
    for (const p of rows) out.push({ member: m, name: persons.length > 1 ? p.name : displayName(m), person: p, phone: phone(p) });
    const unknown = m.unknown_devices == null ? Boolean(m.claimed) : Number(m.unknown_devices) > 0;
    // a device that hasn't said who it is holds the rights with no list yet (every device), or when nobody named does
    if ((!rows.length || (m.admin_people === null && m.unknown_devices != null)) && isAdmin(m) && unknown) out.push({ member: m, name: displayName(m), person: null, phone: phone(null) });
  }
  return out;
}

/** "Seen lately": 'now' (under 3 minutes), else a timeAgo text ('לפני 5 דק׳'), null when unknown / hidden. */
export function presence(seenAt, now = new Date()) {
  const seen = toDate(seenAt);
  if (!seen) return null;
  const at = toDate(now) || new Date();
  return at.getTime() - seen.getTime() < 3 * 60000 ? 'now' : timeAgo(seen, at);
}

/** Who did something: the acting person (a row's by_person — one of a couple / family), else the profile's name. */
export function actorName(member, person) {
  return (typeof person === 'string' && person.trim()) || displayName(member);
}

export function displayName(member) {
  if (!member) return FALLBACK_NAME;
  const name = String(member.display_name ?? '').trim();
  if (name) return name;
  const people = list(member.people).map((p) => String(p ?? '').trim()).filter(Boolean);
  return people.length ? people.join(' ו') : FALLBACK_NAME;
}

// ───────────────────────── units & quantities ─────────────────────────

const UNIT_ALIASES = {
  'חבילות': ['חבילות', 'חבילה', 'חבילת', 'חב׳', "חב'"],
  'ק"ג': ['ק"ג', 'ק״ג', "ק''ג", 'ק׳ג', "ק'ג", 'קג', 'קילו', 'קילוגרם', 'קילוגרמים'],
  'גרם': ['גרם', 'גרמים', 'גר׳', "גר'", 'גר'],
  'יח׳': ['יחידות', 'יחידה', 'יח׳', "יח'", 'יח'],
  'בקבוקים': ['בקבוקים', 'בקבוק', 'בקבוקי', 'בקבוקונים', 'בקבוקון'],
  'שישיות': ['שישיות', 'שישייה', 'שישיה', 'שישיית', 'שישית'],
  'ליטר': ['ליטרים', 'ליטר'],
  'מ"ל': ['מ"ל', 'מ״ל', 'מל'],
  'גליל': ['גלילים', 'גליל', 'גלילי'],
  'קופסאות': ['קופסאות', 'קופסות', 'קופסה', 'קופסא', 'קופסת'],
  'שקים': ['שקים'],
  'ארגזים': ['ארגזים', 'ארגז'],
  'פחיות': ['פחיות', 'פחית'],
  'קרטונים': ['קרטונים', 'קרטון'],
  'מגשים': ['מגשים', 'מגש'],
  'צנצנות': ['צנצנות', 'צנצנת'],
};
const UNIT_LOOKUP = new Map();
for (const [canon, aliases] of Object.entries(UNIT_ALIASES)) for (const a of aliases) UNIT_LOOKUP.set(a, canon);

const UNIT_SINGULAR = {
  'חבילות': 'חבילה', 'בקבוקים': 'בקבוק', 'שישיות': 'שישייה', 'קופסאות': 'קופסה', 'גלילים': 'גליל',
  'שקים': 'שק', 'ארגזים': 'ארגז', 'פחיות': 'פחית', 'קרטונים': 'קרטון', 'מגשים': 'מגש', 'צנצנות': 'צנצנת',
};
const UNIT_PLURAL = { 'גליל': 'גלילים' };
const MEASURE_UNITS = new Set(['גרם', 'ק"ג', 'ליטר', 'מ"ל']);

function normalizeUnit(unit) {
  if (unit === null || unit === undefined) return null;
  const u = String(unit).trim().replace(/\.$/, '');
  if (!u) return null;
  return UNIT_LOOKUP.get(u) || u.slice(0, 20);
}

export function formatQty(value, unit) {
  let v = toNum(value);
  if (v === null) return '';
  let u = normalizeUnit(unit);
  let maxFrac = 2;
  if (u === 'גרם' && Math.abs(v) >= 1000) {
    v = Math.round(v / 100) / 10;
    u = 'ק"ג';
    maxFrac = 1;
  } else if (u === 'מ"ל' && Math.abs(v) >= 1000) {
    v = Math.round(v / 100) / 10;
    u = 'ליטר';
    maxFrac = 1;
  }
  const n = formatNumber(v, maxFrac);
  if (!u) return n;
  const shown = v === 1 ? UNIT_SINGULAR[u] || u : UNIT_PLURAL[u] || u;
  return `${n} ${shown}`;
}

export function itemEffectiveQty(item, totalHeads) {
  const q = toNum(item?.qty);
  const baseUnit = normalizeUnit(item?.unit);
  if (q === null || q <= 0) return { value: null, unit: baseUnit, text: '' };
  let value = q;
  const heads = toNum(totalHeads);
  if (item.per_person && heads !== null) value = q * Math.max(0, heads);
  let unit = baseUnit;
  if (unit === 'גרם' && value >= 1000) {
    value = Math.round(value / 100) / 10;
    unit = 'ק"ג';
  } else if (unit === 'מ"ל' && value >= 1000) {
    value = Math.round(value / 100) / 10;
    unit = 'ליטר';
  } else if (!MEASURE_UNITS.has(unit) && item.per_person) {
    value = Math.ceil(value - 1e-9); // you can't buy 5.5 kebabs
  } else {
    value = Math.round(value * 100) / 100;
  }
  return { value, unit, text: formatQty(value, unit) };
}

// ───────────────────────── items & readiness ─────────────────────────

function posInt(v, dflt) {
  const n = Math.round(toNum(v) ?? dflt);
  return n > 0 ? n : dflt;
}

export function itemProgress(item, pledges, members) {
  const own = list(pledges)
    .filter((p) => p && p.item_id === item?.id)
    .sort((a, b) => timeOf(a.created_at) - timeOf(b.created_at));
  const pledgers = own.map((p) => ({ member_id: p.member_id, qty: posInt(p.qty, 1), done: !!p.done }));
  const memberList = list(members);
  let pledged;
  let needed;
  let doneCount;
  let total;
  let state;

  let units;
  if (item?.type === 'each') {
    const ids = new Set(memberList.map((m) => m.id));
    const doneIds = new Set(own.filter((p) => p.done && ids.has(p.member_id)).map((p) => p.member_id));
    total = memberList.length;
    needed = total;
    doneCount = doneIds.size;
    pledged = new Set(own.filter((p) => ids.has(p.member_id)).map((p) => p.member_id)).size;
    state = total > 0 && doneCount >= total ? 'done' : doneCount > 0 ? 'partial' : 'missing';
    // per couple / family (SPEC §19): how many things, and how many of them are packed ("12 מתוך 14 כיסאות")
    const byMember = new Map(own.map((p) => [p.member_id, p]));
    units = { needed: 0, done: 0 };
    for (const m of memberList) {
      const s = eachSplitOf(item, m, byMember.get(m.id));
      units.needed += s.target;
      units.done += s.doneUnits;
    }
  } else if (item?.type === 'bring') {
    needed = posInt(item.needed, 1);
    pledged = pledgers.reduce((s, p) => s + p.qty, 0);
    total = pledgers.length;
    doneCount = pledgers.filter((p) => p.done).length;
    if (pledged <= 0) state = 'missing';
    else if (pledged < needed) state = 'partial';
    else state = pledgers.every((p) => p.done) ? 'done' : 'covered';
  } else {
    // buy / task: one assignee is enough; items.done = bought / completed
    needed = 1;
    pledged = pledgers.length;
    total = 1;
    doneCount = item?.done ? 1 : 0;
    state = item?.done ? 'done' : pledgers.length ? 'covered' : 'missing';
  }

  if (item?.status === 'proposed') state = 'proposed';
  else if (item?.status === 'rejected') state = 'rejected';
  const out = { state, pledged, needed, doneCount, total, pledgers };
  if (units) out.units = units;
  return out;
}

const isActive = (item) => !!item && (item.status ?? 'active') === 'active';

function groupPledges(snap) {
  const map = new Map();
  for (const p of list(snap?.pledges)) {
    if (!p) continue;
    if (!map.has(p.item_id)) map.set(p.item_id, []);
    map.get(p.item_id).push(p);
  }
  return map;
}

export function tripReadiness(snap) {
  const members = list(snap?.members);
  const byItem = groupPledges(snap);
  const r = { pct: 0, total: 0, covered: 0, missing: 0, partial: 0, proposed: 0, done: 0 };
  for (const item of list(snap?.items)) {
    if (!item) continue;
    if (item.status === 'proposed') {
      r.proposed++;
      continue;
    }
    if (!isActive(item)) continue;
    r.total++;
    const { state } = itemProgress(item, byItem.get(item.id) || [], members);
    if (state === 'done') {
      r.done++;
      r.covered++;
    } else if (state === 'covered') r.covered++;
    else if (state === 'partial') r.partial++;
    else r.missing++;
  }
  // floor, so 100% (and its confetti) only happens when everything is covered
  r.pct = r.total ? (r.covered === r.total ? 100 : Math.floor((r.covered * 100) / r.total)) : 0;
  return r;
}

function itemSorter(snap) {
  const order = new Map();
  list(snap?.categories).forEach((c, i) => order.set(c.id, [toNum(c.sort) ?? 0, i]));
  const catKey = (item) => order.get(item.category_id) || [Infinity, Infinity];
  return (a, b) => {
    const ca = catKey(a);
    const cb = catKey(b);
    return (
      ca[0] - cb[0] ||
      ca[1] - cb[1] ||
      (toNum(a.sort) ?? 0) - (toNum(b.sort) ?? 0) ||
      timeOf(a.created_at) - timeOf(b.created_at) ||
      String(a.title ?? '').localeCompare(String(b.title ?? ''), 'he')
    );
  };
}

export function myAgenda(snap, memberId) {
  const out = { bring: [], buy: [], tasks: [], each: [], packedPct: 0 };
  const me = memberId ?? snap?.me?.member_id ?? null;
  if (me === null || me === undefined) return out;
  const mine = new Map(list(snap?.pledges).filter((p) => p && p.member_id === me).map((p) => [p.item_id, p]));
  const items = list(snap?.items).filter((it) => it && it.status !== 'rejected').sort(itemSorter(snap));
  const member = list(snap?.members).find((m) => m && m.id === me) || null;
  const person = snap?.me?.member_id === me ? snap?.me?.person ?? null : null;
  let total = 0;
  let done = 0;
  for (const item of items) {
    const pledge = mine.get(item.id);
    if (item.type === 'each') {
      if (!isActive(item)) continue;
      // a couple that brings it each their own (SPEC §19): my share, ticked by me
      const split = member ? eachSplitOf(item, member, pledge) : null;
      const part = split?.split && person ? split.parts.find((x) => x.person === person) : null;
      if (part) {
        if (part.qty === 0 && split.open === 0) continue;       // all of it is my partner's
        const isDone = part.qty > 0 && part.done;
        out.each.push({ item, done: isDone, split: true, qty: part.qty, open: split.open, target: split.target });
        total++;
        if (isDone) done++;
        continue;
      }
      const isDone = !!pledge?.done;
      out.each.push({ item, done: isDone });
      total++;
      if (isDone) done++;
    } else if (pledge) {
      if (item.type === 'bring') {
        out.bring.push({ item, pledge });
        total++;
        if (pledge.done) done++;
      } else if (item.type === 'buy' || item.type === 'task') {
        (item.type === 'buy' ? out.buy : out.tasks).push({ item, pledge });
        total++;
        if (item.done) done++;
      }
    }
  }
  out.packedPct = total ? (done === total ? 100 : Math.floor((done * 100) / total)) : 0;
  return out;
}

export function missingItems(snap) {
  const members = list(snap?.members);
  const byItem = groupPledges(snap);
  return list(snap?.items)
    .filter((item) => {
      if (!isActive(item)) return false;
      const { state } = itemProgress(item, byItem.get(item.id) || [], members);
      return state === 'missing' || state === 'partial';
    })
    .sort(itemSorter(snap));
}

// ───────────────────────── money ─────────────────────────

/** Split `cents` by weights with largest-remainder rounding (sum is exact). */
function allocateCents(cents, parts) {
  const W = parts.reduce((s, p) => s + p.weight, 0);
  if (!parts.length || !(W > 0)) return [];
  const sign = cents < 0 ? -1 : 1;
  const abs = Math.abs(cents);
  const rows = parts.map((p, i) => {
    const exact = (abs * p.weight) / W;
    const base = Math.floor(exact + 1e-9);
    return { i, base, frac: exact - base };
  });
  let rest = abs - rows.reduce((s, r) => s + r.base, 0);
  const byFrac = [...rows].sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % byFrac.length, rest--) byFrac[k].base++;
  for (let k = byFrac.length - 1; rest < 0; k = (k - 1 + byFrac.length) % byFrac.length) {
    if (byFrac[k].base > 0) {
      byFrac[k].base--;
      rest++;
    }
  }
  return rows.map((r) => ({ member_id: parts[r.i].member_id, cents: sign * r.base }));
}

function shareCents(expense, snap) {
  if (!expense) return [];
  const members = list(snap?.members);
  let parts;
  if (expense.split_mode === 'members') {
    const byId = membersById(members);
    const orderOf = new Map(members.map((m, i) => [m.id, i]));
    // `expense.members` lets the UI preview a split before it is saved
    const rows = Array.isArray(expense.members)
      ? expense.members
      : list(snap?.expense_shares).filter((s) => s && s.expense_id === expense.id);
    const seen = new Set();
    parts = [];
    for (const r of rows) {
      if (!r || r.member_id == null || seen.has(r.member_id)) continue;
      seen.add(r.member_id);
      const w = toNum(r.weight);
      parts.push({ member_id: r.member_id, weight: w > 0 ? w : headcountOf(byId.get(r.member_id)) });
    }
    parts.sort(
      (a, b) =>
        (orderOf.get(a.member_id) ?? Infinity) - (orderOf.get(b.member_id) ?? Infinity) ||
        String(a.member_id).localeCompare(String(b.member_id)),
    );
  } else {
    // "everyone" = all but the members the admin marked exempt (settings.money.exempt) — unless that's nobody
    const exempt = new Set(list(snap?.trip?.settings?.money?.exempt));
    const all = members.filter((m) => m && m.id != null);
    const payers = all.filter((m) => !exempt.has(m.id));
    parts = (payers.length ? payers : all).map((m) => ({ member_id: m.id, weight: headcountOf(m) }));
  }
  return allocateCents(toCents(expense.amount), parts);
}

export function expenseShares(expense, snap) {
  return shareCents(expense, snap).map((s) => ({ member_id: s.member_id, amount: fromCents(s.cents) }));
}

/** A request whose collected money sits "בקופה": no purchase recorded yet (no expense_id). Not a collection from
 *  before the pot rule (pot === false, set by the schema upgrade): there the payments count in the balances, as
 *  they did when they were made — its purchase may already be an ordinary expense. */
const holdsPot = (q) => Boolean(q) && !q.expense_id && q.pot !== false;

/** Payments that are money collected on a request whose purchase isn't recorded yet ("בקופה"): they stay out of
 *  the balances until the purchase is recorded (the request gets an expense_id) — SQL _in_pot. */
export function potPaymentIds(snap) {
  const open = new Set(list(snap?.money_requests).filter(holdsPot).map((q) => q.id));
  const rows = [...list(snap?.money_request_members), ...list(snap?.money_request_parts)];     // a couple's parts (§19)
  return new Set(rows.filter((x) => x && x.payment_id && open.has(x.request_id)).map((x) => x.payment_id));
}

/** Per collecting request with money in it and no purchase recorded: {request, collected, count, self}. */
export function moneyPots(snap) {
  const pays = new Map(list(snap?.payments).map((p) => [p.id, p]));
  return list(snap?.money_requests).filter(holdsPot).map((q) => {
    // a row of a couple that pays each their own part (SPEC §19) counts the parts paid so far
    const partsOf = (x) => list(snap?.money_request_parts).filter((p) => p.request_id === q.id && p.member_id === x.member_id);
    const paidOf = (x) => {
      if (x.payment_id && pays.has(x.payment_id)) return toCents(x.amount);
      return partsOf(x).filter((p) => p.payment_id && pays.has(p.payment_id)).reduce((s, p) => s + toCents(p.amount), 0);
    };
    const rows = list(snap?.money_request_members).filter((x) => x.request_id === q.id).map(paidOf).filter((c) => c > 0);
    const cents = rows.reduce((s, c) => s + c, 0);
    return { request: q, collected: fromCents(cents), count: rows.length, self: toNum(q.self_amount) || 0 };
  }).filter((p) => p.collected > 0);
}

/** Who shares an "everyone" expense: all but the exempt (settings.money.exempt) — everyone, if that's nobody. */
export function payingMembers(snap) {
  const all = list(snap?.members).filter((m) => m && m.id != null);
  const exempt = new Set(list(snap?.trip?.settings?.money?.exempt));
  const payers = all.filter((m) => !exempt.has(m.id));
  return payers.length ? payers : all;
}

export function balances(snap) {
  const members = list(snap?.members).filter((m) => m && m.id != null);
  const pot = potPaymentIds(snap);
  const acc = new Map(members.map((m) => [m.id, { paid: 0, owed: 0, sent: 0, received: 0 }]));
  for (const e of list(snap?.expenses)) {
    if (!e) continue;
    const payer = acc.get(e.paid_by);
    if (payer) payer.paid += toCents(e.amount);
    for (const s of shareCents(e, snap)) {
      const a = acc.get(s.member_id);
      if (a) a.owed += s.cents;
    }
  }
  for (const p of list(snap?.payments)) {
    if (!p || pot.has(p.id)) continue;
    const c = toCents(p.amount);
    const from = acc.get(p.from_member);
    const to = acc.get(p.to_member);
    if (from) from.sent += c;
    if (to) to.received += c;
  }
  return members.map((m) => {
    const a = acc.get(m.id);
    return {
      member_id: m.id,
      paid: fromCents(a.paid),
      owed: fromCents(a.owed),
      sent: fromCents(a.sent),
      received: fromCents(a.received),
      balance: fromCents(a.paid - a.owed + a.sent - a.received),
    };
  });
}

/** Who pays whom. Rows are balances() (keyed by member_id) or partyBalances() (keyed by `key` — a person of a
 *  couple that pays each their own part is `${member_id}::${person}`); from/to are those keys. */
export function settlePlan(balancesArr) {
  const rows = list(balancesArr)
    .filter((b) => b && (b.key ?? b.member_id) != null)
    .map((b, i) => ({ id: b.key ?? b.member_id, c: toCents(b.balance), i }));
  const debtors = rows.filter((r) => r.c < 0).map((r) => ({ ...r, c: -r.c }));
  const creditors = rows.filter((r) => r.c > 0);
  const largest = (xs) =>
    xs.reduce((best, x) => (x.c > 0 && (!best || x.c > best.c || (x.c === best.c && x.i < best.i)) ? x : best), null);
  const out = [];
  for (;;) {
    const d = largest(debtors);
    const c = largest(creditors);
    if (!d || !c) break;
    const x = Math.min(d.c, c.c);
    d.c -= x;
    c.c -= x;
    if (x >= 100 && d.id !== c.id) out.push({ from: d.id, to: c.id, amount: Math.round(x / 100) });
  }
  return out;
}

// ───────────────────────── couples & families inside one profile (SPEC §19) ─────────────────────────

/** A profile's names, each once, in their order. */
function namesOf(member) {
  return [...new Set(list(member?.people).map((p) => String(p ?? '').trim()).filter(Boolean))];
}

/** The profile pays "each their own part" (members.prefs.pay = 'each') — only with 2+ names. */
export function splitsMoney(member) {
  return namesOf(member).length >= 2 && member?.prefs?.pay === 'each';
}

/** The profile brings a "כל אחד מביא" item each their own: the item's own choice (pledge.split), else
 *  members.prefs.bring — only with 2+ names. */
export function splitsItems(member, pledge = null) {
  if (namesOf(member).length < 2) return false;
  const own = pledge?.split === 'each' || pledge?.split === 'together' ? pledge.split : null;
  return (own ?? member?.prefs?.bring ?? 'together') === 'each';
}

/** How many of an "each" item a profile brings: N (item.each_qty, default 1) per couple / family, ceil(N/2) alone. */
export function eachTarget(item, member) {
  const n = posInt(item?.each_qty, 1);
  return headcountOf(member) >= 2 ? n : Math.ceil(n / 2);
}

/**
 * A profile's row of an "each" item: {split, target, parts: [{person, qty, done}], open, doneUnits, done}.
 * Together (default): no parts, one tick (done = pledge.done). Split: who brings how many (pledge.person_qty,
 * else floor(target / n) each; clipped from the end so Σ ≤ target), `open` = units nobody took yet.
 */
export function eachSplitOf(item, member, pledge) {
  const target = eachTarget(item, member);
  const packed = !!pledge?.done;
  if (!splitsItems(member, pledge)) return { split: false, target, parts: [], open: 0, doneUnits: packed ? target : 0, done: packed };
  const names = namesOf(member);
  const pq = pledge?.person_qty && typeof pledge.person_qty === 'object' && !Array.isArray(pledge.person_qty) ? pledge.person_qty : null;
  const ticked = new Set(list(pledge?.done_people));
  let left = target;
  const parts = names.map((person) => {
    let qty = pq === null ? Math.floor(target / names.length) : typeof pq[person] === 'number' ? Math.max(0, Math.round(pq[person])) : 0;
    qty = Math.min(qty, left);
    left -= qty;
    return { person, qty, done: ticked.has(person) };
  });
  const doneUnits = parts.reduce((sum, x) => sum + (x.done ? x.qty : 0), 0);
  return { split: true, target, parts, open: left, doneUnits, done: packed };
}

/** A settle-up party key → {member_id, person} (person null for a whole profile). */
export function partyOf(key) {
  const s = String(key ?? '');
  const i = s.indexOf('::');
  return i < 0 ? { member_id: key ?? null, person: null } : { member_id: s.slice(0, i), person: s.slice(i + 2) };
}

/** Who settles, in members order: a profile, or — when it pays each their own part — each of its people.
 *  [{key, member_id, person, member}]. */
export function parties(snap) {
  const out = [];
  for (const m of list(snap?.members)) {
    if (!m || m.id == null) continue;
    if (!splitsMoney(m)) out.push({ key: m.id, member_id: m.id, person: null, member: m });
    else for (const person of namesOf(m)) out.push({ key: `${m.id}::${person}`, member_id: m.id, person, member: m });
  }
  return out;
}

/** The name of a party key: the person, else the profile's name. */
export function partyName(snap, key) {
  const { member_id: id, person } = partyOf(key);
  if (person) return person;
  return displayName(list(snap?.members).find((m) => m && m.id === id));
}

/**
 * balances() per party (SPEC §19): a profile that pays each their own part is one row per person — its part of the
 * expenses split equally among its people; what it paid / sent / got goes to the person named on it
 * (paid_by_person / from_person / to_person), the rest (null = together, or a name it no longer has) split equally
 * (agorot to the first ones). Σ of a profile's rows = its balances() row to the agora. Every other profile: its
 * balances() row as is (key = member_id) — so with nobody splitting this is exactly balances().
 */
export function partyBalances(snap) {
  const base = balances(snap);
  const byId = membersById(list(snap?.members));
  const pot = potPaymentIds(snap);
  const out = [];
  for (const b of base) {
    const m = byId.get(b.member_id);
    if (!splitsMoney(m)) {
      out.push({ key: b.member_id, person: null, ...b });
      continue;
    }
    const names = namesOf(m);
    const own = new Map(names.map((p) => [p, { paid: 0, sent: 0, received: 0 }]));
    const shared = { paid: 0, sent: 0, received: 0 };
    const add = (field, person, cents) => {
      const row = own.get(person);
      if (row) row[field] += cents;
      else shared[field] += cents;
    };
    for (const e of list(snap?.expenses)) if (e && e.paid_by === m.id) add('paid', e.paid_by_person, toCents(e.amount));
    for (const p of list(snap?.payments)) {
      if (!p || pot.has(p.id)) continue;
      if (p.from_member === m.id) add('sent', p.from_person, toCents(p.amount));
      if (p.to_member === m.id) add('received', p.to_person, toCents(p.amount));
    }
    const equal = (cents) => allocateCents(cents, names.map((p) => ({ member_id: p, weight: 1 }))).map((x) => x.cents);
    const owed = equal(toCents(b.owed));
    const paid = equal(shared.paid);
    const sent = equal(shared.sent);
    const received = equal(shared.received);
    names.forEach((person, i) => {
      const r = own.get(person);
      const c = { paid: r.paid + paid[i], owed: owed[i], sent: r.sent + sent[i], received: r.received + received[i] };
      out.push({
        key: `${m.id}::${person}`, person, member_id: m.id,
        paid: fromCents(c.paid), owed: fromCents(c.owed), sent: fromCents(c.sent), received: fromCents(c.received),
        balance: fromCents(c.paid - c.owed + c.sent - c.received),
      });
    });
  }
  return out;
}

/**
 * One whole-shekel number per settle-up party, straight from the plan — so every screen says what the transfers
 * say ("עליך להעביר ₪644" = the rows under it, 627 + 17, never ₪643.51): Map key → net (to get − to pay).
 * A party with nothing to move is absent (= even), also when its balance is a few agorot off.
 */
export function settleNets(plan) {
  const nets = new Map();
  for (const t of list(plan)) {
    if (!t) continue;
    nets.set(t.from, (nets.get(t.from) || 0) - t.amount);
    nets.set(t.to, (nets.get(t.to) || 0) + t.amount);
  }
  return nets;
}

/** settleNets per profile: Map member_id → net. A couple that pays each their own part is its people together
 *  (a transfer inside the profile cancels out). `plan` defaults to the trip's plan. */
export function memberNets(snap, plan = null) {
  const nets = new Map();
  for (const t of plan || settlePlan(partyBalances(snap))) {
    const from = partyOf(t.from).member_id;
    const to = partyOf(t.to).member_id;
    nets.set(from, (nets.get(from) || 0) - t.amount);
    nets.set(to, (nets.get(to) || 0) + t.amount);
  }
  return nets;
}

/**
 * My one number (whole shekels; + = I get, − = I pay) — what the home chip, the money header and the closing card
 * all say: my own part when my profile pays each their own part and this device said who it is, else my profile's.
 */
export function myNet(snap, plan = null) {
  const meId = snap?.me?.member_id;
  if (meId == null) return 0;
  const p = plan || settlePlan(partyBalances(snap));
  const me = list(snap?.members).find((m) => m && m.id === meId);
  const person = snap.me?.person || null;
  if (person && splitsMoney(me) && namesOf(me).includes(person)) return settleNets(p).get(`${meId}::${person}`) || 0;
  return memberNets(snap, p).get(meId) || 0;
}

/** "Even" the way the server says it (_member_balance ≥ −1): the balance rounded to whole shekels owes under ₪2. */
export function balanceSettled(balance) {
  const b = toNum(balance) || 0;
  return Math.sign(b) * Math.round(Math.abs(b)) >= -1;
}

/**
 * The money requests that still wait for something — per open request:
 * {request, owes: [{member_id, person, amount}], waiting: [{member_id, person, amount, payment}]}.
 * owes = a share (a couple's: a part) nobody paid yet — on an "already paid" request (its shares are an expense,
 * so part of the balance) only while that profile / person is still in debt; once they're even the settle-up
 * covered it. waiting = marked as paid, not confirmed yet. Requests with neither are left out (nothing is open).
 */
export function openMoneyRequests(snap) {
  const reqs = list(snap?.money_requests).filter((q) => q && q.status === 'open');
  if (!reqs.length) return [];
  const pays = new Map(list(snap?.payments).map((p) => [p.id, p]));
  const pbals = reqs.some((q) => q.expense_id) ? partyBalances(snap) : [];
  const balOf = (memberId, person) => {
    const own = person ? pbals.find((b) => b.key === `${memberId}::${person}`) : null;
    if (own) return own.balance;
    return fromCents(pbals.filter((b) => b.member_id === memberId).reduce((n, b) => n + toCents(b.balance), 0));
  };
  const out = [];
  for (const q of reqs) {
    const owes = [];
    const waiting = [];
    const look = (memberId, person, row) => {
      const pay = row.payment_id ? pays.get(row.payment_id) : null;
      if (pay) {
        if (pay.status !== 'confirmed') waiting.push({ member_id: memberId, person, amount: toNum(row.amount) || 0, payment: pay });
      } else if (!q.expense_id || !balanceSettled(balOf(memberId, person))) {
        owes.push({ member_id: memberId, person, amount: toNum(row.amount) || 0 });
      }
    };
    for (const x of list(snap?.money_request_members)) {
      if (!x || x.request_id !== q.id) continue;
      const parts = list(snap?.money_request_parts).filter((p) => p && p.request_id === q.id && p.member_id === x.member_id);
      if (parts.length) for (const p of parts) look(x.member_id, p.person, p);
      else look(x.member_id, null, x);
    }
    if (owes.length || waiting.length) out.push({ request: q, owes, waiting });
  }
  return out;
}

export function tripTotals(snap) {
  const spentCents = list(snap?.expenses).reduce((s, e) => s + (e ? toCents(e.amount) : 0), 0);
  const heads = headcountTotal(payingMembers(snap));               // the exempt don't share everyone-expenses
  const spent = fromCents(spentCents);
  return { spent, perHead: heads ? Math.round(spentCents / heads) / 100 : 0, heads };
}

export function formatMoney(n) {
  const cents = Math.round((toNum(n) ?? 0) * 100);
  const abs = Math.abs(cents);
  const whole = abs % 100 === 0;
  const s = formatNumber(abs / 100, whole ? 0 : 2, whole ? 0 : 2);
  return `${cents < 0 ? '-' : ''}₪${s}`;
}

// ───────────────────────── list-text parser (WhatsApp → items) ─────────────────────────

const CATS = {
  meat: { emoji: '🥩', name: 'בשר ועוף' },
  veg: { emoji: '🥗', name: 'ירקות ופירות' },
  pantry: { emoji: '🥫', name: 'מזווה ורטבים' },
  snacks: { emoji: '🍿', name: 'נשנושים ומתוקים' },
  drinks: { emoji: '🥤', name: 'שתייה ואלכוהול' },
  grill: { emoji: '🔥', name: 'מנגל ובישול' },
  dispo: { emoji: '\u{1F37D}\uFE0F', name: 'חד\u05BEפעמי' },
  gear: { emoji: '⛺', name: 'ציוד קבוצתי' },
  fun: { emoji: '🎲', name: 'כיף ומשחקים' },
  tasks: { emoji: '📋', name: 'משימות' },
};
const catObj = (key) => ({ ...CATS[key] });

/** Normalise text for keyword matching: no niqqud/quotes, hyphens → spaces. */
function normKey(s) {
  return String(s)
    .replace(/[\u0591-\u05BD\u05BF-\u05C7]/g, '')
    .replace(/[\u05BE\-‐–—_/]/g, ' ')
    .replace(/["'׳״`]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word matcher tolerant to Hebrew one/two-letter prefixes (ו/ה/ל/ב/מ/ש/כ). */
function wordMatcher(words) {
  const alts = [...new Set(words.map(normKey))].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])[והלבמשכ]{0,2}(?:${alts})(?=$|[^\\p{L}\\p{N}])`, 'u');
}

const HEADER_WORDS = {
  meat: ['בשר', 'בשרים', 'עוף', 'עופות', 'קצביה', 'קצבייה', 'meat', 'bbq'],
  veg: ['ירקות', 'ירק', 'פירות', 'פרי', 'סלטים', 'סלט', 'vegetables', 'veggies', 'fruit', 'fruits', 'produce'],
  pantry: ['מזווה', 'רטבים', 'רוטב', 'שימורים', 'מכולת', 'יבשים', 'לחמים', 'לחם', 'מאפים', 'pantry', 'bakery', 'sauces'],
  snacks: ['נשנושים', 'נשנוש', 'חטיפים', 'מתוקים', 'ממתקים', 'קינוחים', 'פיצוחים', 'snacks', 'sweets', 'desserts'],
  drinks: ['שתייה', 'שתיה', 'משקאות', 'אלכוהול', 'drinks', 'beverages', 'alcohol'],
  grill: ['מנגל', 'בישול', 'מטבח', 'גריל', 'כלי בישול', 'grill', 'cooking', 'kitchen'],
  dispo: ['חד פעמי', 'חד פעמיים', 'חדפ', 'disposables', 'tableware'],
  gear: ['ציוד', 'קמפינג', 'לינה', 'ישיבה', 'אוהלים', 'gear', 'equipment', 'camping'],
  fun: ['כיף', 'משחקים', 'משחק', 'בידור', 'פעילויות', 'פנאי', 'fun', 'games', 'activities'],
  tasks: ['משימות', 'משימה', 'מטלות', 'סידורים', 'tasks', 'todo', 'to do', 'chores'],
};

const ITEM_WORDS = {
  meat: ['סטייק', 'אנטריקוט', 'פרגית', 'פרגיות', 'נקניק', 'נקניקיות', 'מרגז', 'קבב', 'קבבים', 'כנפיים', 'שניצל',
    'שניצלים', 'המבורגר', 'המבורגרים', 'עוף', 'בשר', 'צלעות', 'אסאדו', 'קציצות', 'כבד', 'לבבות', 'חזה עוף', 'שוקיים'],
  veg: ['עגבניות', 'עגבנייה', 'עגבניה', 'מלפפונים', 'מלפפון', 'בצל', 'שום', 'אבטיח', 'מלון', 'לימון', 'לימונים',
    'תפוחים', 'בננות', 'ענבים', 'פירות', 'ירקות', 'חסה', 'תפוחי אדמה', 'בטטה', 'פטריות', 'סלט', 'סלטים', 'תירס', 'גזר', 'כרוב', 'פלפל', 'פלפלים'],
  pantry: ['קטשופ', 'מיונז', 'חרדל', 'פיתות', 'פיתה', 'לחם', 'לחמניות', 'בגטים', 'ביצים', 'שמן', 'טחינה', 'חומוס',
    'מטבוחה', 'רוטב', 'רטבים', 'אורז', 'פסטה', 'קמח', 'סוכר', 'טונה', 'דבש', 'עגבניות מרוסקות', 'שימורים'],
  snacks: ['חטיפים', 'חטיף', 'במבה', 'ביסלי', 'שוקולד', 'עוגיות', 'עוגה', 'גומי', 'גרעינים', 'פיצוחים', 'ממתקים',
    'מרשמלו', 'ופלים', 'לואקר', 'בוטנים', 'פופקורן'],
  drinks: ['מים', 'שתייה', 'שתיה', 'קולה', 'ספרייט', 'בירה', 'בירות', 'יין', 'בריזר', 'וודקה', 'ערק', 'אלכוהול',
    'סודה', 'קרח', 'משקאות', 'מיץ'],
  grill: ['מנגל', 'פחמים', 'חומר מדליק', 'מדליק', 'נפנף', 'מלקחיים', 'מחבת', 'מחבתות', 'סיר', 'סירים', 'גזייה', 'גזיה',
    'בלון גז', 'גז', 'פינגאן', 'פקל קפה', 'קרש חיתוך', 'קרשי חיתוך', 'סכין', 'סכינים', 'מזלג', 'מזלגות', 'רשת',
    'שיפודי עץ', 'שיפודים', 'תבלינים', 'תבלין', 'קומקום', 'מצית', 'מצתים', 'גפרורים', 'מלח', 'פפריקה'],
  dispo: ['צלחות', 'כוסות', 'חד פעמי', 'חדפ', 'מפיות', 'נייר סופג', 'נייר כסף', 'שקיות זבל', 'קשים', 'תבניות',
    'ניילון נצמד'],
  gear: ['כסאות', 'כיסאות', 'כסא', 'כיסא', 'מחצלת', 'מחצלות', 'גזיבו', 'צידנית', 'צידניות', 'קרחונים', 'תאורה',
    'פנס', 'פנסים', 'שולחן', 'אוהל', 'מאריך', 'כבל מאריך', 'מזרן', 'מזרנים', 'ערסל'],
  fun: ['כדור', 'כדורים', 'מטקות', 'קלפים', 'שש בש', 'רמקול', 'משחק', 'משחקים', 'גיטרה', 'פריזבי', 'טאקי', 'שחמט'],
  tasks: [],
};

const HEADER_MATCHERS = Object.entries(HEADER_WORDS).map(([k, w]) => [k, wordMatcher(w)]);
const ITEM_MATCHERS = Object.entries(ITEM_WORDS)
  .filter(([, w]) => w.length)
  .map(([k, w]) => [k, wordMatcher(w)]);

/** Category keys whose keywords appear in `text`, ordered by first position. */
function catHits(text, matchers) {
  const t = normKey(text);
  const hits = [];
  for (const [key, re] of matchers) {
    const m = re.exec(t);
    if (m) hits.push([key, m.index]);
  }
  return hits.sort((a, b) => a[1] - b[1]).map(([k]) => k);
}

const EMOJI_CAT = new Map();
for (const [key, chars] of Object.entries({
  meat: '🥩🍗🍖🥓🌭🍔',
  veg: '🥗🥒🍅🥬🍉🍋🥕🍎🍏🍌🍇🍓🍊🧅🧄🌶🌽🥑🍆🥦🍍🥝🍐🍑🍒🍈🥭',
  pantry: '🥫🧂🍞🥚🫒🥖🥯🧈🍯🫙',
  snacks: '🍿🍫🍬🍭🍪🥨🍩🍦🧁🍰🥜🌰',
  drinks: '🥤🍺🍻🍷🥂🍾🧃💧🥛🍹🍸🥃🧊☕🧉🍶🫖',
  grill: '🔥🍳🥘🍲🔪🫕',
  dispo: '🍽🥄🍴🥢',
  gear: '⛺🏕🎒🪑🔦💡🛖🏖',
  fun: '🎲🎮⚽🏐🏀🎸🃏🎯🎉🎶🎵🔊🪁🏓',
  tasks: '📋📝🗒',
})) {
  for (const ch of chars) if (/\p{Extended_Pictographic}/u.test(ch)) EMOJI_CAT.set(ch, key);
}
const emojiCategory = (emoji) => (emoji ? EMOJI_CAT.get(String.fromCodePoint(emoji.codePointAt(0))) || null : null);

const EMOJI_CLUSTER = '(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator})[\\uFE0F\\u20E3\\u{1F3FB}-\\u{1F3FF}]*(?:\\u200D\\p{Extended_Pictographic}\\uFE0F?)*';
const LEADING_EMOJI_RE = new RegExp(`^(?:${EMOJI_CLUSTER}\\s*)+`, 'u');
const FIRST_EMOJI_RE = new RegExp(`^${EMOJI_CLUSTER}`, 'u');
const TRAILING_EMOJI_RE = new RegExp(`(?:\\s*${EMOJI_CLUSTER})+$`, 'u');
const ANY_EMOJI_RE = new RegExp(EMOJI_CLUSTER, 'gu');

const UNIT_ALTS = [...UNIT_LOOKUP.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
const UNIT = `(${UNIT_ALTS})(?=$|[^\\p{L}])`;
const UNIT_START_RE = new RegExp(`^\\s*${UNIT}`, 'u');
const ADJ = '(?:\\s+(קטנה|גדולה|קטן|גדול|קטנות|גדולות|קטנים|גדולים|משפחתית|משפחתי))?(?=$|[^\\p{L}])';
const NUM = '(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?|½|¼|¾)';
const HEB_NUMBERS = {
  'אחד': 1, 'אחת': 1, 'שניים': 2, 'שתיים': 2, 'שני': 2, 'שתי': 2, 'שלושה': 3, 'שלוש': 3, 'שלושת': 3,
  'ארבעה': 4, 'ארבע': 4, 'ארבעת': 4, 'חמישה': 5, 'חמש': 5, 'חמשת': 5, 'שישה': 6, 'שש': 6, 'ששת': 6,
  'שבעה': 7, 'שבע': 7, 'שמונה': 8, 'תשעה': 9, 'תשע': 9, 'עשרה': 10, 'עשר': 10, 'חצי': 0.5,
};
const HEBNUM = `(${Object.keys(HEB_NUMBERS).sort((a, b) => b.length - a.length).join('|')})`;
const IMPLICIT_ONE = '(חבילת|חבילה|גליל|קופסת|שישיית|שישייה|שישיה|קילו|ליטר)';
const X = '[x×*]';

const QTY_ONLY_RES = [
  [new RegExp(`^(?:${X}\\s*)?${NUM}\\s*(?:${X})?\\s*(?:${UNIT}${ADJ})?$`, 'u'), 'num'],
  [new RegExp(`^${HEBNUM}\\s+${UNIT}${ADJ}$`, 'u'), 'heb'],
  [new RegExp(`^${UNIT}${ADJ}$`, 'u'), 'unit'],
];
const LEAD_RES = [
  [new RegExp(`^${NUM}(?:\\s*${X})?\\s*(?:${UNIT}${ADJ})?\\s*(?:של\\s+)?(.*\\p{L}.*)$`, 'u'), 'num'],
  [new RegExp(`^${HEBNUM}\\s+${UNIT}${ADJ}\\s*(?:של\\s+)?(.*\\p{L}.*)$`, 'u'), 'heb'],
  [new RegExp(`^${IMPLICIT_ONE}(?=\\s)${ADJ}\\s+(?:של\\s+)?(.*\\p{L}.*)$`, 'u'), 'implicit'],
];
const TRAIL_RES = [
  [new RegExp(`^(.*\\p{L}.*?)\\s+(?:${X}\\s*)?${NUM}\\s*(?:${X})?\\s*(?:${UNIT}${ADJ})?$`, 'u'), 'num'],
  [new RegExp(`^(.*\\p{L}.*?)\\s*[×*]\\s*${NUM}$`, 'u'), 'numx'],
  [new RegExp(`^(.*\\p{L}.*?)\\s+${HEBNUM}\\s+${UNIT}${ADJ}$`, 'u'), 'heb'],
  // "פחמים 2 שקים" with a word that isn't a known unit: qty 2, the words become a note
  [new RegExp(`^(.*\\p{L}.*?)\\s+${NUM}\\s+(\\p{L}[\\p{L}׳'"]*)$`, 'u'), 'numword'],
];

function parseNumber(s) {
  if (s === '½') return 0.5;
  if (s === '¼') return 0.25;
  if (s === '¾') return 0.75;
  if (s in HEB_NUMBERS) return HEB_NUMBERS[s];
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Turns a regex match into {qty, unit, note}; `note` keeps "חבילה קטנה"-style size hints. */
function qtyFrom(numStr, unitStr, adj) {
  const qty = numStr === null ? 1 : parseNumber(numStr);
  const unit = unitStr ? normalizeUnit(unitStr) : null;
  return { qty, unit, note: adj && unitStr ? `${unitStr} ${adj}` : null };
}

function qtyOnly(t) {
  for (const [re, kind] of QTY_ONLY_RES) {
    const m = re.exec(t);
    if (!m) continue;
    if (kind === 'unit') return qtyFrom(null, m[1], m[2]);
    return qtyFrom(m[1], m[2], m[3]);
  }
  return null;
}

function leadingQty(t) {
  for (const [re, kind] of LEAD_RES) {
    const m = re.exec(t);
    if (!m) continue;
    if (kind === 'implicit') return { ...qtyFrom(null, m[1], m[2]), rest: m[3], at: 0 };
    return { ...qtyFrom(m[1], m[2], m[3]), rest: m[4], at: 0 };
  }
  return null;
}

function trailingQty(t) {
  for (const [re, kind] of TRAIL_RES) {
    const m = re.exec(t);
    if (!m) continue;
    const before = m[1];
    if (/(?:^|\s)של$/u.test(before.trim())) continue; // "ביצים של 12" — the number is part of the name
    if (kind === 'numx') return { ...qtyFrom(m[2], null, null), rest: before, at: before.length };
    if (kind === 'numword') {
      if (/(?:^|\s)(?:ל|עם|עד|כ|ב|מ|לכל|פר)$/u.test(before.trim())) continue; // "אוהל ל 4 אנשים"
      return { qty: parseNumber(m[2]), unit: null, note: `${m[2]} ${m[3]}`, rest: before, at: before.length };
    }
    return { ...qtyFrom(m[2], m[3], m[4]), rest: before, at: before.length };
  }
  return null;
}

function stripInvisible(s) {
  return String(s ?? '')
    .replace(/[\u200B\u200C\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
    .replace(/[\u00A0\u2007\u202F\t]/g, ' ');
}

// WhatsApp export prefixes; group 1 is the sender ("עידו")
const WA_PREFIX_RES = [
  /^\[?\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.?)?\]?\s*(?:[-–]\s*)?([^:]{1,40}?):\s+/,
  /^\[\d{1,2}:\d{2}(?::\d{2})?,\s*\d{1,4}[./-]\d{1,2}[./-]\d{1,4}\]\s*([^:]{1,40}?):\s+/,
  // "[12/10, 20:14] דפנה: …" (no year) / "[20:14, 12/10] דפנה: …" / "[20:14] דפנה: …" — always in brackets
  /^\[\d{1,2}[./-]\d{1,2},?\s+\d{1,2}:\d{2}(?::\d{2})?\]\s*([^:]{1,40}?):\s+/,
  /^\[\d{1,2}:\d{2}(?::\d{2})?(?:,\s*\d{1,2}[./-]\d{1,2})?\]\s*([^:]{1,40}?):\s+/,
];
const WA_DATE_ONLY_RE = /^\[?\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s+\d{1,2}:\d{2}/;
// a line that is nothing but a time stamp ("20:14", "[12/10, 20:14]", "12.10.2026, 20:14") — never an item
const STAMP_ONLY_RE = /^[\[(]?(?:\d{1,4}[./-]\d{1,2}(?:[./-]\d{1,4})?,?\s*)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.?)?(?:,\s*\d{1,2}[./-]\d{1,2}(?:[./-]\d{1,4})?)?[\])]?$/;
const SYSTEM_RE = /<[^>]*(?:המדיה|Media|omitted|נערכה|edited)[^>]*>|הודעה זו נמחקה|ההודעה נמחקה|This message was deleted|https?:\/\/|www\./i;
const CHATTER_RE = /^(?:תודה(?: רבה)?|סבבה|אחלה|מעולה|אוקיי|אוקי|ok|בדיוק|יאללה|וואלה|נכון|כן|לא|סגור|מסכים|מסכימה|אין בעיה|בכיף|יפה|חח+|👍+|👌+|🙏+|❤\uFE0F+)[!.\s]*$/iu;
// "חחח סבבה 😂" / "אחלה תודה!!" — a reply made only of chatter words and emoji is never a list line
const CHATTER_WORDS = new Set(['תודה', 'רבה', 'סבבה', 'אחלה', 'מעולה', 'אוקיי', 'אוקי', 'ok', 'בדיוק', 'יאללה', 'וואלה',
  'נכון', 'כן', 'לא', 'סגור', 'מסכים', 'מסכימה', 'בכיף', 'יפה', 'אין', 'בעיה', 'לגמרי', 'ברור', 'טוב']);
function isChatter(s) {
  const words = s.replace(ANY_EMOJI_RE, ' ').replace(/[!.,?？:;'"()-]/g, ' ').split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 6
    && words.every((w) => CHATTER_WORDS.has(w.toLowerCase()) || /^(?:חח+|ה+ה+|lol|😂+)$/iu.test(w));
}
// "חבר'ה מה לוקחים? רשימה ראשונה" / "היי, מי בא?" — talking to the group, not a list line
const VOCATIVE_RE = /^(?:חבר['׳’]?ה|חברים|חברות|היי+|אהלן|בוקר\s+טוב|ערב\s+טוב|צהריים\s+טובים|מה\s+קורה|מה\s+נשמע)(?=[\s,!.?？]|$)/u;
// laughing mid-line ("קרם הגנה כבר כתבתי למעלה חחח")
const LAUGH_RE = /(?:^|\s)(?:חח+|הה+ה|lol|😂+|🤣+)(?=\s|$)/giu;
// a list's title: "מה כל אחד מביא 👇", "מי מביא מה", "חלוקת ציוד:" — and anything that points down at the list
const LIST_TITLE_RE = /^(?:אז\s+)?(?:מה\s+(?:כל\s+(?:אחד|אחת)\s+)?(?:מביא|מביאה|מביאים|לוקח|לוקחת|לוקחים)|מי\s+(?:מביא|מביאה|לוקח|לוקחת|קונה|אחראי|אחראית)\s+(?:על\s+)?מה|מי\s+על\s+מה|חלוקת?\s+ה?(?:ציוד|אחריות|משימות|תפקידים))$/u;
const POINT_DOWN_RE = /(?:\s*(?:👇|⬇\uFE0F?|🔽|⤵\uFE0F?))+\s*$/u;
const BULLET_RE = /^(?:[*+](?=\s)|[-–—•·▪▫◦●○■□►▶➤➢→⁃✓✔✗✘☐☑✅⬜⬛❌➖🔸🔹🔶🔷👉👈🔘]\uFE0F?|\d\uFE0F?\u20E3|\(?\d{1,2}[.)](?!\d)|[א-י][.)](?=\s))\s*/u;
// checklist marks: ✅ / [x] / (v) = already done; ☐ / [ ] = still open
const DONE_RE = /^(?:✅|☑\uFE0F?|✔\uFE0F?|✓|\[[xXvV✓✔]\]|\([xXvV✓✔]\))\s*/u;
const TODO_RE = /^(?:☐|⬜|🔲|◻\uFE0F?|\[\s?\]|\(\s?\))\s*/u;
const TRAIL_DONE_RE = /\s*(?:✅|☑\uFE0F?|✔\uFE0F?|✓)$/u;
// "3- מזלגות" / "4 - כוסות": numbering only when the neighbouring line carries the next/previous number
const NUMBERING_RE = /^(\d{1,2})(?:\s*[-–—]\s*(?=[^\d\s])|\s*[-–—]\s+(?=\d))/; // "2-3 חבילות" stays a range

const ASK_RE = /^(יש\s+ל?מישהו|למישהו\s+יש|למי\s+יש|מישהו\s+(?:יכול\s+)?(?:מביא|להביא|יביא|לוקח|לקחת)|מי\s+(?:יכול\s+(?:להביא|לקחת|לקנות)|מביא|מביאה|יביא|לוקח|לוקחת|קונה|יקנה|יכול))(?=\s|\?|$)\s*(.*)$/u;
const ASK_TAIL_RE = /\s*(?:ו?ש?(?:יכול|יכולה|יוכל)\s+ל(?:הביא|הקפיץ|השאיל)|שיביא|שתביא|להביא|להשאיל|בבית|לטיול|לקמפינג|מביא|ש?אפשר\s+להביא)\s*$/u;
// "מי מביא מה?" — asks about the whole list, not about one item
const ASK_WHAT_RE = /^(?:מה|מי|משהו|כלום|הכל|הכול|איזה|מה\s+עוד|עוד\s+משהו|מה\s+מביאים)$/u;

// "per person" markers and "everyone brings" markers (replaced by spaces so indices stay stable)
const PER_PERSON_RE = /(^|[^\p{L}])(פר\s+(?:בן\s+)?אדם|לבן\s+אדם|לכל\s+אדם|לאדם|לנפש|פר\s+ראש|per\s+person)(?=$|[^\p{L}])/giu;
const EACH_RE = /(^|[^\p{L}])(לכל\s+(?:אחד|אחת)|לכל\s+(?:זוג|משפחה|יחידה)|פר\s+(?:זוג|משפחה)|לזוג|כל\s+(?:זוג|אחד|אחת|משפחה|יחידה|בית))(?=$|[^\p{L}])/gu;

// "אני מביא 2 כסאות" / "להביא מחצלת" → the verb is not part of the item name
const LEADING_VERB_RE = /^(?:אני\s+|אנחנו\s+)?(?:מביא|מביאה|מביאים|להביא|צריך|צריכה|צריכים|לקנות|קונה|קונים|לוקח|לוקחת|לוקחים)\s+(?=\S)/u;

// Who takes it: "אני מביא/ה X", "עליי: X", "הדס מביאה X", "X - הדס", "X (אני)"
const SLASH_SUFFIX = '(?:\\s*\\/\\s*\\p{L}{1,3})?'; // "מביא/ה"
const FIRST_PERSON_RE = new RegExp(`^(?:ו?(?:אני|אנחנו)\\s+(?:מביא|מביאה|מביאים|מביאות|לוקח|לוקחת|לוקחים|לוקחות|קונה|קונים|קונות|דואג|דואגת|דואגים|אחראי|אחראית|על)${SLASH_SUFFIX}|(?:ו?(?:אני|אנחנו)\\s+)?(?:אביא|נביא|אקח|ניקח|אקנה|נקנה)|עליי|עלינו)(?=$|[^\\p{L}])(?:\\s+את(?=\\s))?\\s*[:：\\-–—]?\\s*`, 'u');
const FIRST_PERSON_BARE_RE = /^(?:אני|עלי)\s*[:：\-–—]\s*/u;
const NAME_VERB_RE = new RegExp(`^(?:מביא|מביאה|מביאים|לוקח|לוקחת|לוקחים|קונה|קונים|יביא|תביא|יביאו|יקח|ייקח|תיקח|תקח|יקנה|תקנה|אחראי|אחראית|דואג|דואגת|על)${SLASH_SUFFIX}(?=$|[^\\p{L}])(?:\\s+את(?=\\s))?\\s*[:：\\-–—]?\\s*`, 'u');
const WHO_VERB_TAIL_RE = new RegExp(`\\s+(?:מביא|מביאה|מביאים|לוקח|לוקחת|לוקחים|קונה|קונים|יביא|תביא|יקח|ייקח|תיקח|יקנה|תקנה|אחראי|אחראית|דואג|דואגת)${SLASH_SUFFIX}$`, 'u');
const ME_RE = /^(?:אני|עליי|עלי|אנחנו|עלינו)$/u;

// "צריך: פחמים, מצתים" / "לקנות: ..." — an intro before a comma list, not an item
const LIST_INTRO_RE = /^(?:מה\s+)?(?:עוד\s+)?(?:(?:צריך|צריכים|צריכה|חסר|חסרים|חסרה)(?:\s+(?:לקנות|להביא|לקחת|לארוז))?|לקנות|להביא|לקחת|לארוז|קונים|מביאים|לוקחים|אורזים|קניות|רשימת\s+קניות|גם|shopping|to\s+buy|to\s+bring|need|buy|bring)$/iu;
const introType = (head) => (/להביא|מביאים|לקחת|לוקחים|לארוז|אורזים|bring/iu.test(head) ? 'bring' : /לקנות|קונים|קניות|shopping|buy/iu.test(head) ? 'buy' : null);

/** Name lookup for "who takes it": exact (normalised) or a unique first-name match → the caller's exact string. */
function nameIndex(names) {
  const exact = new Map();
  const first = new Map();
  for (const n of list(names)) {
    const s = String(n ?? '').trim();
    const k = normKey(s);
    if (!k) continue;
    if (!exact.has(k)) exact.set(k, s);
    const f = k.split(' ')[0];
    first.set(f, first.has(f) && first.get(f) !== s ? null : s); // two people share the first name → ambiguous
  }
  return (text) => {
    const k = normKey(text);
    return (k && (exact.get(k) || first.get(k))) || null;
  };
}

/** The person a text fragment names ('__me__' / sender for "אני"), or undefined when it isn't a person. */
function whoOf(text, ctx) {
  const t = cleanTitle(text).replace(WHO_VERB_TAIL_RE, '').trim();
  if (!t || t.length > 40) return undefined;
  if (ME_RE.test(t)) return ctx.me;
  return ctx.lookup(t) || undefined;
}

/** "אני מביא X" / "עליי: X" / "הדס - X" / "הדס מביאה X" at the start of a line → {who, rest}. */
function whoLead(body, ctx) {
  const fp = FIRST_PERSON_RE.exec(body) || FIRST_PERSON_BARE_RE.exec(body);
  if (fp) {
    const rest = body.slice(fp[0].length).trim();
    if (!rest && /^אנחנו/u.test(body)) return null; // "אנחנו מביאים:" is a section line
    if (!rest && !/[:：\-–—]\s*$/u.test(fp[0]) && !/\s/u.test(fp[0].trim())) return null; // a bare "אביא" is not a block
    return { who: ctx.me, rest };
  }
  if (!ctx.hasNames) return null;
  const words = body.split(' ');
  for (let k = Math.min(3, words.length); k >= 1; k--) {
    let cand = words.slice(0, k).join(' ');
    let rest = words.slice(k).join(' ');
    let sep = false;
    const tail = /[:：\-–—]+$/u.exec(cand);
    if (tail) {
      cand = cand.slice(0, tail.index);
      sep = true;
    }
    const who = ctx.lookup(cand);
    if (!who) continue;
    if (!sep) {
      const m = /^[:：\-–—]\s*/u.exec(rest) || NAME_VERB_RE.exec(rest);
      if (m) {
        rest = rest.slice(m[0].length);
        sep = true;
      }
    }
    if (sep) return { who, rest: rest.trim() }; // a bare "תמר" / "ים" line is an item, "תמר:" opens a block
  }
  return null;
}

/** Splits "a, b, c" (and with `vav` also "a ומחצלת") into parts; separators inside (...) and "1,000" are kept. */
function splitParts(text, vav) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (!depth && (ch === ',' || ch === '،' || ch === ';') && !(/\d/.test(text[k - 1] || '') && /\d/.test(text[k + 1] || ''))) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  const out = [];
  const VAV_RE = /\s+ו-?(?=[^\sו\-])/u;
  parts.forEach((p, k) => {
    // "צידנית ומחצלת" / "ו-3 מצתים"; not "וודקה" (double vav) and not inside parentheses.
    // In a plain comma list only the last "X ו-Y" of two single words splits ("מלפפונים ובצל", not "מתוקה וחריפה").
    const lastPair = k > 0 && k === parts.length - 1 && /^\S+\s+ו-?[^\sו-]\S*$/u.test(p.trim());
    const pieces = (vav || lastPair) && !p.includes('(') ? p.split(VAV_RE) : [p];
    for (const x of pieces) if (x.trim()) out.push(x.trim());
  });
  return out;
}

/** Parses each part as its own item line; null unless every part is an item. */
function partTokens(parts, raw, ctx, extra) {
  const tokens = [];
  for (const p of parts) {
    const t = parseItemLine(p, raw, ctx);
    if (t.kind !== 'item') return null;
    if (t.who === undefined && extra.who !== undefined) t.who = extra.who;
    if (!t.askType && extra.type) t.askType = extra.type;
    if (extra.header) t.ownHeader = extra.header;
    tokens.push(t);
  }
  return tokens.length ? tokens : null;
}

function tidy(s) {
  return String(s ?? '')
    .replace(/\s+([?!.,:;])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(s) {
  let t = String(s ?? '').replace(/\s+/g, ' ');
  t = t.replace(/^[\s\-–—:;,.·|]+|[\s\-–—:;,.·|]+$/gu, '');
  t = t.replace(/^של\s+/u, '');
  t = t.replace(LEADING_EMOJI_RE, '').replace(TRAILING_EMOJI_RE, '');
  t = t.replace(/^[\s\-–—:;,.·|]+|[\s\-–—:;,.·|]+$/gu, '');
  return t.trim().slice(0, 120);
}

function joinNotes(parts) {
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const t = tidy(p).replace(/^[-–—:;,.·\s]+|[-–—:;,·\s]+$/gu, '');
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.length ? out.join(' · ').slice(0, 500) : null;
}

const NUM_WORD_RE = new RegExp(`^${NUM}\\s+\\p{L}[\\p{L}׳'"]*$`, 'u'); // "2 ארגזים" as a side segment

/** Parses one list line into an item token (or a note / skip token). */
function parseItemLine(body, raw, ctx) {
  let s = body;
  const notes = []; // {i, text}
  let askType = null;
  let who; // undefined = the line doesn't say

  // "יש למישהו רמקול?" → item "רמקול" with the question as a note
  const ask = ASK_RE.exec(s);
  if (ask) {
    let rest = ask[2].replace(/[?？!]+/g, ' ').trim();
    for (let k = 0; k < 3; k++) rest = rest.replace(ASK_TAIL_RE, '').trim();
    rest = rest.replace(/^(?:את|איזה|אולי)\s+/u, '');
    const question = tidy(s);
    if (ASK_WHAT_RE.test(rest)) return { kind: 'skip' }; // "מי מביא מה?"
    if (!rest || !/\p{L}/u.test(rest)) return { kind: 'note', text: question };
    notes.push({ i: -1, text: question });
    askType = /קונה|יקנה|לקנות/u.test(ask[1]) ? 'buy' : 'bring';
    s = rest;
  }

  // parentheses → notes, or the taker when they hold a name: "צידנית (עידו)" (keep string length so indices stay aligned);
  // a bare number is how many: "מתאם לשקע (3)"
  let parenQty = null;
  s = s.replace(/\(([^()]*)(?:\)|$)/g, (m, inner, off) => {
    const w = whoOf(inner, ctx);
    if (w !== undefined) {
      if (who === undefined) who = w;
    } else if (parenQty === null && /^\s*[x×]?\s*\d{1,3}\s*$/u.test(inner)) parenQty = { n: Number(inner.replace(/[^\d]/g, '')), i: off };
    else notes.push({ i: off, text: inner });
    return ' '.repeat(m.length);
  });

  // "כיפות ל-10" / "בירות ל-20 איש": for how many people — a note, not "20 of them"
  s = s.replace(/(^|\s)ל-?\s?(\d{1,3})(\s+(?:איש|אנשים|סועדים|נפשות|ילדים|מבוגרים|חבר['׳’]?ה))?(?=\s*$)/u, (m, pre, n, word, off) => {
    notes.push({ i: off, text: `ל-${n}${word ? ` ${word.trim()}` : ''}` });
    return ' '.repeat(m.length);
  });

  // ranges "2-3 חבילות" → qty 3 + note
  s = s.replace(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)(?=\s|$)/g, (m, lo, hi, off) => {
    notes.push({ i: off, text: `${lo}–${hi}` });
    return hi.padEnd(m.length, ' ');
  });

  let perPerson = false;
  s = s.replace(PER_PERSON_RE, (m, pre, marker) => {
    perPerson = true;
    return pre + ' '.repeat(marker.length);
  });

  let each = null; // 'total' ("4 סכינים - כל זוג": the number counts units) | 'unit' ("לכל זוג 2") | 'pp?'
  let eachAt = -1;
  s = s.replace(EACH_RE, (m, pre, marker, off) => {
    if (each === null) {
      each = /^לכל\s+(?:אחד|אחת)/u.test(marker) ? 'pp?' : /^(?:ל|פר\s)/u.test(marker) ? 'unit' : 'total';
      eachAt = off + pre.length;
    }
    return pre + ' '.repeat(marker.length);
  });

  // split into segments on separators: dashes with a space/digit next to them, en/em dash, colon, pipe
  const segs = [];
  let start = 0;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    let cut = false;
    if (ch === '–' || ch === '—' || ch === '|') cut = true;
    else if (ch === ':') cut = !(/\d/.test(s[k - 1] || '') && /\d/.test(s[k + 1] || ''));
    else if (ch === '-' || ch === '‐' || ch === '−') {
      const prev = s[k - 1] || '';
      const next = s[k + 1] || '';
      cut = !prev || !next || /[\s\d]/.test(prev) || /[\s\d]/.test(next) || UNIT_START_RE.test(s.slice(k + 1));
    }
    if (cut) {
      segs.push({ text: s.slice(start, k), i: start });
      start = k + 1;
    }
  }
  segs.push({ text: s.slice(start), i: start });

  let qty = null;
  let unit = null;
  let qtyAt = -1;
  let titleSeg = null;
  const sideSegs = []; // non-title segments, a fallback source for "2 ארגזים"-style quantities
  const lone = segs.filter((x) => x.text.trim()).length === 1; // "תמר" alone is dates, not a taker
  for (const seg of segs) {
    const t = seg.text.trim();
    if (!t) continue;
    const at = seg.i + seg.text.indexOf(t);
    const w = lone && !ME_RE.test(cleanTitle(t)) ? undefined : whoOf(t, ctx); // "הדס - פחמים" / "פחמים - אני"
    if (w !== undefined) {
      if (who === undefined) who = w;
      continue;
    }
    const q = qtyOnly(t);
    if (q && q.qty !== null) {
      if (qty === null) {
        ({ qty, unit } = q);
        qtyAt = at;
        if (q.note) notes.push({ i: at, text: q.note });
      } else notes.push({ i: at, text: t });
      continue;
    }
    if (!titleSeg) titleSeg = { text: t, i: at };
    else {
      notes.push({ i: at, text: t });
      sideSegs.push({ text: t, i: at });
    }
  }
  if (!titleSeg) return { kind: 'skip' };

  // "גם עוגה" / "ועוד קרח": the filler isn't part of the name
  let titleText = titleSeg.text.replace(/^(?:וגם|גם|ועוד)\s+(?=\S)/u, '').replace(LEADING_VERB_RE, '');
  if (qty === null) {
    const q = leadingQty(titleText) || trailingQty(titleText);
    if (q && q.qty !== null) {
      ({ qty, unit } = q);
      qtyAt = titleSeg.i + q.at;
      titleText = q.rest;
      if (q.note) notes.push({ i: titleSeg.i + q.at, text: q.note });
    }
  }
  if (qty === null) {
    // "בירות - 2 ארגזים" with an unknown unit word: the number is the quantity, the words stay in the note
    const side = sideSegs.find((x) => NUM_WORD_RE.test(x.text));
    if (side) {
      qty = parseNumber(NUM_WORD_RE.exec(side.text)[1]);
      qtyAt = side.i;
    }
  }
  if (parenQty) {
    if (qty === null && parenQty.n > 0) {
      qty = parenQty.n;
      qtyAt = parenQty.i;
    } else notes.push({ i: parenQty.i, text: String(parenQty.n) });
  }

  const title = cleanTitle(titleText);
  if (!title || !/\p{L}/u.test(title)) return { kind: 'skip' };
  if (/[?？]\s*$/u.test(title)) return { kind: 'skip' }; // a question, not an item
  if (wordCount(title) > 10) return { kind: 'skip' }; // chat sentence, not a list line

  if (each === 'pp?') {
    // "300 גרם לכל אחד" is a per-person quantity; "לכל אחד" without a number means everyone brings one
    if (qty !== null) {
      perPerson = true;
      each = null;
    } else each = 'total';
  }
  if (each === 'total' && qty !== null && qtyAt >= 0 && qtyAt < eachAt) {
    qty = null; // "4 קרשי חיתוך - כל זוג": 4 is the number of couples, not a per-unit quantity
    unit = null;
  }

  notes.sort((a, b) => a.i - b.i);
  return {
    kind: 'item',
    title,
    qty,
    unit,
    per_person: perPerson,
    note: joinNotes(notes.map((n) => n.text)),
    each: !!each,
    askType,
    who,
    raw,
  };
}

function makeHeader(text, emoji, { colon = false, bold = false, raw = '' } = {}) {
  const name = cleanTitle(text).slice(0, 40);
  const hits = catHits(name, HEADER_MATCHERS);
  const emojiCat = emojiCategory(emoji);
  const candidates = [...hits];
  if (emojiCat && !candidates.includes(emojiCat)) candidates.push(emojiCat);
  const category = candidates.length ? catObj(candidates[0]) : { name, emoji: emoji || '📦' };
  let type = null;
  if (/מהבית|מהבייתה/u.test(name)) type = 'bring';
  else if (/ציוד\s+אישי/u.test(name)) type = 'each';
  else if (candidates[0] === 'gear' || candidates[0] === 'fun') type = 'bring';
  else if (candidates[0] === 'tasks') type = 'task';
  return {
    kind: 'header',
    header: { category, candidates, type },
    // "🍉 אבטיח" lines look like headers; if nothing follows them they are items
    convertible: !!emoji && !colon && !bold && hits.length === 0,
    text,
    emojiCat,
    raw,
  };
}

// words that may sit next to a category keyword in a plain header ("ציוד כללי", "אוכל ושתייה")
const HEADER_FILLERS = new Set(['ו', 'ל', 'של', 'כללי', 'כללית', 'קבוצתי', 'קבוצתית', 'משותף', 'משותפת', 'נוסף', 'נוספים',
  'אוכל', 'מזון', 'דברים', 'and', '&', 'stuff', 'misc', 'list']);
/** A list part that names a known item / category ("פחמים", "גזיבו גדול"); one prefix letter at most ("שלמים" isn't "מים"). */
const KNOWN_RE = new RegExp(wordMatcher([...Object.values(ITEM_WORDS), ...Object.values(HEADER_WORDS)].flat()).source.replace('{0,2}', '?'), 'u');
const known = (p) => KNOWN_RE.test(normKey(p));
const HEADER_ANY_RE = new RegExp(wordMatcher(Object.values(HEADER_WORDS).flat()).source, 'gu');

// words that describe a thing rather than name one — a comma part made only of these is a variant, not an item
const QUALIFIER_WORDS = new Set(('לבן לבנה לבנים לבנות שחור שחורה שחורים אדום אדומה אדומים ירוק ירוקה ירוקים כחול כחולה כחולים צהוב צהובה'
  + ' צהובים כתום כתומה ורוד ורודה סגול סגולה חום חומה אפור אפורה גדול גדולה גדולים גדולות קטן קטנה קטנים קטנות בינוני בינונית'
  + ' ענק ענקית חריף חריפה מתוק מתוקה מלוח מלוחה חמוץ חמוצה יבש יבשה טרי טרייה טריה קפוא קפואה רגיל רגילה דיאט זירו לייט מלא'
  + ' מלאה חצי כפול כפולה חם חמה קר קרה מעושן מעושנת טחון טחונה פרוס פרוסה קלוי קלויה בולגרית צפתית עיזים כבשים דל שומן'
  + ' חד חדה פעמי פעמיים פעמיות ארוך ארוכה קצר קצרה עבה דק דקה רך רכה קשה חדש חדשה ישן ישנה זול זולה טבעי טבעית אורגני'
  + ' אורגנית צמחוני צמחונית טבעוני טבעונית כשר כשרה חלבי חלבית בשרי בשרית פרווה').split(' '));
function isQualifier(part) {
  const words = normKey(part).split(' ').filter(Boolean);
  if (!words.length) return true;
  if (/^(?:עם|בלי|ללא|של|בלי|כולל)$/u.test(words[0])) return true;         // "בלי סוכר", "עם שומשום"
  return words.every((w) => QUALIFIER_WORDS.has(w) || /^\d+%?$/.test(w));
}

/** A plain line like "בשרים" / "Gear" that may be a category header: {token, ambiguous} or null. */
function plainHeaderOf(text, raw) {
  if (!catHits(text, HEADER_MATCHERS).length) return null;
  const pure = !normKey(text).replace(HEADER_ANY_RE, ' ').split(' ').some((w) => w && !HEADER_FILLERS.has(w));
  const ambiguous = catHits(text, ITEM_MATCHERS).length > 0; // "שתייה" / "ירקות" can also be an item
  if (!pure && ambiguous) return null; // "כסאות ישיבה" is an item
  return { token: makeHeader(text, null, { raw }), ambiguous };
}

function sectionTypeOf(text) {
  if (/ציוד\s+אישי/u.test(text)) return 'each';
  if (/מהבית|מהבייתה|ציוד/u.test(text)) return 'bring';
  return 'buy';
}

/** One line → token(s). `state.sender` carries the WhatsApp sender to the message's continuation lines. */
function classifyLine(rawLine, ctx, state, numbered) {
  const raw = stripInvisible(rawLine).trim();
  let s = raw;
  let chatStart = false;
  for (const re of WA_PREFIX_RES) {
    const m = re.exec(s);
    if (m) {
      s = s.slice(m[0].length);
      state.sender = m[1].trim();
      chatStart = true;
      break;
    }
  }
  if (!chatStart && WA_DATE_ONLY_RE.test(s)) return { kind: 'skip', chatStart: true }; // WhatsApp system line
  // in a chat "אני" is the sender (only when they are one of the trip's people)
  const lctx = state.sender !== undefined ? { ...ctx, me: ctx.lookup(state.sender) } : ctx;
  const tok = classifyBody(s, raw, lctx, numbered);
  if (chatStart) tok.chatStart = true;
  return tok;
}

function classifyBody(line, raw, ctx, numbered) {
  let s = line.replace(/\s+/g, ' ').trim();
  if (!s) return { kind: 'blank' };
  if (s.length > 400 || SYSTEM_RE.test(s)) return { kind: 'skip' }; // prose / links, never a list line
  if (numbered) s = s.replace(NUMBERING_RE, '');

  const bold = /^\*[^*]+\*\s*:?$/.test(s);
  let bulleted = numbered;
  let done = false;
  for (let k = 0; k < 4; k++) {
    let m = DONE_RE.exec(s);
    if (m) done = true;
    else m = TODO_RE.exec(s) || BULLET_RE.exec(s);
    if (!m || !m[0]) break;
    s = s.slice(m[0].length);
    bulleted = true;
  }
  if (/^~[^~]+~(?=\s|$)/.test(s)) done = true; // WhatsApp strikethrough = crossed off
  const trailDone = TRAIL_DONE_RE.exec(s);
  if (trailDone && trailDone.index > 0) {
    done = true;
    s = s.slice(0, trailDone.index);
  }
  s = s
    .replace(/[*~]/g, '')
    .replace(/(^|[\s(])_(.+?)_(?=$|[\s).,:!?])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return { kind: 'blank' };
  if (CHATTER_RE.test(s) || isChatter(s) || STAMP_ONLY_RE.test(s)) return { kind: 'skip' };
  // talking, not listing: "חבר'ה מה לוקחים? רשימה ראשונה", "… כבר כתבתי למעלה חחח"; a short line just loses the laugh
  if (VOCATIVE_RE.test(s) && wordCount(s) >= 3) return { kind: 'skip' };
  if (/[?？]\s*[\p{L}\d]/u.test(s) && !ASK_RE.test(s.replace(LEADING_EMOJI_RE, ''))) return { kind: 'skip' };
  LAUGH_RE.lastIndex = 0;
  if (LAUGH_RE.test(s)) {
    LAUGH_RE.lastIndex = 0;
    const calm = s.replace(LAUGH_RE, ' ').replace(/\s+/g, ' ').trim();
    if (wordCount(calm) >= 4) return { kind: 'skip' };
    s = calm;
    if (!s) return { kind: 'skip' };
  }

  const lead = LEADING_EMOJI_RE.exec(s);
  const emoji = lead ? FIRST_EMOJI_RE.exec(s)[0] : null;
  const body = lead ? s.slice(lead[0].length).trim() : s;
  if (!body.replace(ANY_EMOJI_RE, '').trim()) return { kind: 'skip' }; // emoji-only line
  const emojiCat = emojiCategory(emoji);
  const multi = (tokens) => {
    for (const t of tokens) Object.assign(t, { emojiCat, emojiLed: !!emoji, done });
    return { kind: 'multi', tokens };
  };

  // "גיל: אני מביא בירות" / "סבא משה: אני אביא את המטריות" — someone answering in their own name: what they say
  // they bring is theirs (when we know who they are), and never the title
  const said = /^([^:：,()\d]{1,30})[:：]\s*(\S.*)$/u.exec(body);
  if (said && (FIRST_PERSON_RE.test(said[2]) || FIRST_PERSON_BARE_RE.test(said[2]))) {
    // the whole name, else one of its words ("סבא משה" → משה): a word that is a person's own name wins over a
    // word that only starts a longer name
    let me = ctx.lookup(said[1]) || undefined;
    if (me === undefined) {
      const hits = said[1].trim().split(/\s+/).map((w) => ({ w: normKey(w), v: ctx.lookup(w) })).filter((x) => x.v);
      const uniq = (xs) => xs.map((x) => x.v).filter((v, i, all) => all.indexOf(v) === i);
      const own = uniq(hits.filter((x) => normKey(x.v) === x.w));
      const any = uniq(hits);
      me = own.length === 1 ? own[0] : any.length === 1 ? any[0] : undefined;
    }
    const own = whoLead(said[2], { ...ctx, me });
    if (own && own.rest) {
      const parts = partTokens(splitParts(own.rest.replace(/[:：]\s*$/, ''), true), raw, ctx, { who: me });
      if (parts) return multi(parts);
    }
  }

  // Who takes it: "אני מביא צידנית ומחצלת", "הדס: פחמים, מלח", "הדס:" (a person block)
  const wl = whoLead(body, ctx);
  if (wl) {
    if (!wl.rest || /^[:：]$/.test(wl.rest)) return { kind: 'person', who: wl.who };
    const parts = partTokens(splitParts(wl.rest.replace(/[:：]\s*$/, ''), true), raw, ctx, { who: wl.who });
    if (parts) return multi(parts);
  }

  const endsColon = /[:：]\s*$/.test(body);
  const bodyNoColon = body.replace(/[:：]\s*$/, '').trim();
  const hasDigit = /\d/.test(body);

  // Comma lists: "צריך: פחמים, מצתים", "בשרים: אנטריקוט, פרגיות", "פחמים, מצתים, מלח"
  const intro = /^([^:：,()]{1,40})[:：]\s*(\S.*)$/u.exec(body);
  if (intro) {
    const head = intro[1].trim();
    const ph = LIST_INTRO_RE.test(head) ? null : plainHeaderOf(head, raw);
    if (LIST_INTRO_RE.test(head) || (ph && !ph.ambiguous) || (ph && wordCount(head) === 1)) {
      const split = splitParts(intro[2], false);
      // "מנגל: גדול" / "לחם: 4 כיכרות" is one item with a note; "בשרים: אנטריקוט, פרגיות" is a list
      const list_ = !ph || split.length >= 2 || split.every(known);
      const parts = list_ && partTokens(split, raw, ctx, { type: introType(head), header: ph ? ph.token.header : null });
      if (parts) return multi(parts);
    }
  } else if ((body.match(/[,،;]/g) || []).length >= 2 && !/[:：|–—?？]|(?:^|\s)-|-(?:\s|$)/u.test(body)
    && !(lead && catHits(body, HEADER_MATCHERS).length)) { // "🥗 ירקות, פירות, סלטים" is a header
    const parts = splitParts(body, false);
    if (parts.length >= 3 && parts.every((p) => wordCount(p) <= 4 && !CHATTER_RE.test(p))) {
      // "גבינות, צהובה, לבנה" is one item with its variants: a known thing first, then words we don't know — or
      // words that only describe ("אדומה", "גדול", "בלי סוכר"). Otherwise a comma list is a list, also of things
      // nobody taught us ("אלוורה, קרם הגנה, מטען").
      const knownAt = parts.map(known);
      const nKnown = knownAt.filter(Boolean).length;
      const variants = nKnown === 1 ? knownAt[0] : nKnown === 0 && parts.slice(1).some(isQualifier);
      const tokens = !variants && partTokens(parts, raw, ctx, {});
      if (tokens) return multi(tokens);
      const first = parseItemLine(parts[0], raw, ctx);
      if (first.kind === 'item') {
        first.note = joinNotes([first.note || '', parts.slice(1).join(', ')]);
        Object.assign(first, { emojiCat, emojiLed: !!emoji, done });
        return first;
      }
    }
  }

  // "רשימה 1: קניות בסופר" / "רשימה 2:" — list separators, not categories
  const listHdr = /^רשימ[הת](?=$|[\s:.\-–—\d])\s*(?:מס(?:פר|['׳])?\.?\s*)?\d*\s*[:.\-–—]?\s*(.*)$/u.exec(body);
  if (listHdr && body.length <= 60 && !/\d/.test(listHdr[1])) return { kind: 'section', type: sectionTypeOf(listHdr[1]) };

  // Section lines switch the item type and reset the category ("חלוקה של כל אחד מהבית", "מה צריך לקנות:").
  // An emoji in front ("*👗 כל אחת מביאה*", "🏠 מהבית:") is still a section — WhatsApp groups love those.
  if (!hasDigit && !bulleted && wordCount(bodyNoColon) <= 6) {
    const introLine = endsColon || bold;
    if (/^(?:ציוד\s+אישי|כל\s+(?:אחד|אחת|זוג|משפחה)\s+(?:מביא|מביאה|מביאים|צריך|צריכה|צריכים|לוקח|לוקחים))$/u.test(bodyNoColon)) {
      return { kind: 'section', type: 'each' };
    }
    const fromHome = /מהבית|מהבייתה|מהבתים/u.test(body)
      && (introLine || /^(?:חלוק|ציוד|דברים|מה\s|להביא|מביאים|כל\s+(?:אחד|אחת|זוג)|רשימ)/u.test(bodyNoColon));
    if (fromHome || (introLine && /(?:^|\s)(?:להביא|מביאים)(?=\s|$)/u.test(bodyNoColon))
      || /^(?:to\s+bring|things\s+to\s+bring|bring)$/iu.test(bodyNoColon)) {
      return { kind: 'section', type: /אישי/u.test(body) ? 'each' : 'bring' };
    }
    if (!lead && (/^(?:רשימת\s+)?(?:קניות|לקנות|מה\s+לקנות|מה\s+קונים|קנייה|קניה|סופר)(?=\s|$)/u.test(bodyNoColon) && wordCount(bodyNoColon) <= 4)
      || (introLine && /(?:^|\s)(?:קניות|לקנות|לסופר|בסופר|קונים)(?=\s|$)/u.test(bodyNoColon))
      || /^(?:shopping(?:\s+list)?|groceries|to\s+buy)$/iu.test(bodyNoColon)) {
      return { kind: 'section', type: 'buy' };
    }
  }

  // a list's title is never an item: "מה כל אחד מביא 👇", "🍻 סופ״ש ת״א – מי מביא מה", "רשימה לסופ״ש 👇"
  const pointed = POINT_DOWN_RE.test(bodyNoColon);
  const plainTitle = bodyNoColon.replace(POINT_DOWN_RE, '').replace(TRAILING_EMOJI_RE, '').replace(/[:：?？!.\s]+$/u, '').trim();
  const lastPart = plainTitle.split(/\s+[-–—|]\s+/u).pop().trim();
  if (!bulleted && !hasDigit && wordCount(plainTitle) <= 8
      && (LIST_TITLE_RE.test(plainTitle) || LIST_TITLE_RE.test(lastPart) || (pointed && !catHits(plainTitle, ITEM_MATCHERS).length))) {
    return { kind: 'section', type: null };
  }

  const headerish = !hasDigit && !/[()?？]/.test(body) && !bulleted;
  const hdr = (h) => Object.assign(h, { done, ctx });
  if (lead && headerish && wordCount(bodyNoColon) <= 6) return hdr(makeHeader(bodyNoColon, emoji, { colon: endsColon, raw }));
  if (headerish && endsColon && wordCount(bodyNoColon) <= 5) return hdr(makeHeader(bodyNoColon, null, { colon: true, raw }));
  if (headerish && bold && wordCount(bodyNoColon) <= 4) return hdr(makeHeader(bodyNoColon, null, { bold: true, raw }));
  const trail = !lead && headerish ? TRAILING_EMOJI_RE.exec(body) : null;
  if (trail && wordCount(body) <= 4) {
    const text = body.slice(0, trail.index).replace(/[:：]\s*$/, '').trim();
    if (catHits(text, HEADER_MATCHERS).length) return hdr(makeHeader(text, trail[0].trim(), { colon: true, raw }));
  }

  if (/^\([^()]*\)?$/.test(body)) return { kind: 'note', text: tidy(body.replace(/^\(|\)$/g, '')) };
  const token = parseItemLine(body, raw, ctx);
  if (token.kind === 'item') {
    Object.assign(token, { emojiCat, emojiLed: !!emoji, done });
    // "בשרים" / "Gear" on its own line: a header when an item line follows (decided in parseListText)
    if (headerish && !lead && !done && token.who === undefined && wordCount(body) <= 3 && !/[,،:：]/.test(body)) {
      const ph = plainHeaderOf(body, raw);
      if (ph) {
        token.plainHeader = ph.token;
        token.ambiguous = ph.ambiguous;
      }
    }
  }
  return token;
}

/** Marks "3- x" / "4 - x" lines whose neighbour carries the adjacent number (a numbered list, not quantities). */
function numberedLines(lines) {
  const nums = lines.map((l) => {
    const m = NUMBERING_RE.exec(stripInvisible(l).trim());
    return m ? Number(m[1]) : null;
  });
  const filled = lines.map((l) => stripInvisible(l).trim() !== '');
  const out = new Array(lines.length).fill(false);
  let prev = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!filled[i]) continue;
    if (prev >= 0 && nums[i] !== null && nums[prev] !== null && nums[i] === nums[prev] + 1) {
      out[i] = true;
      out[prev] = true;
    }
    prev = i;
  }
  return out;
}

/**
 * Free text / WhatsApp list → items. `opts.names`: the trip's people's names; a line that names one of them
 * (or says "אני"/"עליי") fills `who` (the exact name, or '__me__' for the writer). `done` marks ✅ / [x] / ~struck~ lines.
 */
export function parseListText(text, opts = {}) {
  const names = list(opts?.names);
  const ctx = { lookup: nameIndex(names), hasNames: names.length > 0, me: '__me__' };
  const lines = String(text ?? '').split(/\r\n|\r|\n|\u2028|\u2029/);
  const numbered = numberedLines(lines);
  const state = {};
  const tokens = [];
  lines.forEach((line, i) => {
    const t = classifyLine(line, ctx, state, numbered[i]);
    if (t.kind === 'multi') {
      for (const x of t.tokens) tokens.push(t.chatStart ? { ...x, chatStart: true } : x);
    } else tokens.push(t);
  });

  // does a line start a block (first line, or after a blank / header / section line)? Not inside a person block.
  let prevKind = 'blank';
  let prevItem = null;
  let prevHeader = null;
  let inPerson = false;
  for (const t of tokens) {
    if (t.chatStart && t.kind !== 'person') inPerson = false;
    t.afterBreak = prevKind === 'blank' || prevKind === 'header' || prevKind === 'section';
    // right under "🥩 בשרים", a word of the same category ("עוף") is its first item, not another header
    t.underHeader = prevKind === 'header' && prevHeader ? prevHeader.header?.candidates || [] : [];
    if (t.kind === 'header') prevHeader = t;
    t.prevHits = !inPerson && prevKind === 'item' ? catHits(prevItem.title, ITEM_MATCHERS) : [];
    if (t.kind === 'person') inPerson = true;
    else if (t.kind === 'blank' || t.kind === 'section') inPerson = false;
    if (t.kind === 'item') prevItem = t;
    if (t.kind !== 'skip' && t.kind !== 'note') prevKind = t.kind === 'blank' ? 'blank' : t.kind;
  }

  // Backward pass: an emoji "header" that isn't followed by a plain item line is really an item
  // ("🍉 אבטיח\n🍋 לימון" is a list of two items, "🏊 בריכה\nמצופים" is a header + item);
  // a plain "בשרים" / "שתייה" line is a header only when an item follows (and, for words that are also
  // items, when that item fits the category or the line opens a block).
  let next = null;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.kind === 'blank' || t.kind === 'skip' || t.kind === 'note') continue;
    if (t.kind === 'header' && t.convertible && !(next && next.kind === 'item' && !next.emojiLed)) {
      const item = parseItemLine(t.text, t.raw, t.ctx);
      if (item.kind === 'item') {
        tokens[i] = { ...item, emojiCat: t.emojiCat, emojiLed: true, done: t.done };
        next = tokens[i];
        continue;
      }
    }
    if (t.kind === 'item' && t.plainHeader && next && next.kind === 'item') {
      const nextHits = catHits(next.title, ITEM_MATCHERS);
      // a word that is also an item ("מנגל", "לחם") is a header only when it opens a block, or mid-run when the
      // list clearly switches to its category ("מלפפון / שתייה / קולה"; not "קולה / שתייה / בירה", not in a person block)
      const cands = t.plainHeader.header.candidates;
      const fits = cands.some((c) => nextHits.includes(c));
      const switches = t.prevHits.length > 0 && !t.prevHits.some((c) => cands.includes(c));
      const sameAsAbove = t.ambiguous && t.underHeader.some((c) => cands.includes(c));
      if (!sameAsAbove && (!t.ambiguous || (t.afterBreak && (fits || !nextHits.length)) || (fits && switches))) {
        tokens[i] = t.plainHeader;
        next = tokens[i];
        continue;
      }
    }
    next = t;
  }

  const out = [];
  let section = null;
  let header = null;
  let person; // from a "הדס:" / "אני מביא:" line, until a blank line, a section or the next chat message
  let adjacent = null; // the item a following "(note)" line belongs to
  let broke = true; // a blank line (or the start) since the last line: a new person block starts clean
  for (const t of tokens) {
    if (t.chatStart && t.kind !== 'person') person = undefined;
    if (t.kind === 'blank' || t.kind === 'skip') {
      adjacent = null;
      if (t.kind === 'blank') {
        person = undefined;
        broke = true;
      }
      continue;
    }
    const opensBlock = broke;
    broke = false;
    if (t.kind === 'person') {
      person = t.who;
      if (opensBlock) header = null; // the category above doesn't leak into the next person's items
      adjacent = null;
    } else if (t.kind === 'section') {
      section = t.type;
      header = null;
      person = undefined;
      adjacent = null;
    } else if (t.kind === 'header') {
      header = t.header;
      if (section === 'each') section = null; // "everyone brings" lists end at the next topic
      adjacent = null; // a header inside a person block keeps the block's who
    } else if (t.kind === 'note') {
      if (adjacent) adjacent.note = joinNotes([adjacent.note || '', t.text]);
    } else if (t.kind === 'item') {
      const hdr = t.ownHeader || header;
      let categoryKey = null;
      let category = null;
      const hits = catHits(t.title, ITEM_MATCHERS);
      if (hdr) {
        category = { ...hdr.category };
        categoryKey = hdr.candidates[0] || null;
        const [primary, ...others] = hdr.candidates;
        if (others.length && !hits.includes(primary)) {
          const alt = others.find((c) => hits.includes(c));
          if (alt) {
            category = catObj(alt);
            categoryKey = alt;
          }
        }
      } else {
        categoryKey = hits[0] || t.emojiCat || null;
        category = categoryKey ? catObj(categoryKey) : null;
      }
      let type = t.each ? 'each' : t.askType || hdr?.type || section || null;
      if (!type) type = categoryKey === 'gear' || categoryKey === 'fun' ? 'bring' : categoryKey === 'tasks' ? 'task' : 'buy';
      const who = t.who !== undefined ? t.who : person;
      const item = {
        category,
        title: t.title,
        qty: t.qty,
        unit: t.unit,
        per_person: t.per_person,
        note: t.note,
        type,
        raw: t.raw,
        who: who ?? null,
        done: !!t.done,
      };
      out.push(item);
      adjacent = item;
    }
  }
  return out;
}

// ───────────────────────── dates & counts ─────────────────────────

export function countdown(startsAt, now = new Date(), endsAt = null) {
  const start = toDate(startsAt);
  const at = toDate(now) || new Date();
  if (!start) return { days: 0, hours: 0, minutes: 0, past: false, label: '' };
  const diff = start.getTime() - at.getTime();
  const abs = Math.abs(diff);
  const days = Math.floor(abs / DAY_MS);
  const hours = Math.floor((abs % DAY_MS) / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  if (diff > 0) {
    const dd = dayIndex(start) - dayIndex(at);
    const label = dd <= 0 ? 'היום!' : dd === 1 ? 'מחר!' : dd === 2 ? 'בעוד יומיים' : `בעוד ${dd} ימים`;
    return { days, hours, minutes, past: false, label };
  }
  // without an end time, assume the trip lasts a day
  const end = toDate(endsAt) || new Date(start.getTime() + DAY_MS);
  return { days, hours, minutes, past: true, label: at < end ? 'עכשיו בטיול 🔥' : 'הטיול הסתיים' };
}

export function formatDate(iso, opts) {
  const d = toDate(iso);
  if (!d) return '';
  return dtf(opts || { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

export function formatTime(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

export function formatDateTime(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return `${formatDate(d, { weekday: 'short', day: 'numeric', month: 'short' })} · ${formatTime(d)}`;
}

export function timeAgo(iso, now = new Date()) {
  const d = toDate(iso);
  if (!d) return '';
  const at = toDate(now) || new Date();
  const sec = Math.floor((at.getTime() - d.getTime()) / 1000);
  if (sec < 45) return 'עכשיו';
  if (sec < 90) return 'לפני דקה';
  const min = Math.floor(sec / 60);
  if (min < 60) return `לפני ${min} דק׳`;
  const h = Math.floor(min / 60);
  if (h < 24) return h === 1 ? 'לפני שעה' : h === 2 ? 'לפני שעתיים' : `לפני ${h} שעות`;
  const dd = dayIndex(at) - dayIndex(d);
  if (dd <= 1) return 'אתמול';
  if (dd === 2) return 'לפני יומיים';
  if (dd < 7) return `לפני ${dd} ימים`;
  const sameYear = dtf({ year: 'numeric' }).format(d) === dtf({ year: 'numeric' }).format(at);
  return formatDate(d, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function hebrewCount(n, singular, plural) {
  const v = toNum(n) ?? 0;
  return `${formatNumber(v)} ${v === 1 ? singular : plural ?? singular}`;
}

// ───────────────────────── links ─────────────────────────

const baseOf = (baseUrl) => String(baseUrl ?? '').split('#')[0];

export function inviteUrl(baseUrl, code) {
  return `${baseOf(baseUrl)}#/join/${encodeURIComponent(String(code ?? ''))}`;
}

export function deviceLinkUrl(baseUrl, code) {
  return `${baseOf(baseUrl)}#/link/${encodeURIComponent(String(code ?? ''))}`;
}

export function whatsappShareUrl(text) {
  return `https://wa.me/?text=${encodeURIComponent(String(text ?? ''))}`;
}

/** Normalises a phone number to wa.me digits (Israeli numbers → 972…); null if it isn't a phone. */
function waDigits(phone) {
  const raw = String(phone ?? '').trim();
  if (!raw || /[\p{L}]/u.test(raw.replace(/ext\.?|x/gi, '')) || !/\d/.test(raw)) return null;
  const international = /^\s*(?:\+|00)/.test(raw);
  let d = raw.replace(/\D/g, '');
  if (raw.trim().startsWith('00')) d = d.slice(2);
  if (d.startsWith('972')) {
    let national = d.slice(3);
    if (national.startsWith('0')) national = national.slice(1);
    return /^(?:5\d{8}|[2-489]\d{7}|7\d{8})$/.test(national) ? `972${national}` : null;
  }
  if (international) return d.length >= 8 && d.length <= 15 ? d : null;
  if (/^0(?:5\d{8}|[2-489]\d{7}|7\d{8})$/.test(d)) return `972${d.slice(1)}`;
  if (/^5\d{8}$/.test(d)) return `972${d}`;
  return null;
}

export function whatsappChatUrl(phone, text) {
  const digits = waDigits(phone);
  if (!digits) return null;
  const t = text === undefined || text === null || text === '' ? '' : `?text=${encodeURIComponent(String(text))}`;
  return `https://wa.me/${digits}${t}`;
}

// ───────────────────────── WhatsApp texts ─────────────────────────

function tripTitleLine(trip) {
  return `${trip?.emoji || '⛺'} *${trip?.name || 'הטיול שלנו'}*`;
}
function tripPlainLine(trip) {
  return `${trip?.emoji || '⛺'} ${trip?.name || 'הטיול שלנו'}`;
}

export function buildInviteText(trip, url) {
  const t = trip || {};
  const lines = [tripTitleLine(t)];
  if (t.starts_at) lines.push(`📅 ${formatDate(t.starts_at)} · ${formatTime(t.starts_at)}`);
  if (t.location) lines.push(`📍 ${t.location}`);
  lines.push(
    '',
    'כל הרשימות, מי מביא מה וההתחשבנות — מעכשיו במקום אחד 🔥',
    'נכנסים מהקישור, בוחרים פרופיל ומסמנים מה מביאים ✋',
  );
  if (url) lines.push('', `👈 ${url}`);
  return lines.join('\n');
}

function needLine(item, snap, members, byItem) {
  const p = itemProgress(item, byItem.get(item.id) || [], members);
  let detail = '';
  if (item.type === 'bring') {
    if (p.needed > 1) detail = p.pledged > 0 ? `חסרים ${p.needed - p.pledged} מתוך ${p.needed}` : `צריך ${p.needed}`;
  } else if (item.type === 'each') {
    detail = `כל אחד מביא (${p.doneCount}/${p.total})`;
  } else {
    detail = itemEffectiveQty(item, headcountTotal(members)).text;
  }
  return `• ${item.title}${detail ? ` — ${detail}` : ''}`;
}

/** After the trip: a wrap-up for the group — thanks, the trip in numbers, who still pays whom, the album. */
function summaryAfter(snap) {
  const trip = snap?.trip || {};
  const on = (key) => trip.settings?.modules?.[key] !== false;
  const stats = tripStats(snap);
  const lines = [`${trip.emoji || '⛺'} *${trip.name || 'הטיול'} — תודה לכולם!* 🙏`];
  if (trip.location) lines.push(`📍 ${trip.location}`);
  lines.push('', '*הטיול במספרים:*', `👥 ${hebrewCount(stats.people, 'משתתף', 'משתתפים')}`);
  if (on('lists') || on('tasks')) lines.push(`📋 ${hebrewCount(stats.items, 'פריט', 'פריטים')} ברשימה`);
  if (stats.rides) lines.push(`🚗 ${hebrewCount(stats.rides, 'רכב', 'רכבים')}`);
  if (on('money') && stats.spent > 0) {
    lines.push(`💸 ${formatMoney(stats.spent)} סה״כ · ${formatMoney(stats.perPerson)} לאדם`);
    const plan = settlePlan(partyBalances(snap));
    lines.push('');
    if (!plan.length) lines.push('🎉 כולם מאוזנים — אין צורך בהעברות');
    else {
      lines.push('*מי עוד מעביר למי:*');
      for (const p of plan) lines.push(`• ${partyName(snap, p.from)} ← ${partyName(snap, p.to)} ${formatMoney(p.amount)}`);
      lines.push('', 'אחרי ההעברה מסמנים ״שילמתי״ במדורה ✅');
    }
  }
  const album = trip.info?.album_url;
  if (album) lines.push('', `📸 האלבום: ${album}`);
  lines.push('', 'נתראה בטיול הבא 🔥');
  return lines.join('\n');
}

function summaryStatus(snap) {
  const trip = snap?.trip || {};
  // after the trip, readiness and "what's missing" are history — send the wrap-up instead
  if (trip.starts_at && ['after', 'past'].includes(tripPhase(trip))) return summaryAfter(snap);
  const members = list(snap?.members);
  const byItem = groupPledges(snap);
  const lines = [tripTitleLine(trip)];
  if (trip.starts_at) {
    const when = `📅 ${formatDate(trip.starts_at)} · ${formatTime(trip.starts_at)}`;
    const cd = countdown(trip.starts_at, new Date(), trip.ends_at).label;
    lines.push(cd ? `${when} (${cd})` : when);
  }
  if (trip.location) lines.push(`📍 ${trip.location}`);

  // features that are off stay out of the message (settings.modules; missing = on)
  const on = (key) => trip.settings?.modules?.[key] !== false;
  if (on('lists') || on('tasks')) {
    const r = tripReadiness(snap);
    lines.push('', `📊 *מוכנות: ${r.pct}%*`, `✅ מכוסים: ${r.covered} מתוך ${r.total}`);
    if (r.missing || r.partial) lines.push(`🙋 חסרים: ${r.missing}${r.partial ? ` · 🟡 חלקיים: ${r.partial}` : ''}`);
    if (r.proposed) lines.push(`⏳ ממתינים לאישור: ${r.proposed}`);

    const missing = missingItems(snap);
    if (missing.length) {
      lines.push('', '*עדיין חסר:*');
      for (const item of missing.slice(0, 8)) lines.push(needLine(item, snap, members, byItem));
      if (missing.length > 8) lines.push(`…ועוד ${missing.length - 8}`);
    } else if (r.total) {
      lines.push('', '🎉 הכל מכוסה!');
    }
  }

  if (on('money')) {
    const totals = tripTotals(snap);
    lines.push('', '💸 *כסף*');
    if (totals.spent > 0) {
      lines.push(`הוצאות עד עכשיו: ${formatMoney(totals.spent)}`);
      lines.push(`לאדם: ${formatMoney(totals.perHead)} (${hebrewCount(totals.heads, 'איש', 'אנשים')})`);
    } else {
      lines.push('עוד לא נרשמו הוצאות');
    }
  }
  lines.push('', 'כל הפרטים במדורה 🔥');
  return lines.join('\n');
}

function summaryMissing(snap) {
  const trip = snap?.trip || {};
  const members = list(snap?.members);
  const byItem = groupPledges(snap);
  const missing = missingItems(snap);
  if (!missing.length) {
    return ['🎉 *הכל מכוסה!*', tripPlainLine(trip), '', 'אין מה להוסיף — כל הכבוד לכולם 🔥'].join('\n');
  }
  const cats = new Map(list(snap?.categories).map((c) => [c.id, c]));
  const lines = ['🙋 *מה עוד חסר?*', tripPlainLine(trip)];
  let currentCat;
  for (const item of missing) {
    const catId = cats.has(item.category_id) ? item.category_id : null;
    if (catId !== currentCat) {
      currentCat = catId;
      const c = cats.get(catId);
      lines.push('', c ? `${c.emoji || '📦'} *${c.name}*` : '📦 *שונות*');
    }
    lines.push(needLine(item, snap, members, byItem));
  }
  lines.push('', `סה״כ: ${hebrewCount(missing.length, 'פריט', 'פריטים')}`, 'מי לוקח? ✋');
  return lines.join('\n');
}

function summaryMine(snap, memberId) {
  const trip = snap?.trip || {};
  const me = memberId ?? snap?.me?.member_id;
  const member = list(snap?.members).find((m) => m && m.id === me);
  const heads = headcountTotal(snap?.members);
  const a = myAgenda(snap, me);
  const box = (done) => (done ? '✅' : '⬜');
  const pending = (item) => (item.status === 'proposed' ? ' ⏳' : '');
  const lines = [`🎒 *הרשימה של ${displayName(member)}*`, tripPlainLine(trip)];
  if (a.bring.length) {
    lines.push('', '🧺 *מביאים מהבית*');
    for (const { item, pledge } of a.bring) {
      lines.push(`${box(pledge.done)} ${item.title}${posInt(pledge.qty, 1) > 1 ? ` ×${posInt(pledge.qty, 1)}` : ''}${pending(item)}`);
    }
  }
  if (a.buy.length) {
    lines.push('', '🛒 *קונים*');
    for (const { item } of a.buy) {
      const q = itemEffectiveQty(item, heads).text;
      lines.push(`${box(item.done)} ${item.title}${q ? ` · ${q}` : ''}${pending(item)}`);
    }
  }
  if (a.tasks.length) {
    lines.push('', '📋 *משימות*');
    for (const { item } of a.tasks) lines.push(`${box(item.done)} ${item.title}${pending(item)}`);
  }
  if (a.each.length) {
    lines.push('', '🙋 *כל אחד מביא*');
    for (const { item, done } of a.each) lines.push(`${box(done)} ${item.title}`);
  }
  if (!a.bring.length && !a.buy.length && !a.tasks.length && !a.each.length) {
    lines.push('', 'עוד לא לקחת שום פריט 🙂', 'אפשר לבחור משהו מ״עדיין חסר״ במדורה ✋');
  } else {
    lines.push('', `💪 מוכנות אישית: ${a.packedPct}%`);
  }
  return lines.join('\n');
}

function summarySettle(snap) {
  const trip = snap?.trip || {};
  const totals = tripTotals(snap);
  const lines = ['💸 *התחשבנות*', tripPlainLine(trip), ''];
  if (!(totals.spent > 0)) {
    lines.push('עוד לא נרשמו הוצאות 🧾');
    return lines.join('\n');
  }
  const plan = settlePlan(partyBalances(snap));
  lines.push(`🧾 סה״כ הוצאות: ${formatMoney(totals.spent)}`);
  lines.push(`👥 לאדם: ${formatMoney(totals.perHead)} (${hebrewCount(totals.heads, 'איש', 'אנשים')})`);
  lines.push('');
  if (!plan.length) {
    lines.push('🎉 כולם מאוזנים — אין צורך בהעברות');
  } else {
    lines.push('*מי מעביר למי:*');
    for (const p of plan) {
      lines.push(`• ${partyName(snap, p.from)} ← ${partyName(snap, p.to)} ${formatMoney(p.amount)}`);
    }
    lines.push('', 'אחרי ההעברה מסמנים ״שילמתי״ במדורה ✅');
  }
  return lines.join('\n');
}

export function buildSummaryText(snap, kind = 'status', memberId) {
  if (kind === 'missing') return summaryMissing(snap);
  if (kind === 'mine') return summaryMine(snap, memberId);
  if (kind === 'settle') return summarySettle(snap);
  if (kind === 'after') return summaryAfter(snap);
  return summaryStatus(snap);
}

// ───────────────────────── notifications, polls, votes ─────────────────────────

/** Me in this snapshot: my profile id, and whether THIS device holds admin rights (me.admin; an older
 *  server without it: my profile's role). */
function myIdentity(snap) {
  const meId = snap?.me?.member_id ?? null;
  if (typeof snap?.me?.admin === 'boolean') return { meId, admin: snap.me.admin };
  const meMember = list(snap?.members).find((m) => m && m.id === meId);
  const admin = isAdmin(meMember) || snap?.me?.role === 'owner' || snap?.me?.role === 'admin';
  return { meId, admin };
}

export function visibleNotifications(snap) {
  const { meId, admin } = myIdentity(snap);
  return list(snap?.notifications)
    .filter(
      (n) =>
        n &&
        (n.audience === null ||
          n.audience === undefined ||
          (Array.isArray(n.audience) && meId !== null && n.audience.includes(meId)) ||
          (meId !== null && n.author_member === meId) ||
          (n.kind === 'announcement' && admin)),
    )
    .sort((a, b) => timeOf(b.created_at) - timeOf(a.created_at));
}

/** Urgent announcements of the last 3 days — pinned on top of the feed and on the home card (newest first). */
export function pinnedNotices(snap, now = new Date()) {
  const since = now.getTime() - 3 * 86400000;
  return visibleNotifications(snap).filter((n) => n.kind === 'announcement' && n.urgent && new Date(n.created_at).getTime() >= since);
}

export function unreadCount(snap) {
  const { meId } = myIdentity(snap);
  if (meId === null) return 0;
  const read = new Set(list(snap?.reads).filter((r) => r && r.member_id === meId).map((r) => r.notification_id));
  // my own announcements never count as unread for me
  return visibleNotifications(snap).filter((n) => !read.has(n.id) && n.author_member !== meId).length;
}

export function pollResults(poll, votes) {
  const options = list(poll?.options);
  const optionIds = new Set(options.map((o) => o.id));
  const valid = list(votes).filter(
    (v) => v && (v.poll_id === undefined || v.poll_id === poll?.id) && optionIds.has(v.option_id),
  );
  const voterCount = new Set(valid.map((v) => v.member_id)).size;
  return options.map((o) => {
    const voters = [...new Set(valid.filter((v) => v.option_id === o.id).map((v) => v.member_id))];
    return {
      id: o.id,
      label: o.label,
      count: voters.length,
      pct: voterCount ? Math.round((voters.length * 100) / voterCount) : 0,
      voters,
    };
  });
}

export function adminVoteCounts(snap) {
  const counts = new Map();
  const seen = new Set();
  for (const v of list(snap?.admin_votes)) {
    if (!v || v.candidate_id == null) continue;
    const key = `${v.voter_id}|${v.candidate_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts.set(v.candidate_id, (counts.get(v.candidate_id) || 0) + 1);
  }
  return counts;
}

// ───────────────────────── similar items (duplicate warning) ─────────────────────────

const FINAL_LETTERS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
// Words that say nothing about *what* the item is ("כוסות חד פעמיות" ≠ "צלחות חד פעמיות").
const DUP_STOP_WORDS = new Set([
  'עם', 'של', 'או', 'גם', 'כל', 'לכל', 'זוג', 'אחד', 'אחת', 'עוד', 'בערך', 'לפחות', 'מספיק', 'הרבה',
  'גדול', 'גדולה', 'גדולים', 'גדולות', 'קטן', 'קטנה', 'קטנים', 'קטנות', 'חדש', 'ישן',
  'חד', 'פעמי', 'פעמית', 'פעמיים', 'פעמיות',
  'קילו', 'קג', 'גרם', 'ליטר', 'מל', 'יח', 'יחידות', 'בקבוק', 'בקבוקים', 'חבילה', 'חבילות', 'שישייה', 'שישיה', 'שישיות',
  'קופסה', 'קופסא', 'קופסאות', 'גליל', 'גלילים', 'מארז', 'ארגז',
  'בקבוקי', 'חבילת', 'קופסת', 'שישיית', 'מארזי', 'ארגזי',
]);

/** Rough Hebrew stem: no ו/ה prefix, plural or feminine suffix, or vowel letters (ו/י) after the first letter. */
function dupStem(word) {
  let s = word.replace(/[ךםןףץ]/g, (c) => FINAL_LETTERS[c]);
  if (s.length >= 4 && s[0] === 'ו') s = s.slice(1);
  if (s.length >= 4 && s[0] === 'ה') s = s.slice(1);
  if (s.length >= 5 && /(ימ|ות)$/.test(s)) s = s.slice(0, -2);
  if (s.length >= 4 && /[הת]$/.test(s)) s = s.slice(0, -1);
  if (s.length > 3) s = s[0] + s.slice(1).replace(/[וי]/g, '');
  return s;
}

/** The words of an item title that identify it, stemmed (numbers, units and fillers dropped). */
function dupTokens(title) {
  const words = normKey(title).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/);
  const out = [];
  for (const w of words) {
    if (!w || /\d/.test(w) || DUP_STOP_WORDS.has(w)) continue;
    const s = dupStem(w);
    if (s.length >= 2 && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Levenshtein distance, capped: returns max+1 as soon as it is exceeded. */
function editDistance(a, b, max = 1) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const tokensMatch = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && editDistance(a, b, 1) <= 1);

/**
 * How alike two item titles are: 'same' (same thing, maybe plural/typo/other spelling),
 * 'similar' (one contains the other, or most words shared) or null.
 */
export function titleSimilarity(a, b) {
  const na = normKey(a).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const nb = normKey(b).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!na || !nb) return null;
  if (na === nb) return 'same';
  const ta = dupTokens(a);
  const tb = dupTokens(b);
  if (!ta.length || !tb.length) return null;
  const shared = ta.filter((x) => tb.some((y) => tokensMatch(x, y))).length;
  if (!shared) return null;
  if (shared === ta.length && shared === tb.length) return 'same';
  if (shared === Math.min(ta.length, tb.length)) return 'similar';
  return shared / (ta.length + tb.length - shared) >= 0.5 ? 'similar' : null;
}

/**
 * Items already in the trip that look like `title` — for the "already on the list?" warning.
 * Rejected items are ignored. Returns [{ item, match: 'same'|'similar' }], 'same' first.
 */
export function similarItems(title, items, { excludeId = null, limit = 3 } = {}) {
  if (!String(title ?? '').trim()) return [];
  const out = [];
  for (const item of list(items)) {
    if (!item || item.id === excludeId || item.status === 'rejected') continue;
    const match = titleSimilarity(title, item.title);
    if (match) out.push({ item, match });
  }
  out.sort((x, y) => (x.match === y.match ? 0 : x.match === 'same' ? -1 : 1));
  return out.slice(0, limit);
}

// ───────────────────────── Israel wall clock (shared by rides / trip day) ─────────────────────────

let ilFmt = null;
/** {ymd:'YYYY-MM-DD', hm:'HH:MM'} of an instant as a wall clock in Israel. */
export function ilWall(date) {
  ilFmt ||= new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const part of ilFmt.formatToParts(date)) p[part.type] = part.value;
  return { ymd: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

/** Israel wall-clock date + time → ISO instant (DST aware). */
export function ilIso(ymd, hm = '00:00') {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  const target = Date.UTC(y, m - 1, d, hh || 0, mm || 0);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const w = ilWall(new Date(guess));
    const [wy, wmo, wd] = w.ymd.split('-').map(Number);
    const [wh, wmin] = w.hm.split(':').map(Number);
    const next = target - (Date.UTC(wy, wmo - 1, wd, wh, wmin) - guess);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString();
}

/**
 * When we really leave: the trip's start, or the schedule's earliest row on day 1 when that's earlier
 * ("03:30 יוצאים לשדה" before a 06:30 flight) — {at: ISO, row: {time, emoji, label} | null}.
 * Rows without a day (older trips) count as day 1 until the times go down (the old rollover rule).
 */
export function departureOf(trip) {
  const start = trip?.starts_at ? new Date(trip.starts_at) : null;
  if (!start || Number.isNaN(start.getTime())) return { at: null, row: null };
  const rows = list(trip?.info?.schedule).filter((r) => r && /^\d{2}:\d{2}$/.test(String(r.time || '')));
  const dayed = rows.some((r) => Number.isInteger(r.day));
  let first = [];
  if (dayed) first = rows.filter((r) => (Number.isInteger(r.day) ? r.day : 1) === 1);
  else {
    for (const r of rows) {
      if (first.length && r.time < first[first.length - 1].time) break;
      first.push(r);
    }
  }
  const row = first.reduce((best, r) => (!best || r.time < best.time ? r : best), null);
  if (!row) return { at: trip.starts_at, row: null };
  const at = ilIso(ilWall(start).ymd, row.time);
  return new Date(at) < start ? { at, row: { time: row.time, emoji: row.emoji || '', label: row.label || '' } } : { at: trip.starts_at, row: null };
}

/** How I travel on the day, in words: a car I drive, a taxi I order, a meeting point I set, or a seat. */
export function myRideText(rides) {
  const r = rides?.myRide;
  if (r) {
    const n = r.taken;
    if (r.kind === 'meet') return `את/ה מארגנ/ת את נקודת המפגש${n ? ` · ${hebrewCount(n, 'מצטרף/ת', 'מצטרפים')}` : ''}`;
    if (r.kind === 'taxi') return `את/ה מזמינ/ה את המונית${n ? ` · ${hebrewCount(n, 'נוסע/ת', 'נוסעים')} איתך` : ''}`;
    return `את/ה נוהג/ת${n ? ` · ${hebrewCount(n, 'נוסע/ת', 'נוסעים')} איתך` : ''}`;
  }
  const s = rides?.mySeat;
  if (!s) return null;
  if (s.kind === 'meet') return `נפגשים עם ${displayName(s.driver)}${s.from_text ? ` · ${s.from_text}` : ''}`;
  if (s.kind === 'taxi') return `במונית של ${displayName(s.driver)}`;
  return `נוסע/ת עם ${displayName(s.driver)}`;
}

/** "⏰ עד מתי" of an item, for its row / sheet: {text: '⏰ עד ד׳ 7.10 12:00' | '⏰ עבר המועד (…)', late} | null. */
export function dueInfo(dueAt, now = new Date(), done = false) {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return null;
  const late = !done && d < now;
  const w = ilWall(d);
  const when = w.ymd === ilWall(now).ymd ? `היום ${w.hm}` : `${formatDate(dueAt, { weekday: 'short', day: 'numeric', month: 'numeric' })} ${w.hm}`;
  return { late, text: late ? `⏰ עבר המועד (${when})` : `⏰ עד ${when}` };
}

// ───────────────────────── rides ─────────────────────────

/** Ways of getting there that need no seat in someone's car: they count as "arranged". */
const SELF_ARRIVAL = ['own', 'drop', 'transit', 'park'];

/**
 * Rides view model: each ride with its passengers and free seats, my role, and who still has
 * no ride (members neither driving nor seated).
 */
export function rideModel(snap, meId) {
  const members = list(snap?.members);
  const byId = membersById(members);
  const seats = list(snap?.ride_seats);
  const isApproved = (s) => (s.status || 'approved') === 'approved';
  const rowOf = (s) => ({ member: byId.get(s.member_id), seats: Number(s.seats) || 1, requestedBy: s.requested_by || 'passenger' });
  const rides = list(snap?.rides).map((r) => {
    const mine = seats.filter((s) => s.ride_id === r.id);
    const passengers = mine.filter(isApproved).map(rowOf).filter((p) => p.member);
    const pending = mine.filter((s) => !isApproved(s)).map(rowOf).filter((p) => p.member);
    const taken = passengers.reduce((n, p) => n + p.seats, 0);
    return { ...r, driver: byId.get(r.driver_member) || null, passengers, pending, taken, free: Math.max(0, (Number(r.seats) || 0) - taken) };
  });
  const driving = new Set(rides.map((r) => r.driver_member));
  const seated = new Set(seats.filter(isApproved).map((s) => s.member_id));
  const modeOf = (m) => m?.prefs?.transport?.mode || null;
  // Not driving, not seated, and not coming some other way (own way, dropped off, train / bus, parking at the airport).
  const without = members.filter((m) => !driving.has(m.id) && !seated.has(m.id) && !SELF_ARRIVAL.includes(modeOf(m)));
  return {
    rides,
    myRide: rides.find((r) => r.driver_member === meId) || null,
    mySeat: rides.find((r) => r.passengers.some((p) => p.member.id === meId)) || null,
    /** My own pending ask (waiting for that driver). */
    myAsk: rides.find((r) => r.pending.some((p) => p.member.id === meId && p.requestedBy === 'passenger')) || null,
    /** Drivers inviting me (waiting for my answer). */
    invites: rides.filter((r) => r.pending.some((p) => p.member.id === meId && p.requestedBy === 'driver')),
    without,
    seeking: without.filter((m) => modeOf(m) === 'need').map((m) => ({ member: m, from: m.prefs.transport.from || null })),
    freeSeats: rides.filter((r) => (r.kind || 'car') !== 'meet').reduce((n, r) => n + r.free, 0),
  };
}

/** Flights (member prefs.travel = {out: {flight, at}, back: {flight, at}}): who's on which flight, who hasn't said. */
export function flightModel(snap, leg = 'out') {
  const members = list(snap?.members);
  const groups = new Map();
  const missing = [];
  for (const m of members) {
    const f = m?.prefs?.travel?.[leg];
    const code = String(f?.flight || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!code) {
      missing.push(m);
      continue;
    }
    if (!groups.has(code)) groups.set(code, { flight: code, at: f.at || null, members: [] });
    const g = groups.get(code);
    if (!g.at && f.at) g.at = f.at;
    g.members.push(m);
  }
  const flights = [...groups.values()].sort((a, b) => String(a.at || '~').localeCompare(String(b.at || '~')) || a.flight.localeCompare(b.flight));
  return { flights, missing };
}
// ───────────────────────── trip day ─────────────────────────

/** Waze navigation link: the trip's own Waze link, its coordinates, or a search for its place. */
export function wazeUrl(trip) {
  const own = String(trip?.location_url || '');
  if (/^https?:\/\/([a-z0-9-]+\.)*waze\.com\//i.test(own)) return own;
  if (Number.isFinite(Number(trip?.lat)) && Number.isFinite(Number(trip?.lon)) && trip?.lat != null && trip?.lon != null) {
    return `https://waze.com/ul?ll=${Number(trip.lat)},${Number(trip.lon)}&navigate=yes`;
  }
  const q = String(trip?.location || '').trim();
  return q ? `https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes` : null;
}

/** 'eve' on the day before the trip, 'day' from the morning it starts until it ends, else null. */
export function tripDayPhase(trip, now = new Date()) {
  const start = trip?.starts_at ? new Date(trip.starts_at) : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  const end = trip.ends_at ? new Date(trip.ends_at) : new Date(start.getTime() + 86400000);
  if (now > end) return null;
  const today = ilWall(now).ymd;
  const startDay = ilWall(start).ymd;
  if (today === startDay || (now >= start && now <= end)) return 'day';
  const [y, m, d] = startDay.split('-').map(Number);
  const eve = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  return today === eve ? 'eve' : null;
}
// ───────────────────────── "📥 waiting for you" ─────────────────────────

/**
 * Everything that waits for MY answer, oldest first: asks to join my car, invites to a car,
 * assignments by someone else, payments sent to me, and (admins) proposals to review.
 * Each entry: {kind, key, ...}.
 */
export function myInbox(snap, meId) {
  if (!snap || !meId) return [];
  const members = membersById(list(snap.members));
  const out = [];
  for (const r of list(snap.profile_requests)) {
    out.push({ kind: 'profile_request', key: `pr-${r.id}`, request: r, profile: members.get(r.member_id) || null });
  }
  const model = rideModel(snap, meId);
  // once the trip is over, unanswered seat asks / invites are history — not "מחכה לך"
  const over = ['after', 'past'].includes(tripPhase(snap.trip));
  if (model.myRide && !over) {
    for (const p of model.myRide.pending) {
      if (p.requestedBy === 'passenger') out.push({ kind: 'ride_ask', key: `ask-${p.member.id}`, ride: model.myRide, member: p.member, seats: p.seats });
    }
  }
  for (const ride of over ? [] : model.invites) {
    const p = ride.pending.find((x) => x.member.id === meId);
    out.push({ kind: 'ride_invite', key: `inv-${ride.id}`, ride, seats: p?.seats ?? 1 });
  }
  const items = new Map(list(snap.items).map((i) => [i.id, i]));
  for (const pl of list(snap.pledges)) {
    if (pl.member_id !== meId || !pl.assigned_by || pl.assigned_by === meId || pl.accepted_at) continue;
    const item = items.get(pl.item_id);
    if (item && item.status === 'active') {
      const by = members.get(pl.assigned_by) || null;
      out.push({ kind: 'assignment', key: `as-${pl.id}`, item, pledge: pl, by, byName: by ? actorName(by, pl.by_person) : null });
    }
  }
  const reqs = new Map(list(snap.money_requests).map((q) => [q.id, q]));
  const person = snap.me?.member_id === meId ? snap.me?.person ?? null : null;
  const myParty = person && splitsMoney(members.get(meId)) ? `${meId}::${person}` : meId;
  const bals = list(snap.money_requests).some((q) => q.expense_id) ? partyBalances(snap) : [];
  // a profile's balance is the sum of its rows (a couple that pays each their own part has no row keyed by its id)
  const balOf = (key) => bals.filter((b) => b.key === key || (key === meId && b.member_id === meId)).reduce((n, b) => n + toNum(b.balance), 0);
  for (const x of list(snap.money_request_members)) {
    const q = reqs.get(x.request_id);
    if (!q || q.status !== 'open' || x.member_id !== meId || x.payment_id) continue;
    // a couple that pays each their own part (SPEC §19): my part, or — no person on this device — what's left
    const parts = list(snap.money_request_parts).filter((p) => p.request_id === x.request_id && p.member_id === meId);
    const mine = person ? parts.find((p) => p.person === person) : null;
    if (mine?.payment_id) continue;
    const amount = mine ? mine.amount : parts.length ? fromCents(parts.filter((p) => !p.payment_id).reduce((n, p) => n + toCents(p.amount), 0)) : x.amount;
    // an "already paid" share is part of my balance — once that's even, there's nothing to pay here
    if (q.expense_id && balanceSettled(balOf(mine ? myParty : meId))) continue;
    out.push({ kind: 'money_request', key: `mr-${q.id}`, request: q, amount, from: members.get(q.requested_by) || null });
  }
  for (const pay of list(snap.payments)) {
    if (pay.to_member === meId && pay.status === 'sent') out.push({ kind: 'payment', key: `pay-${pay.id}`, payment: pay, from: members.get(pay.from_member) || null });
  }
  const me = members.get(meId);
  const ident = myIdentity(snap);
  const admin = ident.meId === meId ? ident.admin : isAdmin(me);
  if (me && admin) {
    const proposed = list(snap.items).filter((i) => i.status === 'proposed').length;
    if (proposed) out.push({ kind: 'proposals', key: 'proposals', count: proposed });
  }
  return out;
}
// ───────────────────────── trip phases (home screen) ─────────────────────────

/**
 * Where we are relative to the trip (Israel time):
 * 'before' → 'eve' (the day before) → 'departure' (start day, before it starts) →
 * 'during' (started, not over) → 'after' (up to 14 days) → 'past'. No start date → 'before'.
 */
export function tripPhase(trip, now = new Date()) {
  const start = trip?.starts_at ? new Date(trip.starts_at) : null;
  if (!start || Number.isNaN(start.getTime())) return 'before';
  const end = trip.ends_at ? new Date(trip.ends_at) : new Date(start.getTime() + 86400000);
  if (now > end) return now - end > 14 * 86400000 ? 'past' : 'after';
  if (now >= start) return 'during';
  const today = ilWall(now).ymd;
  const startDay = ilWall(start).ymd;
  if (today === startDay) return 'departure';
  const [y, m, d] = startDay.split('-').map(Number);
  return today === new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10) ? 'eve' : 'before';
}

/** The trip is over ('after' / 'past'): every tab switches to "closing the trip · read only" (ux-spec §3.1). */
export function tripOver(trip, now = new Date()) {
  return ['after', 'past'].includes(tripPhase(trip, now));
}

/**
 * My "before the trip" checklist: contact details, how I get there, my open things to bring /
 * buy, polls I haven't answered. Each: {key, done, label, detail?, href?}. Links are hash routes.
 */
export function myChecklist(snap, meId, extras = {}) {
  if (!snap || !meId) return { items: [], done: 0, total: 0 };
  const me = membersById(list(snap.members)).get(meId);
  if (!me) return { items: [], done: 0, total: 0 };
  const t = `#/t/${snap.trip.id}`;
  const rides = rideModel(snap, meId);
  const transport = me.prefs?.transport?.mode;
  const arrive = rides.myRide || rides.mySeat || SELF_ARRIVAL.includes(transport);
  const openPledges = list(snap.pledges).filter((p) => p.member_id === meId && !p.done).length;
  const myPledges = list(snap.pledges).filter((p) => p.member_id === meId).length;
  const votedPolls = new Set(list(snap.poll_votes).filter((v) => v.member_id === meId).map((v) => v.poll_id));
  const openPolls = list(snap.polls).filter((p) => !p.closed && !votedPolls.has(p.id)).length;
  const on = (key) => snap.trip?.settings?.modules?.[key] !== false;
  const items = [
    { key: 'contact', done: Boolean(me.phone) || Boolean(extras.hasEmail), label: 'פרטי קשר (טלפון / מייל)', href: `${t}/welcome?step=contact` },
    on('rides') && {
      key: 'arrive', done: Boolean(arrive), label: 'איך אני מגיע/ה? 🚗',
      detail: rides.myRide ? 'נוהג/ת' : rides.mySeat ? `עם ${displayName(rides.mySeat.driver)}` : rides.myAsk ? `⏳ מחכה ל${displayName(rides.myAsk.driver)}` : transport === 'need' ? 'מחפשים טרמפ' : null,
      href: `${t}/rides`,
    },
    (on('lists') || on('tasks')) && {
      key: 'bring', done: myPledges > 0 && openPledges === 0, label: myPledges ? 'מה אני מביא/ה' : 'לקחת משהו מהרשימה',
      detail: openPledges ? `עוד ${openPledges} לסמן` : null, href: `${t}/lists?tab=mine`,
    },
  ].filter(Boolean);
  if (on('polls') && list(snap.polls).some((p) => !p.closed)) {
    items.push({ key: 'polls', done: openPolls === 0, label: 'סקרים', detail: openPolls ? (openPolls === 1 ? 'אחד מחכה להצבעה' : `${openPolls} מחכים להצבעה`) : null, href: `${t}/messages` });
  }
  const done = items.filter((i) => i.done).length;
  return { items, done, total: items.length };
}

/** "The trip in numbers" — for the after-trip card and sharing. */
export function tripStats(snap) {
  const members = list(snap?.members);
  const heads = headcountTotal(members);
  const paying = headcountTotal(payingMembers(snap));             // per person = among who pays (not the exempt)
  const items = list(snap?.items).filter((i) => i.status === 'active');
  const spent = list(snap?.expenses).reduce((s, e) => s + toCents(e.amount), 0);
  const rides = list(snap?.rides).length;
  return {
    people: heads,
    items: items.length,
    done: items.filter((i) => i.done).length,
    spent: fromCents(spent),
    perPerson: paying ? fromCents(Math.round(spent / paying)) : 0,
    rides,
  };
}