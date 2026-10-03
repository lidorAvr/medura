// Trip detail cards an admin fills once for everyone (trips.info): group bookings (flights, the hotel,
// reservations), what the trip costs per person, and who sleeps in which room. Members read; admins edit.
// Times here are wall-clock strings ('YYYY-MM-DDTHH:MM', local to the place) — shown as typed.
import { html } from 'htm/preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { actions, store, useTrip } from '../store.js?v=9252f89';
import { displayName, formatMoney, hebrewCount, ilWall } from '../lib/logic.js?v=9252f89';
import { hasModule, resolveType } from '../lib/templates.js?v=9252f89';
import { symbolOf } from '../lib/fx.js?v=9252f89';
import { bookingFromFlight, canLookup, findFlight, flightCode, flightFit, flightLine, flightStatus, updatedAgo, ymdOf } from '../lib/flights.js?v=9252f89';
import { navLinks } from '../lib/places.js?v=9252f89';
import { PlaceInput } from '../ui/place-input.js?v=9252f89';
import { CHECKIN_HOURS, checkinDue, checkinItem, checkinStatus, syncCheckin } from '../lib/checkin.js?v=9252f89';
import { Button, Card, Chip, Field, IconButton, MemberPicker, Segmented, Sheet, Stepper, TextInput, Toggle, confirmDialog } from '../ui/components.js?v=9252f89';

const cx = (...a) => a.filter(Boolean).join(' ');
const DAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const arr = (v) => (Array.isArray(v) ? v : []);

/** 'YYYY-MM-DDTHH:MM' → "יום ג׳ 6.10 · 18:30" (no time-zone shifting: it's the time on the ticket). */
export function wall(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return '';
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return `יום ${DAYS[day]} ${+m[3]}.${+m[2]}${m[4] ? ` · ${m[4]}:${m[5]}` : ''}`;
}

const save = (trip, key, list, success) => actions.run(async (api) => {
  await api.updateTrip(trip.id, { info: { [key]: list } });
  return true;
}, { success });

const PAY = { onsite: 'משלמים במקום', organizer: 'מעבירים למארגן/ת', paid: 'שולם מראש', self: 'כל אחד לעצמו' };
const TONE_COLOR = { ok: 'var(--success-text)', late: 'var(--warning-text)', bad: 'var(--danger-text)' };

// ---------------------------------------------------------------------------
// flight lookup + live status (shared with rides.js)
// ---------------------------------------------------------------------------

const IDLE = { busy: false, found: null, error: '', key: '' };

/**
 * An explicit flight lookup (button / blur — never per keystroke: the quota is tiny). The same number+date
 * is not asked again automatically; only the latest answer counts.
 * → { busy, found, error, run(number, date, {auto}) → flight|null, reset() }
 */
export function useFlightLookup(tripId) {
  const [state, setState] = useState(IDLE);
  const tried = useRef('');
  const seq = useRef(0);
  const reset = () => {
    seq.current += 1;
    tried.current = '';
    setState(IDLE);
  };
  const run = async (number, date, { auto = false } = {}) => {
    const n = flightCode(number);
    if (!canLookup(n, date)) {
      if (!auto) setState({ ...IDLE, error: 'צריך מספר טיסה (למשל LY315) ותאריך' });
      return null;
    }
    const key = `${n}|${date}`;
    if (auto && tried.current === key) return null;
    tried.current = key;
    const api = store.get().api;
    if (typeof api?.lookupFlight !== 'function') {
      setState({ ...IDLE, error: 'החיפוש האוטומטי לא זמין כרגע — אפשר למלא ידנית', key });
      return null;
    }
    const my = ++seq.current;
    setState({ ...IDLE, busy: true, key });
    let res = null;
    try {
      res = await api.lookupFlight(tripId, n, date);
    } catch {
      res = null;
    }
    if (my !== seq.current) return null; // superseded
    if (res?.ok && res.flight) {
      setState({ ...IDLE, found: res.flight, key });
      return res.flight;
    }
    setState({ ...IDLE, error: res?.message || 'החיפוש לא הצליח — אפשר למלא ידנית', key });
    return null;
  };
  return { ...state, run, reset };
}

/** "✓ נמצא · El Al · TLV T3 10:10 → LHR T4 13:35" or the lookup's error (manual fields stay open). */
// One line is always reserved: a lookup started by leaving the field (blur) must not push the "שמירה" button
// down between the press and the release — that tap would be lost.
const NOTE_SLOT = 'min-height: 1.5em; margin: 0';
export function LookupNote({ lookup, testid = 'flight-lookup' }) {
  if (lookup.busy) return html`<p class="small muted" role="status" data-testid=${testid} style=${NOTE_SLOT}>🔎 מחפשים את הטיסה…</p>`;
  if (lookup.found) {
    return html`<p class="small" role="status" data-testid=${testid} style=${`${NOTE_SLOT}; color: var(--success-text)`}>✓ נמצא · <bdi>${flightLine(lookup.found)}</bdi></p>`;
  }
  if (lookup.error) return html`<p class="small" role="status" data-testid=${testid} style=${`${NOTE_SLOT}; color: var(--warning-text)`}>${lookup.error}</p>`;
  return html`<p class="small" aria-hidden="true" style=${NOTE_SLOT}></p>`;
}

/** The live row of a flight from snapshot.flights: "🟠 עיכוב · 16:55 (במקום 16:00) · עודכן לפני 12 דק׳". */
export function FlightLive({ row }) {
  if (!row?.data) return null;
  const st = flightStatus(row.data);
  const ago = updatedAgo(row.checked_at || row.data.updated);
  const color = TONE_COLOR[st.tone];
  return html`<span class="flight-live small" data-testid="flight-live" data-tone=${st.tone}>
    <b style=${color ? `color: ${color}` : undefined}>${st.text}</b>${ago ? html` <span class="muted">· ${ago}</span>` : null}
  </span>`;
}

