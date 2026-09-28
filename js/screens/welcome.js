// Welcome wizard — right after joining (and once for anyone who hasn't done it): contact details,
// how you get there (car / need a ride / own way + arrival time), food & what you have at home.
// Every step can be skipped; finishing (or skipping to the end) sets prefs.onboarded.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { actions, useTrip } from '../store.js';
import { navigate } from '../router.js';
import { displayName, ilIso, ilWall, rideModel, whatsappChatUrl } from '../lib/logic.js';
import { Avatar, Button, Chip, Field, Skeleton, Stepper, TextInput } from '../ui/components.js';
import { DIET_CHIPS, INVENTORY_SUGGESTIONS } from './me.js';

const cx = (...a) => a.filter(Boolean).join(' ');
const MAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s.]{2,}$/;
const STEPS = [
  { key: 'contact', emoji: '📬', title: 'איך יוצרים איתכם קשר?' },
  { key: 'arrive', emoji: '🚗', title: 'איך מגיעים?' },
  { key: 'more', emoji: '🍽️', title: 'ועוד קצת עליכם' },
];

export default function WelcomeScreen({ route }) {
  const { snap, me } = useTrip();
  const tripId = route?.params?.tripId;
  if (!snap || !me || snap.trip.id !== tripId) {
    return html`<div class="screen welcome" aria-busy="true"><${Skeleton} lines=${3} /><${Skeleton} lines=${5} /></div>`;
  }
  return html`<${Wizard} key=${me.id} snap=${snap} me=${me} start=${route.query?.step} />`;
}

