// Pure client helpers for flights (design §4.3 / §4.7): the normalized record the `flight` edge function
// returns (and snapshot.flights carries), turned into short Hebrew lines. No network, no DOM.
// Times are the airport's own wall clock ('2026-10-01T10:10+03:00' → "10:10") — never converted.

const DAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const NUMBER_RE = /^[A-Z0-9]{2}[0-9]{1,4}[A-Z]?$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Minutes a flight must move before we call it late / early. */
export const LATE_MIN = 15;

/** "ly 315" / "LY-315" → "LY315" (no validation). */
export function flightCode(v) {
  return String(v ?? '').toUpperCase().replace(/[\s\-–.]/g, '');
}

/** A usable flight number (after flightCode)? */
export function isFlightNumber(v) {
  return NUMBER_RE.test(flightCode(v));
}

/** 'YYYY-MM-DD' that is a real calendar date? */
export function isYmd(v) {
  if (typeof v !== 'string' || !YMD_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Both parts of a lookup are complete — only then may we spend quota on it. */
export function canLookup(number, date) {
  return isFlightNumber(number) && isYmd(date);
}

/** '2026-10-01T10:10+03:00' → '2026-10-01T10:10' (the local wall clock, for datetime-local fields). */
export function wallOf(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(iso || ''));
  return m ? `${m[1]}T${m[2]}` : null;
}

/** '…T10:10…' → '10:10' */
export function hmOf(iso) {
  const w = wallOf(iso);
  return w ? w.slice(11, 16) : '';
}

/** '2026-10-01T…' → '2026-10-01' */
export function ymdOf(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || ''));
  return m ? m[1] : null;
}

/** '2026-10-01…' → "ה׳ 1.10" */
export function dayLabel(iso) {
  const d = ymdOf(iso);
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return `${DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()]} ${day}.${m}`;
}

/** Best known time of one side: best ?? sched. */
export function bestTime(side) {
  return (side && (side.best || side.sched)) || null;
}

function ms(iso) {
  return iso ? Date.parse(String(iso)) : NaN;
}

/** Minutes the departure moved (best − sched): +55 late, −20 early, 0 on time, null when unknown. */
export function delayMinutes(flight) {
  const s = ms(flight?.dep?.sched);
  const b = ms(bestTime(flight?.dep));
  if (!Number.isFinite(s) || !Number.isFinite(b)) return null;
  return Math.round((b - s) / 60000);
}

/** " · T3 · שער B7" parts for a side (only what is known). */
function gateBits(side) {
  return [side?.terminal ? `T${side.terminal}` : null, side?.gate ? `שער ${side.gate}` : null].filter(Boolean);
}

/**
 * The live state of a flight → { tone: 'ok'|'late'|'bad'|'air'|'done'|'unknown', emoji, label, text }.
 * text is the one-line status: "🟢 בזמן · T3 · שער B7" / "🟠 עיכוב · 11:05 (במקום 10:10)" / "🔴 בוטלה".
 */
