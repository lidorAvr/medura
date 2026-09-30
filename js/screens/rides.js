// Getting there: cars (a driver offers seats), shared taxis (someone organises), meeting points (a train,
// a bus, the airport — join without approval), flights. A passenger ASKS and the organiser answers (or
// the organiser INVITES and the passenger answers) — the side that asked is always told. The admin
// picks which ways a trip offers (settings.arrival). Used on the rides tab, the trip screen and the wizard.
import { html } from 'htm/preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { actions, useTrip } from '../store.js?v=65baf9b';
import { navigate } from '../router.js?v=65baf9b';
import { displayName, flightModel, formatDate, formatTime, hebrewCount, ilIso, ilWall, rideModel } from '../lib/logic.js?v=65baf9b';
import { ARRIVAL_MODES, arrivalOf } from '../lib/templates.js?v=65baf9b';
import { wall } from './trip-extras.js?v=65baf9b';
import { Avatar, Button, Card, Field, IconButton, Sheet, Skeleton, Stepper, TextInput, confirmDialog } from '../ui/components.js?v=65baf9b';

const cx = (...a) => a.filter(Boolean).join(' ');
const ok = (fn) => async (api) => {
  await fn(api);
  return true;
};
const kindOf = (r) => r?.kind || 'car';
const model_kinds = (snap) => (snap?.rides || []).map(kindOf);

/** Words per kind of ride: who runs it, how to say "I'm in", what a place is called. */
const KIND = {
  car: { emoji: '🚗', mine: 'את/ה נוהג/ת', of: (n) => `הרכב של ${n}`, in: (n) => `ברכב של ${n}`, ask: 'מבקשים להצטרף', unit: ['מקום פנוי', 'מקומות פנויים'] },
  taxi: { emoji: '🚕', mine: 'את/ה מארגן/ת מונית', of: (n) => `מונית משותפת · ${n}`, in: (n) => `במונית של ${n}`, ask: 'מבקשים להצטרף', unit: ['מקום פנוי', 'מקומות פנויים'] },
  meet: { emoji: '🚆', mine: 'קבעת נקודת מפגש', of: (n) => `נקודת מפגש · ${n}`, in: (n) => `בנקודת המפגש של ${n}`, ask: 'מצטרפים', unit: ['מצטרף/ת', 'מצטרפים'] },
};

/** The rides tab: how I get there (one tap to say so), flights, and every car / taxi / meeting point. */
export default function RidesScreen({ route }) {
  const { snap, me, isAdmin } = useTrip();
  const [sheet, setSheet] = useState(null); // null | {kind} (new) | ride
  if (!snap || !me || snap.trip.id !== route?.params?.tripId) {
    return html`<div class="screen rides-screen" aria-busy="true"><${Skeleton} lines=${3} /><${Skeleton} lines=${5} /></div>`;
  }
  const arrival = arrivalOf(snap.trip);
  return html`<div class="screen rides-screen">
    <${MyArrival} snap=${snap} me=${me} onOffer=${(kind) => setSheet({ kind })} />
    ${arrival.flights ? html`<${FlightsCard} snap=${snap} me=${me} />` : null}
    <${RidesCard} snap=${snap} me=${me} isAdmin=${isAdmin} sheet=${sheet} setSheet=${setSheet} />
  </div>`;
}

