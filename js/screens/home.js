// Home (SPEC §8.2): the trip at a glance — countdown hero, readiness, quick actions, latest
// announcement, pending approvals (admins), "my list" with inline done toggles, and what's
// still missing with one-tap "I'm on it".
import { html } from 'htm/preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { actions, useTrip } from '../store.js?v=6582265';
import { href, navigate } from '../router.js?v=6582265';
import {
  balances, buildSummaryText, countdown, displayName, expenseShares, formatDate, formatMoney, formatQty, formatTime, headcountTotal,
  hebrewCount, itemEffectiveQty, itemProgress, membersById, missingItems, myAgenda, similarItems, timeAgo, tripReadiness,
  visibleNotifications, rideModel, tripDayPhase, wazeUrl, tripPhase, myChecklist, tripStats,
} from '../lib/logic.js?v=6582265';
import {
  Avatar, AvatarStack, Button, Card, Chip, EmptyState, Field, MemberPicker, MoneyInput, Pill, ProgressBar, ProgressRing,
  Segmented, ShareButton, Sheet, Skeleton, Stepper, TextArea, TextInput, Toggle, fireConfetti,
} from '../ui/components.js?v=6582265';
import { Icon } from '../ui/icons.js?v=6582265';
import { SimilarItemsNotice, confirmNotDuplicate } from './lists.js?v=6582265';
import { InboxCard } from '../ui/inbox.js?v=6582265';
import { hebrewError } from '../api/errors.js?v=6582265';
import { hasModule, tripSetupGaps } from '../lib/templates.js?v=6582265';

const cx = (...a) => a.filter(Boolean).join(' ');
const MISSING_SHOWN = 6;
const APPROVALS_SHOWN = 5;
const UNITS = ['יח׳', 'ק"ג', 'גרם', 'חבילות', 'בקבוקים', 'שישיות', 'ליטר'];
const TYPE_OPTIONS = [
  { value: 'buy', label: '🛒 לקנות' },
  { value: 'bring', label: '🎒 להביא מהבית' },
  { value: 'each', label: '🙋 כל אחד מביא' },
  { value: 'task', label: '✅ משימה' },
];
// A category hints at the likely item type (until the user picks a type themselves).
const TYPE_BY_CATEGORY_EMOJI = { '⛺': 'bring', '🎲': 'bring', '📋': 'task' };
const REJECT_REASONS = ['כבר יש לנו', 'לא צריך הפעם', 'המקום לא מרשה', 'יקר מדי'];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Re-render every `ms` so the countdown stays live. */
function useNow(ms = 30000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Per-key in-flight tracking: `run(key, fn)` ignores double taps; `busy(key)` drives loading states. */
function useBusy() {
  const keys = useRef(new Set());
  const alive = useRef(true);
  const [, bump] = useState(0);
  useEffect(() => () => {
    alive.current = false;
  }, []);
  const run = async (key, fn) => {
    if (keys.current.has(key)) return undefined;
    keys.current.add(key);
    bump((n) => n + 1);
    try {
      return await fn();
    } finally {
      keys.current.delete(key);
      if (alive.current) bump((n) => n + 1);
    }
  };
  return { run, busy: (key) => keys.current.has(key) };
}

// Remembers per trip whether we already celebrated 100% (storage, with an in-memory fallback).
const celebrated = new Map();
function readFlag(key) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
  } catch {
    /* storage blocked */
  }
  return celebrated.get(key) ?? null;
}
function writeFlag(key, value) {
  celebrated.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}

function greeting(now) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hourCycle: 'h23' }).format(now)) % 24;
  if (h >= 5 && h < 12) return 'בוקר טוב';
  if (h >= 12 && h < 17) return 'צהריים טובים';
  if (h >= 17 && h < 22) return 'ערב טוב';
  return 'לילה טוב';
}

