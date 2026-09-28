// Rides & carpools: drivers offer seats; a passenger ASKS and the driver answers (or the driver
// INVITES and the passenger answers) — the side that asked is always told. Used on the trip
// screen and (compact) on the home screen on the day of the trip.
import { html } from 'htm/preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { actions, useTrip } from '../store.js';
import { navigate } from '../router.js';
import { displayName, formatTime, hebrewCount, ilIso, ilWall, rideModel } from '../lib/logic.js';
import { Avatar, Button, Card, Field, IconButton, Sheet, Skeleton, Stepper, TextInput, confirmDialog } from '../ui/components.js';

const cx = (...a) => a.filter(Boolean).join(' ');
const ok = (fn) => async (api) => {
  await fn(api);
  return true;
};

/** The rides tab: how I get there (one tap to say so) + every car. */
export default function RidesScreen({ route }) {
  const { snap, me, isAdmin } = useTrip();
  if (!snap || !me || snap.trip.id !== route?.params?.tripId) {
    return html`<div class="screen rides-screen" aria-busy="true"><${Skeleton} lines=${3} /><${Skeleton} lines=${5} /></div>`;
  }
  return html`<div class="screen rides-screen">
    <${MyArrival} snap=${snap} me=${me} />
    <${RidesCard} snap=${snap} me=${me} isAdmin=${isAdmin} />
  </div>`;
}

function MyArrival({ snap, me }) {
  const [busy, setBusy] = useState(null);
  const model = rideModel(snap, me.id);
  const mode = me.prefs?.transport?.mode;
  const tripId = snap.trip.id;
  const change = () => navigate(`/t/${tripId}/welcome?step=arrive`);
  const setMode = async (value) => {
    setBusy(value);
    await actions.run(ok((api) => api.updateMember(me.id, { prefs: { transport: { mode: value } } })),
      { success: value === 'need' ? 'סימנו שאתם מחפשים טרמפ 🙋 הנהגים יראו' : 'מעולה, סימנו ✅' });
    setBusy(null);
  };
  let status;
  if (model.myRide) status = `🚗 את/ה נוהג/ת · ${model.myRide.free ? hebrewCount(model.myRide.free, 'מקום פנוי', 'מקומות פנויים') : 'הרכב מלא'}`;
  else if (model.mySeat) status = `✅ ברכב של ${displayName(model.mySeat.driver)}`;
  else if (model.myAsk) status = `⏳ ביקשת מקום אצל ${displayName(model.myAsk.driver)}`;
  else if (mode === 'need') status = '🙋 מחפשים טרמפ';
  else if (mode === 'own') status = '🚌 מגיעים בדרך אחרת';
  const seeking = !model.myRide && !model.mySeat && (mode === 'need' || model.myAsk);
  return html`<${Card} emoji="🧭" title="איך אני מגיע/ה?" class="my-arrival" data-testid="my-arrival">
    ${status
      ? html`<div class="my-arrival__row"><b class="my-arrival__status">${status}</b>
          <${Button} variant="ghost" size="sm" onClick=${change}>שינוי</${Button}></div>`
      : html`<p class="muted small">עוד לא סימנת — לחיצה אחת:</p>
        <div class="my-arrival__opts">
          <${Button} variant="secondary" size="sm" onClick=${change}>🚗 אני נוהג/ת</${Button}>
          <${Button} variant="secondary" size="sm" loading=${busy === 'need'} onClick=${() => setMode('need')}>🙋 צריך/ה טרמפ</${Button}>
          <${Button} variant="secondary" size="sm" loading=${busy === 'own'} onClick=${() => setMode('own')}>🚌 מגיעים לבד</${Button}>
        </div>`}
    ${seeking ? html`<${RideOffers} snap=${snap} me=${me} />` : null}
  </${Card}>`;
}