export function flightStatus(flight) {
  if (!flight || typeof flight !== 'object') return { tone: 'unknown', emoji: '⚪', label: 'אין עדיין עדכון', text: '⚪ אין עדיין עדכון' };
  const st = String(flight.status || 'Unknown');
  const dep = flight.dep || {};
  const arr = flight.arr || {};
  const make = (tone, emoji, label, extra = []) => {
    const parts = [label, ...extra].filter(Boolean);
    return { tone, emoji, label, text: `${emoji} ${parts.join(' · ')}` };
  };
  if (st === 'Canceled' || st === 'CanceledUncertain') return make('bad', '🔴', st === 'Canceled' ? 'בוטלה' : 'כנראה בוטלה');
  if (st === 'Diverted') return make('bad', '🔴', 'הוסטה לשדה אחר');
  if (st === 'Arrived') {
    const t = hmOf(bestTime(arr));
    return make('done', '✅', 'נחתה', [t || null, ...gateBits({ terminal: arr.terminal }), arr.belt ? `מסוע ${arr.belt}` : null]);
  }
  if (st === 'Departed' || st === 'EnRoute' || st === 'Approaching') {
    const t = hmOf(bestTime(arr));
    return make('air', '🛫', st === 'Approaching' ? 'בנחיתה' : 'באוויר', [t ? `נחיתה ${t}` : null]);
  }
  const delay = delayMinutes(flight);
  const was = hmOf(dep.sched);
  const now = hmOf(bestTime(dep));
  if (delay != null && delay >= LATE_MIN) return make('late', '🟠', 'עיכוב', [`${now} (במקום ${was})`, ...gateBits(dep)]);
  if (delay != null && delay <= -LATE_MIN) return make('late', '🟠', 'מקדימה', [`${now} (במקום ${was})`, ...gateBits(dep)]);
  if (st === 'Delayed') return make('late', '🟠', 'עיכוב', [now || null, ...gateBits(dep)]);
  if (st === 'GateClosed') return make('late', '🟠', 'השער נסגר', gateBits(dep));
  if (st === 'Boarding') return make('ok', '🟢', 'עלייה למטוס', gateBits(dep));
  if (st === 'CheckIn') return make('ok', '🟢', 'צ׳ק־אין פתוח', [dep.checkin ? `דלפק ${dep.checkin}` : null, ...gateBits(dep)]);
  if (st === 'Unknown' && !dep.sched) return make('unknown', '⚪', 'אין עדיין עדכון');
  return make('ok', '🟢', 'בזמן', gateBits(dep));
}

/** "El Al · TLV T3 10:10 → LHR T4 13:35" (+ " · עם עצירה" for a multi-leg flight). */
export function flightLine(flight) {
  if (!flight) return '';
  const side = (s) => [s?.iata, s?.terminal ? `T${s.terminal}` : null, hmOf(s?.sched) || null].filter(Boolean).join(' ');
  const route = `${side(flight.dep)} → ${side(flight.arr)}`;
  return [flight.airline?.name, route, Number(flight.legs) > 1 ? 'עם עצירה' : null].filter(Boolean).join(' · ');
}

/** "עודכן לפני 12 דק׳" — from a snapshot row's checked_at (or the record's `updated`). */
export function updatedAgo(at, now = new Date()) {
  const t = ms(at);
  if (!Number.isFinite(t)) return '';
  const min = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (min < 1) return 'עודכן עכשיו';
  if (min < 60) return `עודכן לפני ${min} דק׳`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? 'עודכן לפני שעה' : `עודכן לפני ${h} שע׳`;
  const d = Math.round(h / 24);
  return d === 1 ? 'עודכן אתמול' : `עודכן לפני ${d} ימים`;
}

/** "London (LHR)" — where one side of a flight is, in words (city, else the airport's name, + its code). */
export function sidePlace(side) {
  if (!side) return '';
  const name = side.city || side.name || '';
  return name && side.iata && name !== side.iata ? `${name} (${side.iata})` : name || side.iata || '';
}

/** Where a flight goes: "London (LHR)" from a looked-up record, else what was saved on a leg / a booking. */
export function flightDest(flightOrLeg) {
  if (!flightOrLeg) return '';
  if (flightOrLeg.arr) return sidePlace(flightOrLeg.arr);
  return String(flightOrLeg.to || flightOrLeg.to_iata || '').trim();
}

