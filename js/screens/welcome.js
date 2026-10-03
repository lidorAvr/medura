// Welcome wizard — right after joining (and once for anyone who hasn't done it). The steps fit the trip
// (templates.welcomeSteps): contact details · how you get there (a car trip in Israel, or "how do you get to the
// airport?" for a trip abroad — templates.arrivalQuestion) · which flight (with a 🔎 lookup) · food & home.
// Every step can be skipped; finishing (or skipping to the end) sets prefs.onboarded. ux E8: the first time through,
// a one-person profile whose phone and e-mail are already known skips "contact"; "arrive" only says where seats are
// (asking for one happens on the rides tab); the footer's action stays in reach.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { actions, store, useStore, useTrip } from '../store.js?v=8d87c37';
import { href, navigate } from '../router.js?v=8d87c37';
import { displayName, ilIso, ilWall, rideModel, whatsappChatUrl } from '../lib/logic.js?v=8d87c37';
import { Avatar, Button, Chip, Field, Skeleton, Stepper, TextInput, confirmDialog } from '../ui/components.js?v=8d87c37';
import { flightFit } from '../lib/flights.js?v=8d87c37';
import { PlaceInput } from '../ui/place-input.js?v=8d87c37';
import { DIET_CHIPS, INVENTORY_SUGGESTIONS } from './me.js?v=8d87c37';
import { seatsFor } from './rides.js?v=8d87c37';
import { WithPicker } from '../ui/arrive-with.js?v=8d87c37';
import { AIRPORTS, arrivalQuestion, tripType, welcomeSteps } from '../lib/templates.js?v=8d87c37';

const cx = (...a) => a.filter(Boolean).join(' ');
const MAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s.]{2,}$/;
const IATA_RE = /^[A-Z]{3}$/;
const FLIGHT_RE = /^[A-Z0-9]{2}[0-9]{1,4}[A-Z]?$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^\d{2}:\d{2}$/;
const STEP_META = {
  contact: { emoji: '📬', title: 'איך יוצרים איתכם קשר?' },
  arrive: { emoji: '🚗', title: 'איך מגיעים?' },           // replaced by arrivalQuestion(trip)
  fly: { emoji: '🛫', title: 'באיזו טיסה?' },
  food: { emoji: '🍽️', title: 'ועוד קצת עליכם' },
};
const STEP_ALIAS = { more: 'food' };                         // old links (?step=more)

/** "ly 315" → "LY315" */
const flightCode = (v) => String(v || '').toUpperCase().replace(/[\s\-–.]/g, '');
/** 'YYYY-MM-DDTHH:MM…' → 'HH:MM' */
const hmOf = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : '');
const airportName = (iata) => {
  const a = AIRPORTS.find((x) => x.iata === iata);
  return a ? `${a.label} (${a.iata})` : iata;
};
/** "El Al · TLV T3 10:10 → LHR T4 13:35" */
export function flightLine(f) {
  if (!f) return '';
  const side = (s, withTime) => [s?.iata, s?.terminal ? `T${s.terminal}` : null, withTime ? hmOf(s?.sched) : null].filter(Boolean).join(' ');
  return [f.airline?.name, `${side(f.dep, true)} → ${side(f.arr, true)}`].filter(Boolean).join(' · ');
}

export default function WelcomeScreen({ route }) {
  const { snap, me } = useTrip();
  const tripId = route?.params?.tripId;
  if (!snap || !me || snap.trip.id !== tripId) {
    return html`<div class="screen welcome" aria-busy="true"><${Skeleton} lines=${3} /><${Skeleton} lines=${5} /></div>`;
  }
  return html`<${Wizard} key=${me.id} snap=${snap} me=${me} start=${route.query?.step} />`;
}