/** Cars with room for someone who needs a ride — ask right here (rides tab, welcome wizard). */
export function RideOffers({ snap, me }) {
  const [busy, setBusy] = useState(null);
  const model = rideModel(snap, me.id);
  if (model.myRide || model.mySeat) return null;
  const myHeads = Math.max(1, Number(me.headcount) || 1);
  const open = model.rides.filter((r) => r.free > 0 || model.myAsk === r);
  const ask = async (r) => {
    setBusy(r.id);
    await actions.run(ok((api) => api.takeSeat(r.id, Math.min(myHeads, r.free))),
      { success: `הבקשה נשלחה ל${displayName(r.driver)} ⏳ נעדכן כשיענה/תענה` });
    setBusy(null);
  };
  if (!open.length) {
    return html`<p class="ride-offers__none muted small" data-testid="ride-offers">עוד אין רכבים עם מקום. ברגע שמישהו יוסיף רכב — נראה לך כאן, והנהגים רואים שאתם מחפשים 🙂</p>`;
  }
  return html`<div class="ride-offers" data-testid="ride-offers">
    <p class="ride-offers__title">רכבים עם מקום — מבקשים בלחיצה:</p>
    <ul class="ride-offers__list">
      ${open.map((r) => html`<li class="ride-offer" key=${r.id}>
        <${Avatar} member=${r.driver} size=${34} />
        <div class="ride-offer__main">
          <b>${displayName(r.driver)}</b>
          <span class="muted small">${[r.from_text && `📍 ${r.from_text}`, r.depart_at && `🕗 ${formatTime(r.depart_at)}`,
            hebrewCount(r.free, 'מקום פנוי', 'מקומות פנויים')].filter(Boolean).join(' · ')}</span>
        </div>
        ${model.myAsk === r
          ? html`<span class="ride-offer__wait small">⏳ מחכה לאישור</span>`
          : html`<${Button} size="sm" variant="secondary" loading=${busy === r.id} onClick=${() => ask(r)}>
              ${model.myAsk ? 'כאן במקום' : 'בקשה'}
            </${Button}>`}
      </li>`)}
    </ul>
  </div>`;
}