function sortedCategories(snap) {
  return [...(snap.categories || [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
}

function focusInvalid(scope) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`${scope} [aria-invalid="true"]`);
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

export default function HomeScreen({ route }) {
  const { snap, me, isAdmin } = useTrip();
  const now = useNow();
  const { run, busy } = useBusy();
  const [sheet, setSheet] = useState(null); // 'item' | 'expense' | 'announce' | null
  const [rejecting, setRejecting] = useState(null); // item being rejected
  const [optimistic, setOptimistic] = useState({}); // itemId → done (until the snapshot catches up)

  const routeTrip = route?.params?.tripId;
  const ok = !!snap?.trip && (!routeTrip || snap.trip.id === routeTrip);
  const model = useMemo(() => (ok ? buildModel(snap, me) : null), [ok, snap, me]);
  useReadyCelebration(model?.tripId, model?.ready);

  if (!model) return html`<${HomeSkeleton} />`;
  const { trip, tripId } = model;

  const toggleMine = (row) => {
    const next = !row.done;
    const id = row.item.id;
    setOptimistic((o) => ({ ...o, [id]: next }));
    run(`done:${id}`, () => actions.run((api) => (row.kind === 'bring' || row.kind === 'each'
      ? api.setPledgeDone(id, next)
      : api.setItemDone(id, next))))
      .finally(() => setOptimistic((o) => {
        const copy = { ...o };
        delete copy[id];
        return copy;
      }));
  };

  const take = (item, myPledge) => run(`take:${item.id}`, () => {
    if (item.type === 'each') {
      return actions.run((api) => api.setPledgeDone(item.id, true), { success: `✓ ${item.title} — ארוז אצלך` });
    }
    const qty = item.type === 'bring' && myPledge ? (Number(myPledge.qty) || 1) + 1 : 1;
    let success = `סגור! ${item.title} עליך ✋`;
    if (item.type === 'buy') success = `סגור! ${item.title} ברשימת הקניות שלך 🛒`;
    else if (item.type === 'task') success = 'סגור! המשימה עליך 💪';
    else if (myPledge) success = `תודה! עוד ${item.title} עליך ✋`;
    return actions.run((api) => api.pledge(item.id, qty), { success });
  });

  const approve = (item) => run(`ok:${item.id}`, () => actions.run(
    (api) => api.reviewItem(item.id, true, null),
    { success: `אושר ✅ ${item.title} ברשימה` },
  ));

  const phase = tripPhase(trip, now);
  const after = phase === 'after' || phase === 'past';

  return html`<div class=${`screen home home--${phase}`}>
    <${Hero} model=${model} me=${me} now=${now} isAdmin=${isAdmin} />
    <${PhaseStrip} phase=${phase} />

    ${phase === 'during'
      ? html`<${RestCard} snap=${snap} /><${InboxCard} snap=${snap} me=${me} only=${['profile_request']} />`
      : html`
        ${after ? html`<${AfterCard} snap=${snap} me=${me} isAdmin=${isAdmin} />` : html`<${TripDayCard} snap=${snap} me=${me} now=${now} />`}
        <${InboxCard} snap=${snap} me=${me} skip=${['proposals']} />
        ${isAdmin && (phase === 'before' || phase === 'eve') ? html`<${SetupCard} snap=${snap} />` : null}
        ${phase === 'before' || phase === 'eve' ? html`<${ChecklistCard} snap=${snap} me=${me} />` : null}

        ${after
          ? null
          : html`<div class="stack-sm">
              <${Readiness} model=${model} />
              ${hasModule(trip, 'money') ? html`<${MoneyRow} model=${model} />` : null}
            </div>`}

        <${QuickActions}
          isAdmin=${isAdmin}
          proposes=${!isAdmin && trip.settings?.require_approval !== false}
          summary=${model.summary}
          onItem=${() => setSheet('item')}
          onExpense=${hasModule(trip, 'money') ? () => setSheet('expense') : null}
          onAnnounce=${() => setSheet('announce')}
        />

        ${model.news ? html`<${LatestNews} model=${model} />` : null}

        ${isAdmin && model.pending.length && !after
          ? html`<${Approvals} model=${model} busy=${busy} onApprove=${approve} onReject=${(item) => setRejecting(item)} />`
          : null}

        ${after ? null : html`<${MyList} model=${model} optimistic=${optimistic} busy=${busy} onToggle=${toggleMine} />`}

        ${after ? null : html`<${StillMissing} model=${model} busy=${busy} onTake=${take} onAdd=${() => setSheet('item')} />`}
      `}

    <${WhoAmI} snap=${snap} me=${me} phase=${phase} />
    <${ItemSheet} open=${sheet === 'item'} onClose=${() => setSheet(null)} snap=${snap} isAdmin=${isAdmin} tripId=${tripId} />
    <${ExpenseSheet} open=${sheet === 'expense'} onClose=${() => setSheet(null)} snap=${snap} me=${me} tripId=${tripId} />
    ${isAdmin
      ? html`<${AnnounceSheet} open=${sheet === 'announce'} onClose=${() => setSheet(null)} snap=${snap} me=${me} tripId=${tripId} />`
      : null}
    ${isAdmin ? html`<${RejectSheet} item=${rejecting} model=${model} onClose=${() => setRejecting(null)} />` : null}
  </div>`;
}

function buildModel(snap, me) {
  const members = snap.members || [];
  const byId = membersById(members);
  const cats = new Map((snap.categories || []).map((c) => [c.id, c]));
  const heads = headcountTotal(members);
  const pledgesByItem = new Map();
  for (const p of snap.pledges || []) {
    if (!pledgesByItem.has(p.item_id)) pledgesByItem.set(p.item_id, []);
    pledgesByItem.get(p.item_id).push(p);
  }
  const ready = tripReadiness(snap);
  const missing = missingItems(snap);
  const agenda = me ? myAgenda(snap, me.id) : null;
  const pending = (snap.items || [])
    .filter((i) => i.status === 'proposed')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const myBalance = me ? balances(snap).find((b) => b.member_id === me.id) : null;
  const news = visibleNotifications(snap).find((n) => n.kind === 'announcement') || null;
  const newsRead = news
    ? news.author_member === me?.id || (snap.reads || []).some((r) => r.notification_id === news.id && r.member_id === me?.id)
    : true;
  return {
    snap,
    trip: snap.trip,
    tripId: snap.trip.id,
    me,
    members,
    byId,
    cats,
    heads,
    pledgesByItem,
    ready,
    missing,
    agenda,
    pending,
    balance: myBalance ? myBalance.balance : 0,
    hasExpenses: (snap.expenses || []).length > 0,
    news,
    newsUnread: !newsRead,
    summary: buildSummaryText(snap, 'status'),
  };
}

/** Confetti + toast the first time the trip's readiness reaches 100% (again after dropping). */
function useReadyCelebration(tripId, ready) {
  const pct = ready?.pct;
  const total = ready?.total;
  useEffect(() => {
    if (!tripId || pct == null || !total) return;
    const key = `medura:ready100:${tripId}`;
    const prev = readFlag(key);
    if (pct >= 100 && prev !== '1') {
      writeFlag(key, '1');
      fireConfetti();
      actions.toast('הכל מכוסה! המדורה מוכנה 🎉', 'success', 3800);
    } else if (pct < 100 && prev !== '0') {
      writeFlag(key, '0');
    }
  }, [tripId, pct, total]);
}

function HomeSkeleton() {
  return html`<div class="screen home" aria-busy="true">
    <div class="home-skel-hero" role="status" aria-label="טוען…">
      <span class="skeleton__line" style="width:38%"></span>
      <span class="skeleton__line" style="width:72%;height:26px"></span>
      <span class="skeleton__line" style="width:56%"></span>
    </div>
    <${Skeleton} lines=${3} />
    <${Skeleton} lines=${5} />
  </div>`;
}

// ---------------------------------------------------------------------------
// hero + countdown
// ---------------------------------------------------------------------------

function CountTile({ value, one, many }) {
  return html`<span class="home-cd__tile">
    <span class="home-cd__num num">${value}</span>
    <span class="home-cd__unit">${value === 1 ? one : many}</span>
  </span>`;
}

function Hero({ model, me, now, isAdmin }) {
  const { trip, members, heads } = model;
  const cd = trip.starts_at ? countdown(trip.starts_at, now, trip.ends_at) : null;
  const when = trip.starts_at ? `${formatDate(trip.starts_at)} · ${formatTime(trip.starts_at)}` : '';
  const names = me ? (me.people?.length ? me.people.join(' ו') : displayName(me)) : '';
  const tripHref = href(`/t/${trip.id}/trip`);
  return html`<section class="hero home-hero" aria-labelledby="home-trip-name">
    ${names ? html`<p class="home-hero__hello">${greeting(now)}, ${names} 👋</p>` : null}
    <div class="home-hero__top">
      <span class="home-hero__emoji" aria-hidden="true">${trip.emoji || '⛺'}</span>
      <div class="home-hero__titles">
        <h1 class="home-hero__name" id="home-trip-name">${trip.name}</h1>
        ${when
          ? html`<p class="home-hero__when">${when}</p>`
          : isAdmin
            ? html`<a class="home-hero__when home-hero__when--link" href=${`${tripHref}?edit=1`}>עוד לא נקבע תאריך — לקבוע ←</a>`
            : html`<p class="home-hero__when">התאריך עוד לא נקבע 🗓️</p>`}
      </div>
    </div>

    ${cd?.label
      ? html`<div class=${cx('home-cd', cd.past && 'home-cd--past')} role="timer" aria-live="off">
          <span class="home-cd__label">${cd.label}</span>
          ${!cd.past
            ? html`<span class="home-cd__tiles" aria-hidden="true">
                <${CountTile} value=${cd.days} one="יום" many="ימים" />
                <${CountTile} value=${cd.hours} one="שעה" many="שעות" />
                <${CountTile} value=${cd.minutes} one="דקה" many="דק׳" />
              </span>`
            : cd.label === 'הטיול הסתיים' && hasModule(trip, 'money')
              ? html`<a class="home-cd__cta" href=${href(`/t/${trip.id}/money`)}>💸 סוגרים חשבון</a>`
              : null}
        </div>`
      : null}

    <div class="home-hero__foot">
      <a class="home-hero__chip" href=${tripHref}>
        <${Icon} name="map-pin" size=${16} />
        <span class="home-hero__chip-text">${trip.location || 'פרטי הטיול'}</span>
        <${Icon} name="chevron-left" size=${16} />
      </a>
      <a class="home-hero__people" href=${href(`/t/${trip.id}/people`)} aria-label=${`${hebrewCount(heads, 'משתתף', 'משתתפים')} — לרשימת החבר'ה`}>
        <${AvatarStack} members=${members} max=${3} size=${26} />
        <span class="home-hero__heads"><${Icon} name="users" size=${15} /><span class="num">${heads}</span></span>
      </a>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// readiness + money
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// the day before / the day of the trip
// ---------------------------------------------------------------------------

function TripDayCard({ snap, me, now }) {
  const trip = snap.trip;
  const phase = tripDayPhase(trip, now);
  if (!phase) return null;
  const rides = rideModel(snap, me.id);
  const ride = rides.myRide || rides.mySeat;
  const depart = rides.mySeat?.depart_at || rides.myRide?.depart_at || trip.starts_at;
  const open = snap.pledges.filter((p) => p.member_id === me.id && !p.done).length
    + (snap.personal_items || []).filter((p) => !p.done).length;
  const waze = wazeUrl(trip);
  const rideText = rides.myRide
    ? `את/ה נוהג/ת${rides.myRide.taken ? ` · ${hebrewCount(rides.myRide.taken, 'נוסע/ת', 'נוסעים')} איתך` : ''}`
    : rides.mySeat ? `נוסע/ת עם ${displayName(rides.mySeat.driver)}` : null;

  return html`<section class=${`tripday tripday--${phase}`} aria-labelledby="tripday-title" data-testid="trip-day">
    <div class="tripday__top">
      <span class="tripday__emoji" aria-hidden="true">${phase === 'day' ? '🚗' : '🎒'}</span>
      <div class="tripday__text">
        <h2 class="tripday__title" id="tripday-title">${phase === 'day' ? 'יוצאים היום!' : 'מחר יוצאים!'}</h2>
        <p class="tripday__sub">
          ${[depart && `יציאה ב-${formatTime(depart)}`, trip.location].filter(Boolean).join(' · ')}
        </p>
      </div>
    </div>
    <ul class="tripday__facts">
      ${!hasModule(trip, 'rides') ? null : rideText ? html`<li>🚙 ${rideText}</li>` : html`<li>🚙 עוד אין לך הסעה — <a href=${href(`/t/${trip.id}/rides`)}>למצוא טרמפ</a></li>`}
      ${open
        ? html`<li>🎒 עוד ${hebrewCount(open, 'דבר אחד', 'דברים')} לסמן — <a href=${href(`/t/${trip.id}/lists?tab=mine`)}>לרשימה שלי</a></li>`
        : html`<li>✅ הכול מסומן אצלך — אלופים</li>`}
    </ul>
    <div class="tripday__actions">
      ${waze && phase === 'day'
        ? html`<${Button} variant="accent" icon="map-pin" href=${waze} target="_blank" rel="noopener">ניווט ב-Waze</${Button}>`
        : null}
      <${Button} variant=${phase === 'day' && waze ? 'secondary' : 'accent'} href=${href(`/t/${trip.id}/trip`)}>לו״ז, מזג אוויר והסעות</${Button}>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// trip phases: before → eve → departure → during → after
// ---------------------------------------------------------------------------

const PHASES = [
  ['before', 'לפני'], ['eve', 'ערב לפני'], ['departure', 'יוצאים'], ['during', 'בטיול'], ['after', 'אחרי'],
];

function PhaseStrip({ phase }) {
  const at = PHASES.findIndex(([k]) => k === (phase === 'past' ? 'after' : phase));
  return html`<ol class="phase-strip" aria-label="איפה אנחנו בטיול" data-testid="phase-strip">
    ${PHASES.map(([k, label], i) => html`<li key=${k} class=${i === at ? 'is-now' : i < at ? 'is-past' : ''}
      aria-current=${i === at ? 'step' : undefined}>${label}</li>`)}
  </ol>`;
}

/** Once, for a device that joined a shared profile before profiles knew their people: "מי את/ה ב״הדס ועידו״?" */
function WhoAmI({ snap, me, phase }) {
  const tripId = snap.trip.id;
  const snoozeKey = `medura:whoami:${tripId}`;
  const [busy, setBusy] = useState(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return Number(localStorage.getItem(snoozeKey) || 0) > Date.now();
    } catch {
      return false;
    }
  });
  const people = (me?.people || []).filter(Boolean);
  const open = Boolean(me && people.length > 1 && snap.me && !snap.me.person && !dismissed && phase !== 'during');
  const joined = new Set(me?.joined || []);
  const later = () => {
    try {
      localStorage.setItem(snoozeKey, String(Date.now() + 24 * 3600e3));   // ask again tomorrow
    } catch {
      /* storage unavailable */
    }
    setDismissed(true);
  };
  const choose = async (p) => {
    setBusy(p);
    const ok = await actions.run(async (api) => { await api.setMyPerson(tripId, p); return true; }, {
      success: `היי ${p}! 👋 מעכשיו רואים בדיוק מי מה`,
      error: (code) => (code === 'already_claimed' ? `מישהו אחר (במייל אחר) כבר נכנס בתור ${p} — אפשר לבדוק במסך חבר׳ה` : hebrewError(code)),
    });
    setBusy(null);
    if (ok) setDismissed(true);
  };
  // every name stays tappable — the server knows whether "the other device" is you (same e-mail)
  return html`<${Sheet} open=${open} onClose=${later} title=${`מי את/ה ב״${me ? displayName(me) : ''}״? 🙋`}>
    <div class="stack" data-testid="who-am-i">
      <p class="muted">פעם אחת — ככה כולם רואים מי מביא ומי ראה, בלי בלבול.</p>
      <div class="welcome-opts" role="radiogroup" aria-label="מי את/ה">
        ${people.map((p) => html`<button type="button" role="radio" key=${p} aria-checked="false" class="welcome-opt"
          disabled=${Boolean(busy)} onClick=${() => choose(p)}>
          <span class="welcome-opt__emoji" aria-hidden="true">🙋</span>
          <span class="welcome-opt__text"><b>אני ${p}</b><span>${busy === p ? 'רגע…' : joined.has(p) ? 'נכנס/ה גם ממכשיר אחר — אם זה את/ה, מצוין' : 'זה אני'}</span></span>
        </button>`)}
      </div>
      <${Button} variant="ghost" disabled=${Boolean(busy)} onClick=${later}>אחר כך</${Button}>
    </div>
  </${Sheet}>`;
}

/** Admins: what the trip itself still misses (by its type) — one tap to where it's filled. */
function SetupCard({ snap }) {
  const gaps = tripSetupGaps(snap);
  if (!gaps.length) return null;
  return html`<${Card} emoji="🧭" title="מה חסר בטיול" class="checklist setup"
    action=${html`<span class="checklist__count">${gaps.length}</span>`}>
    <p class="muted small">רק מנהלים רואים את זה. ממלאים פעם אחת — וכולם יודעים.</p>
    <ul class="checklist__list" data-testid="setup-gaps">
      ${gaps.map((g) => html`<li key=${g.key}>
        <a href=${g.href}>
          <span class="checklist__mark" aria-hidden="true"></span>
          <span class="checklist__label">${g.label}</span>
          ${g.detail ? html`<span class="checklist__detail">${g.detail}</span>` : null}
          <${Icon} name="chevron-left" size=${16} />
        </a>
      </li>`)}
    </ul>
  </${Card}>`;
}

function ChecklistCard({ snap, me }) {
  const { items, done, total } = myChecklist(snap, me.id, { hasEmail: Boolean(me.prefs?.has_email) });
  if (!total) return null;
  const all = done === total;
  return html`<${Card} emoji=${all ? '🎉' : '✅'} title="הצ׳קליסט שלי לפני הטיול" class="checklist"
    action=${html`<span class="checklist__count">${done}/${total}</span>`}>
    <div class="checklist__bar" role="progressbar" aria-valuemin="0" aria-valuemax=${total} aria-valuenow=${done}>
      <span style=${`width:${Math.round((done / total) * 100)}%`}></span>
    </div>
    ${all ? html`<p class="checklist__all">הכול סגור מצדך — אלופים 💪</p>` : null}
    <ul class="checklist__list" data-testid="checklist">
      ${items.map((it) => html`<li key=${it.key} class=${it.done ? 'is-done' : ''}>
        <a href=${it.href}>
          <span class="checklist__mark" aria-hidden="true">${it.done ? '✓' : ''}</span>
          <span class="checklist__label">${it.label}</span>
          ${it.detail ? html`<span class="checklist__detail">${it.detail}</span>` : null}
          <${Icon} name="chevron-left" size=${16} />
        </a>
      </li>`)}
    </ul>
  </${Card}>`;
}

/** During the trip the app steps aside: where, how to get there, who to call — that's it. */
function RestCard({ snap }) {
  const trip = snap.trip;
  const waze = wazeUrl(trip);
  const admins = (snap.members || []).filter((m) => (m.role === 'owner' || m.role === 'admin') && m.phone);
  return html`<section class="rest" data-testid="rest">
    <p class="rest__emoji" aria-hidden="true">🔥</p>
    <h2 class="rest__title">תהנו!</h2>
    <p class="rest__text">האפליקציה נחה עד שחוזרים — מדברים אחד עם השני 🙂<br />התראות לא דחופות מושתקות בינתיים.</p>
    <ul class="rest__facts">
      ${trip.location ? html`<li>📍 ${trip.location}</li>` : null}
      ${trip.ends_at ? html`<li>🏠 חוזרים ${formatDate(trip.ends_at, { weekday: 'long' })} בערך ב-${formatTime(trip.ends_at)}</li>` : null}
    </ul>
    <div class="rest__actions">
      ${waze ? html`<${Button} variant="secondary" icon="map-pin" href=${waze} target="_blank" rel="noopener">ניווט ב-Waze</${Button}>` : null}
      ${admins.map((m) => html`<${Button} key=${m.id} variant="ghost" href=${`tel:${m.phone.replace(/[^\d+]/g, '')}`}>📞 ${displayName(m)}</${Button}>`)}
    </div>
    <a class="rest__more" href=${href(`/t/${trip.id}/lists`)}>צריך בכל זאת לבדוק משהו? לרשימות ←</a>
  </section>`;
}

/** After the trip: settle up, photos, the trip in numbers. */
function AfterCard({ snap, me, isAdmin }) {
  const trip = snap.trip;
  const mine = balances(snap).find((b) => b.member_id === me.id);
  const bal = mine ? mine.balance : 0;
  const stats = tripStats(snap);
  const album = trip.info?.album_url || null;
  const share = [
    `${trip.emoji || '⛺'} ${trip.name} — במספרים`,
    `👥 ${hebrewCount(stats.people, 'משתתף', 'משתתפים')}`,
    `📋 ${hebrewCount(stats.items, 'פריט', 'פריטים')} ברשימה`,
    stats.spent ? `💸 ${formatMoney(stats.spent)} סה״כ · ${formatMoney(stats.perPerson)} לאדם` : null,
    stats.rides ? `🚗 ${hebrewCount(stats.rides, 'רכב', 'רכבים')}` : null,
    album ? `📸 האלבום: ${album}` : null,
    'נתראה בטיול הבא 🔥',
  ].filter(Boolean).join('\n');
  return html`<section class="after" data-testid="after">
    <h2 class="after__title">איך היה? 🔥</h2>
    ${hasModule(trip, 'money') ? html`<div class="after__money">
      ${Math.abs(bal) < 1
        ? html`<p>💸 הכול מאוזן אצלך ✅</p>`
        : html`<p>💸 ${bal > 0 ? 'מגיע לך' : 'עליך להעביר'} <b>${formatMoney(Math.abs(bal))}</b></p>`}
      <${Button} size="sm" variant=${Math.abs(bal) < 1 ? 'ghost' : 'accent'} href=${href(`/t/${trip.id}/money`)}>
        ${Math.abs(bal) < 1 ? 'למסך הכסף' : bal > 0 ? 'מי מעביר לי' : 'למי להעביר'}
      </${Button}>
    </div>` : null}
    <div class="after__photos">
      ${album
        ? html`<${Button} variant="secondary" href=${album} target="_blank" rel="noopener">📸 לאלבום התמונות</${Button}>`
        : isAdmin
          ? html`<${Button} variant="ghost" href=${href(`/t/${trip.id}/trip?edit=1`)}>📸 הוספת קישור לאלבום משותף</${Button}>`
          : html`<p class="muted small">📸 אלבום משותף — המנהלים יוסיפו קישור</p>`}
    </div>
    <div class="after__stats" aria-label="הטיול במספרים">
      <span><b>${stats.people}</b> משתתפים</span>
      <span><b>${stats.items}</b> פריטים ברשימה</span>
      ${stats.spent ? html`<span><b>${formatMoney(stats.perPerson)}</b> לאדם</span>` : null}
    </div>
    <${ShareButton} text=${share} label="שיתוף ״הטיול במספרים״" />
  </section>`;
}

function Readiness({ model }) {
  const { ready, missing, tripId } = model;
  const pct = ready.pct;
  let headline = 'יש עוד מה לסגור 🙋';
  if (!ready.total) headline = 'הרשימות עוד ריקות 📝';
  else if (pct >= 100) headline = 'הכל מכוסה! 🎉';
  else if (pct >= 75) headline = 'כמעט שם 💪';
  else if (pct >= 40) headline = 'בדרך הנכונה 🔥';
  const parts = [];
  if (ready.total) parts.push(missing.length ? hebrewCount(missing.length, 'חסר', 'חסרים') : 'אין חסרים');
  if (ready.proposed) parts.push(hebrewCount(ready.proposed, 'ממתין לאישור', 'ממתינים לאישור'));
  if (!parts.length) parts.push('מוסיפים פריטים ומתחילים');
  return html`<${Card} class="home-ready" onClick=${() => navigate(`/t/${tripId}/lists`)}>
    <${ProgressRing} value=${pct} size=${84} stroke=${9} label="מוכנות הטיול">
      <span class="home-ready__pct num">${pct}<small>%</small></span>
    </${ProgressRing}>
    <div class="home-ready__text">
      <span class="kicker">מוכנות הטיול</span>
      <span class="home-ready__headline">${headline}</span>
      <span class="home-ready__sub" data-testid="readiness-sub">${parts.join(' · ')}</span>
    </div>
    <${Icon} name="chevron-left" size=${20} class="home-ready__chev" />
  </${Card}>`;
}

function MoneyRow({ model }) {
  const { balance, hasExpenses, tripId } = model;
  let tone = 'muted';
  let emoji = '🧾';
  let text = 'עוד אין הוצאות משותפות';
  if (hasExpenses && balance >= 1) {
    tone = 'success';
    emoji = '💚';
    text = `מגיע לך ${formatMoney(balance)}`;
  } else if (hasExpenses && balance <= -1) {
    tone = 'warning';
    emoji = '💸';
    text = `עליך להעביר ${formatMoney(-balance)}`;
  } else if (hasExpenses) {
    tone = 'balanced';
    emoji = '✨';
    text = 'את/ה מאוזנ/ת';
  }
  return html`<a class=${cx('home-money', `home-money--${tone}`)} href=${href(`/t/${tripId}/money`)} data-testid="money-chip">
    <span class="home-money__emoji" aria-hidden="true">${emoji}</span>
    <span class="home-money__text">${text}</span>
    <span class="home-money__cta">לכסף</span>
    <${Icon} name="chevron-left" size=${18} />
  </a>`;
}

// ---------------------------------------------------------------------------
// quick actions
// ---------------------------------------------------------------------------

function QuickActions({ isAdmin, proposes, summary, onItem, onExpense, onAnnounce }) {
  return html`<nav class=${cx('home-qa', isAdmin && onExpense && 'home-qa--4')} aria-label="פעולות מהירות">
    <button type="button" class="qa-tile" onClick=${onItem}>
      <span class="qa-tile__emoji" aria-hidden="true">➕</span>
      <span class="qa-tile__label">${proposes ? 'הצע פריט' : 'הוסף פריט'}</span>
    </button>
    ${onExpense
      ? html`<button type="button" class="qa-tile" onClick=${onExpense}>
          <span class="qa-tile__emoji" aria-hidden="true">🧾</span>
          <span class="qa-tile__label">הוצאה חדשה</span>
        </button>`
      : null}
    ${isAdmin
      ? html`<button type="button" class="qa-tile" onClick=${onAnnounce}>
          <span class="qa-tile__emoji" aria-hidden="true">📣</span>
          <span class="qa-tile__label">הודעה לכולם</span>
        </button>`
      : null}
    <div class="qa-share" data-testid="qa-share">
      <${ShareButton} text=${summary} label="סיכום לוואטסאפ" block />
    </div>
  </nav>`;
}

// ---------------------------------------------------------------------------
// latest announcement
// ---------------------------------------------------------------------------

function LatestNews({ model }) {
  const { news, newsUnread, byId, tripId } = model;
  const author = news.author_member ? byId.get(news.author_member) : null;
  return html`<${Card}
    class=${cx('home-news', newsUnread && 'is-unread', news.urgent && 'is-urgent')}
    onClick=${() => navigate(`/t/${tripId}/messages`)}
    data-testid="latest-news"
  >
    <div class="home-news__head">
      <span class="home-news__kicker">${news.urgent ? '🔴 הודעה דחופה' : '📣 הודעה אחרונה'}</span>
      ${newsUnread ? html`<${Pill} tone="ember">חדש</${Pill}>` : null}
      <span class="spacer"></span>
      <span class="home-news__time">${timeAgo(news.created_at)}</span>
    </div>
    <h2 class="home-news__title">${news.title}</h2>
    ${news.body ? html`<p class="home-news__body">${news.body}</p>` : null}
    <div class="home-news__foot">
      ${author
        ? html`<${Avatar} member=${author} size=${24} /><span class="home-news__author">${displayName(author)}</span>`
        : html`<span class="home-news__author">🔥 מדורה</span>`}
      <span class="spacer"></span>
      <span class="home-news__more">לכל ההודעות</span>
      <${Icon} name="chevron-left" size=${16} />
    </div>
  </${Card}>`;
}

// ---------------------------------------------------------------------------
// admin: pending approvals
// ---------------------------------------------------------------------------

function itemMeta(item, heads) {
  if (item.type === 'buy') return [itemEffectiveQty(item, heads).text, 'לקנות'].filter(Boolean).join(' · ');
  if (item.type === 'bring') return (Number(item.needed) || 1) > 1 ? `להביא מהבית · צריך ${item.needed}` : 'להביא מהבית';
  if (item.type === 'each') return 'כל אחד מביא';
  return 'משימה';
}

function Approvals({ model, busy, onApprove, onReject }) {
  const { pending, cats, byId, heads, tripId, snap } = model;
  const shown = pending.slice(0, APPROVALS_SHOWN);
  const more = pending.length - shown.length;
  return html`<${Card}
    class="home-approvals"
    tone="warning"
    emoji="⏳"
    title="ממתינים לאישור"
    action=${html`<${Pill} tone="warning">${pending.length}</${Pill}>`}
  >
    <ul class="approve-list">
      ${shown.map((item) => {
        const cat = cats.get(item.category_id);
        const creator = item.created_by ? byId.get(item.created_by) : null;
        const busyOk = busy(`ok:${item.id}`);
        const busyNo = busy(`no:${item.id}`);
        return html`<li class="approve-row" key=${item.id}>
          <span class="approve-row__emoji kbd-emoji" aria-hidden="true">${cat?.emoji || '📦'}</span>
          <div class="approve-row__main">
            <span class="approve-row__title">${item.title}</span>
            ${(() => {
              const like = similarItems(item.title, snap.items, { excludeId: item.id, limit: 1 })[0];
              return like ? html`<${Pill} tone="warning" class="approve-row__dup">🔁 דומה ל: ${like.item.title}</${Pill}>` : null;
            })()}
            <span class="approve-row__sub">
              ${creator ? html`<${Avatar} member=${creator} size=${20} />` : null}
              <span>${[creator && `${displayName(creator)} הציע/ה`, itemMeta(item, heads), timeAgo(item.created_at)].filter(Boolean).join(' · ')}</span>
            </span>
            ${item.note ? html`<span class="approve-row__note">${item.note}</span>` : null}
            <div class="approve-row__actions">
              <${Button} size="sm" variant="primary" icon="check" loading=${busyOk} disabled=${busyNo}
                aria-label=${`אישור: ${item.title}`} onClick=${() => onApprove(item)}>אישור</${Button}>
              <${Button} size="sm" variant="secondary" icon="x" disabled=${busyOk || busyNo}
                aria-label=${`דחייה: ${item.title}`} onClick=${() => onReject(item)}>דחייה</${Button}>
            </div>
          </div>
        </li>`;
      })}
    </ul>
    ${more > 0
      ? html`<a class="home-card-link" href=${href(`/t/${tripId}/lists?tab=pending`)}>ועוד ${more} ברשימות ←</a>`
      : null}
  </${Card}>`;
}

function RejectSheet({ item, model, onClose }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [shown, setShown] = useState(item);
  useEffect(() => {
    if (item) {
      setShown(item);
      setReason('');
      setSaving(false);
    }
  }, [item?.id]);
  const target = item || shown;
  const creator = target?.created_by ? model.byId.get(target.created_by) : null;
  const submit = async (e) => {
    e?.preventDefault();
    if (!target || saving) return;
    setSaving(true);
    const why = reason.trim() || null;
    const res = await actions.run((api) => api.reviewItem(target.id, false, why), { success: 'ההצעה נדחתה — שלחנו עדכון למציע/ה' });
    setSaving(false);
    if (res !== undefined) onClose();
  };
  return html`<${Sheet}
    open=${!!item}
    onClose=${onClose}
    title="לדחות את ההצעה?"
    footer=${html`
      <${Button} variant="danger" type="submit" form="home-reject-form" loading=${saving}>לדחות</${Button}>
      <${Button} variant="secondary" onClick=${onClose}>ביטול</${Button}>`}
  >
    ${target
      ? html`<form id="home-reject-form" class="qsheet" onSubmit=${submit} noValidate>
          <p class="qsheet__lead">
            „<strong>${target.title}</strong>”${creator ? html` · הצעה של ${displayName(creator)}` : null}
          </p>
          <div class="chip-row" role="group" aria-label="סיבות נפוצות">
            ${REJECT_REASONS.map((r) => html`<${Chip} key=${r} active=${reason === r} onClick=${() => setReason(reason === r ? '' : r)}>${r}</${Chip}>`)}
          </div>
          <${Field} label="למה? (לא חובה)" hint="המציע/ה יקבל/תקבל את זה בהודעה">
            <${TextInput} value=${reason} maxlength="500" placeholder="למשל: כבר יש לנו שניים" onInput=${(e) => setReason(e.target.value)} />
          </${Field}>
        </form>`
      : null}
  </${Sheet}>`;
}

// ---------------------------------------------------------------------------
// my list
// ---------------------------------------------------------------------------

function agendaGroups(agenda, heads) {
  if (!agenda) return [];
  return [
    {
      key: 'bring',
      title: '🎒 מביאים מהבית',
      rows: agenda.bring.map(({ item, pledge }) => ({
        item, kind: 'bring', done: !!pledge.done, meta: (Number(pledge.qty) || 1) > 1 ? formatQty(pledge.qty, 'יח׳') : '',
      })),
    },
    {
      key: 'buy',
      title: '🛒 קונים',
      rows: agenda.buy.map(({ item }) => ({ item, kind: 'buy', done: !!item.done, meta: itemEffectiveQty(item, heads).text })),
    },
    { key: 'tasks', title: '✅ משימות', rows: agenda.tasks.map(({ item }) => ({ item, kind: 'task', done: !!item.done, meta: '' })) },
    { key: 'each', title: '🙋 כל אחד מביא', rows: agenda.each.map(({ item, done }) => ({ item, kind: 'each', done, meta: '' })) },
  ].filter((g) => g.rows.length);
}

function MyList({ model, optimistic, busy, onToggle }) {
  const { agenda, heads, cats, tripId } = model;
  const groups = agendaGroups(agenda, heads);
  const rows = groups.flatMap((g) => g.rows);
  const isDone = (row) => (row.item.id in optimistic ? optimistic[row.item.id] : row.done);
  const total = rows.length;
  const doneCount = rows.filter(isDone).length;
  const pct = total ? (doneCount === total ? 100 : Math.floor((doneCount * 100) / total)) : 0;

  // Finishing my whole list deserves a party (only on the transition, not on load).
  const prevPct = useRef(null);
  useEffect(() => {
    if (prevPct.current !== null && prevPct.current < 100 && pct === 100 && total > 0) {
      fireConfetti();
      actions.toast('הכל מוכן אצלך! 🎒✨', 'success', 3200);
    }
    prevPct.current = pct;
  }, [pct, total]);

  return html`<${Card}
    class="home-mine"
    emoji="🎒"
    title="המשימות שלי"
    action=${total ? html`<a class="home-card-link" href=${href(`/t/${tripId}/lists?tab=mine`)}>לרשימה שלי</a>` : null}
  >
    ${total
      ? html`<div class="mine-progress">
          <${ProgressBar} value=${pct} tone="accent" label="כמה מהרשימה שלי מוכן" />
          <span class="mine-progress__text"><b class="num">${doneCount}/${total}</b> ${pct === 100 ? 'הכל מוכן 🎉' : 'מוכנים'}</span>
        </div>
        ${groups.map((g) => html`<div class="mine-group" key=${g.key}>
          <h3 class="mine-group__title">${g.title}</h3>
          <ul class="mine-list">
            ${g.rows.map((row) => {
              const checked = isDone(row);
              const cat = cats.get(row.item.category_id);
              const sub = [row.meta, cat ? `${cat.emoji} ${cat.name}` : ''].filter(Boolean).join(' · ');
              return html`<li class=${cx('mine-row', checked && 'is-done')} key=${row.item.id}>
                <button
                  type="button"
                  class=${cx('check', busy(`done:${row.item.id}`) && 'is-busy')}
                  role="checkbox"
                  aria-checked=${checked ? 'true' : 'false'}
                  aria-label=${row.item.title}
                  onClick=${() => !busy(`done:${row.item.id}`) && onToggle({ ...row, done: checked })}
                ><${Icon} name="check" /></button>
                <span class="mine-row__main">
                  <span class="mine-row__title">${row.item.title}</span>
                  ${sub ? html`<span class="mine-row__sub">${sub}</span>` : null}
                </span>
                ${row.item.status === 'proposed' ? html`<${Pill} tone="warning">ממתין לאישור</${Pill}>` : null}
              </li>`;
            })}
          </ul>
        </div>`)}`
      : html`<${EmptyState}
          emoji="🎒"
          title="עוד לא לקחת כלום"
          text="בחרו משהו מ״עדיין חסר״ למטה — בלחיצה אחת ✋"
        />`}
  </${Card}>`;
}

// ---------------------------------------------------------------------------
// still missing
// ---------------------------------------------------------------------------

function takeLabel(item, myPledge) {
  if (item.type === 'buy') return 'אני קונה ✋';
  if (item.type === 'task') return 'עליי ✋';
  if (item.type === 'each') return 'ארזתי ✓';
  return myPledge ? 'עוד אחד ✋' : 'אני מביא/ה ✋';
}

function missingDetail(item, prog, heads) {
  if (item.type === 'bring') {
    if (prog.needed > 1) return prog.pledged > 0 ? `יש ${prog.pledged} מתוך ${prog.needed}` : `צריך ${prog.needed}`;
    return 'להביא מהבית';
  }
  if (item.type === 'each') return `כל אחד מביא · ${prog.doneCount}/${prog.total} ארזו`;
  return itemMeta(item, heads);
}

function StillMissing({ model, busy, onTake, onAdd }) {
  const { missing, ready, cats, members, pledgesByItem, heads, me, tripId } = model;
  const shown = missing.slice(0, MISSING_SHOWN);
  const more = missing.length - shown.length;
  const listsHref = href(`/t/${tripId}/lists`);

  let body;
  if (!ready.total) {
    body = html`<${EmptyState}
      emoji="📝"
      title="הרשימות עוד ריקות"
      text="מדביקים רשימה מהוואטסאפ או מוסיפים פריט ראשון"
      action=${html`<div class="row row--center wrap">
        <${Button} size="sm" icon="➕" onClick=${onAdd}>הוספת פריט</${Button}>
        <${Button} size="sm" variant="secondary" icon="📥" href=${href(`/t/${tripId}/import`)}>ייבוא מוואטסאפ</${Button}>
      </div>`}
    />`;
  } else if (!missing.length) {
    body = html`<${EmptyState} emoji="🎉" title="הכל מכוסה!" text="לכל פריט יש מישהו שמביא. אלופים 🔥" />`;
  } else {
    body = html`<ul class="need-list">
      ${shown.map((item) => {
        const own = pledgesByItem.get(item.id) || [];
        const prog = itemProgress(item, own, members);
        const mine = me ? own.find((p) => p.member_id === me.id) : null;
        const cat = cats.get(item.category_id);
        const label = takeLabel(item, mine);
        const myEachDone = item.type === 'each' && !!mine?.done;
        return html`<li class="need-row" key=${item.id}>
          <span class="need-row__emoji kbd-emoji" aria-hidden="true">${cat?.emoji || '📦'}</span>
          <span class="need-row__main">
            <span class="need-row__title">${item.title}</span>
            <span class="need-row__sub">${missingDetail(item, prog, heads)}</span>
            ${item.type === 'bring' && prog.needed > 1 && prog.pledged > 0
              ? html`<${ProgressBar} value=${(prog.pledged * 100) / prog.needed} tone="accent" label=${`${item.title}: ${prog.pledged} מתוך ${prog.needed}`} />`
              : null}
          </span>
          ${myEachDone
            ? html`<${Pill} tone="success">שלך מוכן ✓</${Pill}>`
            : html`<${Button}
                size="sm"
                variant="accent"
                class="need-row__btn"
                loading=${busy(`take:${item.id}`)}
                aria-label=${`${label.replace(/ [✋✓]$/u, '')}: ${item.title}`}
                onClick=${() => onTake(item, mine)}
              >${label}</${Button}>`}
        </li>`;
      })}
    </ul>`;
  }

  return html`<${Card}
    class="home-missing"
    emoji="🙋"
    title="עדיין חסר"
    action=${missing.length ? html`<${Pill} tone="ember">${missing.length}</${Pill}>` : null}
  >
    ${body}
    ${ready.total
      ? html`<${Button} variant="ghost" block icon="list" href=${listsHref} class="home-missing__all">
          ${more > 0 ? `לכל הרשימות (עוד ${more} חסרים)` : 'לכל הרשימות'}
        </${Button}>`
      : null}
  </${Card}>`;
}

// ---------------------------------------------------------------------------
// quick sheets: item / expense / announcement
// ---------------------------------------------------------------------------

const blankItem = () => ({
  title: '', category_id: null, type: 'buy', qty: '', unit: null, per_person: false, needed: 1, note: '', mine: false,
});

function ItemSheet({ open, onClose, snap, isAdmin, tripId }) {
  const [f, setF] = useState(blankItem);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const typeTouched = useRef(false);
  useLayoutEffect(() => {
    if (open) {
      setF(blankItem());
      setError('');
      setSaving(false);
      typeTouched.current = false;
    }
  }, [open]);

  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const cats = sortedCategories(snap);
  const needsApproval = !isAdmin && snap.trip.settings?.require_approval !== false;
  const qtyNum = Number(String(f.qty).replace(',', '.'));
  const qtyOk = f.qty === '' || (Number.isFinite(qtyNum) && qtyNum > 0);

  const pickCategory = (cat) => {
    const next = f.category_id === cat.id ? null : cat.id;
    const patch = { category_id: next };
    if (next && !typeTouched.current) patch.type = TYPE_BY_CATEGORY_EMOJI[cat.emoji] || 'buy';
    set(patch);
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (saving) return;
    const title = f.title.trim();
    if (!title) {
      setError('מה להוסיף? 🙂');
      focusInvalid('.home-item-form');
      return;
    }
    if (!qtyOk) {
      focusInvalid('.home-item-form');
      return;
    }
    if (!(await confirmNotDuplicate(title, snap))) return;
    const item = { title, type: f.type, category_id: f.category_id, note: f.note.trim() || null };
    if (f.type === 'buy') {
      item.qty = f.qty === '' ? null : qtyNum;
      item.unit = f.qty === '' ? null : f.unit;
      item.per_person = f.qty !== '' && f.per_person;
    }
    if (f.type === 'bring') item.needed = f.needed;
    if (f.mine && f.type !== 'each') item.pledge_qty = 1;
    setSaving(true);
    const res = await actions.run((api) => api.addItem(tripId, item), {
      success: needsApproval ? 'ההצעה נשלחה לאישור ⏳' : 'נוסף לרשימה ✅',
    });
    setSaving(false);
    if (res !== undefined) onClose();
  };

  const mineLabel = f.type === 'buy' ? 'אני קונה את זה' : f.type === 'task' ? 'אני על זה' : 'אני מביא/ה את זה';
  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title=${needsApproval ? 'הצעת פריט ✨' : 'פריט חדש ✨'}
    footer=${html`<${Button} type="submit" form="home-item-form" size="lg" loading=${saving} icon=${needsApproval ? 'send' : 'plus'}>
      ${needsApproval ? 'שליחה לאישור' : 'הוספה לרשימה'}
    </${Button}>`}
  >
    <form id="home-item-form" class="qsheet home-item-form" onSubmit=${submit} noValidate>
      <${Field} label="מה צריך?" error=${error}>
        <${TextInput}
          value=${f.title}
          maxlength="120"
          placeholder="למשל: מחצלת גדולה"
          data-autofocus
          enterkeyhint="done"
          onInput=${(e) => {
            set({ title: e.target.value });
            if (error) setError('');
          }}
        />
      </${Field}>
      <${SimilarItemsNotice} title=${f.title} snap=${snap} onOpen=${(id) => {
        onClose();
        navigate(`/t/${tripId}/lists?item=${id}`);
      }} />

      <${Field} label="סוג">
        <${Segmented}
          label="סוג הפריט"
          options=${TYPE_OPTIONS}
          value=${f.type}
          onChange=${(type) => {
            typeTouched.current = true;
            set({ type });
          }}
        />
      </${Field}>

      ${cats.length
        ? html`<${Field} label="קטגוריה">
            <div class="h-scroll">
              ${cats.map((c) => html`<${Chip} key=${c.id} active=${f.category_id === c.id} onClick=${() => pickCategory(c)}>
                <span aria-hidden="true">${c.emoji}</span> ${c.name}
              </${Chip}>`)}
            </div>
          </${Field}>`
        : null}

      ${f.type === 'buy'
        ? html`<div class="qsheet__qty">
            <${Field} label="כמות" error=${qtyOk ? '' : 'מספר חיובי בבקשה'}>
              <${TextInput} value=${f.qty} inputmode="decimal" dir="ltr" placeholder="—" class="qsheet__qty-input"
                onInput=${(e) => set({ qty: e.target.value, unit: f.unit || (e.target.value ? 'יח׳' : null) })} />
            </${Field}>
            <${Field} label="יחידה">
              <div class="h-scroll">
                ${UNITS.map((u) => html`<${Chip} key=${u} active=${f.unit === u} onClick=${() => set({ unit: f.unit === u ? null : u })}>${u}</${Chip}>`)}
              </div>
            </${Field}>
          </div>
          ${f.qty !== ''
            ? html`<${Toggle} checked=${f.per_person} onChange=${(v) => set({ per_person: v })} label="הכמות היא לאדם"
                hint=${`מוכפל אוטומטית במספר המשתתפים (${headcountTotal(snap.members)})`} />`
            : null}`
        : null}

      ${f.type === 'bring'
        ? html`<div class="row row--between qsheet__needed">
            <span class="field__label">כמה צריך בסך הכל?</span>
            <${Stepper} value=${f.needed} min=${1} max=${200} label="כמה צריך" onChange=${(v) => set({ needed: v })} />
          </div>`
        : null}

      <${Field} label="הערה (לא חובה)">
        <${TextInput} value=${f.note} maxlength="500" placeholder="מותג, גודל, למי לפנות…" onInput=${(e) => set({ note: e.target.value })} />
      </${Field}>

      ${f.type !== 'each'
        ? html`<${Toggle} checked=${f.mine} onChange=${(v) => set({ mine: v })} label=${`✋ ${mineLabel}`} hint="נרשם עליך מיד" />`
        : null}

      ${needsApproval
        ? html`<p class="qsheet__note" role="note">⏳ ההצעה תישלח לאישור מנהל — ברגע שיאשרו היא נכנסת לרשימה</p>`
        : null}
    </form>
  </${Sheet}>`;
}

function ExpenseSheet({ open, onClose, snap, me, tripId }) {
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  useLayoutEffect(() => {
    if (open) {
      setTitle('');
      setAmount(null);
      setErrors({});
      setSaving(false);
    }
  }, [open]);

  const heads = headcountTotal(snap.members);
  const valid = amount > 0 && amount <= 100000;
  const myShare = valid && me
    ? expenseShares({ amount, split_mode: 'all' }, snap).find((s) => s.member_id === me.id)?.amount ?? 0
    : 0;

  const submit = async (e) => {
    e?.preventDefault();
    if (saving) return;
    const t = title.trim();
    const errs = {};
    if (!t) errs.title = 'על מה ההוצאה?';
    if (!valid) errs.amount = amount > 100000 ? 'עד ₪100,000 להוצאה' : 'כמה זה עלה?';
    setErrors(errs);
    if (Object.keys(errs).length) {
      focusInvalid('.home-expense-form');
      return;
    }
    setSaving(true);
    const res = await actions.run((api) => api.addExpense(tripId, { title: t, amount, split_mode: 'all' }), { success: 'ההוצאה נוספה 🧾' });
    setSaving(false);
    if (res !== undefined) onClose();
  };

  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title="הוצאה חדשה 🧾"
    footer=${html`<${Button} type="submit" form="home-expense-form" size="lg" loading=${saving} icon="receipt">הוספת הוצאה</${Button}>`}
  >
    <form id="home-expense-form" class="qsheet home-expense-form" onSubmit=${submit} noValidate>
      <${Field} label="על מה?" error=${errors.title}>
        <${TextInput} value=${title} maxlength="80" placeholder="למשל: קניות בסופר" data-autofocus
          onInput=${(e) => setTitle(e.target.value)} />
      </${Field}>
      <${Field} label="כמה שילמת?" error=${errors.amount}>
        <${MoneyInput} value=${amount} onChange=${setAmount} />
      </${Field}>
      <div class="qsheet__preview" aria-live="polite">
        <span class="qsheet__preview-emoji" aria-hidden="true">👥</span>
        <span>
          ${valid
            ? html`מתחלק בין כולם לפי ראשים: <b class="num">${formatMoney(Math.round((amount / Math.max(1, heads)) * 100) / 100)}</b> לאדם
                · החלק שלכם <b class="num">${formatMoney(myShare)}</b>`
            : html`מתחלק אוטומטית בין כולם לפי ראשים (${hebrewCount(heads, 'איש', 'אנשים')}, זוג = 2)`}
        </span>
      </div>
      <p class="qsheet__note">
        שילמת רק על חלק מהחבר'ה? <a href=${href(`/t/${tripId}/money`)} onClick=${onClose}>חלוקה מתקדמת במסך הכסף ←</a>
      </p>
    </form>
  </${Sheet}>`;
}

function AnnounceSheet({ open, onClose, snap, me, tripId }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [mode, setMode] = useState('all');
  const [audience, setAudience] = useState([]);
  const [urgent, setUrgent] = useState(false);
  const [when, setWhen] = useState('now');
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  useLayoutEffect(() => {
    if (open) {
      setTitle('');
      setBody('');
      setMode('all');
      setAudience([]);
      setUrgent(false);
      setWhen('now');
      setErrors({});
      setSaving(false);
    }
  }, [open]);
  const others = (snap.members || []).filter((m) => m.id !== me?.id);

  const submit = async (e) => {
    e?.preventDefault();
    if (saving) return;
    const t = title.trim();
    const errs = {};
    if (!t) errs.title = 'מה הכותרת?';
    if (mode === 'some' && !audience.length) errs.audience = 'בחרו לפחות חבר/ה אחד/ת';
    setErrors(errs);
    if (Object.keys(errs).length) {
      focusInvalid('.home-announce-form');
      return;
    }
    setSaving(true);
    const res = await actions.run(
      (api) => api.sendAnnouncement(tripId, { title: t, body: body.trim() || null, audience: mode === 'some' ? audience : null, urgent, digest: !urgent && when === 'digest' }),
      { success: !urgent && when === 'digest' ? 'ההודעה באפליקציה עכשיו, ובמייל ובהתראה — בסיכום של 09:30 ☀️' : 'ההודעה נשלחה 📣' },
    );
    setSaving(false);
    if (res !== undefined) onClose();
  };

  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title="הודעה לחבר'ה 📣"
    footer=${html`<${Button} type="submit" form="home-announce-form" size="lg" variant=${urgent ? 'accent' : 'primary'} loading=${saving} icon="send">
      ${urgent ? 'שליחה דחופה 🔴' : 'שליחה'}
    </${Button}>`}
  >
    <form id="home-announce-form" class="qsheet home-announce-form" onSubmit=${submit} noValidate>
      <${Field} label="כותרת" error=${errors.title}>
        <${TextInput} value=${title} maxlength="80" placeholder="למשל: יוצאים ב-09:00 מהחניון 🚗" data-autofocus
          onInput=${(e) => setTitle(e.target.value)} />
      </${Field}>
      <${Field} label="פרטים (לא חובה)">
        <${TextArea} value=${body} maxlength="2000" rows=${3} placeholder="כל מה שחשוב לדעת" onInput=${(e) => setBody(e.target.value)} />
      </${Field}>
      <${Field} label="למי?" error=${errors.audience}>
        <${Segmented}
          label="קהל ההודעה"
          options=${[{ value: 'all', label: '👥 לכולם' }, { value: 'some', label: '🎯 לבחור' }]}
          value=${mode}
          onChange=${setMode}
        />
      </${Field}>
      ${mode === 'some'
        ? html`<${MemberPicker} members=${others} value=${audience} onChange=${setAudience} multi label="למי לשלוח" />`
        : null}
      <${Toggle} checked=${urgent} onChange=${setUrgent} label="🔴 דחוף" hint="מודגש אצל כולם, עם רטט בטלפון" />
      ${!urgent
        ? html`<${Field} label="מתי להתריע?" hint=${when === 'digest' ? 'באפליקציה זה מופיע מיד; התראה ומייל — פעם ביום ב-09:30, מרוכז, בלי להציף' : 'התראה ומייל עכשיו'}>
            <${Segmented} label="מתי להתריע" value=${when} onChange=${setWhen}
              options=${[{ value: 'now', label: '⚡ עכשיו' }, { value: 'digest', label: '☀️ בסיכום היומי' }]} />
          </${Field}>`
        : null}
    </form>
  </${Sheet}>`;
}
