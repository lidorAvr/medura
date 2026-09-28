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

export function isAdmin(member) {
  return !!member && (member.role === 'owner' || member.role === 'admin');
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
};
const UNIT_LOOKUP = new Map();
for (const [canon, aliases] of Object.entries(UNIT_ALIASES)) for (const a of aliases) UNIT_LOOKUP.set(a, canon);

const UNIT_SINGULAR = { 'חבילות': 'חבילה', 'בקבוקים': 'בקבוק', 'שישיות': 'שישייה', 'קופסאות': 'קופסה', 'גלילים': 'גליל' };
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

  if (item?.type === 'each') {
    const ids = new Set(memberList.map((m) => m.id));
    const doneIds = new Set(own.filter((p) => p.done && ids.has(p.member_id)).map((p) => p.member_id));
    total = memberList.length;
    needed = total;
    doneCount = doneIds.size;
    pledged = new Set(own.filter((p) => ids.has(p.member_id)).map((p) => p.member_id)).size;
    state = total > 0 && doneCount >= total ? 'done' : doneCount > 0 ? 'partial' : 'missing';
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
  return { state, pledged, needed, doneCount, total, pledgers };
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
  let total = 0;
  let done = 0;
  for (const item of items) {
    const pledge = mine.get(item.id);
    if (item.type === 'each') {
      if (!isActive(item)) continue;
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
    parts = members.filter((m) => m && m.id != null).map((m) => ({ member_id: m.id, weight: headcountOf(m) }));
  }
  return allocateCents(toCents(expense.amount), parts);
}

export function expenseShares(expense, snap) {
  return shareCents(expense, snap).map((s) => ({ member_id: s.member_id, amount: fromCents(s.cents) }));
}

export function balances(snap) {
  const members = list(snap?.members).filter((m) => m && m.id != null);
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
    if (!p) continue;
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

export function settlePlan(balancesArr) {
  const rows = list(balancesArr)
    .filter((b) => b && b.member_id != null)
    .map((b, i) => ({ id: b.member_id, c: toCents(b.balance), i }));
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

export function tripTotals(snap) {
  const spentCents = list(snap?.expenses).reduce((s, e) => s + (e ? toCents(e.amount) : 0), 0);
  const heads = headcountTotal(snap?.members);
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
  meat: ['בשר', 'בשרים', 'עוף', 'עופות', 'קצביה', 'קצבייה'],
  veg: ['ירקות', 'ירק', 'פירות', 'פרי', 'סלטים', 'סלט'],
  pantry: ['מזווה', 'רטבים', 'רוטב', 'שימורים', 'מכולת', 'יבשים', 'לחמים', 'לחם', 'מאפים'],
  snacks: ['נשנושים', 'נשנוש', 'חטיפים', 'מתוקים', 'ממתקים', 'קינוחים', 'פיצוחים'],
  drinks: ['שתייה', 'שתיה', 'משקאות', 'אלכוהול'],
  grill: ['מנגל', 'בישול', 'מטבח', 'גריל', 'כלי בישול'],
  dispo: ['חד פעמי', 'חד פעמיים', 'חדפ'],
  gear: ['ציוד', 'קמפינג', 'לינה', 'ישיבה', 'אוהלים'],
  fun: ['כיף', 'משחקים', 'משחק', 'בידור', 'פעילויות', 'פנאי'],
  tasks: ['משימות', 'משימה', 'מטלות', 'סידורים'],
};

const ITEM_WORDS = {
  meat: ['סטייק', 'אנטריקוט', 'פרגית', 'פרגיות', 'נקניק', 'נקניקיות', 'מרגז', 'קבב', 'קבבים', 'כנפיים', 'שניצל',
    'שניצלים', 'המבורגר', 'המבורגרים', 'עוף', 'בשר', 'צלעות', 'אסאדו', 'קציצות', 'כבד', 'לבבות', 'חזה עוף', 'שוקיים'],
  veg: ['עגבניות', 'עגבנייה', 'עגבניה', 'מלפפונים', 'מלפפון', 'בצל', 'שום', 'אבטיח', 'מלון', 'לימון', 'לימונים',
    'תפוחים', 'בננות', 'ענבים', 'פירות', 'ירקות', 'חסה', 'תפוחי אדמה', 'בטטה', 'פטריות', 'סלט', 'סלטים', 'תירס', 'גזר', 'כרוב'],
  pantry: ['קטשופ', 'מיונז', 'חרדל', 'פיתות', 'פיתה', 'לחם', 'לחמניות', 'בגטים', 'ביצים', 'שמן', 'טחינה', 'חומוס',
    'מטבוחה', 'רוטב', 'רטבים', 'אורז', 'פסטה', 'קמח', 'סוכר', 'טונה', 'דבש', 'עגבניות מרוסקות', 'שימורים'],
  snacks: ['חטיפים', 'חטיף', 'במבה', 'ביסלי', 'שוקולד', 'עוגיות', 'עוגה', 'גומי', 'גרעינים', 'פיצוחים', 'ממתקים',
    'מרשמלו', 'ופלים', 'לואקר', 'בוטנים', 'פופקורן'],
  drinks: ['מים', 'שתייה', 'שתיה', 'קולה', 'ספרייט', 'בירה', 'בירות', 'יין', 'בריזר', 'וודקה', 'ערק', 'אלכוהול',
    'סודה', 'קרח', 'משקאות', 'מיץ'],
  grill: ['מנגל', 'פחמים', 'חומר מדליק', 'מדליק', 'נפנף', 'מלקחיים', 'מחבת', 'מחבתות', 'סיר', 'סירים', 'גזייה', 'גזיה',
    'בלון גז', 'גז', 'פינגאן', 'פקל קפה', 'קרש חיתוך', 'קרשי חיתוך', 'סכין', 'סכינים', 'מזלג', 'מזלגות', 'רשת',
    'שיפודי עץ', 'שיפודים', 'תבלינים', 'תבלין', 'קומקום', 'מצית', 'גפרורים'],
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
    return { ...qtyFrom(m[2], m[3], m[4]), rest: before, at: before.length };
  }
  return null;
}

function stripInvisible(s) {
  return String(s ?? '')
    .replace(/[\u200B\u200C\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
    .replace(/[\u00A0\u2007\u202F\t]/g, ' ');
}

const WA_PREFIX_RES = [
  /^\[?\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.?)?\]?\s*(?:[-–]\s*)?[^:]{1,40}?:\s+/,
  /^\[\d{1,2}:\d{2}(?::\d{2})?,\s*\d{1,4}[./-]\d{1,2}[./-]\d{1,4}\]\s*[^:]{1,40}?:\s+/,
];
const WA_DATE_ONLY_RE = /^\[?\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s+\d{1,2}:\d{2}/;
const SYSTEM_RE = /<[^>]*(?:המדיה|Media|omitted|נערכה|edited)[^>]*>|הודעה זו נמחקה|ההודעה נמחקה|This message was deleted|https?:\/\/|www\./i;
const CHATTER_RE = /^(?:תודה(?: רבה)?|סבבה|אחלה|מעולה|אוקיי|אוקי|ok|בדיוק|יאללה|וואלה|נכון|כן|לא|חח+|👍+)[!.\s]*$/iu;
const BULLET_RE = /^(?:[*+](?=\s)|[-–—•·▪▫◦●○■□►▶➤➢→⁃✓✔✗✘☐☑✅⬜⬛❌➖🔸🔹🔶🔷👉👈🔘]\uFE0F?|\d\uFE0F?\u20E3|\(?\d{1,2}[.)](?!\d)|[א-י][.)](?=\s))\s*/u;

const ASK_RE = /^(יש\s+ל?מישהו|למישהו\s+יש|למי\s+יש|מישהו\s+(?:יכול\s+)?(?:מביא|להביא|יביא|לוקח|לקחת)|מי\s+(?:יכול\s+(?:להביא|לקחת|לקנות)|מביא|מביאה|יביא|לוקח|לוקחת|קונה|יקנה|יכול))(?=\s|\?|$)\s*(.*)$/u;
const ASK_TAIL_RE = /\s*(?:ו?ש?(?:יכול|יכולה|יוכל)\s+ל(?:הביא|הקפיץ|השאיל)|שיביא|שתביא|להביא|להשאיל|בבית|לטיול|לקמפינג|מביא|ש?אפשר\s+להביא)\s*$/u;

// "per person" markers and "everyone brings" markers (replaced by spaces so indices stay stable)
const PER_PERSON_RE = /(^|[^\p{L}])(פר\s+(?:בן\s+)?אדם|לבן\s+אדם|לכל\s+אדם|לאדם|לנפש|פר\s+ראש|per\s+person)(?=$|[^\p{L}])/giu;
const EACH_RE = /(^|[^\p{L}])(לכל\s+(?:אחד|אחת)|לכל\s+(?:זוג|משפחה|יחידה)|פר\s+(?:זוג|משפחה)|לזוג|כל\s+(?:זוג|אחד|אחת|משפחה|יחידה|בית))(?=$|[^\p{L}])/gu;

// "אני מביא 2 כסאות" / "להביא מחצלת" → the verb is not part of the item name
const LEADING_VERB_RE = /^(?:אני\s+|אנחנו\s+)?(?:מביא|מביאה|מביאים|להביא|צריך|צריכה|צריכים|לקנות|קונה|קונים|לוקח|לוקחת|לוקחים)\s+(?=\S)/u;

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

/** Parses one list line into an item token (or a note / skip token). */
function parseItemLine(body, raw) {
  let s = body;
  const notes = []; // {i, text}
  let askType = null;

  // "יש למישהו רמקול?" → item "רמקול" with the question as a note
  const ask = ASK_RE.exec(s);
  if (ask) {
    let rest = ask[2].replace(/[?？!]+/g, ' ').trim();
    for (let k = 0; k < 3; k++) rest = rest.replace(ASK_TAIL_RE, '').trim();
    rest = rest.replace(/^(?:את|איזה|אולי)\s+/u, '');
    const question = tidy(s);
    if (!rest || !/\p{L}/u.test(rest)) return { kind: 'note', text: question };
    notes.push({ i: -1, text: question });
    askType = /קונה|יקנה|לקנות/u.test(ask[1]) ? 'buy' : 'bring';
    s = rest;
  }

  // parentheses → notes (keep string length so indices stay aligned)
  s = s.replace(/\(([^()]*)(?:\)|$)/g, (m, inner, off) => {
    notes.push({ i: off, text: inner });
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
  for (const seg of segs) {
    const t = seg.text.trim();
    if (!t) continue;
    const at = seg.i + seg.text.indexOf(t);
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
    else notes.push({ i: at, text: t });
  }
  if (!titleSeg) return { kind: 'skip' };

  let titleText = titleSeg.text.replace(LEADING_VERB_RE, '');
  if (qty === null) {
    const q = leadingQty(titleText) || trailingQty(titleText);
    if (q && q.qty !== null) {
      ({ qty, unit } = q);
      qtyAt = titleSeg.i + q.at;
      titleText = q.rest;
      if (q.note) notes.push({ i: titleSeg.i, text: q.note });
    }
  }

  const title = cleanTitle(titleText);
  if (!title || !/\p{L}/u.test(title)) return { kind: 'skip' };
  if (/[?？]\s*$/u.test(title)) return { kind: 'note', text: tidy(body) }; // a question, not an item
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
  else if (candidates[0] === 'tasks') type = 'buy'; // parser types are buy|bring|each; a task is closest to buy
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

function sectionTypeOf(text) {
  if (/ציוד\s+אישי/u.test(text)) return 'each';
  if (/מהבית|מהבייתה|ציוד/u.test(text)) return 'bring';
  return 'buy';
}

function classifyLine(rawLine) {
  const raw = stripInvisible(rawLine).trim();
  let s = raw;
  for (const re of WA_PREFIX_RES) s = s.replace(re, '');
  if (s === raw && WA_DATE_ONLY_RE.test(s)) return { kind: 'skip' }; // WhatsApp system line
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return { kind: 'blank' };
  if (s.length > 400 || SYSTEM_RE.test(s)) return { kind: 'skip' }; // prose / links, never a list line

  const bold = /^\*[^*]+\*\s*:?$/.test(s);
  let bulleted = false;
  for (let k = 0; k < 3; k++) {
    const m = BULLET_RE.exec(s);
    if (!m || !m[0]) break;
    s = s.slice(m[0].length);
    bulleted = true;
  }
  s = s
    .replace(/[*~]/g, '')
    .replace(/(^|[\s(])_(.+?)_(?=$|[\s).,:!?])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return { kind: 'blank' };
  if (CHATTER_RE.test(s)) return { kind: 'skip' };

  const lead = LEADING_EMOJI_RE.exec(s);
  const emoji = lead ? FIRST_EMOJI_RE.exec(s)[0] : null;
  const body = lead ? s.slice(lead[0].length).trim() : s;
  if (!body.replace(ANY_EMOJI_RE, '').trim()) return { kind: 'skip' }; // emoji-only line

  const endsColon = /[:：]\s*$/.test(body);
  const bodyNoColon = body.replace(/[:：]\s*$/, '').trim();
  const hasDigit = /\d/.test(body);

  // "רשימה 1: קניות בסופר" / "רשימה 2:" — list separators, not categories
  const listHdr = /^רשימ[הת](?=$|[\s:.\-–—\d])\s*(?:מס(?:פר|['׳])?\.?\s*)?\d*\s*[:.\-–—]?\s*(.*)$/u.exec(body);
  if (listHdr && body.length <= 60 && !/\d/.test(listHdr[1])) return { kind: 'section', type: sectionTypeOf(listHdr[1]) };

  // Section lines switch the item type and reset the category ("חלוקה של כל אחד מהבית", "מה צריך לקנות:")
  if (!hasDigit && !bulleted && !lead && wordCount(bodyNoColon) <= 6) {
    const intro = endsColon || bold;
    if (/^(?:ציוד\s+אישי|כל\s+(?:אחד|אחת|זוג|משפחה)\s+(?:מביא|מביאה|מביאים|צריך|צריכה|צריכים|לוקח|לוקחים))$/u.test(bodyNoColon)) {
      return { kind: 'section', type: 'each' };
    }
    const fromHome = /מהבית|מהבייתה|מהבתים/u.test(body)
      && (intro || /^(?:חלוק|ציוד|דברים|מה\s|להביא|מביאים|כל\s+(?:אחד|אחת|זוג)|רשימ)/u.test(bodyNoColon));
    if (fromHome || (intro && /(?:^|\s)(?:להביא|מביאים)(?=\s|$)/u.test(bodyNoColon))) {
      return { kind: 'section', type: /אישי/u.test(body) ? 'each' : 'bring' };
    }
    if ((/^(?:רשימת\s+)?(?:קניות|לקנות|מה\s+לקנות|מה\s+קונים|קנייה|קניה|סופר)(?=\s|$)/u.test(bodyNoColon) && wordCount(bodyNoColon) <= 4)
      || (intro && /(?:^|\s)(?:קניות|לקנות|לסופר|בסופר|קונים)(?=\s|$)/u.test(bodyNoColon))) {
      return { kind: 'section', type: 'buy' };
    }
  }

  const headerish = !hasDigit && !/[()?？]/.test(body) && !bulleted;
  if (lead && headerish && wordCount(bodyNoColon) <= 6) return makeHeader(bodyNoColon, emoji, { colon: endsColon, raw });
  if (headerish && endsColon && wordCount(bodyNoColon) <= 5) return makeHeader(bodyNoColon, null, { colon: true, raw });
  if (headerish && bold && wordCount(bodyNoColon) <= 4) return makeHeader(bodyNoColon, null, { bold: true, raw });
  const trail = !lead && headerish ? TRAILING_EMOJI_RE.exec(body) : null;
  if (trail && wordCount(body) <= 4) {
    const text = body.slice(0, trail.index).replace(/[:：]\s*$/, '').trim();
    if (catHits(text, HEADER_MATCHERS).length) return makeHeader(text, trail[0].trim(), { colon: true, raw });
  }

  if (/^\([^()]*\)?$/.test(body)) return { kind: 'note', text: tidy(body.replace(/^\(|\)$/g, '')) };
  const token = parseItemLine(body, raw);
  if (token.kind === 'item') {
    token.emojiCat = emojiCategory(emoji);
    token.emojiLed = !!emoji;
  }
  return token;
}

export function parseListText(text) {
  const tokens = String(text ?? '').split(/\r\n|\r|\n|\u2028|\u2029/).map(classifyLine);

  // Backward pass: an emoji "header" that isn't followed by a plain item line is really an item
  // ("🍉 אבטיח\n🍋 לימון" is a list of two items, "🏊 בריכה\nמצופים" is a header + item).
  let nextIsPlainItem = false;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.kind === 'blank' || t.kind === 'skip' || t.kind === 'note') continue;
    if (t.kind === 'header' && t.convertible && !nextIsPlainItem) {
      const item = parseItemLine(t.text, t.raw);
      if (item.kind === 'item') {
        tokens[i] = { ...item, emojiCat: t.emojiCat, emojiLed: true };
        nextIsPlainItem = false;
        continue;
      }
    }
    nextIsPlainItem = t.kind === 'item' && !t.emojiLed;
  }

  const out = [];
  let section = null;
  let header = null;
  let adjacent = null; // the item a following "(note)" line belongs to
  for (const t of tokens) {
    if (t.kind === 'blank' || t.kind === 'skip') {
      adjacent = null;
    } else if (t.kind === 'section') {
      section = t.type;
      header = null;
      adjacent = null;
    } else if (t.kind === 'header') {
      header = t.header;
      if (section === 'each') section = null; // "everyone brings" lists end at the next topic
      adjacent = null;
    } else if (t.kind === 'note') {
      if (adjacent) adjacent.note = joinNotes([adjacent.note || '', t.text]);
    } else if (t.kind === 'item') {
      let categoryKey = null;
      let category = null;
      const hits = catHits(t.title, ITEM_MATCHERS);
      if (header) {
        category = { ...header.category };
        categoryKey = header.candidates[0] || null;
        const [primary, ...others] = header.candidates;
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
      let type = t.each ? 'each' : t.askType || header?.type || section || null;
      if (!type) type = categoryKey === 'gear' || categoryKey === 'fun' ? 'bring' : 'buy';
      const item = {
        category,
        title: t.title,
        qty: t.qty,
        unit: t.unit,
        per_person: t.per_person,
        note: t.note,
        type,
        raw: t.raw,
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

function summaryStatus(snap) {
  const trip = snap?.trip || {};
  const members = list(snap?.members);
  const byItem = groupPledges(snap);
  const lines = [tripTitleLine(trip)];
  if (trip.starts_at) {
    const when = `📅 ${formatDate(trip.starts_at)} · ${formatTime(trip.starts_at)}`;
    const cd = countdown(trip.starts_at, new Date(), trip.ends_at).label;
    lines.push(cd ? `${when} (${cd})` : when);
  }
  if (trip.location) lines.push(`📍 ${trip.location}`);

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

  const totals = tripTotals(snap);
  lines.push('', '💸 *כסף*');
  if (totals.spent > 0) {
    lines.push(`הוצאות עד עכשיו: ${formatMoney(totals.spent)}`);
    lines.push(`לאדם: ${formatMoney(totals.perHead)} (${hebrewCount(totals.heads, 'איש', 'אנשים')})`);
  } else {
    lines.push('עוד לא נרשמו הוצאות');
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
  const byId = membersById(snap?.members);
  const plan = settlePlan(balances(snap));
  lines.push(`🧾 סה״כ הוצאות: ${formatMoney(totals.spent)}`);
  lines.push(`👥 לאדם: ${formatMoney(totals.perHead)} (${hebrewCount(totals.heads, 'איש', 'אנשים')})`);
  lines.push('');
  if (!plan.length) {
    lines.push('🎉 כולם מאוזנים — אין צורך בהעברות');
  } else {
    lines.push('*מי מעביר למי:*');
    for (const p of plan) {
      lines.push(`• ${displayName(byId.get(p.from))} ← ${displayName(byId.get(p.to))} ${formatMoney(p.amount)}`);
    }
    lines.push('', 'אחרי ההעברה מסמנים ״שילמתי״ במדורה ✅');
  }
  return lines.join('\n');
}

export function buildSummaryText(snap, kind = 'status', memberId) {
  if (kind === 'missing') return summaryMissing(snap);
  if (kind === 'mine') return summaryMine(snap, memberId);
  if (kind === 'settle') return summarySettle(snap);
  return summaryStatus(snap);
}

// ───────────────────────── notifications, polls, votes ─────────────────────────

function myIdentity(snap) {
  const meId = snap?.me?.member_id ?? null;
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

// ───────────────────────── rides ─────────────────────────

/**
 * Rides view model: each ride with its passengers and free seats, my role, and who still has
 * no ride (members neither driving nor seated).
 */
export function rideModel(snap, meId) {
  const members = list(snap?.members);
  const byId = membersById(members);
  const seats = list(snap?.ride_seats);
  const rides = list(snap?.rides).map((r) => {
    const passengers = seats.filter((s) => s.ride_id === r.id)
      .map((s) => ({ member: byId.get(s.member_id), seats: Number(s.seats) || 1 }))
      .filter((p) => p.member);
    const taken = passengers.reduce((n, p) => n + p.seats, 0);
    return { ...r, driver: byId.get(r.driver_member) || null, passengers, taken, free: Math.max(0, (Number(r.seats) || 0) - taken) };
  });
  const driving = new Set(rides.map((r) => r.driver_member));
  const seated = new Set(seats.map((s) => s.member_id));
  const modeOf = (m) => m?.prefs?.transport?.mode || null;
  // Not driving, not seated, and not coming some other way.
  const without = members.filter((m) => !driving.has(m.id) && !seated.has(m.id) && modeOf(m) !== 'own');
  return {
    rides,
    myRide: rides.find((r) => r.driver_member === meId) || null,
    mySeat: rides.find((r) => r.passengers.some((p) => p.member.id === meId)) || null,
    without,
    seeking: without.filter((m) => modeOf(m) === 'need').map((m) => ({ member: m, from: m.prefs.transport.from || null })),
    freeSeats: rides.reduce((n, r) => n + r.free, 0),
  };
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