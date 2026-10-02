// Trip details (SPEC §8.3): when & where, Waze / Maps, weather (Open-Meteo), schedule timeline,
// rules & tips, notes, invite link — and for admins an edit sheet for every trip field
// (`?edit=1&section=schedule|rules|album|money|…` opens it at that section). After the trip the page reads
// only: the album on top, schedule / rules / notes folded to rows, no weather, navigation, invite or rides.
import { html } from 'htm/preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { actions, useTrip } from '../store.js?v=56bbb9a';
import {
  AIRPORTS, ARRIVAL_MODES, FAMILIES, MODULES, arrivalOf, composeType, dayCount, hasLists, hasModule, resolveType, schedulePlan,
  schedulePresets,
} from '../lib/templates.js?v=56bbb9a';
import { hasCoords as placeHasCoords, navLinks as placeNavLinks } from '../lib/places.js?v=56bbb9a';
import { PlaceInput } from '../ui/place-input.js?v=56bbb9a';
import { CURRENCIES } from '../lib/fx.js?v=56bbb9a';
import { AlbumSheet, BookingsCard, CostsCard, MoreDetails, RoomsCard } from './trip-extras.js?v=56bbb9a';
import { href, navigate } from '../router.js?v=56bbb9a';
import {
  buildInviteText, countdown, displayName, formatDate, formatTime, headcountTotal, hebrewCount, inviteUrl, adminPersons,
  rideModel, tripOver,
} from '../lib/logic.js?v=56bbb9a';
import {
  Avatar, AvatarStack, Button, Card, Chip, CopyButton, EmojiPicker, EmptyState, Field, Fold, IconButton, OverBanner, Sheet,
  ShareButton, Skeleton, TextArea, TextInput, Toggle, confirmDialog,
} from '../ui/components.js?v=56bbb9a';
import { Icon } from '../ui/icons.js?v=56bbb9a';

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

const hasCoords = (trip) => placeHasCoords(trip);

/** Waze / Google Maps links (coords first, else the location text) + the admin's own link (places.js). */
const navLinks = (trip) => placeNavLinks(trip);

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
// schedule model: rows may carry `day` (1..60, design §6); rows without it keep the old rule —
// a time that goes "backwards" rolls over to the next day.
// ---------------------------------------------------------------------------

const WEEKDAY_LETTERS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const MAX_DAY = 60;

/** A schedule row's `day` when it's a valid one (integer 1..60), else null. */
function rowDay(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,2}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAY ? n : null;
}

/** "ה׳ 1.10" for a YYYY-MM-DD. */
function shortDay(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return '';
  const wd = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return `${WEEKDAY_LETTERS[wd]} ${Number(m[3])}.${Number(m[2])}`;
}

/**
 * Orders rows with days: by day, then by time inside the day (a row without a time keeps its place after the
 * row before it). `dayOf(row)` is the row's day; the list is the rows in their stored order.
 */
function orderByDay(list, dayOf, timeOf) {
  let lastTime = '';
  const keyed = list.map((r, i) => {
    const t = normalizeTime(timeOf(r));
    if (t) lastTime = t;
    return { r, i, day: dayOf(r), t: t || lastTime };
  });
  keyed.sort((a, b) => a.day - b.day || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0) || a.i - b.i);
  return keyed.map((k) => k.r);
}

/**
 * Days (1-based) for a list of rows: a row's own `day`, else the rollover rule from the row before it,
 * capped at `max`. Returns a parallel array.
 */
function effectiveDays(list, max = MAX_DAY) {
  let day = 1;
  let prev = null;
  return list.map((r) => {
    const own = rowDay(r.day);
    const hm = normalizeTime(r.time);
    if (own) {
      if (own !== day) prev = null;
      day = own;
    } else if (hm && prev && hm < prev) {
      day += 1;
    }
    if (hm) prev = hm;
    return Math.min(day, Math.max(1, max));
  });
}

