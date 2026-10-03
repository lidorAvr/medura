// Entry point: render the shell, boot the store, register the service worker.
import { html } from 'htm/preact';
import { render } from 'preact';
import { App, preloadScreens } from './app.js?v=5ff55d3';
import { actions } from './store.js?v=5ff55d3';
import { captureInstallPrompt } from './lib/device.js?v=5ff55d3';

captureInstallPrompt();

render(html`<${App} />`, document.getElementById('app'));

actions.boot().then(() => {
  // Warm the other screens once the first one is on screen.
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 400));
  idle(() => preloadScreens());
});

// Service worker: offline shell + (phase 2) push notifications.
const canUseSw = 'serviceWorker' in navigator
  && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');

if (canUseSw) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[medura] service worker registration failed', err);
    });
  });
  // Notification clicks ask an already-open window to jump to a route.
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'navigate' && typeof data.url === 'string') {
      const i = data.url.indexOf('#');
      if (i >= 0) location.hash = data.url.slice(i);
    }
  });
}
