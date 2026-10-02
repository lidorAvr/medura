// Me (SPEC §8.10): my profile (single / couple), what I have at home, food preferences,
// notification + reminder preferences (saved in members.prefs), this device's notifications,
// theme, linking another device / partner, my trips, leaving the trip and the demo-only
// "🎭 החלף משתמש" switcher.
// Also exports `ProfileForm`, reused by the People screen for "הוסף פרופיל לחבר/ה".
import { html } from 'htm/preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { useTrip, useStore, actions, emailRequired, store } from '../store.js?v=56bbb9a';
import { cleanPhone } from '../ui/account.js?v=56bbb9a';
import { navigate } from '../router.js?v=56bbb9a';
import {
  Avatar, Button, Card, Chip, ColorPicker, CopyButton, EmojiPicker, Field, Pill, Segmented, Sheet,
  ShareButton, Skeleton, Stepper, TextArea, TextInput, Toggle, confirmDialog, Fold,
} from '../ui/components.js?v=56bbb9a';
import { Icon } from '../ui/icons.js?v=56bbb9a';
import { CoupleCard } from '../ui/couple.js?v=56bbb9a';
import { disablePush, enablePush, pushState } from '../lib/device.js?v=56bbb9a';
import { arrivalOf, resolveType } from '../lib/templates.js?v=56bbb9a';
import { adminPersons, deviceLinkUrl, displayName, formatMoney, payingMembers, personsOf, whatsappChatUrl } from '../lib/logic.js?v=56bbb9a';

const cx = (...a) => a.filter(Boolean).join(' ');

let seq = 0;
const useFormId = (prefix) => useState(() => `${prefix}-${++seq}`)[0];

const appBase = () => `${location.origin}${location.pathname}`;

