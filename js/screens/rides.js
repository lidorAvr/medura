// Rides & carpools (phase 2): drivers offer seats, everyone else hops in. Used on the trip screen
// and (compact) on the home screen on the day of the trip.
import { html } from 'htm/preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { actions } from '../store.js';
import { displayName, formatTime, hebrewCount, ilIso, ilWall, rideModel } from '../lib/logic.js';
import { Avatar, Button, Card, Field, IconButton, Sheet, Stepper, TextInput, confirmDialog } from '../ui/components.js';

const cx = (...a) => a.filter(Boolean).join(' ');
const ok = (fn) => async (api) => {
  await fn(api);
  return true;
};

export function RidesCard({ snap, me, isAdmin, compact = false }) {
  const [sheet, setSheet] = useState(null); // null | 'new' | ride
  const [busy, setBusy] = useState(null);
  const model = rideModel(snap, me.id);
  const myHeads = Math.max(1, Number(me.headcount) || 1);
  const tripId = snap.trip.id;

  const take = async (ride) => {
    const n = Math.min(myHeads, ride.free);
    setBusy(ride.id);
    await actions.run(ok((api) => api.takeSeat(ride.id, n)), { success: `את/ה ברכב של ${displayName(ride.driver)} 🚗` });
    setBusy(null);
  };
  const leave = async () => {
    setBusy('leave');
    await actions.run(ok((api) => api.leaveSeat(tripId)), { success: 'ירדת מהרכב' });
    setBusy(null);
  };
  const cancel = async (ride) => {
    const yes = await confirmDialog({
      title: 'לבטל את ההסעה?',
      text: ride.passengers.length ? `${ride.passengers.map((p) => displayName(p.member)).join(', ')} יקבלו הודעה שצריך למצוא הסעה אחרת.` : 'הרכב יוסר מהרשימה.',
      confirmText: 'ביטול ההסעה', cancelText: 'השארה', danger: true,
    });
    if (!yes) return;
    await actions.run(ok((api) => api.deleteRide(ride.id)), { success: 'ההסעה בוטלה' });
  };

  const rides = compact ? model.rides.filter((r) => r === model.myRide || r === model.mySeat) : model.rides;
  if (compact && !rides.length) return null;

  return html`<${Card} emoji="🚗" title=${compact ? 'ההסעה שלך' : 'הסעות וטרמפים'} class=${cx('rides', compact && 'rides--compact')}>
    ${!compact
      ? html`<p class="rides__sum muted small" data-testid="rides-summary">
          ${model.rides.length
            ? `${hebrewCount(model.rides.length, 'רכב', 'רכבים')} · ${hebrewCount(model.freeSeats, 'מקום פנוי', 'מקומות פנויים')}`
            : 'עוד אין רכבים — מי נוהג/ת?'}
        </p>`
      : null}

    <ul class="rides__list">
      ${rides.map((r) => {
        const mine = r.driver_member === me.id;
        const inside = r.passengers.some((p) => p.member.id === me.id);
        const canEdit = mine || isAdmin;
        return html`<li class=${cx('ride', mine && 'is-mine', inside && 'is-in')} key=${r.id} data-testid="ride">
          <div class="ride__head">
            <${Avatar} member=${r.driver} size=${40} />
            <div class="ride__main">
              <span class="ride__driver">${mine ? 'את/ה נוהג/ת' : displayName(r.driver)}</span>
              <span class=${cx('ride__seats', r.free === 0 && 'is-full')}>${r.free === 0 ? 'הרכב מלא' : `${hebrewCount(r.free, 'מקום פנוי', 'מקומות פנויים')}`}</span>
            </div>
            ${canEdit
              ? html`<div class="ride__tools">
                  <${IconButton} icon="edit" label=${`עריכת ההסעה של ${displayName(r.driver)}`} onClick=${() => setSheet(r)} />
                  <${IconButton} icon="trash" label=${`ביטול ההסעה של ${displayName(r.driver)}`} onClick=${() => cancel(r)} />
                </div>`
              : null}
          </div>
          <p class="ride__meta">
            ${[r.depart_at && `🕗 יציאה ${formatTime(r.depart_at)}`, r.from_text && `📍 ${r.from_text}`].filter(Boolean).join(' · ') || 'פרטי יציאה בקרוב'}
          </p>
          ${r.passengers.length
            ? html`<div class="ride__pass">
                ${r.passengers.map((p) => html`<span class="ride__chip" key=${p.member.id}>
                  <${Avatar} member=${p.member} size=${22} /> ${displayName(p.member)}${p.seats > 1 ? ` ×${p.seats}` : ''}
                </span>`)}
              </div>`
            : null}
          ${r.note ? html`<p class="ride__note">📝 ${r.note}</p>` : null}
          ${!mine && !model.myRide
            ? inside
              ? html`<${Button} variant="ghost" size="sm" loading=${busy === 'leave'} onClick=${leave}>יורד/ת מהרכב</${Button}>`
              : r.free > 0
                ? html`<${Button} variant="secondary" size="sm" loading=${busy === r.id} onClick=${() => take(r)}>
                    ${model.mySeat ? 'עוברים לרכב הזה' : 'מצטרפים'}${Math.min(myHeads, r.free) > 1 ? ` (${Math.min(myHeads, r.free)} מקומות)` : ''}
                  </${Button}>`
                : null
            : null}
        </li>`;
      })}
    </ul>

    ${!compact && model.seeking.length
      ? html`<p class="rides__seeking small" data-testid="rides-seeking"><b>🙋 מחפשים טרמפ:</b>
          ${model.seeking.map((x) => `${displayName(x.member)}${x.from ? ` (מ${x.from})` : ''}`).join(' · ')}</p>`
      : null}
    ${!compact && model.rides.length && model.without.length > model.seeking.length
      ? html`<p class="rides__without small"><b>עוד לא ידוע איך מגיעים:</b>
          ${model.without.filter((m) => !model.seeking.some((x) => x.member.id === m.id)).map(displayName).join(' · ')}</p>`
      : null}
    ${!compact && !model.myRide
      ? html`<${Button} variant=${model.rides.length ? 'ghost' : 'secondary'} icon="plus" block onClick=${() => setSheet('new')}>
          אני נוהג/ת — יש לי מקום
        </${Button}>`
      : null}
    <${RideSheet} open=${Boolean(sheet)} ride=${sheet && sheet !== 'new' ? sheet : null} trip=${snap.trip} onClose=${() => setSheet(null)} />
  </${Card}>`;
}