function Wizard({ snap, me, start }) {
  const trip = snap.trip;
  const first = Math.max(0, STEPS.findIndex((s) => s.key === start));
  const [step, setStep] = useState(first);
  const [busy, setBusy] = useState(false);
  const people = (me.people && me.people.length ? me.people : [displayName(me)]);
  const prefs = me.prefs || {};
  const rides = rideModel(snap, me.id);

  // ---- step 1: contact ----
  const [phone, setPhone] = useState(me.phone || '');
  const [emails, setEmails] = useState(() => people.map(() => ''));
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

  // ---- step 2: arrival ----
  const t = prefs.transport || {};
  const [mode, setMode] = useState(rides.myRide ? 'car' : t.mode || (rides.mySeat ? 'seat' : ''));
  const [from, setFrom] = useState(rides.myRide?.from_text || t.from || '');
  const [seats, setSeats] = useState(rides.myRide?.seats ?? 2);
  const [depart, setDepart] = useState(rides.myRide?.depart_at ? ilWall(new Date(rides.myRide.depart_at)).hm : '');
  const [late, setLate] = useState(Boolean(prefs.arrival));
  const [arrival, setArrival] = useState(prefs.arrival || '');

  // ---- step 3: food & home ----
  const [diet, setDiet] = useState(() => new Set(String(prefs.diet || '').split(' · ').filter((x) => DIET_CHIPS.includes(x))));
  const [dietNote, setDietNote] = useState(() => String(prefs.diet || '').split(' · ').filter((x) => x && !DIET_CHIPS.includes(x)).join(' · '));
  const [inv, setInv] = useState(me.inventory || []);

  const [errors, setErrors] = useState({});
  const s = STEPS[step];
  const startHm = trip.starts_at ? ilWall(new Date(trip.starts_at)).hm : null;
  const tripDay = trip.starts_at ? ilWall(new Date(trip.starts_at)).ymd : ilWall(new Date()).ymd;

  const run = (fn) => actions.run(async (api) => { await fn(api); return true; }, { refresh: false });

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

  const saveArrive = async () => {
    const errs = {};
    if (mode === 'car' && !from.trim()) errs.from = 'מאיפה יוצאים? (עיר / שכונה)';
    if (late && !arrival) errs.arrival = 'באיזו שעה בערך?';
    setErrors(errs);
    if (Object.keys(errs).length) return false;
    const transport = mode === 'car' ? { mode: 'car' } : mode === 'need' ? { mode: 'need', from: from.trim() || null } : mode ? { mode } : null;
    let ok = await run((api) => api.updateMember(me.id, { prefs: { transport, arrival: late ? arrival : null } }));
    if (ok && mode === 'car') {
      ok = await run((api) => api.upsertRide(trip.id, {
        ...(rides.myRide ? { id: rides.myRide.id } : {}),
        seats, from_text: from.trim(), depart_at: depart ? ilIso(tripDay, depart) : null,
      }));
    } else if (ok && mode !== 'car' && rides.myRide && !rides.myRide.taken) {
      ok = await run((api) => api.deleteRide(rides.myRide.id));
    }
    return ok;
  };

  const saveMore = async () => {
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
    const savers = [saveContact, saveArrive, saveMore];
    const ok = save ? await savers[step]() : true;
    setBusy(false);
    if (!ok) return;
    setErrors({});
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      window.scrollTo(0, 0);
    } else {
      setBusy(true);
      await finish();
    }
  };

  const toggleInv = (name) => setInv((list) => (list.includes(name) ? list.filter((x) => x !== name) : [...list, name].slice(0, 60)));
  const toggleDiet = (chip) => setDiet((set) => {
    const n = new Set(set);
    if (n.has(chip)) n.delete(chip);
    else n.add(chip);
    return n;
  });

  const modeCard = (value, emoji, label, hint) => html`<button type="button" role="radio" aria-checked=${mode === value ? 'true' : 'false'}
    class=${cx('welcome-opt', mode === value && 'is-on')} onClick=${() => { setMode(value); setErrors({}); }}>
    <span class="welcome-opt__emoji" aria-hidden="true">${emoji}</span>
    <span class="welcome-opt__text"><b>${label}</b><span>${hint}</span></span>
  </button>`;

  return html`<div class="screen welcome">
    <header class="welcome__head">
      <${Avatar} member=${me} size=${52} />
      <div>
        <p class="welcome__hi">היי ${displayName(me)}! עוד רגע בפנים 🔥</p>
        <ol class="welcome__dots" aria-label=${`שלב ${step + 1} מתוך ${STEPS.length}`}>
          ${STEPS.map((x, i) => html`<li key=${x.key} class=${cx('welcome__dot', i === step && 'is-on', i < step && 'is-done')}></li>`)}
        </ol>
      </div>
    </header>

    <section class="welcome__card" aria-labelledby="welcome-title">
      <h1 class="welcome__title" id="welcome-title"><span aria-hidden="true">${s.emoji}</span> ${s.title}</h1>

      ${s.key === 'contact'
        ? html`<p class="welcome__lead">כדי שנוכל לעדכן אתכם בכל מה שחשוב — ולהעביר כסף בקלות.</p>
          <${Field} label="טלפון (לא חובה)" hint="בשביל Bit / PayBox ווואטסאפ — יוצג רק לחברי הטיול" error=${errors.phone}>
            <${TextInput} type="tel" inputmode="tel" autocomplete="tel" value=${phone} placeholder="050-1234567"
              onInput=${(e) => setPhone(e.target.value)} />
          </${Field}>
          ${people.map((name, i) => html`<${Field} key=${i} label=${people.length === 1 ? 'המייל שלך' : `המייל של ${name || `משתתף/ת ${i + 1}`}`}
              hint=${i === 0 ? 'לשם יגיעו עדכונים ותזכורות (ערב לפני, בוקר היציאה). בכל מייל יש קישור להסרה.' : null}
              error=${errors[`email${i}`]}>
            <${TextInput} type="email" inputmode="email" dir="ltr" autocomplete=${i === 0 ? 'email' : 'off'} value=${emails[i]}
              placeholder="name@example.com"
              onInput=${(e) => { const v = e.target.value; setEmails((l) => l.map((x, j) => (j === i ? v : x))); }} />
          </${Field}>`)}`
        : null}

      ${s.key === 'arrive'
        ? html`<div class="welcome-opts" role="radiogroup" aria-label="איך מגיעים">
            ${modeCard('car', '🚗', 'נוסעים ברכב שלנו', 'ואולי יש מקום לעוד מישהו')}
            ${modeCard('need', '🙋', 'צריכים טרמפ', 'נראה מי נוסע מהאזור שלכם')}
            ${rides.mySeat ? modeCard('seat', '✅', `כבר ברכב של ${displayName(rides.mySeat.driver)}`, 'מסודרים') : null}
            ${modeCard('own', '🚌', 'מגיעים בדרך אחרת', 'אוטובוס, רכב מלא, מישהו מקפיץ')}
          </div>
          ${mode === 'car' || mode === 'need'
            ? html`<${Field} label="יוצאים מ…" error=${errors.from}>
                <${TextInput} value=${from} maxlength="80" placeholder="למשל: תל אביב, רמת גן" onInput=${(e) => setFrom(e.target.value)} />
              </${Field}>`
            : null}
          ${mode === 'car'
            ? html`<div class="welcome-row">
                <span class="field__label">כמה מקומות פנויים (בלי אתכם)?</span>
                <${Stepper} value=${seats} min=${rides.myRide ? Math.max(1, rides.myRide.taken) : 1} max=${8} label="מקומות פנויים" onChange=${setSeats} />
              </div>
              <${Field} label="מתכננים לצאת ב… (לא חובה)">
                <${TextInput} type="time" value=${depart} onInput=${(e) => setDepart(e.target.value)} />
              </${Field}>`
            : null}
          <div class="welcome-late">
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
        : null}

      ${s.key === 'more'
        ? html`<p class="welcome__lead">מה חשוב לדעת על האוכל שלכם?</p>
          <div class="me-chips" role="group" aria-label="העדפות אוכל">
            ${DIET_CHIPS.map((c) => html`<${Chip} key=${c} active=${diet.has(c)} onClick=${() => toggleDiet(c)}>${c}</${Chip}>`)}
          </div>
          <${Field} label="משהו נוסף? (לא חובה)">
            <${TextInput} value=${dietNote} maxlength="120" placeholder="למשל: אלרגיה לבוטנים" onInput=${(e) => setDietNote(e.target.value)} />
          </${Field}>
          <p class="welcome__lead">מה יש לכם בבית שיכול לעזור בטיול?</p>
          <div class="me-chips" role="group" aria-label="מה יש לנו בבית">
            ${INVENTORY_SUGGESTIONS.map(([name, em]) => html`<${Chip} key=${name} active=${inv.includes(name)} onClick=${() => toggleInv(name)}>
              <span aria-hidden="true">${em}</span> ${name}
            </${Chip}>`)}
          </div>`
        : null}
    </section>

    <footer class="welcome__foot">
      <${Button} variant="accent" size="lg" block loading=${busy} onClick=${() => next(true)}>
        ${step < STEPS.length - 1 ? 'הבא' : 'סיימנו — לטיול! 🔥'}
      </${Button}>
      <div class="row row--center wrap">
        ${step > 0 ? html`<${Button} variant="ghost" onClick=${() => { setErrors({}); setStep(step - 1); }}>חזרה</${Button}>` : null}
        <${Button} variant="ghost" disabled=${busy} onClick=${() => next(false)}>
          ${step < STEPS.length - 1 ? 'דלג על השלב' : 'אחר כך'}
        </${Button}>
      </div>
    </footer>
  </div>`;
}
