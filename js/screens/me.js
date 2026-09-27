// Me (SPEC §8.10): my profile (single / couple), what I have at home, food preferences,
// notification + reminder preferences (saved in members.prefs), this device's notifications,
// theme, linking another device / partner, my trips, leaving the trip and the demo-only
// "🎭 החלף משתמש" switcher.
// Also exports `ProfileForm`, reused by the People screen for "הוסף פרופיל לחבר/ה".
import { html } from 'htm/preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { useTrip, useStore, actions } from '../store.js';
import { navigate } from '../router.js';
import {
  Avatar, Button, Card, Chip, ColorPicker, CopyButton, EmojiPicker, Field, Pill, Segmented, Sheet,
  ShareButton, Skeleton, Stepper, TextArea, TextInput, Toggle, confirmDialog,
} from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import { deviceLinkUrl, displayName, formatDate, isAdmin as memberIsAdmin, whatsappChatUrl } from '../lib/logic.js';

const cx = (...a) => a.filter(Boolean).join(' ');

let seq = 0;
const useFormId = (prefix) => useState(() => `${prefix}-${++seq}`)[0];

const appBase = () => `${location.origin}${location.pathname}`;

const PALETTE = ['⛺', '🔥', '🌲', '🦊', '🐻', '🦉', '🦔', '🐢', '🦎', '🌙', '⭐', '🍉', '🥩', '🍺', '🎸', '🏕️', '🌈', '🐬', '🦄', '🌵'];
const COLORS = ['#2F6B4F', '#F28C28', '#E4572E', '#3A86FF', '#8E44AD', '#16A085', '#D4A017', '#C0392B', '#2C3E50', '#FF6B9A'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Stored inventory values stay plain (the lists screen matches them to item titles). */
const INVENTORY_SUGGESTIONS = [
  ['מנגל', '🔥'], ['נפנף', '💨'], ['גזיבו', '⛱️'], ['רמקול', '🔊'], ['מחצלת', '🧺'], ['כסאות ים', '🪑'],
  ['צידנית', '🧊'], ['פקל קפה', '☕'], ['גזייה', '🍳'], ['פנס/תאורה', '🔦'], ['מטקות', '🏓'], ['כדור', '⚽'],
  ['שש בש', '🎲'], ['קלפים', '🃏'], ['אוהל גדול', '⛺'], ['שולחן מתקפל', '🍽️'],
];
const SUGGESTED = new Set(INVENTORY_SUGGESTIONS.map(([name]) => name));

const DIET_CHIPS = ['🥦 צמחוני/ת', '🌱 טבעוני/ת', '🌾 בלי גלוטן', '🥛 בלי לקטוז', '✡️ כשר', '🌶️ אוהב/ת חריף', '🚱 בלי אלכוהול'];

const NOTIFY_KEYS = [
  ['announcements', '📣 הודעות מהמנהלים', 'עדכונים חשובים לכל הקבוצה'],
  ['assignments', '🙋 שיבוצים והצעות', 'כששיבצו אותך או כשהצעה שלך אושרה'],
  ['money', '💸 כסף והעברות', 'כשמישהו סימן שהעביר לך, או אישר שקיבל'],
  ['reminders', '⏰ תזכורות', 'תזכורות חכמות לפני ואחרי הטיול'],
];
const REMINDER_KEYS = [
  ['pack_evening_before', '🎒 ערב לפני — לארוז', 'רשימת "המשימות שלי" + מה עוד לא ארוז'],
  ['departure_morning', '🚗 בוקר היציאה', 'מה לא לשכוח לפני שיוצאים'],
  ['pay_after_trip', '💸 אחרי הטיול — להתחשבן', 'למי להעביר וכמה'],
];

function normalizePrefs(p) {
  const prefs = p && typeof p === 'object' ? p : {};
  const notify = prefs.notify && typeof prefs.notify === 'object' ? prefs.notify : {};
  const reminders = prefs.reminders && typeof prefs.reminders === 'object' ? prefs.reminders : {};
  const qh = prefs.quiet_hours;
  return {
    notify: Object.fromEntries(NOTIFY_KEYS.map(([k]) => [k, notify[k] !== false])),
    reminders: Object.fromEntries(REMINDER_KEYS.map(([k]) => [k, reminders[k] !== false])),
    quiet_hours: qh && typeof qh === 'object' && qh.from && qh.to ? { from: qh.from, to: qh.to } : null,
  };
}

/** Wraps a void mutation so the caller can tell success (true) from failure (undefined). */
const ok = (fn) => async (api) => {
  await fn(api);
  return true;
};

// ---------------------------------------------------------------------------
// shared profile form (Me → edit, People → add a placeholder profile)
// ---------------------------------------------------------------------------

const joinNames = (a, b) => [String(a || '').trim(), String(b || '').trim()].filter(Boolean).join(' ו');

/**
 * Single / couple profile form. Renders a <form id={id}> without a submit button, so the caller
 * can put one in a sheet footer (`<Button type="submit" form={id}>`).
 * onSubmit receives {display_name, headcount, people, emoji, color, phone}.
 */
export function ProfileForm({ id, initial = {}, allowFamily = false, onSubmit }) {
  const initPeople = (initial.people || []).map((p) => String(p || '').trim()).filter(Boolean);
  const initHead = Math.max(1, Number(initial.headcount) || (initPeople.length >= 2 ? 2 : 1));
  const initDisplay = String(initial.display_name || '').trim();
  const [headcount, setHeadcount] = useState(initHead);
  const [name1, setName1] = useState(initPeople[0] || (initPeople.length ? '' : initDisplay));
  const [name2, setName2] = useState(initPeople[1] || '');
  const initAuto = initHead >= 2 ? joinNames(initPeople[0], initPeople[1]) : initPeople[0] || initDisplay;
  const [display, setDisplay] = useState(initDisplay);
  const [touched, setTouched] = useState(Boolean(initDisplay) && initDisplay !== initAuto);
  const [emoji, setEmoji] = useState(initial.emoji || pick(PALETTE));
  const [color, setColor] = useState(initial.color || pick(COLORS));
  const [phone, setPhone] = useState(initial.phone || '');
  const [errors, setErrors] = useState({});

  const couple = headcount >= 2;
  const family = headcount > 2;
  const auto = couple ? joinNames(name1, name2) : name1.trim();
  const shown = touched ? display : auto;
  const kinds = [
    { v: 1, emoji: '🧍', label: 'יחיד/ה' },
    { v: 2, emoji: '👫', label: 'זוג' },
    ...(allowFamily || initHead > 2 ? [{ v: 3, emoji: '👨‍👩‍👧', label: 'משפחה' }] : []),
  ];
  const kindOf = (h) => (h > 2 ? 3 : h);
  const clear = (k) => errors[k] && setErrors({ ...errors, [k]: undefined });

  const submit = (e) => {
    e.preventDefault();
    const errs = {};
    const finalName = (shown.trim() || auto).trim();
    if (!name1.trim()) errs.name1 = couple ? 'מה השם הראשון? 🙂' : 'איך קוראים לך? 🙂';
    if (headcount === 2 && !name2.trim()) errs.name2 = 'ומה השם של בן/בת הזוג?';
    if (finalName.length > 40) errs.display = 'עד 40 תווים, בבקשה';
    const ph = phone.trim();
    if (ph && !whatsappChatUrl(ph)) errs.phone = 'המספר לא נראה תקין — למשל 050-1234567';
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    onSubmit?.({
      display_name: finalName,
      headcount,
      people: couple ? [name1.trim(), name2.trim()].filter(Boolean) : [name1.trim()],
      emoji,
      color,
      phone: ph || null,
    });
  };

  const preview = { display_name: shown || auto || (couple ? 'השמות שלכם' : 'השם'), headcount, emoji, color, people: [] };

  return html`<form id=${id} class="pf stack-lg" onSubmit=${submit} noValidate>
    <div class="pf-preview" aria-live="polite">
      <${Avatar} member=${preview} size=${64} />
      <div class="pf-preview__text">
        <span class=${cx('pf-preview__name', !(shown || auto) && 'is-empty')}>${preview.display_name}</span>
        <${Pill} tone="primary">${family ? `👨‍👩‍👧 ${headcount} אנשים` : couple ? '👫 זוג · 2 אנשים' : '🧍 יחיד/ה'}</${Pill}>
      </div>
    </div>

    <div class=${cx('pf-kinds', kinds.length === 3 && 'pf-kinds--3')} role="radiogroup" aria-label="מגיעים לבד או בזוג?">
      ${kinds.map((k) => html`<button
        type="button"
        key=${k.v}
        role="radio"
        aria-checked=${kindOf(headcount) === k.v ? 'true' : 'false'}
        class="pf-kind"
        onClick=${() => {
          setHeadcount(k.v === 3 ? Math.max(3, headcount) : k.v);
          clear('name2');
        }}
      >
        <span class="pf-kind__emoji" aria-hidden="true">${k.emoji}</span>
        <span class="pf-kind__label">${k.label}</span>
      </button>`)}
    </div>

    ${family
      ? html`<div class="pf-count">
          <span class="field__label">כמה אנשים?</span>
          <${Stepper} value=${headcount} min=${3} max=${8} label="כמה אנשים" onChange=${setHeadcount} />
        </div>`
      : null}

    <div class=${cx('pf-names', couple && 'pf-names--two')}>
      <${Field} label=${couple ? 'שם ראשון' : 'שם'} error=${errors.name1}>
        <${TextInput}
          value=${name1}
          maxlength="30"
          placeholder=${couple ? 'למשל: נועה' : 'השם'}
          onInput=${(e) => {
            setName1(e.target.value);
            clear('name1');
          }}
        />
      </${Field}>
      ${couple
        ? html`<${Field} label=${family ? 'שם נוסף (לא חובה)' : 'ושל בן/בת הזוג'} error=${errors.name2}>
            <${TextInput}
              value=${name2}
              maxlength="30"
              placeholder="למשל: איתי"
              onInput=${(e) => {
                setName2(e.target.value);
                clear('name2');
              }}
            />
          </${Field}>`
        : null}
    </div>

    <${Field} label="שם תצוגה" hint="ככה תופיעו ברשימות ובהתחשבנות" error=${errors.display}>
      <${TextInput}
        value=${shown}
        maxlength="40"
        placeholder=${auto || 'שם תצוגה'}
        onInput=${(e) => {
          const v = e.target.value;
          setDisplay(v);
          setTouched(v.trim() !== '');
          clear('display');
        }}
      />
    </${Field}>

    <${Field} label="האימוג׳י">
      <${EmojiPicker} value=${emoji} onChange=${setEmoji} label="האימוג׳י" />
    </${Field}>

    <${Field} label="הצבע">
      <${ColorPicker} value=${color} onChange=${setColor} label="הצבע" />
    </${Field}>

    <${Field} label="טלפון (לא חובה)" hint="בשביל Bit / PayBox ווואטסאפ — יוצג רק לחברי הטיול" error=${errors.phone}>
      <${TextInput}
        type="tel"
        inputmode="tel"
        autocomplete="tel"
        value=${phone}
        placeholder="050-1234567"
        onInput=${(e) => {
          setPhone(e.target.value);
          clear('phone');
        }}
      />
    </${Field}>
  </form>`;
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

export default function MeScreen({ route }) {
  const { snap, me, isAdmin, tripId } = useTrip();
  const wanted = route?.params?.tripId || tripId;
  if (!snap || !me || snap.trip?.id !== wanted) {
    return html`<div class="screen me-screen" aria-busy="true">
      <${Skeleton} lines=${3} />
      <${Skeleton} lines=${4} />
      <${Skeleton} lines=${4} />
    </div>`;
  }
  return html`<${MeBody} key=${me.id} snap=${snap} me=${me} admin=${isAdmin} tripId=${snap.trip.id} />`;
}

function MeBody({ snap, me, admin, tripId }) {
  return html`<div class="screen me-screen">
    <${ProfileCard} me=${me} admin=${admin} />
    <${InventoryCard} me=${me} />
    <${DietCard} me=${me} />
    <${NotifyCard} me=${me} tripId=${tripId} />
    <${DeviceLinkCard} me=${me} trip=${snap.trip} />
    <${ThemeCard} />
    <${TripsCard} tripId=${tripId} />
    <${DemoCard} snap=${snap} me=${me} />
    <${LeaveCard} snap=${snap} me=${me} admin=${admin} tripId=${tripId} />
  </div>`;
}

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------

function ProfileCard({ me, admin }) {
  const [open, setOpen] = useState(false);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const formId = useFormId('me-profile');
  const heads = Number(me.headcount) || 1;
  const people = (me.people || []).filter(Boolean);
  const peopleLine = people.length > 1 && joinNames(people[0], people[1]) !== me.display_name ? people.join(' · ') : null;
  const kind = heads > 2 ? `👨‍👩‍👧 ${heads} אנשים` : heads === 2 ? '👫 זוג' : '🧍 יחיד/ה';
  const roleLabel = me.role === 'owner' ? '👑 יוצר/ת הטיול' : me.role === 'admin' ? '👑 מנהל/ת' : null;

  const save = async (patch) => {
    setBusy(true);
    const done = await actions.run(ok((api) => api.updateMember(me.id, patch)), { success: 'הפרופיל עודכן ✨' });
    setBusy(false);
    if (done) setOpen(false);
  };

  return html`<section class="me-hero" aria-label="הפרופיל שלי">
    <div class="me-hero__avatar"><${Avatar} member=${me} size=${76} /></div>
    <div class="me-hero__text">
      <span class="kicker">הפרופיל שלי</span>
      <h1 class="me-hero__name">${displayName(me)}</h1>
      ${peopleLine ? html`<span class="me-hero__people">${peopleLine}</span>` : null}
      <div class="me-hero__pills">
        <${Pill} tone="primary">${kind}</${Pill}>
        ${roleLabel ? html`<${Pill} tone="accent">${roleLabel}</${Pill}>` : null}
        ${me.phone
          ? html`<${Pill}><${Icon} name="phone" size=${12} /> <bdi dir="ltr">${me.phone}</bdi></${Pill}>`
          : html`<${Pill} tone="warning">📱 בלי טלפון</${Pill}>`}
      </div>
    </div>
    <${Button}
      variant="secondary"
      size="sm"
      icon="edit"
      class="me-hero__edit"
      onClick=${() => {
        setRound(round + 1);
        setOpen(true);
      }}
    >עריכה</${Button}>

    <${Sheet}
      open=${open}
      onClose=${() => setOpen(false)}
      title="✏️ עריכת פרופיל"
      footer=${html`<${Button} type="submit" form=${formId} variant="accent" size="lg" block loading=${busy}>שמירה</${Button}>`}
    >
      <${ProfileForm} key=${`${me.id}-${round}`} id=${formId} initial=${me} allowFamily=${admin} onSubmit=${save} />
    </${Sheet}>
  </section>`;
}

// ---------------------------------------------------------------------------
// what I have at home
// ---------------------------------------------------------------------------

/** Local copy of a server list/object that updates optimistically and resyncs when idle. */
function useSynced(serverValue) {
  const key = JSON.stringify(serverValue);
  const [value, setValue] = useState(serverValue);
  const pending = useRef(0);
  useEffect(() => {
    if (!pending.current) setValue(serverValue);
  }, [key]);
  return [value, setValue, pending];
}

function InventoryCard({ me }) {
  const [inv, setInv, pending] = useSynced(me.inventory || []);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const custom = inv.filter((x) => !SUGGESTED.has(x));
  const has = (name) => inv.some((x) => x.trim().toLowerCase() === name.trim().toLowerCase());

  const save = async (next) => {
    setInv(next);
    pending.current++;
    await actions.run(ok((api) => api.updateMember(me.id, { inventory: next })));
    pending.current--;
  };

  const toggle = (name) => save(has(name) ? inv.filter((x) => x !== name) : [...inv, name]);

  const add = (e) => {
    e.preventDefault();
    const v = text.trim().slice(0, 40);
    if (!v) return;
    if (has(v)) {
      setError('זה כבר ברשימה 🙂');
      return;
    }
    if (inv.length >= 60) {
      setError('עד 60 פריטים');
      return;
    }
    setText('');
    setError('');
    save([...inv, v]);
  };

  return html`<${Card} emoji="🏠" title="מה יש לי בבית" class="me-inv" action=${inv.length ? html`<${Pill} tone="primary">${inv.length}</${Pill}>` : null}>
    <p class="muted small me-card__lead">סמנו מה יש לכם — כשמישהו ישאל ״יש למישהו רמקול?״ כולם כבר יידעו 😉</p>
    <div class="me-chips" role="group" aria-label="הצעות">
      ${INVENTORY_SUGGESTIONS.map(([name, em]) => html`<${Chip} key=${name} active=${has(name)} onClick=${() => toggle(name)}>
        <span aria-hidden="true">${em}</span> ${name}
      </${Chip}>`)}
      ${custom.map((name) => html`<${Chip} key=${`c-${name}`} active tone="accent" onClick=${() => toggle(name)} aria-label=${`הסרת ${name}`}>
        ${name} <${Icon} name="x" size=${14} />
      </${Chip}>`)}
    </div>
    <form class="me-inv__add" onSubmit=${add}>
      <${TextInput}
        value=${text}
        maxlength="40"
        placeholder="משהו אחר? למשל: ערסל"
        aria-label="פריט נוסף שיש לי בבית"
        onInput=${(e) => {
          setText(e.target.value);
          setError('');
        }}
      />
      <${Button} type="submit" variant="secondary" icon="plus" disabled=${!text.trim()}>הוספה</${Button}>
    </form>
    ${error ? html`<p class="field__error" role="alert">${error}</p>` : null}
  </${Card}>`;
}

// ---------------------------------------------------------------------------
// food & preferences
// ---------------------------------------------------------------------------

function DietCard({ me }) {
  const server = String(me.prefs?.diet || '');
  const [text, setText] = useState(server);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(server), [server]);
  const dirty = text.trim() !== server.trim();

  const addChip = (chip) => {
    const t = text.trim();
    if (t.includes(chip)) return;
    setText(t ? `${t}, ${chip}` : chip);
  };

  const save = async () => {
    setBusy(true);
    await actions.run(ok((api) => api.updateMember(me.id, { prefs: { diet: text.trim() } })), {
      success: 'ההעדפות נשמרו 🍽️',
    });
    setBusy(false);
  };

  return html`<${Card} emoji="🍽️" title="אוכל והעדפות" class="me-diet">
    <p class="muted small me-card__lead">ככה מי שקונה יודע/ת — צמחוני? בלי גלוטן? אוהבים יין מבעבע? 🥂</p>
    <div class="h-scroll me-diet__chips" role="group" aria-label="הוספה מהירה">
      ${DIET_CHIPS.map((c) => html`<${Chip} key=${c} active=${text.includes(c)} onClick=${() => addChip(c)}>${c}</${Chip}>`)}
    </div>
    <${Field} label="מה חשוב לדעת עליכם?">
      <${TextArea}
        value=${text}
        rows=${2}
        maxlength="300"
        placeholder="למשל: איתי צמחוני, נועה בלי חריף 🌶️"
        onInput=${(e) => setText(e.target.value)}
      />
    </${Field}>
    ${dirty
      ? html`<div class="row me-diet__actions">
          <${Button} variant="primary" icon="check" loading=${busy} onClick=${save}>שמירה</${Button}>
          <${Button} variant="ghost" disabled=${busy} onClick=${() => setText(server)}>ביטול</${Button}>
        </div>`
      : null}
  </${Card}>`;
}

// ---------------------------------------------------------------------------
// notifications, quiet hours, reminders, this device
// ---------------------------------------------------------------------------

function NotifyCard({ me, tripId }) {
  const [prefs, setPrefs, pending] = useSynced(normalizePrefs(me.prefs));
  const [status, setStatus] = useState('idle');
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  const save = async (patch) => {
    setPrefs({ ...prefs, ...patch });
    pending.current++;
    setStatus('saving');
    clearTimeout(timer.current);
    const done = await actions.run(ok((api) => api.updateMember(me.id, { prefs: patch })));
    pending.current--;
    setStatus(done ? 'saved' : 'idle');
    if (done) timer.current = setTimeout(() => setStatus('idle'), 2200);
  };

  const setNotify = (k, v) => save({ notify: { ...prefs.notify, [k]: v } });
  const setReminder = (k, v) => save({ reminders: { ...prefs.reminders, [k]: v } });
  const quiet = prefs.quiet_hours;
  const setQuiet = (from, to) => save({ quiet_hours: { from, to } });

  const statusNode = status === 'saving'
    ? html`<span class="me-saved is-saving" aria-live="polite">שומר…</span>`
    : status === 'saved'
      ? html`<span class="me-saved" aria-live="polite"><${Icon} name="check" size=${14} /> נשמר</span>`
      : html`<span class="me-saved" aria-live="polite"></span>`;

  return html`<${Card} emoji="🔔" title="התראות ותזכורות" class="me-notify" action=${statusNode}>
    <div class="me-toggles">
      ${NOTIFY_KEYS.map(([k, label, hint]) => html`<${Toggle}
        key=${k}
        checked=${prefs.notify[k]}
        label=${label}
        hint=${hint}
        onChange=${(v) => setNotify(k, v)}
      />`)}
    </div>

    ${prefs.notify.reminders
      ? html`<div class="me-sub">
          <h3 class="me-sub__title">אילו תזכורות?</h3>
          <div class="me-toggles">
            ${REMINDER_KEYS.map(([k, label, hint]) => html`<${Toggle}
              key=${k}
              checked=${prefs.reminders[k]}
              label=${label}
              hint=${hint}
              onChange=${(v) => setReminder(k, v)}
            />`)}
          </div>
        </div>`
      : null}

    <div class="me-sub">
      <${Toggle}
        checked=${Boolean(quiet)}
        label="🌙 שעות שקט"
        hint=${quiet ? `בלי התראות בין ${quiet.from} ל-${quiet.to} (חוץ מדחופות)` : 'בלי התראות בלילה, חוץ מהודעות דחופות'}
        onChange=${(v) => save({ quiet_hours: v ? { from: '23:00', to: '08:00' } : null })}
      />
      ${quiet
        ? html`<div class="me-quiet">
            <${Field} label="מ-">
              <input type="time" class="input" value=${quiet.from} step="900" onChange=${(e) => e.target.value && setQuiet(e.target.value, quiet.to)} />
            </${Field}>
            <${Field} label="עד">
              <input type="time" class="input" value=${quiet.to} step="900" onChange=${(e) => e.target.value && setQuiet(quiet.from, e.target.value)} />
            </${Field}>
          </div>`
        : null}
    </div>

    <${PushBlock} tripId=${tripId} />
  </${Card}>`;
}

function permissionState() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  const p = Notification.permission;
  return p === 'granted' ? 'granted' : p === 'denied' ? 'denied' : 'default';
}