export function RidesCard({ snap, me, isAdmin, compact = false }) {
  const [sheet, setSheet] = useState(null); // null | 'new' | ride
  const [busy, setBusy] = useState(null);
  const model = rideModel(snap, me.id);
  const myHeads = Math.max(1, Number(me.headcount) || 1);
  const tripId = snap.trip.id;

  const act = async (key, fn, success) => {
    setBusy(key);
    await actions.run(ok(fn), { success });
    setBusy(null);
  };
  const ask = (ride) => act(ride.id, (api) => api.takeSeat(ride.id, Math.min(myHeads, ride.free)),
    `הבקשה נשלחה ל${displayName(ride.driver)} ⏳ נעדכן כשיענה/תענה`);
  const leave = (msg) => act('leave', (api) => api.leaveSeat(tripId), msg);
  const answer = (ride, member, yes) => act(`${ride.id}:${member.id}`, (api) => api.respondSeat(ride.id, member.id, yes),
    yes ? `${displayName(member)} ברכב ✅` : 'עדכנו אותם 🙏');
  const invite = (ride, member) => act(`inv:${member.id}`, (api) => api.inviteToRide(ride.id, member.id),
    `ההזמנה נשלחה ל${displayName(member)} ⏳`);
  const cancel = async (ride) => {
    const names = [...ride.passengers, ...ride.pending].map((p) => displayName(p.member));
    const yes = await confirmDialog({
      title: 'לבטל את ההסעה?',
      text: names.length ? `${names.join(', ')} יקבלו הודעה שצריך למצוא הסעה אחרת.` : 'הרכב יוסר מהרשימה.',
      confirmText: 'ביטול ההסעה', cancelText: 'השארה', danger: true,
    });
    if (!yes) return;
    await actions.run(ok((api) => api.deleteRide(ride.id)), { success: 'ההסעה בוטלה' });
  };

  const rides = compact ? model.rides.filter((r) => r === model.myRide || r === model.mySeat) : model.rides;
  if (compact && !rides.length) return null;
  const canInvite = model.myRide && model.myRide.free > 0;

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
        const asked = model.myAsk === r;
        const invited = model.invites.includes(r);
        const canManage = mine || isAdmin;
        return html`<li class=${cx('ride', mine && 'is-mine', inside && 'is-in')} key=${r.id} data-testid="ride">
          <div class="ride__head">
            <${Avatar} member=${r.driver} size=${40} />
            <div class="ride__main">
              <span class="ride__driver">${mine ? 'את/ה נוהג/ת' : displayName(r.driver)}</span>
              <span class=${cx('ride__seats', r.free === 0 && 'is-full')}>${r.free === 0 ? 'הרכב מלא' : `${hebrewCount(r.free, 'מקום פנוי', 'מקומות פנויים')}`}</span>
            </div>
            ${canManage
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

          ${canManage && r.pending.length
            ? html`<ul class="ride__asks" aria-label="בקשות שמחכות">
                ${r.pending.map((p) => html`<li class="ride__ask" key=${p.member.id} data-testid="ride-ask">
                  <${Avatar} member=${p.member} size=${26} />
                  ${p.requestedBy === 'passenger'
                    ? html`<span class="ride__ask-text"><b>${displayName(p.member)}</b> מבקש/ת להצטרף${p.seats > 1 ? ` (${p.seats})` : ''}</span>
                      <${Button} size="sm" loading=${busy === `${r.id}:${p.member.id}`} disabled=${p.seats > r.free}
                        onClick=${() => answer(r, p.member, true)}>אישור</${Button}>
                      <${Button} size="sm" variant="ghost" onClick=${() => answer(r, p.member, false)}>לא הפעם</${Button}>`
                    : html`<span class="ride__ask-text">⏳ הוזמנו: <b>${displayName(p.member)}</b></span>`}
                </li>`)}
              </ul>`
            : null}

          ${invited
            ? html`<div class="ride__invite" data-testid="ride-invite">
                <span><b>${displayName(r.driver)}</b> מזמין/ה אותך לרכב 🚗</span>
                <${Button} size="sm" loading=${busy === `${r.id}:${me.id}`} onClick=${() => answer(r, me, true)}>מצטרפים</${Button}>
                <${Button} size="sm" variant="ghost" onClick=${() => answer(r, me, false)}>לא, תודה</${Button}>
              </div>`
            : !mine && !model.myRide
              ? inside
                ? html`<${Button} variant="ghost" size="sm" loading=${busy === 'leave'} onClick=${() => leave('ירדת מהרכב')}>יורד/ת מהרכב</${Button}>`
                : asked
                  ? html`<div class="ride__waiting" data-testid="ride-waiting">
                      <span>⏳ מחכה לאישור של ${displayName(r.driver)}</span>
                      <${Button} variant="ghost" size="sm" loading=${busy === 'leave'} onClick=${() => leave('הבקשה בוטלה')}>ביטול הבקשה</${Button}>
                    </div>`
                  : r.free > 0 && !model.mySeat
                    ? html`<${Button} variant="secondary" size="sm" loading=${busy === r.id} onClick=${() => ask(r)}>
                        ${model.myAsk ? 'לבקש כאן במקום' : 'מבקשים להצטרף'}${Math.min(myHeads, r.free) > 1 ? ` (${Math.min(myHeads, r.free)} מקומות)` : ''}
                      </${Button}>`
                    : null
              : null}
        </li>`;
      })}
    </ul>

    ${!compact && model.seeking.length
      ? html`<div class="rides__seeking small" data-testid="rides-seeking"><b>🙋 מחפשים טרמפ:</b>
          <ul class="rides__seekers">
            ${model.seeking.map((x) => {
              const invitedAlready = model.myRide?.pending.some((p) => p.member.id === x.member.id);
              return html`<li key=${x.member.id}>
                ${displayName(x.member)}${x.from ? ` (מ${x.from})` : ''}
                ${canInvite && !invitedAlready
                  ? html` <${Button} size="sm" variant="ghost" loading=${busy === `inv:${x.member.id}`}
                      onClick=${() => invite(model.myRide, x.member)}>הזמנה לרכב שלי</${Button}>`
                  : invitedAlready ? html` <span class="muted">· הוזמנו ⏳</span>` : null}
              </li>`;
            })}
          </ul>
        </div>`
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