/** Waze / Maps buttons for a place with coordinates or an address. */
export function NavButtons({ place, waze = true }) {
  const links = navLinks(place);
  if (!waze) links.waze = null;                      // a place abroad: Waze is no use there
  if (!links.waze && !links.maps) return null;
  return html`<span class="row wrap" style="gap: 6px">
    ${links.waze ? html`<a class="btn btn--secondary btn--sm" href=${links.waze} target="_blank" rel="noopener noreferrer"><span class="emoji-icon" aria-hidden="true">🚙</span><span class="btn__label">Waze</span></a>` : null}
    ${links.maps ? html`<a class="btn btn--secondary btn--sm" href=${links.maps} target="_blank" rel="noopener noreferrer"><span class="emoji-icon" aria-hidden="true">🗺️</span><span class="btn__label">מפות</span></a>` : null}
  </span>`;
}

/** The trip's first / last day ('YYYY-MM-DD') — default dates for the out / back flight. */
/** A flight's leg by its date: the first half of the trip flies out (a connection too), the second half back. */
export function legOf(ymd, days) {
  if (!ymd || !days?.out || !days?.back || days.back <= days.out) return null;
  const t = (d) => Date.parse(`${d}T00:00:00Z`);
  return t(ymd) - t(days.out) <= t(days.back) - t(ymd) ? 'out' : 'back';
}

export function tripDays(trip) {
  const out = trip?.starts_at ? ilWall(new Date(trip.starts_at)).ymd : '';
  const back = trip?.ends_at ? ilWall(new Date(trip.ends_at)).ymd : out;
  return { out, back };
}

/** 'il' | 'abroad' — where place searches look. */
export function whereOf(trip) {
  try {
    return resolveType(trip?.settings || {}).where === 'abroad' ? 'abroad' : 'il';
  } catch {
    return 'il';
  }
}
export const nearOf = (trip) => (trip?.lat != null && trip?.lon != null ? { lat: Number(trip.lat), lon: Number(trip.lon) } : null);

// ---------------------------------------------------------------------------
// bookings
// ---------------------------------------------------------------------------

export function BookingsCard({ trip, isAdmin, force }) {
  const { snap } = useTrip();
  const list = arr(trip.info?.bookings);
  const [sheet, setSheet] = useState(null); // null | {index, booking}
  const madeTask = useRef(null);                 // a check-in task made by a save whose booking didn't save: a retry reuses it
  if (!list.length && !(isAdmin && force)) return null;
  const remove = async (i) => {
    if (!(await confirmDialog({ title: 'למחוק את ההזמנה?', confirmText: 'מחיקה', danger: true }))) return;
    // a flight's check-in is a task with a reminder: it goes with the booking
    const task = checkinItem(snap, list[i]);
    if (task && (await actions.run((api) => api.deleteItem(task.id))) === undefined) return;
    await save(trip, 'bookings', list.filter((_, j) => j !== i), 'נמחק');
  };
  return html`<${Card} emoji="🎫" title="הזמנות" class="bookings" data-testid="bookings">
    ${list.length
      ? html`<ul class="bookings__list">
          ${list.map((b, i) => html`<li class=${cx('booking', `booking--${b.kind}`)} key=${i} data-testid="booking">
            <div class="booking__main">${bookingBody(b, snap)}</div>
            ${isAdmin
              ? html`<div class="booking__tools">
                  <${IconButton} icon="edit" label="עריכה" onClick=${() => setSheet({ index: i, booking: b })} />
                  <${IconButton} icon="trash" label="מחיקה" onClick=${() => remove(i)} />
                </div>`
              : null}
          </li>`)}
        </ul>`
      : html`<p class="muted small">טיסה, מלון, מסעדה — מכניסים פעם אחת, וכולם רואים את כל הפרטים במקום אחד.</p>`}
    ${isAdmin
      ? html`<div class="row wrap bookings__add">
          <${Button} size="sm" variant="secondary" onClick=${() => setSheet({ index: -1, booking: { kind: 'flight', leg: list.some((b) => b.kind === 'flight' && b.leg === 'out') ? 'back' : 'out' } })}>✈️ טיסה</${Button}>
          <${Button} size="sm" variant="secondary" onClick=${() => setSheet({ index: -1, booking: { kind: 'hotel', pay: 'onsite' } })}>🏨 לינה</${Button}>
          <${Button} size="sm" variant="secondary" onClick=${() => setSheet({ index: -1, booking: { kind: 'other' } })}>🎟️ הזמנה אחרת</${Button}>
        </div>`
      : null}
    <${BookingSheet} open=${Boolean(sheet)} data=${sheet} trip=${trip} members=${snap?.members || []} onClose=${() => setSheet(null)}
      onSave=${async (b) => {
        // a flight's check-in is a real task (due time + a person): create / update / drop it with the booking
        if (b.kind === 'flight') {
          const prev = sheet.index >= 0 ? list[sheet.index] : (madeTask.current ? { checkin: { item: madeTask.current } } : null);
          const res = await actions.run(async (api) => ({ checkin: await syncCheckin(api, snap, trip.id, b, prev) }));
          if (res === undefined) return false;
          if (res.checkin) { b = { ...b, checkin: res.checkin }; madeTask.current = res.checkin.item; }
          else { const { checkin: _c, ...rest } = b; b = rest; madeTask.current = null; }
        }
        const next = [...list];
        if (sheet.index >= 0) next[sheet.index] = b;
        else next.push(b);
        next.sort((x, y) => String(x.at || x.check_in || '~').localeCompare(String(y.at || y.check_in || '~')));
        const saved = await save(trip, 'bookings', next, 'נשמר ✅');
        if (saved) madeTask.current = null;
        return saved;
      }} />
  </${Card}>`;
}

