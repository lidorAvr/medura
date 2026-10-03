// Getting there: cars (a driver offers seats), shared taxis (someone organises), meeting points (a train,
// a bus, the airport — join without approval), flights. A passenger ASKS and the organiser answers (or
// the organiser INVITES and the passenger answers) — the side that asked is always told. The admin
// picks which ways a trip offers (settings.arrival). Used on the rides tab, the trip screen and the wizard.
import { html } from 'htm/preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { actions, useTrip } from '../store.js?v=853199b';
import { navigate } from '../router.js?v=853199b';
import { displayName, flightModel, formatDate, formatTime, hebrewCount, ilIso, ilWall, rideModel, tripPhase } from '../lib/logic.js?v=853199b';
import { AIRPORTS, ARRIVAL_MODES, arrivalOf } from '../lib/templates.js?v=853199b';
import { CrewArrival } from '../ui/crew-arrival.js?v=853199b';
import { WithPicker, withIds } from '../ui/arrive-with.js?v=853199b';
import { findFlight, flightCode, flightDest, flightFit, hmOf, isFlightNumber, isYmd, legDate, travelFromFlight } from '../lib/flights.js?v=853199b';
import { hasCoords, navLinks } from '../lib/places.js?v=853199b';
import { FlightLive, LookupNote, nearOf, tripDays, useFlightLookup, wall, whereOf } from './trip-extras.js?v=853199b';
import { PlaceInput } from '../ui/place-input.js?v=853199b';
import { Avatar, Button, Card, Chip, Field, OverBanner, Sheet, Skeleton, Stepper, TextInput, confirmDialog, tripOver } from '../ui/components.js?v=853199b';

const cx = (...a) => a.filter(Boolean).join(' ');
const ok = (fn) => async (api) => {
  await fn(api);
  return true;
};
const kindOf = (r) => r?.kind || 'car';
/** A ride's time — with its day when that isn't the trip's first day ("ה׳ 11:30"), so a stale date shows. */
const rideWhen = (iso, trip) => (trip?.starts_at && ilWall(new Date(iso)).ymd !== ilWall(new Date(trip.starts_at)).ymd
  ? `${formatDate(iso, { weekday: 'short', day: 'numeric', month: 'numeric' })} ${formatTime(iso)}`
  : formatTime(iso));
const model_kinds = (snap) => (snap?.rides || []).map(kindOf);
const modeOf = (m) => m?.prefs?.transport?.mode || null;
/** Ways that need no ride of ours: someone drops me off / train or bus / we park at the airport. */
const SELF_MODES = ['drop', 'transit', 'park'];
/** Ways where we look for a place in someone's car / taxi / meeting point. */
const SEEK_MODES = ['need', 'taxi', 'transit'];
const IATA_RE = /^[A-Z]{3}$/;

/** "נתב״ג (TLV)" */
export function airportName(iata) {
  const a = AIRPORTS.find((x) => x.iata === iata);
  return a ? `${a.label} (${a.iata})` : iata || '';
}
/** My airport: prefs.travel.airport, else the trip's (settings.arrival.airport, default TLV). */
const myAirport = (trip, me) => {
  const own = String(me?.prefs?.travel?.airport || '').toUpperCase();
  return IATA_RE.test(own) ? own : arrivalOf(trip).airport || 'TLV';
};
/** A trip that flies (the rides tab is about getting to the airport). */
const flying = (trip) => arrivalOf(trip).flights || whereOf(trip) === 'abroad';

/** What a status line says for a way of getting there that has no ride attached. */
const MODE_STATUS = {
  need: '🙋 מחפשים מקום',
  own: '🧍 מגיעים בדרך שלנו',
  drop: '🙋 מקפיצים אותי',
  transit: '🚆 ברכבת / באוטובוס',
  park: '🅿️ חונים בשדה',
  taxi: '🚕 מחפשים מונית משותפת',
  car: '🚗 נוסעים ברכב',
};

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
  // after the trip (ux A3): how we got there is history — read only, no "איך אני מגיע/ה?"
  const over = tripOver(snap.trip);
  const m = rideModel(snap, me.id);
  // "איך אני מגיע/ה?" already offers my car / taxi while I haven't said how — one CTA, not two (ux R1)
  const offering = !modeOf(me) && !m.myRide && !m.mySeat && !m.myAsk;
  return html`<div class="screen rides-screen">
    <${OverBanner} trip=${snap.trip} />
    ${over ? null : html`<${MyArrival} snap=${snap} me=${me} onOffer=${(kind) => setSheet({ kind })} />`}
    ${over ? null : html`<${CrewArrival} snap=${snap} me=${me} isAdmin=${isAdmin} tripId=${snap.trip.id} />`}
    ${arrival.flights && !over ? html`<${FlightsCard} snap=${snap} me=${me} />` : null}
    <${RidesCard} snap=${snap} me=${me} isAdmin=${isAdmin} sheet=${sheet} setSheet=${setSheet} readOnly=${over} hideOffer=${offering} />
  </div>`;
}

