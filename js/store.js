// App store (SPEC §7.3): one tiny observable object + hooks + actions.
import { useEffect, useReducer, useRef } from 'preact/hooks';
import { createApi } from './api/index.js?v=8a35ae3';
import { hebrewError, toApiError } from './api/errors.js?v=8a35ae3';
import { isAdmin as memberIsAdmin, tripPhase, visibleNotifications } from './lib/logic.js?v=8a35ae3';
import { parseHash, navigate } from './router.js?v=8a35ae3';
import { withModules } from './lib/templates.js?v=8a35ae3';
import { landingTrip } from './lib/overview.js?v=8a35ae3';

const THEME_KEY = 'medura:theme';
const THEMES = ['auto', 'light', 'dark'];
const THEME_COLORS = { light: '#FBF6EE', dark: '#0E1512' };
const REFRESH_DEBOUNCE_MS = 250;
const MAX_TOASTS = 3;
// "Seen lately": the regular refresh (the 45 s poll) touches presence at most this often — every second
// poll, so a touch lands within ~100 s of the last one and, kept to the minute, stays inside the 3-minute
// "🟢 מחובר/ת עכשיו" window (the server writes at most every 30 s).
const PRESENCE_EVERY_MS = 55000;

function readTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return THEMES.includes(t) ? t : 'auto';
  } catch {
    return 'auto';
  }
}

let state = {
  api: null,
  mode: null,
  userId: null,
  ready: false,
  trips: [],
  tripId: null,
  snap: null,
  loading: false,
  error: null, // {code, scope:'boot'|'trip', tripId?}
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  toasts: [],
  theme: readTheme(),
  contact: null, // {email, verified} of this user (device), or null until loaded / on error
  account: undefined, // my account {email, verified, name, phone, prefs} (my_account); undefined = not loaded
  overview: undefined, // my_overview() rows (SPEC §16.1); undefined = not loaded, null = unavailable (error / older server)
  overviewAt: null, // ms of the last good overview (a cached one after a reload / offline)
  invites: [], // my_invites(): pending invitations to my verified e-mail
};

const OVERVIEW_KEY = (userId) => `medura:overview:${userId}`;
const LAST_TRIP_KEY = 'medura:lastTrip';
let landingDone = false; // the cold-start "open the live trip" rule runs once per page load

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/** Must this user verify an e-mail before using a trip? Always on the real server; in demo only
 *  when forced with ?emailgate=1 (tests / trying it out). */
export function emailRequired(s = state) {
  // Real server: only once e-mail delivery is live (config.requireEmailVerification).
  if (s.mode === 'supabase') return globalThis.MEDURA_CONFIG?.requireEmailVerification === true;
  try {
    return new URLSearchParams(location.search).get('emailgate') === '1';
  } catch {
    return false;
  }
}

const listeners = new Set();

export const store = {
  get: () => state,
  /** Shallow-merge a patch (object, or fn(state) → object) and notify subscribers. */
  set(patch) {
    const next = typeof patch === 'function' ? patch(state) : patch;
    if (!next) return;
    state = { ...state, ...next };
    listeners.forEach((fn) => fn(state));
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is(a[k], b[k]));
}

const identity = (s) => s;

/** Subscribe to (a slice of) the store; re-renders only when the selection changes (shallow). */
export function useStore(selector = identity) {
  const [, force] = useReducer((n) => n + 1, 0);
  const selRef = useRef(selector);
  selRef.current = selector;
  const value = selector(state);
  const valRef = useRef(value);
  valRef.current = value;
  useEffect(() => {
    const check = () => {
      const next = selRef.current(state);
      if (!shallowEqual(next, valRef.current)) force();
    };
    const off = store.subscribe(check);
    check(); // catch changes between render and subscribe
    return off;
  }, []);
  return value;
}

/** Current trip context for screens. */
export function useTrip() {
  const { snap, tripId } = useStore((s) => ({ snap: s.snap, tripId: s.tripId }));
  const myId = snap?.me?.member_id;
  const me = (myId && snap?.members?.find((m) => m.id === myId)) || null;
  // this device's own rights (per person); an older server without me.admin: my profile's role
  const admin = typeof snap?.me?.admin === 'boolean' ? snap.me.admin : me ? memberIsAdmin(me) : false;
  return { snap, me, isAdmin: admin, tripId };
}

// ---------------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------------

let toastSeq = 0;

