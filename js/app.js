// App shell: routes → screens, top bar, bottom nav, banners, toasts, access gate, error boundary.
import { html } from 'htm/preact';
import { Component } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useRoute, href, navigate } from './router.js?v=6582265';
import { useStore, useTrip, actions, emailRequired } from './store.js?v=6582265';
import { unreadCount } from './lib/logic.js?v=6582265';
import { hebrewError } from './api/errors.js?v=6582265';
import { Avatar, Button, Card, EmptyState, IconButton, Skeleton } from './ui/components.js?v=6582265';
import { Icon } from './ui/icons.js?v=6582265';
import { EmailGate } from './ui/email-gate.js?v=6582265';
import { Tour, tourDue } from './ui/tour.js?v=6582265';
import { PendingGate } from './ui/pending.js?v=6582265';
import { arrivalOf, hasModule } from './lib/templates.js?v=6582265';
import { TabGuide, hasGuide, openGuide } from './ui/tab-guide.js?v=6582265';

const cx = (...a) => a.filter(Boolean).join(' ');

// ---------------------------------------------------------------------------
// Lazy screens (one broken screen module can't take the whole app down)
// ---------------------------------------------------------------------------

const SCREENS = {
  landing: './screens/onboarding.js?v=6582265',
  new: './screens/onboarding.js?v=6582265',
  join: './screens/onboarding.js?v=6582265',
  link: './screens/onboarding.js?v=6582265',
  home: './screens/home.js?v=6582265',
  trip: './screens/trip.js?v=6582265',
  rides: './screens/rides.js?v=6582265',
  lists: './screens/lists.js?v=6582265',
  shop: './screens/shopping.js?v=6582265',
  import: './screens/import.js?v=6582265',
  money: './screens/money.js?v=6582265',
  messages: './screens/messages.js?v=6582265',
  people: './screens/people.js?v=6582265',
  me: './screens/me.js?v=6582265',
  welcome: './screens/welcome.js?v=6582265',
  signin: './screens/signin.js?v=6582265',
};
const pending = new Map(); // module path → Promise<Component>
const resolved = new Map(); // module path → Component
const failed = new Set(); // module paths whose last fetch failed
let retrySeq = 0;

/**
 * Load a screen module once. After a failure the next attempt uses a fresh URL,
 * because browsers remember failed module fetches for the page's lifetime.
 */
function loadScreen(name, { retry = false } = {}) {
  const path = SCREENS[name];
  if (!path) return Promise.reject(new Error(`no screen for ${name}`));
  if (resolved.has(path)) return Promise.resolve(resolved.get(path));
  if (!pending.has(path)) {
    const url = retry || failed.has(path) ? `${path}?retry=${++retrySeq}` : path;
    const p = import(url).then(
      (mod) => {
        failed.delete(path);
        resolved.set(path, mod.default);
        return mod.default;
      },
      (err) => {
        failed.add(path);
        pending.delete(path);
        throw err;
      },
    );
    pending.set(path, p);
  }
  return pending.get(path);
}

/** Warm the module cache so tab switches are instant. */
export function preloadScreens() {
  Object.keys(SCREENS).forEach((name) => loadScreen(name).catch(() => {}));
}

function useScreen(name) {
  const path = SCREENS[name];
  const [state, setState] = useState({ path, Comp: resolved.get(path) || null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) return undefined;
    if (resolved.has(path)) {
      setState({ path, Comp: resolved.get(path), error: null });
      return undefined;
    }
    let alive = true;
    setState({ path, Comp: null, error: null });
    loadScreen(name, { retry: attempt > 0 }).then(
      (Comp) => alive && setState({ path, Comp, error: null }),
      (error) => {
        console.error(`[medura] failed to load screen "${name}"`, error);
        if (alive) setState({ path, Comp: null, error });
      },
    );
    return () => {
      alive = false;
    };
  }, [name, attempt]);
  const current = state.path === path ? state : { Comp: resolved.get(path) || null, error: null };
  return { ...current, retry: () => setAttempt((n) => n + 1) };
}

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error('[medura] screen crashed', error);
  }

  render() {
    if (this.state.error) {
      return html`<${OopsCard}
        onRetry=${() => {
          this.setState({ error: null });
          actions.refresh();
        }}
      />`;
    }
    return this.props.children;
  }
}

