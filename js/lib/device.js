// This device: install as an app (Android prompt / iPhone steps) and push notifications.
// Shared by the first-run guide and the Me screen.

let deferredInstall = null;
const installListeners = new Set();

/** Call once at startup: Android/Chrome offers "install" only through this event. */
export function captureInstallPrompt() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    installListeners.forEach((fn) => fn());
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    installListeners.forEach((fn) => fn());
  });
}

export function onInstallChange(fn) {
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}

const ua = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent || '');
export const isIos = () => /iphone|ipad|ipod/i.test(ua()) || (/macintosh/i.test(ua()) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
export const isAndroid = () => /android/i.test(ua());
export const isStandalone = () => typeof window !== 'undefined'
  && ((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true);

/** 'installed' | 'prompt' (Android can install now) | 'ios' (show the steps) | 'android' | 'desktop' */
export function installState() {
  if (isStandalone()) return 'installed';
  if (deferredInstall) return 'prompt';
  if (isIos()) return 'ios';
  if (isAndroid()) return 'android';
  return 'desktop';
}

/** Shows the Android install dialog. Resolves true when the user accepted. */
export async function promptInstall() {
  if (!deferredInstall) return false;
  const e = deferredInstall;
  deferredInstall = null;
  e.prompt();
  const choice = await e.userChoice.catch(() => null);
  installListeners.forEach((fn) => fn());
  return choice?.outcome === 'accepted';
}

// ---- push ----

const vapidKey = () => String((globalThis.MEDURA_CONFIG && globalThis.MEDURA_CONFIG.vapidPublicKey) || '').trim();
export const pushCapable = () => Boolean(vapidKey()) && typeof navigator !== 'undefined'
  && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window;

function swReady(ms) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve(null);
  return Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), ms))]).catch(() => null);
}

function urlBase64ToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * 'on' (subscribed) | 'ready' (can ask) | 'denied' | 'ios-install' (iPhone: only from the home-screen
 * app) | 'unsupported'
 */
export async function pushState() {
  if (isIos() && !isStandalone()) return 'ios-install';
  if (typeof window === 'undefined' || !('Notification' in window) || !pushCapable()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'granted') {
    const reg = await swReady(2500);
    const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription().catch(() => null) : null;
    if (sub) return 'on';
  }
  return 'ready';
}

/** Ask permission → subscribe → hand the subscription to `save(json)`. Returns the new pushState. */
export async function enablePush(save) {
  if (isIos() && !isStandalone()) return 'ios-install';
  if (!('Notification' in window) || !pushCapable()) return 'unsupported';
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'ready';
  const reg = await swReady(6000);
  if (!reg || !reg.pushManager) throw new Error('no service worker');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(vapidKey()) });
  const ok = await save(sub.toJSON());
  return ok ? 'on' : 'ready';
}

/** Unsubscribe this device; `forget(endpoint)` removes it on the server. */
export async function disablePush(forget) {
  const reg = await swReady(3000);
  const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
  if (!sub) return 'ready';
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await forget(endpoint);
  return 'ready';
}