const PALETTE = ['⛺', '🔥', '🌲', '🦊', '🐻', '🦉', '🦔', '🐢', '🦎', '🌙', '⭐', '🍉', '🥩', '🍺', '🎸', '🏕️', '🌈', '🐬', '🦄', '🌵'];
const COLORS = ['#2F6B4F', '#F28C28', '#E4572E', '#3A86FF', '#8E44AD', '#16A085', '#D4A017', '#C0392B', '#2C3E50', '#FF6B9A'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Stored inventory values stay plain (the lists screen matches them to item titles). */
export const INVENTORY_SUGGESTIONS = [
  ['מנגל', '🔥'], ['נפנף', '💨'], ['גזיבו', '⛱️'], ['רמקול', '🔊'], ['מחצלת', '🧺'], ['כסאות ים', '🪑'],
  ['צידנית', '🧊'], ['פקל קפה', '☕'], ['גזייה', '🍳'], ['פנס/תאורה', '🔦'], ['מטקות', '🏓'], ['כדור', '⚽'],
  ['שש בש', '🎲'], ['קלפים', '🃏'], ['אוהל גדול', '⛺'], ['שולחן מתקפל', '🍽️'],
];
const SUGGESTED = new Set(INVENTORY_SUGGESTIONS.map(([name]) => name));

export const DIET_CHIPS = ['🥦 צמחוני/ת', '🌱 טבעוני/ת', '🌾 בלי גלוטן', '🥛 בלי לקטוז', '✡️ כשר', '🌶️ אוהב/ת חריף', '🚱 בלי אלכוהול'];

const NOTIFY_KEYS = [
  ['announcements', '📣 הודעות מהמנהלים', 'עדכונים חשובים לכל הקבוצה'],
  ['assignments', '🙋 שיבוצים והצעות', 'כששיבצו אותך או כשהצעה שלך אושרה'],
  ['money', '💸 כסף והעברות', 'כשמישהו סימן שהעביר לך, או אישר שקיבל'],
  ['reminders', '⏰ תזכורות', 'תזכורות חכמות לפני ואחרי הטיול'],
  ['flights', '✈️ עדכוני טיסות', 'עיכוב, ביטול, שער או טרמינל שהשתנו'],
];

/** The flights toggle shows only in a trip that flies: flights on, a flight booking, or a trip abroad. */
export function tripFlies(trip) {
  if (!trip) return false;
  if (arrivalOf(trip).flights) return true;
  if ((trip.info?.bookings || []).some((b) => b && b.kind === 'flight')) return true;
  return resolveType(trip.settings || {}).where === 'abroad';
}
const REMINDER_KEYS = [
  ['morning_gaps', '☀️ בוקר — מה עוד פתוח אצלך', 'שורה או שתיים בסיכום של 09:30, רק כשחסר משהו'],
  ['pack_evening_before', '🎒 לפני היציאה — לארוז / לקנות', 'יום לפני ב-12:00 וב-19:00, ושעה לפני שיוצאים — רק מה שעוד לא סומן'],
  ['task_due', '⏰ הגיע הזמן למשימה', 'כשמגיע המועד של משימה שלקחת'],
  ['nudge', '🔔 תזכורת עדינה מהמארגנים', 'כשמנהל/ת מזכיר/ה מה עוד חסר אצלך (פעם ביום לכל היותר)'],
  ['unclaimed', '🙋 מה שאף אחד לא לקח (מנהלים)', 'יום לפני ב-12:00 וב-19:00, ובבוקר היציאה — רק אם יש כאלה'],
  ['expense_missing', '🧾 לרשום הוצאה על הקניות', 'בערב שלפני היציאה, אם יש לך קניות ועוד לא רשמת הוצאה (מנהלים: מי עוד לא)'],
  ['departure_morning', '🚗 בוקר היציאה', 'מה לא לשכוח לפני שיוצאים'],
  ['pay_after_trip', '💸 אחרי הטיול — להתחשבן', 'למי להעביר וכמה'],
];

const DEFAULT_QUIET = { from: '22:30', to: '07:00' };

function normalizePrefs(p) {
  const prefs = p && typeof p === 'object' ? p : {};
  const notify = prefs.notify && typeof prefs.notify === 'object' ? prefs.notify : {};
  const reminders = prefs.reminders && typeof prefs.reminders === 'object' ? prefs.reminders : {};
  const qh = prefs.quiet_hours;
  return {
    notify: Object.fromEntries(NOTIFY_KEYS.map(([k]) => [k, notify[k] !== false])),
    reminders: Object.fromEntries(REMINDER_KEYS.map(([k]) => [k, reminders[k] !== false])),
    // never set (no key) → the server's default 22:30–07:00 applies (deliver lib.ts); null = switched off
    quiet_hours: !('quiet_hours' in prefs) ? { ...DEFAULT_QUIET }
      : qh && typeof qh === 'object' && qh.from && qh.to ? { from: qh.from, to: qh.to } : null,
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
  // ux ME1: me → notifications (push first) → home gear / food → mail, partner & device, look → leave.
  // "הטיולים שלי" lives on the dashboard (the home button), not here.
  return html`<div class="screen me-screen">
    <${ProfileCard} me=${me} role=${snap.me?.role || me.role} snap=${snap} />
    <${CoupleCard} snap=${snap} me=${me} onEdit=${() => document.querySelector('.me-hero__edit')?.click()} />
    <${NotifyCard} me=${me} tripId=${tripId} trip=${snap.trip} admin=${admin} />
    <${InventoryCard} me=${me} />
    <${DietCard} me=${me} />
    <${AccountCard} />
    <${EmailCard} me=${me} />
    <${Fold} emoji="👫" title="בן/בת זוג ומכשיר נוסף" class="me-fold me-partner" data-testid="me-partner">
      <${TogetherCard} me=${me} trip=${snap.trip} />
      <${DeviceLinkCard} me=${me} trip=${snap.trip} />
    </${Fold}>
    <${ThemeCard} />
    <${DemoCard} snap=${snap} me=${me} />
    <p class="me-links small">
      <a class="link" href=${`#/t/${tripId}/welcome`}>📝 פרטי קשר והגעה</a>
      <span aria-hidden="true"> · </span>
      <button type="button" class="link" onClick=${() => window.dispatchEvent(new Event('medura:tour'))}>🎓 מדריך קצר</button>
    </p>
    <${LeaveCard} snap=${snap} me=${me} admin=${admin} tripId=${tripId} />
  </div>`;
}

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------

/** `role` is this device's own role (a couple's partner who wasn't crowned is a member). */
function ProfileCard({ me, role, snap }) {
  const [open, setOpen] = useState(false);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const formId = useFormId('me-profile');
  const heads = Number(me.headcount) || 1;
  const people = (me.people || []).filter(Boolean);
  const peopleLine = people.length > 1 && joinNames(people[0], people[1]) !== me.display_name ? people.join(' · ') : null;
  const kind = heads > 2 ? `👨‍👩‍👧 ${heads} אנשים` : heads === 2 ? '👫 זוג' : '🧍 יחיד/ה';
  const roleLabel = role === 'owner' ? '👑 יוצר/ת הטיול' : role === 'admin' ? '👑 מנהל/ת' : null;

  const save = async (patch) => {
    // more / fewer of us moves everyone's split once there are expenses — say it before, not after
    const next = Number(patch?.headcount) || heads;
    const shared = (snap?.expenses || []).filter((e) => e.split_mode === 'all');
    if (next !== heads && shared.length) {
      const payers = payingMembers(snap);
      const all = payers.reduce((n, m) => n + (Number(m.headcount) || 1), 0);
      const spent = shared.reduce((n, e) => n + Number(e.amount || 0), 0);
      const after = all + (payers.some((m) => m.id === me.id) ? next - heads : 0);
      const mineNow = all ? (spent * heads) / all : 0;
      const mineAfter = after ? (spent * next) / after : 0;
      const yes = await confirmDialog({
        title: `${next > heads ? 'מוסיפים' : 'מורידים'} אנשים בפרופיל?`,
        text: `זה משנה את החלוקה של ההוצאות לכולם: החלק שלכם ${formatMoney(mineNow)} ← ${formatMoney(mineAfter)}. המנהלים יקבלו הודעה.`,
        confirmText: 'כן, לעדכן',
      });
      if (!yes) return;
    }
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
      <${ProfileForm} key=${`${me.id}-${round}`} id=${formId} initial=${me} allowFamily onSubmit=${save} />
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

function NotifyCard({ me, tripId, trip, admin }) {
  const flies = tripFlies(trip);
  const [prefs, setPrefs, pending] = useSynced(normalizePrefs(me.prefs));
  const [status, setStatus] = useState('idle');
  const timer = useRef(0);
  const queue = useRef(Promise.resolve());
  useEffect(() => () => clearTimeout(timer.current), []);

  const save = async (patch) => {
    setPrefs({ ...prefs, ...patch });
    pending.current++;
    setStatus('saving');
    clearTimeout(timer.current);
    // one save at a time, in order: two quick changes (quiet hours on → a new end time) must not land reversed
    const run = queue.current.then(() => actions.run(ok((api) => api.updateMember(me.id, { prefs: patch }))));
    queue.current = run.catch(() => {});
    const done = await run;
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

  const on = NOTIFY_KEYS.filter(([k]) => (k !== 'flights' || flies) && prefs.notify[k]).length;
  // push for this device first (ux ME1); what to get sits one tap away
  return html`<${Card} emoji="🔔" title="התראות ותזכורות" class="me-notify" action=${statusNode}>
    <${PushBlock} tripId=${tripId} />
    <${Fold} title="מה מקבלים" meta=${on ? `${on} מופעלות` : 'הכול כבוי'} class="me-notify__more" data-testid="notify-more">
    <div class="me-toggles">
      ${NOTIFY_KEYS.filter(([k]) => k !== 'flights' || flies).map(([k, label, hint]) => html`<${Toggle}
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
            ${REMINDER_KEYS.filter(([k]) => admin || k !== 'unclaimed').map(([k, label, hint]) => html`<${Toggle}
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
        onChange=${(v) => save({ quiet_hours: v ? { ...DEFAULT_QUIET } : null })}
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
    </${Fold}>
  </${Card}>`;
}

/** "הפעל התראות למכשיר הזה" — see js/lib/device.js. */
function PushBlock({ tripId }) {
  const [state, setState] = useState('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    pushState().then((s) => alive && setState(s)).catch(() => alive && setState('unsupported'));
    return () => { alive = false; };
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      const s = await enablePush((json) => actions.run(ok((api) => api.savePushSubscription(tripId, json)), {
        success: 'ההתראות הופעלו במכשיר הזה 🔔', refresh: false,
      }));
      setState(s);
      if (s === 'denied') actions.toast('ההתראות נחסמו — אפשר לשחרר בהגדרות האתר 🔒', 'info');
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
      setState(await disablePush((endpoint) => actions.run((api) => api.deletePushSubscription(endpoint), {
        success: 'ההתראות כובו במכשיר הזה 🔕', refresh: false,
      })));
    } catch (err) {
      console.warn('[medura] disabling push failed', err);
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (state === 'loading') {
    body = null;
  } else if (state === 'ios-install') {
    body = html`<p class="me-push__text">באייפון התראות עובדות רק מהאפליקציה שעל מסך הבית: בספארי ← <b>שיתוף ⬆️</b> ← <b>״הוספה למסך הבית״</b>, ואז פותחים מהאייקון ומפעילים כאן.</p>`;
  } else if (state === 'unsupported') {
    body = html`<p class="me-push__text">הדפדפן הזה לא תומך בהתראות — העדכונים יגיעו אליך במייל ובמסך ההודעות.</p>`;
  } else if (state === 'denied') {
    body = html`<p class="me-push__text">ההתראות חסומות בדפדפן 🔒 אפשר לשחרר אותן בהגדרות האתר ולנסות שוב.</p>`;
  } else if (state === 'on') {
    body = html`<div class="stack-sm">
      <div class="me-push__row">
        <p class="me-push__text"><strong>✅ המכשיר הזה מקבל התראות</strong></p>
        <${Button} variant="ghost" size="sm" loading=${busy} onClick=${disable}>כיבוי</${Button}>
      </div>
      <${Button} variant="secondary" size="sm" onClick=${() => actions.run(ok((api) => api.sendTestNotification(tripId)), { success: 'נשלחה — היא תקפוץ תוך כמה שניות 📨' })}>
        📨 שליחת התראת בדיקה לעצמי
      </${Button}>
    </div>`;
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
  const label = { auto: 'אוטומטי', light: 'בהיר', dark: 'כהה' }[theme] || 'אוטומטי';
  return html`<${Fold} emoji="🎨" title="מראה" meta=${label} class="me-fold me-theme">
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
  </${Fold}>`;
}

// ---------------------------------------------------------------------------
// e-mail updates: my verified address + the other people of my profile
// ---------------------------------------------------------------------------

const MAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s.]{2,}$/;

/** "החשבון שלי": the person (by verified e-mail) — one name and phone for all their trips, and what the
 *  trip's people may see: "🟢 מחובר/ת עכשיו" (prefs.presence) and my phone (prefs.share_phone). */
function AccountCard() {
  const acc = useStore((s) => s.account);
  const verified = useStore((s) => Boolean(s.contact?.verified));
  useEffect(() => {
    actions.loadAccount({ force: true });
  }, [verified]);
  if (!acc?.verified) return null;
  return html`<${AccountForm} key=${acc.email} acc=${acc} />`;
}

export function AccountForm({ acc }) {
  const [name, setName] = useState(acc.name || '');
  const [phone, setPhone] = useState(acc.phone || '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('idle');
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const prefs = acc.prefs || {};
  const dirty = name.trim() !== (acc.name || '') || phone.trim() !== (acc.phone || '');
  const save = async (e) => {
    e?.preventDefault();
    if (!name.trim()) return;
    if (phone.trim() && !cleanPhone(phone)) {
      actions.toast('הטלפון לא נראה תקין — רק ספרות, רווחים ומקפים', 'error');
      return;
    }
    setBusy(true);
    const res = await actions.run((api) => api.saveAccount({ name: name.trim(), phone: cleanPhone(phone) }),
      { success: 'הפרטים שלך נשמרו ✅' });
    setBusy(false);
    if (res) actions.setAccount(res);
  };
  // a switch saves at once (the trip is refreshed, so the People screen shows it right away); quick taps on
  // both switches: each shows at once, and the server's answer lands only after the last one
  const pending = useRef({ n: 0, server: acc });
  const setPref = async (key, on) => {
    const cur = store.get().account || acc;
    if (!pending.current.n) pending.current.server = cur;
    pending.current.n++;
    actions.setAccount({ ...cur, prefs: { ...(cur.prefs || {}), [key]: on } });
    setStatus('saving');
    clearTimeout(timer.current);
    if (key === 'presence') actions.resetPresence(); // back on → "I'm here" again with the next refresh
    const res = await actions.run((api) => api.saveAccount({ prefs: { [key]: on } }));
    if (res) pending.current.server = res;
    if (--pending.current.n) return;
    actions.setAccount(pending.current.server);
    setStatus(res ? 'saved' : 'idle');
    if (res) timer.current = setTimeout(() => setStatus('idle'), 2200);
  };
  const statusNode = status === 'saving'
    ? html`<span class="me-saved is-saving" aria-live="polite">שומר…</span>`
    : status === 'saved'
      ? html`<span class="me-saved" aria-live="polite"><${Icon} name="check" size=${14} /> נשמר</span>`
      : html`<span class="me-saved" aria-live="polite"></span>`;
  const seen = prefs.presence !== false;
  const phoneShown = prefs.share_phone !== false;
  const invitable = prefs.invitable !== false;
  return html`<${Card} emoji="🙂" title="החשבון שלי" class="me-account" data-testid="account-card" action=${statusNode}>
    <p class="muted small me-card__lead">פעם אחת לכל הטיולים · <bdi dir="ltr">${acc.email}</bdi> ✅</p>
    <form class="stack" onSubmit=${save} noValidate>
      <div class="grid-2">
        <${Field} label="השם שלי"><${TextInput} value=${name} maxlength="40" onInput=${(e) => setName(e.target.value)} /></${Field}>
        <${Field} label="טלפון"><${TextInput} type="tel" dir="ltr" value=${phone} maxlength="20" placeholder="050-1234567" onInput=${(e) => setPhone(e.target.value)} /></${Field}>
      </div>
      ${dirty ? html`<${Button} type="submit" size="sm" loading=${busy}>שמירה</${Button}>` : null}
    </form>
    <div class="me-sub">
      <h3 class="me-sub__title">מה החבר'ה בטיול רואים</h3>
      <div class="me-toggles">
        <${Toggle}
          checked=${seen}
          label="🟢 מתי אני מחובר/ת"
          hint=${seen ? '״מחובר/ת עכשיו״ או ״נראה/תה לפני…״ — רק מי שבטיול, ובדיוק של דקה' : 'כבוי — אף אחד לא רואה מתי נכנסת'}
          onChange=${(v) => setPref('presence', v)}
        />
        <${Toggle}
          checked=${phoneShown}
          label="📞 הטלפון שלי"
          hint=${phoneShown ? 'כדי שיוכלו לשלוח לך וואטסאפ או להתקשר ממסך החבר׳ה' : 'כבוי — המספר שלך לא מוצג ליד השם שלך'}
          onChange=${(v) => setPref('share_phone', v)}
        />
      </div>
    </div>
    <div class="me-sub">
      <h3 class="me-sub__title">טיולים הבאים</h3>
      <div class="me-toggles">
        <${Toggle}
          checked=${invitable}
          label="📨 אפשר להזמין אותי מטיולים קודמים"
          hint=${invitable ? 'מי שהיה איתך בטיול ומנהל/ת טיול חדש יכול/ה להזמין אותך בלחיצה — ואת/ה מאשר/ת' : 'כבוי — לא תופיע/י ברשימת ״➕ מטיולים קודמים״'}
          onChange=${(v) => setPref('invitable', v)}
        />
      </div>
    </div>
  </${Card}>`;
}

function EmailCard({ me }) {
  const contact = useStore((s) => s.contact);
  const required = useStore((s) => emailRequired(s));
  const people = me.people && me.people.length ? me.people : [displayName(me)];
  const [list, setList] = useState(null);
  const [draft, setDraft] = useState([]);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    actions.run((api) => api.getMemberEmails(me.id), { refresh: false, error: () => 'לא הצלחנו לטעון את המיילים' })
      .then((r) => {
        if (!alive || !r) return;
        setList(r);
        setDraft(Array.from({ length: Math.max(people.length, r.length) }, (_, i) => r[i] || ''));
      });
    return () => { alive = false; };
  }, [me.id, people.length]);

  const clean = (d) => [...new Set(d.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const dirty = list && clean(draft).join('|') !== list.join('|');
  const save = async () => {
    const errs = {};
    draft.forEach((m, i) => { if (m.trim() && !MAIL_RE.test(m.trim())) errs[i] = 'המייל לא נראה תקין'; });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    const emails = clean(draft);
    const done = await actions.run(ok((api) => api.setMemberEmails(me.id, emails)), { success: 'נשמר ✉️' });
    setSaving(false);
    if (done) setList(emails);
  };

  return html`<${Card} emoji="📬" title="עדכונים במייל" class="me-email">
    <p class="muted small me-card__lead">עדכונים ותזכורות מהטיול יגיעו גם לכאן. בכל מייל יש קישור להסרה.</p>
    ${contact?.verified
      ? html`<p class="me-email__mine">מאומת במכשיר הזה: <bdi dir="ltr">${contact.email}</bdi> <${Pill} tone="success">✓</${Pill}>
          ${required ? html`<${Button} variant="ghost" size="sm" onClick=${() => actions.setContact({ ...contact, verified: false })}>שינוי</${Button}>` : null}</p>`
      : null}
    <div class="me-email__others">
      ${draft.map((m, i) => html`<${Field} key=${i} label=${people.length === 1 && i === 0 ? 'המייל שלך' : `המייל של ${people[i] || `משתתף/ת ${i + 1}`}`} error=${errors[i]}>
        <${TextInput} type="email" inputmode="email" dir="ltr" autocomplete="off" value=${m} placeholder="name@example.com"
          onInput=${(e) => { const v = e.target.value; setDraft((d) => d.map((x, j) => (j === i ? v : x))); }} />
      </${Field}>`)}
      ${dirty ? html`<${Button} size="sm" icon="check" loading=${saving} onClick=${save}>שמירה</${Button}>` : null}
    </div>
  </${Card}>`;
}
// ---------------------------------------------------------------------------
// who's in my profile + inviting a partner / joining another profile
// ---------------------------------------------------------------------------

function TogetherCard({ me, trip }) {
  const people = me.people && me.people.length ? me.people : [displayName(me)];
  const url = `${location.origin}${location.pathname}#/join/${trip.invite_code}`;
  const text = `הצטרפ/י אליי במדורה 🔥 לטיול ״${trip.name}״:\n${url}\nבקישור לוחצים על ״${displayName(me)}״ ← ״גם אני בפרופיל הזה״ — ואני מאשר/ת.`;
  return html`<${Card} emoji="🤝" title="מי בפרופיל" class="me-together">
    <p class="muted small me-card__lead">כל אחד בפרופיל יכול להתחבר מהטלפון שלו — עם המייל שלו — ולקבל התראות משלו.</p>
    <div class="me-together__people">${people.map((p) => html`<span class="me-together__person" key=${p}>🙂 ${p}</span>`)}</div>
    <div class="me-together__actions">
      <${ShareButton} text=${text} label="הזמנת בן/בת הזוג בוואטסאפ" />
      <${Button} variant="ghost" size="sm" href=${`#/join/${trip.invite_code}?switch=1`}>אנחנו בעצם בפרופיל של מישהו אחר ←</${Button}>
    </div>
  </${Card}>`;
}

function DemoCard({ snap, me }) {
  const mode = useStore((s) => s.mode);
  const [busy, setBusy] = useState(null);
  if (mode !== 'demo') return null;
  // one option per person (a couple is two people, each with their own rights), except the one I am now
  const options = snap.members.flatMap((m) => {
    const persons = personsOf(m);
    const many = persons.length > 1;
    return persons
      .filter((p) => !(m.id === me.id && (!many || p.name === snap.me?.person)))
      .map((p) => ({ m, p, key: `${m.id}:${p.name}`, name: many ? p.name : displayName(m), sub: many ? displayName(m) : null }));
  });
  const become = async (o) => {
    setBusy(o.key);
    const person = (o.m.people || []).includes(o.p.name) ? o.p.name : null;
    await actions.run(ok((api) => api.demo.actAs(o.m.id, person)), { success: `עכשיו את/ה ${o.name} 🎭` });
    setBusy(null);
  };
  const label = ({ m, p }) => (p.admin ? (m.role === 'owner' ? '👑 יוצר/ת' : '👑 מנהל/ת')
    : !m.claimed ? '⏳ לא נכנס/ה' : !p.joined ? 'עוד לא נכנס/ה' : 'חבר/ה');
  return html`<${Card} emoji="🎭" title="החלף משתמש" class="me-demo">
    <p class="muted small me-card__lead">רק במצב הדגמה: ראו את מדורה בעיניים של חבר/ה אחר/ת.</p>
    <div class="me-demo__list">
      ${options.map((o) => html`<button
        type="button"
        key=${o.key}
        class="me-demo__opt"
        disabled=${Boolean(busy)}
        aria-busy=${busy === o.key ? 'true' : undefined}
        onClick=${() => become(o)}
      >
        <${Avatar} member=${o.m} size=${34} />
        <span class="me-demo__name">${o.name}${o.sub ? html`<span class="me-demo__sub"> · ${o.sub}</span>` : null}</span>
        <span class="me-demo__role">${label(o)}</span>
      </button>`)}
    </div>
  </${Card}>`;
}

function LeaveCard({ snap, me, admin, tripId }) {
  const [busy, setBusy] = useState(false);
  // the only one with admin rights? (per person — a crowned partner in my own profile is another admin)
  const mine = (a) => a.member.id === me.id && (a.person ? a.person.name === snap.me?.person || a.person.mine : !snap.me?.person);
  const onlyAdmin = admin && adminPersons(snap).every(mine);
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