function MyArrival({ snap, me, onOffer }) {
  const [busy, setBusy] = useState(null);
  const model = rideModel(snap, me.id);
  const { modes } = arrivalOf(snap.trip);
  const rideModes = modes.filter((m) => m !== 'own');
  const mode = me.prefs?.transport?.mode;
  const setMode = async (value) => {
    setBusy(value);
    await actions.run(ok((api) => api.updateMember(me.id, { prefs: { transport: { mode: value } } })),
      { success: value === 'need' ? 'סימנו שאתם מחפשים מקום 🙋 המארגנים יראו' : 'מעולה, סימנו ✅' });
    setBusy(null);
  };
  let status;
  if (model.myRide) {
    const k = KIND[kindOf(model.myRide)];
    status = `${k.emoji} ${k.mine}${kindOf(model.myRide) === 'meet' ? ` · ${hebrewCount(model.myRide.taken, 'מצטרף/ת', 'מצטרפים')}`
      : ` · ${model.myRide.free ? hebrewCount(model.myRide.free, 'מקום פנוי', 'מקומות פנויים') : 'מלא'}`}`;
  } else if (model.mySeat) status = `✅ ${KIND[kindOf(model.mySeat)].in(displayName(model.mySeat.driver))}`;
  else if (model.myAsk) status = `⏳ ביקשת מקום אצל ${displayName(model.myAsk.driver)}`;
  else if (mode === 'need') status = '🙋 מחפשים מקום';
  else if (mode === 'own') status = '🧍 מגיעים בדרך שלנו';
  const seeking = !model.myRide && !model.mySeat && (mode === 'need' || model.myAsk);
  const change = () => setMode(null);
  return html`<${Card} emoji="🧭" title="איך אני מגיע/ה?" class="my-arrival" data-testid="my-arrival">
    ${status
      ? html`<div class="my-arrival__row"><b class="my-arrival__status">${status}</b>
          ${model.myRide || model.mySeat || model.myAsk
            ? null
            : html`<${Button} variant="ghost" size="sm" onClick=${change}>שינוי</${Button}>`}</div>`
      : html`<p class="muted small">עוד לא סימנת — לחיצה אחת:</p>
        <div class="my-arrival__opts">
          ${rideModes.map((k) => {
            const m = ARRIVAL_MODES.find((x) => x.key === k);
            return html`<${Button} key=${k} variant="secondary" size="sm" onClick=${() => onOffer(k)}>${m.emoji} ${m.offer}</${Button}>`;
          })}
          ${rideModes.length
            ? html`<${Button} variant="secondary" size="sm" loading=${busy === 'need'} onClick=${() => setMode('need')}>🙋 מחפש/ת מקום</${Button}>`
            : null}
          ${modes.includes('own')
            ? html`<${Button} variant="secondary" size="sm" loading=${busy === 'own'} onClick=${() => setMode('own')}>🧍 מגיעים לבד</${Button}>`
            : null}
        </div>`}
    ${seeking ? html`<${RideOffers} snap=${snap} me=${me} />` : null}
  </${Card}>`;
}

/** Rides with room for someone who needs one — ask (or join a meeting point) right here. */
export function RideOffers({ snap, me }) {
  const [busy, setBusy] = useState(null);
  const model = rideModel(snap, me.id);
  if (model.myRide || model.mySeat) return null;
  const myHeads = Math.max(1, Number(me.headcount) || 1);
  const open = model.rides.filter((r) => r.free > 0 || model.myAsk === r);
  const ask = async (r) => {
    setBusy(r.id);
    const meet = kindOf(r) === 'meet';
    await actions.run(ok((api) => api.takeSeat(r.id, Math.min(myHeads, r.free))),
      { success: meet ? 'הצטרפת לנקודת המפגש ✅' : `הבקשה נשלחה ל${displayName(r.driver)} ⏳ נעדכן כשיענה/תענה` });
    setBusy(null);
  };
  if (!open.length) {
    return html`<p class="ride-offers__none muted small" data-testid="ride-offers">עוד אין מקומות פנויים. ברגע שמישהו יציע — נראה לך כאן, והמארגנים רואים שאתם מחפשים 🙂</p>`;
  }
  return html`<div class="ride-offers" data-testid="ride-offers">
    <p class="ride-offers__title">יש מקום — בלחיצה:</p>
    <ul class="ride-offers__list">
      ${open.map((r) => {
        const k = KIND[kindOf(r)];
        return html`<li class="ride-offer" key=${r.id}>
          <${Avatar} member=${r.driver} size=${34} />
          <div class="ride-offer__main">
            <b>${k.emoji} ${displayName(r.driver)}</b>
            <span class="muted small">${[r.from_text && `📍 ${r.from_text}`, r.to_text && `← ${r.to_text}`, r.depart_at && `🕗 ${formatTime(r.depart_at)}`,
              kindOf(r) === 'meet' ? null : hebrewCount(r.free, 'מקום פנוי', 'מקומות פנויים')].filter(Boolean).join(' · ')}</span>
          </div>
          ${model.myAsk === r
            ? html`<span class="ride-offer__wait small">⏳ מחכה לאישור</span>`
            : html`<${Button} size="sm" variant="secondary" loading=${busy === r.id} onClick=${() => ask(r)}>
                ${kindOf(r) === 'meet' ? 'מצטרפים' : model.myAsk ? 'כאן במקום' : 'בקשה'}
              </${Button}>`}
        </li>`;
      })}
    </ul>
  </div>`;
}