function bookingBody(b, snap) {
  if (b.kind === 'flight') {
    const live = b.flight ? findFlight(snap, b) : null;
    const route = [b.from, b.to].filter(Boolean);
    return html`<p class="booking__title">${b.leg === 'back' ? '🛬 טיסה חזור' : '🛫 טיסה הלוך'}
        ${b.flight ? html` · <b dir="ltr">${b.flight}</b>` : null}${b.airline ? html` · <bdi>${b.airline}</bdi>` : ''}</p>
      <p class="booking__line">${wall(b.at)}${b.at && route.length ? ' · ' : ''}${route.map((x, i) => html`${i ? ' ← ' : ''}<bdi>${x}</bdi>`)}${b.terminal ? ` · טרמינל ${b.terminal}` : ''}</p>
      ${b.arr_at ? html`<p class="booking__line">🛬 נחיתה ${wall(b.arr_at)}</p>` : null}
      ${live ? html`<p class="booking__line"><${FlightLive} row=${live} /></p>` : null}
      ${b.seats ? html`<p class="booking__line" data-testid="booking-seats">💺 מושבים: <bdi>${b.seats}</bdi></p>` : null}
      ${b.baggage ? html`<p class="booking__line">🧳 ${b.baggage}</p>` : null}
      ${b.ref ? html`<p class="booking__line">🔖 הזמנה <b dir="ltr">${b.ref}</b></p>` : null}
      <${CheckinLine} b=${b} snap=${snap} />
      ${b.note ? html`<p class="booking__line muted">📝 ${b.note}</p>` : null}`;
  }
  if (b.kind === 'hotel') {
    const where = b.lat != null && b.lon != null ? { name: b.place || b.name, address: b.address, lat: b.lat, lon: b.lon }
      : b.address ? { name: b.name, address: b.address } : null;
    return html`<p class="booking__title">🏨 ${b.name || 'לינה'}</p>
      ${b.address ? html`<p class="booking__line">📍 <bdi>${b.address}</bdi></p>` : null}
      <p class="booking__line">${[b.check_in && `צ׳ק־אין ${wall(b.check_in)}`, b.check_out && `צ׳ק־אאוט ${wall(b.check_out)}`].filter(Boolean).join(' · ')}</p>
      ${b.ref ? html`<p class="booking__line" data-testid="booking-ref">🔖 קוד הזמנה <b dir="ltr">${b.ref}</b></p>` : null}
      ${b.pay ? html`<p class="booking__line">💳 ${PAY[b.pay] || b.pay}${b.price ? ` · ${b.price}` : ''}</p>` : null}
      ${b.cancel ? html`<p class="booking__line">↩️ ${b.cancel}</p>` : null}
      ${b.note ? html`<p class="booking__line muted">📝 ${b.note}</p>` : null}
      ${where ? html`<div class="booking__line" data-testid="booking-nav"><${NavButtons} place=${where} waze=${snap?.trip?.settings?.where !== 'abroad'} /></div>` : null}
      ${b.url ? html`<a class="booking__link" href=${b.url} target="_blank" rel="noopener noreferrer">לפרטי ההזמנה ↗</a>` : null}`;
  }
  return html`<p class="booking__title">🎟️ ${b.title || 'הזמנה'}</p>
    ${b.at ? html`<p class="booking__line">🕗 ${wall(b.at)}</p>` : null}
    ${b.ref ? html`<p class="booking__line" data-testid="booking-ref">🔖 קוד הזמנה <b dir="ltr">${b.ref}</b></p>` : null}
    ${b.note ? html`<p class="booking__line muted">📝 ${b.note}</p>` : null}
    ${b.url ? html`<a class="booking__link" href=${b.url} target="_blank" rel="noopener noreferrer">קישור ↗</a>` : null}`;
}

/** An ISO instant → the Israeli wall-clock text the cards use ("יום ב׳ 5.10 · 21:30"). */
const wallOf = (iso) => { const w = ilWall(new Date(iso)); return wall(`${w.ymd}T${w.hm}`); };

/** A flight's check-in on its card: ✅ done / ⏳ who + until when / ⏰ late — and "בוצע ✓" for who took it (or an admin). */
function CheckinLine({ b, snap }) {
  const st = checkinStatus(snap, b);
  const [busy, setBusy] = useState(false);
  if (!st) return null;
  const who = (snap.members || []).find((m) => m.id === st.who);
  const mine = snap.me?.member_id === st.who || ['owner', 'admin'].includes(snap.me?.role);
  const dueText = st.due ? wallOf(st.due) : '';
  const done = async () => {
    setBusy(true);
    await actions.run((api) => api.setItemDone(st.item.id, true), { success: 'סומן שהצ׳ק־אין בוצע ✅' });
    setBusy(false);
  };
  const text = st.state === 'done' ? `✅ צ׳ק־אין בוצע${who ? ` · ${displayName(who)}` : ''}`
    : st.state === 'late' ? `⏰ צ׳ק־אין עבר המועד${who ? ` · ${displayName(who)}` : ''}${dueText ? ` · ${dueText}` : ''}`
      : `⏳ צ׳ק־אין${who ? ` · ${displayName(who)}` : ''}${dueText ? ` · עד ${dueText}` : ''}`;
  return html`<p class=${cx('booking__line', 'booking__checkin', `is-${st.state}`)} data-testid="checkin-status" data-state=${st.state}>${text}
    ${st.state !== 'done' && st.item && mine
      ? html` <${Button} size="sm" variant="secondary" loading=${busy} onClick=${done}>בוצע ✓</${Button}>` : null}</p>`;
}

