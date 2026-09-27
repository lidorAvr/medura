// Trip details (SPEC §8.3): when & where, Waze / Maps, weather (Open-Meteo), schedule timeline,
// rules & tips, notes, invite link — and for admins an edit sheet for every trip field.
import { html } from 'htm/preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { actions, useTrip } from '../store.js';
import { href, navigate } from '../router.js';
import {
  buildInviteText, countdown, displayName, formatDate, formatTime, headcountTotal, hebrewCount, inviteUrl, isAdmin as memberIsAdmin,
} from '../lib/logic.js';
import {
  Avatar, AvatarStack, Button, Card, CopyButton, EmojiPicker, EmptyState, Field, IconButton, Sheet, ShareButton, Skeleton,
  TextArea, TextInput, Toggle, confirmDialog,
} from '../ui/components.js';

const cx = (...a) => a.filter(Boolean).join(' ');
const TZ = 'Asia/Jerusalem';
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const TRIP_EMOJIS = ['⛺', '🏕️', '🔥', '🌲', '🏖️', '🌊', '⛰️', '🏜️', '🚐', '🎒', '🌄', '🛶', '🎉', '🌙'];
const WEATHER_TTL_MS = 30 * 60 * 1000;
const WEATHER_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Asia/Jerusalem date helpers
// ---------------------------------------------------------------------------