function OopsCard({ onRetry, title = 'אופס, משהו השתבש 🙈', text = 'זה לא אתם, זה אנחנו. נסו שוב — ואם זה חוזר, רעננו את הדף.' }) {
  return html`<div class="screen">
    <${Card}>
      <${EmptyState}
        emoji="🪵"
        title=${title}
        text=${text}
        action=${html`<div class="row row--center wrap">
          <${Button} icon="refresh" onClick=${onRetry}>לנסות שוב</${Button}>
          <${Button} variant="ghost" href="#/">לדף הבית</${Button}>
        </div>`}
      />
    </${Card}>
  </div>`;
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

export function Splash() {
  return html`<div class="splash" role="status" aria-label="טוען את מדורה">
    <div class="splash__fire" aria-hidden="true">🔥</div>
    <div class="splash__name">מדורה</div>
  </div>`;
}

function useScrolled(threshold = 4) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > threshold);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return scrolled;
}

function Banners() {
  const { online, mode } = useStore((s) => ({ online: s.online, mode: s.mode }));
  return html`
    ${mode === 'demo'
      ? html`<div class="banner banner--demo" role="note"><span aria-hidden="true">🎭</span> מצב הדגמה — הנתונים נשמרים רק בדפדפן הזה</div>`
      : null}
    ${!online
      ? html`<div class="banner banner--offline" role="status"><${Icon} name="wifi-off" size=${16} /> אין חיבור — מציגים את המידע האחרון שנשמר</div>`
      : null}`;
}

function TopBar({ route }) {
  const { snap: current, me: currentMe, tripId: storeTrip } = useTrip();
  const tripId = route.params.tripId || storeTrip;
  // While another trip is loading, don't show the previous trip's name/avatar.
  const snap = current && current.trip?.id === tripId ? current : null;
  const me = snap ? currentMe : null;
  const scrolled = useScrolled();
  let unread = 0;
  try {
    unread = snap ? unreadCount(snap) : 0;
  } catch {
    unread = 0;
  }
  const trip = snap?.trip;
  return html`<div class=${cx('topbar', scrolled && 'is-scrolled')}>
    <div class="topbar__inner">
      <a class="topbar__trip" href=${href(`/t/${tripId}/trip`)} aria-label=${trip ? `פרטי הטיול: ${trip.name}` : 'פרטי הטיול'}>
        <span class="topbar__emoji" aria-hidden="true">${trip?.emoji || '⛺'}</span>
        ${trip
          ? html`<span class="topbar__name">${trip.name}</span>`
          : html`<span class="topbar__name topbar__name--loading" aria-hidden="true"></span>`}
      </a>
      <div class="topbar__actions">
        ${hasGuide(route.name)
          ? html`<button type="button" class="topbar__help" aria-label="מה אפשר לעשות כאן?" onClick=${() => openGuide(route.name)}>?</button>`
          : null}
        <${IconButton} icon="bell" label="הודעות" badge=${unread} href=${href(`/t/${tripId}/messages`)} class="topbar__bell" />
        <a class="topbar__me" href=${href(`/t/${tripId}/me`)} aria-label="הפרופיל שלי">
          <${Avatar} member=${me} size=${36} />
        </a>
      </div>
    </div>
  </div>`;
}

const TABS = [
  { key: 'home', path: '', emoji: '🏕️', label: 'בית', match: ['home', 'trip'] },
  { key: 'lists', path: '/lists', emoji: '📋', label: 'רשימות', match: ['lists', 'shop', 'import'] },
  { key: 'rides', path: '/rides', emoji: '🚗', label: 'הסעות', match: ['rides'] },
  { key: 'money', path: '/money', emoji: '💸', label: 'כסף', match: ['money'] },
  { key: 'messages', path: '/messages', emoji: '🔔', label: 'הודעות', match: ['messages'] },
  { key: 'people', path: '/people', emoji: '👥', label: "חבר'ה", match: ['people'] },
];

