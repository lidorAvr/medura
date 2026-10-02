// "הבית שלי" (SPEC §8.0, §16.2): pure helpers over my_overview() rows — no DOM, no store.
// Overview row shape: SPEC §16.1 / my_overview(). Every field is read defensively (an older
// server may send fewer keys).
import { formatMoney, tripPhase } from './logic.js?v=56bbb9a';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const time = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : Infinity;
};
const LIVE = new Set(['departure', 'during']);
const ACTIVE = new Set(['before', 'eve', 'departure']);

/** Cold start: the trip to open straight away — one in phase departure/during (the last opened, else the earliest). */
export function landingTrip(trips, lastTripId, now = new Date()) {
  const live = (trips || []).filter((e) => e?.trip && LIVE.has(tripPhase(e.trip, now)));
  if (!live.length) return null;
  const last = live.find((e) => e.trip.id === lastTripId);
  if (last) return last.trip.id;
  return [...live].sort((a, b) => time(a.trip.starts_at) - time(b.trip.starts_at))[0].trip.id;
}

/** How many answers wait for me in a trip (rides asks/invites, assignments, profile requests). */
export function answersOf(ov) {
  const a = ov?.answers || {};
  return num(a.ride_asks) + num(a.ride_invites) + num(a.assignments) + num(a.profile_requests);
}

const plural = (n, one, many) => (n === 1 ? one : `${n} ${many}`);

/** What I owe in a trip, one number for the tile and the card: the larger of my open requests and my balance. */
export function tripDebt(ov) {
  const req = num(ov?.owe?.total);
  const b = ov?.balance == null ? 0 : num(ov.balance);
  return Math.round(Math.max(req, b < -1 ? -b : 0) * 100) / 100;
}

function moneyThings(ov, base) {
  const out = [];
  const owe = ov.owe || {};
  const debt = tripDebt(ov);
  const b = ov.balance == null ? 0 : num(ov.balance);
  if (num(owe.count) > 0) {
    const first = (owe.items || [])[0];
    let text = num(owe.count) === 1 && first
      ? `💰 ${formatMoney(first.amount)}${first.to_name ? ` ל${first.to_name}` : ''}`
      : `💰 ${formatMoney(owe.total)} ב־${num(owe.count)} בקשות`;
    // the settle-up asks for more than the requests: say the whole number, the requests inside it
    if (debt > num(owe.total) + 1) text = `💸 עליך להעביר ${formatMoney(debt)} · מתוכם ${formatMoney(owe.total)} בבקשות`;
    out.push({
      key: 'owe', emoji: owe.overdue ? '⏰' : '💰', text: owe.overdue ? `${text} · ⏰ עבר המועד` : text,
      href: `${base}/money`, tone: owe.overdue ? 'danger' : 'warning',
    });
  } else if (debt > 1) {
    out.push({ key: 'balance', emoji: '💸', text: `💸 עליך להעביר ${formatMoney(debt)}`, href: `${base}/money`, tone: 'warning' });
  }
  if (b > 1) {
    out.push({ key: 'credit', emoji: '💚', text: `💚 מגיע לך ${formatMoney(b)} — תזכורת עדינה במסך הכסף`, href: `${base}/money`, tone: 'info' });
  }
  if (num(ov.confirm) > 0) {
    out.push({ key: 'confirm', emoji: '✅', text: `✅ ${plural(num(ov.confirm), 'העברה אחת לאשר', 'העברות לאשר')}`, href: `${base}/money`, tone: 'info' });
  }
  return out;
}

const ARRIVAL = {
  missing: '🚗 איך מגיעים? עוד לא סימנת',
  seeking: '🙋 עוד מחפש/ת טרמפ',
  waiting: '⏳ מחכה לתשובת הנהג/ת',
};

/** A trip card's most important things for me (≤3), phase-aware. Each: {key, emoji, text, href, tone}. */
export function cardThings(ov, now = new Date()) {
  if (!ov?.trip?.id) return [];
  const base = `#/t/${ov.trip.id}`;
  const phase = tripPhase(ov.trip, now);
  if (phase === 'during' || phase === 'past') return [];
  if (phase === 'after') return moneyThings(ov, base).slice(0, 3);
  const out = [];
  const answers = answersOf(ov);
  if (answers > 0) out.push({ key: 'answers', emoji: '📥', text: `📥 ${plural(answers, 'דבר אחד מחכה לתשובה שלך', 'מחכים לתשובה שלך')}`, href: base, tone: 'accent' });
  out.push(...moneyThings(ov, base));
  if (ov.arrival && ARRIVAL[ov.arrival]) {
    out.push({ key: 'arrival', emoji: ov.arrival === 'missing' ? '🚗' : ov.arrival === 'seeking' ? '🙋' : '⏳', text: ARRIVAL[ov.arrival], href: `${base}/rides`, tone: 'default' });
  }
  if (ov.flight_missing) out.push({ key: 'flight', emoji: '✈️', text: '✈️ איזו טיסה? עוד לא סימנת', href: `${base}/rides`, tone: 'default' });
  const open = ov.open || {};
  if (num(open.count) > 0) {
    const titles = (open.titles || []).filter(Boolean).slice(0, 3).join(', ');
    out.push({
      key: 'open', emoji: '🧺', text: `🧺 ${plural(num(open.count), 'דבר אחד עליך עוד לא מסומן', 'עליך עוד לא מסומנים')}${titles ? `: ${titles}` : ''}`,
      href: `${base}/lists?tab=mine`, tone: 'default',
    });
  }
  if (ov.took_nothing) out.push({ key: 'took_nothing', emoji: '🤲', text: '🤲 עוד לא לקחת כלום', href: `${base}/lists`, tone: 'default' });
  if (num(ov.polls) > 0) {
    out.push({ key: 'polls', emoji: '📊', text: num(ov.polls) === 1 ? '📊 סקר מחכה לקול שלך' : `📊 ${num(ov.polls)} סקרים מחכים לקול שלך`, href: `${base}/messages`, tone: 'default' });
  }
  return out.slice(0, 3);
}

