// Onboarding (SPEC §8.1): landing / new trip / join ("מי אתם?") / link device.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { actions, store, useStore } from '../store.js?v=5ff55d3';
import { navigate, href } from '../router.js?v=5ff55d3';
import { flightErrorText, hebrewError, toApiError } from '../api/errors.js?v=5ff55d3';
import {
  buildInviteText, countdown, displayName, formatDate, formatTime, hebrewCount, inviteUrl, isAdmin,
} from '../lib/logic.js?v=5ff55d3';
import {
  Avatar, Button, Card, ColorPicker, CopyButton, EmojiPicker, EmptyState, Field, Pill, ShareButton, Skeleton, TextInput,
  confirmDialog, fireConfetti,
} from '../ui/components.js?v=5ff55d3';
import { Icon } from '../ui/icons.js?v=5ff55d3';
import { EmailGate, linkThisDevice } from '../ui/email-gate.js?v=5ff55d3';
import { Entry, cleanPhone } from '../ui/account.js?v=5ff55d3';
import {
  AIRPORTS, FAMILIES, MODULES, composeType, focusPacksFor, hasLists, itemTypeOn, packSeed, tripSeed, typeModules, wizardCopy,
} from '../lib/templates.js?v=5ff55d3';
import { ListEditor, PackPicker, applyPack, countOf, fromSeed, toSeed } from '../ui/list-editor.js?v=5ff55d3';
import { PlaceInput } from '../ui/place-input.js?v=5ff55d3';
import { flightFit, hmOf } from '../lib/flights.js?v=5ff55d3';