function swReady(ms) {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), ms))]).catch(() => null);
}

function urlBase64ToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const vapidKey = () => String((window.MEDURA_CONFIG && window.MEDURA_CONFIG.vapidPublicKey) || '').trim();
const pushCapable = () => Boolean(vapidKey()) && 'serviceWorker' in navigator && 'PushManager' in window;
const isIosBrowser = () => /iphone|ipad|ipod/i.test(navigator.userAgent || '') && !navigator.standalone;

/** "הפעל התראות למכשיר הזה": permission → push subscription (when a VAPID key is set) → saved. */
function PushBlock({ tripId }) {
  const [state, setState] = useState(permissionState);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state !== 'granted' || !pushCapable()) return undefined;
    let alive = true;
    swReady(2500)
      .then((reg) => (reg && reg.pushManager ? reg.pushManager.getSubscription() : null))
      .then((sub) => {
        if (alive && sub) setState('on');
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      let perm = Notification.permission;
      if (perm === 'default') perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setState(perm === 'denied' ? 'denied' : 'default');
        actions.toast('בלי הרשאה לא נוכל לשלוח התראות 🙈', 'info');
        return;
      }
      if (!pushCapable()) {
        setState('granted');
        actions.toast('ההרשאה התקבלה ✅ התראות לטלפון יגיעו בקרוב', 'success');
        return;
      }
      const reg = await swReady(6000);
      if (!reg || !reg.pushManager) {
        setState('granted');
        actions.toast('לא הצלחנו להפעיל התראות כרגע — נסו שוב אחר כך', 'error');
        return;
      }
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(vapidKey()) });
      const done = await actions.run(ok((api) => api.savePushSubscription(tripId, sub.toJSON())), {
        success: 'ההתראות הופעלו במכשיר הזה 🔔',
        refresh: false,
      });
      setState(done ? 'on' : 'granted');
    } catch (err) {
      console.warn('[medura] enabling push failed', err);
      actions.toast('לא הצלחנו להפעיל התראות במכשיר הזה 😕', 'error');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const reg = await swReady(3000);
      const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await actions.run((api) => api.deletePushSubscription(endpoint), { success: 'ההתראות כובו במכשיר הזה 🔕', refresh: false });
      }
      setState('granted');
    } catch (err) {
      console.warn('[medura] disabling push failed', err);
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (state === 'unsupported') {
    body = html`<p class="me-push__text">
      הדפדפן הזה לא תומך בהתראות.
      ${isIosBrowser() ? ' באייפון: פתחו בספארי ← שיתוף ← ״הוסף למסך הבית״, ונסו שוב מהאייקון.' : ''}
    </p>`;
  } else if (state === 'denied') {
    body = html`<p class="me-push__text">ההתראות חסומות בדפדפן 🔒 אפשר לשחרר אותן בהגדרות האתר ולנסות שוב.</p>`;
  } else if (state === 'on') {
    body = html`<div class="me-push__row">
      <p class="me-push__text"><strong>✅ המכשיר הזה מקבל התראות</strong></p>
      <${Button} variant="ghost" size="sm" loading=${busy} onClick=${disable}>כיבוי</${Button}>
    </div>`;
  } else if (state === 'granted' && !pushCapable()) {
    body = html`<p class="me-push__text"><strong>✅ ההרשאה ניתנה.</strong> התראות לטלפון יגיעו בקרוב 🚀 — בינתיים כל העדכונים מחכים לכם במסך ההודעות.</p>`;
  } else {
    body = html`<div class="stack-sm">
      <p class="me-push__text">כדי לקבל עדכונים גם כשהאפליקציה סגורה.</p>
      <${Button} variant="primary" icon="bell" block loading=${busy} onClick=${enable}>הפעל התראות למכשיר הזה</${Button}>
    </div>`;
  }

  return html`<div class=${cx('me-push', `me-push--${state}`)}>
    <h3 class="me-sub__title">📱 המכשיר הזה</h3>
    ${body}
  </div>`;
}

