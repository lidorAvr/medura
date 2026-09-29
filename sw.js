/* מדורה service worker — offline shell (network-first) + push notifications.
   Same-origin GETs only; Supabase and other cross-origin requests are never touched. */
const VERSION = 'medura-d288b77';
const NETWORK_TIMEOUT_MS = 4000; // weak reception at the campsite → fall back to cache quickly

const SHELL = [
  './',
  'index.html',
  'config.js?v=d288b77',
  'manifest.webmanifest',
  'favicon.svg',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/maskable-512.png',
  'assets/icons/apple-touch-icon.png',
  'assets/icons/badge-96.png',
  'css/styles.css?v=d288b77',
  'css/onboarding.css?v=d288b77',
  'css/home.css?v=d288b77',
  'css/trip.css?v=d288b77',
  'css/lists.css?v=d288b77',
  'css/money.css?v=d288b77',
  'css/messages.css?v=d288b77',
  'css/people.css?v=d288b77',
  'css/me.css?v=d288b77',
  'js/vendor/preact.module.js?v=d288b77',
  'js/vendor/hooks.module.js?v=d288b77',
  'js/vendor/htm.module.js?v=d288b77',
  'js/vendor/htm-preact.module.js?v=d288b77',
  'js/vendor/supabase.umd.js?v=d288b77',
  'js/main.js?v=d288b77',
  'js/app.js?v=d288b77',
  'js/router.js?v=d288b77',
  'js/store.js?v=d288b77',
  'js/ui/components.js?v=d288b77',
  'js/ui/email-gate.js?v=d288b77',
  'js/ui/tour.js?v=d288b77',
  'js/ui/inbox.js?v=d288b77',
  'js/ui/pending.js?v=d288b77',
  'js/ui/account.js?v=d288b77',
  'js/ui/tab-guide.js?v=d288b77',
  'js/lib/turnstile.js?v=d288b77',
  'js/lib/device.js?v=d288b77',
  'js/screens/rides.js?v=d288b77',
  'js/screens/welcome.js?v=d288b77',
  'js/screens/signin.js?v=d288b77',
  'js/ui/icons.js?v=d288b77',
  'js/lib/logic.js?v=d288b77',
  'js/lib/templates.js?v=d288b77',
  'js/lib/fx.js?v=d288b77',
  'js/api/index.js?v=d288b77',
  'js/api/errors.js?v=d288b77',
  'js/api/supabase-api.js?v=d288b77',
  'js/api/demo-api.js?v=d288b77',
  'js/api/demo-seed.js?v=d288b77',
  'js/screens/onboarding.js?v=d288b77',
  'js/screens/home.js?v=d288b77',
  'js/screens/trip.js?v=d288b77',
  'js/screens/trip-extras.js?v=d288b77',
  'js/screens/lists.js?v=d288b77',
  'js/screens/shopping.js?v=d288b77',
  'js/screens/import.js?v=d288b77',
  'js/screens/money.js?v=d288b77',
  'js/screens/money-requests.js?v=d288b77',
  'js/screens/messages.js?v=d288b77',
  'js/screens/people.js?v=d288b77',
  'js/screens/me.js?v=d288b77',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // One missing file must not break installation.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('medura-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Only this deploy's cache. A versioned file (?v=…) is served only as that exact version, so a slow network
// can't mix modules of two deploys; unversioned files and pages fall back by path.
async function fromCache(request) {
  const cache = await caches.open(VERSION);
  const versioned = new URL(request.url).searchParams.has('v');
  const hit = await cache.match(request, versioned ? undefined : { ignoreSearch: true });
  if (hit) return hit;
  if (request.mode === 'navigate') return (await cache.match('index.html')) || cache.match('./');
  return undefined;
}

async function networkFirst(event) {
  const { request } = event;
  const cache = await caches.open(VERSION);
  const network = fetch(request).then((response) => {
    if (response && response.ok && response.type === 'basic') {
      const copy = response.clone();
      event.waitUntil(cache.put(request, copy).catch(() => {}));
    }
    return response;
  });

  // Serve the cache if the network is too slow, but only when we actually have a copy.
  const timeout = new Promise((resolve) => {
    setTimeout(() => {
      fromCache(request).then((hit) => hit && resolve(hit));
    }, NETWORK_TIMEOUT_MS);
  });

  try {
    return await Promise.race([network, timeout]);
  } catch {
    const hit = await fromCache(request);
    if (hit) return hit;
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase, fonts, CDNs → browser default
  event.respondWith(networkFirst(event));
});

// ---------------------------------------------------------------------------
// Push (phase 2 delivers these; payload: {title, body, url, tag, urgent})
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'מדורה 🔥';
  const options = {
    body: data.body || '',
    icon: 'assets/icons/icon-192.png',
    badge: 'assets/icons/badge-96.png',
    dir: 'rtl',
    lang: 'he',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    requireInteraction: Boolean(data.urgent),
    vibrate: data.urgent ? [90, 50, 90] : [40],
    data: { url: data.url || './' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || './';
  const target = new URL(raw, self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const existing = windows.find((w) => w.url.startsWith(self.registration.scope));
      if (existing) {
        const focused = await existing.focus().catch(() => existing);
        const client = focused || existing;
        const sameDocument = client.url.split('#')[0] === target.split('#')[0];
        if (sameDocument || !('navigate' in client)) {
          // Hash-only change: let the page's router handle it (no reload).
          client.postMessage({ type: 'navigate', url: target });
          return client;
        }
        return client.navigate(target).catch(() => client.postMessage({ type: 'navigate', url: target }));
      }
      return self.clients.openWindow(target);
    }),
  );
});