/** The organiser's side of a flight's check-in: switch, who takes it, how long before takeoff — and the resulting time. */
function CheckinFields({ b, setB, members }) {
  const c = b.checkin || null;
  const on = Boolean(c);
  const due = c && b.at ? checkinDue(b.at, c.hours) : null;
  const dueText = due ? wallOf(due) : '';
  const setC = (patch) => setB((x) => ({ ...x, checkin: { ...(x.checkin || {}), ...patch } }));
  const toggle = (v) => setB((x) => {
    if (!v) { const { checkin: _c, ...rest } = x; return { ...rest, checkin: undefined }; }
    return { ...x, checkin: { ...(x.checkin || {}), hours: x.checkin?.hours || 24, who: x.checkin?.who || null } };
  });
  return html`<div class="checkin-fields" data-testid="checkin-fields">
    <${Toggle} checked=${on} onChange=${toggle} label="לנהל צ׳ק־אין לטיסה הזו"
      hint=${on ? 'נוצרת משימה עם מועד — מי שלקח/ה אותה יקבל/ת תזכורת, ואתם רואים אם בוצע' : 'משימה עם תזכורת למי שאחראי/ת על הצ׳ק־אין'} />
    ${on
      ? html`<${Field} label="מי עושה צ׳ק־אין?"><div data-testid="checkin-who"><${MemberPicker} members=${members} value=${c.who} onChange=${(id) => id && setC({ who: id })} label="מי עושה צ׳ק־אין?" /></div></${Field}>
        <${Field} label="עד מתי?">
          <div class="sched-quick" role="group" aria-label="כמה זמן לפני ההמראה" data-testid="checkin-hours">
            ${CHECKIN_HOURS.map((h) => html`<${Chip} key=${h.hours} active=${Number(c.hours) === h.hours} onClick=${() => setC({ hours: h.hours })}>${h.label}</${Chip}>`)}
          </div>
          ${b.at
            ? html`<p class="tiny muted" data-testid="checkin-due">${dueText ? `התזכורת תגיע ב־${dueText}` : ''}</p>`
            : html`<p class="tiny muted">צריך שעת המראה כדי לחשב מתי</p>`}
        </${Field}>`
      : null}
  </div>`;
}

