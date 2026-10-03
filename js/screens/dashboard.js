// "הבית שלי" (SPEC §8.0): the landing when I have a trip or an invitation — hello + my account, what matters
// now across all my trips, invitations from past trips (accept / decline), a card per trip, past trips.
// Also serves #/invite/:inviteId (the e-mail / push link of an invitation).
import { html } from 'htm/preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { actions, useStore } from '../store.js?v=9252f89';
import { navigate } from '../router.js?v=9252f89';
import { countdown, formatMoney, hebrewCount, isAdmin, timeAgo, tripPhase } from '../lib/logic.js?v=9252f89';
import { adminParts, cardThings, splitTrips, totals, tripDebt, urgentStrip } from '../lib/overview.js?v=9252f89';
import { Avatar, Button, IconButton, Pill, Section, Sheet, Skeleton, confirmDialog, fireConfetti } from '../ui/components.js?v=9252f89';
import { Icon } from '../ui/icons.js?v=9252f89';
import { EmailGate } from '../ui/email-gate.js?v=9252f89';
import { Entry } from '../ui/account.js?v=9252f89';
import { CodeEntry, Hero, Landing, TripCard, dateRange } from './onboarding.js?v=9252f89';
import { AccountForm } from './me.js?v=9252f89';
import { CloneSheet } from '../ui/clone-sheet.js?v=9252f89';

const cx = (...a) => a.filter(Boolean).join(' ');
const REFRESH_MS = 60000;
const URGENT_SHOWN = 4;

export default function DashboardScreen({ route }) {
  const { trips, invites, contact } = useStore((s) => ({ trips: s.trips, invites: s.invites, contact: s.contact }));
  const inviteId = route.name === 'invite' ? route.params.inviteId : null;
  const openCode = route.query?.link === '1';

  if (inviteId && !contact?.verified) return html`<${InviteGate} />`;
  if (!inviteId && !(trips || []).length && !(invites || []).length) {
    return html`<${Entry}><${Landing} openCode=${openCode} /></${Entry}>`;
  }
  return html`<${Dashboard} inviteId=${inviteId} openCode=${openCode} />`;
}

