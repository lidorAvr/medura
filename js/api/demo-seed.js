// Demo data for the in-browser fake backend (SPEC §6, §7.2).
// Pure data + a builder: no storage, no randomness of its own (ids/codes are injected).

export const DEMO_VERSION = 2;

/** SPEC §6 default categories, sort 1..10. */
export const DEFAULT_CATEGORIES = Object.freeze([
  { emoji: '🥩', name: 'בשר ועוף' },
  { emoji: '🥗', name: 'ירקות ופירות' },
  { emoji: '🥫', name: 'מזווה ורטבים' },
  { emoji: '🍿', name: 'נשנושים ומתוקים' },
  { emoji: '🥤', name: 'שתייה ואלכוהול' },
  { emoji: '🔥', name: 'מנגל ובישול' },
  { emoji: '🍽️', name: 'חד־פעמי' },
  { emoji: '⛺', name: 'ציוד קבוצתי' },
  { emoji: '🎲', name: 'כיף ומשחקים' },
  { emoji: '📋', name: 'משימות' },
]);

/** SPEC §6 personal gear template (add_personal_template order). */
export const PERSONAL_TEMPLATE = Object.freeze([
  'אוהל',
  'מזרן / מזרן מתנפח + משאבה',
  'שק שינה / שמיכה',
  'כרית',
  'מגבת',
  'בגד ים',
  'כפכפים',
  'קרם הגנה',
  'כובע',
  'פנס ראש / פנס',
  'סוללה ניידת + מטען',
  'בגדים חמים ללילה',
  'ביגוד להחלפה',
  'מברשת שיניים ומשחה',
  'תרופות אישיות',
  'בקבוק מים אישי',
  'תעודה מזהה / כרטיסי כניסה',
]);

export const DEFAULT_TRIP_INFO = Object.freeze({ schedule: [], rules: [], notes: '' });
export const DEFAULT_TRIP_SETTINGS = Object.freeze({ require_approval: true });

export const SAMPLE_TRIP_NAME = 'טיול לדוגמה בכנרת 🌊';

// ---------- Asia/Jerusalem date helpers ----------

const TZ = 'Asia/Jerusalem';
let wallFmt = null;

