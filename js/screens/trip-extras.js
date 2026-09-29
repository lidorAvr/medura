// Trip detail cards an admin fills once for everyone (trips.info): group bookings (flights, the hotel,
// reservations), what the trip costs per person, and who sleeps in which room. Members read; admins edit.
// Times here are wall-clock strings ('YYYY-MM-DDTHH:MM', local to the place) — shown as typed.
import { html } from 'htm/preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { actions } from '../store.js?v=6582265';
import { displayName, formatMoney, hebrewCount } from '../lib/logic.js?v=6582265';
import { symbolOf } from '../lib/fx.js?v=6582265';
import { Button, Card, Chip, Field, IconButton, Segmented, Sheet, Stepper, TextInput, confirmDialog } from '../ui/components.js?v=6582265';

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

// ---------------------------------------------------------------------------
// bookings
// ---------------------------------------------------------------------------

export function BookingsCard({ trip, isAdmin, force }) {
  const list = arr(trip.info?.bookings);
  const [sheet, setSheet] = useState(null); // null | {index, booking}
  if (!list.length && !(isAdmin && force)) return null;
  const remove = async (i) => {
    if (!(await confirmDialog({ title: 'למחוק את ההזמנה?', confirmText: 'מחיקה', danger: true }))) return;
    await save(trip, 'bookings', list.filter((_, j) => j !== i), 'נמחק');
  };
  return html`<${Card} emoji="🎫" title="הזמנות" class="bookings" data-testid="bookings">
    ${list.length
      ? html`<ul class="bookings__list">
          ${list.map((b, i) => html`<li class=${cx('booking', `booking--${b.kind}`)} key=${i} data-testid="booking">
            <div class="booking__main">${bookingBody(b)}</div>
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
    <${BookingSheet} open=${Boolean(sheet)} data=${sheet} onClose=${() => setSheet(null)}
      onSave=${async (b) => {
        const next = [...list];
        if (sheet.index >= 0) next[sheet.index] = b;
        else next.push(b);
        next.sort((x, y) => String(x.at || x.check_in || '~').localeCompare(String(y.at || y.check_in || '~')));
        return save(trip, 'bookings', next, 'נשמר ✅');
      }} />
  </${Card}>`;
}

function bookingBody(b) {
  if (b.kind === 'flight') {
    return html`<p class="booking__title">${b.leg === 'back' ? '🛬 טיסה חזור' : '🛫 טיסה הלוך'}
        ${b.flight ? html` · <b dir="ltr">${b.flight}</b>` : null}${b.airline ? ` · ${b.airline}` : ''}</p>
      <p class="booking__line">${[wall(b.at), [b.from, b.to].filter(Boolean).join(' ← ')].filter(Boolean).join(' · ')}</p>
      ${b.baggage ? html`<p class="booking__line">🧳 ${b.baggage}</p>` : null}
      ${b.ref ? html`<p class="booking__line">🔖 הזמנה <b dir="ltr">${b.ref}</b></p>` : null}
      ${b.note ? html`<p class="booking__line muted">📝 ${b.note}</p>` : null}`;
  }
  if (b.kind === 'hotel') {
    return html`<p class="booking__title">🏨 ${b.name || 'לינה'}</p>
      ${b.address ? html`<p class="booking__line">📍 ${b.address}</p>` : null}
      <p class="booking__line">${[b.check_in && `צ׳ק־אין ${wall(b.check_in)}`, b.check_out && `צ׳ק־אאוט ${wall(b.check_out)}`].filter(Boolean).join(' · ')}</p>
      ${b.pay ? html`<p class="booking__line">💳 ${PAY[b.pay] || b.pay}${b.price ? ` · ${b.price}` : ''}</p>` : null}
      ${b.cancel ? html`<p class="booking__line">↩️ ${b.cancel}</p>` : null}
      ${b.note ? html`<p class="booking__line muted">📝 ${b.note}</p>` : null}
      ${b.url ? html`<a class="booking__link" href=${b.url} target="_blank" rel="noopener noreferrer">לפרטי ההזמנה ↗</a>` : null}`;
  }
  return html`<p class="booking__title">🎟️ ${b.title || 'הזמנה'}</p>
    ${b.at ? html`<p class="booking__line">🕗 ${wall(b.at)}</p>` : null}
    ${b.note ? html`<p class="booking__line muted">📝 ${b.note}</p>` : null}
    ${b.url ? html`<a class="booking__link" href=${b.url} target="_blank" rel="noopener noreferrer">קישור ↗</a>` : null}`;
}

function BookingSheet({ open, data, onClose, onSave }) {
  const [b, setB] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useLayoutEffect(() => {
    if (!open) return;
    setB({ ...(data?.booking || {}) });
    setBusy(false);
    setError(null);
  }, [open]);
  const set = (k) => (e) => setB((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
  const submit = async (e) => {
    e?.preventDefault();
    const clean = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]).filter(([, v]) => v !== '' && v != null));
    if (clean.kind === 'hotel' && !clean.name) return setError('איך קוראים למקום?');
    if (clean.kind === 'other' && !clean.title) return setError('מה הוזמן?');
    if (clean.flight) clean.flight = clean.flight.toUpperCase().replace(/\s+/g, '');
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
        ? html`<${Segmented} label="כיוון" value=${b.leg || 'out'} onChange=${set('leg')}
            options=${[{ value: 'out', label: '🛫 הלוך' }, { value: 'back', label: '🛬 חזור' }]} />
          <div class="date-pair">
            <${Field} label="מספר טיסה"><${TextInput} dir="ltr" value=${b.flight || ''} maxlength="12" placeholder="LY2513" onInput=${set('flight')} /></${Field}>
            <${Field} label="חברה"><${TextInput} value=${b.airline || ''} maxlength="40" placeholder="אל על" onInput=${set('airline')} /></${Field}>
          </div>
          <${Field} label="המראה (שעה מקומית)"><${TextInput} type="datetime-local" value=${b.at || ''} onInput=${set('at')} /></${Field}>
          <div class="date-pair">
            <${Field} label="מ…"><${TextInput} value=${b.from || ''} maxlength="40" placeholder="נתב״ג" onInput=${set('from')} /></${Field}>
            <${Field} label="ל…"><${TextInput} value=${b.to || ''} maxlength="40" placeholder="בוקרשט" onInput=${set('to')} /></${Field}>
          </div>
          <${Field} label="כבודה"><${TextInput} value=${b.baggage || ''} maxlength="80" placeholder="טרולי + תיק גב" onInput=${set('baggage')} /></${Field}>
          <${Field} label="קוד הזמנה (לא חובה)"><${TextInput} dir="ltr" value=${b.ref || ''} maxlength="20" onInput=${set('ref')} /></${Field}>`
        : null}
      ${kind === 'hotel'
        ? html`<${Field} label="שם המקום"><${TextInput} value=${b.name || ''} maxlength="60" placeholder="Park Inn" onInput=${set('name')} /></${Field}>
          <${Field} label="כתובת"><${TextInput} value=${b.address || ''} maxlength="120" onInput=${set('address')} /></${Field}>
          <div class="date-pair">
            <${Field} label="צ׳ק־אין"><${TextInput} type="datetime-local" value=${b.check_in || ''} onInput=${set('check_in')} /></${Field}>
            <${Field} label="צ׳ק־אאוט"><${TextInput} type="datetime-local" value=${b.check_out || ''} onInput=${set('check_out')} /></${Field}>
          </div>
          <p class="field__label">תשלום</p>
          <div class="sched-quick">${['onsite', 'organizer', 'paid'].map((k) => html`<${Chip} key=${k} active=${b.pay === k} onClick=${() => set('pay')(k)}>${PAY[k]}</${Chip}>`)}</div>
          <${Field} label="מחיר (לא חובה)"><${TextInput} value=${b.price || ''} maxlength="60" placeholder="₪1,054 לאדם" onInput=${set('price')} /></${Field}>
          <${Field} label="ביטול"><${TextInput} value=${b.cancel || ''} maxlength="120" placeholder="ביטול חינם עד 3 ימים לפני" onInput=${set('cancel')} /></${Field}>
          <${Field} label="קישור (לא חובה)"><${TextInput} type="url" dir="ltr" value=${b.url || ''} maxlength="500" placeholder="https://…" onInput=${set('url')} /></${Field}>`
        : null}
      ${kind === 'other'
        ? html`<${Field} label="מה הוזמן?"><${TextInput} value=${b.title || ''} maxlength="60" placeholder="שולחן במסעדה, שייט, קארטינג…" onInput=${set('title')} /></${Field}>
          <${Field} label="מתי"><${TextInput} type="datetime-local" value=${b.at || ''} onInput=${set('at')} /></${Field}>
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
  { key: 'bookings', label: '🎫 הזמנות (טיסה, לינה)' },
  { key: 'costs', label: '🧮 עלויות לאדם' },
  { key: 'rooms', label: '🛏️ חדרים' },
];

export function MoreDetails({ trip, open, onOpen }) {
  const missing = EXTRAS.filter((x) => !arr(trip.info?.[x.key]).length && !open[x.key]);
  if (!missing.length) return null;
  return html`<div class="more-details" data-testid="more-details">
    <span class="small muted">➕ עוד לטיול:</span>
    ${missing.map((x) => html`<${Chip} key=${x.key} onClick=${() => onOpen(x.key)}>${x.label}</${Chip}>`)}
  </div>`;
}
