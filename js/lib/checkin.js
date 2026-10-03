// Flight check-in as a real task: the organiser says when it's due (N hours before takeoff) and who takes it; it is an
// ordinary task item (so the existing "⏰ הגיע הזמן" reminder reaches whoever took it, and the lists show it), linked
// from the booking (`booking.checkin = {who, hours, item}`). Takeoff times on bookings are wall-clock strings
// ('YYYY-MM-DDTHH:MM'); the due time is computed on the Israeli clock (a flight out of Israel is exactly that; a
// flight back is within an hour or two — a check-in window is that loose anyway).
import { ilIso } from './logic.js?v=5ff55d3';

export const CHECKIN_HOURS = [
  { hours: 48, label: '48 שעות לפני' },
  { hours: 24, label: '24 שעות לפני' },
  { hours: 12, label: '12 שעות לפני' },
  { hours: 4, label: '4 שעות לפני' },
];

const WALL_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

/** When the check-in is due: the takeoff minus `hours`, as an ISO instant — null without a takeoff time. */
export function checkinDue(at, hours) {
  const m = WALL_RE.exec(String(at || ''));
  const h = Number(hours);
  if (!m || !(h > 0)) return null;
  return new Date(new Date(ilIso(m[1], m[2])).getTime() - h * 3600000).toISOString();
}

export const checkinTitle = (b) => `✈️ צ׳ק־אין${b.flight ? ` ל־${String(b.flight).toUpperCase()}` : ''}${b.leg === 'back' ? ' (חזור)' : ''}`;

/** The check-in task of a booking, from the trip's items (null when none / deleted). */
export function checkinItem(snap, b) {
  const id = b?.checkin?.item;
  return id ? (snap?.items || []).find((i) => i.id === id && i.status !== 'rejected') || null : null;
}

/** Who holds the task: the member id of its first pledge. */
export function checkinHolder(snap, item) {
  const p = item ? (snap?.pledges || []).find((x) => x.item_id === item.id) : null;
  return p ? p.member_id : null;
}

/** The status the booking card shows: {state: 'done'|'due'|'late'|'open', due, item, who}. */
export function checkinStatus(snap, b, now = new Date()) {
  const c = b?.checkin;
  if (!c?.who) return null;
  const item = checkinItem(snap, b);
  const due = item?.due_at || checkinDue(b.at, c.hours);
  const who = checkinHolder(snap, item) || c.who;
  if (item?.done) return { state: 'done', due, item, who };
  const late = due && new Date(due) < now;
  return { state: late ? 'late' : 'open', due, item, who };
}

/**
 * Make the task match the booking's check-in settings (create / update / reassign / remove). Returns the `checkin`
 * value to store on the booking ({who, hours, item}) or undefined when check-in isn't managed.
 * `api` is the app's api; admin only (assigning is an admin act).
 */
export async function syncCheckin(api, snap, tripId, booking, previous = null) {
  const c = booking.checkin;
  // the task the booking had before this save (switching check-in off drops the link on the new value, not on the old)
  const old = checkinItem(snap, booking) || checkinItem(snap, previous);
  if (!c?.who || !(Number(c.hours) > 0) || !booking.at) {
    if (old && old.id) await api.deleteItem(old.id);          // switched off: its reminder goes with it
    return undefined;
  }
  const due = checkinDue(booking.at, c.hours);
  const title = checkinTitle(booking);
  let id = old ? old.id : null;
  if (id) {
    const moved = old.done && (old.due_at !== due || (c.who && checkinHolder(snap, old) !== c.who));
    await api.updateItem(id, { title, due_at: due });
    if (moved) await api.setItemDone(id, false);               // the time or the person changed: it's open again
    // the task changes hands: the old holder's pledge goes (qty 0), the new one's comes (they're asked to confirm, as for any assignment)
    const holders = (snap?.pledges || []).filter((x) => x.item_id === id).map((x) => x.member_id);
    for (const h of holders) if (h !== c.who) await api.assign(id, h, 0);
    if (!holders.includes(c.who)) await api.assign(id, c.who, 1);
  } else {
    const cat = (snap?.categories || []).find((x) => /משימות/u.test(x.name) || x.emoji === '📋');
    id = await api.addItem(tripId, { title, type: 'task', due_at: due, note: 'צ׳ק־אין אונליין — מסמנים ✓ כשבוצע', ...(cat ? { category_id: cat.id } : {}) });
    await api.assign(id, c.who, 1);
  }
  return { who: c.who, hours: Number(c.hours), item: id };
}