function BottomNav({ route }) {
  const { snap, tripId } = useTrip();
  let unread = 0;
  try {
    unread = snap ? unreadCount(snap) : 0;
  } catch {
    unread = 0;
  }
  const id = route.params.tripId || tripId;
  const flying = arrivalOf(snap?.trip).flights;
  const tabs = TABS.filter((t) => !['rides', 'money'].includes(t.key) || hasModule(snap?.trip, t.key))
    .map((t) => (t.key === 'rides' && flying ? { ...t, emoji: '✈️', label: 'הגעה' } : t));
  return html`<nav class="bottom-nav" aria-label="ניווט ראשי">
    <div class="bottom-nav__inner" style=${`grid-template-columns: repeat(${tabs.length}, minmax(0, 1fr))`}>
      ${tabs.map((t) => {
        const active = t.match.includes(route.name);
        const badge = t.key === 'messages' && unread > 0 ? unread : 0;
        return html`<a
          key=${t.key}
          class=${cx('nav-tab', active && 'is-active')}
          href=${href(`/t/${id}${t.path}`)}
          aria-current=${active ? 'page' : undefined}
          data-tab=${t.key}
        >
          <span class="nav-tab__icon" aria-hidden="true">${t.emoji}</span>
          <span class="nav-tab__label">${t.label}</span>
          ${badge ? html`<span class="badge nav-tab__badge" aria-label=${`${badge} לא נקראו`}>${badge > 99 ? '99+' : badge}</span>` : null}
        </a>`;
      })}
    </div>
  </nav>`;
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const icons = { success: '✓', error: '!' };
  return html`<div class="toasts" aria-live="polite" aria-atomic="false">
    ${toasts.map((t) => html`<div
      key=${t.id}
      class=${cx('toast', `toast--${t.kind}`, t.leaving && 'is-leaving')}
      role=${t.kind === 'error' ? 'alert' : 'status'}
      onClick=${() => {
        if (t.href) navigate(t.href);
        actions.dismissToast(t.id);
      }}
    >
      ${t.icon || icons[t.kind] ? html`<span class=${cx('toast__icon', t.icon && 'toast__icon--emoji')} aria-hidden="true">${t.icon || icons[t.kind]}</span>` : null}
      <span class="toast__text">${t.text}</span>
    </div>`)}
  </div>`;
}

function AccessGate({ code }) {
  const network = code === 'network';
  const missing = code === 'not_found'; // deleted by an admin (or a link to a trip that never existed)
  return html`<div class="screen gate">
    <div class="gate__brand" aria-hidden="true">🔥 מדורה</div>
    <${Card}>
      <${EmptyState}
        emoji=${network ? '📶' : missing ? '🪵' : '🔒'}
        title=${network ? 'אין חיבור כרגע' : missing ? 'הטיול הזה לא קיים יותר' : 'הטיול הזה עוד לא אצלך'}
        text=${network
          ? 'לא הצלחנו לטעון את הטיול. בדקו את החיבור ונסו שוב.'
          : missing
            ? 'כנראה שאחד המנהלים מחק אותו — או שהקישור לא מדויק.'
            : 'כדי להיכנס צריך קישור הזמנה מאחד החברים. קיבלתם קישור? הדביקו אותו במסך הראשי.'}
        action=${html`<div class="row row--center wrap">
          ${network
            ? html`<${Button} icon="refresh" onClick=${() => actions.refresh()}>לנסות שוב</${Button}>`
            : html`<${Button} icon="link" href="#/?link=1">יש לי קישור</${Button}>`}
          <${Button} variant="ghost" href="#/">לטיולים שלי</${Button}>
        </div>`}
      />
    </${Card}>
  </div>`;
}

function BootError({ code }) {
  return html`<main class="main main--bare">
    <${Card}>
      <${EmptyState}
        emoji=${code === 'network' ? '📶' : '🪵'}
        title=${code === 'network' ? 'אין חיבור לאינטרנט' : 'המדורה לא נדלקה 😅'}
        text=${hebrewError(code)}
        action=${html`<${Button} icon="refresh" onClick=${() => actions.boot()}>לנסות שוב</${Button}>`}
      />
    </${Card}>
  </main>`;
}

function ScreenHost({ route }) {
  const { Comp, error, retry } = useScreen(route.name);
  if (error) {
    return html`<${OopsCard} title="המסך לא נטען 😕" text="בדקו את החיבור ונסו שוב." onRetry=${retry} />`;
  }
  if (!Comp) {
    return html`<div class="screen"><${Skeleton} lines=${3} /><div class="gap-12"></div><${Skeleton} lines=${4} /></div>`;
  }
  return html`<${ErrorBoundary} key=${route.path}><${Comp} route=${route} /></${ErrorBoundary}>`;
}