const GAP_LABELS = {
  rides: 'לא סימנו הגעה',
  flights: 'לא סימנו טיסה',
  polls: 'לא הצביעו',
  lists: 'לא לקחו כלום',
  money: 'לא העבירו',
  rooms: 'בלי חדר',
};

/** Admins, before the trip: what waits for the admins — [{key, text, href}]. */
export function adminParts(ov, now = new Date()) {
  const info = ov?.admin && ov.admin_info;
  if (!info || !ACTIVE.has(tripPhase(ov.trip, now))) return [];
  const base = `#/t/${ov.trip.id}`;
  const out = [];
  if (num(info.proposed) > 0) out.push({ key: 'proposed', text: `${num(info.proposed)} לאישור`, href: `${base}/lists?tab=pending` });
  if (num(info.unclaimed_items) > 0) out.push({ key: 'unclaimed_items', text: `${num(info.unclaimed_items)} שאף אחד לא לקח`, href: `${base}/lists` });
  for (const g of info.gaps || []) {
    if (num(g?.missing) > 0 && GAP_LABELS[g.key]) out.push({ key: `gap:${g.key}`, text: `${num(g.missing)} ${GAP_LABELS[g.key]}`, href: base });
  }
  if (num(info.profile_requests) > 0) out.push({ key: 'profile_requests', text: num(info.profile_requests) === 1 ? 'בקשה אחת להצטרף' : `${num(info.profile_requests)} בקשות להצטרף`, href: `${base}/people` });
  if (num(info.invites_pending) > 0) out.push({ key: 'invites_pending', text: num(info.invites_pending) === 1 ? 'הזמנה אחת פתוחה' : `${num(info.invites_pending)} הזמנות פתוחות`, href: `${base}/people` });
  return out;
}

const PRIORITY = ['answers', 'owe', 'confirm', 'balance', 'credit', 'arrival', 'flight', 'open', 'took_nothing', 'polls'];

/**
 * "⚡ עכשיו חשוב" across trips: invites first (by trip date), then overdue money, then every card thing
 * of the trips that aren't over, by trip start (then priority). Each: {key, tripId, emoji, text, href, tone, at}.
 */
export function urgentStrip(overviews, invites, now = new Date()) {
  const out = [];
  const inv = [...(invites || [])].sort((a, b) => time(a?.trip?.starts_at) - time(b?.trip?.starts_at));
  for (const i of inv) {
    if (!i?.id) continue;
    out.push({
      key: `invite:${i.id}`, tripId: i.trip?.id || null, tripEmoji: i.trip?.emoji || '📨', emoji: '📨',
      text: `📨 ${i.invited_by_name || 'מישהו'} הזמין/ה אותך ל${i.trip?.name || 'טיול'}`,
      href: `#/invite/${i.id}`, tone: 'accent', at: i.trip?.starts_at || null,
    });
  }
  const rows = (overviews || []).filter((ov) => ov?.trip?.id && tripPhase(ov.trip, now) !== 'past');
  const overdue = [];
  const rest = [];
  for (const ov of rows) {
    for (const t of cardThings(ov, now)) {
      const item = { ...t, key: `${ov.trip.id}:${t.key}`, tripId: ov.trip.id, tripEmoji: ov.trip.emoji || '⛺', at: ov.trip.starts_at || null, prio: PRIORITY.indexOf(t.key) };
      (t.key === 'owe' && ov.owe?.overdue ? overdue : rest).push(item);
    }
  }
  rest.sort((a, b) => time(a.at) - time(b.at) || a.prio - b.prio);
  return [...out, ...overdue, ...rest].map(({ prio, ...t }) => t);
}

/** Header tiles: what I owe / am owed across trips, answers waiting, and the next trip. */
export function totals(overviews, now = new Date()) {
  let owe = 0;
  let owed = 0;
  let answers = 0;
  let next = null;
  for (const ov of overviews || []) {
    if (!ov?.trip) continue;
    const phase = tripPhase(ov.trip, now);
    const b = ov.balance == null ? 0 : num(ov.balance);
    if (phase !== 'past') {
      owe += tripDebt(ov);                        // the same number the trip's card says
      if (b > 1) owed += b;
    }
    answers += answersOf(ov);
    const start = time(ov.trip.starts_at);
    if (phase !== 'past' && phase !== 'after' && Number.isFinite(start) && (!next || start < time(next.trip.starts_at))) {
      next = { trip: ov.trip, label: '' };
    }
  }
  return { owe: Math.round(owe * 100) / 100, owed: Math.round(owed * 100) / 100, answers, next };
}

/** Order trip cards: live/upcoming first by start, then no-date; past ones separately. */
export function splitTrips(entries, now = new Date()) {
  const current = [];
  const past = [];
  for (const e of entries || []) {
    if (!e?.trip) continue;
    (tripPhase(e.trip, now) === 'past' ? past : current).push(e);
  }
  current.sort((a, b) => time(a.trip.starts_at) - time(b.trip.starts_at));
  past.sort((a, b) => time(b.trip.starts_at) - time(a.trip.starts_at));
  return { current, past };
}