/** One flight leg of my own: number + date → 🔎 lookup (or a manual time when the lookup can't help). */
function useLeg(saved, defaultDate) {
  const [flight, setFlight] = useState(saved?.flight || '');
  const [date, setDate] = useState(saved?.date || (saved?.at ? String(saved.at).slice(0, 10) : '') || defaultDate || '');
  const [time, setTime] = useState(hmOf(saved?.at));
  const [found, setFound] = useState(saved?.flight && saved?.from && saved?.to
    ? { number: saved.flight, from: saved.from, to: saved.to, at: saved.at || null, line: null } : null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return { flight, setFlight, date, setDate, time, setTime, found, setFound, error, setError, busy, setBusy };
}

/** The footer stays at the bottom of the screen while a long step scrolls (inline: no css file of its own). */
const STICKY_FOOT = 'position:sticky;bottom:0;z-index:2;padding:10px 0 calc(10px + env(safe-area-inset-bottom, 0px));'
  + 'background:linear-gradient(to bottom, transparent, var(--bg) 14px)';

function Wizard({ snap, me, start }) {
  const trip = snap.trip;
  const verified = useStore((s) => (s.contact?.verified ? s.contact.email : null));
  // first time through, one person, phone + e-mail already known: nothing to ask on "contact" (kept for the session)
  const [skipContact] = useState(() => !start && !me.prefs?.onboarded && !!me.phone
    && (me.people || []).length <= 1 && Boolean(me.prefs?.has_email || verified));
  const steps = welcomeSteps(trip).filter((key) => !(skipContact && key === 'contact')).map((key) => ({ key, ...STEP_META[key] }));
  const aq = arrivalQuestion(trip);
  const abroad = Boolean(aq.airports);
  const askHome = tripType(trip).ask?.home !== false;
  const startKey = STEP_ALIAS[start] || start;
  const first = Math.max(0, steps.findIndex((x) => x.key === startKey));
  const [step, setStep] = useState(first);
  const [busy, setBusy] = useState(false);
  const people = (me.people && me.people.length ? me.people : [displayName(me)]);
  const prefs = me.prefs || {};
  const rides = rideModel(snap, me.id);
  // what we last saved of prefs.travel (prefs merge shallowly — never drop the other half)
  const travelRef = useRef({ ...(prefs.travel || {}) });

  // ---- contact ----
  const [phone, setPhone] = useState(me.phone || '');
  // "הפרופיל שלי" already has a phone? use it (only while the field is still empty)
  useEffect(() => {
    if (me.phone) return undefined;
    let alive = true;
    store.get().api.myAccount?.().then((acc) => {
      if (alive && acc?.phone) setPhone((typed) => typed || acc.phone.replace(/[^0-9+() -]/g, ''));
    }).catch(() => {});
    return () => { alive = false; };
  }, [me.id]);
  // the e-mail verified at the door fills the first person's field
  const [emails, setEmails] = useState(() => people.map((_, i) => (i === 0 && verified) || ''));
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    actions.run((api) => api.getMemberEmails(me.id), { refresh: false, error: () => 'לא הצלחנו לטעון את המיילים' })
      .then((list) => {
        if (!alive) return;
        // fill only fields that are still empty — never overwrite what's being typed
        if (list?.length) setEmails((typed) => people.map((_, i) => typed[i] || list[i] || ''));
        setLoaded(true);
      });
    return () => { alive = false; };
  }, [me.id]);

  // ---- arrive ----
  const t = prefs.transport || {};
  const myRide = rides.myRide;
  const [mode, setMode] = useState(myRide
    ? (['park', 'taxi'].includes(t.mode) && abroad ? t.mode : 'car')
    : t.mode || (rides.mySeat ? 'seat' : ''));
  const savedFrom = myRide?.from_text || t.from || '';
  const savedLat = myRide?.from_lat ?? t.from_lat;
  const savedLon = myRide?.from_lon ?? t.from_lon;
  const [fromText, setFromText] = useState(savedFrom);
  const [fromPlace, setFromPlace] = useState(savedFrom && savedLat != null && savedLon != null
    ? { name: savedFrom, address: '', lat: Number(savedLat), lon: Number(savedLon) } : null);
  const ownSeats = Math.min(2, seatsFor('car', me));         // what's left next to my own profile, 2 at most
  const [seats, setSeats] = useState(myRide?.seats ?? (mode === 'park' ? 0 : ownSeats));
  const [organise, setOrganise] = useState(Boolean(myRide && myRide.kind === 'taxi'));
  const [together, setTogether] = useState(() => (Array.isArray(t.with) ? t.with : []));   // who I arrive with (optional)
  const [depart, setDepart] = useState(myRide?.depart_at ? ilWall(new Date(myRide.depart_at)).hm : '');
  const [late, setLate] = useState(Boolean(prefs.arrival));
  const [arrival, setArrival] = useState(prefs.arrival || '');
  const [airport, setAirport] = useState(() => {
    const own = String(prefs.travel?.airport || '').toUpperCase();
    return IATA_RE.test(own) ? own : aq.airport || 'TLV';
  });
  const [otherAirport, setOtherAirport] = useState(() => !AIRPORTS.some((a) => a.iata === airport));

  // ---- fly ----
  const bookings = Array.isArray(trip.info?.bookings) ? trip.info.bookings : [];
  const groupFlight = bookings.find((b) => b.kind === 'flight' && (b.leg || 'out') === 'out' && b.flight) || null;
  const [ownFlight, setOwnFlight] = useState(Boolean(prefs.travel?.out?.flight && prefs.travel.out.flight !== groupFlight?.flight));
  const startYmd = trip.starts_at ? ilWall(new Date(trip.starts_at)).ymd : '';
  const endYmd = trip.ends_at ? ilWall(new Date(trip.ends_at)).ymd : '';
  const out = useLeg(prefs.travel?.out, startYmd);
  const back = useLeg(prefs.travel?.back, endYmd);

  // ---- food & home ----
  const [diet, setDiet] = useState(() => new Set(String(prefs.diet || '').split(' · ').filter((x) => DIET_CHIPS.includes(x))));
  const [dietNote, setDietNote] = useState(() => String(prefs.diet || '').split(' · ').filter((x) => x && !DIET_CHIPS.includes(x)).join(' · '));
  const [inv, setInv] = useState(me.inventory || []);

  const [errors, setErrors] = useState({});
  const s0 = steps[Math.min(step, steps.length - 1)];
  const s = s0.key === 'arrive' ? { ...s0, emoji: aq.emoji, title: aq.title } : s0;
  const startHm = trip.starts_at ? ilWall(new Date(trip.starts_at)).hm : null;
  const tripDay = startYmd || ilWall(new Date()).ymd;

  const run = (fn) => actions.run(async (api) => { await fn(api); return true; }, { refresh: false });
  const saveTravel = async (patch) => {
    const travel = { ...travelRef.current, ...patch };
    const ok = await run((api) => api.updateMember(me.id, { prefs: { travel } }));
    if (ok) travelRef.current = travel;
    return ok;
  };

  const saveContact = async () => {
    const errs = {};
    if (phone.trim() && !whatsappChatUrl(phone.trim())) errs.phone = 'המספר לא נראה תקין — למשל 050-1234567';
    emails.forEach((m, i) => { if (m.trim() && !MAIL_RE.test(m.trim())) errs[`email${i}`] = 'המייל לא נראה תקין'; });
    setErrors(errs);
    if (Object.keys(errs).length) return false;
    const list = emails.map((m) => m.trim().toLowerCase()).filter(Boolean);
    // Before the current list has loaded, an empty form must not wipe it — anything typed is saved.
    const skipEmails = !loaded && !list.length;
    const flag = skipEmails ? {} : { prefs: { has_email: list.length > 0 } };
    return (await run((api) => api.updateMember(me.id, { phone: phone.trim() || null, ...flag })))
      && (skipEmails || await run((api) => api.setMemberEmails(me.id, list)));
  };

  // which modes ask "יוצאים מ…" / drive a ride of mine
  const asksFrom = aq.askFrom.includes(mode);
  const rideKind = mode === 'car' || (mode === 'park' && seats > 0) ? 'car' : mode === 'taxi' && organise ? 'taxi' : null;
  const fromNow = fromText.trim();

  const saveArrive = async () => {
    const errs = {};
    if (rideKind && !fromNow) errs.from = 'מאיפה יוצאים? (עיר / שכונה)';
    if (aq.askLate && late && !arrival) errs.arrival = 'באיזו שעה בערך?';
    if (abroad && !IATA_RE.test(airport)) errs.airport = 'קוד שדה של 3 אותיות — למשל TLV';
    setErrors(errs);
    if (Object.keys(errs).length) return false;
    const coords = fromPlace && fromNow === fromPlace.name ? { from_lat: fromPlace.lat, from_lon: fromPlace.lon } : {};
    const transport0 = !mode ? null
      : mode === 'car' ? { mode: 'car' }
        : asksFrom ? { mode, from: fromNow || null, ...coords }
          : { mode };
    const transport = transport0 && together.length ? { ...transport0, with: together } : transport0;
    let ok = await run((api) => api.updateMember(me.id, { prefs: { transport, arrival: aq.askLate && late ? arrival : null } }));
    if (ok && abroad) ok = await saveTravel({ airport });
    if (ok && rideKind) {
      ok = await run((api) => api.upsertRide(trip.id, {
        ...(myRide ? { id: myRide.id } : {}),
        kind: rideKind, seats: Math.max(1, seats), from_text: fromNow,
        from_lat: coords.from_lat ?? null, from_lon: coords.from_lon ?? null,
        depart_at: depart ? ilIso(tripDay, depart) : null,
        ...(abroad ? { to_text: airportName(airport) } : {}),
      }));
    } else if (ok && myRide && !myRide.taken) {
      ok = await run((api) => api.deleteRide(myRide.id));
    }
    return ok;
  };

  const legOf = (L) => {
    const flight = flightCode(L.flight);
    if (!flight) return null;
    const date = YMD_RE.test(L.date) ? L.date : null;
    if (L.found && L.found.number === flight && (!date || String(L.found.at || '').startsWith(date))) {
      return { flight, date, at: L.found.at, from: L.found.from, to: L.found.to };
    }
    return { flight, date, at: date && HM_RE.test(L.time) ? `${date}T${L.time}` : null };
  };

  // a flight that lands far from the trip, or on another week: most likely a typo — warn, and ask before saving
  const flyDays = {
    out: trip.starts_at ? ilWall(new Date(trip.starts_at)).ymd : null,
    back: trip.ends_at ? ilWall(new Date(trip.ends_at)).ymd : null,
  };
  const fitWarns = (L, key) => (flightCode(L.flight)
    ? flightFit({ flight: L.found?.number === flightCode(L.flight) ? L.found.full || null : null, trip, leg: key, date: L.date, days: flyDays })
    : []);

  const saveFly = async () => {
    const errs = {};
    const onGroup = groupFlight && !ownFlight;
    if (!onGroup) {
      for (const [k, L] of [['out', out], ['back', back]]) {
        const code = flightCode(L.flight);
        if (code && !FLIGHT_RE.test(code)) errs[k] = 'מספר טיסה נראה כמו LY315';
      }
    }
    setErrors(errs);
    if (Object.keys(errs).length) return false;
    const warns = onGroup ? [] : [['out', out], ['back', back]].flatMap(([k, L]) => fitWarns(L, k));
    if (warns.length && !(await confirmDialog({
      title: 'הטיסה לא מתאימה לטיול?', text: `${warns.map((w) => w.text).join(' · ')}.`,
      confirmText: 'לשמור בכל זאת', cancelText: 'לתקן',
    }))) return false;
    return saveTravel(onGroup ? { out: null, back: null } : { out: legOf(out), back: legOf(back) });
  };

  const saveFood = async () => {
    const text = [...diet, dietNote.trim()].filter(Boolean).join(' · ').slice(0, 300);
    return run((api) => api.updateMember(me.id, { prefs: { diet: text }, inventory: inv }));
  };

  const finish = async () => {
    await run((api) => api.updateMember(me.id, { prefs: { onboarded: true } }));
    await actions.refresh();
    actions.toast('הכול מוכן! 🔥 נתראה סביב המדורה', 'success', 3200);
    navigate(`/t/${trip.id}`, { replace: true });
  };

  const next = async (save = true) => {
    setBusy(true);
    const savers = { contact: saveContact, arrive: saveArrive, fly: saveFly, food: saveFood };
    const ok = save ? await savers[s.key]() : true;
    setBusy(false);
    if (!ok) return;
    setErrors({});
    if (step < steps.length - 1) {
      setStep(step + 1);
      window.scrollTo(0, 0);
    } else {
      setBusy(true);
      await finish();
    }
  };

  const lookup = async (L) => {
    const code = flightCode(L.flight);
    if (!FLIGHT_RE.test(code) || !YMD_RE.test(L.date)) {
      L.setError('צריך מספר טיסה (למשל LY315) ותאריך');
      return;
    }
    const api = store.get().api;
    if (typeof api?.lookupFlight !== 'function') {
      L.setError('החיפוש האוטומטי לא זמין כרגע — אפשר למלא ידנית');
      return;
    }
    L.setBusy(true);
    L.setError('');
    let res;
    try {
      res = await api.lookupFlight(trip.id, code, L.date);
    } catch {
      res = { ok: false, message: 'החיפוש לא הצליח — אפשר למלא ידנית' };
    }
    L.setBusy(false);
    if (res?.ok && res.flight) {
      const f = res.flight;
      const at = String(f.dep?.sched || '').slice(0, 16) || null;
      L.setFlight(code);
      L.setFound({ number: code, from: f.dep?.iata || null, to: f.arr?.iata || null, at, line: flightLine(f), full: f });
      if (at) L.setTime(hmOf(at));
    } else {
      L.setFound(null);
      L.setError(res?.message || 'לא מצאנו את הטיסה — אפשר למלא ידנית');
    }
  };

  const toggleInv = (name) => setInv((list) => (list.includes(name) ? list.filter((x) => x !== name) : [...list, name].slice(0, 60)));
  const toggleDiet = (chip) => setDiet((set) => {
    const n = new Set(set);
    if (n.has(chip)) n.delete(chip);
    else n.add(chip);
    return n;
  });

  const pickMode = (value) => {
    setErrors({});
    if (value === 'car' && abroad) {
      // "ברכב / מישהו מקפיץ": keep the sub-choice; start with "מקפיצים אותי" when the admin offers it (no ride is
      // created by accident), else with the one choice there is
      const offered = (aq.options.find((o) => o.key === 'car')?.choices || []).map((c) => c.key);
      const first = offered.includes('drop') || !offered.length ? 'drop' : offered[0];
      setMode((m) => (m === 'car' || m === 'drop' ? m : first));
      if (first === 'car' && !myRide && seats < 1) setSeats(ownSeats);
      return;
    }
    setMode(value);
    if (value === 'park' && !myRide) setSeats(0);
    if (value === 'car' && !myRide && seats < 1) setSeats(ownSeats);
  };
  const isOn = (key) => mode === key || (abroad && key === 'car' && mode === 'drop');

  const optCard = (o) => html`<button type="button" role="radio" key=${o.key} data-mode=${o.key}
    aria-checked=${isOn(o.key) ? 'true' : 'false'}
    class=${cx('welcome-opt', isOn(o.key) && 'is-on')} onClick=${() => pickMode(o.key)}>
    <span class="welcome-opt__emoji" aria-hidden="true">${o.emoji}</span>
    <span class="welcome-opt__text"><b>${o.label}</b><span>${o.sub}</span></span>
  </button>`;

  const legFields = (L, key, title, placeholder) => html`<div class="welcome-flights" data-testid=${`welcome-leg-${key}`}>
    <div class="date-pair">
      <${Field} label=${title} error=${errors[key]}>
        <${TextInput} dir="ltr" value=${L.flight} maxlength="12" placeholder=${placeholder} autocapitalize="characters"
          onInput=${(e) => { L.setFlight(e.target.value); L.setFound(null); L.setError(''); }} />
      </${Field}>
      <${Field} label="תאריך">
        <${TextInput} type="date" value=${L.date} onInput=${(e) => { L.setDate(e.target.value); L.setFound(null); L.setError(''); }} />
      </${Field}>
    </div>
    ${L.found
      ? html`<p class="small" data-testid=${`welcome-found-${key}`} dir="auto">✓ נמצא · ${L.found.line || `${L.found.from} → ${L.found.to}`}</p>`
      : html`<div class="row wrap">
          <${Button} size="sm" variant="secondary" loading=${L.busy} disabled=${!flightCode(L.flight) || !L.date}
            onClick=${() => lookup(L)} data-testid=${`welcome-lookup-${key}`}>🔎 מילוי אוטומטי</${Button}>
        </div>`}
    ${fitWarns(L, key).map((w) => html`<p key=${w.kind} class="small flight-fit" role="status" data-testid=${`welcome-fit-${key}`} style="margin: 0; color: var(--warning-text)">⚠️ ${w.text}</p>`)}
    ${L.error ? html`<p class="small muted" role="status" data-testid=${`welcome-lookup-msg-${key}`}>${L.error}</p>` : null}
    ${!L.found && flightCode(L.flight) && L.error
      ? html`<${Field} label="שעת המראה (לא חובה)">
          <${TextInput} type="time" value=${L.time} onInput=${(e) => L.setTime(e.target.value)} />
        </${Field}>`
      : null}
  </div>`;

  const minSeats = myRide ? Math.max(1, myRide.taken) : 1;

  return html`<div class="screen welcome">
    <header class="welcome__head">
      <${Avatar} member=${me} size=${52} />
      <div>
        <p class="welcome__hi">היי ${displayName(me)}! עוד רגע בפנים 🔥</p>
        <ol class="welcome__dots" aria-label=${`שלב ${step + 1} מתוך ${steps.length}`}>
          ${steps.map((x, i) => html`<li key=${x.key} class=${cx('welcome__dot', i === step && 'is-on', i < step && 'is-done')}></li>`)}
        </ol>
      </div>
    </header>

    <section class="welcome__card" aria-labelledby="welcome-title" data-step=${s.key}>
      <h1 class="welcome__title" id="welcome-title"><span aria-hidden="true">${s.emoji}</span> ${s.title}</h1>

      ${s.key === 'contact'
        ? html`<p class="welcome__lead">${people.length > 1
            ? 'מייל לכל אחד מכם — ככה כל אחד יקבל עדכונים ויוכל להתחבר מהטלפון שלו.'
            : 'כדי שנוכל לעדכן אותך בכל מה שחשוב — ולהעביר כסף בקלות.'}</p>
          <${Field} label="טלפון (לא חובה)" hint="בשביל Bit / PayBox ווואטסאפ — יוצג רק לחברי הטיול" error=${errors.phone}>
            <${TextInput} type="tel" inputmode="tel" autocomplete="tel" value=${phone} placeholder="050-1234567"
              onInput=${(e) => setPhone(e.target.value)} />
          </${Field}>
          ${people.map((name, i) => html`<${Field} key=${i} label=${people.length === 1 ? 'המייל שלך' : `המייל של ${name || `משתתף/ת ${i + 1}`}`}
              hint=${i === 0
                ? (verified && emails[0] === verified ? '✅ מאומת. לשם יגיעו עדכונים ותזכורות.' : 'לשם יגיעו עדכונים ותזכורות (ערב לפני, בוקר היציאה). בכל מייל יש קישור להסרה.')
                : `✉️ יאומת בהמשך — כש${name || 'הם'} יתחבר/תתחבר מהטלפון שלו/ה עם המייל הזה, ייכנס/תיכנס ישר לפרופיל המשותף.`}
              error=${errors[`email${i}`]}>
            <${TextInput} type="email" inputmode="email" dir="ltr" autocomplete=${i === 0 ? 'email' : 'off'} value=${emails[i]}
              placeholder="name@example.com"
              onInput=${(e) => { const v = e.target.value; setEmails((l) => l.map((x, j) => (j === i ? v : x))); }} />
          </${Field}>`)}`
        : null}

      ${s.key === 'arrive'
        ? html`<p class="welcome__lead">${aq.lead}</p>
          <div class="welcome-opts" role="radiogroup" aria-label=${aq.title} data-testid="welcome-arrive-opts">
            ${aq.options.map(optCard)}
            ${rides.mySeat ? optCard({ key: 'seat', emoji: '✅', label: `כבר ברכב של ${displayName(rides.mySeat.driver)}`, sub: 'מסודרים' }) : null}
          </div>
          ${abroad && (mode === 'car' || mode === 'drop')
            ? html`<div class="me-chips" role="radiogroup" aria-label="נוהגים או שמקפיצים אתכם?">
                ${(aq.options.find((o) => o.key === 'car')?.choices || []).map((c) => html`<button type="button" key=${c.key} role="radio"
                  aria-checked=${mode === c.key ? 'true' : 'false'} class=${cx('chip', mode === c.key && 'is-active')}
                  onClick=${() => { setMode(c.key); setErrors({}); if (c.key === 'car' && !myRide && seats < 1) setSeats(ownSeats); }}>${c.label}</button>`)}
              </div>`
            : null}
          ${abroad && mode === 'taxi'
            ? html`<button type="button" role="switch" aria-checked=${organise ? 'true' : 'false'} class=${cx('welcome-chk', organise && 'is-on')}
                onClick=${() => { setOrganise(!organise); if (!organise && seats < 1) setSeats(seatsFor('taxi', me)); }}>
                ${organise ? '☑️' : '⬜'} אני מזמין/ה את המונית — יש מקום לעוד
              </button>`
            : null}
          ${mode && mode !== 'seat' && (snap.members || []).length > 2
            ? html`<${WithPicker} members=${snap.members} meId=${me.id} value=${together} onChange=${setTogether} label="🤝 מגיעים יחד עם מישהו? (לא חובה)" />` : null}
          ${asksFrom
            ? html`<div>
                <${PlaceInput} label="יוצאים מ…" value=${fromPlace} text=${fromText} where="il" nav=${false}
                  placeholder="למשל: תל אביב, רמת גן" testid="welcome-from"
                  onChange=${(place, text) => { setFromPlace(place); setFromText(text ?? ''); }} />
                ${errors.from ? html`<span class="field__error" role="alert">${errors.from}</span>` : null}
              </div>`
            : null}
          ${mode === 'need' || mode === 'transit' || (mode === 'taxi' && !organise)
            ? html`<${SeatsNote} snap=${snap} rides=${rides} />` : null}
          ${rideKind || mode === 'park'
            ? html`<div class="welcome-row">
                <span class="field__label">${mode === 'park' ? 'מקומות פנויים ברכב לשדה (לא חובה)' : 'כמה מקומות פנויים (בלי אתכם)?'}</span>
                <${Stepper} value=${seats} min=${mode === 'park' && !(myRide && myRide.taken) ? 0 : minSeats} max=${8} label="מקומות פנויים" onChange=${setSeats} />
              </div>`
            : null}
          ${rideKind
            ? html`<${Field} label="מתכננים לצאת ב… (לא חובה)">
                <${TextInput} type="time" value=${depart} onInput=${(e) => setDepart(e.target.value)} />
              </${Field}>`
            : null}
          ${abroad
            ? html`<div class="field" data-testid="welcome-airports">
                <span class="field__label">מאיזה שדה ממריאים?</span>
                <div class="me-chips" role="radiogroup" aria-label="מאיזה שדה ממריאים?">
                  ${aq.airports.map((a) => html`<button type="button" key=${a.iata} role="radio" data-iata=${a.iata}
                    aria-checked=${!otherAirport && airport === a.iata ? 'true' : 'false'}
                    class=${cx('chip', !otherAirport && airport === a.iata && 'is-active')}
                    onClick=${() => { setAirport(a.iata); setOtherAirport(false); setErrors({}); }}>${a.label} <span dir="ltr">${a.iata}</span></button>`)}
                  <button type="button" role="radio" aria-checked=${otherAirport ? 'true' : 'false'} class=${cx('chip', otherAirport && 'is-active')}
                    onClick=${() => { setOtherAirport(true); if (AIRPORTS.some((a) => a.iata === airport)) setAirport(''); }}>שדה אחר</button>
                </div>
                ${otherAirport
                  ? html`<${Field} label="קוד השדה" error=${errors.airport}>
                      <${TextInput} dir="ltr" value=${airport} maxlength="3" placeholder="SDV" autocapitalize="characters"
                        onInput=${(e) => setAirport(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3))} />
                    </${Field}>`
                  : null}
              </div>`
            : null}
          ${aq.askLate
            ? html`<div class="welcome-late">
                <button type="button" role="switch" aria-checked=${late ? 'true' : 'false'} class=${cx('welcome-chk', late && 'is-on')}
                  onClick=${() => setLate(!late)}>
                  ${late ? '☑️' : '⬜'} מגיעים בשעה אחרת${startHm ? ` (לא ב-${startHm} עם כולם)` : ''}
                </button>
                ${late
                  ? html`<${Field} label="בערך באיזו שעה?" error=${errors.arrival}>
                      <${TextInput} type="time" value=${arrival} onInput=${(e) => setArrival(e.target.value)} />
                    </${Field}>`
                  : null}
              </div>`
            : null}`
        : null}

      ${s.key === 'fly'
        ? html`${groupFlight
            ? html`<div class="welcome-opts" role="radiogroup" aria-label="טיסה" data-testid="welcome-group-flight">
                <button type="button" role="radio" aria-checked=${!ownFlight ? 'true' : 'false'} class=${cx('welcome-opt', !ownFlight && 'is-on')} onClick=${() => { setOwnFlight(false); setErrors({}); }}>
                  <span class="welcome-opt__emoji" aria-hidden="true">✈️</span>
                  <span class="welcome-opt__text"><b>טס/ה עם הקבוצה</b><span dir="auto">${groupFlight.flight}${groupFlight.at ? ` · ${hmOf(groupFlight.at)}` : ''}</span></span>
                </button>
                <button type="button" role="radio" aria-checked=${ownFlight ? 'true' : 'false'} class=${cx('welcome-opt', ownFlight && 'is-on')} onClick=${() => setOwnFlight(true)}>
                  <span class="welcome-opt__emoji" aria-hidden="true">🛫</span>
                  <span class="welcome-opt__text"><b>בטיסה אחרת</b><span>מצטרפים מאוחר / חוזרים בנפרד</span></span>
                </button>
              </div>`
            : html`<p class="welcome__lead">מספר טיסה ותאריך — ונמלא את השאר. לא חובה, אפשר גם אחר כך.</p>`}
          ${!groupFlight || ownFlight
            ? html`<div class="welcome-flights" data-testid="welcome-flights">
                ${legFields(out, 'out', 'טיסה הלוך', 'LY315')}
                ${legFields(back, 'back', 'טיסה חזור', 'LY316')}
              </div>`
            : null}`
        : null}

      ${s.key === 'food'
        ? html`<p class="welcome__lead">מה חשוב לדעת על האוכל שלכם?</p>
          <div class="me-chips" role="group" aria-label="העדפות אוכל">
            ${DIET_CHIPS.map((c) => html`<${Chip} key=${c} active=${diet.has(c)} onClick=${() => toggleDiet(c)}>${c}</${Chip}>`)}
          </div>
          <${Field} label="משהו נוסף? (לא חובה)">
            <${TextInput} value=${dietNote} maxlength="120" placeholder="למשל: אלרגיה לבוטנים" onInput=${(e) => setDietNote(e.target.value)} />
          </${Field}>
          ${askHome
            ? html`<p class="welcome__lead">מה יש לכם בבית שיכול לעזור בטיול?</p>
              <div class="me-chips" role="group" aria-label="מה יש לנו בבית">
                ${INVENTORY_SUGGESTIONS.map(([name, em]) => html`<${Chip} key=${name} active=${inv.includes(name)} onClick=${() => toggleInv(name)}>
                  <span aria-hidden="true">${em}</span> ${name}
                </${Chip}>`)}
              </div>`
            : null}`
        : null}
    </section>

    <footer class="welcome__foot" style=${STICKY_FOOT}>
      <${Button} variant="accent" size="lg" block loading=${busy} onClick=${() => next(true)}>
        ${step < steps.length - 1 ? 'הבא' : 'סיימנו — לטיול! 🔥'}
      </${Button}>
      <div class="row row--center wrap">
        ${step > 0 ? html`<${Button} variant="ghost" onClick=${() => { setErrors({}); setStep(step - 1); }}>חזרה</${Button}>` : null}
        <${Button} variant="ghost" disabled=${busy} onClick=${() => next(false)}>
          ${step < steps.length - 1 ? 'דלג על השלב' : 'אחר כך'}
        </${Button}>
      </div>
    </footer>
  </div>`;
}