const cx = (...a) => a.filter(Boolean).join(' ');
const PROFILE_EMOJIS = ['⛺', '🔥', '🌲', '🦊', '🐻', '🦉', '🦔', '🐢', '🦎', '🌙', '⭐', '🍉', '🥩', '🍺', '🎸', '🏕️', '🌈', '🐬', '🦄', '🌵'];
const COLORS = ['#2F6B4F', '#F28C28', '#E4572E', '#3A86FF', '#8E44AD', '#16A085', '#D4A017', '#C0392B', '#2C3E50', '#FF6B9A'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const baseUrl = () => `${location.origin}${location.pathname}`;

export default function OnboardingScreen({ route }) {
  switch (route.name) {
    case 'join':
      return html`<${Entry} requireVerified code=${route.params.code}><${Join} code=${route.params.code} switchMode=${route.query?.switch === '1'} /></${Entry}>`;
    case 'link':
      return html`<${LinkDevice} code=${route.params.code} />`;
    case 'new':
      return html`<${Entry} requireVerified><${NewTrip} /></${Entry}>`;
    default:
      return html`<${Entry}><${Landing} openCode=${route.query.link === '1'} /></${Entry}>`;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Minutes east of UTC for Asia/Jerusalem at a given instant. */
function jerusalemOffset(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ts));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
  return Math.round((asUtc - ts) / 60000);
}

/** 'YYYY-MM-DD' + 'HH:MM' in Israel time → ISO string (null when no date). */
function jerusalemIso(date, time) {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh || 0, mm || 0);
  let ts = guess - jerusalemOffset(guess) * 60000;
  ts = guess - jerusalemOffset(ts) * 60000; // settle DST edges
  return new Date(ts).toISOString();
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function dateRange(trip) {
  if (!trip?.starts_at) return '';
  const opts = { weekday: 'short', day: 'numeric', month: 'numeric' };
  const start = formatDate(trip.starts_at, opts);
  const end = trip.ends_at ? formatDate(trip.ends_at, opts) : '';
  return end && end !== start ? `${start} – ${end}` : start;
}

/** Accepts a full invite/device link or a bare code. */
function parseInviteInput(text) {
  const t = String(text || '').trim();
  const join = t.match(/#\/join\/([A-Za-z0-9]+)/);
  if (join) return { kind: 'join', code: join[1].toLowerCase() };
  const link = t.match(/#\/link\/([A-Za-z0-9]+)/);
  if (link) return { kind: 'link', code: link[1].toLowerCase() };
  const bare = t.replace(/[\s-]/g, '');
  if (/^[A-Za-z0-9]{4,24}$/.test(bare)) return { kind: 'join', code: bare.toLowerCase() };
  return null;
}

function focusFirstInvalid() {
  requestAnimationFrame(() => {
    const el = document.querySelector('.onb [aria-invalid="true"]');
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
}

// ---------------------------------------------------------------------------
// Illustrated dusk scene (pure SVG; animated in onboarding.css)
// ---------------------------------------------------------------------------

const STARS = [[28, 30, 1.6, 0], [74, 58, 1.1, 1.2], [128, 22, 1.3, 0.6], [180, 64, 1, 2.1], [226, 34, 1.5, 1.6],
  [268, 76, 1, 0.3], [318, 26, 1.4, 2.4], [352, 60, 1.1, 1], [372, 18, 1, 1.8], [150, 90, 0.9, 2.8]];
const SPARKS = [[-4, 0, '-10px'], [3, 0.7, '8px'], [0, 1.4, '-4px'], [6, 2, '12px']];

function Scene() {
  return html`<svg class="scene" viewBox="0 0 390 250" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="sc-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="sc-sky-1" />
        <stop offset="0.5" class="sc-sky-2" />
        <stop offset="0.8" class="sc-sky-3" />
        <stop offset="1" class="sc-sky-4" />
      </linearGradient>
      <radialGradient id="sc-glow">
        <stop offset="0" stop-color="#FFC45C" stop-opacity="0.75" />
        <stop offset="1" stop-color="#FFC45C" stop-opacity="0" />
      </radialGradient>
      <linearGradient id="sc-flame" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#FFB23F" />
        <stop offset="0.6" stop-color="#F9772F" />
        <stop offset="1" stop-color="#E4492B" />
      </linearGradient>
    </defs>
    <rect width="390" height="250" fill="url(#sc-sky)" />
    <g class="sc-stars">
      ${STARS.map(([x, y, r, d]) => html`<circle class="sc-star" cx=${x} cy=${y} r=${r} style=${`animation-delay:${d}s`} />`)}
    </g>
    <circle class="sc-sun" cx="300" cy="186" r="38" />
    <path class="sc-moon" d="M318 44a20 20 0 1 0 14 34 16 16 0 1 1-14-34Z" />
    <path class="sc-hill-far" d="M0 186C62 160 128 158 196 176S320 170 390 156V250H0Z" />
    <g class="sc-pines">
      <path d="M14 182 26 146 38 182Z" /><path d="M32 180 42 154 52 180Z" />
      <path d="M332 170 344 132 356 170Z" /><path d="M352 168 362 142 372 168Z" /><path d="M368 166 377 146 386 166Z" />
    </g>
    <path class="sc-hill-near" d="M0 210C70 194 150 190 232 200S350 210 390 202V250H0Z" />
    <g class="sc-tent">
      <path d="M58 214 104 150 150 214Z" fill="#FFF1DC" />
      <path d="M104 150 150 214 112 214Z" fill="#F2D3A6" />
      <path d="M92 214 104 184 116 214Z" fill="#3A2618" />
      <path d="M104 150 98 141" stroke="#FFF1DC" stroke-width="3" stroke-linecap="round" />
    </g>
    <g class="sc-fire" transform="translate(252 214)">
      <circle class="sc-glow" cx="0" cy="-22" r="62" fill="url(#sc-glow)" />
      <path d="M-24 4 24-5M-24-5 24 4" stroke="#6B3B1F" stroke-width="8" stroke-linecap="round" />
      <g class="sc-flame sc-flame--1">
        <path d="M0-62c7 13 20 21 21 38 1 14-9 26-21 26s-22-10-21-24c0-9 4-14 8-19 1 6 3 9 6 11-2-14 3-22 7-32Z" fill="url(#sc-flame)" />
      </g>
      <g class="sc-flame sc-flame--2">
        <path d="M0-36c5 7 12 12 12 22 0 8-5 14-12 14s-12-6-12-13c0-10 7-15 12-23Z" fill="#FFC94D" />
      </g>
      <g class="sc-flame sc-flame--3">
        <path d="M0-19c3 4 6 6 6 11 0 4-3 7-6 7s-6-3-6-7c0-5 3-7 6-11Z" fill="#FFF6D8" />
      </g>
      ${SPARKS.map(([x, d, dx]) => html`<circle class="sc-spark" cx=${x} cy="-40" r="1.8" style=${`animation-delay:${d}s;--dx:${dx}`} />`)}
    </g>
  </svg>`;
}

export function Hero({ compact, children }) {
  return html`<header class=${cx('onb-hero', compact && 'onb-hero--compact')}>
    <${Scene} />
    <div class="onb-hero__content">${children}</div>
  </header>`;
}

function BackBar({ to = '/', label = 'חזרה', onClick }) {
  return html`<div class="onb-back">
    ${onClick
      ? html`<button type="button" class="icon-btn onb-back__btn" aria-label=${label} onClick=${onClick}><${Icon} name="arrow-right" size=${22} /></button>`
      : html`<a class="icon-btn onb-back__btn" href=${href(to)} aria-label=${label}><${Icon} name="arrow-right" size=${22} /></a>`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

export function TripCard({ entry }) {
  const { trip, member } = entry;
  const cd = trip.starts_at ? countdown(trip.starts_at, new Date(), trip.ends_at) : null;
  const meta = [dateRange(trip), trip.location].filter(Boolean).join(' · ');
  return html`<a class="trip-card" href=${href(`/t/${trip.id}`)}>
    <span class="trip-card__emoji" aria-hidden="true">${trip.emoji || '⛺'}</span>
    <span class="trip-card__main">
      <span class="trip-card__name">${trip.name}</span>
      ${meta ? html`<span class="trip-card__meta">${meta}</span>` : null}
      ${cd?.label ? html`<span class="trip-card__pills"><${Pill} tone=${cd.past ? 'default' : 'accent'}>${cd.label}</${Pill}>
        ${isAdmin(member) ? html`<${Pill} tone="warning">👑 מנהל/ת</${Pill}>` : null}</span>` : null}
    </span>
    <span class="trip-card__end">
      <${Avatar} member=${member} size=${34} />
      <${Icon} name="chevron-left" size=${20} class="trip-card__chev" />
    </span>
  </a>`;
}

export function CodeEntry({ startOpen }) {
  const [open, setOpen] = useState(!!startOpen);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const formRef = useRef(null);
  useEffect(() => {
    if (open) formRef.current?.querySelector('input')?.focus({ preventScroll: !!startOpen });
  }, [open]);
  if (!open) {
    return html`<${Button} variant="secondary" size="lg" block icon="link" onClick=${() => setOpen(true)}>יש לי קישור / קוד</${Button}>`;
  }
  const submit = (e) => {
    e.preventDefault();
    const parsed = parseInviteInput(text);
    if (!parsed) {
      setError('זה לא נראה כמו קישור הזמנה 🤔 נסו להדביק את כל הקישור מהוואטסאפ');
      focusFirstInvalid();
      return;
    }
    navigate(`/${parsed.kind}/${parsed.code}`);
  };
  return html`<form class="code-entry card" ref=${formRef} onSubmit=${submit} noValidate>
    <${Field} label="הדביקו כאן את הקישור או הקוד" hint="קיבלתם קישור בוואטסאפ? אפשר להדביק אותו כמו שהוא" error=${error}>
      <${TextInput}
        value=${text}
        dir="ltr"
        inputmode="url"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder="https://…#/join/abc123"
        onInput=${(e) => {
          setText(e.target.value);
          if (error) setError('');
        }}
      />
    </${Field}>
    <${Button} type="submit" block icon="arrow-left">המשך</${Button}>
  </form>`;
}

function Intro() {
  const rows = [
    ['📋', 'כל הרשימות במקום אחד', 'מי מביא מה, מה חסר ומה כבר נקנה'],
    ['🙋', 'כל אחד מסמן מה הוא מביא', 'בלי "למישהו יש רמקול?" שנבלע בקבוצה'],
    ['💸', 'התחשבנות אוטומטית', 'מוסיפים הוצאות — מדורה מחשבת מי מעביר למי'],
    ['📣', 'עדכונים מהמנהלים', 'הודעות חשובות שלא הולכות לאיבוד'],
  ];
  return html`<div class="card onb-intro">
    <h2 class="onb-intro__title">הבלגן של הוואטסאפ נגמר כאן 🔥</h2>
    <ul class="onb-intro__list">
      ${rows.map(([e, t, s]) => html`<li class="onb-intro__row">
        <span class="kbd-emoji" aria-hidden="true">${e}</span>
        <span><strong>${t}</strong><span class="muted small onb-intro__sub">${s}</span></span>
      </li>`)}
    </ul>
  </div>`;
}

/**
 * The door (ux E6): two equal choices first, "קיבלתי הזמנה" and "אני מארגן/ת טיול", a text link to sign in, and only
 * then what מדורה is.
 */
export function Landing({ openCode }) {
  const trips = useStore((s) => s.trips);
  const has = trips.length > 0;
  const [code, setCode] = useState(!!openCode);
  return html`<div class="onb onb--landing">
    <${Hero} compact=${!has}>
      <div class="onb-brand">
        <h1 class="onb-brand__name">מדורה</h1>
        <p class="onb-brand__tag">כל החבר'ה סביב המדורה</p>
      </div>
    </${Hero}>
    <div class="onb__body">
      ${has
        ? html`<section class="stack" aria-labelledby="my-trips">
            <h2 class="onb__h" id="my-trips">הטיולים שלי <span class="onb__count num">${trips.length}</span></h2>
            ${trips.map((t) => html`<${TripCard} key=${t.trip.id} entry=${t} />`)}
          </section>`
        : null}
      <div class="stack" data-testid="landing-choices">
        ${code
          ? html`<${CodeEntry} startOpen />`
          : html`<${Button} variant="secondary" size="lg" block onClick=${() => setCode(true)}>✉️ קיבלתי הזמנה</${Button}>`}
        <${Button} variant="secondary" size="lg" block href="#/new">🔥 אני מארגן/ת טיול</${Button}>
        <a class="link center" href="#/signin">🔑 כבר הצטרפתי ממכשיר אחר? התחברות עם המייל</a>
      </div>
      ${has ? null : html`<${Intro} />`}
      <p class="onb__foot muted tiny center">עושים סדר בבלגן — כדי שיהיה זמן לשבת ליד המדורה 🌲</p>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Profile form (join + new trip)
// ---------------------------------------------------------------------------

/** "נועה", "נועה ואיתי", "נועה, איתי ויעל". */
function autoName(names) {
  const list = names.map((n) => String(n || '').trim()).filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} ו${list[list.length - 1]}`;
}

const MAX_PEOPLE = 8;
/** The form's one action stays in reach while the page scrolls (ux W3/E3) — no css file of its own needed. */
const STICKY = 'position:sticky;bottom:0;z-index:2;padding:10px 0 calc(10px + env(safe-area-inset-bottom, 0px));'
  + 'margin-bottom:-10px;background:linear-gradient(to bottom, transparent, var(--bg) 14px)';

/**
 * Profile: single or couple by default, "➕ עוד משתתף/ת" for 3+ (up to 8). For everyone but the
 * phone and e-mails are asked right after joining (the welcome wizard). onSubmit receives
 * {display_name, headcount, people, emoji, color}.
 */
function ProfileForm({ initial, submitLabel, busy, onSubmit, children }) {
  const init = initial || {};
  const initPeople = (init.people || []).map((p) => String(p || '').trim()).filter(Boolean);
  const [names, setNames] = useState(() => {
    const h = Math.min(MAX_PEOPLE, Math.max(1, Number(init.headcount) || 1, initPeople.length));
    const list = Array.from({ length: h }, (_, i) => initPeople[i] || '');
    if (!initPeople.length && init.display_name) list[0] = String(init.display_name);
    return list;
  });
  const headcount = names.length;
  const couple = headcount >= 2;
  const auto = autoName(names);
  const [custom, setCustom] = useState(() => {
    const d = String(init.display_name || '').trim();
    return d && d !== autoName(initPeople.length ? initPeople : [d]) ? d : '';
  });
  const [editName, setEditName] = useState(Boolean(custom));
  const display = ((editName && custom.trim()) || auto).trim();
  const [emoji, setEmoji] = useState(init.emoji || pick(PROFILE_EMOJIS));
  const [color, setColor] = useState(init.color || pick(COLORS));
  const [look, setLook] = useState(false); // emoji + colour come random; "שינוי מראה" opens the pickers (ux W3/E3)
  const [errors, setErrors] = useState({});

  const clear = (key) => errors[key] && setErrors({ ...errors, [key]: undefined });
  const resize = (n) => {
    setNames((list) => Array.from({ length: n }, (_, i) => list[i] || ''));
  };
  const setAt = (setter, i, v) => setter((list) => list.map((x, j) => (j === i ? v : x)));
  const removeAt = (i) => {
    setNames((list) => list.filter((_, j) => j !== i));
  };

  const submit = (e) => {
    e.preventDefault();
    const errs = {};
    if (!names[0].trim()) errs.name0 = couple ? 'מה השם הראשון? 🙂' : 'רגע, איך קוראים לך? 🙂';
    if (headcount === 2 && !names[1].trim()) errs.name1 = 'ומה השם של בן/בת הזוג?';
    if (display.length > 40) errs.display = 'עד 40 תווים, בבקשה';
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) {
      focusFirstInvalid();
      return;
    }
    onSubmit({
      display_name: display,
      headcount,
      people: names.map((n) => n.trim()).filter(Boolean),
      emoji,
      color,
    });
  };

  const preview = { display_name: display || (couple ? 'השמות שלכם' : 'השם שלך'), headcount, emoji, color, people: [] };
  const personLabel = (i) => (i === 0 ? (couple ? 'השם שלך' : 'איך קוראים לך?') : headcount === 2 ? 'ושל בן/בת הזוג' : `משתתף/ת ${i + 1}`);

  return html`<form class="profile-form stack-lg" onSubmit=${submit} noValidate>
    ${children}
    <div class="kind-toggle" role="radiogroup" aria-label="מגיעים לבד או בזוג?">
      <button type="button" role="radio" aria-checked=${couple ? 'false' : 'true'} class="kind-opt" onClick=${() => resize(1)}>
        <span class="kind-opt__emoji" aria-hidden="true">🧍</span>
        <span class="kind-opt__label">יחיד/ה</span>
      </button>
      <button type="button" role="radio" aria-checked=${couple ? 'true' : 'false'} class="kind-opt" onClick=${() => resize(Math.max(2, headcount))}>
        <span class="kind-opt__emoji" aria-hidden="true">${headcount > 2 ? '👨‍👩‍👧' : '👫'}</span>
        <span class="kind-opt__label">${headcount > 2 ? `${headcount} ביחד` : 'זוג'}</span>
      </button>
    </div>

    <div class="profile-people" role="group" aria-label="מי מגיע">
      ${names.map((n, i) => html`<div class="profile-person" key=${i}>
        <div class="profile-person__row">
          <${Field} label=${personLabel(i)} error=${errors[`name${i}`]}>
            <${TextInput}
              value=${n}
              maxlength="30"
              autocomplete=${i === 0 ? 'given-name' : 'off'}
              placeholder=${i === 0 ? (couple ? 'למשל: נועה' : 'השם שלך') : i === 1 ? 'למשל: איתי' : 'שם (לא חובה)'}
              onInput=${(e) => {
                setAt(setNames, i, e.target.value);
                clear(`name${i}`);
              }}
            />
          </${Field}>
          ${i >= 2
            ? html`<button type="button" class="icon-btn profile-person__remove" aria-label=${`הסרת משתתף/ת ${i + 1}`} onClick=${() => removeAt(i)}>
                <${Icon} name="x" size=${18} />
              </button>`
            : null}
        </div>
      </div>`)}
      ${couple && headcount < MAX_PEOPLE
        ? html`<button type="button" class="link profile-people__add" onClick=${() => resize(headcount + 1)}>➕ עוד משתתף/ת (ילד/ה, חבר/ה…)</button>`
        : null}
    </div>

    ${editName
      ? html`<${Field} label="שם תצוגה" hint="ככה תופיעו ברשימות ובהתחשבנות" error=${errors.display}>
          <${TextInput}
            value=${custom || auto}
            maxlength="40"
            onInput=${(e) => {
              setCustom(e.target.value);
              clear('display');
            }}
          />
        </${Field}>`
      : couple
        ? html`<button type="button" class="link onb-rename" onClick=${() => {
            setCustom(auto);
            setEditName(true);
          }}>✏️ רוצים שם תצוגה אחר?</button>`
        : null}

    <div class="profile-preview" aria-live="polite">
      <${Avatar} member=${preview} size=${44} />
      <div class="profile-preview__text">
        <div class=${cx('profile-preview__name', !display && 'is-placeholder')}>${preview.display_name}</div>
        <button type="button" class="link small" aria-expanded=${look ? 'true' : 'false'} onClick=${() => setLook(!look)}>
          🎨 ${look ? 'סגירת המראה' : 'שינוי מראה (אימוג׳י וצבע)'}
        </button>
      </div>
    </div>
    ${look
      ? html`<${Field} label="האימוג׳י שלכם">
          <${EmojiPicker} value=${emoji} onChange=${setEmoji} label="האימוג׳י שלכם" />
        </${Field}>
        <${Field} label="הצבע שלכם">
          <${ColorPicker} value=${color} onChange=${setColor} label="הצבע שלכם" />
        </${Field}>`
      : null}

    <div class="profile-form__submit" style=${STICKY}>
      <${Button} type="submit" variant="accent" size="lg" block loading=${busy}>${submitLabel}</${Button}>
    </div>
  </form>`;
}
// ---------------------------------------------------------------------------
// New trip
// ---------------------------------------------------------------------------

function StepDots({ step, labels }) {
  return html`<ol class="steps" aria-label="שלבים">
    ${labels.map((label, i) => {
      const n = i + 1;
      const state = n < step ? 'done' : n === step ? 'current' : 'todo';
      return html`<li class=${cx('steps__item', `is-${state}`)} aria-current=${state === 'current' ? 'step' : undefined}>
        <span class="steps__dot">${state === 'done' ? html`<${Icon} name="check" size=${14} />` : n}</span>
        <span class="steps__label">${label}</span>
      </li>`;
    })}
  </ol>`;
}

function InviteStep({ tripId }) {
  const snap = useStore((s) => (s.tripId === tripId ? s.snap : null));
  const trip = snap?.trip;
  if (!trip) {
    return html`<div class="stack"><${Skeleton} lines=${3} /></div>`;
  }
  const url = inviteUrl(baseUrl(), trip.invite_code);
  const text = buildInviteText(trip, url);
  return html`<div class="stack-lg invite-step">
    <div class="invite-step__hero">
      <div class="invite-step__emoji" aria-hidden="true">🎉</div>
      <h2 class="h1">הטיול מוכן!</h2>
      <p class="muted">עכשיו מזמינים את החבר'ה — שלחו להם את הקישור בקבוצת הוואטסאפ, וכל אחד יבחר את הפרופיל שלו.</p>
    </div>
    <div class="card invite-card" data-invite=${url}>
      <div class="invite-card__head">
        <span class="kbd-emoji" aria-hidden="true">${trip.emoji || '⛺'}</span>
        <div class="invite-card__title">
          <strong>${trip.name}</strong>
          <span class="muted small">קישור ההזמנה מוכן</span>
        </div>
      </div>
      <div class="stack-sm">
        <${ShareButton} text=${text} label="שלחו הזמנה בוואטסאפ" size="lg" block />
        <${CopyButton} text=${url} label="העתקת הקישור" variant="ghost" block />
      </div>
    </div>
    <p class="muted small invite-step__tip">💡 טיפ: אפשר להוסיף מראש פרופילים לחברים במסך חבר'ה — ככה הם רק לוחצים "זה אנחנו!"</p>
    <${Button} variant="ghost" size="lg" block icon="arrow-left" onClick=${() => navigate(`/t/${trip.id}`)}>יאללה, לטיול</${Button}>
  </div>`;
}

/** "מה יש בטיול?" — the type's features, each on/off; what's on comes ready and is followed up. */
function FeaturePicker({ type, modules, onChange }) {
  // what shows up ready (a feature that's off keeps its part hidden until it's switched on)
  const shared = modules.lists ? type.items.filter((x) => x.k !== 'task').length : 0;
  const tasks = modules.tasks ? type.items.filter((x) => x.k === 'task').length : 0;
  const ready = [
    shared ? hebrewCount(shared, 'פריט ברשימות', 'פריטים ברשימות') : null,
    tasks ? hebrewCount(tasks, 'משימה', 'משימות') : null,
    modules.packing ? `רשימת אריזה (${type.packing.length})` : null,
    modules.schedule ? 'לו״ז בלחיצה' : null,
  ].filter(Boolean);
  return html`<div class="features" data-testid="type-gets">
    <h3 class="features__title">מה יש בטיול? <span class="muted small">— לחיצה מדליקה / מכבה</span></h3>
    <div class="features__grid" role="group" aria-label="מה יש בטיול">
      ${MODULES.map((m) => html`<button type="button" key=${m.key} data-module=${m.key} aria-pressed=${modules[m.key] ? 'true' : 'false'}
        class=${cx('feature', modules[m.key] && 'is-on')} onClick=${() => onChange({ ...modules, [m.key]: !modules[m.key] })}>
        <span class="feature__emoji" aria-hidden="true">${m.emoji}</span>
        <span class="feature__text"><b>${m.label}</b><span>${m.hint}</span></span>
        <span class="feature__check" aria-hidden="true">${modules[m.key] ? '✓' : ''}</span>
      </button>`)}
    </div>
    <p class="features__note muted small">
      ${ready.length ? html`מקבלים מוכן: ${ready.join(' · ')}. ` : null}
      🔔 על מה שדלוק נזכיר למי שעוד לא מילא — ותראו מי חסר. אפשר לשנות הכל אחר כך.
    </p>
  </div>`;
}

/** Short names for the one-line "בטיול הזה: …" (ux W1). */
const MODULE_SHORT = {
  rides: 'הסעות', money: 'כסף', lists: 'רשימות', packing: 'אריזה', tasks: 'משימות', polls: 'סקרים', schedule: 'לו״ז',
  rooms: 'חדרים', bookings: 'הזמנות',
};
const CUSTOM_EMOJIS = ['⛳', '🎭', '🏄', '🚴', '🎿', '🧘', '🎣', '🍷', '🎤', '📸', '🏝️', '🚤'];
const FLIGHT_RE = /^[A-Z0-9]{2}[0-9]{1,4}[A-Z]?$/;
const normFlight = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');

/** Default hours for a type's step 2: abroad — none (they come from the flight); one evening; one work day. */
function defaultTimes(copy, composed) {
  if (!copy) return ['09:00', '12:00'];
  if (copy.hoursOptional) return ['', ''];
  if (copy.dates === 'single') return composed.family === 'work' ? ['09:00', '17:00'] : ['19:00', '23:00'];
  return ['09:00', '12:00'];
}

/** {starts_at, ends_at} of the wizard's dates (Israel time). One day: "until" before "from" ⇒ past midnight. */
function tripRange(trip, single) {
  if (!trip.startDate) return { starts_at: null, ends_at: null };
  if (single) {
    const starts = jerusalemIso(trip.startDate, trip.startTime || '00:00');
    if (!trip.endTime) return { starts_at: starts, ends_at: null };
    const endDay = trip.startTime && trip.endTime <= trip.startTime ? addDays(trip.startDate, 1) : trip.startDate;
    return { starts_at: starts, ends_at: jerusalemIso(endDay, trip.endTime) };
  }
  return {
    starts_at: jerusalemIso(trip.startDate, trip.startTime || '00:00'),
    ends_at: trip.endDate ? jerusalemIso(trip.endDate, trip.endTime || '23:59') : null,
  };
}

/** The group's flights typed in step 2 → info.bookings rows (details filled after the trip exists). */
function flightBookings(trip) {
  const legs = [
    ['out', normFlight(trip.flightOut), trip.startDate, trip.startTime],
    ['back', normFlight(trip.flightBack), trip.endDate || trip.startDate, trip.endTime],
  ];
  return legs.filter(([, n, d]) => n && d).map(([leg, flight, date, time]) => ({
    kind: 'flight', leg, flight, date, at: time ? `${date}T${time}` : date,
  }));
}

/** A found flight (design §4.3) on top of its booking row. Wall clocks at each airport, never converted. */
function withFlight(b, f) {
  const wallOf = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(0, 16) : null);
  const at = wallOf(f.dep?.sched);
  const arr = wallOf(f.arr?.sched);
  return {
    ...b,
    ...(f.airline?.name ? { airline: f.airline.name } : {}),
    ...(at ? { at, date: at.slice(0, 10) } : {}),
    ...(arr ? { arr_at: arr } : {}),
    ...(f.dep?.iata ? { from: f.dep.iata, from_iata: f.dep.iata } : {}),
    ...(f.arr?.iata ? { to: f.arr.iata, to_iata: f.arr.iata } : {}),
    ...(f.dep?.terminal ? { terminal: String(f.dep.terminal) } : {}),
  };
}

/**
 * After create: look the typed flights up (the `flight` function needs a member of the trip) and fill the
 * bookings; hours left empty take the flights' times; an empty "לאן" takes the out flight's city.
 * Never fatal — a flight that isn't found stays as typed (the admin fixes it on the trip screen).
 */
async function fillFlights(tripId, trip, bookings) {
  const api = store.get().api;
  if (!api?.lookupFlight || !bookings.length) return;
  const found = {};
  const next = [];
  for (const b of bookings) {
    let r = null;
    try {
      r = await api.lookupFlight(tripId, b.flight, b.date);
    } catch {
      r = { ok: false, error: 'upstream' };
    }
    if (r?.ok && r.flight) {
      found[b.leg] = r.flight;
      next.push(withFlight(b, r.flight));
    } else {
      next.push(b);
      actions.toast(`✈️ ${b.flight}: ${r?.message || flightErrorText(r?.error)}`, 'warning', 5200);
    }
  }
  if (!Object.keys(found).length) return;
  const patch = { info: { bookings: next } };
  const toIso = (s) => {
    const t = Date.parse(s || '');
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };
  // a flying trip starts when its flight takes off: the found flight's hour wins over a typed guess (and says so)
  if (found.out) {
    patch.starts_at = toIso(found.out.dep?.sched);
    const real = hmOf(found.out.dep?.sched);
    if (patch.starts_at && trip.startTime && real && real !== trip.startTime) {
      actions.toast(`✈️ ${found.out.number || 'הטיסה'} ממריאה ב-${real} — שעת היציאה עודכנה לפי הטיסה`, 'info', 5200);
    }
  }
  if (found.back) patch.ends_at = toIso(found.back.arr?.best || found.back.arr?.sched);
  // … and a flight that lands far from where the trip is, is probably the wrong number
  const where = { lat: trip.place?.lat, lon: trip.place?.lon, location: trip.place?.name || trip.location.trim() };
  for (const w of found.out ? flightFit({ flight: found.out, trip: where, leg: 'out' }) : []) {
    actions.toast(`⚠️ ${w.text} — אפשר לתקן במסך הטיול`, 'warning', 6400);
  }
  if (!(trip.place?.name || trip.location.trim()) && found.out?.arr?.city) patch.location = found.out.arr.city;
  for (const k of ['starts_at', 'ends_at']) if (patch[k] === null) delete patch[k];
  try {
    await api.updateTrip(tripId, patch);
  } catch {
    /* the flights are a nicety — the trip is already there */
  }
}

/** Step 1: family → sub-type (→ בארץ / בחו״ל, custom name) + the collapsed features. */
function TypeStep({ trip, composed, errors, onFamily, onSubtype, onWhere, onCustom, onModules, onNext }) {
  const family = FAMILIES.find((f) => f.key === trip.family) || null;
  const sub = family?.subtypes.find((x) => x.key === trip.subtype) || null;
  const modules = trip.modules || (composed ? typeModules(composed.family, composed.subtype, composed.where) : null);
  const onCount = modules ? MODULES.filter((m) => modules[m.key]).length : 0;
  return html`<form class="stack-lg" onSubmit=${onNext} noValidate>
    <div class="onb-flow__title">
      <h1>טיול חדש 🔥</h1>
      <p class="muted">בוחרים סוג — ומקבלים רשימות, לו״ז ואריזה מוכנים. אפשר לשנות הכל אחר כך.</p>
    </div>
    <section class="trip-types" aria-labelledby="trip-type-h">
      <h2 class="field__label" id="trip-type-h">איזה טיול?</h2>
      <div class="trip-types__grid" role="radiogroup" aria-label="סוג הטיול">
        ${FAMILIES.map((f) => html`<button type="button" role="radio" key=${f.key} aria-checked=${trip.family === f.key ? 'true' : 'false'}
          class=${cx('trip-type', trip.family === f.key && 'is-on')} onClick=${() => onFamily(f)} data-type=${f.key}>
          <span class="trip-type__emoji" aria-hidden="true">${f.emoji}</span>
          <span class="trip-type__label">${f.label}</span>
          <span class="trip-type__hint">${f.hint}</span>
        </button>`)}
      </div>
      ${errors.type ? html`<p class="field__error" role="alert">${errors.type}</p>` : null}
    </section>

    ${family
      ? html`<section class="nt-more" key=${family.key}>
          <h2 class="nt-sep"><span>ואיזה סוג?</span></h2>
          <div class="nt-subs" role="radiogroup" aria-label="איזה סוג">
            ${family.subtypes.map((x) => html`<button type="button" role="radio" key=${x.key} data-subtype=${x.key}
              aria-checked=${trip.subtype === x.key ? 'true' : 'false'} title=${x.hint || undefined}
              class=${cx('nt-sub', trip.subtype === x.key && 'is-on')} onClick=${() => onSubtype(x)}>
              <span aria-hidden="true">${x.emoji}</span> ${x.label}
            </button>`)}
          </div>
          ${sub?.hint ? html`<p class="muted small nt-sub-hint">${sub.hint}</p>` : null}

          ${sub?.where === 'ask'
            ? html`<div class="nt-where">
                <h2 class="nt-sep"><span>איפה?</span></h2>
                <div class="nt-where__opts" role="radiogroup" aria-label="איפה">
                  ${[['il', '🇮🇱 בארץ'], ['abroad', '✈️ בחו״ל']].map(([k, label]) => html`<button type="button" role="radio" key=${k}
                    data-where=${k} aria-checked=${trip.where === k ? 'true' : 'false'}
                    class=${cx('nt-where__opt', trip.where === k && 'is-on')} onClick=${() => onWhere(k)}>${label}</button>`)}
                </div>
              </div>`
            : null}

          ${trip.subtype === 'custom'
            ? html`<div class="nt-custom stack">
                <${Field} label="איך תקראו לזה?" error=${errors.customLabel}>
                  <${TextInput} value=${trip.customLabel} maxlength="30" placeholder="למשל: סופ״ש גולף"
                    onInput=${(e) => onCustom({ customLabel: e.target.value })} />
                </${Field}>
                <${Field} label="ואימוג׳י">
                  <${EmojiPicker} value=${trip.customEmoji} options=${CUSTOM_EMOJIS} label="אימוג׳י לסוג"
                    onChange=${(v) => onCustom({ customEmoji: v })} />
                </${Field}>
              </div>`
            : null}

          ${composed && modules
            ? html`<details class="nt-fold" data-testid="features-fold">
                <summary>
                  <span>בטיול הזה: <span class="nt-fold__count">${onCount
                    ? MODULES.filter((m) => modules[m.key]).map((m) => MODULE_SHORT[m.key] || m.label).join(' · ')
                    : 'בלי תוספות'}</span></span>
                  <span class="link small nt-fold__change">שינוי</span>
                </summary>
                <${FeaturePicker} type=${composed} modules=${modules} onChange=${onModules} />
              </details>`
            : null}
        </section>`
      : null}

    <${Button} type="submit" size="lg" block icon="arrow-left">המשך</${Button}>
  </form>`;
}

/** Step 2: name, place, dates — every word by the type (wizardCopy); abroad: airport + optional flights. */
function DetailsStep({ trip, composed, copy, single, errors, set, setPatch, onNext, onBack }) {
  const airports = AIRPORTS || [];
  const otherAirport = !airports.some((a) => a.iata === trip.airport);
  const hourLabel = (l) => (copy.hoursOptional ? `${l} (לא חובה)` : l);
  return html`<form class="stack-lg" onSubmit=${onNext} noValidate>
    <div class="onb-flow__title">
      <h1>פרטים קטנים ✍️</h1>
      <p class="muted">
        <button type="button" class="nt-kind" onClick=${onBack} aria-label=${`${composed.label} — לשנות סוג`}>
          <span aria-hidden="true" class="nt-kind__emoji">${trip.emoji || composed.emoji}</span> ${composed.label}${composed.where === 'abroad' ? ' · ✈️ בחו״ל' : ''}
          <span class="nt-kind__edit">שינוי</span>
        </button>
      </p>
    </div>
    <${Field} label="איך קוראים לטיול?" error=${errors.name}>
      <${TextInput} value=${trip.name} maxlength="60" placeholder=${copy.namePlaceholder || 'למשל: טיול לפארק החבשושיות'}
        onInput=${(e) => set('name', e.target.value)} />
    </${Field}>
    <${PlaceInput} label=${copy.placeLabel} where=${copy.placeWhere} placeholder=${copy.placePlaceholder} testid="trip-place" maxlength=${120}
      value=${trip.place} text=${trip.location} hint=${copy.placeWhere === 'il' ? 'בוחרים מהרשימה — בשביל ניווט ותחזית' : undefined}
      onChange=${(place, text) => setPatch({ place, location: text ?? '' })} />

    ${single
      ? html`<div class="stack">
          <${Field} label=${copy.startLabel} error=${errors.startDate}>
            <${TextInput} type="date" value=${trip.startDate} onInput=${(e) => set('startDate', e.target.value)} />
          </${Field}>
          <div class="date-pair date-pair--even">
            <${Field} label=${copy.startHourLabel}>
              <${TextInput} type="time" value=${trip.startTime} onInput=${(e) => set('startTime', e.target.value)} />
            </${Field}>
            <${Field} label=${copy.endHourLabel}>
              <${TextInput} type="time" value=${trip.endTime} onInput=${(e) => set('endTime', e.target.value)} />
            </${Field}>
          </div>
          ${copy.moreDaysLabel
            ? html`<button type="button" class="link nt-days" onClick=${() => setPatch({ multiDay: true, endDate: trip.endDate || (trip.startDate ? addDays(trip.startDate, 1) : '') })}>📅 ${copy.moreDaysLabel}</button>`
            : null}
        </div>`
      : html`<div class="stack">
          <div class="date-pair">
            <${Field} label=${copy.dates === 'single' ? 'מתחילים' : copy.startLabel} error=${errors.startDate}>
              <${TextInput} type="date" value=${trip.startDate} onInput=${(e) => set('startDate', e.target.value)} />
            </${Field}>
            <${Field} label=${hourLabel(copy.startHourLabel === 'משעה' ? 'בשעה' : copy.startHourLabel)}>
              <${TextInput} type="time" value=${trip.startTime} onInput=${(e) => set('startTime', e.target.value)} />
            </${Field}>
          </div>
          <div class="date-pair">
            <${Field} label=${copy.dates === 'single' ? 'מסיימים' : copy.endLabel} error=${errors.endDate}>
              <${TextInput} type="date" value=${trip.endDate} min=${trip.startDate || undefined} onInput=${(e) => set('endDate', e.target.value)} />
            </${Field}>
            <${Field} label=${hourLabel(copy.endHourLabel === 'עד שעה' ? 'בשעה' : copy.endHourLabel)}>
              <${TextInput} type="time" value=${trip.endTime} onInput=${(e) => set('endTime', e.target.value)} />
            </${Field}>
          </div>
          ${copy.dates === 'single'
            ? html`<button type="button" class="link nt-days" onClick=${() => setPatch({ multiDay: false })}>📅 רק יום אחד</button>`
            : null}
        </div>`}

    ${copy.askAirport
      ? html`<div class="nt-airport" data-testid="nt-airport">
          <p class="field__label" id="nt-airport-h">${copy.airportLabel}</p>
          <div class="nt-chips" role="radiogroup" aria-labelledby="nt-airport-h">
            ${airports.map((a) => html`<button type="button" role="radio" key=${a.iata} data-airport=${a.iata}
              aria-checked=${trip.airport === a.iata ? 'true' : 'false'} class=${cx('chip', trip.airport === a.iata && 'is-active')}
              onClick=${() => setPatch({ airport: a.iata })}>${a.label} <bdi class="nt-iata">${a.iata}</bdi></button>`)}
            <button type="button" role="radio" data-airport="other" aria-checked=${otherAirport ? 'true' : 'false'}
              class=${cx('chip', otherAirport && 'is-active')} onClick=${() => !otherAirport && setPatch({ airport: '' })}>שדה אחר</button>
          </div>
          ${otherAirport
            ? html`<${Field} label="קוד השדה (3 אותיות)" error=${errors.airport}>
                <${TextInput} dir="ltr" value=${trip.airport} maxlength="3" placeholder="ETM" autocapitalize="characters"
                  onInput=${(e) => set('airport', e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} />
              </${Field}>`
            : null}
        </div>`
      : null}

    ${copy.askFlight
      ? html`<details class="nt-fold nt-flights" data-testid="nt-flights" open=${Boolean(trip.flightOut || trip.flightBack || errors.flightOut || errors.flightBack)}>
          <summary><span aria-hidden="true">🛫</span> ${copy.flightLabel}</summary>
          <div class="stack nt-fold__body">
            <div class="date-pair date-pair--even">
              <${Field} label="טיסת הלוך" error=${errors.flightOut}>
                <${TextInput} dir="ltr" value=${trip.flightOut} maxlength="10" placeholder="LY315" autocapitalize="characters"
                  onInput=${(e) => set('flightOut', e.target.value)} />
              </${Field}>
              <${Field} label="טיסת חזור" error=${errors.flightBack}>
                <${TextInput} dir="ltr" value=${trip.flightBack} maxlength="10" placeholder="LY316" autocapitalize="characters"
                  onInput=${(e) => set('flightBack', e.target.value)} />
              </${Field}>
            </div>
            <p class="muted small">אחרי שהטיול נוצר נמלא לבד חברה, שעות וטרמינל — ונעדכן אם משהו משתנה. אפשר גם לערוך.</p>
          </div>
        </details>`
      : null}

    <${Button} type="submit" size="lg" block icon="arrow-left">המשך</${Button}>
  </form>`;
}

const EMPTY_TRIP = {
  family: '', subtype: '', where: 'il', customLabel: '', customEmoji: '', modules: null,
  name: '', emoji: '⛺', location: '', place: null,
  startDate: '', startTime: '09:00', endDate: '', endTime: '12:00', timesTouched: false, multiDay: false,
  airport: 'TLV', flightOut: '', flightBack: '',
};

function NewTrip() {
  const [step, setStep] = useState(1);
  const [trip, setTrip] = useState(EMPTY_TRIP);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState(null);
  // the type's lists, as the organiser shapes them in step 3 (null until they get there; re-seeded when the type/features change)
  const [lists, setLists] = useState(null);
  const [picked, setPicked] = useState(() => new Set());       // the focus packs ticked in the lists step
  const listsFor = useRef('');

  const custom = trip.subtype === 'custom' ? { label: trip.customLabel.trim(), emoji: trip.customEmoji || null } : null;
  const composed = trip.family ? composeType(trip.family, trip.subtype, trip.where, custom) : null;
  const copy = composed ? wizardCopy(composed) : null;
  const single = copy?.dates === 'single' && !trip.multiDay;
  // the lists step exists when the trip has lists, tasks or a packing list (features picked in step 1)
  const typeSeed = composed ? tripSeed({ family: trip.family, subtype: trip.subtype, where: trip.where, custom, modules: trip.modules,
    airport: copy?.askAirport ? trip.airport : undefined }) : null;
  const withLists = Boolean(typeSeed && hasLists({ settings: typeSeed.settings }));
  const PROFILE = withLists ? 4 : 3;
  const INVITE = PROFILE + 1;
  const seedKey = typeSeed ? JSON.stringify([trip.family, trip.subtype, trip.where, custom, typeSeed.settings.modules]) : '';
  const allowedTypes = typeSeed ? ['buy', 'bring', 'each', 'task'].filter((t) => itemTypeOn({ settings: typeSeed.settings }, t)) : [];

  const clearErr = (...keys) => {
    if (keys.some((k) => errors[k])) setErrors((e) => ({ ...e, ...Object.fromEntries(keys.map((k) => [k, undefined])) }));
  };

  /** A new family / sub-type / where re-seeds the features (and the hours, while untouched). */
  const retype = (t, patch) => {
    const n = { ...t, ...patch };
    const c = composeType(n.family, n.subtype, n.where, null);
    n.where = c.where;
    n.modules = typeModules(n.family, n.subtype, n.where);
    if (!t.timesTouched) [n.startTime, n.endTime] = defaultTimes(wizardCopy(c), c);
    return n;
  };
  const pickFamily = (f) => {
    if (trip.family === f.key) return;
    const s = f.subtypes[0];
    setTrip((t) => retype(t, { family: f.key, subtype: s.key, where: f.where === 'abroad' ? 'abroad' : 'il', multiDay: false, emoji: s.key === 'custom' ? f.emoji : s.emoji }));
    clearErr('type', 'customLabel');
  };
  const pickSubtype = (s) => {
    if (trip.subtype === s.key) return;
    setTrip((t) => retype(t, { subtype: s.key, emoji: s.key === 'custom' ? t.customEmoji || FAMILIES.find((f) => f.key === t.family)?.emoji || t.emoji : s.emoji }));
    clearErr('customLabel');
  };
  const pickWhere = (w) => {
    if (trip.where === w) return;
    setTrip((t) => retype(t, { where: w, place: null }));
  };
  const setCustom = (patch) => {
    setTrip((t) => ({ ...t, ...patch, ...(patch.customEmoji ? { emoji: patch.customEmoji } : {}) }));
    if (patch.customLabel !== undefined) clearErr('customLabel');
  };

  const set = (key, value) => {
    setTrip((t) => {
      const next = { ...t, [key]: value };
      if (key === 'startDate' && value && !single && (!t.endDate || t.endDate < value)) next.endDate = addDays(value, 1);
      if (key === 'startTime' || key === 'endTime') next.timesTouched = true;
      return next;
    });
    clearErr(key);
  };
  const setPatch = (patch) => {
    setTrip((t) => ({ ...t, ...patch }));
    clearErr(...Object.keys(patch));
  };

  const fail = (errs) => {
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) {
      focusFirstInvalid();
      return true;
    }
    return false;
  };
  const go = (n) => {
    setStep(n);
    window.scrollTo(0, 0);
  };

  const nextFromType = (e) => {
    e.preventDefault();
    const errs = {};
    if (!trip.family) errs.type = 'איזה טיול? בחרו אחד — אפשר לשנות הכל אחר כך';
    if (trip.subtype === 'custom') {
      const n = [...trip.customLabel.trim()].length;
      if (!n) errs.customLabel = 'איך תקראו לזה? 🙂';
      else if (n > 30) errs.customLabel = 'עד 30 תווים';
    }
    if (fail(errs)) return;
    go(2);
  };

  const nextFromDetails = (e) => {
    e.preventDefault();
    const errs = {};
    const name = trip.name.trim();
    if (!name) errs.name = 'איך נקרא לטיול? 🙂';
    else if ([...name].length > 60) errs.name = 'עד 60 תווים';
    if (!single) {
      if (trip.endDate && !trip.startDate) errs.startDate = composed.where === 'abroad' ? 'מתי טסים?' : 'מתי יוצאים?';
      if (trip.startDate && trip.endDate) {
        const r = tripRange(trip, false);
        if (r.ends_at < r.starts_at) errs.endDate = 'החזרה לפני היציאה? 🙃';
      }
    }
    if (copy.askAirport && !/^[A-Z]{3}$/.test(trip.airport)) errs.airport = '3 אותיות באנגלית, למשל ETM';
    if (copy.askFlight) {
      const out = normFlight(trip.flightOut);
      const back = normFlight(trip.flightBack);
      if (out && !FLIGHT_RE.test(out)) errs.flightOut = 'מספר טיסה כמו LY315';
      else if (out && !trip.startDate) errs.flightOut = 'צריך תאריך טיסה (למעלה) כדי למצוא אותה';
      if (back && !FLIGHT_RE.test(back)) errs.flightBack = 'מספר טיסה כמו LY316';
      else if (back && !(trip.endDate || trip.startDate)) errs.flightBack = 'צריך תאריך חזרה (למעלה) כדי למצוא אותה';
    }
    if (fail(errs)) return;
    if (withLists) {
      if (listsFor.current !== seedKey) {            // first time here, or the type / features changed since: start from the type's own
        listsFor.current = seedKey;
        setLists(fromSeed(typeSeed));
        setPicked(new Set());
      }
      go(3);
    } else go(PROFILE);
  };

  const create = async (profile) => {
    setBusy(true);
    const seed = tripSeed({
      family: trip.family, subtype: trip.subtype, where: trip.where, custom, modules: trip.modules,
      airport: copy.askAirport ? trip.airport : undefined,
    });
    const shaped = withLists && lists ? toSeed(lists) : null;
    const itemsToAdd = shaped ? shaped.items : seed.items;
    const range = tripRange(trip, single);
    const bookings = copy.askFlight ? flightBookings(trip) : [];
    const place = trip.place;
    const payload = {
      name: trip.name.trim(),
      emoji: trip.emoji,
      location: (place?.name || trip.location).trim() || null,
      ...(place && Number.isFinite(place.lat) && Number.isFinite(place.lon) ? { lat: place.lat, lon: place.lon } : {}),
      ...(place?.address ? { address: String(place.address).slice(0, 200) } : {}),
      starts_at: range.starts_at,
      ends_at: range.ends_at,
      settings: seed.settings,
      info: { ...seed.info, ...(shaped ? { packing: shaped.packing } : {}), ...(bookings.length ? { bookings } : {}) },
      // an emptied list still needs one category (the server would add the camping defaults to none)
      categories: shaped ? (shaped.categories.length ? shaped.categories : [{ name: 'שונות', emoji: '📦' }]) : seed.categories,
    };
    const res = await actions.run((api) => api.createTrip(payload, profile), { refresh: false });
    if (!res?.trip_id) {
      setBusy(false);
      return;
    }
    // the type's ready-made lists (a failure here isn't fatal — the trip exists, the lists can be filled later)
    for (let i = 0; i < itemsToAdd.length; i += 150) {
      const chunk = itemsToAdd.slice(i, i + 150);
      await actions.run(async (api) => { await api.addItemsBulk(res.trip_id, chunk); return true; }, { refresh: false })
        .catch(() => null);
    }
    if (bookings.length) await fillFlights(res.trip_id, trip, bookings);
    await actions.loadTrips();
    await actions.openTrip(res.trip_id, { force: true });
    setBusy(false);
    setCreatedId(res.trip_id);
    go(INVITE);
    fireConfetti();
  };

  return html`<div class="onb onb--flow onb--newtrip" data-step=${step}>
    <div class="onb-flow__top">
      ${step === 1 ? html`<${BackBar} to="/" label="חזרה למסך הראשי" />` : null}
      ${step === 2 ? html`<${BackBar} label="חזרה לסוג הטיול" onClick=${() => go(1)} />` : null}
      ${step === 3 && withLists ? html`<${BackBar} label="חזרה לפרטי הטיול" onClick=${() => go(2)} />` : null}
      ${step === PROFILE ? html`<${BackBar} label=${withLists ? 'חזרה לרשימות' : 'חזרה לפרטי הטיול'} onClick=${() => go(withLists ? 3 : 2)} />` : null}
      <${StepDots} step=${step} labels=${withLists ? ['סוג', 'פרטים', 'רשימות', 'הפרופיל שלך', 'הזמנה'] : ['סוג', 'פרטים', 'הפרופיל שלך', 'הזמנה']} />
    </div>
    <div class="onb__body">
    ${step === 1
      ? html`<${TypeStep} trip=${trip} composed=${composed} errors=${errors}
          onFamily=${pickFamily} onSubtype=${pickSubtype} onWhere=${pickWhere} onCustom=${setCustom}
          onModules=${(modules) => setTrip((t) => ({ ...t, modules }))} onNext=${nextFromType} />`
      : null}

    ${step === 2 && composed
      ? html`<${DetailsStep} trip=${trip} composed=${composed} copy=${copy} single=${single} errors=${errors}
          set=${set} setPatch=${setPatch} onNext=${nextFromDetails} onBack=${() => go(1)} />`
      : null}

    ${step === 3 && withLists && lists
      ? html`<div class="stack-lg" data-testid="wizard-lists">
          <div class="onb-flow__title">
            <h1>הרשימות של הטיול 📋</h1>
            <p class="muted">הכנו התחלה לפי סוג הטיול — אבל אתם המארגנים, וזה שלכם: שנו שמות, הוסיפו, מחקו וסדרו. אפשר גם אחר כך.</p>
          </div>
          <${PackPicker} packs=${focusPacksFor(composed)} picked=${picked}
            onToggle=${(p) => {
              const on = !picked.has(p.key);
              setLists((v) => applyPack(v, p.key, (() => { const sd = packSeed(p); return { ...sd, items: sd.items.filter((x) => allowedTypes.includes(x.type)) }; })(), on));
              setPicked((s) => { const n = new Set(s); if (on) n.add(p.key); else n.delete(p.key); return n; });
            }} />
          <${ListEditor} value=${lists} onChange=${setLists} allowedTypes=${allowedTypes} showLists=${allowedTypes.length > 0} showSecret=${trip.family === 'celebrate'} showPacking=${Boolean(typeSeed?.settings?.modules?.packing !== false)} />
          <div class="stack">
            <${Button} block onClick=${() => go(PROFILE)} data-testid="wizard-lists-next">${(() => { const c = countOf(lists); return c.items ? `המשך — ${c.items} פריטים ב־${c.categories} קטגוריות` : 'המשך'; })()}</${Button}>
            <button type="button" class="link onb-back-link" onClick=${() => go(2)}><${Icon} name="arrow-right" size=${18} /> חזרה לפרטי הטיול</button>
          </div>
        </div>`
      : null}

    ${step === PROFILE
      ? html`<div class="stack-lg">
          <div class="onb-flow__title">
            <h1>ומי את/ה? 🙂</h1>
            <p class="muted">הפרופיל שלך בטיול. מגיעים בזוג? בחרו "זוג" — ההתחשבנות תספור אתכם כשניים.</p>
          </div>
          <${ProfileForm} submitLabel="צור את הטיול 🔥" busy=${busy} onSubmit=${create} />
          <button type="button" class="link onb-back-link" onClick=${() => go(withLists ? 3 : 2)}><${Icon} name="arrow-right" size=${18} /> ${withLists ? 'חזרה לרשימות' : 'חזרה לפרטי הטיול'}</button>
        </div>`
      : null}

    ${step === INVITE && createdId ? html`<${InviteStep} tripId=${createdId} />` : null}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

function JoinTicket({ preview }) {
  const { trip } = preview;
  const when = dateRange(trip);
  const cd = trip.starts_at ? countdown(trip.starts_at, new Date(), trip.ends_at) : null;
  return html`<div class="card join-ticket">
    <div class="join-ticket__row">
      <span class="join-ticket__emoji" aria-hidden="true">${trip.emoji || '⛺'}</span>
      <div class="join-ticket__title">
        <span class="kicker">הוזמנתם ל־</span>
        <h1 class="join-ticket__name">${trip.name}</h1>
      </div>
    </div>
    <div class="join-ticket__chips">
      ${when ? html`<span class="join-chip"><${Icon} name="calendar" size=${15} /> ${when}${trip.starts_at ? html` · <bdi>${formatTime(trip.starts_at)}</bdi>` : null}</span>` : null}
      ${trip.location ? html`<span class="join-chip"><${Icon} name="map-pin" size=${15} /> ${trip.location}</span>` : null}
      <span class="join-chip"><${Icon} name="users" size=${15} /> ${hebrewCount(preview.headcount || 0, 'משתתף', 'משתתפים')}</span>
      ${cd?.label && !cd.past ? html`<span class="join-chip join-chip--hot">${cd.label}</span>` : null}
    </div>
  </div>`;
}

/** Three tiles to a row on a phone (ux E2) — the grid's own css keeps two. */
const GRID3 = 'grid-template-columns:repeat(3, minmax(0, 1fr));gap:8px';
const TILE = 'min-height:0;padding:10px 6px;gap:4px';

/** Everyone on the trip, one card per person ("עידו", small: "בפרופיל הדס ועידו") — pick yourself, you're in. */
function PeopleGrid({ unclaimed, claimed, busy, onPickPerson, onAsk, onNew }) {
  const tiles = [];
  for (const m of [...unclaimed, ...claimed]) {
    const people = (m.people || []).filter(Boolean);
    const names = people.length ? people : [displayName(m)];
    const joined = new Set(m.joined || []);
    const isClaimed = claimed.includes(m);
    for (const p of names) {
      const taken = isClaimed && (names.length < 2 || joined.has(p));
      // an owner/admin profile, or one whose device never said who it is: its people approve (older servers send no `open`)
      const ask = isClaimed && !taken && Array.isArray(m.open) && !m.open.includes(p);
      tiles.push({ key: `${m.id}:${p}`, m, person: people.length ? p : null, name: p, taken, ask, multi: names.length > 1 });
    }
  }
  // those already in are one text line (ux E2), not tiles
  const inside = tiles.filter((x) => x.taken);
  const open = tiles.filter((x) => !x.taken);
  return html`<section class="stack" aria-labelledby="who-are-you">
    <div>
      <h2 class="h2" id="who-are-you">מי את/ה? 👀</h2>
      <p class="muted small">מוצאים את השם שלך ולוחצים — וזהו, בפנים.</p>
    </div>
    <div class="claim-grid" data-testid="people-grid" style=${GRID3}>
      ${open.map((x) => html`<button type="button" key=${x.key} class="claim-tile" style=${TILE}
        disabled=${busy} data-person=${x.name} onClick=${() => (x.ask ? onAsk(x.m, x.person) : onPickPerson(x.m, x.person))}>
        <${Avatar} member=${{ ...x.m, headcount: 1, claimed: true, display_name: x.name }} size=${40} />
        <span class="claim-tile__name">${x.name}</span>
        ${x.multi ? html`<span class="claim-tile__people">בפרופיל ${displayName(x.m)}</span>` : null}
        <span class="claim-tile__cta">${x.ask ? 'זה אני — לבקש 🤝' : 'זה אני!'}</span>
      </button>`)}
    </div>
    ${inside.length
      ? html`<p class="small muted" data-testid="people-inside">✓ כבר בפנים: ${inside.map((x, i) => html`${i ? ', ' : ''}<span data-person=${x.name}>${x.name}</span>`)}</p>`
      : null}
    <button type="button" class="claim-tile claim-tile--new" disabled=${busy} onClick=${onNew}
      style="width:100%;min-height:56px;flex-direction:row;justify-content:center;gap:10px;padding:10px 14px">
      <span class="claim-tile__name">✨ אני לא ברשימה</span>
      <span class="claim-tile__cta">יצירת פרופיל</span>
    </button>
    ${claimed.length
      ? html`<p class="small muted center" data-testid="claim-signin">כתוב "כבר בפנים" ליד השם שלך?
          <a class="link" href="#/signin">🔑 התחברות עם המייל</a></p>`
      : null}
  </section>`;
}

/** A new profile whose name matches a person on a profile nobody claimed yet: {m, person} | null. */
function waitingTwin(unclaimed, profile) {
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const names = new Set([profile.display_name, ...(profile.people || [])].map(norm).filter(Boolean));
  for (const m of unclaimed || []) {
    const people = m.people?.length ? m.people : [m.display_name];
    const person = people.find((p) => names.has(norm(p)));
    if (person) return { m, person };
  }
  return null;
}

/** Taken profiles on the invite: "גם אני בפרופיל הזה 🤝" → ask to join (verified e-mail, answered by its people). */
function ClaimedGrid({ claimed, onPick, title }) {
  if (!claimed?.length) return null;
  return html`<section class="stack" aria-labelledby="already-in">
    <div>
      <h2 class="h2" id="already-in">${title || 'כבר בטיול'}</h2>
      <p class="muted small">בן/בת הזוג כבר נרשם/ה? מצטרפים לאותו פרופיל — הם יאשרו.</p>
    </div>
    <div class="claim-grid">
      ${claimed.map((m) => html`<button type="button" class="claim-tile claim-tile--taken" key=${m.id} onClick=${() => onPick(m)}>
        <${Avatar} member=${{ ...m, claimed: true }} size=${50} />
        <span class="claim-tile__name">${displayName(m)}</span>
        <span class="claim-tile__cta">גם אני בפרופיל הזה 🤝</span>
      </button>`)}
    </div>
  </section>`;
}

/** Ask to join an existing profile: verify an e-mail (maybe it's already yours → straight in), say who you are, send. */
function JoinExisting({ code, tripId, target, onBack }) {
  const contact = useStore((s) => s.contact);
  const people = (target.people || []).filter(Boolean);
  const [who, setWho] = useState(target.preselect && people.includes(target.preselect) ? target.preselect : people.length ? '' : '__new');
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Just verified: if this e-mail already belongs to a profile here (a partner listed it), go straight in.
  useEffect(() => {
    if (!contact?.verified) return;
    linkThisDevice().then((linked) => {
      const here = linked.find((l) => l.trip_id === tripId);
      if (here) {
        actions.toast('זיהינו אותך ✅ נכנסים לפרופיל', 'success', 3200);
        navigate(`/t/${tripId}`, { replace: true });
      }
    });
  }, [contact?.verified]);

  if (!contact?.verified) {
    return html`<div class="stack">
      <p class="muted small">כדי להצטרף ל<b>${displayName(target)}</b> — קודם מאמתים את המייל שלך:</p>
      <${EmailGate} mode="inline" />
      <button type="button" class="link onb-back-link" onClick=${onBack}><${Icon} name="arrow-right" size=${18} /> חזרה</button>
    </div>`;
  }

  const send = async (e) => {
    e?.preventDefault();
    if (!who) return setError('מי את/ה בפרופיל? 🙂');
    if (who === '__new' && !name.trim()) return setError('איך קוראים לך?');
    if (who === '__new' && people.includes(name.trim())) {
      return setError(`${name.trim()} כבר ברשימה — אם זה את/ה בחרו ״אני ${name.trim()}״, ואם לא הוסיפו אות או כינוי ✏️`);
    }
    setBusy(true);
    const opts = who === '__new' ? { name: name.trim() } : { person: who };
    const id = await actions.run((api) => api.requestProfileJoin(code, target.id, opts), { refresh: false });
    setBusy(false);
    if (!id) return undefined;
    actions.toast(`הבקשה נשלחה ל${displayName(target)} ⏳`, 'success', 3200);
    navigate(`/t/${tripId}`, { replace: true });
    return undefined;
  };

  return html`<form class="stack-lg join-existing" onSubmit=${send} noValidate>
    <div>
      <h2 class="h2">מי את/ה ב״${displayName(target)}״? 🤝</h2>
      <p class="muted small">ככה לא נספור אותך פעמיים. אחרי שיאשרו — הרשימות, ההסעה והכסף משותפים.</p>
    </div>
    <div class="welcome-opts" role="radiogroup" aria-label="מי את/ה">
      ${people.map((p) => html`<button type="button" role="radio" key=${p} aria-checked=${who === p ? 'true' : 'false'}
        class=${who === p ? 'welcome-opt is-on' : 'welcome-opt'} onClick=${() => { setWho(p); setError(null); }}>
        <span class="welcome-opt__emoji" aria-hidden="true">🙋</span>
        <span class="welcome-opt__text"><b>אני ${p}</b><span>כבר ברשימה של הפרופיל</span></span>
      </button>`)}
      <button type="button" role="radio" aria-checked=${who === '__new' ? 'true' : 'false'}
        class=${who === '__new' ? 'welcome-opt is-on' : 'welcome-opt'} onClick=${() => { setWho('__new'); setError(null); }}>
        <span class="welcome-opt__emoji" aria-hidden="true">➕</span>
        <span class="welcome-opt__text"><b>אני חדש/ה בפרופיל</b><span>הפרופיל יגדל באחד</span></span>
      </button>
    </div>
    ${who === '__new'
      ? html`<${Field} label="איך קוראים לך?">
          <${TextInput} value=${name} maxlength="40" placeholder="השם שלך" onInput=${(ev) => { setName(ev.target.value); setError(null); }} />
        </${Field}>`
      : null}
    ${error ? html`<p class="field__error" role="alert">${error}</p>` : null}
    <${Button} type="submit" variant="accent" size="lg" block loading=${busy}>שליחת בקשה להצטרף</${Button}>
    <button type="button" class="link onb-back-link" onClick=${onBack}><${Icon} name="arrow-right" size=${18} /> חזרה לבחירת פרופיל</button>
  </form>`;
}

function Join({ code, switchMode = false }) {
  const api = useStore((s) => s.api);
  const cleanCode = String(code || '').trim().toLowerCase();
  const [state, setState] = useState({ status: 'loading', preview: null, error: null });
  const [choice, setChoice] = useState(undefined); // undefined = choosing, null = new profile, member = claim
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState(null); // a taken profile to ask to join
  const [account, setAccount] = useState(null); // "הפרופיל שלי" (name, phone) when this device has one
  useEffect(() => {
    if (!api?.myAccount) return;
    api.myAccount().then((a) => setAccount(a?.verified ? a : null)).catch(() => {});
  }, [api]);

  const load = async () => {
    setState({ status: 'loading', preview: null, error: null });
    try {
      const preview = await api.previewInvite(cleanCode);
      const waiting = preview.my_request?.status === 'pending' && !preview.my_member_id;
      if ((preview.my_member_id && !switchMode) || waiting) {
        await actions.loadTrips();
        navigate(`/t/${preview.trip.id}`, { replace: true });
        return;
      }
      setState({ status: 'ready', preview, error: null });
      setChoice(switchMode || preview.unclaimed?.length || preview.claimed?.length ? undefined : null);
    } catch (e) {
      setState({ status: 'error', preview: null, error: toApiError(e) });
    }
  };

  useEffect(() => {
    if (api) load();
  }, [api, cleanCode]);

  const pickProfile = (m) => {
    setChoice(m);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const join = async (profile, as = null) => {
    setBusy(true);
    let retryPreview = false;
    const res = await actions.run(
      (a) => a.joinTrip(cleanCode, as
        ? { claimMemberId: as.member.id, person: as.person, profile: null }
        : { claimMemberId: choice?.id || null, profile }),
      {
        refresh: false,
        error: (errCode) => {
          if (errCode === 'already_claimed' || errCode === 'not_found') retryPreview = true;
          if (errCode === 'needs_approval' && as) {
            setTarget({ ...as.member, preselect: as.person });            // → ask the profile's people
            return 'לפרופיל הזה נכנסים באישור — שולחים להם בקשה 🤝';
          }
          return hebrewError(errCode);
        },
      },
    );
    if (!res?.trip_id) {
      setBusy(false);
      if (retryPreview) load();
      return;
    }
    fireConfetti();
    await actions.loadTrips();
    const opened = await actions.openTrip(res.trip_id, { force: true });
    // the profile has no phone yet and my account has one: fill it (never overwrite)
    const mine = opened?.members?.find((m) => m.id === res.member_id);
    if (cleanPhone(account?.phone) && mine && !mine.phone) {
      try {
        await store.get().api.updateMember(mine.id, { phone: cleanPhone(account.phone) });
        await actions.refresh();
      } catch {
        /* a phone is a nicety — never block joining over it */
      }
    }
    actions.toast('ברוכים הבאים! 🔥 איזה כיף שבאתם', 'success', 3200);
    navigate(`/t/${res.trip_id}`);
  };

  const header = html`<${Hero} compact>
    <div class="onb-brand onb-brand--small">
      <p class="onb-brand__name">מדורה</p>
      <p class="onb-brand__tag">כל החבר'ה סביב המדורה</p>
    </div>
  </${Hero}>`;

  if (state.status === 'loading') {
    return html`<div class="onb onb--flow">
      ${header}
      <div class="onb__body onb__body--lift"><${Skeleton} lines=${3} /><${Skeleton} lines=${4} /></div>
    </div>`;
  }

  if (state.status === 'error') {
    const invalid = state.error?.code === 'invalid_code' || state.error?.code === 'invalid_input' || state.error?.code === 'not_found';
    return html`<div class="onb onb--flow">
      ${header}
      <div class="onb__body onb__body--lift">
        <${Card}>
          <${EmptyState}
            emoji=${invalid ? '🔗' : '📶'}
            title=${invalid ? 'הקישור הזה לא עובד 🤔' : 'לא הצלחנו לטעון את ההזמנה'}
            text=${invalid ? 'אולי הוא ישן או שהועתק חלקית. בקשו מהמנהל/ת קישור חדש — או הדביקו אותו שוב.' : hebrewError(state.error?.code)}
            action=${invalid ? null : html`<${Button} icon="refresh" onClick=${load}>לנסות שוב</${Button}>`}
          />
        </${Card}>
        <${CodeEntry} startOpen=${invalid} />
        <${Button} variant="ghost" block href="#/">למסך הראשי</${Button}>
      </div>
    </div>`;
  }

  const { preview } = state;
  const unclaimed = preview.unclaimed || [];
  // no hero here (ux E2): the trip's own ticket is the header, the people start high on the screen
  return html`<div class="onb onb--flow onb--join">
    <div class="onb__body" style="padding-top:calc(16px + env(safe-area-inset-top, 0px))">
      <${JoinTicket} preview=${preview} />
      ${target
        ? html`<${JoinExisting} code=${cleanCode} tripId=${preview.trip.id} target=${target} onBack=${() => setTarget(null)} />`
        : choice === undefined
        ? html`<div class="stack-lg">
            ${switchMode
              ? null
              : html`<${PeopleGrid} unclaimed=${unclaimed} claimed=${preview.claimed || []} busy=${busy}
                  onPickPerson=${(m, person) => join(null, { member: m, person })}
                  onAsk=${(m, person) => { setTarget({ ...m, preselect: person }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                  onNew=${() => pickProfile(null)} />`}
            <details class="join-more" open=${switchMode}>
              <summary>${switchMode ? 'לאיזה פרופיל מצטרפים?' : 'מצטרפים לפרופיל של מישהו (בן/בת זוג, משפחה)?'}</summary>
              <${ClaimedGrid} claimed=${(preview.claimed || []).filter((m) => m.id !== preview.my_member_id)}
                title=${switchMode ? 'לאיזה פרופיל מצטרפים?' : null} onPick=${(m) => { setTarget(m); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
            </details>
          </div>`
        : html`<div class="stack-lg">
            <div>
              <h2 class="h2">${choice ? 'רק מוודאים שהכל נכון 👌' : 'ספרו לנו עליכם 🙂'}</h2>
              <p class="muted small">${choice ? 'אפשר לתקן שמות, אימוג׳י וצבע. טלפון ומייל — בשלב הבא.' : 'איך קוראים לכם, ואתם בפנים.'}</p>
            </div>
            <${ProfileForm} key=${choice?.id || (account?.name ? 'new-acc' : 'new')}
              initial=${choice || (account?.name ? { display_name: account.name, people: [account.name], headcount: 1 } : null)}
              submitLabel="יאללה, נכנסים! 🔥" busy=${busy}
              onSubmit=${async (profile) => {
                // "אני לא ברשימה" with a name that already waits on the list: that's probably me — say so first
                const twin = !choice && profile ? waitingTwin(unclaimed, profile) : null;
                if (twin) {
                  const me_ = await confirmDialog({
                    title: `יש כבר ${twin.person} שמחכה ברשימה 👀`,
                    text: `המארגנים כבר הוסיפו את ${twin.person}${twin.m.display_name !== twin.person ? ` (בפרופיל ${twin.m.display_name})` : ''}. זה את/ה? אם כן — נכנסים לפרופיל הזה, בלי כפילות בחשבון.`,
                    confirmText: 'זה אני!',
                    cancelText: 'לא, מישהו אחר',
                  });
                  if (me_) return join(null, { member: twin.m, person: twin.person });
                }
                return join(!choice && cleanPhone(account?.phone) && profile && !profile.phone ? { ...profile, phone: cleanPhone(account.phone) } : profile);
              }} />
            ${unclaimed.length
              ? html`<button type="button" class="link onb-back-link" onClick=${() => setChoice(undefined)}><${Icon} name="arrow-right" size=${18} /> חזרה לבחירת פרופיל</button>`
              : null}
          </div>`}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Link another device to an existing profile
// ---------------------------------------------------------------------------

function LinkDevice({ code }) {
  const api = useStore((s) => s.api);
  const [phase, setPhase] = useState('confirm'); // confirm | busy | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const cleanCode = String(code || '').trim().toLowerCase();

  const link = async () => {
    setPhase('busy');
    try {
      const res = await api.linkDevice(cleanCode);
      await actions.loadTrips();
      const snap = await actions.openTrip(res.trip_id, { force: true });
      const member = snap?.members?.find((m) => m.id === res.member_id) || null;
      setResult({ tripId: res.trip_id, member, trip: snap?.trip || null });
      setPhase('done');
      fireConfetti();
    } catch (e) {
      setError(toApiError(e));
      setPhase('error');
    }
  };

  return html`<div class="onb onb--flow">
    <${Hero} compact>
      <div class="onb-brand onb-brand--small">
        <p class="onb-brand__name">מדורה</p>
        <p class="onb-brand__tag">כל החבר'ה סביב המדורה</p>
      </div>
    </${Hero}>
    <div class="onb__body onb__body--lift">
      ${phase === 'done' && result
        ? html`<div class="card link-card link-card--done">
            <${Avatar} member=${result.member} size=${80} />
            <h1 class="h2">מחוברים! 🎉</h1>
            <p class="muted">מעכשיו המכשיר הזה מחובר לפרופיל של <strong>${displayName(result.member)}</strong>${result.trip ? html` בטיול <strong>${result.trip.name}</strong>` : null}.</p>
            <${Button} size="lg" block icon="arrow-left" onClick=${() => navigate(`/t/${result.tripId}`)}>לטיול</${Button}>
          </div>`
        : phase === 'error'
          ? html`<${Card}>
              <${EmptyState}
                emoji="🔗"
                title=${error?.code === 'network' ? 'אין חיבור כרגע' : 'הקוד לא עובד'}
                text=${error?.code === 'network' ? hebrewError('network') : 'אולי הוא כבר לא בתוקף. בקשו קישור חדש ממסך "הפרופיל שלי" במכשיר המקורי.'}
                action=${html`<div class="row row--center wrap">
                  ${error?.code === 'network' ? html`<${Button} icon="refresh" onClick=${link}>לנסות שוב</${Button}>` : null}
                  <${Button} variant="ghost" href="#/">למסך הראשי</${Button}>
                </div>`}
              />
            </${Card}>`
          : html`<div class="card link-card">
              <div class="link-card__emoji" aria-hidden="true">📱✨</div>
              <h1 class="h2">מחברים מכשיר נוסף</h1>
              <p class="muted">המכשיר הזה יחובר לפרופיל קיים בטיול — מושלם לבן/בת הזוג או לטלפון נוסף. הכל יסתנכרן אוטומטית.</p>
              <${Button} size="lg" block variant="accent" loading=${phase === 'busy'} onClick=${link}>חברו את המכשיר</${Button}>
              <${Button} variant="ghost" block href="#/">לא עכשיו</${Button}>
            </div>`}
    </div>
  </div>`;
}