/** #/invite/:id without a verified e-mail: verify once, then the invitation shows. */
function InviteGate() {
  return html`<div class="onb onb--flow dash-gate">
    <${Hero} compact>
      <div class="onb-brand">
        <h1 class="onb-brand__name">📨 הוזמנת לטיול!</h1>
        <p class="onb-brand__tag">ההזמנה נשלחה למייל שלך — מאמתים אותו פעם אחת</p>
      </div>
    </${Hero}>
    <div class="onb__body onb__body--lift">
      <${EmailGate} mode="inline" />
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// the dashboard
// ---------------------------------------------------------------------------

function useRefreshing() {
  useEffect(() => {
    actions.loadTrips();
    actions.loadOverview({ force: true });
    actions.loadInvites();
    actions.loadAccount();
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const onVis = () => {
      if (visible()) {
        actions.loadOverview({ force: true });
        actions.loadInvites();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    const timer = setInterval(() => {
      if (visible()) {
        actions.loadOverview();
        actions.loadInvites();
      }
    }, REFRESH_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(timer);
    };
  }, []);
}

function Dashboard({ inviteId, openCode }) {
  const s = useStore((st) => ({
    trips: st.trips, overview: st.overview, overviewAt: st.overviewAt, invites: st.invites,
    contact: st.contact, online: st.online, account: st.account, ready: st.ready,
  }));
  useRefreshing();
  const [highlight, setHighlight] = useState(null);
  const [inviteFailed, setInviteFailed] = useState(false); // #/invite/:id: couldn't load my invitations
  const [attempt, setAttempt] = useState(0);
  const now = new Date();

  // #/invite/:id → scroll to that invitation, or say it's no longer open. A failed load is NOT "closed": it says
  // so, keeps the route and offers a retry.
  useEffect(() => {
    if (!inviteId) return undefined;
    let alive = true;
    setInviteFailed(false);
    actions.loadInvites().then((list) => {
      if (!alive) return;
      if (list === null) {
        setInviteFailed(true);
      } else if (list.some((i) => i.id === inviteId)) {
        setHighlight(inviteId);
        requestAnimationFrame(() => document.getElementById(`invite-${inviteId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      } else {
        actions.toast('ההזמנה הזאת כבר לא פתוחה — אם כבר הצטרפת, הטיול מחכה ברשימה', 'info', 4200);
        navigate('/', { replace: true });
      }
    });
    return () => {
      alive = false;
    };
  }, [inviteId, attempt]);

  const rows = Array.isArray(s.overview) ? s.overview : null;
  const byTrip = useMemo(() => new Map((rows || []).map((ov) => [ov?.trip?.id, ov])), [rows]);
  // "my trips": the nearest first; every finished trip sits in the fold below (2026-10-03). A debt never disappears
  // quietly (ux A5): the fold says so, and the urgent strip above keeps naming it.
  const { current, past } = useMemo(() => splitTrips(s.trips, now), [s.trips, byTrip]);
  const owingPast = past.filter((e) => tripDebt(byTrip.get(e.trip.id)) > 1).length;
  const urgent = useMemo(() => urgentStrip(rows || [], s.invites, now), [rows, s.invites]);
  const sum = useMemo(() => totals(rows || [], now), [rows]);
  const loading = s.overview === undefined;
  const stale = !s.online && s.overviewAt;

  return html`<div class="dash" data-testid="dashboard">
    <${Head} account=${s.account} contact=${s.contact} trips=${s.trips} rows=${rows} />
    ${stale ? html`<p class="dash-stale tiny muted" role="status">📶 אין חיבור · עודכן ${timeAgo(new Date(s.overviewAt))}</p>` : null}
    <${Stats} sum=${sum} rows=${rows} trips=${current} invites=${s.invites} loading=${loading} now=${now} urgent=${urgent.length} />
    ${inviteId && inviteFailed
      ? html`<div class="card dash-invite dash-invite--error" role="alert" data-testid="invite-load-error">
          <p class="dash-invite__title">📶 לא הצלחנו לטעון את ההזמנה</p>
          <p class="small muted">היא לא נסגרה — בודקים את החיבור ומנסים שוב.</p>
          <div class="dash-invite__actions">
            <${Button} variant="accent" onClick=${() => setAttempt((n) => n + 1)}>לנסות שוב</${Button}>
          </div>
        </div>`
      : null}
    ${urgent.length ? html`<${Urgent} items=${urgent} />` : null}
    ${(s.invites || []).length
      ? html`<section class="dash-sec dash-invites" aria-labelledby="dash-invites-h">
          <h2 class="dash-sec__h" id="dash-invites-h">📨 הזמנות <span class="dash-sec__count num">${s.invites.length}</span></h2>
          ${s.invites.map((i) => html`<${InviteCard} key=${i.id} invite=${i} highlight=${highlight === i.id} online=${s.online} />`)}
        </section>`
      : null}
    ${current.length
      ? html`<section class="dash-sec" aria-labelledby="dash-trips-h">
          <h2 class="dash-sec__h" id="dash-trips-h">הטיולים שלי <span class="dash-sec__count num">${current.length}</span></h2>
          ${current.map((e) => html`<${TripBox} key=${e.trip.id} entry=${e} ov=${byTrip.get(e.trip.id)} loading=${loading} now=${now} />`)}
        </section>`
      : null}
    ${past.length
      ? html`<${Section} title=${owingPast ? `טיולים שהסתיימו · 💸 ${hebrewCount(owingPast, 'עם חשבון פתוח', 'עם חשבון פתוח')}` : 'טיולים שהסתיימו'} emoji="🗂️" count=${past.length}
          collapsible defaultOpen=${owingPast > 0} class="dash-past" data-testid="dash-past">
          <div class="stack-sm">${past.map((e) => html`<div class="dash-past__row" key=${e.trip.id}>
            <${TripCard} entry=${e} />
            <${CloneButton} entry=${e} />
            <${DeleteTripButton} entry=${e} />
            ${tripDebt(byTrip.get(e.trip.id)) > 1
              ? html`<a class="dash-past__debt small" href=${`#/t/${e.trip.id}/money`} data-testid="dash-past-debt">💸 עוד פתוח: עליך להעביר ${formatMoney(tripDebt(byTrip.get(e.trip.id)))}</a>` : null}
          </div>`)}</div>
        </${Section}>`
      : null}
    <div class="dash-actions stack">
      <${Button} variant="accent" size="lg" block icon="plus" href="#/new">טיול חדש</${Button}>
      <${CodeEntry} startOpen=${openCode} />
      ${s.contact?.verified ? null : html`<${Button} variant="ghost" block href="#/signin">🔑 התחברות עם המייל</${Button}>`}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// head: hello + my account
// ---------------------------------------------------------------------------

function Head({ account, contact, trips, rows }) {
  const snapPerson = useStore((st) => st.snap?.me?.person || null);
  const [sheet, setSheet] = useState(null); // 'account' | 'email' | null
  const verified = Boolean(contact?.verified);
  useEffect(() => {
    if (sheet === 'email' && verified) setSheet(null);
  }, [verified]);
  // the profile I opened last (else my first trip's)
  let last = null;
  try {
    last = localStorage.getItem('medura:lastTrip');
  } catch {
    /* storage unavailable */
  }
  const entry = (trips || []).find((e) => e.trip?.id === last) || (trips || [])[0] || null;
  const row = rows?.find((r) => r?.trip?.id === entry?.trip?.id);
  const person = row?.person || (rows || []).find((r) => r?.person)?.person || snapPerson || null;
  const name = account?.name || person;
  return html`<header class="dash-head">
    <${Avatar} member=${entry?.member || { emoji: '🔥', color: '#F28C28', display_name: name || '' }} size=${52} />
    <div class="dash-head__text">
      <h1 class="dash-head__hello">${name ? `היי ${name} 👋` : 'היי! 👋'}</h1>
      ${verified
        ? html`<p class="dash-head__mail small"><bdi dir="ltr">${contact.email}</bdi> <span aria-label="מאומת">✓</span></p>`
        : html`<button type="button" class="link small dash-head__verify" onClick=${() => setSheet('email')}>🔐 לאמת מייל — כל הטיולים בכל מכשיר</button>`}
    </div>
    ${verified && account?.verified
      ? html`<${IconButton} icon="edit" label="עריכת הפרטים שלי" class="dash-head__edit" onClick=${() => setSheet('account')} />`
      : null}
    <${Sheet} open=${sheet === 'account'} onClose=${() => setSheet(null)} title="✏️ הפרטים שלי" class="dash-account">
      ${account?.verified ? html`<${AccountForm} key=${account.email} acc=${account} />` : null}
    </${Sheet}>
    <${Sheet} open=${sheet === 'email'} onClose=${() => setSheet(null)} title="🔐 אימות מייל">
      ${sheet === 'email' ? html`<${EmailGate} mode="inline" />` : null}
    </${Sheet}>
  </header>`;
}

// ---------------------------------------------------------------------------
// stats tiles
// ---------------------------------------------------------------------------

function Stats({ sum, rows, trips, invites, loading, now, urgent }) {
  // next trip: from the overview, else from my trips (an older server)
  const nextTrip = sum.next?.trip || trips.find((e) => e.trip.starts_at && ['before', 'eve', 'departure', 'during'].includes(tripPhase(e.trip, now)))?.trip || null;
  const cd = nextTrip ? countdown(nextTrip.starts_at, now, nextTrip.ends_at) : null;
  const soon = Boolean(cd?.label?.startsWith('בעוד '));
  const waiting = sum.answers + (invites || []).length;
  // one money number (ux A5): each trip card says its own debt; the tile adds them up only when there's
  // money open in more than one trip ("בכל הטיולים")
  const debts = (rows || []).map((ov) => tripDebt(ov)).filter((d) => d > 1);
  const oweAll = Math.round(debts.reduce((n, d) => n + d, 0) * 100) / 100;
  // "מחכים לך 0" contradicted "עכשיו חשוב" (ux H5): the tile shows only when something waits and isn't listed there
  const showWaiting = waiting > 0 && !urgent;
  return html`<div class="dash-stats" role="list">
    <a class="dash-stat" role="listitem" href=${nextTrip ? `#/t/${nextTrip.id}` : '#/new'}>
      <span class="dash-stat__k">${soon ? '🧭 הבא בעוד' : '🧭 הבא'}</span>
      <span class="dash-stat__v">${soon ? cd.label.slice(5) : cd?.label || (nextTrip ? 'בלי תאריך' : 'אין עדיין')}</span>
      <span class="dash-stat__l truncate">${nextTrip ? `${nextTrip.emoji || '⛺'} ${nextTrip.name}` : 'טיול חדש?'}</span>
    </a>
    ${debts.length > 1
      ? html`<div class="dash-stat dash-stat--warn" role="listitem" data-testid="dash-owe-all">
          <span class="dash-stat__k">💸 עליך להעביר</span>
          <bdi class="dash-stat__v num">${formatMoney(oweAll)}</bdi>
          <span class="dash-stat__l">בכל הטיולים</span>
        </div>`
      : null}
    ${showWaiting
      ? html`<div class="dash-stat dash-stat--hot" role="listitem">
          <span class="dash-stat__k">📥 מחכים לך</span>
          <span class="dash-stat__v num">${waiting}</span>
          <span class="dash-stat__l">תשובות והזמנות</span>
        </div>`
      : null}
  </div>`;
}

// ---------------------------------------------------------------------------
// ⚡ what matters now, across trips
// ---------------------------------------------------------------------------

function Urgent({ items }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, URGENT_SHOWN);
  const more = items.length - shown.length;
  return html`<section class="dash-sec dash-urgent" aria-labelledby="dash-urgent-h">
    <h2 class="dash-sec__h" id="dash-urgent-h">⚡ עכשיו חשוב</h2>
    <ul class="dash-urgent__list">
      ${shown.map((t) => html`<li key=${t.key}>
        <a class=${cx('dash-urgent__row', `is-${t.tone}`)} href=${t.href}>
          <span class="dash-urgent__trip" aria-hidden="true">${t.tripEmoji || '📨'}</span>
          <span class="dash-urgent__text">${t.text}</span>
          <${Icon} name="chevron-left" size=${18} class="dash-urgent__chev" />
        </a>
      </li>`)}
    </ul>
    ${more > 0 ? html`<button type="button" class="link small dash-urgent__more" onClick=${() => setAll(true)}>עוד ${more} ←</button>` : null}
  </section>`;
}

// ---------------------------------------------------------------------------
// a trip card
// ---------------------------------------------------------------------------

/** "🔁 לעשות את זה שוב" for the organisers of a finished trip: a new trip with its structure and lists. */
function CloneButton({ entry }) {
  const [open, setOpen] = useState(false);
  if (!isAdmin(entry.member)) return null;
  return html`<button type="button" class="dash-trip__del dash-trip__clone" data-testid="dash-trip-clone" aria-label=${`לעשות שוב את ${entry.trip.name}`}
    title="לעשות את זה שוב" onClick=${(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}>🔁</button>
    <${CloneSheet} open=${open} tripId=${entry.trip.id} name=${entry.trip.name} onClose=${() => setOpen(false)} />`;
}

/** A quick 🗑️ for the organisers (only for a trip I'm an admin of): a plain question, then it's gone for everyone. */
function DeleteTripButton({ entry }) {
  const [busy, setBusy] = useState(false);
  if (!isAdmin(entry.member)) return null;
  const { trip } = entry;
  const remove = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    const yes = await confirmDialog({
      title: `למחוק את "${trip.name}"?`,
      text: 'הטיול יימחק לכולם: החברים, הרשימות, ההוצאות וההודעות. אי אפשר לשחזר.',
      confirmText: 'מחיקה לצמיתות', cancelText: 'ביטול', danger: true,
    });
    if (!yes) return;
    setBusy(true);
    const done = await actions.run(async (api) => { await api.deleteTrip(trip.id); return true; }, { success: 'הטיול נמחק 🗑️', refresh: false });
    setBusy(false);
    if (done) actions.loadTrips();
  };
  return html`<button type="button" class="dash-trip__del" data-testid="dash-trip-delete" aria-label=${`מחיקת הטיול ${trip.name}`}
    title="מחיקת הטיול" disabled=${busy} onClick=${remove}><${Icon} name="trash" size=${18} /></button>`;
}

function TripBox({ entry, ov, loading, now }) {
  const { trip } = entry;
  const t = ov?.trip ? { ...trip, ...ov.trip } : trip;
  const phase = tripPhase(t, now);
  const cd = t.starts_at ? countdown(t.starts_at, now, t.ends_at) : null;
  const meta = [dateRange(t), t.location].filter(Boolean).join(' · ');
  const base = `#/t/${t.id}`;
  const debt = ov ? tripDebt(ov) : 0;
  // cardThings is silent once a trip is 'past' — a debt still shows ("עוד פתוח"), one net number (ux A5)
  const things = ov ? (phase === 'past' && debt > 1
    ? [{ key: 'balance', text: `💸 עוד פתוח: עליך להעביר ${formatMoney(debt)}`, href: `${base}/money`, tone: 'warning' }]
    : cardThings(ov, now)) : [];
  const admin = ov ? adminParts(ov, now) : [];
  const adminCount = admin.reduce((n, p) => n + (parseInt(p.text, 10) || 1), 0);
  const onCard = (e) => {
    if (e.target.closest('a, button')) return;
    navigate(`/t/${t.id}`);
  };
  const during = phase === 'during';
  const unread = Number(ov?.unread) || 0;
  const urgentUnread = Number(ov?.urgent_unread) || 0;
  return html`<div class=${cx('card dash-trip', during && 'is-live')} data-trip-id=${t.id} onClick=${onCard}>
    <div class="dash-trip__head">
      <span class="dash-trip__emoji" aria-hidden="true">${t.emoji || '⛺'}</span>
      <div class="dash-trip__title">
        <a class="dash-trip__name" href=${base}>${t.name}</a>
        ${meta ? html`<span class="dash-trip__meta small muted">${meta}</span>` : null}
      </div>
      ${cd?.label ? html`<${Pill} tone=${during ? 'success' : cd.past ? 'default' : 'accent'} class="dash-trip__cd">${cd.label}</${Pill}>` : null}
      <${DeleteTripButton} entry=${entry} />
    </div>
    ${during
      ? html`<p class="dash-trip__live">עכשיו בטיול 🔥 · תהנו${urgentUnread ? html` · <a href=${`${base}/messages`}>🔴 ${hebrewCount(urgentUnread, 'הודעה דחופה', 'הודעות דחופות')}</a>` : ''}</p>`
      : null}
    ${!ov && loading
      ? html`<div class="dash-trip__loading"><${Skeleton} lines=${2} /></div>`
      : things.length
        ? html`<ul class="dash-trip__things">
            ${things.map((x) => html`<li key=${x.key}>
              <a class=${cx('dash-thing', `is-${x.tone}`)} href=${x.href} data-key=${x.key}>
                <span class="dash-thing__text">${x.text}</span>
                <${Icon} name="chevron-left" size=${16} class="dash-thing__chev" />
              </a>
            </li>`)}
          </ul>`
        : ov && !during && phase !== 'after'
          ? html`<p class="dash-trip__ok small">✨ הכל מסודר אצלך</p>`
          : null}
    ${unread > 0 && !during
      ? html`<a class="dash-trip__unread small" href=${`${base}/messages`}>🔔 ${hebrewCount(unread, 'הודעה חדשה', 'הודעות חדשות')}</a>`
      : null}
    ${admin.length
      // the admin's to-dos as one link (ux H5): "👑 12 דברים לטפל ‹"
      ? html`<a class="dash-trip__admin small" href=${admin[0].href} data-testid="dash-admin" title=${admin.map((p) => p.text).join(' · ')}>
          👑 ${admin.length === 1 ? admin[0].text : `${adminCount} דברים לטפל`} ‹
        </a>`
      : null}
    <${Button} variant="primary" block href=${base} class="dash-trip__enter">כניסה לטיול ←</${Button}>
  </div>`;
}