// ---------------------------------------------------------------------------
// another device / partner
// ---------------------------------------------------------------------------

function DeviceLinkCard({ me, trip }) {
  const [code, setCode] = useState(null);
  const [busy, setBusy] = useState(false);
  const url = code ? deviceLinkUrl(appBase(), code) : '';
  const name = displayName(me);
  const couple = (Number(me.headcount) || 1) >= 2;
  const text = `🔗 הקישור לפרופיל ${couple ? 'שלנו' : 'שלי'} (${name}) ב${trip.emoji || '⛺'} ${trip.name}\nפותחים בטלפון — וזהו, מחוברים לאותו פרופיל 🔥\n👈 ${url}`;

  const make = async () => {
    setBusy(true);
    const c = await actions.run((api) => api.getDeviceCode(me.id), { refresh: false });
    setBusy(false);
    if (c) setCode(c);
  };

  return html`<${Card} emoji="📱" title="חיבור מכשיר נוסף / בן-בת זוג" class="me-device">
    <p class="muted small me-card__lead">
      ${couple
        ? 'רוצים שגם בן/בת הזוג יסמנו מה מביאים מהטלפון שלהם? שלחו להם את הקישור — הוא מחבר לאותו פרופיל בדיוק.'
        : 'נכנסים גם מהמחשב או מטלפון נוסף? הקישור מחבר את המכשיר לאותו פרופיל בדיוק.'}
    </p>
    ${code
      ? html`<div class="stack-sm">
          <div class="me-linkbox" title=${url}><bdi dir="ltr">${url.replace(/^https?:\/\//, '')}</bdi></div>
          <div class="me-linkbox__actions">
            <${ShareButton} text=${text} label="שליחה בוואטסאפ" />
            <${CopyButton} text=${url} label="העתקה" />
          </div>
          <p class="tiny muted">🔒 הקישור נותן גישה לפרופיל שלכם — שלחו רק למי שסומכים עליו/ה.</p>
        </div>`
      : html`<${Button} variant="secondary" icon="link" block loading=${busy} onClick=${make}>יצירת קישור חיבור</${Button}>`}
  </${Card}>`;
}

// ---------------------------------------------------------------------------
// theme, trips, demo, leave
// ---------------------------------------------------------------------------

function ThemeCard() {
  const theme = useStore((s) => s.theme);
  return html`<${Card} emoji="🎨" title="מראה" class="me-theme">
    <${Segmented}
      label="ערכת צבעים"
      value=${theme}
      onChange=${(t) => actions.setTheme(t)}
      options=${[
        { value: 'auto', label: '🌗 אוטומטי' },
        { value: 'light', label: '☀️ בהיר' },
        { value: 'dark', label: '🌙 כהה' },
      ]}
    />
  </${Card}>`;
}

function TripsCard({ tripId }) {
  const trips = useStore((s) => s.trips) || [];
  useEffect(() => {
    actions.loadTrips();
  }, []);
  return html`<${Card} emoji="🗺️" title="הטיולים שלי" class="me-trips">
    ${trips.length
      ? html`<div class="me-trips__list">
          ${trips.map(({ trip, member }) => {
            const current = trip.id === tripId;
            const manages = member?.role === 'owner' || member?.role === 'admin';
            return html`<div key=${trip.id} class=${cx('me-trip-row', current && 'is-current')}>
              <a class="me-trip" href=${`#/t/${trip.id}`} aria-current=${current ? 'page' : undefined}>
                <span class="me-trip__emoji" aria-hidden="true">${trip.emoji || '⛺'}</span>
                <span class="me-trip__main">
                  <span class="me-trip__name">${trip.name}</span>
                  <span class="me-trip__date">${trip.starts_at ? formatDate(trip.starts_at) : 'בלי תאריך עדיין'}</span>
                </span>
                ${current ? html`<${Pill} tone="success">כאן עכשיו</${Pill}>` : html`<${Icon} name="chevron-left" size=${18} />`}
              </a>
              ${manages
                ? html`<a class="icon-btn me-trip__edit" href=${`#/t/${trip.id}/trip?edit=1`} aria-label=${`עריכה או מחיקה של ${trip.name}`}>
                    <${Icon} name="edit" size=${18} />
                  </a>`
                : null}
            </div>`;
          })}
        </div>`
      : null}
    <div class="me-trips__actions">
      <${Button} variant="secondary" size="sm" icon="plus" href="#/new">טיול חדש</${Button}>
      <${Button} variant="ghost" size="sm" icon="link" href="#/?link=1">יש לי קישור</${Button}>
    </div>
  </${Card}>`;
}

function DemoCard({ snap, me }) {
  const mode = useStore((s) => s.mode);
  const [busy, setBusy] = useState(null);
  if (mode !== 'demo') return null;
  const others = snap.members.filter((m) => m.id !== me.id);
  const become = async (m) => {
    setBusy(m.id);
    await actions.run(ok((api) => api.demo.actAs(m.id)), { success: `עכשיו את/ה ${displayName(m)} 🎭` });
    setBusy(null);
  };
  return html`<${Card} emoji="🎭" title="החלף משתמש" class="me-demo">
    <p class="muted small me-card__lead">רק במצב הדגמה: ראו את מדורה בעיניים של חבר/ה אחר/ת.</p>
    <div class="me-demo__list">
      ${others.map((m) => html`<button
        type="button"
        key=${m.id}
        class="me-demo__opt"
        disabled=${Boolean(busy)}
        aria-busy=${busy === m.id ? 'true' : undefined}
        onClick=${() => become(m)}
      >
        <${Avatar} member=${m} size=${34} />
        <span class="me-demo__name">${displayName(m)}</span>
        <span class="me-demo__role">${m.role === 'owner' ? '👑 יוצר/ת' : m.role === 'admin' ? '👑 מנהל/ת' : !m.claimed ? '⏳ לא נכנס/ה' : 'חבר/ה'}</span>
      </button>`)}
    </div>
  </${Card}>`;
}

function LeaveCard({ snap, me, admin, tripId }) {
  const [busy, setBusy] = useState(false);
  const onlyAdmin = admin && !snap.members.some((m) => m.id !== me.id && memberIsAdmin(m));
  const leave = async () => {
    const yes = await confirmDialog({
      title: 'לצאת מהטיול?',
      text: 'המכשיר הזה יתנתק מהפרופיל. הפריטים וההתחשבנות נשארים — ואפשר לחזור בכל רגע עם קישור ההזמנה.',
      confirmText: 'יציאה',
      danger: true,
    });
    if (!yes) return;
    setBusy(true);
    const done = await actions.run(ok((api) => api.leaveTrip(tripId)), { success: 'יצאת מהטיול 👋', refresh: false });
    if (!done) {
      setBusy(false);
      return;
    }
    await actions.loadTrips();
    navigate('/', { replace: true });
  };
  return html`<div class="me-leave">
    ${onlyAdmin
      ? html`<p class="tiny muted">את/ה המנהל/ת היחיד/ה — כדי לצאת, קודם מנו מנהל/ת נוסף/ת במסך החבר'ה.</p>`
      : null}
    <${Button} variant="ghost" icon="logout" class="me-leave__btn" loading=${busy} onClick=${leave}>יציאה מהטיול</${Button}>
  </div>`;
}