const FAR_KM = 400;
function distKm(aLat, aLon, bLat, bLon) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLon - aLon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * Does a flight fit the trip? → warnings [{kind: 'place' | 'date', text}] ([] = it fits, or we can't tell):
 *  - place: the trip has coordinates and the flight's far end (out: where it lands; back: where it takes off) is
 *    more than 400 km from them ("LY315 נוחתת ב-London — הטיול בבוקרשט");
 *  - date: the flight's day is more than a day from the trip's first day (out) / last day (back).
 * flight = a looked-up record (or null — then only `date` is checked); days = {out, back} (the trip's first / last
 * day, 'YYYY-MM-DD').
 */
export function flightFit({ flight = null, trip = null, leg = 'out', date = null, days = null } = {}) {
  const out = [];
  const back = leg === 'back';
  const far = back ? flight?.dep : flight?.arr;
  const [tLat, tLon, fLat, fLon] = [num(trip?.lat), num(trip?.lon), num(far?.lat), num(far?.lon)];
  if ([tLat, tLon, fLat, fLon].every(Number.isFinite) && distKm(tLat, tLon, fLat, fLon) > FAR_KM) {
    const where = sidePlace(far) || 'מקום אחר';
    const place = String(trip?.location || '').trim();
    // "הטיול בבוקרשט" / "הטיול ב-Bucharest" (a name that isn't in Hebrew takes the hyphen)
    const trail = place ? ` — הטיול ב${/^[֐-׿]/.test(place) ? '' : '-'}${place}` : ' — רחוק מיעד הטיול';
    out.push({ kind: 'place', text: `${back ? 'הטיסה ממריאה מ-' : 'הטיסה נוחתת ב-'}${where}${trail}` });
  }
  const day = ymdOf(flight?.dep?.sched) || (isYmd(date) ? date : null);
  const want = days?.[back ? 'back' : 'out'] || null;
  if (day && isYmd(want)) {
    const diff = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${want}T00:00:00Z`)) / 86400000);
    if (Math.abs(diff) > 1) {
      out.push({ kind: 'date', text: `הטיסה ב-${dayLabel(day)} — הטיול ${back ? 'מסתיים' : 'מתחיל'} ב-${dayLabel(want)}` });
    }
  }
  return out;
}

/** 'YYYY-MM-DD' of a booking / travel leg ({date} or the date part of {at}), or null. */
export function legDate(leg) {
  if (!leg) return null;
  if (isYmd(leg.date)) return leg.date;
  const d = ymdOf(leg.at);
  return d && isYmd(d) ? d : null;
}

/** snapshot.flights row of a flight (number + date), or null. Accepts a leg/booking or (number, date). */
export function findFlight(snap, numberOrLeg, date) {
  const leg = typeof numberOrLeg === 'object' && numberOrLeg ? numberOrLeg : { flight: numberOrLeg, date };
  const n = flightCode(leg.flight || leg.number);
  const d = typeof numberOrLeg === 'object' ? legDate(leg) : (isYmd(date) ? date : null);
  if (!n || !d) return null;
  const rows = Array.isArray(snap?.flights) ? snap.flights : [];
  return rows.find((r) => r && flightCode(r.number) === n && String(r.date || '').slice(0, 10) === d) || null;
}

/**
 * The fields a lookup fills in a group flight booking (design §4.7): airline, from/to (city), at / arr_at
 * (local wall clock), terminal, from_iata / to_iata, date. Fields stay editable afterwards.
 */
export function bookingFromFlight(flight) {
  if (!flight) return {};
  const dep = flight.dep || {};
  const arr = flight.arr || {};
  const out = {
    flight: flightCode(flight.number),
    date: ymdOf(dep.sched) || (isYmd(flight.date) ? flight.date : null),
    airline: flight.airline?.name || null,
    at: wallOf(dep.sched),
    arr_at: wallOf(arr.sched),
    from: dep.city || dep.name || dep.iata || null,
    to: arr.city || arr.name || arr.iata || null,
    from_iata: dep.iata || null,
    to_iata: arr.iata || null,
    terminal: dep.terminal || null,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null && v !== ''));
}

/** A member's own leg (prefs.travel.out/back) from a lookup: {flight, date, at, from, to} (as the welcome saves). */
export function travelFromFlight(flight) {
  if (!flight) return null;
  const b = bookingFromFlight(flight);
  return { flight: b.flight, date: b.date || null, at: b.at || null, from: b.from_iata || null, to: b.to_iata || null };
}