function MyArrival({ snap, me, onOffer }) {
  const [busy, setBusy] = useState(null);
  const model = rideModel(snap, me.id);
  const { modes } = arrivalOf(snap.trip);
  const fly = flying(snap.trip);
  // ways that offer a ride of mine (a sheet opens), ways that are just a status (one tap)
  const offers = ARRIVAL_MODES.filter((m) => m.offer && m.key !== 'own' && modes.includes(m.key));
  const plain = ARRIVAL_MODES.filter((m) => ['drop', 'transit'].includes(m.key) && modes.includes(m.key));
  const canSeek = modes.some((k) => ['car', 'taxi', 'meet', 'park'].includes(k));
  const mode = modeOf(me);
  const airport = myAirport(snap.trip, me);
  const setMode = async (value) => {
    setBusy(value);
    const t = me.prefs?.transport || {};
    const transport = value ? { ...t, mode: value } : { ...t, mode: null };
    await actions.run(ok((api) => api.updateMember(me.id, { prefs: { transport } })),
      { success: value === 'need' ? 'סימנו שאתם מחפשים מקום 🙋 המארגנים יראו' : 'מעולה, סימנו ✅' });
    setBusy(null);
  };
  const setAirport = async (iata) => {
    if (iata === airport) return;
    setBusy(`ap:${iata}`);
    await actions.run(ok((api) => api.updateMember(me.id, { prefs: { travel: { ...(me.prefs?.travel || {}), airport: iata } } })),
      { success: `ממריאים מ${airportName(iata)} ✈️` });
    setBusy(null);
  };
  let status;
  if (model.myRide) {
    const k = KIND[kindOf(model.myRide)];
    status = `${mode === 'park' ? '🅿️ חונים בשדה' : `${k.emoji} ${k.mine}`}${kindOf(model.myRide) === 'meet' ? ` · ${hebrewCount(model.myRide.taken, 'מצטרף/ת', 'מצטרפים')}`
      : ` · ${model.myRide.free ? hebrewCount(model.myRide.free, 'מקום פנוי', 'מקומות פנויים') : 'מלא'}`}`;
  } else if (model.mySeat) status = `✅ ${KIND[kindOf(model.mySeat)].in(displayName(model.mySeat.driver))}`;
  else if (model.myAsk) status = `⏳ ביקשת מקום אצל ${displayName(model.myAsk.driver)}`;
  else if (mode && MODE_STATUS[mode]) status = MODE_STATUS[mode];
  const seeking = !model.myRide && !model.mySeat && (SEEK_MODES.includes(mode) || model.myAsk);
  const change = () => setMode(null);
  // "who I come with": saved right away; the crew card shows the link to everyone
  const saveWith = async (ids) => {
    const t = me.prefs?.transport || {};
    await actions.run(ok((api) => api.updateMember(me.id, { prefs: { transport: { ...t, with: ids } } })), { success: ids.length ? 'סימנו שאתם מגיעים יחד 🤝' : 'עודכן' });
  };
  const mineWith = (Array.isArray(me.prefs?.transport?.with) ? me.prefs.transport.with : []);
  return html`<${Card} emoji="🧭" title=${fly ? 'איך אני מגיע/ה לשדה?' : 'איך אני מגיע/ה?'} class="my-arrival" data-testid="my-arrival">
    ${status
      ? html`<div class="my-arrival__row"><b class="my-arrival__status" data-testid="my-arrival-status">${status}</b>
          ${model.myRide || model.mySeat || model.myAsk
            ? null
            : html`<${Button} variant="ghost" size="sm" onClick=${change}>שינוי</${Button}>`}</div>`
      : html`<p class="muted small">עוד לא סימנת — לחיצה אחת:</p>
        <div class="my-arrival__opts">
          ${offers.map((m) => html`<${Button} key=${m.key} variant="secondary" size="sm" onClick=${() => onOffer(m.key)}>${m.emoji} ${m.offer}</${Button}>`)}
          ${canSeek
            ? html`<${Button} variant="secondary" size="sm" loading=${busy === 'need'} onClick=${() => setMode('need')}>🙋 מחפש/ת מקום</${Button}>`
            : null}
          ${plain.map((m) => html`<${Button} key=${m.key} variant="secondary" size="sm" loading=${busy === m.key} onClick=${() => setMode(m.key)}>${m.emoji} ${m.label}</${Button}>`)}
          ${modes.includes('park') && !offers.some((m) => m.key === 'park')
            ? html`<${Button} variant="secondary" size="sm" loading=${busy === 'park'} onClick=${() => setMode('park')}>🅿️ חונים בשדה</${Button}>`
            : null}
          ${modes.includes('own')
            ? html`<${Button} variant="secondary" size="sm" loading=${busy === 'own'} onClick=${() => setMode('own')}>🧍 מגיעים לבד</${Button}>`
            : null}
        </div>`}
    ${fly
      ? html`<div class="my-arrival__opts" role="group" aria-label="מאיזה שדה ממריאים?" data-testid="my-airport">
          <span class="small muted">🛫 ממריאים מ:</span>
          ${[...AIRPORTS.map((a) => a.iata), ...(AIRPORTS.some((a) => a.iata === airport) ? [] : [airport])].map((iata) => html`<${Chip} key=${iata}
            active=${iata === airport} data-iata=${iata} onClick=${() => setAirport(iata)} disabled=${busy === `ap:${iata}`}>
            ${AIRPORTS.find((a) => a.iata === iata)?.label || iata} <span dir="ltr">${iata}</span></${Chip}>`)}
        </div>`
      : null}
    ${(status || mode) ? html`<${WithPicker} members=${snap.members} meId=${me.id} value=${mineWith} onChange=${saveWith} />` : null}
    ${seeking ? html`<${RideOffers} snap=${snap} me=${me} />` : null}
  </${Card}>`;
}