function scheduleModel(trip, now) {
  const raw = Array.isArray(trip.info?.schedule) ? trip.info.schedule : [];
  const start = toDate(trip.starts_at);
  const startYmd = start ? wall(start).ymd : null;
  const kept = raw
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r && (String(r.label ?? '').trim() || normalizeTime(r.time)));
  const byDay = kept.some(({ r }) => rowDay(r.day));
  let ordered;
  if (byDay) {
    const eff = effectiveDays(kept.map((k) => k.r));
    const withDay = kept.map((k, idx) => ({ ...k, d: eff[idx] }));
    ordered = orderByDay(withDay, (k) => k.d, (k) => k.r.time);
  } else {
    let day = 1;
    let prev = null;
    ordered = kept.map((k) => {
      const hm = normalizeTime(k.r.time);
      if (hm && prev && hm < prev) day++;
      if (hm) prev = hm;
      return { ...k, d: day };
    });
  }
  const rows = ordered.map(({ r, i, d }) => {
    const hm = normalizeTime(r.time);
    const day = d - 1;
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
  const dayCountSeen = rows.length ? Math.max(...rows.map((r) => r.day)) + 1 : 0;
  const dateLabel = (d) => formatDate(jerusalemIso(addDaysYmd(startYmd, d), '12:00'), { weekday: 'long', day: 'numeric', month: 'numeric' });
  const dayLabel = byDay
    ? (d) => (startYmd ? `יום ${d + 1} · ${dateLabel(d)}` : `יום ${d + 1}`)
    : (d) => (startYmd ? dateLabel(d) : d === 0 ? 'יום ראשון לטיול' : 'למחרת');
  return { rows, multiDay: dayCountSeen > 1, dayLabel, byDay };
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

export default function TripScreen({ route }) {
  const { snap, me, isAdmin } = useTrip();
  const now = useNow();
  const routeTrip = route?.params?.tripId;
  const trip = snap?.trip && (!routeTrip || snap.trip.id === routeTrip) ? snap.trip : null;
  const over = trip ? tripOver(trip, now) : false;
  const weather = useWeather(over ? null : trip);
  const wantsEdit = route?.query?.edit === '1';
  const section = wantsEdit ? route?.query?.section || null : null;
  const [editing, setEditing] = useState(false);
  const [album, setAlbum] = useState(false);
  const [extra, setExtra] = useState({}); // detail cards an admin opened before filling

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
  const hasSched = hasModule(trip, 'schedule') && sched.rows.length > 0;
  const nothingYet = !hasSched && !rules.length && !notes;
  const albumUrl = String(trip.info?.album_url || '').trim();
  // ux T1: while the group is still small, inviting is the admin's next step — right under the hero
  const inviteFirst = isAdmin && headcountTotal(members) < 3;
  const sheets = isAdmin
    ? html`<${EditTripSheet} open=${editing} onClose=${closeEdit} trip=${trip} snap=${snap} section=${section} />
      <${AlbumSheet} open=${album} onClose=${() => setAlbum(false)} trip=${trip} />`
    : null;

  if (over) {
    // ux A3: closing the trip · read only — the album first, the rest one row each
    return html`<div class="screen trip trip--over">
      <${TripHero} trip=${trip} members=${members} now=${now} isAdmin=${isAdmin} onEdit=${openEdit} />
      <${OverBanner} trip=${trip} />
      <${AlbumCard} url=${albumUrl} isAdmin=${isAdmin} onEdit=${() => setAlbum(true)} />
      <${WhenWhere} trip=${trip} isAdmin=${isAdmin} onEdit=${openEdit} readOnly />
      ${hasSched || rules.length || notes
        ? html`<div class="stack-sm" data-testid="trip-folds">
            ${hasSched ? html`<${Fold} emoji="⏰" title="לו״ז" count=${sched.rows.length}><${Timeline} sched=${sched} /></${Fold}>` : null}
            ${rules.length ? html`<${Fold} emoji="📌" title="חשוב לדעת" count=${rules.length}><${RulesList} rules=${rules} /></${Fold}>` : null}
            ${notes ? html`<${Fold} emoji="📝" title="הערות"><p class="trip-notes">${notes}</p></${Fold}>` : null}
          </div>`
        : null}
      ${sheets}
    </div>`;
  }

  return html`<div class="screen trip">
    <${TripHero} trip=${trip} members=${members} now=${now} isAdmin=${isAdmin} onEdit=${openEdit} />
    ${inviteFirst ? html`<${InviteCard} trip=${trip} />` : null}
    ${albumUrl ? html`<${AlbumCard} url=${albumUrl} isAdmin=${isAdmin} onEdit=${() => setAlbum(true)} />` : null}
    <${WhenWhere} trip=${trip} isAdmin=${isAdmin} onEdit=${openEdit} />
    ${weather ? html`<${WeatherCard} days=${weather} />` : null}

    ${!hasModule(trip, 'schedule') ? null : sched.rows.length
      ? html`<${ScheduleCard} sched=${sched} />`
      : isAdmin
        ? html`<${Card} emoji="⏰" title="לו״ז" class="trip-schedule">
            <${EmptyState} emoji="🗓️" title="עוד אין לו״ז" text="מתי יוצאים, מתי על האש ומתי ישנים — שכולם יידעו"
              action=${html`<${Button} size="sm" icon="plus" onClick=${openEdit}>הוספת לו״ז</${Button}>`} />
          </${Card}>`
        : null}

    ${hasModule(trip, 'bookings') ? html`<${BookingsCard} trip=${trip} isAdmin=${isAdmin} force=${extra.bookings} />
      <${CostsCard} trip=${trip} members=${members} isAdmin=${isAdmin} force=${extra.costs} />` : null}
    ${hasModule(trip, 'rooms') ? html`<${RoomsCard} trip=${trip} members=${members} me=${me} isAdmin=${isAdmin} force=${extra.rooms} />` : null}
    ${isAdmin ? html`<${MoreDetails} trip=${trip} open=${extra} onOpen=${(k) => setExtra({ ...extra, [k]: true })} />` : null}

    ${me && hasModule(trip, 'rides') ? html`<${RidesLine} snap=${snap} me=${me} />` : null}

    ${rules.length
      ? html`<${Card} emoji="📌" title="חשוב לדעת" class="trip-rules-card"><${RulesList} rules=${rules} /></${Card}>`
      : null}

    ${notes
      ? html`<${Fold} emoji="📝" title="הערות" class="trip-notes-card"
          meta=${[...notes].length > 16 ? `${[...notes].slice(0, 14).join("")}…` : notes}><p class="trip-notes">${notes}</p></${Fold}>`
      : null}

    ${nothingYet && !isAdmin
      ? html`<${Card}><${EmptyState} emoji="🛠️" title="המנהלים עוד מסדרים את הפרטים" text="לו״ז, חוקים וטיפים יופיעו כאן ברגע שיתעדכנו" /></${Card}>`
      : null}

    ${inviteFirst ? null : html`<${InviteCard} trip=${trip} />`}
    <${AdminsCard} trip=${trip} snap=${snap} isAdmin=${isAdmin} />
    ${sheets}
  </div>`;
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

function TripHero({ trip, members, now, isAdmin, onEdit }) {
  const cd = trip.starts_at ? countdown(trip.starts_at, now, trip.ends_at) : null;
  const heads = headcountTotal(members);
  // one labelled edit button (ux T1) — the page has no second one at the bottom
  return html`<section class="hero trip-hero" aria-labelledby="trip-name">
    ${isAdmin
      ? html`<${Button} variant="ghost" size="sm" icon="edit" class="trip-hero__edit" aria-label="עריכת פרטי הטיול" onClick=${onEdit}>עריכה</${Button}>`
      : null}
    <span class="trip-hero__emoji" aria-hidden="true">${trip.emoji || '⛺'}</span>
    <h1 class="trip-hero__name" id="trip-name">${trip.name}</h1>
    ${cd?.label ? html`<span class="trip-hero__cd">${cd.label}</span>` : null}
    <a class="trip-hero__people" href=${href(`/t/${trip.id}/people`)}>
      <${AvatarStack} members=${members} max=${5} size=${28} />
      <span>${hebrewCount(heads, 'משתתף', 'משתתפים')}</span>
    </a>
  </section>`;
}

/** 📸 The shared album (ux A3/A4): open it; admins add or change the link in a one-field sheet. */
function AlbumCard({ url, isAdmin, onEdit }) {
  return html`<${Card} emoji="📸" title="אלבום הטיול" class="trip-album" data-testid="trip-album">
    ${url
      ? html`<div class="stack-sm">
          <${Button} size="lg" block href=${url} target="_blank" rel="noopener noreferrer">לפתוח את האלבום</${Button}>
          ${isAdmin ? html`<button type="button" class="link small" onClick=${onEdit}>שינוי הקישור לאלבום</button>` : null}
        </div>`
      : isAdmin
        ? html`<${Button} size="lg" block variant="secondary" onClick=${onEdit}>📸 הוספת אלבום משותף</${Button}>`
        : html`<p class="muted small">עוד אין קישור לאלבום. כשהמנהלים יוסיפו אותו, הוא יופיע כאן.</p>`}
  </${Card}>`;
}

/** 🚗 One line instead of the whole rides card (ux T1); the rides tab has the rest. */
function RidesLine({ snap, me }) {
  const model = rideModel(snap, me.id);
  const who = (r) => (r?.driver ? displayName(r.driver) : 'מישהו');
  const coming = me.prefs?.transport?.mode && !model.without.some((m) => m.id === me.id);
  const text = model.myRide
    ? (model.myRide.free ? `ההסעה שלך · ${hebrewCount(model.myRide.free, 'מקום פנוי', 'מקומות פנויים')}` : 'ההסעה שלך · מלאה')
    : model.mySeat ? `יש לך מקום אצל ${who(model.mySeat)}`
      : model.myAsk ? `מחכים לאישור של ${who(model.myAsk)}`
        : model.invites.length ? `הזמנה להצטרף להסעה של ${who(model.invites[0])}`
          : coming ? 'מגיעים בדרך משלכם'
            : model.freeSeats ? `עוד לא סגור איך מגיעים · ${hebrewCount(model.freeSeats, 'מקום פנוי', 'מקומות פנויים')}`
              : 'עוד לא סגור איך מגיעים';
  return html`<div class="list trip-rides-line">
    <a class="list-row" href=${href(`/t/${snap.trip.id}/rides`)} data-testid="trip-rides-line">
      <span aria-hidden="true">🚗</span>
      <span class="list-row__main"><span class="list-row__title">הסעות</span><span class="list-row__sub">${text}</span></span>
      <span class="list-row__end"><${Icon} name="chevron-left" size=${18} /></span>
    </a>
  </div>`;
}

function RulesList({ rules }) {
  return html`<ul class="trip-rules">
    ${rules.map((r, i) => html`<li class="trip-rules__row" key=${i}>
      <span class="trip-rules__emoji" aria-hidden="true">${String(r.emoji ?? '').trim() || '💡'}</span>
      <span class="trip-rules__text">${r.text}</span>
    </li>`)}
  </ul>`;
}

function whenText(iso) {
  return `${formatDate(iso)} · ${formatTime(iso)}`;
}

function WhenWhere({ trip, isAdmin, onEdit, readOnly = false }) {
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
  if (trip.location) {
    const addr = String(trip.address || '').trim();
    facts.push({
      icon: '📍', label: 'איפה',
      value: addr && addr !== trip.location
        ? html`${trip.location}<span class="trip-fact__sub" data-testid="trip-address">${addr}</span>`
        : trip.location,
    });
  }
  const hasNav = !readOnly && (links.waze || links.maps || links.site);

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
    ${hasNav
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
        </div>`
      : null}
    ${cal && !readOnly
      ? html`<p class="small center trip-cal"><a class="link" href=${cal} target="_blank" rel="noopener noreferrer">📅 הוספה ליומן</a></p>`
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
  return html`<${Card} emoji="⏰" title="לו״ז" class="trip-schedule"><${Timeline} sched=${sched} /></${Card}>`;
}

function Timeline({ sched }) {
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
  return html`<ol class="timeline">${items}</ol>`;
}

function InviteCard({ trip }) {
  const url = inviteUrl(`${location.origin}${location.pathname}`, trip.invite_code);
  return html`<${Card} emoji="💌" title="מזמינים את החבר'ה" class="trip-invite">
    <span class="sr-only" dir="ltr" data-testid="invite-link">${url}</span>
    <div class="trip-invite__actions">
      <${ShareButton} text=${buildInviteText(trip, url)} label="שליחה בוואטסאפ" block />
      <${CopyButton} text=${url} label="העתקה" />
    </div>
  </${Card}>`;
}

/** 👑 Who runs the trip: one row to the people tab (ux T1). Admins also see the approval policy there. */
function AdminsCard({ trip, snap, isAdmin }) {
  const admins = adminPersons(snap); // per person: in a couple, only whoever was crowned
  const approval = trip.settings?.require_approval !== false;
  return html`<div class="list trip-admins">
    <a class="list-row" href=${href(`/t/${trip.id}/people`)} data-testid="trip-admins">
      <span aria-hidden="true">👑</span>
      <span class="list-row__main">
        <span class="list-row__title">מנהלים: ${admins.map((a) => a.name).join(', ') || 'עוד אין'}</span>
        ${isAdmin
          ? html`<span class="list-row__sub" data-testid="approval-policy">
              ${approval ? '⏳ פריטים שחברים מציעים מחכים לאישור של מנהל/ת' : '⚡ כל פריט חדש נכנס לרשימה מיד, בלי אישור'}
            </span>`
          : null}
      </span>
      <span class="list-row__end"><${Icon} name="chevron-left" size=${18} /></span>
    </a>
  </div>`;
}

// ---------------------------------------------------------------------------
// admin edit sheet
// ---------------------------------------------------------------------------

let rowSeq = 0;
const rowKey = () => `row-${++rowSeq}`;

const tagSig = (list) => JSON.stringify((Array.isArray(list) ? list : []).map((t) => [t?.e || '', String(t?.n ?? '').trim()]));
const customOf = (d) => (d.subtype === 'custom' ? { label: d.customLabel.trim(), emoji: d.customEmoji.trim() || null } : null);
const composedOf = (d) => composeType(d.family, d.subtype, d.where, customOf(d));

/** Days of the trip in the draft (1 without dates). */
const draftDays = (d) => dayCount(d.startDate || null, d.endDate || d.startDate || null);

/**
 * The schedule editor works by day tabs whenever the trip has more than one day. (A two-day trip used to keep the
 * one-list editor with its hidden "an earlier hour = the next day" rule: a breakfast added after "חזרה 11:00"
 * landed on the day after the trip. Rows without a day get one from that old rule when the editor opens.)
 */
function isTabbed(d) {
  return draftDays(d) >= 2;
}

/**
 * In the day-tab editor every row has a day: rows without one get it from the old rollover rule. A row's own day
 * is never clamped here — dates picked by mistake and then fixed must not move rows; the editor shows rows past
 * the last day on the last tab, and saving (validateDraft) clamps.
 */
function withDays(d) {
  if (!isTabbed(d)) return d;
  const eff = effectiveDays(d.schedule);
  if (d.schedule.every((r, i) => r.day === eff[i])) return d;
  return { ...d, schedule: d.schedule.map((r, i) => ({ ...r, day: eff[i] })) };
}

/** "HH:MM" of the group's flight leg (booking `at` is a local wall clock "YYYY-MM-DDTHH:MM"). */
function flightHm(trip, leg) {
  const list = Array.isArray(trip.info?.bookings) ? trip.info.bookings : [];
  const b = list.find((x) => x?.kind === 'flight' && (x.leg || 'out') === leg && /T\d{2}:\d{2}/.test(String(x.at || '')));
  return b ? normalizeTime(String(b.at).slice(11, 16)) : null;
}

/** "YYYY-MM-DD" departure date of the group's flight leg. */
function flightYmd(trip, leg) {
  const list = Array.isArray(trip.info?.bookings) ? trip.info.bookings : [];
  const b = list.find((x) => x?.kind === 'flight' && (x.leg || 'out') === leg && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(x.at || '')));
  return b ? String(b.at).slice(0, 10) : null;
}

function draftFrom(trip) {
  const start = toDate(trip.starts_at);
  const end = toDate(trip.ends_at);
  const s = start ? wall(start) : null;
  const e = end ? wall(end) : null;
  const kind = resolveType(trip.settings);
  const location = trip.location || '';
  return withDays({
    name: trip.name || '',
    emoji: trip.emoji || '⛺',
    location,
    address: String(trip.address || ''),
    // picked from the OpenStreetMap list (has an address line + coordinates); typing again un-picks it
    placed: hasCoords(trip) && !!String(trip.address || '').trim() && !!location.trim(),
    location_url: trip.location_url || '',
    coords: hasCoords(trip) ? `${Number(trip.lat)}, ${Number(trip.lon)}` : '',
    startDate: s?.ymd || '',
    startTime: s?.hm || '',
    endDate: e?.ymd || '',
    endTime: e?.hm || '',
    schedule: (Array.isArray(trip.info?.schedule) ? trip.info.schedule : []).map((r) => ({
      key: rowKey(), time: normalizeTime(r?.time) || '', emoji: String(r?.emoji ?? ''), label: String(r?.label ?? ''), day: rowDay(r?.day),
    })),
    rules: (Array.isArray(trip.info?.rules) ? trip.info.rules : []).map((r) => ({
      key: rowKey(), emoji: String(r?.emoji ?? ''), text: String(r?.text ?? ''),
    })),
    notes: String(trip.info?.notes ?? ''),
    album_url: String(trip.info?.album_url ?? ''),
    require_approval: trip.settings?.require_approval !== false,
    family: kind.family,
    subtype: kind.subtype,
    where: kind.where,
    customLabel: kind.custom?.label || '',
    customEmoji: kind.custom?.emoji || '',
    modules: Object.fromEntries(MODULES.map((m) => [m.key, hasModule(trip, m.key)])),
    arrival: arrivalOf(trip),
    money: {
      currencies: Array.isArray(trip.settings?.money?.currencies) ? [...trip.settings.money.currencies] : [],
      exempt: Array.isArray(trip.settings?.money?.exempt) ? [...trip.settings.money.exempt] : [],
    },
  });
}

/** Comparable form of a draft (row keys don't count as changes). */
const draftSig = (d) => JSON.stringify({
  ...d,
  schedule: d.schedule.map(({ key, ...r }) => r),
  rules: d.rules.map(({ key, ...r }) => r),
});

const inIsrael = (lat, lon) => lat >= 29.4 && lat <= 33.4 && lon >= 34.2 && lon <= 35.95;

/**
 * "32.09, 34.78", or a Google Maps / Waze link that carries coordinates; null when it can't be read. A number
 * is taken whole (never "32.5" out of "132.5"). In Israel (`where` 'il') a pair in lon,lat order (GeoJSON, OSM
 * tools) is swapped back when only the swapped one is in Israel.
 */
function parseCoords(text, where = 'il') {
  const t = String(text || '').trim();
  if (!t) return { lat: null, lon: null };
  const pair = '(-?\\d{1,2}(?:\\.\\d+)?)\\s*(?:,|%2C)\\s*(-?\\d{1,3}(?:\\.\\d+)?)(?![\\d.])';
  const patterns = [
    new RegExp(`@${pair}`),
    new RegExp(`[?&](?:ll|q|query|destination|daddr)=${pair}`, 'i'),
    new RegExp(`^${pair}$`),
    new RegExp(`(?:^|[^\\d.\\-])${pair}`),
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (!m) continue;
    let lat = Number(m[1]);
    let lon = Number(m[2]);
    if (where !== 'abroad' && !inIsrael(lat, lon) && inIsrael(lon, lat)) [lat, lon] = [lon, lat];
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return { lat, lon };
  }
  return null;
}

const cpLen = (s) => [...String(s)].length;
const LOCATION_MAX = 120; // trips.location on the server
const SCHEDULE_MAX = 60;  // info.schedule rows on the server

function validateDraft(d, trip) {
  const errors = {};
  const name = d.name.trim();
  if (!name) errors.name = 'איך נקרא לטיול?';
  else if (cpLen(name) > 60) errors.name = 'עד 60 תווים';
  if (cpLen(d.location.trim()) > LOCATION_MAX) errors.location = `עד ${LOCATION_MAX} תווים`;
  const url = d.location_url.trim();
  if (url && !/^https:\/\/\S+$/i.test(url)) errors.location_url = 'צריך קישור מלא שמתחיל ב-https://';
  const coords = parseCoords(d.coords, d.where);
  if (!coords) errors.coords = 'לא הצלחנו לזהות קואורדינטות — למשל 32.0853, 34.7818';
  let starts = null;
  let ends = null;
  if (d.startDate) starts = jerusalemIso(d.startDate, normalizeTime(d.startTime) || '09:00');
  if (d.endDate) ends = jerusalemIso(d.endDate, normalizeTime(d.endTime) || '12:00');
  if (!d.startDate && d.startTime) errors.startDate = 'חסר תאריך';
  if (!d.endDate && d.endTime) errors.endDate = 'חסר תאריך';
  if (starts && ends && Date.parse(ends) < Date.parse(starts)) errors.endDate = 'החזרה לפני היציאה 🤔';

  const tabbed = isTabbed(d);
  const n = draftDays(d);
  let schedule = d.schedule
    .map((r) => {
      const row = { time: normalizeTime(r.time) || '', label: r.label.trim(), emoji: r.emoji.trim() };
      if (tabbed) row.day = Math.min(rowDay(r.day) || 1, n);
      return row;
    })
    .filter((r) => r.label);
  if (tabbed) schedule = orderByDay(schedule, (r) => r.day, (r) => r.time);
  if (schedule.some((r) => cpLen(r.label) > 80 || cpLen(r.emoji) > 8)) errors.schedule = 'שורה ארוכה מדי — עד 80 תווים לשורה';
  else if (schedule.length > SCHEDULE_MAX) errors.schedule = `עד ${SCHEDULE_MAX} שורות בלו״ז (יש ${schedule.length}) — כדאי למחוק כמה`;
  const rules = d.rules.map((r) => ({ emoji: r.emoji.trim(), text: r.text.trim() })).filter((r) => r.text);
  if (rules.some((r) => cpLen(r.text) > 200 || cpLen(r.emoji) > 8)) errors.rules = 'טיפ ארוך מדי — עד 200 תווים';
  if (cpLen(d.notes) > 4000) errors.notes = 'עד 4000 תווים';
  const album = d.album_url.trim();
  if (album && (!/^https?:\/\/\S+$/i.test(album) || album.length > 500)) errors.album_url = 'צריך קישור מלא שמתחיל ב-https://';

  const custom = customOf(d);
  if (custom) {
    if (!custom.label) errors.customLabel = 'איך תקראו לזה?';
    else if (cpLen(custom.label) > 30) errors.customLabel = 'עד 30 תווים';
    if (custom.emoji && cpLen(custom.emoji) > 8) errors.customLabel = 'אימוג׳י אחד מספיק';
  }

  // settings are merged key by key on the server — keep what this sheet doesn't edit (arrival.airport, money.tags…)
  const was = trip?.settings || {};
  const before = resolveType(was);
  const kindChanged = before.family !== d.family || before.subtype !== d.subtype || before.where !== d.where;
  const money = { ...(was.money && typeof was.money === 'object' ? was.money : {}), currencies: [...d.money.currencies], exempt: [...d.money.exempt] };
  if (kindChanged) {
    // expense tags follow the new type unless an admin changed them
    const own = was.money?.tags;
    const auto = !Array.isArray(own) || tagSig(own) === tagSig(composeType(before.family, before.subtype, before.where, before.custom).expenseTags);
    if (auto) money.tags = composedOf(d).expenseTags.map((t) => ({ e: t.e, n: t.n }));
  }
  const arrival = { ...(was.arrival && typeof was.arrival === 'object' ? was.arrival : {}), modes: [...d.arrival.modes], flights: !!d.arrival.flights };
  if (d.where === 'abroad' || d.arrival.flights) arrival.airport = /^[A-Z]{3}$/.test(d.arrival.airport || '') ? d.arrival.airport : 'TLV';
  const settings = {
    require_approval: !!d.require_approval,
    type: d.family,
    subtype: d.subtype,
    where: d.where,
    modules: { ...d.modules },
    arrival,
    money,
  };
  if (custom) settings.custom = { label: custom.label, emoji: custom.emoji };
  else if (was.custom) settings.custom = null;

  const place = d.placed && coords && coords.lat !== null;
  const patch = {
    name,
    emoji: d.emoji.trim() || '⛺',
    location: d.location.trim() || null,
    // a pick always keeps an address line (its name when OSM gave none), so it reopens as picked
    address: place ? ((d.address.trim() || d.location.trim()).slice(0, 200) || null) : null,
    location_url: url || null,
    lat: coords ? coords.lat : null,
    lon: coords ? coords.lon : null,
    starts_at: starts,
    ends_at: ends,
    info: { schedule, rules, notes: d.notes.trim(), album_url: album || null },
    settings,
  };
  return { errors, patch };
}

/** Ways to get there offered in the sheet: to the airport for a trip abroad, else the domestic ones (+ any already on). */
function arrivalChoices(d) {
  const keys = d.where === 'abroad' ? ['taxi', 'car', 'drop', 'transit', 'park'] : ['car', 'taxi', 'meet', 'own'];
  return ARRIVAL_MODES.filter((m) => keys.includes(m.key) || d.arrival.modes.includes(m.key));
}

function TripKindPicker({ d, setD, errors, clearError }) {
  const fam = FAMILIES.find((f) => f.key === d.family) || FAMILIES[0];
  const sub = fam.subtypes.find((x) => x.key === d.subtype) || fam.subtypes[0];
  const pick = (familyKey, subKey, where) => setD((x) => {
    const f = FAMILIES.find((y) => y.key === familyKey) || FAMILIES[0];
    const s = f.subtypes.find((y) => y.key === subKey) || f.subtypes[0];
    const w = s.where === 'ask' ? (where || (x.where === 'abroad' ? 'abroad' : 'il')) : s.where;
    const prev = composedOf(x);
    const out = { ...x, family: f.key, subtype: s.key, where: w };
    const next = composedOf(out);
    out.where = next.where;
    if (next.where !== prev.where) {
      out.arrival = { ...x.arrival, modes: [...next.arrival.modes], flights: next.arrival.flights, airport: x.arrival.airport || 'TLV' };
    }
    if (x.emoji === prev.emoji) out.emoji = next.emoji;
    return out;
  });

  return html`<div class="trip-kind" data-testid="trip-kind" data-type=${d.family} data-subtype=${d.subtype} data-where=${d.where}>
    <p class="field__label">איזה טיול?</p>
    <div class="sched-quick" role="group" aria-label="איזה טיול">
      ${FAMILIES.map((f) => html`<${Chip} key=${f.key} active=${f.key === fam.key} data-family=${f.key}
        onClick=${() => f.key !== fam.key && pick(f.key, null, null)}>${f.emoji} ${f.label}</${Chip}>`)}
    </div>
    <p class="field__label">ואיזה סוג?</p>
    <div class="sched-quick" role="group" aria-label="איזה סוג">
      ${fam.subtypes.map((s) => html`<${Chip} key=${s.key} active=${s.key === sub.key} data-subtype=${s.key}
        onClick=${() => s.key !== sub.key && pick(fam.key, s.key, null)}>${s.emoji} ${s.label}</${Chip}>`)}
    </div>
    ${sub.where === 'ask'
      ? html`<p class="field__label">איפה?</p>
        <div class="sched-quick" role="group" aria-label="בארץ או בחו״ל">
          <${Chip} active=${d.where !== 'abroad'} data-where="il" onClick=${() => d.where === 'abroad' && pick(fam.key, sub.key, 'il')}>🇮🇱 בארץ</${Chip}>
          <${Chip} active=${d.where === 'abroad'} data-where="abroad" onClick=${() => d.where !== 'abroad' && pick(fam.key, sub.key, 'abroad')}>✈️ בחו״ל</${Chip}>
        </div>`
      : null}
    ${sub.key === 'custom'
      ? html`<div class="trip-kind__custom">
          <${Field} label="איך תקראו לזה?" error=${errors.customLabel}>
            <${TextInput} value=${d.customLabel} maxlength="30" placeholder="למשל: סופ״ש גולף"
              onInput=${(e) => { const v = e.target.value; setD((x) => ({ ...x, customLabel: v })); clearError('customLabel'); }} />
          </${Field}>
          <${Field} label="אימוג׳י">
            <${TextInput} value=${d.customEmoji} maxlength="8" placeholder="⛳" class="trip-kind__emoji"
              onInput=${(e) => { const v = e.target.value; setD((x) => ({ ...x, customEmoji: v })); clearError('customLabel'); }} />
          </${Field}>
        </div>`
      : null}
    <p class="trip-edit__hint trip-kind__hint">משנה הצעות, לו״ז מוכן ודרכי הגעה — הרשימות נשארות כמו שהן.</p>
  </div>`;
}

/** Schedule rows editor (the rows given; `day` for new rows when the editor works by days). */
function ScheduleRows({ rows, setRow, dropRow, addRow, clearError, error, day }) {
  return html`<div class="row-editor" role="group" aria-label=${day ? `שורות הלו״ז, יום ${day}` : 'שורות הלו״ז'}>
    ${rows.map((r, i) => html`<div class="row-editor__row row-editor__row--sched" key=${r.key} data-row=${r.key}>
      <${TextInput} type="time" value=${r.time} aria-label=${`שעה, שורה ${i + 1}`} class="row-editor__time"
        onInput=${(e) => setRow('schedule', r.key, { time: e.target.value })} />
      <${TextInput} value=${r.emoji} aria-label=${`אימוג׳י, שורה ${i + 1}`} placeholder="🔥" maxlength="8" class="row-editor__emoji"
        onInput=${(e) => setRow('schedule', r.key, { emoji: e.target.value })} />
      <${TextInput} value=${r.label} aria-label=${`מה קורה, שורה ${i + 1}`} placeholder="מה קורה?" maxlength="80" class="row-editor__text"
        onInput=${(e) => { setRow('schedule', r.key, { label: e.target.value }); clearError('schedule'); }} />
      <${IconButton} icon="trash" label=${`מחיקת שורה ${i + 1} בלו״ז`} class="row-editor__del" onClick=${() => dropRow('schedule', r.key)} />
    </div>`)}
    ${error ? html`<span class="field__error" role="alert">${error}</span>` : null}
    <${Button} variant="ghost" size="sm" icon="plus" class="row-editor__add"
      onClick=${() => addRow('schedule', { time: '', emoji: '', label: '', day: day || null })}>הוספת שורה ללו״ז</${Button}>
  </div>`;
}

const FILL_ALL_MAX = 7; // longer trips: "fill all" does the first and last day, the rest go day by day

function ScheduleEditor({ d, setD, trip, errors, clearError, setRow, dropRow, addRow, activeDay, setActiveDay }) {
  const composed = composedOf(d);
  const abroad = composed.where === 'abroad';
  const sHm = (abroad && flightHm(trip, 'out')) || normalizeTime(d.startTime) || null;
  const eHm = (abroad && flightHm(trip, 'back')) || normalizeTime(d.endTime) || null;
  const tabbed = isTabbed(d);

  if (!tabbed) {
    const presets = schedulePresets(composed, sHm, eHm);
    return html`<section class="trip-edit__group">
      <h3 class="trip-edit__h">⏰ לו״ז</h3>
      <p class="trip-edit__hint">לוחצים על מה שיש בטיול — ומשנים שעה רק אם צריך. שעה מוקדמת מהשורה שלפניה = למחרת.</p>
      <div class="sched-quick" role="group" aria-label="הוספה מהירה ללו״ז" data-testid="sched-quick">
        ${presets.map((p) => {
          const has = d.schedule.some((r) => r.label.trim() === p.label);
          return html`<${Chip} key=${p.label} active=${has} onClick=${() => setD((x) => ({
            ...x,
            schedule: has
              ? x.schedule.filter((r) => r.label.trim() !== p.label)
              : [...x.schedule, { key: rowKey(), time: p.time, emoji: p.emoji, label: p.label, day: null }],
          }))}>${p.emoji} ${p.label}</${Chip}>`;
        })}
      </div>
      ${d.schedule.length
        ? null
        : html`<${Button} variant="secondary" size="sm" class="sched-quick__all"
            onClick=${() => setD((x) => ({ ...x, schedule: presets.map((p) => ({ key: rowKey(), ...p, day: null })) }))}>
            ✨ לו״ז מוכן — רק לעדכן שעות
          </${Button}>`}
      <${ScheduleRows} rows=${d.schedule} setRow=${setRow} dropRow=${dropRow} addRow=${addRow} clearError=${clearError} error=${errors.schedule} />
    </section>`;
  }

  const lastYmd = abroad ? flightYmd(trip, 'back') : null;
  const plan = schedulePlan(composed, { startYmd: d.startDate || null, startHm: sHm, endYmd: d.endDate || null, endHm: eHm, lastYmd });
  const n = plan.length;
  const active = Math.min(Math.max(1, activeDay), n);
  const today = plan[active - 1];
  const dayOf = (r) => Math.min(rowDay(r.day) || 1, n);
  const rowsOf = (day) => d.schedule.filter((r) => dayOf(r) === day);
  const addPresets = (sched, p) => {
    const have = new Set(sched.filter((r) => dayOf(r) === p.day).map((r) => r.label.trim()));
    const room = Math.max(0, SCHEDULE_MAX - sched.filter((r) => r.label.trim()).length);  // the server keeps ≤60 rows
    const add = p.presets.filter((x) => !have.has(x.label)).slice(0, room)
      .map((x) => ({ key: rowKey(), time: x.time, emoji: x.emoji, label: x.label, day: p.day }));
    return [...sched, ...add];
  };
  const fillDay = (p) => setD((x) => ({ ...x, schedule: addPresets(x.schedule, p) }));
  const fillAll = () => setD((x) => {
    let sched = x.schedule;
    for (const p of plan) if (n <= FILL_ALL_MAX || p.day === 1 || p.day === n) sched = addPresets(sched, p);
    return { ...x, schedule: sched };
  });
  const onTabKey = (e) => {
    const step = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0; // RTL: left = next day
    let to = null;
    if (step) to = ((active - 1 + step + n) % n) + 1;
    else if (e.key === 'Home') to = 1;
    else if (e.key === 'End') to = n;
    if (to === null) return;
    e.preventDefault();
    setActiveDay(to);
    requestAnimationFrame(() => document.getElementById(`sched-tab-${to}`)?.focus());
  };
  const dayRows = rowsOf(active);

  return html`<section class="trip-edit__group" data-testid="sched-by-day">
    <h3 class="trip-edit__h">⏰ לו״ז</h3>
    <p class="trip-edit__hint">יום־יום: בוחרים יום, לוחצים על מה שיש בו — ומשנים שעה רק אם צריך.</p>
    <div class="sched-days" role="tablist" aria-label="ימי הטיול" data-testid="sched-days" onKeyDown=${onTabKey}>
      ${plan.map((p) => {
        const count = rowsOf(p.day).length;
        const on = p.day === active;
        return html`<button type="button" role="tab" key=${p.day} id=${`sched-tab-${p.day}`} class=${cx('sched-day', on && 'is-active')}
          aria-selected=${on ? 'true' : 'false'} aria-controls="sched-day-panel" tabindex=${on ? 0 : -1} data-day=${p.day} data-kind=${p.kind}
          onClick=${() => setActiveDay(p.day)}>
          <span class="sched-day__n">יום ${p.day}</span>
          ${p.ymd ? html`<span class="sched-day__d num">${shortDay(p.ymd)}</span>` : null}
          ${count ? html`<span class="sched-day__count num" aria-label=${`${count} שורות`}>${count}</span>` : null}
        </button>`;
      })}
    </div>
    <div class="sched-day-panel" role="tabpanel" id="sched-day-panel" aria-labelledby=${`sched-tab-${active}`} data-day=${active}>
      <p class="sched-day-panel__title">${today.label}${today.ymd ? html` <span class="muted">· ${shortDay(today.ymd)}</span>` : null}</p>
      <div class="sched-quick" role="group" aria-label=${`הוספה מהירה ליום ${active}`} data-testid="sched-quick">
        ${today.presets.map((p) => {
          const has = dayRows.some((r) => r.label.trim() === p.label);
          return html`<${Chip} key=${p.label} active=${has} onClick=${() => setD((x) => ({
            ...x,
            schedule: has
              ? x.schedule.filter((r) => !(dayOf(r) === active && r.label.trim() === p.label))
              : [...x.schedule, { key: rowKey(), time: p.time, emoji: p.emoji, label: p.label, day: active }],
          }))}>${p.emoji} ${p.label}</${Chip}>`;
        })}
        ${today.presets.every((p) => dayRows.some((r) => r.label.trim() === p.label))
          ? null
          : html`<${Chip} class="sched-quick__day" onClick=${() => fillDay(today)}>✨ יום מלא</${Chip}>`}
      </div>
      <${ScheduleRows} rows=${dayRows} day=${active} setRow=${setRow} dropRow=${dropRow} addRow=${addRow} clearError=${clearError} error=${errors.schedule} />
    </div>
    <${Button} variant="secondary" size="sm" class="sched-quick__all" data-testid="sched-fill-all" onClick=${fillAll}>✨ למלא את כל הימים</${Button}>
    ${n > FILL_ALL_MAX ? html`<p class="trip-edit__hint">טיול ארוך: ממלאים את היום הראשון והאחרון — ושאר הימים ב״✨ יום מלא״ בכל יום.</p>` : null}
  </section>`;
}

/** Sections of the edit sheet a link can open at (`?edit=1&section=…`, ux T2); the rest open at the top. */
const EDIT_SECTIONS = ['details', 'when', 'where', 'schedule', 'rules', 'notes', 'album', 'modules', 'money', 'settings'];

function EditTripSheet({ open, onClose, trip, snap, section = null }) {
  const [d, setD] = useState(() => draftFrom(trip));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeDay, setActiveDay] = useState(1);
  const [moreOpen, setMoreOpen] = useState(false);
  const initial = useRef('');
  const focusKey = useRef(null);
  const placeRef = useRef(null);

  // The place field's name comes from our own label ("מקום"), so the suggestions list keeps its own name.
  useLayoutEffect(() => {
    const input = placeRef.current?.querySelector('.place__input');
    if (input && input.getAttribute('aria-labelledby') !== 'trip-place-label') input.setAttribute('aria-labelledby', 'trip-place-label');
  });

  useLayoutEffect(() => {
    if (!open) return;
    const fresh = draftFrom(trip);
    initial.current = draftSig(fresh);
    setD(fresh);
    setErrors({});
    setSaving(false);
    setActiveDay(1);
    // hand-typed coordinates or an own link live under "עוד" — open it when there's something there
    setMoreOpen((!!fresh.coords && !fresh.placed) || !!fresh.location_url);
  }, [open]);

  // Opened at a section (ux T2): scroll it to the top of the sheet and put the cursor in its first field.
  useEffect(() => {
    if (!open || !EDIT_SECTIONS.includes(section)) return undefined;
    const t = setTimeout(() => {
      const form = document.querySelector('.trip-edit-sheet');
      const el = form?.querySelector(`[data-section="${section}"]`)
        || (section === 'money' ? form?.querySelector('[data-section="modules"]') : null);
      if (!el) return;
      el.scrollIntoView({ block: 'start' });
      const field = el.querySelector('input:not([type=hidden]), textarea, [role=switch], button');
      field?.focus({ preventScroll: true });
    }, 90); // after the sheet's own first focus (40ms)
    return () => clearTimeout(t);
  }, [open, section]);

  // New dates that turn the editor into day tabs: give every row its day.
  useEffect(() => {
    if (!open) return;
    setD((x) => withDays(x));
  }, [open, d.startDate, d.endDate]);

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

  const onPlace = (place, text) => {
    if (place) {
      set({
        location: [...String(place.name || '')].slice(0, LOCATION_MAX).join(''), placed: true,
        address: String(place.address || place.name || ''),
        coords: hasCoords(place) ? `${Number(place.lat)}, ${Number(place.lon)}` : '',
      });
      setErrors((e) => ({ ...e, location: undefined, coords: undefined }));
      return;
    }
    // typing again un-picks: the old place's coordinates and address go with it
    setD((x) => ({ ...x, location: text ?? '', ...(x.placed && (text ?? '') !== x.location ? { placed: false, address: '', coords: '' } : {}) }));
    clearError('location');
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
    const { errors: errs, patch } = validateDraft(d, trip);
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) {
      if (errs.coords || errs.location_url) setMoreOpen(true);
      requestAnimationFrame(() => {
        const el = document.querySelector('.trip-edit [aria-invalid="true"], .trip-edit .field__error');
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (el?.matches?.('input,textarea')) el.focus({ preventScroll: true });
      });
      return;
    }
    setSaving(true);
    // The trip moved to other days: its rides move with it, and — when the whole trip moved (the end by the same
    // number of days) — its flights and lodging too (the server shifts them). A trip that only got longer or
    // shorter moves no flight: say what to check instead.
    const dayN = (iso) => Date.parse(`${new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' })}T00:00:00Z`) / 86400000;
    const startBy = patch.starts_at && trip.starts_at ? Math.round(dayN(patch.starts_at) - dayN(trip.starts_at)) : 0;
    const endBy = patch.ends_at && trip.ends_at ? Math.round(dayN(patch.ends_at) - dayN(trip.ends_at)) : startBy;
    const booked = (Array.isArray(trip.info?.bookings) && trip.info.bookings.length > 0)
      || (snap?.members || []).some((m) => m.prefs?.travel?.out?.flight || m.prefs?.travel?.back?.flight);
    const riding = (snap?.rides || []).some((r) => r.depart_at);
    const note = startBy && startBy === endBy && (booked || riding) ? ' הטיסות, הלינה וההסעות זזו עם התאריכים — כדאי לוודא אותן'
      : (startBy || endBy) && booked ? ' התאריכים השתנו — כדאי לבדוק את הטיסות והלינה'
        : startBy && riding ? ' ההסעות זזו עם התאריך — כדאי לוודא אותן' : '';
    const res = await actions.run((api) => api.updateTrip(trip.id, patch), { success: `פרטי הטיול עודכנו ✅${note}` });
    setSaving(false);
    if (res !== undefined) onClose();
  };

  const deleteTrip = async () => {
    if (saving || deleting) return;
    const count = (list) => (Array.isArray(list) ? list.length : 0);
    const yes = await confirmDialog({
      title: `למחוק את "${trip.name}"?`,
      // items of a feature that's off are hidden here, but they go too: no count that looks smaller
      text: `הטיול יימחק לכולם, כולל ${hebrewCount(count(snap?.members), 'משתתף/ת', 'משתתפים')}, `
        + (hasLists(trip) && hasModule(trip, 'lists') && hasModule(trip, 'tasks') && hasModule(trip, 'packing')
          ? `${hebrewCount(count(snap?.items), 'פריט', 'פריטים')}` : 'כל הרשימות (גם מה שמוסתר)')
        + ` ו-${hebrewCount(count(snap?.expenses), 'הוצאה', 'הוצאות')}. `
        + 'אי אפשר לשחזר.',
      confirmText: 'מחיקה לצמיתות',
      cancelText: 'ביטול',
      danger: true,
    });
    if (!yes) return;
    setDeleting(true);
    const done = await actions.run(async (api) => { await api.deleteTrip(trip.id); return true; },
      { success: 'הטיול נמחק 🗑️', refresh: false });
    if (!done) {
      setDeleting(false);
      return;
    }
    navigate('/', { replace: true });
    actions.closeTrip();
    actions.loadTrips();
  };

  const abroad = d.where === 'abroad';
  const coordsNow = parseCoords(d.coords, d.where);
  const near = abroad && coordsNow && coordsNow.lat !== null ? coordsNow : null;

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
      <section class="trip-edit__group" data-section="details">
        <h3 class="trip-edit__h">✨ הטיול</h3>
        <${Field} label="שם הטיול" error=${errors.name}>
          <${TextInput} value=${d.name} maxlength="60" onInput=${(e) => { set({ name: e.target.value }); clearError('name'); }} />
        </${Field}>
        <${Field} label="אימוג׳י">
          <${EmojiPicker} value=${d.emoji} options=${TRIP_EMOJIS.includes(d.emoji) ? TRIP_EMOJIS : [d.emoji, ...TRIP_EMOJIS]}
            onChange=${(emoji) => set({ emoji })} label="אימוג׳י לטיול" />
        </${Field}>
        <${TripKindPicker} d=${d} setD=${setD} errors=${errors} clearError=${clearError} />
      </section>

      <section class="trip-edit__group" data-section="when">
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

      <section class="trip-edit__group trip-edit__where" data-section="where">
        <h3 class="trip-edit__h">📍 איפה</h3>
        <div class="trip-edit__place" ref=${placeRef}>
          <span class="field__label" id="trip-place-label" onClick=${() => placeRef.current?.querySelector('.place__input')?.focus()}>מקום</span>
          <${PlaceInput} text=${d.location} onChange=${onPlace} maxlength=${LOCATION_MAX} where=${abroad ? 'abroad' : 'il'} near=${near}
            placeholder=${abroad ? 'עיר או מדינה — למשל: אתונה' : 'חניון, חוף, יישוב…'} testid="trip-place" />
        </div>
        ${errors.location ? html`<span class="field__error" role="alert">${errors.location}</span>` : null}
        ${d.placed && d.location.trim()
          ? html`<p class="trip-edit__placed" data-testid="trip-place-picked">
              <span aria-hidden="true">✅</span>
              <span>${(d.address.trim() !== d.location.trim() && d.address.trim()) || 'נבחר מהרשימה'} <span class="muted">· ניווט ותחזית מוכנים</span></span>
            </p>`
          : html`<p class="trip-edit__hint">בוחרים מהרשימה — בשביל ניווט ותחזית. אפשר גם סתם לכתוב.</p>`}
        <details class="trip-edit__more" open=${moreOpen} onToggle=${(e) => setMoreOpen(e.currentTarget.open)}>
          <summary>מתקדם: קישור מגוגל מפות או Waze</summary>
          <div class="trip-edit__more-body">
            <${Field} label="קואורדינטות (לניווט ולתחזית)" hint="אפשר להדביק קישור מגוגל מפות או מ-Waze" error=${errors.coords}>
              <${TextInput} value=${d.coords} dir="ltr" inputmode="decimal" autocomplete="off" placeholder="32.0853, 34.7818"
                onInput=${(e) => { set({ coords: e.target.value }); clearError('coords'); }} />
            </${Field}>
            <${Field} label="קישור למקום (לא חובה)" error=${errors.location_url}>
              <${TextInput} type="url" value=${d.location_url} placeholder="https://…" autocomplete="off"
                onInput=${(e) => { set({ location_url: e.target.value }); clearError('location_url'); }} />
            </${Field}>
          </div>
        </details>
      </section>

      ${!d.modules.schedule ? null : html`<div data-section="schedule"><${ScheduleEditor} d=${d} setD=${setD} trip=${trip} errors=${errors} clearError=${clearError}
        setRow=${setRow} dropRow=${dropRow} addRow=${addRow} activeDay=${activeDay} setActiveDay=${setActiveDay} /></div>`}

      <section class="trip-edit__group" data-section="rules">
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

      <section class="trip-edit__group" data-section="notes">
        <h3 class="trip-edit__h">📝 הערות</h3>
        <${Field} label="הערות לכולם" error=${errors.notes}>
          <${TextArea} value=${d.notes} rows=${3} maxlength="4000" placeholder="חניה, כרטיסים, מה חשוב לזכור…"
            onInput=${(e) => { set({ notes: e.target.value }); clearError('notes'); }} />
        </${Field}>
        <div data-section="album">
          <${Field} label="📸 קישור לאלבום תמונות משותף (לא חובה)" hint="Google Photos / iCloud — יופיע לכולם אחרי הטיול" error=${errors.album_url}>
            <${TextInput} type="url" dir="ltr" value=${d.album_url} placeholder="https://photos.app.goo.gl/…" autocomplete="off"
              onInput=${(e) => { set({ album_url: e.target.value }); clearError('album_url'); }} />
          </${Field}>
        </div>
      </section>

      <section class="trip-edit__group" data-testid="trip-modules" data-section="modules">
        <h3 class="trip-edit__h">🧩 מה יש בטיול</h3>
        <p class="trip-edit__hint">מה שכבוי נעלם מהתפריט ומהמסכים — לכולם. אפשר להדליק שוב בכל רגע, שום דבר לא נמחק.</p>
        ${MODULES.map((m) => html`<${Toggle} key=${m.key}
          checked=${d.modules[m.key]}
          onChange=${(v) => set({ modules: { ...d.modules, [m.key]: v } })}
          label=${`${m.emoji} ${m.label}`}
          hint=${m.hint}
        />`)}
        ${d.modules.rides
          ? html`<div class="trip-edit__sub" data-testid="arrival-modes">
              <p class="field__label">${abroad ? 'איך מגיעים לשדה? (אפשר כמה)' : 'איך מגיעים? (אפשר כמה)'}</p>
              <div class="sched-quick" role="group" aria-label="דרכי הגעה">
                ${arrivalChoices(d).map((m) => {
                  const on = d.arrival.modes.includes(m.key);
                  return html`<${Chip} key=${m.key} active=${on} data-mode=${m.key} onClick=${() => {
                    const modes = on ? d.arrival.modes.filter((x) => x !== m.key) : [...d.arrival.modes, m.key];
                    if (modes.length) set({ arrival: { ...d.arrival, modes } });
                  }}>${m.emoji} ${m.label}</${Chip}>`;
                })}
              </div>
              <${Toggle} checked=${d.arrival.flights} onChange=${(v) => set({ arrival: { ...d.arrival, flights: v } })}
                label="✈️ טיסות" hint="כל אחד מסמן את הטיסה שלו, ורואים מי טס עם מי" />
            </div>`
          : null}
        ${d.arrival.flights || abroad
          ? html`<div class="trip-edit__sub" data-testid="trip-airport">
              <p class="field__label">🛫 מאיזה שדה ממריאים?</p>
              <div class="sched-quick" role="group" aria-label="שדה תעופה">
                ${[...AIRPORTS, ...(AIRPORTS.some((a) => a.iata === d.arrival.airport) || !d.arrival.airport ? [] : [{ iata: d.arrival.airport, label: d.arrival.airport }])]
                  .map((a) => html`<${Chip} key=${a.iata} active=${(d.arrival.airport || 'TLV') === a.iata} data-airport=${a.iata}
                    onClick=${() => set({ arrival: { ...d.arrival, airport: a.iata } })}>${a.label} <span class="num" dir="ltr">${a.iata}</span></${Chip}>`)}
              </div>
            </div>`
          : null}
        ${d.modules.money
          ? html`<div class="trip-edit__sub" data-testid="money-options" data-section="money">
              <p class="field__label">💱 מטבעות זרים (השער לפי יום ההוצאה, אוטומטית)</p>
              <div class="sched-quick" role="group" aria-label="מטבעות">
                ${CURRENCIES.map((c) => {
                  const on = d.money.currencies.includes(c.code);
                  return html`<${Chip} key=${c.code} active=${on} onClick=${() => {
                    const list = on ? d.money.currencies.filter((x) => x !== c.code) : [...d.money.currencies, c.code].slice(0, 6);
                    set({ money: { ...d.money, currencies: list } });
                  }}>${c.symbol} ${c.label}</${Chip}>`;
                })}
              </div>
              <p class="field__label">🎁 פטורים מההוצאות המשותפות (לא חובה)</p>
              <p class="trip-edit__hint">למשל החתן/הכלה. הוצאה של "כולם" מתחלקת בין השאר; אפשר גם לבחור בכל הוצאה על מי היא.</p>
              <div class="sched-quick" role="group" aria-label="פטורים">
                ${(snap?.members || []).map((m) => {
                  const on = d.money.exempt.includes(m.id);
                  return html`<${Chip} key=${m.id} active=${on} onClick=${() => set({ money: { ...d.money,
                    exempt: on ? d.money.exempt.filter((x) => x !== m.id) : [...d.money.exempt, m.id] } })}>${displayName(m)}</${Chip}>`;
                })}
              </div>
            </div>`
          : null}
      </section>

      <section class="trip-edit__group" data-section="settings">
        <h3 class="trip-edit__h">⚙️ הגדרות</h3>
        <${Toggle}
          checked=${d.require_approval}
          onChange=${(v) => set({ require_approval: v })}
          label="הצעות של חברים מחכות לאישור"
          hint="כשכבוי — כל פריט שמישהו מוסיף נכנס לרשימה מיד"
        />
      </section>
    </form>

    <section class="trip-edit__group trip-edit__danger" aria-labelledby="trip-delete-h">
      <h3 class="trip-edit__h" id="trip-delete-h">🗑️ מחיקת הטיול</h3>
      <p class="trip-edit__hint">מוחק לכולם את הטיול, כולל כל הרשימות, ההוצאות וההודעות. אי אפשר לשחזר.</p>
      <${Button} variant="danger" icon="trash" loading=${deleting} disabled=${saving} onClick=${deleteTrip}>מחיקת הטיול</${Button}>
    </section>
  </${Sheet}>`;
}