/** Where there are seats — a line, not a live "בקשה" button (ux E8): asking happens on the rides tab after this. */
function SeatsNote({ snap, rides }) {
  const open = rides.rides.filter((r) => r.free > 0 && (r.kind || 'car') !== 'meet');
  const meets = rides.rides.filter((r) => (r.kind || 'car') === 'meet');
  const seats = open.reduce((n, r) => n + r.free, 0);
  return html`<p class="small muted" data-testid="welcome-seats">
    ${seats
      ? `🚗 יש ${seats === 1 ? 'מקום פנוי אחד' : `${seats} מקומות פנויים`} ב${open.length === 1 ? `רכב של ${open[0].driver ? displayName(open[0].driver) : 'מישהו'}` : `${open.length} רכבים`}${meets.length ? ' ויש גם נקודת מפגש' : ''}. `
      : meets.length ? '🚆 יש נקודת מפגש. ' : 'עוד אין מקומות פנויים. ברגע שמישהו יציע, נראה לך. '}
    ${seats || meets.length
      ? html`מבקשים מקום במסך <a class="link" href=${href(`/t/${snap.trip.id}/rides`)}>הסעות</a>, אחרי שמסיימים כאן.`
      : 'המארגנים רואים שאתם מחפשים מקום 🙂'}
  </p>`;
}