/** Flights: mine (out / back) and who's on which flight. */
function FlightsCard({ snap, me }) {
  const travel = me.prefs?.travel || {};
  const [editing, setEditing] = useState(false);
  const [out, setOut] = useState({ flight: travel.out?.flight || '', at: travel.out?.at || '' });
  const [back, setBack] = useState({ flight: travel.back?.flight || '', at: travel.back?.at || '' });
  const [busy, setBusy] = useState(false);
  const outs = flightModel(snap, 'out');
  const backs = flightModel(snap, 'back');
  const save = async (e) => {
    e?.preventDefault();
    setBusy(true);
    const clean = (f) => (f.flight.trim() ? { flight: f.flight.trim().toUpperCase(), at: f.at || null } : null);
    const done = await actions.run(ok((api) => api.updateMember(me.id, { prefs: { travel: { out: clean(out), back: clean(back) } } })),
      { success: 'הטיסות נשמרו ✈️' });
    setBusy(false);
    if (done) setEditing(false);
  };
  const when = (at) => wall(at);
  const bookings = Array.isArray(snap.trip.info?.bookings) ? snap.trip.info.bookings : [];
  const group = (m, title, leg) => {
    const gf = bookings.find((b) => b.kind === 'flight' && (b.leg || 'out') === leg && b.flight);
    if (gf) {
      // the group's flight: everyone is on it unless they listed another one
      const others = m.flights.filter((g) => g.flight !== gf.flight);
      const away = new Set(others.flatMap((g) => g.members.map((x) => x.id)));
      const notOn = snap.members.filter((x) => away.has(x.id));
      return html`<div class="flights__leg">
        <p class="flights__title">${title}</p>
        <ul class="flights__list">
          <li class="flights__row is-group"><b dir="ltr">${gf.flight}</b> <span class="muted small">${when(gf.at)}</span>
            <span class="flights__who small">${notOn.length ? `כולם חוץ מ: ${notOn.map(displayName).join(' · ')}` : 'כולם 👥'}</span></li>
          ${others.map((g) => html`<li key=${g.flight} class="flights__row"><b dir="ltr">${g.flight}</b> ${g.at ? html`<span class="muted small">${when(g.at)}</span>` : null}
            <span class="flights__who small">${g.members.map(displayName).join(' · ')}</span></li>`)}
        </ul>
      </div>`;
    }
    return html`<div class="flights__leg">
    <p class="flights__title">${title}</p>
    ${m.flights.length
      ? html`<ul class="flights__list">${m.flights.map((g) => html`<li key=${g.flight} class="flights__row">
          <b dir="ltr">${g.flight}</b> ${g.at ? html`<span class="muted small">${when(g.at)}</span>` : null}
          <span class="flights__who small">${g.members.map(displayName).join(' · ')}</span>
        </li>`)}</ul>`
      : html`<p class="muted small">עוד אף אחד לא סימן.</p>`}
  </div>`;
  };
  const groupFlights = bookings.some((b) => b.kind === 'flight' && b.flight);
  const mine = travel.out?.flight || travel.back?.flight;
  return html`<${Card} emoji="✈️" title="טיסות" class="flights" data-testid="flights">
    ${editing
      ? html`<form class="stack" onSubmit=${save} noValidate>
          <div class="date-pair">
            <${Field} label="טיסה הלוך"><${TextInput} dir="ltr" value=${out.flight} maxlength="12" placeholder="LY315" onInput=${(e) => setOut({ ...out, flight: e.target.value })} /></${Field}>
            <${Field} label="מתי"><${TextInput} type="datetime-local" value=${out.at} onInput=${(e) => setOut({ ...out, at: e.target.value })} /></${Field}>
          </div>
          <div class="date-pair">
            <${Field} label="טיסה חזור"><${TextInput} dir="ltr" value=${back.flight} maxlength="12" placeholder="LY316" onInput=${(e) => setBack({ ...back, flight: e.target.value })} /></${Field}>
            <${Field} label="מתי"><${TextInput} type="datetime-local" value=${back.at} onInput=${(e) => setBack({ ...back, at: e.target.value })} /></${Field}>
          </div>
          <div class="row wrap">
            <${Button} type="submit" size="sm" loading=${busy}>שמירה</${Button}>
            <${Button} variant="ghost" size="sm" onClick=${() => setEditing(false)}>ביטול</${Button}>
          </div>
        </form>`
      : html`<div class="my-arrival__row">
          <span>${mine ? html`הטיסות שלך: <b dir="ltr">${[travel.out?.flight, travel.back?.flight].filter(Boolean).join(' / ')}</b>` : groupFlights ? 'את/ה על טיסת הקבוצה' : 'עוד לא סימנת טיסה'}</span>
          <${Button} variant=${mine || groupFlights ? 'ghost' : 'secondary'} size="sm" onClick=${() => setEditing(true)}>${mine ? 'עריכה' : groupFlights ? 'טס/ה בטיסה אחרת?' : '✈️ הטיסה שלי'}</${Button}>
        </div>`}
    ${group(outs, '🛫 הלוך', 'out')}
    ${group(backs, '🛬 חזור', 'back')}
    ${!groupFlights && outs.missing.length && outs.flights.length
      ? html`<p class="muted small">עוד לא סימנו: ${outs.missing.map(displayName).join(' · ')}</p>`
      : null}
  </${Card}>`;
}