function RideSheet({ open, ride, trip, onClose }) {
  const [seats, setSeats] = useState(3);
  const [from, setFrom] = useState('');
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    setSeats(ride ? ride.seats : 3);
    setFrom(ride?.from_text || '');
    setTime(ride?.depart_at ? ilWall(new Date(ride.depart_at)).hm : '');
    setNote(ride?.note || '');
    setSaving(false);
  }, [open, ride?.id]);

  const minSeats = ride ? Math.max(1, ride.taken) : 1;
  const save = async (e) => {
    e?.preventDefault();
    const day = trip.starts_at ? ilWall(new Date(trip.starts_at)).ymd : ilWall(new Date()).ymd;
    const payload = {
      seats,
      from_text: from.trim() || null,
      depart_at: time ? ilIso(day, time) : null,
      note: note.trim() || null,
      ...(ride ? { id: ride.id } : {}),
    };
    setSaving(true);
    const done = await actions.run(ok((api) => api.upsertRide(trip.id, payload)), { success: ride ? 'ההסעה עודכנה 🚗' : 'תודה! הרכב שלך ברשימה 🚗' });
    setSaving(false);
    if (done) onClose();
  };

  return html`<${Sheet} open=${open} onClose=${onClose} title=${ride ? 'עריכת ההסעה 🚗' : 'יש לי מקום ברכב 🚗'}
    footer=${html`<${Button} type="submit" form="ride-form" icon="check" loading=${saving}>${ride ? 'שמירה' : 'הוספה'}</${Button}>
      <${Button} variant="secondary" onClick=${onClose}>ביטול</${Button}>`}>
    <form id="ride-form" class="stack-lg" onSubmit=${save} noValidate>
      <div class="ride-form__seats">
        <span class="field__label">כמה מקומות פנויים (בלי הנהג/ת)?</span>
        <${Stepper} value=${seats} min=${minSeats} max=${8} label="מקומות פנויים" onChange=${setSeats} />
      </div>
      <${Field} label="יוצאים מ… (לא חובה)">
        <${TextInput} value=${from} maxlength="80" placeholder="למשל: תל אביב, רכבת השלום" onInput=${(e) => setFrom(e.target.value)} />
      </${Field}>
      <${Field} label="שעת יציאה (לא חובה)">
        <${TextInput} type="time" value=${time} onInput=${(e) => setTime(e.target.value)} />
      </${Field}>
      <${Field} label="הערה (לא חובה)">
        <${TextInput} value=${note} maxlength="200" placeholder="למשל: יש מקום לצידנית אחת" onInput=${(e) => setNote(e.target.value)} />
      </${Field}>
    </form>
  </${Sheet}>`;
}
