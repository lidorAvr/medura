/* מדורה service worker — offline shell (network-first) + push notifications.
   Same-origin GETs only; Supabase and other cross-origin requests are never touched. */
const VERSION = 'medura-v1';
const NETWORK_TIMEOUT_MS = 4000; // weak reception at the campsite → fall back to cache quickly

const SHELL = [
  './',
  'index.html',
  'config.js',
  'manifest.webmanifest',
  'favicon.svg',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/maskable-512.png',
  'assets/icons/apple-touch-icon.png',
  'assets/icons/badge-96.png',
  'css/styles.css',
  'css/onboarding.css',
  'css/home.css',
  'css/trip.css',
  'css/lists.css',
  'css/money.css',
  'css/messages.css',
  'css/people.css',
  'css/me.css',
  'js/vendor/preact.module.js',
  'js/vendor/hooks.module.js',
  'js/vendor/htm.module.js',
  'js/vendor/htm-preact.module.js',
  'js/vendor/supabase.umd.js',
  'js/main.js',
  'js/app.js',
  'js/router.js',
  'js/store.js',
  'js/ui/components.js',
  'js/ui/email-gate.js',
  'js/ui/tour.js',
  'js/ui/inbox.js',
  'js/ui/pending.js',
  'js/lib/turnstile.js',
  'js/lib/device.js',
  'js/screens/rides.js',
  'js/screens/welcome.js',
  'js/screens/signin.js',
  'js/ui/icons.js',
  'js/lib/logic.js',
  'js/api/index.js',
  'js/api/errors.js',
  'js/api/supabase-api.js',
  'js/api/demo-api.js',
  'js/api/demo-seed.js',
  'js/screens/onboarding.js',
  'js/screens/home.js',
  'js/screens/trip.js',
  'js/screens/lists.js',
  'js/screens/shopping.js',
  'js/screens/import.js',
  'js/screens/money.js',
  'js/screens/messages.js',
  'js/screens/people.js',
  'js/screens/me.js',
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

function fromCache(request) {
  return caches.match(request, { ignoreSearch: true }).then((hit) => {
    if (hit) return hit;
    if (request.mode === 'navigate') {
      return caches.match('index.html').then((page) => page || caches.match('./'));
    }
    return undefined;
  });
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