let wallFmt = null;
/** {ymd:'YYYY-MM-DD', hm:'HH:MM'} of an instant, as a wall clock in Israel. */
function wall(date) {
  wallFmt ||= new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const part of wallFmt.formatToParts(date)) p[part.type] = part.value;
  return { ymd: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

/** Israel wall-clock date + time → ISO instant (DST aware). */
function jerusalemIso(ymd, hm = '00:00') {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  const target = Date.UTC(y, m - 1, d, hh || 0, mm || 0);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const w = wall(new Date(guess));
    const [wy, wmo, wd] = w.ymd.split('-').map(Number);
    const [wh, wmin] = w.hm.split(':').map(Number);
    const next = target - (Date.UTC(wy, wmo - 1, wd, wh, wmin) - guess);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString();
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const toDate = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

function normalizeTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function useNow(ms = 60000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ---------------------------------------------------------------------------
// links: navigation + calendar
// ---------------------------------------------------------------------------

const hasCoords = (trip) => trip?.lat != null && trip?.lon != null && Number.isFinite(Number(trip.lat)) && Number.isFinite(Number(trip.lon));

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Waze / Google Maps links (coords first, else the location text) + the admin's own link. */
function navLinks(trip) {
  const q = String(trip.location || '').trim();
  let waze = null;
  let maps = null;
  let site = null;
  if (hasCoords(trip)) {
    const ll = `${Number(trip.lat)},${Number(trip.lon)}`;
    waze = `https://waze.com/ul?ll=${ll}&navigate=yes`;
    maps = `https://www.google.com/maps/search/?api=1&query=${ll}`;
  } else if (q) {
    waze = `https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`;
    maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }
  const own = /^https?:\/\/\S+$/i.test(trip.location_url || '') ? trip.location_url : null;
  if (own) {
    const host = hostOf(own);
    if (/(^|\.)waze\.com$/.test(host)) waze = own;
    else if (/(^|\.)google\.[a-z.]+$/.test(host) || /(^|\.)goo\.gl$/.test(host)) maps = own;
    else site = own;
  }
  return { waze, maps, site };
}

function calendarUrl(trip) {
  const start = toDate(trip.starts_at);
  if (!start) return null;
  const endRaw = toDate(trip.ends_at);
  const end = endRaw && endRaw > start ? endRaw : new Date(start.getTime() + 3 * HOUR_MS);
  const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${trip.emoji || '⛺'} ${trip.name}`,
    dates: `${stamp(start)}/${stamp(end)}`,
    details: `כל הרשימות והפרטים במדורה 🔥\n${location.origin}${location.pathname}#/t/${trip.id}/trip`,
    location: trip.location || '',
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

// ---------------------------------------------------------------------------
// weather (Open-Meteo; a bonus — any failure simply hides the card)
// ---------------------------------------------------------------------------

const WMO = [
  [[0], '☀️', 'שמשי'],
  [[1], '🌤️', 'בהיר ברובו'],
  [[2], '⛅', 'מעונן חלקית'],
  [[3], '☁️', 'מעונן'],
  [[45, 48], '🌫️', 'ערפל'],
  [[51, 53, 55, 56, 57], '🌦️', 'טפטוף'],
  [[61, 63, 65, 66, 67], '🌧️', 'גשם'],
  [[71, 73, 75, 77, 85, 86], '🌨️', 'שלג'],
  [[80, 81, 82], '🌦️', 'ממטרים'],
  [[95, 96, 99], '⛈️', 'סופות רעמים'],
];
function wmo(code) {
  const hit = WMO.find(([codes]) => codes.includes(code));
  return hit ? { emoji: hit[1], text: hit[2] } : { emoji: '🌡️', text: '' };
}

/** Dates to forecast: only with coordinates, not over yet, starting within 14 days. */
function weatherRange(trip, now = new Date()) {
  if (!hasCoords(trip)) return null;
  const start = toDate(trip.starts_at);
  if (!start) return null;
  const endRaw = toDate(trip.ends_at);
  const end = endRaw && endRaw >= start ? endRaw : start;
  if (end.getTime() < now.getTime() || start.getTime() - now.getTime() > 14 * DAY_MS) return null;
  const today = wall(now).ymd;
  let s = wall(start).ymd;
  if (s < today) s = today;
  let e = wall(end).ymd;
  const cap = addDaysYmd(s, 6); // a week is plenty for a trip card
  const max = addDaysYmd(today, 14); // the API forecasts ~16 days ahead
  if (e > cap) e = cap;
  if (e > max) e = max;
  if (e < s) e = s;
  return { lat: Math.round(Number(trip.lat) * 1e4) / 1e4, lon: Math.round(Number(trip.lon) * 1e4) / 1e4, start: s, end: e };
}

function weatherUrl(r) {
  return 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${r.lat}&longitude=${r.lon}`
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code'
    + `&timezone=Asia%2FJerusalem&start_date=${r.start}&end_date=${r.end}`;
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseWeather(data) {
  const d = data?.daily;
  if (!d || !Array.isArray(d.time)) return null;
  const days = d.time
    .map((date, i) => ({
      date,
      max: numOrNull(d.temperature_2m_max?.[i]),
      min: numOrNull(d.temperature_2m_min?.[i]),
      rain: numOrNull(d.precipitation_probability_max?.[i]),
      code: numOrNull(d.weather_code?.[i]),
    }))
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x.date)) && x.max !== null && x.min !== null);
  return days.length ? days : null;
}

function readWeatherCache(key) {
  try {
    const raw = sessionStorage.getItem(`medura:wx:${key}`);
    const v = raw ? JSON.parse(raw) : null;
    return v && Date.now() - v.at < WEATHER_TTL_MS && Array.isArray(v.days) ? v.days : null;
  } catch {
    return null;
  }
}
function writeWeatherCache(key, days) {
  try {
    sessionStorage.setItem(`medura:wx:${key}`, JSON.stringify({ at: Date.now(), days }));
  } catch {
    /* storage blocked — no cache, no problem */
  }
}

function useWeather(trip) {
  const range = trip ? weatherRange(trip) : null;
  const key = range ? `${range.lat},${range.lon},${range.start},${range.end}` : null;
  const [state, setState] = useState(() => (key ? { key, days: readWeatherCache(key) } : null));
  useEffect(() => {
    if (!key) {
      setState(null);
      return undefined;
    }
    const cached = readWeatherCache(key);
    if (cached) {
      setState({ key, days: cached });
      return undefined;
    }
    setState({ key, days: null });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT_MS);
    fetch(weatherUrl(range), { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const days = parseWeather(data);
        if (!days) return;
        writeWeatherCache(key, days);
        setState({ key, days });
      })
      .catch(() => {
        /* offline / blocked / timed out: the trip page works fine without weather */
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [key]);
  return state && state.key === key ? state.days : null;
}

function weatherTips(days) {
  const hot = Math.max(...days.map((d) => d.max));
  const cold = Math.min(...days.map((d) => d.min));
  const rain = Math.max(...days.map((d) => d.rain ?? 0));
  const tips = [];
  if (hot >= 30) tips.push('🧴 חם! קרם הגנה, כובע והרבה מים');
  if (cold <= 14) tips.push('🧥 קריר בלילה — להביא שכבה חמה לשינה');
  if (rain >= 40) tips.push('☔ יש סיכוי לגשם — יריעה או גזיבו יעזרו');
  if (!tips.length) tips.push('😎 מזג אוויר מושלם לקמפינג');
  return tips;
}

// ---------------------------------------------------------------------------
// schedule model (times that go "backwards" roll over to the next day)
// ---------------------------------------------------------------------------

function scheduleModel(trip, now) {
  const raw = Array.isArray(trip.info?.schedule) ? trip.info.schedule : [];
  const start = toDate(trip.starts_at);
  const startYmd = start ? wall(start).ymd : null;
  let day = 0;
  let prev = null;
  const rows = raw
    .filter((r) => r && (String(r.label ?? '').trim() || normalizeTime(r.time)))
    .map((r, i) => {
      const hm = normalizeTime(r.time);
      if (hm && prev && hm < prev) day++;
      if (hm) prev = hm;
      const at = startYmd && hm ? Date.parse(jerusalemIso(addDaysYmd(startYmd, day), hm)) : null;
      return { i, hm, day, at, label: String(r.label ?? '').trim(), emoji: String(r.emoji ?? '').trim(), state: '' };
    });
  const endMs = toDate(trip.ends_at)?.getTime() ?? (start ? start.getTime() + DAY_MS : null);
  const t = now.getTime();
  const live = !!start && t >= start.getTime() - 6 * HOUR_MS && endMs !== null && t <= endMs;
  if (live) {
    let current = -1;
    rows.forEach((r, idx) => {
      if (r.at !== null && r.at <= t) current = idx;
    });
    const next = rows.findIndex((r) => r.at !== null && r.at > t);
    rows.forEach((r, idx) => {
      if (idx === current) r.state = 'now';
      else if (idx === next) r.state = 'next';
      else if (r.at !== null && r.at <= t) r.state = 'past';
    });
  }
  const dayCount = rows.length ? Math.max(...rows.map((r) => r.day)) + 1 : 0;
  const dayLabel = (d) => (startYmd
    ? formatDate(jerusalemIso(addDaysYmd(startYmd, d), '12:00'), { weekday: 'long', day: 'numeric', month: 'numeric' })
    : d === 0 ? 'יום ראשון לטיול' : 'למחרת');
  return { rows, multiDay: dayCount > 1, dayLabel };
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

export default function TripScreen({ route }) {
  const { snap, isAdmin } = useTrip();
  const now = useNow();
  const routeTrip = route?.params?.tripId;
  const trip = snap?.trip && (!routeTrip || snap.trip.id === routeTrip) ? snap.trip : null;
  const weather = useWeather(trip);
  const wantsEdit = route?.query?.edit === '1';
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (wantsEdit && isAdmin && trip) setEditing(true);
  }, [wantsEdit, isAdmin, !!trip]);

  if (!trip) {
    return html`<div class="screen trip" aria-busy="true">
      <div class="trip-skel-hero" role="status" aria-label="טוען…"><span class="skeleton__line" style="width:30%;height:44px"></span><span class="skeleton__line" style="width:70%;height:24px"></span></div>
      <${Skeleton} lines=${4} />
      <${Skeleton} lines=${6} />
    </div>`;
  }

  const openEdit = () => setEditing(true);
  const closeEdit = () => {
    setEditing(false);
    if (wantsEdit) navigate(`/t/${trip.id}/trip`, { replace: true });
  };

  const members = snap.members || [];
  const sched = scheduleModel(trip, now);
  const rules = (Array.isArray(trip.info?.rules) ? trip.info.rules : []).filter((r) => r && String(r.text ?? '').trim());
  const notes = String(trip.info?.notes ?? '').trim();
  const nothingYet = !sched.rows.length && !rules.length && !notes;

  return html`<div class="screen trip">
    <${TripHero} trip=${trip} members=${members} now=${now} isAdmin=${isAdmin} onEdit=${openEdit} />
    <${WhenWhere} trip=${trip} isAdmin=${isAdmin} onEdit=${openEdit} />
    ${weather ? html`<${WeatherCard} days=${weather} />` : null}

    ${sched.rows.length
      ? html`<${ScheduleCard} sched=${sched} />`
      : isAdmin
        ? html`<${Card} emoji="⏰" title="לו״ז" class="trip-schedule">
            <${EmptyState} emoji="🗓️" title="עוד אין לו״ז" text="מתי יוצאים, מתי על האש ומתי ישנים — שכולם יידעו"
              action=${html`<${Button} size="sm" icon="plus" onClick=${openEdit}>הוספת לו״ז</${Button}>`} />
          </${Card}>`
        : null}

    ${rules.length
      ? html`<${Card} emoji="📌" title="חשוב לדעת" class="trip-rules-card">
          <ul class="trip-rules">
            ${rules.map((r, i) => html`<li class="trip-rules__row" key=${i}>
              <span class="trip-rules__emoji" aria-hidden="true">${String(r.emoji ?? '').trim() || '💡'}</span>
              <span class="trip-rules__text">${r.text}</span>
            </li>`)}
          </ul>
        </${Card}>`
      : null}

    ${notes
      ? html`<${Card} emoji="📝" title="הערות" class="trip-notes-card"><p class="trip-notes">${notes}</p></${Card}>`
      : null}

    ${nothingYet && !isAdmin
      ? html`<${Card}><${EmptyState} emoji="🛠️" title="המנהלים עוד מסדרים את הפרטים" text="לו״ז, חוקים וטיפים יופיעו כאן ברגע שיתעדכנו" /></${Card}>`
      : null}

    <${InviteCard} trip=${trip} />
    <${AdminsCard} trip=${trip} members=${members} />

    ${isAdmin
      ? html`<${Button} variant="secondary" size="lg" block icon="edit" onClick=${openEdit}>עריכת פרטי הטיול</${Button}>
        <${EditTripSheet} open=${editing} onClose=${closeEdit} trip=${trip} />`
      : null}
  </div>`;
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

function TripHero({ trip, members, now, isAdmin, onEdit }) {
  const cd = trip.starts_at ? countdown(trip.starts_at, now, trip.ends_at) : null;
  const heads = headcountTotal(members);
  return html`<section class="hero trip-hero" aria-labelledby="trip-name">
    ${isAdmin ? html`<${IconButton} icon="edit" label="עריכת פרטי הטיול" class="trip-hero__edit" onClick=${onEdit} />` : null}
    <span class="trip-hero__emoji" aria-hidden="true">${trip.emoji || '⛺'}</span>
    <h1 class="trip-hero__name" id="trip-name">${trip.name}</h1>
    ${cd?.label ? html`<span class="trip-hero__cd">${cd.label}</span>` : null}
    <a class="trip-hero__people" href=${href(`/t/${trip.id}/people`)}>
      <${AvatarStack} members=${members} max=${5} size=${28} />
      <span>${hebrewCount(heads, 'משתתף', 'משתתפים')}</span>
    </a>
  </section>`;
}

function whenText(iso) {
  return `${formatDate(iso)} · ${formatTime(iso)}`;
}

function WhenWhere({ trip, isAdmin, onEdit }) {
  const start = toDate(trip.starts_at);
  const end = toDate(trip.ends_at);
  const sameDay = start && end && wall(start).ymd === wall(end).ymd;
  const links = navLinks(trip);
  const cal = calendarUrl(trip);
  const facts = [];
  if (start && end && sameDay) {
    facts.push({ icon: '📅', label: 'מתי', value: `${formatDate(start)} · ${formatTime(start)}–${formatTime(end)}` });
  } else {
    if (start) facts.push({ icon: '🚗', label: 'יוצאים', value: whenText(start) });
    if (end) facts.push({ icon: '🏡', label: 'חוזרים', value: whenText(end) });
  }
  if (trip.location) facts.push({ icon: '📍', label: 'איפה', value: trip.location });
  const hasNav = links.waze || links.maps || links.site;

  return html`<${Card} emoji="🧭" title="מתי ואיפה" class="trip-where">
    ${facts.length
      ? html`<div class="trip-facts">
          ${facts.map((f) => html`<div class="trip-fact" key=${f.label}>
            <span class="trip-fact__icon" aria-hidden="true">${f.icon}</span>
            <span class="trip-fact__text">
              <span class="trip-fact__label">${f.label}</span>
              <span class="trip-fact__value">${f.value}</span>
            </span>
          </div>`)}
        </div>`
      : html`<p class="muted trip-where__empty">
          ${isAdmin ? 'עוד לא קבעתם תאריך ומקום.' : 'התאריך והמקום עוד לא נקבעו — נעדכן כאן 🙂'}
          ${isAdmin ? html` <button type="button" class="link" onClick=${onEdit}>לקבוע עכשיו</button>` : null}
        </p>`}
    ${hasNav || cal
      ? html`<div class="trip-nav">
          ${links.waze
            ? html`<${Button} variant="secondary" href=${links.waze} target="_blank" rel="noopener noreferrer" icon="🚙" class="trip-nav__btn">ניווט ב-Waze</${Button}>`
            : null}
          ${links.maps
            ? html`<${Button} variant="secondary" href=${links.maps} target="_blank" rel="noopener noreferrer" icon="🗺️" class="trip-nav__btn">גוגל מפות</${Button}>`
            : null}
          ${links.site
            ? html`<${Button} variant="secondary" href=${links.site} target="_blank" rel="noopener noreferrer" icon="link" class="trip-nav__btn">קישור למקום</${Button}>`
            : null}
          ${cal
            ? html`<${Button} variant="ghost" href=${cal} target="_blank" rel="noopener noreferrer" icon="calendar" class="trip-nav__btn">הוספה ליומן</${Button}>`
            : null}
        </div>`
      : null}
  </${Card}>`;
}

function WeatherCard({ days }) {
  const tips = weatherTips(days);
  return html`<${Card} emoji="🌤️" title="מזג האוויר" class="trip-weather" data-testid="weather">
    <div class="wx-days">
      ${days.map((d) => {
        const w = wmo(d.code);
        return html`<div class="wx-day" key=${d.date}>
          <span class="wx-day__name">${formatDate(`${d.date}T12:00:00Z`, { weekday: 'long' })}</span>
          <span class="wx-day__date num">${formatDate(`${d.date}T12:00:00Z`, { day: 'numeric', month: 'numeric' })}</span>
          <span class="wx-day__emoji" role="img" aria-label=${w.text || 'תחזית'}>${w.emoji}</span>
          <span class="wx-day__temp num"><b>${Math.round(d.max)}°</b><span class="wx-day__min">${Math.round(d.min)}°</span></span>
          ${d.rain !== null ? html`<span class="wx-day__rain num">💧 ${Math.round(d.rain)}%</span>` : null}
        </div>`;
      })}
    </div>
    <ul class="wx-tips">${tips.map((t) => html`<li key=${t}>${t}</li>`)}</ul>
    <a class="wx-credit" href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">תחזית: Open-Meteo</a>
  </${Card}>`;
}

function ScheduleCard({ sched }) {
  let lastDay = -1;
  const items = [];
  for (const r of sched.rows) {
    if (sched.multiDay && r.day !== lastDay) {
      lastDay = r.day;
      items.push(html`<li class="tl-day" key=${`d${r.day}`}>${sched.dayLabel(r.day)}</li>`);
    }
    items.push(html`<li class=${cx('tl-row', r.state && `is-${r.state}`)} key=${`r${r.i}`}>
      <span class="tl-time num">${r.hm || ''}</span>
      <span class="tl-dot" aria-hidden="true">${r.emoji || ''}</span>
      <span class="tl-label">${r.label}</span>
      ${r.state === 'now' ? html`<span class="tl-badge tl-badge--now">עכשיו</span>` : null}
      ${r.state === 'next' ? html`<span class="tl-badge">הבא</span>` : null}
    </li>`);
  }
  return html`<${Card} emoji="⏰" title="לו״ז" class="trip-schedule">
    <ol class="timeline">${items}</ol>
  </${Card}>`;
}

function InviteCard({ trip }) {
  const url = inviteUrl(`${location.origin}${location.pathname}`, trip.invite_code);
  return html`<${Card} emoji="💌" title="מזמינים את החבר'ה" class="trip-invite">
    <p class="muted small">מי שמקבל/ת את הקישור בוחר/ת פרופיל ונכנס/ת — בלי הרשמה ובלי סיסמה.</p>
    <div class="trip-invite__link" dir="ltr" data-testid="invite-link">${url}</div>
    <div class="trip-invite__actions">
      <${ShareButton} text=${buildInviteText(trip, url)} label="שליחה בוואטסאפ" block />
      <${CopyButton} text=${url} label="העתקה" />
    </div>
  </${Card}>`;
}

function AdminsCard({ trip, members }) {
  const admins = members.filter(memberIsAdmin);
  const approval = trip.settings?.require_approval !== false;
  return html`<${Card} emoji="👑" title="מי מנהל" class="trip-admins">
    <div class="trip-admins__list">
      ${admins.map((m) => html`<span class="trip-admin" key=${m.id}>
        <${Avatar} member=${m} size=${30} />
        <span class="trip-admin__name">${displayName(m)}</span>
      </span>`)}
    </div>
    <p class="trip-policy" data-testid="approval-policy">
      ${approval ? '⏳ פריטים שחברים מציעים מחכים לאישור של מנהל/ת' : '⚡ כל פריט חדש נכנס לרשימה מיד, בלי אישור'}
    </p>
    <a class="trip-admins__link" href=${href(`/t/${trip.id}/people`)}>בחירת מנהלים 👑 ←</a>
  </${Card}>`;
}

// ---------------------------------------------------------------------------
// admin edit sheet
// ---------------------------------------------------------------------------

let rowSeq = 0;
const rowKey = () => `row-${++rowSeq}`;

function draftFrom(trip) {
  const start = toDate(trip.starts_at);
  const end = toDate(trip.ends_at);
  const s = start ? wall(start) : null;
  const e = end ? wall(end) : null;
  return {
    name: trip.name || '',
    emoji: trip.emoji || '⛺',
    location: trip.location || '',
    location_url: trip.location_url || '',
    coords: hasCoords(trip) ? `${Number(trip.lat)}, ${Number(trip.lon)}` : '',
    startDate: s?.ymd || '',
    startTime: s?.hm || '',
    endDate: e?.ymd || '',
    endTime: e?.hm || '',
    schedule: (Array.isArray(trip.info?.schedule) ? trip.info.schedule : []).map((r) => ({
      key: rowKey(), time: normalizeTime(r?.time) || '', emoji: String(r?.emoji ?? ''), label: String(r?.label ?? ''),
    })),
    rules: (Array.isArray(trip.info?.rules) ? trip.info.rules : []).map((r) => ({
      key: rowKey(), emoji: String(r?.emoji ?? ''), text: String(r?.text ?? ''),
    })),
    notes: String(trip.info?.notes ?? ''),
    require_approval: trip.settings?.require_approval !== false,
  };
}

/** Comparable form of a draft (row keys don't count as changes). */
const draftSig = (d) => JSON.stringify({
  ...d,
  schedule: d.schedule.map(({ key, ...r }) => r),
  rules: d.rules.map(({ key, ...r }) => r),
});

/** "32.09, 34.78", or a Google Maps / Waze link that carries coordinates. */
function parseCoords(text) {
  const t = String(text || '').trim();
  if (!t) return { lat: null, lon: null };
  const pair = '(-?\\d{1,2}(?:\\.\\d+)?)\\s*(?:,|%2C)\\s*(-?\\d{1,3}(?:\\.\\d+)?)';
  const patterns = [
    new RegExp(`@${pair}`),
    new RegExp(`[?&](?:ll|q|query|destination|daddr)=${pair}`, 'i'),
    new RegExp(`^${pair}$`),
    new RegExp(pair),
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (!m) continue;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return { lat, lon };
  }
  return null;
}

const cpLen = (s) => [...String(s)].length;

function validateDraft(d) {
  const errors = {};
  const name = d.name.trim();
  if (!name) errors.name = 'איך נקרא לטיול?';
  else if (cpLen(name) > 60) errors.name = 'עד 60 תווים';
  if (cpLen(d.location.trim()) > 200) errors.location = 'עד 200 תווים';
  const url = d.location_url.trim();
  if (url && !/^https?:\/\/\S+$/i.test(url)) errors.location_url = 'צריך קישור מלא שמתחיל ב-https://';
  const coords = parseCoords(d.coords);
  if (!coords) errors.coords = 'לא הצלחנו לזהות קואורדינטות — למשל 32.0853, 34.7818';
  let starts = null;
  let ends = null;
  if (d.startDate) starts = jerusalemIso(d.startDate, normalizeTime(d.startTime) || '09:00');
  if (d.endDate) ends = jerusalemIso(d.endDate, normalizeTime(d.endTime) || '12:00');
  if (!d.startDate && d.startTime) errors.startDate = 'חסר תאריך';
  if (!d.endDate && d.endTime) errors.endDate = 'חסר תאריך';
  if (starts && ends && Date.parse(ends) < Date.parse(starts)) errors.endDate = 'החזרה לפני היציאה 🤔';
  const schedule = d.schedule
    .map((r) => ({ time: normalizeTime(r.time) || '', label: r.label.trim(), emoji: r.emoji.trim() }))
    .filter((r) => r.label);
  if (schedule.some((r) => cpLen(r.label) > 80 || cpLen(r.emoji) > 8)) errors.schedule = 'שורה ארוכה מדי — עד 80 תווים לשורה';
  const rules = d.rules.map((r) => ({ emoji: r.emoji.trim(), text: r.text.trim() })).filter((r) => r.text);
  if (rules.some((r) => cpLen(r.text) > 200 || cpLen(r.emoji) > 8)) errors.rules = 'טיפ ארוך מדי — עד 200 תווים';
  if (cpLen(d.notes) > 4000) errors.notes = 'עד 4000 תווים';
  const patch = {
    name,
    emoji: d.emoji.trim() || '⛺',
    location: d.location.trim() || null,
    location_url: url || null,
    lat: coords ? coords.lat : null,
    lon: coords ? coords.lon : null,
    starts_at: starts,
    ends_at: ends,
    info: { schedule, rules, notes: d.notes.trim() },
    settings: { require_approval: !!d.require_approval },
  };
  return { errors, patch };
}

function EditTripSheet({ open, onClose, trip }) {
  const [d, setD] = useState(() => draftFrom(trip));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const initial = useRef('');
  const focusKey = useRef(null);

  useLayoutEffect(() => {
    if (!open) return;
    const fresh = draftFrom(trip);
    initial.current = draftSig(fresh);
    setD(fresh);
    setErrors({});
    setSaving(false);
  }, [open]);

  // Focus the first field of a freshly added row.
  useEffect(() => {
    if (!focusKey.current) return;
    const el = document.querySelector(`[data-row="${focusKey.current}"] input`);
    focusKey.current = null;
    el?.focus();
  });

  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const clearError = (k) => errors[k] && setErrors((e) => ({ ...e, [k]: undefined }));
  const setRow = (list, key, patch) => setD((x) => ({ ...x, [list]: x[list].map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const dropRow = (list, key) => setD((x) => ({ ...x, [list]: x[list].filter((r) => r.key !== key) }));
  const addRow = (list, row) => {
    const key = rowKey();
    focusKey.current = key;
    setD((x) => ({ ...x, [list]: [...x[list], { key, ...row }] }));
  };

  const requestClose = async () => {
    if (saving) return;
    if (draftSig(d) !== initial.current) {
      const leave = await confirmDialog({
        title: 'לצאת בלי לשמור?', text: 'השינויים שעשית לא יישמרו.', confirmText: 'לצאת', cancelText: 'להמשיך לערוך', danger: true,
      });
      if (!leave) return;
    }
    onClose();
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (saving) return;
    const { errors: errs, patch } = validateDraft(d);
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) {
      requestAnimationFrame(() => {
        const el = document.querySelector('.trip-edit [aria-invalid="true"], .trip-edit .field__error');
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (el?.matches?.('input,textarea')) el.focus({ preventScroll: true });
      });
      return;
    }
    setSaving(true);
    const res = await actions.run((api) => api.updateTrip(trip.id, patch), { success: 'פרטי הטיול עודכנו ✅' });
    setSaving(false);
    if (res !== undefined) onClose();
  };

  return html`<${Sheet}
    open=${open}
    onClose=${requestClose}
    title="עריכת פרטי הטיול ✏️"
    class="trip-edit-sheet"
    footer=${html`
      <${Button} type="submit" form="trip-edit-form" loading=${saving} icon="check">שמירה</${Button}>
      <${Button} variant="secondary" onClick=${requestClose}>ביטול</${Button}>`}
  >
    <form id="trip-edit-form" class="trip-edit" onSubmit=${submit} noValidate>
      <section class="trip-edit__group">
        <h3 class="trip-edit__h">✨ הטיול</h3>
        <${Field} label="שם הטיול" error=${errors.name}>
          <${TextInput} value=${d.name} maxlength="60" onInput=${(e) => { set({ name: e.target.value }); clearError('name'); }} />
        </${Field}>
        <${Field} label="אימוג׳י">
          <${EmojiPicker} value=${d.emoji} options=${TRIP_EMOJIS.includes(d.emoji) ? TRIP_EMOJIS : [d.emoji, ...TRIP_EMOJIS]}
            onChange=${(emoji) => set({ emoji })} label="אימוג׳י לטיול" />
        </${Field}>
      </section>

      <section class="trip-edit__group">
        <h3 class="trip-edit__h">📅 מתי</h3>
        <div class="grid-2">
          <${Field} label="תאריך יציאה" error=${errors.startDate}>
            <${TextInput} type="date" value=${d.startDate} onInput=${(e) => {
              const v = e.target.value;
              set({ startDate: v, endDate: d.endDate || (v ? addDaysYmd(v, 1) : '') });
              clearError('startDate');
            }} />
          </${Field}>
          <${Field} label="שעת יציאה">
            <${TextInput} type="time" value=${d.startTime} onInput=${(e) => set({ startTime: e.target.value })} />
          </${Field}>
          <${Field} label="תאריך חזרה" error=${errors.endDate}>
            <${TextInput} type="date" value=${d.endDate} onInput=${(e) => { set({ endDate: e.target.value }); clearError('endDate'); }} />
          </${Field}>
          <${Field} label="שעת חזרה">
            <${TextInput} type="time" value=${d.endTime} onInput=${(e) => { set({ endTime: e.target.value }); clearError('endDate'); }} />
          </${Field}>
        </div>
      </section>

      <section class="trip-edit__group">
        <h3 class="trip-edit__h">📍 איפה</h3>
        <${Field} label="מקום" error=${errors.location}>
          <${TextInput} value=${d.location} maxlength="200" placeholder="למשל: פארק החבשושיות" onInput=${(e) => { set({ location: e.target.value }); clearError('location'); }} />
        </${Field}>
        <${Field} label="קואורדינטות (לניווט ולתחזית)" hint="אפשר להדביק קישור מגוגל מפות או מ-Waze" error=${errors.coords}>
          <${TextInput} value=${d.coords} dir="ltr" inputmode="decimal" autocomplete="off" placeholder="32.0853, 34.7818"
            onInput=${(e) => { set({ coords: e.target.value }); clearError('coords'); }} />
        </${Field}>
        <${Field} label="קישור למקום (לא חובה)" error=${errors.location_url}>
          <${TextInput} type="url" value=${d.location_url} placeholder="https://…" autocomplete="off"
            onInput=${(e) => { set({ location_url: e.target.value }); clearError('location_url'); }} />
        </${Field}>
      </section>

      <section class="trip-edit__group">
        <h3 class="trip-edit__h">⏰ לו״ז</h3>
        <p class="trip-edit__hint">שעה מוקדמת מהשורה שלפניה = למחרת.</p>
        <div class="row-editor" role="group" aria-label="שורות הלו״ז">
          ${d.schedule.map((r, i) => html`<div class="row-editor__row row-editor__row--sched" key=${r.key} data-row=${r.key}>
            <${TextInput} type="time" value=${r.time} aria-label=${`שעה, שורה ${i + 1}`} class="row-editor__time"
              onInput=${(e) => setRow('schedule', r.key, { time: e.target.value })} />
            <${TextInput} value=${r.emoji} aria-label=${`אימוג׳י, שורה ${i + 1}`} placeholder="🔥" maxlength="8" class="row-editor__emoji"
              onInput=${(e) => setRow('schedule', r.key, { emoji: e.target.value })} />
            <${TextInput} value=${r.label} aria-label=${`מה קורה, שורה ${i + 1}`} placeholder="מה קורה?" maxlength="80" class="row-editor__text"
              onInput=${(e) => { setRow('schedule', r.key, { label: e.target.value }); clearError('schedule'); }} />
            <${IconButton} icon="trash" label=${`מחיקת שורה ${i + 1} בלו״ז`} class="row-editor__del" onClick=${() => dropRow('schedule', r.key)} />
          </div>`)}
          ${errors.schedule ? html`<span class="field__error" role="alert">${errors.schedule}</span>` : null}
          <${Button} variant="ghost" size="sm" icon="plus" class="row-editor__add"
            onClick=${() => addRow('schedule', { time: '', emoji: '', label: '' })}>הוספת שורה ללו״ז</${Button}>
        </div>
      </section>

      <section class="trip-edit__group">
        <h3 class="trip-edit__h">📌 חשוב לדעת</h3>
        <div class="row-editor" role="group" aria-label="חוקים וטיפים">
          ${d.rules.map((r, i) => html`<div class="row-editor__row row-editor__row--rule" key=${r.key} data-row=${r.key}>
            <${TextInput} value=${r.emoji} aria-label=${`אימוג׳י, טיפ ${i + 1}`} placeholder="💡" maxlength="8" class="row-editor__emoji"
              onInput=${(e) => setRow('rules', r.key, { emoji: e.target.value })} />
            <${TextInput} value=${r.text} aria-label=${`טיפ ${i + 1}`} placeholder="למשל: שקט אחרי 23:00" maxlength="200" class="row-editor__text"
              onInput=${(e) => { setRow('rules', r.key, { text: e.target.value }); clearError('rules'); }} />
            <${IconButton} icon="trash" label=${`מחיקת טיפ ${i + 1}`} class="row-editor__del" onClick=${() => dropRow('rules', r.key)} />
          </div>`)}
          ${errors.rules ? html`<span class="field__error" role="alert">${errors.rules}</span>` : null}
          <${Button} variant="ghost" size="sm" icon="plus" class="row-editor__add"
            onClick=${() => addRow('rules', { emoji: '', text: '' })}>הוספת טיפ</${Button}>
        </div>
      </section>

      <section class="trip-edit__group">
        <h3 class="trip-edit__h">📝 הערות</h3>
        <${Field} label="הערות לכולם" error=${errors.notes}>
          <${TextArea} value=${d.notes} rows=${3} maxlength="4000" placeholder="חניה, כרטיסים, מה חשוב לזכור…"
            onInput=${(e) => { set({ notes: e.target.value }); clearError('notes'); }} />
        </${Field}>
      </section>

      <section class="trip-edit__group">
        <h3 class="trip-edit__h">⚙️ הגדרות</h3>
        <${Toggle}
          checked=${d.require_approval}
          onChange=${(v) => set({ require_approval: v })}
          label="הצעות של חברים מחכות לאישור"
          hint="כשכבוי — כל פריט שמישהו מוסיף נכנס לרשימה מיד"
        />
      </section>
    </form>
  </${Sheet}>`;
}