function NotFound() {
  return html`<div class="screen">
    <${Card}>
      <${EmptyState}
        emoji="🧭"
        title="הלכנו לאיבוד ביער"
        text="הדף הזה לא קיים. בואו נחזור למדורה."
        action=${html`<${Button} href="#/" icon="home">למסך הראשי</${Button}>`}
      />
    </${Card}>
  </div>`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const BARE_ROUTES = new Set(['landing', 'new', 'join', 'link', 'signin', 'notfound']);
const FOCUS_ROUTES = new Set(['shop', 'welcome']); // full-screen, no chrome

/** First visit to a trip: the welcome wizard (skipped by automated browsers unless ?welcome=1). */
function welcomeDue() {
  try {
    if (new URLSearchParams(location.search).get('welcome') === '1') return true;
  } catch {
    /* no location */
  }
  return !(typeof navigator !== 'undefined' && navigator.webdriver);
}

export function App() {
  const route = useRoute();
  const { ready, error, tripId, snap, needEmail } = useStore((s) => ({
    ready: s.ready, error: s.error, tripId: s.tripId, snap: s.snap,
    needEmail: s.ready && emailRequired(s) && !s.contact?.verified,
  }));
  const routeTrip = route.params.tripId || null;
  const inTrip = !!routeTrip;
  const gated = inTrip && error?.scope === 'trip' && error.tripId === routeTrip && !snap;
  const emailGate = inTrip && !gated && needEmail;
  const bare = BARE_ROUTES.has(route.name) || gated || emailGate;
  const focus = FOCUS_ROUTES.has(route.name);
  const showNav = inTrip && !focus && !gated && !emailGate;
  const myId = snap?.me?.member_id;
  const meRow = myId ? snap.members?.find((m) => m.id === myId) : null;
  const needsWelcome = Boolean(meRow && snap.trip?.id === routeTrip && !meRow.prefs?.onboarded);
  useEffect(() => {
    if (needsWelcome && route.name !== 'welcome' && !emailGate && welcomeDue()) {
      navigate(`/t/${routeTrip}/welcome`, { replace: true });
    }
  }, [needsWelcome, route.name, emailGate]);
  const [tourOpen, setTourOpen] = useState(false);
  const tourReady = showNav && Boolean(snap);
  useEffect(() => {
    if (tourReady && tourDue()) setTourOpen(true);
  }, [tourReady]);
  useEffect(() => {
    const open = () => setTourOpen(true);
    window.addEventListener('medura:tour', open);
    return () => window.removeEventListener('medura:tour', open);
  }, []);

  // Keep the store's open trip in sync with the URL.
  useEffect(() => {
    if (ready && routeTrip && routeTrip !== tripId) actions.openTrip(routeTrip);
  }, [ready, routeTrip, tripId]);

  // New page → start at the top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.path]);

  useEffect(() => {
    document.documentElement.classList.toggle('no-nav', !showNav);
  }, [showNav]);

  useEffect(() => {
    const t = inTrip && snap?.trip ? `${snap.trip.emoji || '⛺'} ${snap.trip.name} · מדורה` : "מדורה 🔥 כל החבר'ה סביב המדורה";
    if (document.title !== t) document.title = t;
  }, [inTrip, snap?.trip?.name, snap?.trip?.emoji]);

  if (!ready) return html`<${Splash} />`;
  if (error?.scope === 'boot') return html`<div class="app app--bare"><${Banners} /><${BootError} code=${error.code} /><${Toasts} /></div>`;

  let body;
  if (route.name === 'notfound') body = html`<${NotFound} />`;
  else if (gated && error.code === 'forbidden') {
    body = html`<${PendingGate} key=${routeTrip} tripId=${routeTrip} fallback=${html`<${AccessGate} code=${error.code} />`} />`;
  } else if (gated) body = html`<${AccessGate} code=${error.code} />`;
  else if (emailGate) body = html`<${EmailGate} />`;
  else body = html`<${ScreenHost} route=${route} />`;

  return html`<div class=${cx('app', bare && 'app--bare', focus && 'app--focus', showNav && 'app--nav')}>
    <button type="button" class="skip-link" onClick=${() => document.getElementById('main')?.focus()}>דלגו לתוכן</button>
    <header class="app-header">
      <${Banners} />
      ${showNav ? html`<${TopBar} route=${route} />` : null}
    </header>
    <main id="main" class=${cx('main', bare && 'main--bare')} tabIndex="-1">
      <div class="page" key=${route.path}>${body}</div>
    </main>
    ${showNav ? html`<${BottomNav} route=${route} />` : null}
    ${showNav ? html`<${Tour} open=${tourOpen} tripId=${routeTrip} onClose=${() => setTourOpen(false)} />` : null}
    ${showNav ? html`<${TabGuide} key=${route.name} name=${route.name} blocked=${tourOpen} />` : null}
    <${Toasts} />
  </div>`;
}
