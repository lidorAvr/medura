// Cloudflare Turnstile for the first anonymous sign-in on a device (bot protection).
// Loaded only when config.turnstileSiteKey is set. Resolves with a one-time token.

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TIMEOUT_MS = 45000;
let scriptPromise = null;

function loadScript() {
  if (globalThis.turnstile) return Promise.resolve(globalThis.turnstile);
  scriptPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.onload = () => (globalThis.turnstile ? resolve(globalThis.turnstile) : reject(new Error('network')));
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error('network'));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/** Shows a small "checking you're human" card (Turnstile may need a tap) until a token arrives. */
export async function turnstileToken(siteKey) {
  const ts = await loadScript();
  const box = document.createElement('div');
  box.className = 'captcha-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'בדיקת אבטחה');
  box.innerHTML = '<div class="captcha-box__card"><p class="captcha-box__text">רגע, בודקים שאתם לא רובוט 🤖</p><div class="captcha-box__widget"></div></div>';
  document.body.appendChild(box);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('network')), TIMEOUT_MS);
      ts.render(box.querySelector('.captcha-box__widget'), {
        sitekey: siteKey,
        language: 'he',
        appearance: 'interaction-only',
        callback: (token) => {
          clearTimeout(timer);
          resolve(token);
        },
        'error-callback': () => {
          clearTimeout(timer);
          reject(new Error('network'));
        },
      });
    });
  } finally {
    box.remove();
  }
}