/** A meeting point's room isn't a car's: "נקודת מפגש: נשארו 18/30". */
function meetRoom(model) {
  const meets = model.rides.filter((r) => kindOf(r) === 'meet' && Number(r.seats) > 0);
  if (!meets.length) return '';
  const free = meets.reduce((n, r) => n + r.free, 0);
  const all = meets.reduce((n, r) => n + Number(r.seats), 0);
  return `${meets.length === 1 ? 'נקודת מפגש' : `${meets.length} נקודות מפגש`}: נשארו ${free}/${all}`;
}

/** "×2", or "×1 מתוך 2" when only part of a couple / family got in (the rest still need a ride). */
function seatsNote(p) {
  const heads = Math.max(1, Number(p.member?.headcount) || 1);
  if (p.seats < heads) return ` ×${p.seats} מתוך ${heads}`;
  return p.seats > 1 ? ` ×${p.seats}` : '';
}

/** Fewer free seats than we are (a couple, one seat left): say so and ask — never quietly half of us. */
async function roomForAll(ride, heads) {
  if (kindOf(ride) === 'meet' || heads <= ride.free) return true;
  return confirmDialog({
    title: ride.free === 1 ? 'יש מקום רק לאחד/ת 🙈' : `יש רק ${ride.free} מקומות`,
    text: `אתם ${heads}. לבקש ${ride.free === 1 ? 'מקום אחד' : `${ride.free} מקומות`} — ומי שלא נכנס/ת ימשיך לחפש הסעה?`,
    confirmText: ride.free === 1 ? 'לבקש מקום אחד' : `לבקש ${ride.free} מקומות`,
    cancelText: 'לא, נחפש לכולנו',
  });
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
    if (!(await roomForAll(r, myHeads))) { setBusy(null); return; }
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
            <span class="muted small">${[r.from_text && `📍 ${r.from_text}`, r.to_text && `← ${r.to_text}`, r.depart_at && `🕗 ${rideWhen(r.depart_at, snap.trip)}`,
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

/** One leg of my own flight in the edit form: number + date → 🔎 fills the takeoff time. */
function useLegForm(saved, defDate) {
  const [flight, setFlight] = useState(saved?.flight || '');
  const [date, setDate] = useState(legDate(saved) || defDate || '');
  const [time, setTime] = useState(hmOf(saved?.at) || '');
  const [found, setFound] = useState(null); // the looked-up flight (normalized record)
  const now = useRef(null);
  now.current = { flight, date };
  return { flight, setFlight, date, setDate, time, setTime, found, setFound, now };
}

function LegFields({ L, lookup, leg, label, placeholder, trip, days }) {
  // a flight that lands somewhere else, or on another week, is most likely a typo — say so before it's saved
  const warns = flightCode(L.flight) ? flightFit({ flight: L.found, trip, leg, date: L.date, days }) : [];
  const find = async (auto) => {
    const asked = { flight: flightCode(L.flight), date: L.date };
    const f = await lookup.run(asked.flight, asked.date, { auto });
    const cur = L.now.current;
    if (f && flightCode(cur.flight) === asked.flight && cur.date === asked.date) {
      L.setFound(f);
      L.setFlight(asked.flight);
      L.setTime(hmOf(f.dep?.sched) || L.time);
    } else if (!f && !auto) L.setFound(null);
  };
  return html`<div class="stack-sm" data-testid=${`flights-leg-${leg}`}>
    <div class="date-pair">
      <${Field} label=${label}><${TextInput} dir="ltr" value=${L.flight} maxlength="12" placeholder=${placeholder} autocapitalize="characters"
        onInput=${(e) => { L.setFlight(e.target.value); L.setFound(null); }} onBlur=${() => find(true)} /></${Field}>
      <${Field} label="תאריך"><${TextInput} type="date" value=${L.date} onInput=${(e) => { L.setDate(e.target.value); L.setFound(null); }} onBlur=${() => find(true)} /></${Field}>
    </div>
    <div class="row wrap">
      <${Button} size="sm" variant="ghost" loading=${lookup.busy} onClick=${() => find(false)} data-testid=${`flights-lookup-${leg}`}>🔎 מילוי אוטומטי</${Button}>
      <${Field} label="שעת המראה (לא חובה)"><${TextInput} type="time" value=${L.time} onInput=${(e) => L.setTime(e.target.value)} /></${Field}>
    </div>
    <${LookupNote} lookup=${lookup} testid=${`flights-note-${leg}`} />
    ${warns.map((w) => html`<p key=${w.kind} class="small flight-fit" role="status" data-testid=${`flight-fit-${leg}`} style="margin: 0; color: var(--warning-text)">⚠️ ${w.text}</p>`)}
  </div>`;
}

/** prefs.travel.<leg> from the form: {flight, date, at, from, to} (lookup) or {flight, date, at} (typed). */
function legValue(L) {
  const flight = flightCode(L.flight);
  if (!flight) return null;
  const date = isYmd(L.date) ? L.date : null;
  if (L.found && flightCode(L.found.number) === flight && date && String(L.found.dep?.sched || '').startsWith(date)) {
    const t = travelFromFlight(L.found);
    return { ...t, at: L.time && t.at ? `${date}T${L.time}` : t.at };
  }
  return { flight, date, at: date && /^\d{2}:\d{2}$/.test(L.time) ? `${date}T${L.time}` : null };
}

/** Flights: mine (out / back), who's on which flight, and each flight's live status (snapshot.flights). */
function FlightsCard({ snap, me }) {
  const travel = me.prefs?.travel || {};
  const days = tripDays(snap.trip);
  const [editing, setEditing] = useState(false);
  const out = useLegForm(travel.out, days.out);
  const back = useLegForm(travel.back, days.back);
  const outLookup = useFlightLookup(snap.trip.id);
  const backLookup = useFlightLookup(snap.trip.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const outs = flightModel(snap, 'out');
  const backs = flightModel(snap, 'back');
  const open = () => {
    for (const [L, saved, def] of [[out, travel.out, days.out], [back, travel.back, days.back]]) {
      L.setFlight(saved?.flight || '');
      L.setDate(legDate(saved) || def || '');
      L.setTime(hmOf(saved?.at) || '');
      L.setFound(null);
    }
    outLookup.reset();
    backLookup.reset();
    setError('');
    setEditing(true);
  };
  const save = async (e) => {
    e?.preventDefault();
    for (const L of [out, back]) {
      if (flightCode(L.flight) && !isFlightNumber(L.flight)) return setError('מספר טיסה נראה כמו LY315');
    }
    setError('');
    const warns = [[out, 'out'], [back, 'back']].flatMap(([L, leg]) => (flightCode(L.flight)
      ? flightFit({ flight: L.found, trip: snap.trip, leg, date: L.date, days }) : []));
    if (warns.length && !(await confirmDialog({
      title: 'הטיסה לא מתאימה לטיול?', text: `${warns.map((w) => w.text).join(' · ')}.`,
      confirmText: 'לשמור בכל זאת', cancelText: 'לתקן',
    }))) return undefined;
    setBusy(true);
    const next = { ...travel, out: legValue(out), back: legValue(back) };
    const done = await actions.run(ok((api) => api.updateMember(me.id, { prefs: { travel: next } })),
      { success: 'הטיסות נשמרו ✈️' });
    setBusy(false);
    if (done) setEditing(false);
    return undefined;
  };
  const when = (at) => wall(at);
  const bookings = Array.isArray(snap.trip.info?.bookings) ? snap.trip.info.bookings : [];
  const liveOf = (g, leg) => {
    const withDate = g.members.map((x) => x.prefs?.travel?.[leg]).find((t) => t && flightCode(t.flight) === g.flight && legDate(t));
    const row = withDate ? findFlight(snap, withDate) : null;
    return row ? html`<${FlightLive} row=${row} />` : null;
  };
  // where a flight goes ("← London (LHR)") — from its live record, else what was saved with it
  const dest = (text) => (text ? html` <span class="flights__dest small" data-testid="flight-dest">← <bdi>${text}</bdi></span>` : null);
  const destOf = (g, leg) => {
    const legs = g.members.map((x) => x.prefs?.travel?.[leg]).filter((t) => t && flightCode(t.flight) === g.flight);
    const dated = legs.find((t) => legDate(t));
    return flightDest(dated ? findFlight(snap, dated)?.data : null) || flightDest(legs.find((t) => t.to) || null);
  };
  const group = (m, title, leg) => {
    const gf = bookings.find((b) => b.kind === 'flight' && (b.leg || 'out') === leg && b.flight);
    if (gf) {
      // the group's flight: everyone is on it unless they listed another one
      const others = m.flights.filter((g) => g.flight !== gf.flight);
      const away = new Set(others.flatMap((g) => g.members.map((x) => x.id)));
      const notOn = snap.members.filter((x) => away.has(x.id));
      const live = findFlight(snap, gf);
      return html`<div class="flights__leg">
        <p class="flights__title">${title}</p>
        <ul class="flights__list">
          <li class="flights__row is-group" data-testid="flight-row" data-flight=${gf.flight}><b dir="ltr">${gf.flight}</b>${dest(flightDest(live?.data) || flightDest(gf))} <span class="muted small">${when(gf.at)}</span>
            ${live ? html`<${FlightLive} row=${live} />` : null}
            <span class="flights__who small">${notOn.length ? `כולם חוץ מ: ${notOn.map(displayName).join(' · ')}` : 'כולם 👥'}</span></li>
          ${others.map((g) => html`<li key=${g.flight} class="flights__row" data-testid="flight-row" data-flight=${g.flight}><b dir="ltr">${g.flight}</b>${dest(destOf(g, leg))} ${g.at ? html`<span class="muted small">${when(g.at)}</span>` : null}
            ${liveOf(g, leg)}
            <span class="flights__who small">${g.members.map(displayName).join(' · ')}</span></li>`)}
        </ul>
      </div>`;
    }
    return html`<div class="flights__leg">
    <p class="flights__title">${title}</p>
    ${m.flights.length
      ? html`<ul class="flights__list">${m.flights.map((g) => html`<li key=${g.flight} class="flights__row" data-testid="flight-row" data-flight=${g.flight}>
          <b dir="ltr">${g.flight}</b>${dest(destOf(g, leg))} ${g.at ? html`<span class="muted small">${when(g.at)}</span>` : null}
          ${liveOf(g, leg)}
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
          <${LegFields} L=${out} lookup=${outLookup} leg="out" label="טיסה הלוך" placeholder="LY315" trip=${snap.trip} days=${days} />
          <${LegFields} L=${back} lookup=${backLookup} leg="back" label="טיסה חזור" placeholder="LY316" trip=${snap.trip} days=${days} />
          ${error ? html`<p class="field__error" role="alert">${error}</p>` : null}
          <div class="row wrap">
            <${Button} type="submit" size="sm" loading=${busy}>שמירה</${Button}>
            <${Button} variant="ghost" size="sm" onClick=${() => setEditing(false)}>ביטול</${Button}>
          </div>
        </form>`
      : html`<div class="my-arrival__row">
          <span>${mine ? html`הטיסות שלך: <b dir="ltr">${[travel.out?.flight, travel.back?.flight].filter(Boolean).join(' / ')}</b>` : groupFlights ? 'את/ה על טיסת הקבוצה' : 'עוד לא סימנת טיסה'}</span>
          <${Button} variant=${mine || groupFlights ? 'ghost' : 'secondary'} size="sm" onClick=${open}>${mine ? 'עריכה' : groupFlights ? 'טס/ה בטיסה אחרת?' : '✈️ הטיסה שלי'}</${Button}>
        </div>`}
    ${group(outs, '🛫 הלוך', 'out')}
    ${group(backs, '🛬 חזור', 'back')}
    ${!groupFlights && outs.missing.length && outs.flights.length
      ? html`<p class="muted small">עוד לא סימנו: ${outs.missing.map(displayName).join(' · ')}</p>`
      : null}
  </${Card}>`;
}

export function RidesCard({ snap, me, isAdmin, compact = false, sheet: outerSheet, setSheet: outerSet, readOnly = false, hideOffer = false }) {
  const [ownSheet, setOwnSheet] = useState(null); // null | {kind} (new) | ride
  const sheet = outerSet ? outerSheet : ownSheet;
  const setSheet = outerSet || setOwnSheet;
  const { modes } = arrivalOf(snap.trip);
  const offerModes = ARRIVAL_MODES.filter((m) => m.offer && m.key !== 'own' && modes.includes(m.key));
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
  const ask = async (ride) => {
    if (!(await roomForAll(ride, myHeads))) return;
    await act(ride.id, (api) => api.takeSeat(ride.id, Math.min(myHeads, ride.free)),
      kindOf(ride) === 'meet' ? 'הצטרפת לנקודת המפגש ✅' : `הבקשה נשלחה ל${displayName(ride.driver)} ⏳ נעדכן כשיענה/תענה`);
  };
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

  // looking for a place: 'need', plus people who'd share a taxi to the airport
  const seekers = [...model.seeking, ...model.without.filter((m) => modeOf(m) === 'taxi')
    .map((m) => ({ member: m, from: m.prefs?.transport?.from || null }))];
  // "not known yet" leaves out people who said how (dropped off / train / parking)
  const unknown = model.without.filter((m) => !SELF_MODES.includes(modeOf(m)) && !seekers.some((x) => x.member.id === m.id));
  const rides = compact ? model.rides.filter((r) => r === model.myRide || r === model.mySeat) : model.rides;
  if (compact && !rides.length) return null;
  const canInvite = model.myRide && model.myRide.free > 0;

  return html`<${Card} emoji="🚗" title=${compact ? 'ההסעה שלך' : carsOnly ? 'הסעות וטרמפים' : 'כל האפשרויות להגיע'} class=${cx('rides', compact && 'rides--compact')}>
    ${!compact
      ? html`<p class="rides__sum muted small" data-testid="rides-summary">
          ${model.rides.length
            ? `${carsOnly ? hebrewCount(model.rides.length, 'רכב', 'רכבים') : hebrewCount(model.rides.length, 'אפשרות', 'אפשרויות')} · ${hebrewCount(model.freeSeats, 'מקום פנוי', 'מקומות פנויים')}${meetRoom(model) ? ` · ${meetRoom(model)}` : ''}`
            : carsOnly ? 'עוד אין רכבים — מי נוהג/ת?' : 'עוד אין הצעות — מי מארגן/ת?'}
        </p>`
      : null}

    <ul class="rides__list">
      ${rides.map((r) => {
        const mine = r.driver_member === me.id;
        const inside = r.passengers.some((p) => p.member.id === me.id);
        const asked = model.myAsk === r;
        const invited = model.invites.includes(r);
        const canManage = (mine || isAdmin) && !readOnly;
        const over = ['after', 'past'].includes(tripPhase(snap.trip));   // unanswered asks are history then
        const k = KIND[kindOf(r)];
        const meet = kindOf(r) === 'meet';
        return html`<li class=${cx('ride', mine && 'is-mine', inside && 'is-in')} key=${r.id} data-testid="ride" data-kind=${kindOf(r)}>
          <div class="ride__head">
            <${Avatar} member=${r.driver} size=${40} />
            <div class="ride__main">
              <span class="ride__driver">${mine ? (kindOf(r) === 'car' ? 'את/ה נוהג/ת' : `${k.emoji} ${k.mine}`) : kindOf(r) === 'car' ? displayName(r.driver) : `${k.emoji} ${k.of(displayName(r.driver))}`}</span>
              <span class=${cx('ride__seats', !meet && r.free === 0 && 'is-full')}>${meet ? `${hebrewCount(r.taken, 'מצטרף/ת', 'מצטרפים')}${Number(r.seats) > 0 ? ` · נשארו ${r.free}/${r.seats}` : ''}` : r.free === 0 ? 'מלא' : `${hebrewCount(r.free, 'מקום פנוי', 'מקומות פנויים')}`}</span>
            </div>
            ${canManage
              ? html`<div class="ride__tools">
                  <button type="button" class="link ride__tool" aria-label=${`עריכת ההסעה של ${displayName(r.driver)}`} onClick=${() => setSheet(r)}>עריכה</button>
                  <span aria-hidden="true">·</span>
                  <button type="button" class="link ride__tool ride__tool--danger" aria-label=${`ביטול ההסעה של ${displayName(r.driver)}`} onClick=${() => cancel(r)}>ביטול ההסעה</button>
                </div>`
              : null}
          </div>
          <p class="ride__meta">
            ${[r.depart_at && `🕗 ${meet ? 'מפגש' : 'יציאה'} ${rideWhen(r.depart_at, snap.trip)}`, r.from_text && `📍 ${r.from_text}`, r.to_text && `← ${r.to_text}`].filter(Boolean).join(' · ') || 'פרטים בקרוב'}
            ${hasCoords({ lat: r.from_lat, lon: r.from_lon })
              ? html` <a class="ride__nav small" href=${navLinks({ lat: r.from_lat, lon: r.from_lon }).waze} target="_blank" rel="noopener noreferrer"
                  data-testid="ride-nav">🚙 ניווט ${meet ? 'למפגש' : 'לאיסוף'}</a>`
              : null}
          </p>
          ${r.passengers.length
            ? html`<div class="ride__pass">
                ${r.passengers.map((p) => html`<span class="ride__chip" key=${p.member.id}>
                  <${Avatar} member=${p.member} size=${22} /> ${displayName(p.member)}${seatsNote(p)}
                </span>`)}
              </div>`
            : null}
          ${r.note ? html`<p class="ride__note">📝 ${r.note}</p>` : null}

          ${canManage && r.pending.length && !over
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

          ${readOnly
            ? null
            : invited
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

    ${!compact && seekers.length
      ? html`<div class="rides__seeking small" data-testid="rides-seeking"><b>🙋 ${carsOnly ? 'מחפשים טרמפ' : 'מחפשים מקום'}:</b>
          <ul class="rides__seekers">
            ${seekers.map((x) => {
              const invitedAlready = model.myRide?.pending.some((p) => p.member.id === x.member.id);
              return html`<li key=${x.member.id}>
                ${displayName(x.member)}${x.from ? ` (מ${x.from})` : ''}
                ${canInvite && !invitedAlready && !readOnly
                  ? html` <${Button} size="sm" variant="ghost" loading=${busy === `inv:${x.member.id}`}
                      onClick=${() => invite(model.myRide, x.member)}>הזמנה לרכב שלי</${Button}>`
                  : invitedAlready ? html` <span class="muted">· הוזמנו ⏳</span>` : null}
              </li>`;
            })}
          </ul>
        </div>`
      : null}
    ${!compact && model.rides.length && unknown.length
      ? html`<p class="rides__without small"><b>עוד לא ידוע איך מגיעים:</b>
          ${unknown.map(displayName).join(' · ')}</p>`
      : null}
    ${!compact && !model.myRide && !readOnly && !hideOffer
      ? html`<div class="rides__offer">${offerModes.map((m) => html`<${Button} key=${m.key} variant=${model.rides.length ? 'ghost' : 'secondary'} icon="plus" block
          onClick=${() => setSheet({ kind: m.key })}>${m.key === 'car' ? m.offer : `${m.emoji} ${m.offer}`}</${Button}>`)}</div>`
      : null}
    <${RideSheet} open=${Boolean(sheet)} ride=${sheet && sheet.id ? sheet : null} kind=${sheet ? sheetKind(sheet) : 'car'}
      park=${Boolean(sheet && !sheet.id && sheet.kind === 'park')} trip=${snap.trip} me=${me} onClose=${() => setSheet(null)} />
  </${Card}>`;
}

/** {kind: 'park'} (a new "we park at the airport" offer) is a car ride to the airport. */
const sheetKind = (sheet) => (sheet?.kind === 'park' ? 'car' : kindOf(sheet));

const SHEET = {
  car: { title: 'יש לי מקום ברכב 🚗', edit: 'עריכת ההסעה 🚗', seats: 'כמה מקומות פנויים (בלי הנהג/ת)?', max: 8, def: 3,
    from: 'יוצאים מ… (לא חובה)', fromPh: 'למשל: תל אביב, רכבת השלום', time: 'שעת יציאה (לא חובה)', done: 'תודה! הרכב שלך ברשימה 🚗' },
  taxi: { title: 'מונית משותפת 🚕', edit: 'עריכת המונית 🚕', seats: 'כמה מקומות במונית (בלי המארגן/ת)?', max: 7, def: 3,
    from: 'איסוף מ…', fromPh: 'למשל: גבעתיים — ליד הקניון', time: 'שעת איסוף', done: 'המונית ברשימה 🚕 מי שצריך יבקש להצטרף' },
  meet: { title: 'נקודת מפגש 🚆', edit: 'עריכת נקודת המפגש 🚆', seats: 'עד כמה אנשים?', max: 40, def: 20,
    from: 'איפה נפגשים?', fromPh: 'למשל: רכבת ההגנה, רציף 1', time: 'שעת מפגש', done: 'נקודת המפגש ברשימה 🚆' },
};
const PARK = { title: 'חונים בשדה — יש מקום 🅿️', done: 'הרכב לשדה ברשימה 🅿️' };

/** How many seats a new offer starts with: what's left next to my own profile — a family of four in a car has one
 *  seat to give, not three (testers 2026-10-02). At least 1, at most the kind's usual; a meeting point is its own. */
export function seatsFor(kind, me) {
  const w = SHEET[kind] || SHEET.car;
  if (kind === 'meet') return w.def;
  const mine = Math.max(1, Number(me?.headcount) || 1);
  return Math.max(1, Math.min(w.def, (kind === 'taxi' ? 4 : 5) - mine));
}

/** A place the sheet holds: the picked OSM place (with coords) or null, plus the text in the field. */
function usePlace() {
  const [place, setPlace] = useState(null);
  const [text, setText] = useState('');
  const load = (t, lat, lon) => {
    setText(t || '');
    setPlace(t && lat != null && lon != null ? { name: t, address: '', lat: Number(lat), lon: Number(lon) } : null);
  };
  const coords = () => (place && text.trim() === place.name ? { lat: place.lat, lon: place.lon } : { lat: null, lon: null });
  return { place, text, load, coords, onChange: (p, t) => { setPlace(p); setText(t); } };
}

function RideSheet({ open, ride, kind = 'car', park = false, trip, me, onClose }) {
  const w = SHEET[kind] || SHEET.car;
  const fly = flying(trip);
  const where = whereOf(trip);
  const [seats, setSeats] = useState(3);
  const from = usePlace();
  const to = usePlace();
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    setSeats(ride ? ride.seats : seatsFor(kind, me));
    from.load(ride?.from_text || (!ride ? me?.prefs?.transport?.from : '') || '', ride ? ride.from_lat : me?.prefs?.transport?.from_lat,
      ride ? ride.from_lon : me?.prefs?.transport?.from_lon);
    to.load(ride ? ride.to_text || '' : fly && kind !== 'meet' ? airportName(myAirport(trip, me)) : '', ride?.to_lat, ride?.to_lon);
    setTime(ride?.depart_at ? ilWall(new Date(ride.depart_at)).hm : '');
    setNote(ride?.note || '');
    setSaving(false);
  }, [open, ride?.id]);

  // the day the ride leaves: my out flight's day on a flying trip, else the trip's first day
  const rideDay = () => {
    const mine = legDate(me?.prefs?.travel?.out);
    const group = (Array.isArray(trip.info?.bookings) ? trip.info.bookings : []).find((b) => b.kind === 'flight' && (b.leg || 'out') === 'out');
    const flightDay = fly ? mine || legDate(group) : null;
    return flightDay || (trip.starts_at ? ilWall(new Date(trip.starts_at)).ymd : ilWall(new Date()).ymd);
  };
  const minSeats = ride ? Math.max(1, ride.taken) : 1;
  const save = async (e) => {
    e?.preventDefault();
    const f = from.coords();
    const t = to.coords();
    const payload = {
      seats,
      from_text: from.text.trim() || null,
      from_lat: f.lat, from_lon: f.lon,
      depart_at: time ? ilIso(ride?.depart_at ? ilWall(new Date(ride.depart_at)).ymd : rideDay(), time) : null,
      note: note.trim() || null,
      kind,
      to_text: to.text.trim() || null,
      to_lat: t.lat, to_lon: t.lon,
      ...(ride ? { id: ride.id } : {}),
    };
    setSaving(true);
    const done = await actions.run(async (api) => {
      await api.upsertRide(trip.id, payload);
      if (park && me) {
        const tr = me.prefs?.transport || {};
        await api.updateMember(me.id, { prefs: { transport: { ...tr, mode: 'park', from: payload.from_text, from_lat: f.lat, from_lon: f.lon } } });
      }
      return true;
    }, { success: ride ? 'עודכן ✅' : park ? PARK.done : w.done });
    setSaving(false);
    if (done) onClose();
  };

  const showTo = kind !== 'car' || fly || Boolean(ride?.to_text);
  return html`<${Sheet} open=${open} onClose=${onClose} title=${ride ? w.edit : park ? PARK.title : w.title}
    footer=${html`<${Button} type="submit" form="ride-form" icon="check" loading=${saving}>${ride ? 'שמירה' : 'הוספה'}</${Button}>
      <${Button} variant="secondary" onClick=${onClose}>ביטול</${Button}>`}>
    <form id="ride-form" class="stack-lg" onSubmit=${save} noValidate>
      <div class="ride-form__seats">
        <span class="field__label">${w.seats}</span>
        <${Stepper} value=${seats} min=${minSeats} max=${w.max} label="מקומות" onChange=${setSeats} />
      </div>
      <${PlaceInput} label=${w.from} value=${from.place} text=${from.text} onChange=${from.onChange} where="il" near=${where === 'il' ? nearOf(trip) : null}
        placeholder=${w.fromPh} testid="ride-from" nav=${false} />
      ${showTo
        ? html`<${PlaceInput} label="לאן? (לא חובה)" value=${to.place} text=${to.text} onChange=${to.onChange} where="il" near=${where === 'il' ? nearOf(trip) : null}
            placeholder=${fly ? 'למשל: נתב״ג טרמינל 3' : 'למשל: החניון בכניסה'} testid="ride-to" nav=${false} />`
        : null}
      <${Field} label=${w.time}>
        <${TextInput} type="time" value=${time} onInput=${(e) => setTime(e.target.value)} />
      </${Field}>
      <${Field} label="הערה (לא חובה)">
        <${TextInput} value=${note} maxlength="200" placeholder="למשל: יש מקום לצידנית אחת" onInput=${(e) => setNote(e.target.value)} />
      </${Field}>
    </form>
  </${Sheet}>`;
}
