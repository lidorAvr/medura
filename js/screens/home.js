// Home (SPEC §8.2): the trip at a glance — countdown hero, readiness, quick actions, latest
// announcement, pending approvals (admins), "my list" with inline done toggles, and what's
// still missing with one-tap "I'm on it".
import { html } from 'htm/preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { actions, useTrip } from '../store.js?v=853199b';
import { href, navigate } from '../router.js?v=853199b';
import {
  actorName,
  balances, buildSummaryText, countdown, displayName, expenseShares, formatDate, formatMoney, formatQty, formatTime, headcountTotal,
  hebrewCount, itemEffectiveQty, itemProgress, membersById, missingItems, myAgenda, similarItems, timeAgo, tripReadiness,
  visibleNotifications, rideModel, tripDayPhase, wazeUrl, tripPhase, myChecklist, tripStats, adminPersons, personsOf,
  departureOf, myRideText, pinnedNotices, myInbox, tripPlan, moneyPots, myNet, openMoneyRequests, partyBalances,
  partyName, partyOf, splitsMoney,
} from '../lib/logic.js?v=853199b';
import {
  Avatar, Button, Card, Chip, EmptyState, Field, MemberPicker, MoneyInput, Pill, ProgressBar, ProgressRing,
  Segmented, ShareButton, Sheet, Skeleton, Stepper, TextArea, TextInput, Toggle, fireConfetti,
} from '../ui/components.js?v=853199b';
import { Icon } from '../ui/icons.js?v=853199b';
import { SimilarItemsNotice, confirmNotDuplicate } from './lists.js?v=853199b';
import { InboxCard } from '../ui/inbox.js?v=853199b';
import { CloneSheet } from '../ui/clone-sheet.js?v=853199b';
import { payMethodsOf } from './money-requests.js?v=853199b';
import { AlbumSheet } from './trip-extras.js?v=853199b';
import { hebrewError } from '../api/errors.js?v=853199b';
import { hasModule, itemTypeOn, tripSetupGaps } from '../lib/templates.js?v=853199b';

