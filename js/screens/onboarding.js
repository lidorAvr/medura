// Onboarding (SPEC §8.1): landing / new trip / join ("מי אתם?") / link device.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { actions, useStore } from '../store.js?v=71bed20';
import { navigate, href } from '../router.js?v=71bed20';
import { hebrewError, toApiError } from '../api/errors.js?v=71bed20';
import {
  buildInviteText, countdown, displayName, formatDate, formatTime, hebrewCount, inviteUrl, isAdmin,
} from '../lib/logic.js?v=71bed20';
import {
  Avatar, Button, Card, ColorPicker, CopyButton, EmojiPicker, EmptyState, Field, Pill, ShareButton, Skeleton, TextInput,
  fireConfetti,
} from '../ui/components.js?v=71bed20';
import { Icon } from '../ui/icons.js?v=71bed20';
import { EmailGate, linkThisDevice } from '../ui/email-gate.js?v=71bed20';
import { Entry } from '../ui/account.js?v=71bed20';
import { MODULES, TRIP_TYPES, tripSeed } from '../lib/templates.js?v=71bed20';

const cx = (...a) => a.filter(Boolean).join(' ');
const PROFILE_EMOJIS = ['⛺', '🔥', '🌲', '🦊', '🐻', '🦉', '🦔', '🐢', '🦎', '🌙', '⭐', '🍉', '🥩', '🍺', '🎸', '🏕️', '🌈', '🐬', '🦄', '🌵'];
const TRIP_EMOJIS = ['✈️', '🥂', '🏡', '👨‍👩‍👧', '💼', '🥾', '⛺', '🏕️', '🔥', '🌲', '🏖️', '🌊', '⛰️', '🏜️', '🚐', '🎒', '🌄', '🛶', '🎉', '🌙'];
const COLORS = ['#2F6B4F', '#F28C28', '#E4572E', '#3A86FF', '#8E44AD', '#16A085', '#D4A017', '#C0392B', '#2C3E50', '#FF6B9A'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const baseUrl = () => `${location.origin}${location.pathname}`;

export default function OnboardingScreen({ route }) {
  switch (route.name) {
    case 'join':
      return html`<${Entry} requireVerified><${Join} code=${route.params.code} switchMode=${route.query?.switch === '1'} /></${Entry}>`;
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

function dateRange(trip) {
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

function Hero({ compact, children }) {
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

function TripCard({ entry }) {
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

function CodeEntry({ startOpen }) {
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

function Landing({ openCode }) {
  const trips = useStore((s) => s.trips);
  const has = trips.length > 0;
  return html`<div class="onb onb--landing">
    <${Hero}>
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
        : html`<${Intro} />`}
      <div class="stack">
        <${Button} variant="accent" size="lg" block icon="plus" href="#/new">צור טיול חדש</${Button}>
        <${CodeEntry} startOpen=${openCode} />
        <${Button} variant="ghost" block href="#/signin">🔑 כבר הצטרפתי ממכשיר אחר — התחברות עם המייל</${Button}>
      </div>
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
    <div class="profile-preview" aria-live="polite">
      <${Avatar} member=${preview} size=${72} />
      <div class="profile-preview__text">
        <div class=${cx('profile-preview__name', !display && 'is-placeholder')}>${preview.display_name}</div>
        <div class="profile-preview__meta">
          <${Pill} tone="primary">${couple ? (headcount > 2 ? `👨‍👩‍👧 ${headcount} אנשים` : '👫 זוג · 2 אנשים') : '🧍 מגיע/ה לבד'}</${Pill}>
        </div>
      </div>
    </div>

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
      : html`<button type="button" class="link onb-rename" onClick=${() => {
          setCustom(auto);
          setEditName(true);
        }}>✏️ רוצים שם תצוגה אחר?</button>`}

    <${Field} label="האימוג׳י שלכם">
      <${EmojiPicker} value=${emoji} onChange=${setEmoji} label="האימוג׳י שלכם" />
    </${Field}>

    <${Field} label="הצבע שלכם">
      <${ColorPicker} value=${color} onChange=${setColor} label="הצבע שלכם" />
    </${Field}>

    <${Button} type="submit" variant="accent" size="lg" block loading=${busy}>${submitLabel}</${Button}>
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

function TripTicket({ trip }) {
  const when = trip.startDate
    ? dateRange({ starts_at: jerusalemIso(trip.startDate, trip.startTime), ends_at: jerusalemIso(trip.endDate, trip.endTime) })
    : 'מתי? עוד נחליט 🙂';
  return html`<div class="ticket" aria-hidden="true">
    <span class="ticket__emoji">${trip.emoji}</span>
    <span class="ticket__main">
      <span class="ticket__name">${trip.name.trim() || 'הטיול שלכם'}</span>
      <span class="ticket__meta">${[when, trip.location.trim()].filter(Boolean).join(' · ')}</span>
    </span>
  </div>`;
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
    <div class="card invite-card">
      <div class="invite-card__head">
        <span class="kbd-emoji" aria-hidden="true">${trip.emoji || '⛺'}</span>
        <div class="invite-card__title">
          <strong>${trip.name}</strong>
          <span class="muted small">קישור ההזמנה</span>
        </div>
      </div>
      <div class="invite-card__link" dir="ltr"><bdi>${url}</bdi></div>
      <div class="stack-sm">
        <${ShareButton} text=${text} label="שלחו הזמנה בוואטסאפ" size="lg" block />
        <${CopyButton} text=${url} label="העתקת הקישור" block />
      </div>
    </div>
    <p class="muted small invite-step__tip">💡 טיפ: אפשר להוסיף מראש פרופילים לחברים במסך חבר'ה — ככה הם רק לוחצים "זה אנחנו!"</p>
    <${Button} size="lg" block icon="arrow-left" onClick=${() => navigate(`/t/${trip.id}`)}>יאללה, לטיול</${Button}>
  </div>`;
}

function NewTrip() {
  const [step, setStep] = useState(1);
  const [trip, setTrip] = useState({ type: '', name: '', emoji: '⛺', location: '', startDate: '', startTime: '09:00', endDate: '', endTime: '12:00' });
  const type = TRIP_TYPES.find((x) => x.key === trip.type) || null;
  const pickType = (x) => {
    setTrip((t) => ({ ...t, type: x.key, emoji: x.emoji }));
    if (errors.type) setErrors({ ...errors, type: undefined });
  };
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState(null);

  const set = (key, value) => {
    setTrip((t) => {
      const next = { ...t, [key]: value };
      if (key === 'startDate' && value && (!t.endDate || t.endDate < value)) next.endDate = addDays(value, 1);
      return next;
    });
    if (errors[key]) setErrors({ ...errors, [key]: undefined });
  };

  const next = (e) => {
    e.preventDefault();
    const errs = {};
    const name = trip.name.trim();
    if (!trip.type) errs.type = 'איזה טיול? בחרו אחד — אפשר לשנות הכל אחר כך';
    if (!name) errs.name = 'איך נקרא לטיול? 🙂';
    else if (name.length > 60) errs.name = 'עד 60 תווים';
    if (trip.endDate && !trip.startDate) errs.startDate = 'מתי יוצאים?';
    if (trip.startDate && trip.endDate) {
      const s = jerusalemIso(trip.startDate, trip.startTime);
      const en = jerusalemIso(trip.endDate, trip.endTime);
      if (en < s) errs.endDate = 'החזרה לפני היציאה? 🙃';
    }
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) {
      focusFirstInvalid();
      return;
    }
    setStep(2);
    window.scrollTo(0, 0);
  };

  const create = async (profile) => {
    setBusy(true);
    const seed = tripSeed(trip.type);
    const payload = {
      name: trip.name.trim(),
      emoji: trip.emoji,
      location: trip.location.trim() || null,
      starts_at: jerusalemIso(trip.startDate, trip.startTime),
      ends_at: jerusalemIso(trip.endDate, trip.endTime),
      settings: seed.settings,
      info: seed.info,
      categories: seed.categories,
    };
    const res = await actions.run((api) => api.createTrip(payload, profile), { refresh: false });
    if (!res?.trip_id) {
      setBusy(false);
      return;
    }
    // the type's ready-made lists (a failure here isn't fatal — the trip exists, the lists can be filled later)
    if (seed.items.length) {
      await actions.run(async (api) => { await api.addItemsBulk(res.trip_id, seed.items); return true; }, { refresh: false })
        .catch(() => null);
    }
    await actions.loadTrips();
    await actions.openTrip(res.trip_id, { force: true });
    setBusy(false);
    setCreatedId(res.trip_id);
    setStep(3);
    window.scrollTo(0, 0);
    fireConfetti();
  };

  return html`<div class="onb onb--flow">
    <div class="onb-flow__top">
      ${step === 1 ? html`<${BackBar} to="/" label="חזרה למסך הראשי" />` : null}
      ${step === 2 ? html`<${BackBar} label="חזרה לפרטי הטיול" onClick=${() => setStep(1)} />` : null}
      <${StepDots} step=${step} labels=${['הטיול', 'הפרופיל שלך', 'הזמנה']} />
    </div>
    <div class="onb__body">
    ${step === 1
      ? html`<form class="stack-lg" onSubmit=${next} noValidate>
          <div class="onb-flow__title">
            <h1>טיול חדש ⛺</h1>
            <p class="muted">כמה פרטים קטנים וממשיכים. אפשר לשנות הכל אחר כך.</p>
          </div>
          <section class="trip-types" aria-labelledby="trip-type-h">
            <h2 class="field__label" id="trip-type-h">איזה טיול?</h2>
            <div class="trip-types__grid" role="radiogroup" aria-label="סוג הטיול">
              ${TRIP_TYPES.map((x) => html`<button type="button" role="radio" key=${x.key} aria-checked=${trip.type === x.key ? 'true' : 'false'}
                class=${cx('trip-type', trip.type === x.key && 'is-on')} onClick=${() => pickType(x)} data-type=${x.key}>
                <span class="trip-type__emoji" aria-hidden="true">${x.emoji}</span>
                <span class="trip-type__label">${x.label}</span>
                <span class="trip-type__hint">${x.hint}</span>
              </button>`)}
            </div>
            ${errors.type ? html`<p class="field__error" role="alert">${errors.type}</p>` : null}
            ${type
              ? html`<p class="trip-types__gets" data-testid="type-gets">
                  מקבלים מוכן: ${hebrewCount(type.items.length, 'פריט ברשימות', 'פריטים ברשימות')} · רשימת אריזה אישית (${type.packing.length}) · לו״ז בלחיצה
                  ${MODULES.filter((m) => type.modules[m.key] !== false).map((m) => ` · ${m.emoji} ${m.label}`).join('')}
                  <span class="muted"> — הכל ניתן לשינוי.</span>
                </p>`
              : null}
          </section>
          <${TripTicket} trip=${trip} />
          <${Field} label="איך קוראים לטיול?" error=${errors.name}>
            <${TextInput}
              value=${trip.name}
              maxlength="60"
              placeholder=${type ? type.placeholder : 'למשל: טיול לפארק החבשושיות'}
              onInput=${(e) => set('name', e.target.value)}
            />
          </${Field}>
          <${Field} label="אימוג׳י לטיול">
            <${EmojiPicker} value=${trip.emoji} options=${TRIP_EMOJIS} onChange=${(v) => set('emoji', v)} label="אימוג׳י לטיול" />
          </${Field}>
          <${Field} label="לאן?" hint="שם המקום — נשתמש בו גם לניווט">
            <${TextInput}
              value=${trip.location}
              maxlength="80"
              placeholder="למשל: פארק החבשושיות"
              onInput=${(e) => set('location', e.target.value)}
            />
          </${Field}>
          <div class="date-pair">
            <${Field} label="יוצאים" error=${errors.startDate}>
              <${TextInput} type="date" value=${trip.startDate} onInput=${(e) => set('startDate', e.target.value)} />
            </${Field}>
            <${Field} label="בשעה">
              <${TextInput} type="time" value=${trip.startTime} onInput=${(e) => set('startTime', e.target.value)} />
            </${Field}>
          </div>
          <div class="date-pair">
            <${Field} label="חוזרים" error=${errors.endDate}>
              <${TextInput} type="date" value=${trip.endDate} min=${trip.startDate || undefined} onInput=${(e) => set('endDate', e.target.value)} />
            </${Field}>
            <${Field} label="בשעה">
              <${TextInput} type="time" value=${trip.endTime} onInput=${(e) => set('endTime', e.target.value)} />
            </${Field}>
          </div>
          <${Button} type="submit" size="lg" block icon="arrow-left">המשך</${Button}>
        </form>`
      : null}

    ${step === 2
      ? html`<div class="stack-lg">
          <div class="onb-flow__title">
            <h1>ומי את/ה? 🙂</h1>
            <p class="muted">הפרופיל שלך בטיול. מגיעים בזוג? בחרו "זוג" — ההתחשבנות תספור אתכם כשניים.</p>
          </div>
          <${ProfileForm} submitLabel="צור את הטיול 🔥" busy=${busy} onSubmit=${create} />
          <button type="button" class="link onb-back-link" onClick=${() => setStep(1)}><${Icon} name="arrow-right" size=${18} /> חזרה לפרטי הטיול</button>
        </div>`
      : null}

    ${step === 3 && createdId ? html`<${InviteStep} tripId=${createdId} />` : null}
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

/** Everyone on the trip, one card per person ("עידו", small: "בפרופיל הדס ועידו") — pick yourself, you're in. */
function PeopleGrid({ unclaimed, claimed, busy, onPickPerson, onNew }) {
  const tiles = [];
  for (const m of [...unclaimed, ...claimed]) {
    const people = (m.people || []).filter(Boolean);
    const names = people.length ? people : [displayName(m)];
    const joined = new Set(m.joined || []);
    const isClaimed = claimed.includes(m);
    for (const p of names) {
      const taken = isClaimed && (names.length < 2 || joined.has(p));
      tiles.push({ key: `${m.id}:${p}`, m, person: people.length ? p : null, name: p, taken, multi: names.length > 1 });
    }
  }
  tiles.sort((a, b) => Number(a.taken) - Number(b.taken));
  return html`<section class="stack" aria-labelledby="who-are-you">
    <div>
      <h2 class="h2" id="who-are-you">מי את/ה? 👀</h2>
      <p class="muted small">מוצאים את השם שלך ולוחצים — וזהו, בפנים.</p>
    </div>
    <div class="claim-grid" data-testid="people-grid">
      ${tiles.map((x) => html`<button type="button" key=${x.key} class=${x.taken ? 'claim-tile claim-tile--taken is-in' : 'claim-tile'}
        disabled=${x.taken || busy} data-person=${x.name} onClick=${() => onPickPerson(x.m, x.person)}>
        <${Avatar} member=${{ ...x.m, headcount: 1, claimed: true, display_name: x.name }} size=${54} />
        <span class="claim-tile__name">${x.name}</span>
        ${x.multi ? html`<span class="claim-tile__people">בפרופיל ${displayName(x.m)}</span>` : null}
        <span class="claim-tile__cta">${x.taken ? '✓ כבר בפנים' : 'זה אני!'}</span>
      </button>`)}
      <button type="button" class="claim-tile claim-tile--new" disabled=${busy} onClick=${onNew}>
        <span class="claim-tile__plus" aria-hidden="true">✨</span>
        <span class="claim-tile__name">אני לא ברשימה</span>
        <span class="claim-tile__cta">יצירת פרופיל</span>
      </button>
    </div>
    <div class="claim-signin" data-testid="claim-signin">
      <p><b>כתוב "כבר בפנים" ליד השם שלך?</b> כנראה נכנסת ממכשיר אחר.</p>
      <${Button} variant="secondary" icon="link" href="#/signin">🔑 התחברות עם המייל</${Button}>
    </div>
  </section>`;
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
  const [who, setWho] = useState(people.length ? '' : '__new');
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
    await actions.openTrip(res.trip_id, { force: true });
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
  return html`<div class="onb onb--flow">
    ${header}
    <div class="onb__body onb__body--lift">
      <${JoinTicket} preview=${preview} />
      ${target
        ? html`<${JoinExisting} code=${cleanCode} tripId=${preview.trip.id} target=${target} onBack=${() => setTarget(null)} />`
        : choice === undefined
        ? html`<div class="stack-lg">
            ${switchMode
              ? null
              : html`<${PeopleGrid} unclaimed=${unclaimed} claimed=${preview.claimed || []} busy=${busy}
                  onPickPerson=${(m, person) => join(null, { member: m, person })} onNew=${() => pickProfile(null)} />`}
            <details class="join-more" open=${switchMode}>
              <summary>${switchMode ? 'לאיזה פרופיל מצטרפים?' : 'מצטרפים לפרופיל של מישהו (בן/בת זוג, משפחה)?'}</summary>
              <${ClaimedGrid} claimed=${(preview.claimed || []).filter((m) => m.id !== preview.my_member_id)}
                title=${switchMode ? 'לאיזה פרופיל מצטרפים?' : null} onPick=${(m) => { setTarget(m); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
            </details>
          </div>`
        : html`<div class="stack-lg">
            <div>
              <h2 class="h2">${choice ? 'רק מוודאים שהכל נכון 👌' : 'ספרו לנו עליכם 🙂'}</h2>
              <p class="muted small">${choice ? 'אפשר לתקן שמות, אימוג׳י וצבע. טלפון ומייל — בשלב הבא.' : 'שם, אימוג׳י וצבע — וזהו, אתם בפנים.'}</p>
            </div>
            <${ProfileForm} key=${choice?.id || 'new'} initial=${choice || null} submitLabel="יאללה, נכנסים! 🔥" busy=${busy} onSubmit=${join} />
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