export function RidesCard({ snap, me, isAdmin, compact = false, sheet: outerSheet, setSheet: outerSet }) {
  const [ownSheet, setOwnSheet] = useState(null); // null | {kind} (new) | ride
  const sheet = outerSet ? outerSheet : ownSheet;
  const setSheet = outerSet || setOwnSheet;
  const { modes } = arrivalOf(snap.trip);
  const offerModes = ARRIVAL_MODES.filter((m) => m.key !== 'own' && modes.includes(m.key));
  const carsOnly = model_kinds(snap).every((k) => k === 'car') && offerModes.every((m) => m.key === 'car');
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
    kindOf(ride) === 'meet' ? 'הצטרפת לנקודת המפגש ✅' : `הבקשה נשלחה ל${displayName(ride.driver)} ⏳ נעדכן כשיענה/תענה`);
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

  return html`<${Card} emoji="🚗" title=${compact ? 'ההסעה שלך' : carsOnly ? 'הסעות וטרמפים' : 'כל האפשרויות להגיע'} class=${cx('rides', compact && 'rides--compact')}>
    ${!compact
      ? html`<p class="rides__sum muted small" data-testid="rides-summary">
          ${model.rides.length
            ? `${carsOnly ? hebrewCount(model.rides.length, 'רכב', 'רכבים') : hebrewCount(model.rides.length, 'אפשרות', 'אפשרויות')} · ${hebrewCount(model.freeSeats, 'מקום פנוי', 'מקומות פנויים')}`
            : carsOnly ? 'עוד אין רכבים — מי נוהג/ת?' : 'עוד אין הצעות — מי מארגן/ת?'}
        </p>`
      : null}

    <ul class="rides__list">
      ${rides.map((r) => {
        const mine = r.driver_member === me.id;
        const inside = r.passengers.some((p) => p.member.id === me.id);
        const asked = model.myAsk === r;
        const invited = model.invites.includes(r);
        const canManage = mine || isAdmin;
        const k = KIND[kindOf(r)];
        const meet = kindOf(r) === 'meet';
        return html`<li class=${cx('ride', mine && 'is-mine', inside && 'is-in')} key=${r.id} data-testid="ride" data-kind=${kindOf(r)}>
          <div class="ride__head">
            <${Avatar} member=${r.driver} size=${40} />
            <div class="ride__main">
              <span class="ride__driver">${mine ? (kindOf(r) === 'car' ? 'את/ה נוהג/ת' : `${k.emoji} ${k.mine}`) : kindOf(r) === 'car' ? displayName(r.driver) : `${k.emoji} ${k.of(displayName(r.driver))}`}</span>
              <span class=${cx('ride__seats', !meet && r.free === 0 && 'is-full')}>${meet ? hebrewCount(r.taken, 'מצטרף/ת', 'מצטרפים') : r.free === 0 ? 'מלא' : `${hebrewCount(r.free, 'מקום פנוי', 'מקומות פנויים')}`}</span>
            </div>
            ${canManage
              ? html`<div class="ride__tools">
                  <${IconButton} icon="edit" label=${`עריכת ההסעה של ${displayName(r.driver)}`} onClick=${() => setSheet(r)} />
                  <${IconButton} icon="trash" label=${`ביטול ההסעה של ${displayName(r.driver)}`} onClick=${() => cancel(r)} />
                </div>`
              : null}
          </div>
          <p class="ride__meta">
            ${[r.depart_at && `🕗 ${meet ? 'מפגש' : 'יציאה'} ${formatTime(r.depart_at)}`, r.from_text && `📍 ${r.from_text}`, r.to_text && `← ${r.to_text}`].filter(Boolean).join(' · ') || 'פרטים בקרוב'}
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
                        ${meet ? 'מצטרפים' : model.myAsk ? 'לבקש כאן במקום' : 'מבקשים להצטרף'}${!meet && Math.min(myHeads, r.free) > 1 ? ` (${Math.min(myHeads, r.free)} מקומות)` : ''}
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
      ? html`<div class="rides__offer">${offerModes.map((m) => html`<${Button} key=${m.key} variant=${model.rides.length ? 'ghost' : 'secondary'} icon="plus" block
          onClick=${() => setSheet({ kind: m.key })}>${m.key === 'car' ? m.offer : `${m.emoji} ${m.offer}`}</${Button}>`)}</div>`
      : null}
    <${RideSheet} open=${Boolean(sheet)} ride=${sheet && sheet.id ? sheet : null} kind=${sheet ? kindOf(sheet) : 'car'} trip=${snap.trip} onClose=${() => setSheet(null)} />
  </${Card}>`;
}

const SHEET = {
  car: { title: 'יש לי מקום ברכב 🚗', edit: 'עריכת ההסעה 🚗', seats: 'כמה מקומות פנויים (בלי הנהג/ת)?', max: 8, def: 3,
    from: 'יוצאים מ… (לא חובה)', fromPh: 'למשל: תל אביב, רכבת השלום', time: 'שעת יציאה (לא חובה)', done: 'תודה! הרכב שלך ברשימה 🚗' },
  taxi: { title: 'מונית משותפת 🚕', edit: 'עריכת המונית 🚕', seats: 'כמה מקומות במונית (בלי המארגן/ת)?', max: 7, def: 3,
    from: 'איסוף מ…', fromPh: 'למשל: גבעתיים — ליד הקניון', time: 'שעת איסוף', done: 'המונית ברשימה 🚕 מי שצריך יבקש להצטרף' },
  meet: { title: 'נקודת מפגש 🚆', edit: 'עריכת נקודת המפגש 🚆', seats: 'עד כמה אנשים?', max: 40, def: 20,
    from: 'איפה נפגשים?', fromPh: 'למשל: רכבת ההגנה, רציף 1', time: 'שעת מפגש', done: 'נקודת המפגש ברשימה 🚆' },
};

function RideSheet({ open, ride, kind = 'car', trip, onClose }) {
  const w = SHEET[kind] || SHEET.car;
  const [seats, setSeats] = useState(3);
  const [to, setTo] = useState('');
  const [from, setFrom] = useState('');
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    setSeats(ride ? ride.seats : w.def);
    setTo(ride?.to_text || '');
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
      kind,
      to_text: to.trim() || null,
      ...(ride ? { id: ride.id } : {}),
    };
    setSaving(true);
    const done = await actions.run(ok((api) => api.upsertRide(trip.id, payload)), { success: ride ? 'עודכן ✅' : w.done });
    setSaving(false);
    if (done) onClose();
  };

  return html`<${Sheet} open=${open} onClose=${onClose} title=${ride ? w.edit : w.title}
    footer=${html`<${Button} type="submit" form="ride-form" icon="check" loading=${saving}>${ride ? 'שמירה' : 'הוספה'}</${Button}>
      <${Button} variant="secondary" onClick=${onClose}>ביטול</${Button}>`}>
    <form id="ride-form" class="stack-lg" onSubmit=${save} noValidate>
      <div class="ride-form__seats">
        <span class="field__label">${w.seats}</span>
        <${Stepper} value=${seats} min=${minSeats} max=${w.max} label="מקומות" onChange=${setSeats} />
      </div>
      <${Field} label=${w.from}>
        <${TextInput} value=${from} maxlength="80" placeholder=${w.fromPh} onInput=${(e) => setFrom(e.target.value)} />
      </${Field}>
      ${kind === 'car'
        ? null
        : html`<${Field} label="לאן? (לא חובה)">
            <${TextInput} value=${to} maxlength="80" placeholder="למשל: נתב״ג טרמינל 3" onInput=${(e) => setTo(e.target.value)} />
          </${Field}>`}
      <${Field} label=${w.time}>
        <${TextInput} type="time" value=${time} onInput=${(e) => setTime(e.target.value)} />
      </${Field}>
      <${Field} label="הערה (לא חובה)">
        <${TextInput} value=${note} maxlength="200" placeholder="למשל: יש מקום לצידנית אחת" onInput=${(e) => setNote(e.target.value)} />
      </${Field}>
    </form>
  </${Sheet}>`;
}