// ---------------------------------------------------------------------------
// invitations (invitee)
// ---------------------------------------------------------------------------

function InviteCard({ invite, highlight, online }) {
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [choosing, setChoosing] = useState(false); // which person of the placeholder am I
  const ref = useRef(null);
  const trip = invite.trip || {};
  const partners = (invite.partners || []).filter(Boolean);
  const meta = [dateRange(trip), trip.location, invite.member_count ? hebrewCount(invite.member_count, 'משתתף/ת', 'משתתפים') : null]
    .filter(Boolean).join(' · ');

  const choose = (invite.joinable?.choose || []).filter(Boolean);
  const accept = async (withNames = [], person = null) => {
    setBusy(true);
    const res = await actions.respondInvite(invite.id, true, withNames, person);
    setBusy(false);
    if (!res?.trip_id) return;
    setPicking(false);
    setChoosing(false);
    fireConfetti();
    actions.toast('איזה כיף, את/ה בפנים! 🔥', 'success', 3200);
    navigate(`/t/${res.trip_id}`);
  };
  const onAccept = () => {
    if (choose.length) setChoosing(true);
    else if (invite.joinable || !partners.length) accept();
    else setPicking(true);
  };
  const decline = async () => {
    const yes = await confirmDialog({
      title: 'לא הפעם?',
      text: `נעדכן את ${invite.invited_by_name || 'המזמין/ה'} בעדינות.`,
      confirmText: 'לא הפעם',
      cancelText: 'רגע, חזרה',
    });
    if (!yes) return;
    setBusy(true);
    const done = await actions.respondInvite(invite.id, false);
    setBusy(false);
    if (!done) return;
    actions.toast('עדכנו 🙏', 'success');
    if (/^#\/invite\//.test(location.hash)) navigate('/', { replace: true });
  };

  return html`<div class=${cx('card dash-invite', highlight && 'is-highlight')} id=${`invite-${invite.id}`} ref=${ref} data-invite-id=${invite.id}>
    <p class="dash-invite__title">
      <strong>${invite.invited_by_name || 'מישהו'}</strong> הזמין/ה אותך ל${trip.emoji ? `${trip.emoji} ` : ''}<strong>${trip.name || 'טיול'}</strong>
    </p>
    ${meta ? html`<p class="dash-invite__meta small muted">${meta}</p>` : null}
    <div class="dash-invite__actions">
      <${Button} variant="accent" loading=${busy} disabled=${!online} onClick=${onAccept}>
        ${invite.joinable ? `✅ מצטרף/ת ל${invite.joinable.display_name}` : '✅ מצטרף/ת'}
      </${Button}>
      <${Button} variant="ghost" disabled=${busy || !online} onClick=${decline}>לא הפעם</${Button}>
    </div>
    ${!online ? html`<p class="tiny muted">צריך חיבור כדי לענות</p>` : null}
    <${PartnersSheet} open=${picking} invite=${invite} partners=${partners} busy=${busy} onClose=${() => setPicking(false)} onSubmit=${accept} />
    <${PersonSheet} open=${choosing} invite=${invite} people=${choose} busy=${busy} onClose=${() => setChoosing(false)}
      onSubmit=${(person) => accept([], person)} />
  </div>`;
}

/** "מי מהם את/ה?" — the placeholder I was invited onto has several people and my name isn't one of them. */
function PersonSheet({ open, invite, people, busy, onClose, onSubmit }) {
  const [person, setPerson] = useState(null);
  useLayoutEffect(() => {
    if (open) setPerson(null);
  }, [open]);
  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title="מי מהם את/ה?"
    footer=${html`<${Button} variant="accent" size="lg" block loading=${busy} disabled=${!person} onClick=${() => onSubmit(person)}>
      ${person ? `אני ${person} 🔥` : 'בוחרים שם'}
    </${Button}>`}
  >
    <p class="muted small">${invite.invited_by_name || 'המזמין/ה'} הזמין/ה אותך לפרופיל ״${invite.joinable?.display_name || ''}״.</p>
    <div class="dash-pick" role="radiogroup" aria-label="מי את/ה">
      ${people.map((p) => html`<label key=${p} class=${cx('dash-pick__row', person === p && 'is-on')}>
        <input type="radio" name=${`person-${invite.id}`} checked=${person === p} onChange=${() => setPerson(p)} />
        <span>🙋 ${p}</span>
      </label>`)}
    </div>
  </${Sheet}>`;
}

/** "מגיע/ה לבד או עם…?" — only me, or me and people I've been in a profile with. */
function PartnersSheet({ open, invite, partners, busy, onClose, onSubmit }) {
  const [chosen, setChosen] = useState([]);
  useEffect(() => {
    if (open) setChosen([]);
  }, [open]);
  const toggle = (name) => setChosen((c) => (c.includes(name) ? c.filter((x) => x !== name) : [...c, name]));
  const alone = chosen.length === 0;
  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title="מגיע/ה לבד או עם…?"
    footer=${html`<${Button} variant="accent" size="lg" block loading=${busy} onClick=${() => onSubmit(chosen)}>
      ${alone ? 'מצטרף/ת 🔥' : `מצטרפים ${1 + chosen.length} 🔥`}
    </${Button}>`}
  >
    <p class="muted small">ל${invite.trip?.name || 'טיול'} — אפשר לשנות אחר כך במסך ״אני״.</p>
    <div class="dash-pick" role="group" aria-label="מי מגיע">
      <label class=${cx('dash-pick__row', alone && 'is-on')}>
        <input type="radio" name=${`with-${invite.id}`} checked=${alone} onChange=${() => setChosen([])} />
        <span>🙋 רק אני</span>
      </label>
      ${partners.map((p) => html`<label key=${p} class=${cx('dash-pick__row', chosen.includes(p) && 'is-on')}>
        <input type="checkbox" checked=${chosen.includes(p)} onChange=${() => toggle(p)} />
        <span>👫 אני ו${p}</span>
      </label>`)}
    </div>
  </${Sheet}>`;
}