function wallParts(ms) {
  if (!wallFmt) {
    wallFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  const out = {};
  for (const p of wallFmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

/** 'YYYY-MM-DD' of the given instant, in Asia/Jerusalem. */
export function jerusalemYmd(date = new Date()) {
  const p = wallParts(date.getTime());
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Add whole days to a 'YYYY-MM-DD' calendar date. */
export function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** ISO instant for a wall-clock time on a calendar date in Asia/Jerusalem (DST aware). */
export function jerusalemIso(ymd, hh, mm = 0) {
  const [y, m, d] = ymd.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = wallParts(guess);
    const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const next = target - (wallAsUtc - guess);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString();
}

// ---------- the sample trip ----------

/**
 * Build a fresh demo database containing the sample trip.
 * @param {object} o
 * @param {string} o.userId   demo auth user linked as owner of "נועה ואיתי"
 * @param {() => string} o.newId    uuid generator
 * @param {() => string} o.newCode  10-char invite/device code generator
 * @param {Date} [o.now]
 */
export function buildDemoSeed({ userId, newId, newCode, now = new Date() }) {
  const nowMs = now.getTime();
  let tick = 0;
  // Deterministic, strictly increasing "created" timestamps spread over the last 3 days.
  const past = (hoursAgo) => new Date(nowMs - hoursAgo * 3600e3 + tick++).toISOString();

  const startYmd = addDaysYmd(jerusalemYmd(now), 4);
  const tripId = newId();
  const created = past(72);

  const trip = {
    id: tripId,
    name: SAMPLE_TRIP_NAME,
    emoji: '🌊',
    location: 'חוף צאלון, כנרת',
    location_url: 'https://waze.com/ul?q=%D7%97%D7%95%D7%A3%20%D7%A6%D7%90%D7%9C%D7%95%D7%9F&navigate=yes',
    lat: 32.8625,
    lon: 35.5647,
    starts_at: jerusalemIso(startYmd, 9, 0),
    ends_at: jerusalemIso(addDaysYmd(startYmd, 1), 11, 0),
    info: {
      schedule: [
        { time: '09:00', label: 'יוצאים מהמרכז (נפגשים בחניון)', emoji: '🚗' },
        { time: '11:00', label: 'הקמת המאהל', emoji: '⛺' },
        { time: '13:00', label: 'על האש — צהריים', emoji: '🔥' },
        { time: '16:00', label: 'מים, סאפ ומנוחה', emoji: '🏊' },
        { time: '19:30', label: 'על האש — ערב', emoji: '🔥' },
        { time: '22:00', label: 'מדורה, גיטרה ומרשמלו', emoji: '🌙' },
        { time: '08:30', label: 'שקשוקה לבוקר (למחרת)', emoji: '🍳' },
      ],
      rules: [
        { emoji: '🗑️', text: 'משאירים את החוף נקי יותר ממה שמצאנו' },
        { emoji: '🔥', text: 'מדורה רק בפינה המסומנת, ומכבים עם מים בסוף' },
        { emoji: '💧', text: 'לפחות 3 ליטר מים לאדם — חם שם!' },
        { emoji: '🤫', text: 'שקט אחרי 23:00 — יש שכנים באזור' },
      ],
      notes: 'חניה בחוף ₪30 לרכב — מתחלקים לפי רכבים. מי שמגיע/ה מאוחר — להודיע בקבוצה 🙏',
    },
    settings: { require_approval: true },
    invite_code: newCode(),
    rev: 1,
    created_by: userId,
    created_at: created,
    updated_at: created,
  };

  // ----- members (units) -----
  const M = {};
  const members = [];
  const addMember = (key, m) => {
    const row = {
      id: newId(),
      trip_id: tripId,
      display_name: m.display_name,
      headcount: m.headcount,
      people: m.people,
      emoji: m.emoji,
      color: m.color,
      role: m.role || 'member',
      phone: m.phone || null,
      prefs: m.prefs || {},
      inventory: m.inventory || [],
      claimed_at: m.unclaimed ? null : past(m.hoursAgo),
      created_at: past(m.hoursAgo),
    };
    M[key] = row;
    members.push(row);
  };
  addMember('noa', {
    display_name: 'נועה ואיתי', headcount: 2, people: ['נועה', 'איתי'], emoji: '🦊', color: '#2F6B4F',
    role: 'owner', phone: '0500000001', hoursAgo: 72,
    inventory: ['מנגל', 'כסאות ים', 'מטקות', 'צידנית'],
    prefs: { diet: 'איתי צמחוני 🥦', notify: { announcements: true, assignments: true, money: true, reminders: true } },
  });
  addMember('maya', {
    display_name: 'מאיה ורון', headcount: 2, people: ['מאיה', 'רון'], emoji: '🐻', color: '#F28C28',
    role: 'admin', phone: '0500000002', hoursAgo: 70,
    inventory: ['גזיבו', 'מלקחיים', 'מחבת', 'פקל קפה'],
  });
  addMember('yoav', {
    display_name: 'יואב', headcount: 1, people: ['יואב'], emoji: '🎸', color: '#3A86FF',
    phone: '0500000003', hoursAgo: 60, inventory: ['רמקול', 'כדור', 'כסאות ים'],
  });
  addMember('shira', {
    display_name: 'שירה וטל', headcount: 2, people: ['שירה', 'טל'], emoji: '🌙', color: '#8E44AD',
    phone: '0500000004', hoursAgo: 50, inventory: ['מחצלת', 'שש בש', 'קלפים', 'פנס/תאורה'],
    prefs: { diet: 'אוהבת יין מבעבע 🥂' },
  });
  addMember('uri', {
    display_name: 'אורי', headcount: 1, people: ['אורי'], emoji: '🦔', color: '#16A085',
    hoursAgo: 45, unclaimed: true, inventory: ['נפנף'],
  });

  const memberUsers = [{ user_id: userId, trip_id: tripId, member_id: M.noa.id, created_at: created }];

  // ----- categories -----
  const defaultBuyers = { '🥩': 'maya', '🥗': 'maya', '🥫': 'maya', '🥤': 'yoav', '🔥': 'noa' };
  const C = {};
  const categories = DEFAULT_CATEGORIES.map((c, i) => {
    const row = {
      id: newId(),
      trip_id: tripId,
      name: c.name,
      emoji: c.emoji,
      sort: i + 1,
      default_buyer_id: defaultBuyers[c.emoji] ? M[defaultBuyers[c.emoji]].id : null,
      note: null,
      created_at: created,
    };
    C[c.emoji] = row;
    return row;
  });

  // ----- items + pledges -----
  const items = [];
  const pledges = [];
  const I = {};
  let sort = 0;
  const addItem = (key, cat, it) => {
    const at = past(it.hoursAgo ?? 66 - sort);
    const creatorKey = it.by || 'noa';
    const creator = M[creatorKey];
    const status = it.status || 'active';
    // Admin-created items are self-approved; members' active items were approved by מאיה.
    const approverKey = it.approvedBy || (creator.role === 'member' ? 'maya' : creatorKey);
    const row = {
      id: newId(),
      trip_id: tripId,
      category_id: cat ? C[cat].id : null,
      title: it.title,
      note: it.note || null,
      type: it.type,
      qty: it.qty ?? null,
      unit: it.unit || null,
      per_person: Boolean(it.per_person),
      needed: it.needed || 1,
      status,
      done: Boolean(it.done),
      done_at: it.done ? past(10) : null,
      reject_reason: it.reject_reason || null,
      created_by: creator.id,
      approved_by: status === 'active' ? M[approverKey].id : null,
      sort: ++sort,
      created_at: at,
      updated_at: at,
    };
    I[key] = row;
    items.push(row);
    for (const p of it.pledges || []) {
      pledges.push({
        id: newId(),
        trip_id: tripId,
        item_id: row.id,
        member_id: M[p.m].id,
        qty: p.qty || 1,
        done: Boolean(p.done),
        assigned_by: p.assignedBy ? M[p.assignedBy].id : null,
        created_at: past(40 - pledges.length * 0.5),
      });
    }
    return row;
  };

  // 🥩 meat (buy)
  addItem('steak', '🥩', { title: 'סטייק אנטריקוט', type: 'buy', qty: 300, unit: 'גרם', per_person: true, by: 'maya', pledges: [{ m: 'maya' }] });
  addItem('pargiot', '🥩', { title: 'פרגיות', type: 'buy', qty: 400, unit: 'גרם', per_person: true, by: 'maya', done: true, pledges: [{ m: 'maya' }] });
  addItem('hotdogs', '🥩', { title: 'נקניקיות', type: 'buy', qty: 2, unit: 'חבילות' });
  addItem('wings', '🥩', { title: 'כנפיים', type: 'buy', qty: 1, unit: 'ק"ג', note: 'אם אוהבים 🍗', status: 'proposed', by: 'shira', hoursAgo: 20 });
  // 🥗 veg & fruit (buy)
  addItem('tomatoes', '🥗', { title: 'עגבניות', type: 'buy', qty: 12, unit: 'יח׳', by: 'maya', done: true, pledges: [{ m: 'maya' }] });
  addItem('watermelon', '🥗', { title: 'אבטיח', type: 'buy', qty: 1, unit: 'יח׳', note: 'גדול וקר 🍉' });
  addItem('salads', '🥗', { title: 'סלטים מוכנים', type: 'buy', note: 'חומוס, טחינה, מטבוחה, סלט טורקי', pledges: [{ m: 'noa' }] });
  // 🥫 pantry (buy)
  addItem('pita', '🥫', { title: 'פיתות', type: 'buy', qty: 40, unit: 'יח׳', by: 'maya', pledges: [{ m: 'maya' }] });
  addItem('eggs', '🥫', { title: 'ביצים', type: 'buy', qty: 2, unit: 'חבילות', note: 'לשקשוקה של הבוקר' });
  // 🍿 snacks (buy)
  addItem('snacks', '🍿', { title: 'חטיפים', type: 'buy', qty: 12, unit: 'יח׳', by: 'yoav', approvedBy: 'noa', done: true, pledges: [{ m: 'yoav' }] });
  addItem('marshmallow', '🍿', { title: 'מרשמלו למדורה', type: 'buy', qty: 3, unit: 'חבילות', note: 'למדורה בלילה 🔥', status: 'proposed', by: 'yoav', hoursAgo: 8 });
  // 🥤 drinks (buy)
  addItem('water', '🥤', { title: 'מים', type: 'buy', qty: 3, unit: 'שישיות', by: 'yoav', approvedBy: 'noa', pledges: [{ m: 'yoav' }] });
  addItem('beer', '🥤', { title: 'בירות', type: 'buy', qty: 24, unit: 'בקבוקים', by: 'yoav', approvedBy: 'noa', pledges: [{ m: 'yoav' }] });
  addItem('wine', '🥤', { title: 'יין לבן מבעבע', type: 'buy', qty: 2, unit: 'בקבוקים', note: 'כי שירה אוהבת 🥂' });
  // 🔥 grill & cooking
  addItem('coals', '🔥', { title: 'פחמים', type: 'buy', qty: 3, unit: 'חבילות', pledges: [{ m: 'noa' }] });
  addItem('grill', '🔥', { title: 'מנגל עם רשת', type: 'bring', needed: 1, pledges: [{ m: 'noa', done: true }] });
  addItem('tongs', '🔥', { title: 'מלקחיים', type: 'bring', needed: 2, by: 'maya', pledges: [{ m: 'maya' }] });
  addItem('spices', '🔥', { title: 'תבלינים', type: 'bring', needed: 1, note: 'מלח, פלפל שחור, פפריקה, תבלין על האש', by: 'maya', pledges: [{ m: 'shira' }] });
  addItem('cutting', '🔥', { title: 'קרש חיתוך + סכין + מזלג', type: 'each', note: 'כל זוג/יחיד מביא סט משלו', pledges: [{ m: 'noa', done: true }, { m: 'maya', done: true }] });
  // 🍽️ disposables (buy)
  addItem('plates', '🍽️', { title: 'צלחות גדולות', type: 'buy', qty: 50, unit: 'יח׳', by: 'shira', approvedBy: 'maya', pledges: [{ m: 'shira' }] });
  // ⛺ group gear (bring)
  addItem('chairs', '⛺', { title: 'כסאות קמפינג', type: 'bring', needed: 8, note: 'כל מי שיש — שיביא!', pledges: [{ m: 'noa', qty: 2 }, { m: 'yoav', qty: 1 }, { m: 'shira', qty: 2 }] });
  addItem('gazebo', '⛺', { title: 'גזיבו', type: 'bring', needed: 1, note: 'הצל היחיד בחוף ☀️', by: 'maya', pledges: [{ m: 'maya', done: true }] });
  addItem('mats', '⛺', { title: 'מחצלות', type: 'bring', needed: 2 });
  addItem('speaker', '⛺', { title: 'רמקול נייד', type: 'bring', needed: 1, status: 'rejected', by: 'yoav', reject_reason: 'סיכמנו בלי מוזיקה בקול רם — יש שכנים 🤫', hoursAgo: 30 });
  addItem('headlamp', '⛺', { title: 'פנס ראש', type: 'each', note: 'לכל אחד/ת — חושך מוחלט בלילה' });
  // 🎲 fun (bring)
  addItem('matkot', '🎲', { title: 'מטקות', type: 'bring', needed: 2, pledges: [{ m: 'yoav', qty: 1 }, { m: 'noa', qty: 1 }] });
  addItem('backgammon', '🎲', { title: 'שש בש + קלפים', type: 'bring', needed: 1, pledges: [{ m: 'uri', assignedBy: 'maya' }] });
  // 📋 tasks
  addItem('table', '📋', { title: 'לשריין שולחן פיקניק ליד המים', type: 'task', by: 'maya', done: true, pledges: [{ m: 'maya' }] });
  addItem('forecast', '📋', { title: 'לבדוק תחזית ולעדכן בקבוצה', type: 'task', pledges: [{ m: 'noa' }] });
  addItem('tickets', '📋', { title: 'להזמין כרטיסי כניסה לחוף', type: 'task', note: 'דרך האתר של החוף, עד יום לפני' });
  // uncategorized
  addItem('sunscreen', null, { title: 'קרם הגנה משותף', type: 'bring', needed: 1, by: 'shira', approvedBy: 'noa', pledges: [{ m: 'shira' }] });

  // ----- money -----
  const expenses = [];
  const expenseShares = [];
  const addExpense = (e) => {
    const row = {
      id: newId(),
      trip_id: tripId,
      title: e.title,
      amount: e.amount,
      paid_by: M[e.paid_by].id,
      category_id: e.cat ? C[e.cat].id : null,
      note: e.note || null,
      split_mode: e.shares ? 'members' : 'all',
      created_by: M[e.created_by || e.paid_by].id,
      spent_on: jerusalemYmd(new Date(nowMs - e.hoursAgo * 3600e3)),
      created_at: past(e.hoursAgo),
    };
    expenses.push(row);
    for (const s of e.shares || []) {
      expenseShares.push({ expense_id: row.id, trip_id: tripId, member_id: M[s.m].id, weight: s.weight });
    }
  };
  addExpense({ title: 'קניות בשר — הקצביה בכפר', amount: 640, paid_by: 'maya', cat: '🥩', hoursAgo: 26 });
  addExpense({ title: 'שתייה וקרח', amount: 210, paid_by: 'yoav', cat: '🥤', hoursAgo: 24 });
  addExpense({
    title: 'חניה בחוף (3 רכבים)', amount: 90, paid_by: 'noa', note: 'מתחלקים לפי רכב', hoursAgo: 12,
    shares: [{ m: 'noa', weight: 1 }, { m: 'maya', weight: 1 }, { m: 'shira', weight: 1 }],
  });

  const payments = [
    {
      id: newId(), trip_id: tripId, from_member: M.shira.id, to_member: M.maya.id, amount: 150, method: 'bit',
      note: 'על הבשר 🥩', status: 'confirmed', created_by: M.shira.id, created_at: past(9), confirmed_at: past(7),
    },
    {
      id: newId(), trip_id: tripId, from_member: M.shira.id, to_member: M.yoav.id, amount: 90, method: 'paybox',
      note: null, status: 'sent', created_by: M.shira.id, created_at: past(5), confirmed_at: null,
    },
  ];

  // ----- notifications -----
  const notifications = [];
  const reads = [];
  const note = (n) => {
    const row = {
      id: newId(),
      trip_id: tripId,
      kind: n.kind || 'system',
      title: n.title,
      body: n.body || null,
      audience: n.audience ? n.audience.map((k) => M[k].id) : null,
      author_member: n.author ? M[n.author].id : null,
      urgent: Boolean(n.urgent),
      link: n.link || null,
      created_at: past(n.hoursAgo),
    };
    notifications.push(row);
    for (const k of n.readBy || []) {
      reads.push({ notification_id: row.id, trip_id: tripId, member_id: M[k].id, read_at: past(n.hoursAgo - 0.5) });
    }
    return row;
  };
  const link = (tail) => `#/t/${tripId}/${tail}`;
  note({ title: 'יואב הצטרפ/ה לטיול 🎉', audience: ['noa', 'maya'], link: link('people'), hoursAgo: 60, readBy: ['noa', 'maya'] });
  note({ title: 'שירה וטל הצטרפ/ה לטיול 🎉', audience: ['noa', 'maya'], link: link('people'), hoursAgo: 50, readBy: ['maya'] });
  note({ title: 'ההצעה נדחתה: רמקול נייד', body: I.speaker.reject_reason, audience: ['yoav'], link: link(`lists?item=${I.speaker.id}`), hoursAgo: 29, readBy: ['yoav'] });
  note({ title: 'שובצת: שש בש + קלפים', audience: ['uri'], link: link(`lists?item=${I.backgammon.id}`), hoursAgo: 28 });
  note({ title: 'הצעה חדשה: כנפיים', body: 'שירה וטל הציע/ה להוסיף לרשימה', audience: ['noa', 'maya'], link: link(`lists?item=${I.wings.id}`), hoursAgo: 20, readBy: ['maya'] });
  note({
    kind: 'announcement', author: 'maya', title: 'יוצאים ב-09:00 מהחניון 🚗',
    body: 'מי שצריך/ה טרמפ — לכתוב לי עד מחר בערב. להביא כובע, מים וחיוך ☀️',
    hoursAgo: 18, readBy: ['maya', 'yoav', 'shira'],
  });
  note({ title: 'שירה וטל סימן/ה שהעביר/ה לך ₪90', audience: ['yoav'], link: link('money'), hoursAgo: 5 });
  note({ title: 'הצעה חדשה: מרשמלו למדורה', body: 'יואב הציע/ה להוסיף לרשימה', audience: ['noa', 'maya'], link: link(`lists?item=${I.marshmallow.id}`), hoursAgo: 8 });
  note({
    kind: 'announcement', author: 'noa', audience: ['yoav', 'shira'], urgent: true,
    title: 'חסרים כסאות ומחצלות 🪑',
    body: 'חסרים עוד 3 כסאות ו-2 מחצלות. מי שיש לו/ה בבית — לסמן ברשימה 🙏',
    hoursAgo: 3, readBy: ['noa', 'shira'],
  });

  // ----- admin votes, polls, personal -----
  const adminVotes = [
    { trip_id: tripId, voter_id: M.yoav.id, candidate_id: M.shira.id, created_at: past(40) },
    { trip_id: tripId, voter_id: M.maya.id, candidate_id: M.shira.id, created_at: past(39) },
    { trip_id: tripId, voter_id: M.shira.id, candidate_id: M.yoav.id, created_at: past(38) },
  ];

  const pollId = newId();
  const polls = [
    {
      id: pollId, trip_id: tripId, question: 'מה עושים בלילה אחרי על האש? 🌙',
      options: [
        { id: 'o1', label: 'מדורה ושירים 🎸' },
        { id: 'o2', label: 'טורניר קלפים 🃏' },
        { id: 'o3', label: 'טבילת לילה בכנרת 🌊' },
      ],
      multi: false, closed: false, created_by: M.maya.id, created_at: past(16),
    },
  ];
  const pollVotes = [
    { poll_id: pollId, trip_id: tripId, member_id: M.maya.id, option_id: 'o1' },
    { poll_id: pollId, trip_id: tripId, member_id: M.yoav.id, option_id: 'o3' },
    { poll_id: pollId, trip_id: tripId, member_id: M.shira.id, option_id: 'o1' },
  ];

  const personal = [];
  const addPersonal = (m, title, done) =>
    personal.push({ id: newId(), trip_id: tripId, member_id: M[m].id, title, done, sort: personal.length + 1, created_at: past(15 - personal.length * 0.1) });
  addPersonal('noa', 'אוהל', true);
  addPersonal('noa', 'שק שינה / שמיכה', true);
  addPersonal('noa', 'מגבת', false);
  addPersonal('noa', 'קרם הגנה', false);
  addPersonal('noa', 'פנס ראש / פנס', false);
  addPersonal('maya', 'משקפת לציפורים', false);

  // ----- rides: מאיה ורון drive from Tel Aviv, יואב rides with them -----
  const rideId = newId();
  const rides = [{
    id: rideId, trip_id: tripId, driver_member: M.maya.id, seats: 3, from_text: 'תל אביב — רכבת השלום',
    depart_at: jerusalemIso(startYmd, 7, 30), note: 'יש מקום לצידנית אחת 🧊', created_at: past(40),
  }];
  const rideSeats = [{ ride_id: rideId, trip_id: tripId, member_id: M.yoav.id, seats: 1, status: 'approved', requested_by: 'passenger', created_at: past(38) }];

  return {
    version: DEMO_VERSION,
    trips: [trip],
    members,
    member_secrets: [],
    member_users: memberUsers,
    categories,
    items,
    pledges,
    expenses,
    expense_shares: expenseShares,
    payments,
    notifications,
    notification_reads: reads,
    admin_votes: adminVotes,
    polls,
    poll_votes: pollVotes,
    personal_items: personal,
    push_subscriptions: [],
    rides,
    ride_seats: rideSeats,
    // טל asks to join שירה וטל from her own phone (she's listed in that profile)
    profile_requests: [{
      id: newId(), trip_id: tripId, member_id: M.shira.id, user_id: newId(), email: 'tal@example.com', person: 'טל',
      name: 'טל', from_member: null, status: 'pending', created_at: past(5), answered_at: null,
    }],
  };
}