const cx = (...a) => a.filter(Boolean).join(' ');
const MISSING_SHOWN = 3;
const MINE_SHOWN = 3;
const APPROVALS_SHOWN = 1;
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
  const [sheet, setSheet] = useState(null); // 'item' | 'expense' | 'album' | null
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
  const prep = phase === 'before' || phase === 'eve';          // the planning weeks (+ the evening before)
  const lists = hasModule(trip, 'lists') || hasModule(trip, 'tasks');
  // after the trip a request for an expense's shares is already inside the net ("כולל …" in the closing card)
  const inboxSnap = after ? { ...snap, money_requests: (snap.money_requests || []).filter((q) => !q.expense_id) } : snap;
  const moneyAsked = me ? myInbox(snap, me.id).some((e) => e.kind === 'money_request') : false;
  // an old announcement is history once the trip is over (an urgent one after the end still shows)
  const news = model.news && (!after || !trip.ends_at || String(model.news.created_at) > String(trip.ends_at)) ? model.news : null;

  return html`<div class=${`screen home home--${phase}`}>
    <${Hero} model=${model} me=${me} now=${now} isAdmin=${isAdmin} />

    ${phase === 'during'
      ? html`<${RestCard} snap=${snap} /><${InboxCard} snap=${snap} me=${me} only=${['profile_request']} />`
      : after
        ? html`
          <${AfterCard} snap=${snap} me=${me} isAdmin=${isAdmin} onAlbum=${() => setSheet('album')} />
          <${InboxCard} snap=${inboxSnap} me=${me} skip=${['proposals']} />
          ${news ? html`<${LatestNews} model=${{ ...model, news }} />` : null}`
        : html`
          <${TripDayCard} snap=${snap} me=${me} now=${now} />
          <${InboxCard} snap=${snap} me=${me} skip=${['proposals']} />
          ${isAdmin && model.pending.length
            ? html`<${Approvals} model=${model} busy=${busy} onApprove=${approve} onReject=${(item) => setRejecting(item)} />`
            : null}

          ${lists
            ? html`<${StillMissing} model=${model} busy=${busy} onTake=${take} onAdd=${() => setSheet('item')}
                canImport=${hasModule(trip, 'lists')} />`
            : null}
          <${MyList} model=${model} optimistic=${optimistic} busy=${busy} onToggle=${toggleMine} />

          ${prep ? html`<${ChecklistCard} snap=${snap} me=${me} />` : null}
          ${isAdmin && phase === 'before' ? html`<${SetupCard} snap=${snap} />` : null}
          ${isAdmin && phase === 'before' ? html`<${CrewCard} snap=${snap} />` : null}

          <div class="stack-sm">
            ${lists ? html`<${Readiness} model=${model} />` : null}
            ${hasModule(trip, 'money') && !moneyAsked ? html`<${MoneyRow} model=${model} />` : null}
          </div>

          ${phase === 'before'
            ? html`<${QuickActions}
                proposes=${!isAdmin && trip.settings?.require_approval !== false}
                summary=${model.summary}
                onItem=${lists ? () => setSheet('item') : null}
                onExpense=${hasModule(trip, 'money') ? () => setSheet('expense') : null}
              />`
            : null}

          ${news ? html`<${LatestNews} model=${model} />` : null}
        `}

    <${WhoAmI} snap=${snap} me=${me} phase=${phase} />
    <${ItemSheet} open=${sheet === 'item'} onClose=${() => setSheet(null)} snap=${snap} isAdmin=${isAdmin} tripId=${tripId} />
    <${ExpenseSheet} open=${sheet === 'expense'} onClose=${() => setSheet(null)} snap=${snap} me=${me} tripId=${tripId} />
    ${isAdmin
      ? html`<${AlbumSheet} open=${sheet === 'album'} onClose=${() => setSheet(null)} trip=${trip} />`
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
  // an urgent announcement I haven't seen stays the home card's news (3 days), even when newer ones came after it
  const readIds = new Set((snap.reads || []).filter((r) => r.member_id === me?.id).map((r) => r.notification_id));
  const news = pinnedNotices(snap).find((n) => n.author_member !== me?.id && !readIds.has(n.id))
    || visibleNotifications(snap).find((n) => n.kind === 'announcement') || null;
  const newsRead = news
    ? news.author_member === me?.id || (snap.reads || []).some((r) => r.notification_id === news.id && r.member_id === me?.id)
    : true;
  return {
    snap,
    trip: snap.trip,
    tripId: snap.trip.id,
    me,
    person: (typeof snap.me?.person === 'string' && snap.me.person.trim()) || null,
    members,
    byId,
    cats,
    heads,
    pledgesByItem,
    ready,
    missing,
    agenda,
    pending,
    balance: me ? myNet(snap) : 0,                 // the settle-up's own whole-shekel number
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

function Hero({ model, me, now, isAdmin }) {
  const { trip, heads } = model;
  const cd = trip.starts_at ? countdown(trip.starts_at, now, trip.ends_at) : null;
  const when = trip.starts_at ? `${formatDate(trip.starts_at)} · ${formatTime(trip.starts_at)}` : '';
  // greet the person holding this phone ("בוקר טוב, נועה"), not the whole family profile
  const names = me ? (model.person || (me.people?.length ? me.people.join(' ו') : displayName(me))) : '';
  const tripHref = href(`/t/${trip.id}/trip`);
  // compact (ux H1): one countdown line, no tiles, no phase strip, no CTA pill — the cards below carry the actions
  return html`<section class="hero home-hero" aria-labelledby="home-trip-name">
    <div class="home-hero__top">
      <span class="home-hero__emoji" aria-hidden="true">${trip.emoji || '⛺'}</span>
      <div class="home-hero__titles">
        <h1 class="home-hero__name" id="home-trip-name">${trip.name}</h1>
        ${cd?.label
          ? html`<p class=${cx('home-cd', cd.past && 'home-cd--past')} role="timer" aria-live="off">
              <span class="home-cd__label">${cd.label}</span>${trip.starts_at && !cd.past
                ? html`<span class="home-cd__when"> · ${formatDate(trip.starts_at, { weekday: 'short', day: 'numeric', month: 'numeric' })} ${formatTime(trip.starts_at)}</span>`
                : null}
            </p>`
          : when
            ? html`<p class="home-hero__when">${when}</p>`
            : isAdmin
              ? html`<a class="home-hero__when home-hero__when--link" href=${`${tripHref}?edit=1`}>עוד לא נקבע תאריך — לקבוע ←</a>`
              : html`<p class="home-hero__when">התאריך עוד לא נקבע 🗓️</p>`}
      </div>
    </div>

    <div class="home-hero__foot">
      ${names && !cd?.past ? html`<span class="sr-only home-hero__hello">${greeting(now)}, ${names} 👋</span>` : null}
      <a class="home-hero__chip" href=${tripHref}>
        <${Icon} name="map-pin" size=${16} />
        <span class="home-hero__chip-text">${trip.location || 'פרטי הטיול'}</span>
        <${Icon} name="chevron-left" size=${16} />
      </a>
      <a class="home-hero__people" href=${href(`/t/${trip.id}/people`)} aria-label=${`${hebrewCount(heads, 'משתתף', 'משתתפים')} — לרשימת החבר'ה`}>
        <span class="home-hero__heads"><${Icon} name="users" size=${15} /><span class="num">${heads}</span></span>
        <${Icon} name="chevron-left" size=${16} />
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
  // my car's time, else the schedule's first row when it's before the start ("03:30 יוצאים לשדה")
  const leave = departureOf(trip);
  const depart = rides.mySeat?.depart_at || rides.myRide?.depart_at || leave.at;
  const firstRow = !rides.mySeat?.depart_at && !rides.myRide?.depart_at ? leave.row : null;
  // what "הרשימה שלי" still shows unticked: what I bring, "כל אחד מביא", what I buy / do, and my own packing list
  const mine = myAgenda(snap, me.id);
  const on = (x) => itemTypeOn(trip, x.item.type);
  const open = mine.bring.filter((x) => on(x) && !x.pledge.done).length + mine.each.filter((x) => on(x) && !x.done).length
    + [...mine.buy, ...mine.tasks].filter((x) => on(x) && !x.item.done).length
    + (hasModule(trip, 'packing') ? (snap.personal_items || []).filter((p) => !p.done).length : 0);
  const waze = trip.settings?.where === 'abroad' ? null : wazeUrl(trip);   // abroad: no Waze from home to "רומא"
  const rideText = myRideText(rides);

  return html`<section class=${`tripday tripday--${phase}`} aria-labelledby="tripday-title" data-testid="trip-day">
    <div class="tripday__top">
      <span class="tripday__emoji" aria-hidden="true">${phase === 'day' ? '🚗' : '🎒'}</span>
      <div class="tripday__text">
        <h2 class="tripday__title" id="tripday-title">${phase === 'day' ? 'יוצאים היום!' : 'מחר יוצאים!'}</h2>
        <p class="tripday__sub">
          ${[depart && (firstRow ? `${firstRow.emoji ? `${firstRow.emoji} ` : ''}${formatTime(depart)} ${firstRow.label}`.trim() : `יציאה ב-${formatTime(depart)}`), trip.location].filter(Boolean).join(' · ')}
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
  // per person (a newer server): someone else's device (another e-mail) already is that person → the server
  // would refuse it; "mine" = my e-mail on another device → fine. Older server: every name stays tappable.
  const rows = Array.isArray(me?.persons) ? new Map(personsOf(me).map((p) => [p.name, p])) : null;
  const takenBy = (p) => Boolean(rows?.get(p)?.joined && !rows.get(p).mine);
  const choosable = people.filter((p) => !takenBy(p));
  const open = Boolean(me && people.length > 1 && choosable.length && snap.me && !snap.me.person && !dismissed && phase !== 'during');
  const joined = new Set(me?.joined || []);
  const hint = (p) => {
    if (busy === p) return 'רגע…';
    if (rows) return rows.get(p)?.mine ? 'זה את/ה — כבר נכנסת ממכשיר אחר 👍' : takenBy(p) ? `${p} כבר נכנס/ה מטלפון משלו/ה` : 'זה אני';
    return joined.has(p) ? 'נכנס/ה גם ממכשיר אחר — אם זה את/ה, מצוין' : 'זה אני';
  };
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
  // "אחר כך" always closes it; a name someone else's phone already is can't be picked (the server says so too)
  return html`<${Sheet} open=${open} onClose=${later} title=${`מי את/ה ב״${me ? displayName(me) : ''}״? 🙋`}>
    <div class="stack" data-testid="who-am-i">
      <p class="muted">פעם אחת — ככה כולם רואים מי מביא ומי ראה, בלי בלבול.</p>
      <div class="welcome-opts" role="radiogroup" aria-label="מי את/ה">
        ${people.map((p) => html`<button type="button" role="radio" key=${p} aria-checked="false" class="welcome-opt"
          disabled=${Boolean(busy) || takenBy(p)} onClick=${() => choose(p)}>
          <span class="welcome-opt__emoji" aria-hidden="true">${takenBy(p) ? '📱' : '🙋'}</span>
          <span class="welcome-opt__text"><b>אני ${p}</b><span>${hint(p)}</span></span>
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

const CREW = {
  rides: { emoji: '🚗', done: 'סימנו איך מגיעים', missing: 'עוד לא סימנו', nudge: true },
  flights: { emoji: '✈️', done: 'הזינו טיסה', missing: 'עוד בלי טיסה', nudge: true },
  polls: { emoji: '📊', done: 'הצביעו בסקרים', missing: 'עוד לא הצביעו', nudge: true },
  lists: { emoji: '🤲', done: 'לקחו משהו מהרשימה', missing: 'עוד לא לקחו כלום', nudge: true },
  money: { emoji: '💸', done: 'שילמו את הבקשות', missing: 'עוד לא שילמו', nudge: true },
  rooms: { emoji: '🛏️', done: 'משובצים לחדר', missing: 'עוד בלי חדר', nudge: false },
};

/** Admins: who's still missing in each feature that's on — names, and a gentle nudge (once a day). */
function CrewCard({ snap }) {
  const [busy, setBusy] = useState(null);
  const rows = (Array.isArray(snap.status) ? snap.status : []).filter((g) => CREW[g.key] && g.done < g.total);
  if (!rows.length) return null;
  const byId = membersById(snap.members || []);
  const nudge = async (key) => {
    setBusy(key);
    const n = await actions.run((api) => api.nudgeMembers(snap.trip.id, key));
    setBusy(null);
    if (n == null) return;
    actions.toast(n ? `נשלחה תזכורת עדינה ל-${hebrewCount(n, 'משתתף/ת', 'משתתפים')} 🙂` : 'כולם כבר קיבלו תזכורת היום 🙂', 'success', 3200);
  };
  const nudgeable = rows.filter((g) => CREW[g.key].nudge);
  return html`<${Card} emoji="👥" title="אצל החבר׳ה" class="checklist crew" data-testid="crew-card">
    <ul class="crew__list">
      ${rows.map((g) => {
        const c = CREW[g.key];
        const names = g.missing.map((id) => displayName(byId.get(id))).join(', ');
        return html`<li key=${g.key} class="crew__row" data-module=${g.key}>
          <div class="crew__head">
            <span class="crew__emoji" aria-hidden="true">${c.emoji}</span>
            <span class="crew__text"><b class="num">${g.done}/${g.total}</b> ${c.done}</span>
          </div>
          <p class="crew__who small"><span class="muted">${c.missing}:</span> ${names}</p>
        </li>`;
      })}
    </ul>
    ${nudgeable.length
      ? html`<p class="crew__nudge small" data-testid="crew-nudge">
          <span class="muted">🔔 תזכורת עדינה:</span>
          ${nudgeable.map((g, i) => html`${i ? html`<span aria-hidden="true"> · </span>` : null}<button type="button" class="link crew__link"
            key=${g.key} data-module=${g.key} disabled=${busy === g.key} aria-label=${`תזכורת עדינה — ${CREW[g.key].missing}`}
            onClick=${() => nudge(g.key)}>${CREW[g.key].emoji} ${CREW_LABEL[g.key]}</button>`)}
        </p>`
      : null}
  </${Card}>`;
}

const CREW_LABEL = { rides: 'הגעה', flights: 'טיסות', polls: 'סקרים', lists: 'רשימה', money: 'תשלום', rooms: 'חדרים' };

function ChecklistCard({ snap, me }) {
  // "מה אני מביא/ה" is the my-list card's job (ux H2) — the checklist keeps the rest
  const all0 = myChecklist(snap, me.id, { hasEmail: Boolean(me.prefs?.has_email) });
  const items = all0.items.filter((it) => it.key !== 'bring');
  const total = items.length;
  const done = items.filter((it) => it.done).length;
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
  // the admins' phones, per person (their own phone, else their profile's) — each number once
  const seen = new Set();
  const admins = adminPersons(snap).filter((a) => {
    const digits = String(a.phone || '').replace(/[^\d+]/g, '');
    if (!digits || seen.has(digits)) return false;
    seen.add(digits);
    return true;
  });
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
      ${admins.map((a) => html`<${Button} key=${`${a.member.id}:${a.name}`} variant="ghost" href=${`tel:${a.phone.replace(/[^\d+]/g, '')}`}>📞 ${a.name}</${Button}>`)}
    </div>
    <a class="rest__more" href=${href(`/t/${trip.id}/lists`)}>צריך בכל זאת לבדוק משהו? לרשימות ←</a>
  </section>`;
}

/** Israeli mobile → '050-123-4567'; anything else as typed. */
const prettyPhone = (phone) => {
  const d = String(phone || '').replace(/\D/g, '');
  return /^05\d{8}$/.test(d) ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : String(phone || '').trim();
};

/**
 * After the trip — one closing card (ux A1): the ONE net number with its one action, the album, the trip in
 * numbers with one share. Requests for an expense's shares are part of the net → "כולל …", not a second debt.
 */
function AfterCard({ snap, me, isAdmin, onAlbum }) {
  const trip = snap.trip;
  const [cloning, setCloning] = useState(false);
  const money = hasModule(trip, 'money');
  const bals = money ? balances(snap) : [];
  // the same plan the money screen shows (a couple that pays each their own part settles per person)
  const plan = money ? tripPlan(snap) : [];
  const byId = membersById(snap.members || []);
  const person = (me.people || []).includes(snap.me?.person) ? snap.me.person : null;
  const myKey = person && splitsMoney(me) ? `${me.id}::${person}` : me.id;
  const isMine = (key) => key === myKey || (myKey === me.id && partyOf(key).member_id === me.id);
  const out = plan.filter((t) => isMine(t.from) && !isMine(t.to));
  const inn = plan.filter((t) => isMine(t.to) && !isMine(t.from));
  const names = (keys) => [...new Set(keys.map((k) => partyName(snap, k)))].join(', ');
  const outSum = out.reduce((n, t) => n + t.amount, 0);
  const inSum = inn.reduce((n, t) => n + t.amount, 0);
  const payee = out.length ? partyOf(out[0].to).member_id : null;
  const toPay = payee ? payMethodsOf(snap, payee) : null;
  const bit = toPay?.bit || (payee ? byId.get(payee)?.phone : null) || null;
  // what else keeps the money open: requests with a share to pay / to confirm, transfers waiting for "קיבלתי"
  const openReqs = money ? openMoneyRequests(snap) : [];
  const mineOf = (rows) => rows.filter((o) => o.member_id === me.id && (!o.person || myKey === me.id || o.person === person));
  // requests for an expense's shares that I still owe — already inside the net
  const included = openReqs.filter((r) => r.request.expense_id)
    .flatMap((r) => mineOf(r.owes).map((o) => `${formatMoney(o.amount)} ${r.request.title}`));
  // money asked before buying isn't in the balances: a share of mine there is a debt of its own
  const asked = openReqs.filter((r) => !r.request.expense_id)
    .flatMap((r) => mineOf(r.owes).map((o) => ({ ...o, request: r.request })));
  // … and the other way round: what people still haven't paid on a collection I asked for
  const awaited = openReqs.filter((r) => !r.request.expense_id && r.request.requested_by === me.id && r.owes.length);
  const awaitedSum = awaited.reduce((n, r) => n + r.owes.reduce((k, o) => k + Math.round(o.amount * 100), 0), 0) / 100;
  const sentRows = money ? (snap.payments || []).filter((p) => p.status === 'sent') : [];
  // waiting for MY "קיבלתי" (inside a couple: only the partner who got it) / my own, waiting for theirs
  const toConfirm = sentRows.filter((p) => p.to_member === me.id && (p.from_member !== me.id || p.to_person === person));
  const myWaiting = sentRows.filter((p) => p.from_member === me.id && !toConfirm.includes(p)
    && (!p.from_person || myKey === me.id || p.from_person === person));
  const sumOf = (rows) => rows.reduce((n, p) => n + Math.round(Number(p.amount) * 100), 0) / 100;
  const payName = (memberId, who) => (who && splitsMoney(byId.get(memberId)) ? who : displayName(byId.get(memberId)));
  // admins: how far the trip is from closed — what was moved, out of everything there is to move (the plan and
  // what's still asked before buying)
  const sentCents = bals.reduce((n, b) => n + Math.round((b.sent || 0) * 100), 0)
    + moneyPots(snap).reduce((n, p) => n + Math.round(p.collected * 100), 0);
  const leftCents = plan.reduce((n, t) => n + Math.round(t.amount * 100), 0)
    + openReqs.filter((r) => !r.request.expense_id).reduce((n, r) => n + r.owes.reduce((k, o) => k + Math.round(o.amount * 100), 0), 0);
  const pct = sentCents + leftCents > 0 ? Math.round((sentCents / (sentCents + leftCents)) * 100) : 100;
  const openFrom = new Set(plan.map((t) => partyOf(t.from).member_id)).size;
  const reqOpen = openReqs.filter((r) => r.owes.length).length;
  const adminParts = [
    openFrom ? (openFrom === 1 ? 'אחד עוד לא סגר' : `${openFrom} עוד לא סגרו`) : null,
    reqOpen ? (reqOpen === 1 ? 'בקשה אחת פתוחה' : `${reqOpen} בקשות פתוחות`) : null,
    sentRows.length ? (sentRows.length === 1 ? 'העברה אחת מחכה לאישור' : `${sentRows.length} העברות מחכות לאישור`) : null,
  ].filter(Boolean);
  const moneyHref = href(`/t/${trip.id}/money`);

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

  let moneyBody = null;
  if (money) {
    let line;
    let action = null;
    let state = 'closed';
    if (out.length) {
      state = 'pay';
      line = html`עליך להעביר <b class="num" data-testid="after-amount">${formatMoney(outSum)}</b> ל${names(out.map((t) => t.to))}`;
      action = html`<${Button} block href=${`${moneyHref}?pay=me`} data-testid="after-pay">✓ שילמתי${out.length === 1 ? ` ${formatMoney(outSum)}` : ''}</${Button}>`;
    } else if (asked.length) {
      // a request I haven't paid (money asked before buying): still open, whatever the settle-up says
      state = 'asked';
      const a = asked[0];
      line = html`עליך <b class="num" data-testid="after-amount">${formatMoney(sumOf(asked))}</b> ל${actorName(byId.get(a.request.requested_by), a.request.by_person)} · ${a.request.title}${asked.length > 1 ? ` ועוד ${asked.length - 1}` : ''}`;
      action = html`<${Button} block href=${`${moneyHref}?show=requests`} data-testid="after-request">לבקשה ולתשלום</${Button}>`;
    } else if (inn.length) {
      state = 'get';
      line = html`${names(inn.map((t) => t.from))} ${inn.length > 1 ? 'מעבירים' : 'מעביר/ה'} לך <b class="num" data-testid="after-amount">${formatMoney(inSum)}</b>`;
    } else if (awaited.length) {
      state = 'awaited';
      const n = awaited.reduce((k, r) => k + r.owes.length, 0);
      line = html`עוד לא שילמו לך <b class="num" data-testid="after-amount">${formatMoney(awaitedSum)}</b> על ${awaited.map((r) => `״${r.request.title}״`).join(', ')} · ${n === 1 ? 'אחד עוד לא שילם' : `${n} עוד לא שילמו`}`;
    } else if (toConfirm.length) {
      // the money is marked as sent to me: closed only once I say it arrived
      state = 'confirm';
      line = html`נשאר רק לאשר שקיבלת <b class="num" data-testid="after-amount">${formatMoney(sumOf(toConfirm))}</b> מ${[...new Set(toConfirm.map((p) => payName(p.from_member, p.from_person)))].join(', ')}`;
    } else if (myWaiting.length) {
      state = 'waiting';
      line = html`שילמת <b class="num" data-testid="after-amount">${formatMoney(sumOf(myWaiting))}</b> ✓ · מחכה לאישור של ${[...new Set(myWaiting.map((p) => payName(p.to_member, p.to_person)))].join(', ')}`;
    } else {
      line = html`הכול סגור ✓ תודה! 🔥`;
    }
    moneyBody = html`<div class="after__money" data-testid="after-money" data-state=${state}>
      <h2 class="after__title">💸 סוגרים חשבון</h2>
      <p class="after__line">${line}</p>
      ${included.length && out.length ? html`<p class="after__incl small muted" data-testid="after-included">כולל ${included.join(' · ')}</p>` : null}
      ${action}
      ${state === 'pay' && bit ? html`<p class="after__bit small muted">ביט <bdi dir="ltr" class="num">${prettyPhone(bit)}</bdi></p>` : null}
      ${isAdmin
        ? html`<a class="after__row" href=${moneyHref} data-testid="after-admin">
            <span>👑 ${pct >= 100 && adminParts.length ? 'כמעט סגור' : html`נסגר <b class="num">${pct}%</b>`}${adminParts.length ? ` · ${adminParts.join(' · ')}` : ''}</span>
            <${Icon} name="chevron-left" size=${16} />
          </a>`
        : !action
          ? html`<a class="after__row" href=${moneyHref}><span>לפרטים במסך הכסף</span><${Icon} name="chevron-left" size=${16} /></a>`
          : null}
    </div>`;
  }

  return html`<section class="after" data-testid="after">
    ${moneyBody}
    ${isAdmin
      ? html`<div class="after__again" data-testid="after-again"><${Button} variant="secondary" block onClick=${() => setCloning(true)}>🔁 לעשות את זה שוב — טיול חדש מהרשימות האלה</${Button}>
          <${CloneSheet} open=${cloning} tripId=${trip.id} name=${trip.name} snap=${snap} onClose=${() => setCloning(false)} /></div>`
      : null}
    <div class="after__photos">
      ${album
        ? html`<a class="after__row" href=${album} target="_blank" rel="noopener"><span>📸 לאלבום התמונות</span><${Icon} name="chevron-left" size=${16} /></a>`
        : isAdmin
          ? html`<${Button} variant="secondary" block onClick=${onAlbum}>📸 הוספת אלבום משותף</${Button}>`
          : html`<p class="muted small">📸 אלבום משותף — המנהלים יוסיפו קישור</p>`}
    </div>
    <div class="after__numbers">
      <p class="after__stats" aria-label="הטיול במספרים">${[
        hebrewCount(stats.people, 'משתתף', 'משתתפים'),
        stats.spent ? `${formatMoney(stats.perPerson)} לאדם` : null,
      ].filter(Boolean).join(' · ')}</p>
      <${ShareButton} text=${share} label="שיתוף ״הטיול במספרים״" variant="secondary" block />
    </div>
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
    <${ProgressRing} value=${pct} size=${60} stroke=${7} label="מוכנות הטיול">
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
    text = `מגיע לך ${formatMoney(balance)}`;                 // balance = myNet: whole shekels, as the money screen
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

function QuickActions({ proposes, summary, onItem, onExpense }) {
  // two labelled actions; "הודעה לכולם" lives on the messages tab, the WhatsApp summary is a text link (ux H2)
  const tiles = [onItem, onExpense].filter(Boolean).length;
  return html`<nav class=${cx('home-qa', tiles === 2 ? 'home-qa--2' : 'home-qa--1')} aria-label="פעולות מהירות">
    ${onItem
      ? html`<button type="button" class="qa-tile" onClick=${onItem}>
          <span class="qa-tile__emoji" aria-hidden="true">➕</span>
          <span class="qa-tile__label">${proposes ? 'הצע פריט' : 'הוסף פריט'}</span>
        </button>`
      : null}
    ${onExpense
      ? html`<button type="button" class="qa-tile" onClick=${onExpense}>
          <span class="qa-tile__emoji" aria-hidden="true">🧾</span>
          <span class="qa-tile__label">הוצאה חדשה</span>
        </button>`
      : null}
    ${summary
      ? html`<div class="qa-share" data-testid="qa-share">
          <${ShareButton} text=${summary} label="סיכום לוואטסאפ" variant="ghost" size="sm" />
        </div>`
      : null}
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
        ? html`<${Avatar} member=${author} size=${24} /><span class="home-news__author">${actorName(author, news.by_person)}</span>`
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
    // a couple that brings it each their own (§19): my share, or an open one nobody took yet
    { key: 'each', title: '🙋 כל אחד מביא', rows: agenda.each.map(({ item, done, split, qty, open }) => ({
      item, kind: 'each', done, meta: split ? (qty > 0 ? (qty > 1 ? `${qty} שלי` : '') : `עוד ${open} — מי מביא?`) : '',
    })) },
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

  // summary first (ux H2): the next 3 open things; done ones and the rest live in "my list"
  const open = rows.filter((row) => !row.done);
  const shown = open.slice(0, MINE_SHOWN);
  const more = open.length - shown.length;
  const groupOf = new Map(groups.flatMap((g) => g.rows.map((r) => [r, g.title])));
  const listHref = href(`/t/${tripId}/lists?tab=mine`);

  return html`<${Card}
    class="home-mine"
    emoji="🎒"
    title="המשימות שלי"
    action=${total ? html`<span class="mine-progress__text"><b class="num">${doneCount}/${total}</b> ${pct === 100 ? 'הכל מוכן 🎉' : 'מוכנים'}</span>` : null}
  >
    ${total
      ? html`<${ProgressBar} value=${pct} tone="accent" label="כמה מהרשימה שלי מוכן" />
        ${shown.length
          ? html`<ul class="mine-list">
              ${shown.map((row) => {
                const checked = isDone(row);
                const cat = cats.get(row.item.category_id);
                const sub = [row.meta, cat ? `${cat.emoji} ${cat.name}` : groupOf.get(row)].filter(Boolean).join(' · ');
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
            </ul>`
          : html`<p class="checklist__all">הכל מוכן אצלך 🎉</p>`}
        <a class="home-card-link home-mine__all" href=${listHref}>לרשימה שלי${more > 0 ? ` (עוד ${more})` : ''} ‹</a>`
      : html`<p class="muted small">עוד לא לקחת כלום — בוחרים משהו מ״עדיין חסר״ ✋</p>`}
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

function StillMissing({ model, busy, onTake, onAdd, canImport = true }) {
  const { missing, ready, cats, members, pledgesByItem, heads, me, tripId } = model;
  const shown = missing.slice(0, MISSING_SHOWN);
  const more = missing.length - shown.length;
  const listsHref = href(`/t/${tripId}/lists`);

  let body;
  if (!ready.total) {
    body = html`<${EmptyState}
      emoji="📝"
      title="הרשימות עוד ריקות"
      text="בונים רשימה קטגוריה אחרי קטגוריה, מדביקים מהוואטסאפ או מוסיפים פריט ראשון"
      action=${html`<div class="row row--center wrap">
        <${Button} size="sm" icon="➕" onClick=${onAdd}>הוספת פריט</${Button}>
        <${Button} size="sm" variant="secondary" icon="✨" href=${href(`/t/${tripId}/build`)}>בניית רשימה מהירה</${Button}>
        ${canImport ? html`<${Button} size="sm" variant="secondary" icon="📥" href=${href(`/t/${tripId}/import`)}>ייבוא מוואטסאפ</${Button}>` : null}
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
      const b = blankItem();
      setF(itemTypeOn(snap.trip, b.type) ? b : { ...b, type: 'task' });   // "מי מביא מה" off: tasks only
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
    const guess = TYPE_BY_CATEGORY_EMOJI[cat.emoji] || 'buy';
    if (next && !typeTouched.current && itemTypeOn(snap.trip, guess)) patch.type = guess;
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
          options=${TYPE_OPTIONS.filter((o) => o.value === f.type || itemTypeOn(snap.trip, o.value))}
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