function BookingSheet({ open, data, trip, members = [], onClose, onSave }) {
  const [b, setB] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [legTouched, setLegTouched] = useState(false);   // the leg switch was set by hand
  const [place, setPlace] = useState(null); // hotel: the picked OSM place (or null = free text)
  const [placeText, setPlaceText] = useState('');
  const lookup = useFlightLookup(trip?.id);
  const days = tripDays(trip);
  useLayoutEffect(() => {
    if (!open) return;
    const x = { ...(data?.booking || {}) };
    if (x.kind === 'flight' && !x.date) x.date = ymdOf(x.at) || days[x.leg === 'back' ? 'back' : 'out'] || '';
    setB(x);
    const picked = x.kind === 'hotel' && x.lat != null && x.lon != null
      ? { name: x.place || x.name || x.address || '', address: x.address || '', lat: Number(x.lat), lon: Number(x.lon), kind: 'hotel' } : null;
    setPlace(picked);
    setPlaceText(picked ? picked.name : x.address || '');
    lookup.reset();
    setBusy(false);
    setError(null);
    setLegTouched(data?.index != null && data.index >= 0);   // editing: keep what's saved
  }, [open]);
  const set = (k) => (e) => setB((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
  const setLeg = (leg) => {
    setLegTouched(true);
    setB((x) => ({
      ...x, leg, date: !x.date || x.date === days[x.leg === 'back' ? 'back' : 'out'] ? days[leg] || x.date : x.date,
    }));
  };
  const now = useRef(b);
  now.current = b;
  const find = async (auto = false) => {
    const asked = { flight: flightCode(b.flight), date: b.date };
    const f = await lookup.run(asked.flight, asked.date, { auto });
    // apply only if the form still asks for this flight (typing goes on while we wait); the typed date stays
    const cur = now.current;
    if (f && flightCode(cur.flight) === asked.flight && cur.date === asked.date) {
      const { date: _d, ...fill } = bookingFromFlight(f);
      setB((x) => ({ ...x, ...fill }));
    }
  };
  // a flight that lands far from the trip, or on another week: most likely a typo — warn, and ask before saving
  const fitOf = (x) => (x.kind === 'flight' && flightCode(x.flight)
    ? flightFit({
      flight: lookup.found && flightCode(lookup.found.number) === flightCode(x.flight) ? lookup.found : null,
      trip, leg: x.leg || 'out', date: ymdOf(x.at) || x.date, days,
    }) : []);
  const submit = async (e) => {
    e?.preventDefault();
    const clean = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]).filter(([, v]) => v !== '' && v != null));
    if (clean.kind === 'hotel') {
      delete clean.place;
      delete clean.lat;
      delete clean.lon;
      delete clean.address;
      const text = placeText.trim();
      if (place && place.lat != null) {
        Object.assign(clean, { place: place.name, address: place.address || place.name, lat: place.lat, lon: place.lon });
        if (!clean.name) clean.name = place.name;
      } else if (text) clean.address = text;
    }
    if (clean.kind === 'flight' && clean.checkin && !clean.checkin.who) return setError('מי עושה את הצ׳ק־אין? אפשר לבחור למעלה, או לכבות');
    if (clean.kind === 'flight' && clean.checkin && !clean.at) return setError('צ׳ק־אין צריך שעת המראה (למעלה)');
    if (clean.kind === 'hotel' && !clean.name) return setError('איך קוראים למקום?');
    if (clean.kind === 'other' && !clean.title) return setError('מה הוזמן?');
    if (clean.flight) clean.flight = flightCode(clean.flight);
    if (clean.kind === 'flight') {
      const d = ymdOf(clean.at);
      if (d) clean.date = d; // the takeoff the booking shows wins
      if (!clean.flight) delete clean.date;
      // a second flight (a connection) isn't "back" just because an outbound exists: its date says which leg
      const byDate = legOf(clean.date, days);
      if (byDate && !legTouched) clean.leg = byDate;
      else if (byDate && byDate !== (clean.leg || 'out')) {
        const keep = await confirmDialog({
          title: clean.leg === 'back' ? 'טיסה חזור בתחילת הטיול?' : 'טיסה הלוך בסוף הטיול?',
          text: `התאריך (${clean.date.slice(8, 10)}.${clean.date.slice(5, 7)}) נראה כמו טיסת ${byDate === 'out' ? 'הלוך (או קונקשן בדרך)' : 'חזור'}.`,
          confirmText: `לשמור כ${byDate === 'out' ? 'הלוך' : 'חזור'}`,
          cancelText: 'להשאיר כמו שבחרתי',
        });
        if (keep) clean.leg = byDate;
      }
      const warns = fitOf(clean);
      if (warns.length && !(await confirmDialog({
        title: 'הטיסה לא מתאימה לטיול?', text: `${warns.map((w) => w.text).join(' · ')}.`,
        confirmText: 'לשמור בכל זאת', cancelText: 'לתקן',
      }))) return undefined;
    }
    setBusy(true);
    const ok = await onSave(clean);
    setBusy(false);
    if (ok) onClose();
    return undefined;
  };
  const kind = b.kind || 'flight';
  const title = kind === 'flight' ? 'טיסה ✈️' : kind === 'hotel' ? 'לינה 🏨' : 'הזמנה 🎟️';
  return html`<${Sheet} open=${open} onClose=${onClose} title=${title}
    footer=${html`<${Button} type="submit" form="booking-form" icon="check" loading=${busy}>שמירה</${Button}>
      <${Button} variant="secondary" onClick=${onClose}>ביטול</${Button}>`}>
    <form id="booking-form" class="stack" onSubmit=${submit} noValidate>
      ${kind === 'flight'
        ? html`<${Segmented} label="כיוון" value=${b.leg || 'out'} onChange=${setLeg}
            options=${[{ value: 'out', label: '🛫 הלוך' }, { value: 'back', label: '🛬 חזור' }]} />
          <div class="date-pair">
            <${Field} label="מספר טיסה"><${TextInput} dir="ltr" value=${b.flight || ''} maxlength="12" placeholder="LY315" autocapitalize="characters"
              onInput=${set('flight')} onBlur=${() => find(true)} data-testid="booking-flight" /></${Field}>
            <${Field} label="תאריך הטיסה"><${TextInput} type="date" value=${b.date || ''} onInput=${set('date')} onBlur=${() => find(true)} data-testid="booking-date" /></${Field}>
          </div>
          <div class="row wrap">
            <${Button} size="sm" variant="secondary" loading=${lookup.busy} onClick=${() => find(false)} data-testid="booking-lookup">🔎 מילוי אוטומטי</${Button}>
          </div>
          <${LookupNote} lookup=${lookup} testid="booking-lookup-note" />
          ${fitOf(b).map((w) => html`<p key=${w.kind} class="small flight-fit" role="status" data-testid="booking-fit" style="margin: 0; color: var(--warning-text)">⚠️ ${w.text}</p>`)}
          <${Field} label="חברה"><${TextInput} value=${b.airline || ''} maxlength="40" placeholder="אל על" onInput=${set('airline')} /></${Field}>
          <${Field} label="המראה (שעה מקומית)"><${TextInput} type="datetime-local" value=${b.at || ''} onInput=${set('at')} /></${Field}>
          <div class="date-pair">
            <${Field} label="מ…"><${TextInput} value=${b.from || ''} maxlength="40" placeholder="נתב״ג" onInput=${set('from')} /></${Field}>
            <${Field} label="ל…"><${TextInput} value=${b.to || ''} maxlength="40" placeholder="בוקרשט" onInput=${set('to')} /></${Field}>
          </div>
          <div class="date-pair">
            <${Field} label="נחיתה (שעה מקומית)"><${TextInput} type="datetime-local" value=${b.arr_at || ''} onInput=${set('arr_at')} /></${Field}>
            <${Field} label="טרמינל"><${TextInput} dir="ltr" value=${b.terminal || ''} maxlength="6" placeholder="3" onInput=${set('terminal')} /></${Field}>
          </div>
          <${Field} label="מושבים (לא חובה)"><${TextInput} value=${b.seats || ''} maxlength="60" placeholder="14A, 14B, 14C" onInput=${set('seats')} /></${Field}>
          <${Field} label="כבודה"><${TextInput} value=${b.baggage || ''} maxlength="80" placeholder="טרולי + תיק גב" onInput=${set('baggage')} /></${Field}>
          <${CheckinFields} b=${b} setB=${setB} members=${members} />
          <${Field} label="קוד הזמנה (לא חובה)"><${TextInput} dir="ltr" value=${b.ref || ''} maxlength="20" onInput=${set('ref')} /></${Field}>`
        : null}
      ${kind === 'hotel'
        ? html`<${Field} label="שם המקום"><${TextInput} value=${b.name || ''} maxlength="60" placeholder="Park Inn" onInput=${set('name')} /></${Field}>
          <${PlaceInput} label="איפה זה? (כתובת)" value=${place} text=${placeText} where=${whereOf(trip)} near=${nearOf(trip)}
            placeholder="שם המלון או הכתובת" testid="booking-place"
            onChange=${(p, t) => {
              setPlace(p);
              setPlaceText(t);
              if (p && !String(b.name || '').trim()) setB((x) => ({ ...x, name: p.name.slice(0, 60) }));
            }} />
          <div class="date-pair">
            <${Field} label="צ׳ק־אין"><${TextInput} type="datetime-local" value=${b.check_in || ''} onInput=${set('check_in')} /></${Field}>
            <${Field} label="צ׳ק־אאוט"><${TextInput} type="datetime-local" value=${b.check_out || ''} onInput=${set('check_out')} /></${Field}>
          </div>
          <p class="field__label">תשלום</p>
          <div class="sched-quick">${['onsite', 'organizer', 'paid'].map((k) => html`<${Chip} key=${k} active=${b.pay === k} onClick=${() => set('pay')(k)}>${PAY[k]}</${Chip}>`)}</div>
          <${Field} label="מחיר (לא חובה)"><${TextInput} value=${b.price || ''} maxlength="60" placeholder="₪1,054 לאדם" onInput=${set('price')} /></${Field}>
          <${Field} label="קוד הזמנה (לא חובה)" hint="מה שמראים בדלפק — כולם יראו אותו כאן, גם בלי קליטה"><${TextInput} dir="ltr" value=${b.ref || ''} maxlength="30" placeholder="HM3K2L" onInput=${set('ref')} data-testid="booking-ref-input" /></${Field}>
          <${Field} label="ביטול"><${TextInput} value=${b.cancel || ''} maxlength="120" placeholder="ביטול חינם עד 3 ימים לפני" onInput=${set('cancel')} /></${Field}>
          <${Field} label="קישור (לא חובה)"><${TextInput} type="url" dir="ltr" value=${b.url || ''} maxlength="500" placeholder="https://…" onInput=${set('url')} /></${Field}>`
        : null}
      ${kind === 'other'
        ? html`<${Field} label="מה הוזמן?"><${TextInput} value=${b.title || ''} maxlength="60" placeholder="שולחן במסעדה, שייט, קארטינג…" onInput=${set('title')} /></${Field}>
          <${Field} label="מתי"><${TextInput} type="datetime-local" value=${b.at || ''} onInput=${set('at')} /></${Field}>
          <${Field} label="קוד הזמנה (לא חובה)"><${TextInput} dir="ltr" value=${b.ref || ''} maxlength="30" onInput=${set('ref')} data-testid="booking-ref-input" /></${Field}>
          <${Field} label="קישור (לא חובה)"><${TextInput} type="url" dir="ltr" value=${b.url || ''} maxlength="500" onInput=${set('url')} /></${Field}>`
        : null}
      <${Field} label="הערה (לא חובה)"><${TextInput} value=${b.note || ''} maxlength="200" onInput=${set('note')} /></${Field}>
      ${error ? html`<p class="field__error" role="alert">${error}</p>` : null}
    </form>
  </${Sheet}>`;
}

