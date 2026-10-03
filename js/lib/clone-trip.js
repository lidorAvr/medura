// "🔁 לעושים את זה שוב" — a new trip from an old one: its structure (type, features, place, schedule, rules, lists, tasks, packing,
// categories in order) without what belonged to that one trip (the people, who took what, ticks, bookings, costs, rooms, the
// money, the album). Built from the old trip's snapshot and sent through the same calls the new-trip wizard uses, so the
// server needs nothing new. The caller becomes the owner of the new trip; the group is invited from "מטיולים קודמים".
import { ilIso, ilWall } from './logic.js?v=5ff55d3';

const DAY_MS = 86400000;
const HM = /^\d{2}:\d{2}$/;

/** The new trip's dates: it starts on `startYmd` at the old start's time, and lasts as long as the old one did. */
export function clonedDates(trip, startYmd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startYmd || ''))) return { starts_at: null, ends_at: null };
  if (!trip?.starts_at) return { starts_at: ilIso(startYmd, '00:00'), ends_at: null };      // the old trip had no dates: the typed one still counts
  const oldStart = new Date(trip.starts_at);
  const hm = ilWall(oldStart).hm;
  const starts = ilIso(startYmd, HM.test(hm) ? hm : '00:00');
  const dur = trip.ends_at ? new Date(trip.ends_at).getTime() - oldStart.getTime() : null;
  return { starts_at: starts, ends_at: dur !== null && dur > 0 ? new Date(new Date(starts).getTime() + dur).toISOString() : null };
}

/** Settings of the old trip without what points at its own people or money: the guest of honour, the exempt, the pot. */
export function clonedSettings(settings) {
  const s = JSON.parse(JSON.stringify(settings || {}));
  delete s.groom;
  if (s.money && typeof s.money === 'object') {
    delete s.money.exempt;
    delete s.money.pot;
  }
  return s;
}

/**
 * Everything the clone needs from the old snapshot: {payload (create_trip), profile, items (add_items_bulk)}.
 * `name` and `startYmd` ('YYYY-MM-DD', optional) come from the sheet.
 */
export function cloneModel(snap, { name, startYmd = '' } = {}) {
  const trip = snap?.trip || {};
  const me = (snap?.members || []).find((m) => m.id === snap?.me?.member_id) || {};
  const cats = [...(snap?.categories || [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const catOf = new Map(cats.map((c) => [c.id, c]));
  const info = trip.info || {};
  const dates = clonedDates(trip, startYmd);
  const payload = {
    name: String(name || `${trip.name || 'טיול'} — שוב`).trim().slice(0, 60),
    emoji: trip.emoji || '⛺',
    location: trip.location || null,
    ...(trip.lat != null && trip.lon != null ? { lat: trip.lat, lon: trip.lon } : {}),
    ...(trip.address ? { address: trip.address } : {}),
    ...dates,
    settings: clonedSettings(trip.settings),
    info: {
      schedule: Array.isArray(info.schedule) ? info.schedule : [],
      rules: Array.isArray(info.rules) ? info.rules : [],
      notes: info.notes || '',
      ...(Array.isArray(info.packing) ? { packing: info.packing } : {}),
    },
    categories: cats.length
      ? cats.slice(0, 20).map((c) => ({ name: c.name, emoji: c.emoji || '📦', ...(c.secret ? { secret: true } : {}) }))
      : undefined,
  };
  const items = (snap?.items || []).filter((i) => i.status === 'active').map((i) => {
    const c = catOf.get(i.category_id);
    return {
      title: i.title, type: i.type, ...(i.note ? { note: i.note } : {}),
      ...(i.qty != null ? { qty: i.qty, unit: i.unit || null, per_person: Boolean(i.per_person) } : {}),
      needed: i.needed || 1, ...(i.type === 'each' && i.each_qty ? { each_qty: i.each_qty } : {}),
      ...(c ? { category_name: c.name, category_emoji: c.emoji || null, ...(c.secret ? { category_secret: true } : {}) } : {}),
    };
  });
  const profile = {
    display_name: me.display_name || 'מארגנ/ת', headcount: me.headcount || 1, people: me.people || [],
    ...(me.emoji ? { emoji: me.emoji } : {}), ...(me.color ? { color: me.color } : {}), ...(me.phone ? { phone: me.phone } : {}),
  };
  return { payload, profile, items };
}

/** Creates the new trip: returns its id (or null). `api` is the app's api (js/api). */
export async function runClone(api, snap, opts) {
  const { payload, profile, items } = cloneModel(snap, opts);
  const res = await api.createTrip(payload, profile);
  if (!res?.trip_id) return null;
  for (let i = 0; i < items.length; i += 150) await api.addItemsBulk(res.trip_id, items.slice(i, i + 150));
  return res.trip_id;
}

export const durationDays = (trip) => (trip?.starts_at && trip?.ends_at ? Math.max(1, Math.round((new Date(trip.ends_at) - new Date(trip.starts_at)) / DAY_MS)) : null);