/** New screens met old modules (a deploy mid-load): tell the person and reload once per session. */
function reloadForUpdate() {
  try {
    if (sessionStorage.getItem('medura:reloaded')) return false;
    sessionStorage.setItem('medura:reloaded', '1');
  } catch {
    return false;
  }
  toast('יש גרסה חדשה — מרעננים רגע… 🔄', 'info', 2500);
  setTimeout(() => location.reload(), 1200);
  return true;
}

function dismissToast(id) {
  store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

function toast(text, kind = 'info', ms = 2600, opts = {}) {
  if (!text) return 0;
  const id = ++toastSeq;
  const item = { id, text: String(text), kind, href: opts.href || null, icon: opts.icon || null, leaving: false };
  store.set((s) => ({ toasts: [...s.toasts.filter((t) => !t.leaving).slice(-(MAX_TOASTS - 1)), item] }));
  setTimeout(() => {
    store.set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
    setTimeout(() => dismissToast(id), 220);
  }, ms);
  return id;
}

// ---------------------------------------------------------------------------
// trip loading, realtime, notifications
// ---------------------------------------------------------------------------

const bootAt = Date.now();
let unsubscribeTrip = null;
let refreshTimer = 0;
let inflight = null;
let again = false;
let seenNotifications = new Set();
let notificationsPrimed = false;
let touchedAt = 0; // last touch_presence for the open trip (0 = not yet)
let overviewInflight = null;

/** Tell the trip "I'm here" (fire and forget) — only while the page is visible, at most every PRESENCE_EVERY_MS. */
function maybeTouch(tripId) {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const now = Date.now();
  if (touchedAt && now - touchedAt < PRESENCE_EVERY_MS) return;
  touchedAt = now;
  try {
    Promise.resolve(state.api?.touchPresence?.(tripId)).catch(() => {});
  } catch {
    /* presence is best-effort */
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    actions.refresh();
  }, REFRESH_DEBOUNCE_MS);
}

/** Toast notifications that appeared since the last snapshot (not on first load). */
function announceNew(snap) {
  let list = [];
  try {
    list = visibleNotifications(snap) || [];
  } catch {
    list = snap.notifications || [];
  }
  if (!notificationsPrimed) {
    list.forEach((n) => seenNotifications.add(n.id));
    notificationsPrimed = true;
    return;
  }
  const myId = snap.me?.member_id;
  const quiet = tripPhase(snap.trip) === 'during'; // at the campsite: only urgent messages pop up
  let shown = 0;
  for (const n of list) {
    if (seenNotifications.has(n.id)) continue;
    seenNotifications.add(n.id);
    if (n.author_member && n.author_member === myId) continue;
    const created = Date.parse(n.created_at);
    if (Number.isFinite(created) && created < bootAt - 120000) continue;
    if (quiet && !n.urgent) continue;
    if (shown++ >= 2) continue;
    toast(n.title, 'info', n.urgent ? 6000 : 4200, { href: `#/t/${snap.trip.id}/messages`, icon: n.urgent ? '🔴' : '🔔' });
    if (n.urgent) navigator.vibrate?.(30);
  }
}

const TRIP_GONE = new Set(['forbidden', 'not_found', 'invalid_input']);

async function refreshLoop() {
  do {
    again = false;
    const { api, tripId } = state;
    if (!api || !tripId) return null;
    try {
      const snap = await api.getSnapshot(tripId);
      if (state.tripId !== tripId) continue; // switched trips meanwhile
      store.set({ snap: withModules(snap), loading: false, error: null, online: true });
      announceNew(snap);
      maybeTouch(tripId);
    } catch (e) {
      const err = toApiError(e);
      if (state.tripId !== tripId) continue;
      if (TRIP_GONE.has(err.code)) {
        store.set({ snap: null, loading: false, error: { code: err.code, scope: 'trip', tripId } });
        actions.loadTrips(); // e.g. deleted by an admin → drop it from "my trips" too
      } else if (err.code === 'network') {
        store.set({ loading: false, online: false, error: state.snap ? null : { code: 'network', scope: 'trip', tripId } });
      } else {
        store.set({ loading: false, error: state.snap ? null : { code: err.code, scope: 'trip', tripId } });
      }
    }
  } while (again);
  return state.snap;
}

// ---------------------------------------------------------------------------
// theme
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    if (!m.dataset.initial) m.dataset.initial = m.content;
    m.content = THEME_COLORS[theme] || m.dataset.initial;
  });
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