// ---------------------------------------------------------------------------
// costs per person
// ---------------------------------------------------------------------------

export function CostsCard({ trip, members, isAdmin, force }) {
  const list = arr(trip.info?.costs);
  const [sheet, setSheet] = useState(null);
  if (!list.length && !(isAdmin && force)) return null;
  const byCur = new Map();
  for (const c of list) byCur.set(c.currency || 'ILS', (byCur.get(c.currency || 'ILS') || 0) + (Number(c.amount) || 0));
  const total = [...byCur.entries()].map(([cur, v]) => (cur === 'ILS' ? formatMoney(v) : `${symbolOf(cur)}${v.toLocaleString('en-US')}`)).join(' + ');
  const nameOf = (id) => displayName(members.find((m) => m.id === id));
  const remove = async (i) => {
    if (!(await confirmDialog({ title: 'למחוק את השורה?', confirmText: 'מחיקה', danger: true }))) return;
    await save(trip, 'costs', list.filter((_, j) => j !== i), 'נמחק');
  };
  return html`<${Card} emoji="🧮" title="כמה זה עולה לאדם" class="costs" data-testid="costs">
    ${list.length
      ? html`<ul class="costs__list">
          ${list.map((c, i) => html`<li class="costs__row" key=${i}>
            <div class="costs__main">
              <b>${c.label}</b>
              <span class="muted small">${[PAY[c.pay] ? (c.pay === 'organizer' && c.to ? `מעבירים ל${nameOf(c.to)}` : PAY[c.pay]) : null, c.due && `עד ${wall(c.due)}`, c.note].filter(Boolean).join(' · ')}</span>
            </div>
            <b class="costs__amount num">${(c.currency || 'ILS') === 'ILS' ? formatMoney(c.amount) : `${symbolOf(c.currency)}${Number(c.amount).toLocaleString('en-US')}`}</b>
            ${isAdmin
              ? html`<span class="costs__tools"><${IconButton} icon="edit" label="עריכה" onClick=${() => setSheet({ index: i, cost: c })} />
                  <${IconButton} icon="trash" label="מחיקה" onClick=${() => remove(i)} /></span>`
              : null}
          </li>`)}
        </ul>
        <p class="costs__total">סה״כ לאדם: <b class="num">${total}</b></p>`
      : html`<p class="muted small">טיסה, לינה, מקדמה — כמה כל אחד משלם, למי ועד מתי. בלי ״כמה המלון שוב?״ בקבוצה 🙂</p>`}
    ${isAdmin ? html`<${Button} size="sm" variant="secondary" icon="plus" onClick=${() => setSheet({ index: -1, cost: { pay: 'organizer' } })}>שורת עלות</${Button}>` : null}
    <${CostSheet} open=${Boolean(sheet)} data=${sheet} members=${members} onClose=${() => setSheet(null)}
      onSave=${(c) => {
        const next = [...list];
        if (sheet.index >= 0) next[sheet.index] = c;
        else next.push(c);
        return save(trip, 'costs', next, 'נשמר ✅');
      }} />
  </${Card}>`;
}