export const actions = {
  /** createApi → init → ensureSession → myTrips (+ invites, overview in the background); route-aware: on a cold
   *  start at "/" a trip in phase departure/during opens directly (SPEC §16.2), otherwise "/" is the dashboard. */
  async boot() {
    applyTheme(state.theme);
    store.set({ ready: false, error: null });
    try {
      const api = await createApi();
      await api.init();
      const { userId } = await api.ensureSession();
      store.set({ api, mode: api.mode, userId });
      const cached = readJson(OVERVIEW_KEY(userId));
      if (cached && Array.isArray(cached.rows)) store.set({ overview: cached.rows, overviewAt: cached.at || null });
      await actions.loadContact();
      const trips = await actions.loadTrips({ quiet: false });
      actions.loadInvites();
      actions.loadOverview();
      const route = parseHash(location.hash);
      if (route.name === 'landing' && !landingDone && !route.query.link) {
        landingDone = true;
        let last = null;
        try {
          last = localStorage.getItem(LAST_TRIP_KEY);
        } catch {
          /* storage unavailable */
        }
        const live = landingTrip(trips, last, new Date());
        if (live) navigate(`/t/${live}`, { replace: true });
      } else if (route.params.tripId) {
        actions.openTrip(route.params.tripId);
      }
      landingDone = true;
      store.set({ ready: true });
    } catch (e) {
      const err = toApiError(e);
      console.error('[medura] boot failed', e);
      store.set({ ready: true, error: { code: err.code, scope: 'boot' } });
    }
  },

  /** This user's verified e-mail (null on failure — the gate then offers to retry). */
  async loadContact() {
    const { api } = state;
    if (!api) return null;
    try {
      const contact = await api.myEmail();
      store.set({ contact });
      return contact;
    } catch (e) {
      if (toApiError(e).code === 'network') store.set({ online: false });
      store.set({ contact: null });
      return null;
    }
  },

  setContact(contact) {
    store.set({ contact, account: undefined });
    if (contact?.verified) actions.loadInvites();
  },

  /** My account (name, phone, prefs incl. presence / share_phone) — loaded once; `force` reloads. */
  async loadAccount({ force = false } = {}) {
    const { api } = state;
    if (!api?.myAccount) return null;
    if (!force && state.account !== undefined) return state.account;
    try {
      const account = (await api.myAccount()) || null;
      store.set({ account });
      return account;
    } catch {
      store.set({ account: null });
      return null;
    }
  },

  setAccount(account) {
    store.set({ account: account || null });
  },

  /** Touch presence on the next refresh even if it was touched lately (e.g. after turning it back on). */
  resetPresence() {
    touchedAt = 0;
  },

  async loadTrips({ quiet = true } = {}) {
    const { api } = state;
    if (!api) return [];
    try {
      const trips = (await api.myTrips()) || [];
      store.set({ trips });
      return trips;
    } catch (e) {
      if (!quiet) throw e;
      const err = toApiError(e);
      if (err.code === 'network') store.set({ online: false });
      return state.trips;
    }
  },

  /**
   * "הבית שלי": my_overview() across all my trips. A network error keeps the cached rows (offline);
   * any other error (e.g. an older server without the RPC) → overview null (plain cards from state.trips).
   */
  async loadOverview({ force = false } = {}) {
    const { api, userId } = state;
    if (!api) return state.overview;
    if (!api.myOverview) {
      store.set({ overview: null });
      return null;
    }
    if (!force && overviewInflight) return overviewInflight;
    overviewInflight = (async () => {
      try {
        const rows = (await api.myOverview()) || [];
        const at = Date.now();
        store.set({ overview: rows, overviewAt: at, online: true });
        if (userId) writeJson(OVERVIEW_KEY(userId), { at, rows });
        return rows;
      } catch (e) {
        const err = toApiError(e);
        if (err.code === 'network') {
          store.set({ online: false, overview: state.overview === undefined ? null : state.overview });
        } else {
          console.warn('[medura] overview unavailable', err.code);
          store.set({ overview: null });
        }
        return state.overview;
      } finally {
        overviewInflight = null;
      }
    })();
    return overviewInflight;
  },

  /** Pending invitations to my verified e-mail (none without one). Errors keep the previous list and return null
   *  (so a caller never mistakes "couldn't load" for "no such invitation"). */
  async loadInvites() {
    const { api } = state;
    if (!api?.myInvites || !state.contact?.verified) {
      if (state.invites.length) store.set({ invites: [] });
      return state.invites;
    }
    try {
      const invites = (await api.myInvites()) || [];
      store.set({ invites, online: true });
      return invites;
    } catch (e) {
      if (toApiError(e).code === 'network') store.set({ online: false });
      return null;
    }
  },

  /**
   * Accept (optionally with partners, or as `person` of the placeholder I was invited onto) or decline an
   * invitation. Accept → {trip_id, member_id}; decline → true.
   */
  async respondInvite(inviteId, accept, withNames = [], person = null) {
    const res = await actions.run((api) => api.respondInvite(inviteId, accept, { with: withNames, person }), {
      refresh: false,
      error: (code) => (code === 'not_allowed_state' ? 'ההזמנה הזאת כבר לא פתוחה' : code === 'limit_reached' ? 'הטיול מלא — עד 60 פרופילים' : hebrewError(code)),
    });
    const ok = accept ? Boolean(res?.trip_id) : res !== undefined;
    await Promise.all([actions.loadTrips(), actions.loadInvites(), actions.loadOverview({ force: true })]);
    if (!ok) return undefined;
    return accept ? res : true;
  },

  /**
   * Switch to a trip: load its snapshot and subscribe to realtime changes.
   * `force` reloads even when that trip is already the open one (e.g. right after joining it).
   */
  async openTrip(tripId, { force = false } = {}) {
    if (!tripId || !state.api) return null;
    const same = state.tripId === tripId;
    if (same && !force && (state.snap || state.loading)) return state.snap;
    if (unsubscribeTrip) {
      unsubscribeTrip();
      unsubscribeTrip = null;
    }
    clearTimeout(refreshTimer);
    seenNotifications = new Set();
    notificationsPrimed = false;
    touchedAt = 0;
    store.set({ tripId, snap: null, loading: true, error: null });
    const snap = await actions.refresh();
    if (state.tripId === tripId && snap && !unsubscribeTrip) {
      try {
        unsubscribeTrip = state.api.subscribe(tripId, scheduleRefresh);
      } catch (e) {
        console.warn('[medura] realtime subscribe failed', e);
      }
      try {
        localStorage.setItem(LAST_TRIP_KEY, tripId);
      } catch {
        /* storage unavailable */
      }
    }
    return snap;
  },

  /**
   * Close the open trip (after deleting it): stop listening and forget its snapshot.
   * tripId stays set (marked gone) so the route→openTrip effect doesn't reopen it, and "back"
   * lands on the "this trip was deleted" gate.
   */
  closeTrip() {
    const { tripId } = state;
    if (unsubscribeTrip) {
      unsubscribeTrip();
      unsubscribeTrip = null;
    }
    clearTimeout(refreshTimer);
    store.set({ snap: null, loading: false, error: tripId ? { code: 'not_found', scope: 'trip', tripId } : null });
  },

  /** Re-fetch the current trip snapshot. Concurrent calls share one request (+1 follow-up). */
  refresh() {
    if (!state.api || !state.tripId) return Promise.resolve(null);
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = refreshLoop().finally(() => {
      inflight = null;
    });
    return inflight;
  },

  /** Run an API mutation with feedback. Returns the result, or undefined on error. */
  async run(fn, { success, error, refresh = true } = {}) {
    const { api } = state;
    if (!api) return undefined;
    try {
      const result = await fn(api);
      // Refresh before the success toast so the UI already shows the new state when it appears.
      if (refresh) {
        try {
          await actions.refresh();
        } catch {
          /* the mutation succeeded; refresh problems surface through store.error */
        }
      }
      if (success) toast(success, 'success');
      return result;
    } catch (e) {
      const err = toApiError(e);
      console.warn('[medura] action failed', err.code, err.detail || '', e);
      if (e instanceof TypeError && /is not a function/.test(String(e.message)) && reloadForUpdate()) return undefined;
      const text = typeof error === 'function' ? error(err.code, err) : error || hebrewError(err.code);
      toast(text, 'error', 3800);
      if (err.code === 'network') store.set({ online: false });
      else if (refresh) actions.refresh();
      return undefined;
    }
  },

  toast,
  dismissToast,

  setTheme(theme) {
    const t = THEMES.includes(theme) ? theme : 'auto';
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* storage unavailable */
    }
    applyTheme(t);
    store.set({ theme: t });
  },
};

// Connectivity → banner + catch-up refresh.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    store.set({ online: true });
    actions.refresh();
  });
  window.addEventListener('offline', () => store.set({ online: false }));
}