function CostSheet({ open, data, members, onClose, onSave }) {
  const [c, setC] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useLayoutEffect(() => {
    if (!open) return;
    setC({ currency: 'ILS', ...(data?.cost || {}) });
    setBusy(false);
    setError(null);
  }, [open]);
  const set = (k) => (e) => setC((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
  const submit = async (e) => {
    e?.preventDefault();
    const amount = Number(String(c.amount ?? '').replace(/,/g, ''));
    if (!String(c.label || '').trim()) return setError('על מה?');
    if (!(amount > 0 && amount <= 1000000)) return setError('כמה לאדם?');
    setBusy(true);
    const clean = { label: c.label.trim(), amount, currency: c.currency || 'ILS', pay: c.pay || 'organizer',
      ...(c.to && c.pay === 'organizer' ? { to: c.to } : {}), ...(c.due ? { due: c.due } : {}), ...(c.note?.trim() ? { note: c.note.trim() } : {}) };
    const ok = await onSave(clean);
    setBusy(false);
    if (ok) onClose();
    return undefined;
  };
  return html`<${Sheet} open=${open} onClose=${onClose} title="עלות לאדם 🧮"
    footer=${html`<${Button} type="submit" form="cost-form" icon="check" loading=${busy}>שמירה</${Button}>
      <${Button} variant="secondary" onClick=${onClose}>ביטול</${Button}>`}>
    <form id="cost-form" class="stack" onSubmit=${submit} noValidate>
      <${Field} label="על מה?"><${TextInput} value=${c.label || ''} maxlength="60" placeholder="טיסות / לינה / מקדמה" onInput=${set('label')} /></${Field}>
      <div class="date-pair">
        <${Field} label="כמה לאדם"><${TextInput} inputmode="decimal" dir="ltr" value=${c.amount ?? ''} onInput=${set('amount')} /></${Field}>
        <${Field} label="מטבע"><${TextInput} dir="ltr" value=${c.currency || 'ILS'} maxlength="3" onInput=${(e) => set('currency')(e.target.value.toUpperCase())} /></${Field}>
      </div>
      <p class="field__label">איך משלמים?</p>
      <div class="sched-quick">${['organizer', 'onsite', 'paid', 'self'].map((k) => html`<${Chip} key=${k} active=${c.pay === k} onClick=${() => set('pay')(k)}>${PAY[k]}</${Chip}>`)}</div>
      ${c.pay === 'organizer'
        ? html`<p class="field__label">למי מעבירים?</p>
          <div class="sched-quick">${members.map((m) => html`<${Chip} key=${m.id} active=${c.to === m.id} onClick=${() => set('to')(c.to === m.id ? null : m.id)}>${displayName(m)}</${Chip}>`)}</div>`
        : null}
      <${Field} label="עד מתי (לא חובה)"><${TextInput} type="date" value=${c.due || ''} onInput=${set('due')} /></${Field}>
      <${Field} label="הערה (לא חובה)"><${TextInput} value=${c.note || ''} maxlength="120" placeholder="בביט / במזומן בקבלה" onInput=${set('note')} /></${Field}>
      ${error ? html`<p class="field__error" role="alert">${error}</p>` : null}
    </form>
  </${Sheet}>`;
}

// ---------------------------------------------------------------------------
// rooms
// ---------------------------------------------------------------------------

export function RoomsCard({ trip, members, me, isAdmin, force }) {
  const list = arr(trip.info?.rooms);
  const [sheet, setSheet] = useState(null);
  if (!list.length && !(isAdmin && force)) return null;
  const placed = new Set(list.flatMap((r) => arr(r.members)));
  const unplaced = members.filter((m) => !placed.has(m.id));
  const remove = async (i) => {
    if (!(await confirmDialog({ title: 'למחוק את החדר?', confirmText: 'מחיקה', danger: true }))) return;
    await save(trip, 'rooms', list.filter((_, j) => j !== i), 'נמחק');
  };
  return html`<${Card} emoji="🛏️" title="חדרים" class="rooms" data-testid="rooms">
    ${list.length
      ? html`<ul class="rooms__list">
          ${list.map((r, i) => {
            const who = arr(r.members).map((id) => members.find((m) => m.id === id)).filter(Boolean);
            const heads = who.reduce((n, m) => n + (Number(m.headcount) || 1), 0);
            return html`<li class=${cx('room', who.some((m) => m.id === me?.id) && 'is-mine')} key=${i}>
              <div class="room__main">
                <b>${r.name}</b> <span class="muted small">${r.beds ? `${heads}/${r.beds} מיטות` : hebrewCount(heads, 'איש', 'אנשים')}</span>
                <span class="room__who small">${who.map(displayName).join(' · ') || 'עוד אף אחד'}</span>
                ${r.note ? html`<span class="muted small">📝 ${r.note}</span>` : null}
              </div>
              ${isAdmin
                ? html`<span class="costs__tools"><${IconButton} icon="edit" label="עריכה" onClick=${() => setSheet({ index: i, room: r })} />
                    <${IconButton} icon="trash" label="מחיקה" onClick=${() => remove(i)} /></span>`
                : null}
            </li>`;
          })}
        </ul>
        ${unplaced.length ? html`<p class="muted small">עוד בלי חדר: ${unplaced.map(displayName).join(' · ')}</p>` : null}`
      : html`<p class="muted small">מי ישן עם מי — שכולם יידעו מראש.</p>`}
    ${isAdmin ? html`<${Button} size="sm" variant="secondary" icon="plus" onClick=${() => setSheet({ index: -1, room: { beds: 2, members: [] } })}>חדר</${Button}>` : null}
    <${RoomSheet} open=${Boolean(sheet)} data=${sheet} members=${members} onClose=${() => setSheet(null)}
      onSave=${(r) => {
        const next = list.map((x) => ({ ...x, members: arr(x.members).filter((id) => !r.members.includes(id)) })); // one room each
        if (sheet.index >= 0) next[sheet.index] = r;
        else next.push(r);
        return save(trip, 'rooms', next, 'נשמר ✅');
      }} />
  </${Card}>`;
}

function RoomSheet({ open, data, members, onClose, onSave }) {
  const [r, setR] = useState({ members: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useLayoutEffect(() => {
    if (!open) return;
    setR({ beds: 2, ...(data?.room || {}), members: [...arr(data?.room?.members)] });
    setBusy(false);
    setError(null);
  }, [open]);
  const submit = async (e) => {
    e?.preventDefault();
    if (!String(r.name || '').trim()) return setError('איך נקרא לחדר?');
    setBusy(true);
    const ok = await onSave({ name: r.name.trim(), beds: r.beds || null, members: r.members, ...(r.note?.trim() ? { note: r.note.trim() } : {}) });
    setBusy(false);
    if (ok) onClose();
    return undefined;
  };
  const toggle = (id) => setR((x) => ({ ...x, members: x.members.includes(id) ? x.members.filter((y) => y !== id) : [...x.members, id] }));
  return html`<${Sheet} open=${open} onClose=${onClose} title="חדר 🛏️"
    footer=${html`<${Button} type="submit" form="room-form" icon="check" loading=${busy}>שמירה</${Button}>
      <${Button} variant="secondary" onClick=${onClose}>ביטול</${Button}>`}>
    <form id="room-form" class="stack" onSubmit=${submit} noValidate>
      <${Field} label="שם החדר"><${TextInput} value=${r.name || ''} maxlength="40" placeholder="חדר 1 / הסוויטה" onInput=${(e) => setR({ ...r, name: e.target.value })} /></${Field}>
      <div class="welcome-row"><span class="field__label">כמה מיטות?</span><${Stepper} value=${r.beds || 2} min=${1} max=${20} label="מיטות" onChange=${(v) => setR({ ...r, beds: v })} /></div>
      <p class="field__label">מי בחדר?</p>
      <div class="sched-quick">${members.map((m) => html`<${Chip} key=${m.id} active=${r.members.includes(m.id)} onClick=${() => toggle(m.id)}>${displayName(m)}</${Chip}>`)}</div>
      <${Field} label="הערה (לא חובה)"><${TextInput} value=${r.note || ''} maxlength="120" onInput=${(e) => setR({ ...r, note: e.target.value })} /></${Field}>
      ${error ? html`<p class="field__error" role="alert">${error}</p>` : null}
    </form>
  </${Sheet}>`;
}

/** For admins: the detail cards this trip doesn't use yet, one tap to open. */
export const EXTRAS = [
  { key: 'bookings', module: 'bookings', label: '🎫 הזמנות (טיסה, לינה)' },
  { key: 'costs', module: 'bookings', label: '🧮 עלויות לאדם' },
  { key: 'rooms', module: 'rooms', label: '🛏️ חדרים' },
];

export function MoreDetails({ trip, open, onOpen }) {
  const missing = EXTRAS.filter((x) => hasModule(trip, x.module) && !arr(trip.info?.[x.key]).length && !open[x.key]);
  if (!missing.length) return null;
  // one line of labelled links (ux T1) instead of a row of chips
  return html`<p class="more-details small" data-testid="more-details">
    <span class="muted">➕ עוד לטיול:</span>
    ${missing.map((x, i) => html`${i ? html`<span class="muted" aria-hidden="true"> · </span>` : null}<button type="button" key=${x.key}
      class="link" onClick=${() => onOpen(x.key)}>${x.label}</button>`)}
  </p>`;
}

/**
 * The shared photo album: one field, saved into info.album_url (update_trip merges info, so schedule / rules stay —
 * ux A4). Admins only (the server's update_trip). The trip screen's album card opens it; home.js has its own copy.
 */
export function AlbumSheet({ open, onClose, trip }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    setUrl(trip.info?.album_url || '');
    setError('');
    setSaving(false);
  }, [open]);
  const submit = async (e) => {
    e?.preventDefault();
    if (saving) return;
    const v = url.trim();
    if (v && (!/^https?:\/\/\S+$/i.test(v) || v.length > 500)) {
      setError('צריך קישור מלא שמתחיל ב-https://');
      return;
    }
    setSaving(true);
    const res = await actions.run(
      async (api) => { await api.updateTrip(trip.id, { info: { album_url: v || null } }); return true; },
      { success: v ? 'האלבום נשמר 📸 כולם רואים אותו' : 'הקישור לאלבום הוסר' },
    );
    setSaving(false);
    if (res) onClose();
  };
  return html`<${Sheet} open=${open} onClose=${onClose} title="📸 אלבום משותף"
    footer=${html`<${Button} type="submit" form="trip-album-form" block loading=${saving}>שמירה</${Button}>`}>
    <form id="trip-album-form" onSubmit=${submit} noValidate>
      <${Field} label="קישור לאלבום" hint="Google Photos / iCloud / Drive — יופיע לכולם" error=${error}>
        <${TextInput} type="url" dir="ltr" value=${url} placeholder="https://photos.app.goo.gl/…" autocomplete="off" data-autofocus
          onInput=${(e) => { setUrl(e.target.value); setError(''); }} />
      </${Field}>
    </form>
  </${Sheet}>`;
}
