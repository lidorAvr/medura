// New people start with who they are: an e-mail first (verify now or later — joining a trip needs it
// verified), then "הפרופיל שלי" (name, phone, the app on the home screen) — once, for all their trips.
// People who already have a trip on this device never see it (only new joiners).
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { actions, emailRequired, store, useStore } from '../store.js?v=65baf9b';
import { installState, onInstallChange, promptInstall } from '../lib/device.js?v=65baf9b';
import { EmailGate } from './email-gate.js?v=65baf9b';
import { Button, Card, Field, Skeleton, TextInput } from './components.js?v=65baf9b';

const LATER = 'medura:email-later';
const readLater = () => {
  try {
    return localStorage.getItem(LATER) || '';
  } catch {
    return '';
  }
};
const writeLater = (v) => {
  try {
    localStorage.setItem(LATER, v);
  } catch {
    /* storage unavailable */
  }
};

function Shell({ title, lead, children }) {
  return html`<div class="onb onb--flow entry" data-testid="entry">
    <div class="entry__head">
      <span class="entry__logo" aria-hidden="true">🔥</span>
      <h1 class="entry__title">${title}</h1>
      ${lead ? html`<p class="entry__lead">${lead}</p>` : null}
    </div>
    <div class="onb__body">${children}</div>
  </div>`;
}

/** Wraps a screen for new people: e-mail → my profile → the screen. `requireVerified` = joining a trip. */
export function Entry({ requireVerified = false, children }) {
  const ready = useStore((s) => s.ready);
  const contact = useStore((s) => s.contact);
  const trips = useStore((s) => s.trips);
  const [later, setLater] = useState(readLater);
  const [account, setAccount] = useState(undefined); // undefined = loading
  const verified = Boolean(contact?.verified);
  const active = ready && emailRequired(store.get()) && !(trips && trips.length);

  useEffect(() => {
    if (!active || !verified) return;
    store.get().api.myAccount().then(setAccount).catch(() => setAccount(null));
  }, [active, verified]);

  if (!active) return children;
  if (!verified && (requireVerified || !later)) {
    return html`<${Shell} title=${requireVerified ? 'רגע לפני שנכנסים 🔐' : 'ברוכים הבאים למדורה 🔥'}
      lead=${requireVerified ? 'מאמתים את המייל פעם אחת — ומכל מכשיר רואים את כל הטיולים שלך.' : 'מתחילים במייל — ככה כל הטיולים שלך יחכו לך בכל מכשיר.'}>
      <${EmailGate} mode="inline" initialEmail=${later}
        onLater=${requireVerified ? null : (email) => { writeLater(email || 'later'); setLater(email || 'later'); }} />
    </${Shell}>`;
  }
  if (verified) {
    if (account === undefined) return html`<${Shell} title="רגע…"><${Skeleton} lines=${3} /></${Shell}>`;
    if (!account?.name) return html`<${AccountStep} account=${account} onDone=${setAccount} />`;
  }
  return children;
}

/** A phone as typed or pasted (iOS adds invisible direction marks) → the characters a profile phone allows, or null. */
export function cleanPhone(p) {
  const t = String(p || '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/[\u2010-\u2015\u2212./]/g, '-')
    .trim();
  return t && t.length <= 20 && /^[0-9+() -]+$/.test(t) ? t : null;
}

/** "הפרופיל שלי": the person — name, phone, the app on the home screen. */
export function AccountStep({ account, onDone }) {
  const [name, setName] = useState(account?.name || '');
  const [phone, setPhone] = useState(account?.phone || '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [install, setInstall] = useState(installState);
  useEffect(() => onInstallChange(() => setInstall(installState())), []);
  const save = async (e) => {
    e?.preventDefault();
    if (!name.trim()) return setError('איך קוראים לך? 🙂');
    if (phone.trim() && !cleanPhone(phone)) return setError('הטלפון לא נראה תקין — רק ספרות, רווחים ומקפים');
    setBusy(true);
    const res = await actions.run((api) => api.saveAccount({ name: name.trim(), phone: cleanPhone(phone) }), { refresh: false });
    setBusy(false);
    if (res) onDone(res);
    return undefined;
  };
  return html`<${Shell} title="הפרופיל שלי 🙂" lead="פעם אחת, לכל הטיולים. אפשר לשנות אחר כך במסך ״אני״.">
    <${Card}>
      <form class="stack" onSubmit=${save} noValidate data-testid="account-step">
        <${Field} label="איך קוראים לך?" error=${error}>
          <${TextInput} value=${name} maxlength="40" placeholder="השם שלך" autocomplete="given-name" data-autofocus
            onInput=${(e) => { setName(e.target.value); setError(null); }} />
        </${Field}>
        <${Field} label="טלפון (לא חובה)" hint="כדי שהחבר׳ה יוכלו להתקשר או להעביר לך כסף בביט">
          <${TextInput} type="tel" inputmode="tel" dir="ltr" autocomplete="tel" value=${phone} maxlength="20" placeholder="050-1234567"
            onInput=${(e) => setPhone(e.target.value)} />
        </${Field}>
        ${install === 'prompt'
          ? html`<div class="entry__install">
              <span>📲 מדורה במסך הבית — כמו אפליקציה</span>
              <${Button} size="sm" variant="secondary" onClick=${async () => { await promptInstall(); setInstall(installState()); }}>התקנה</${Button}>
            </div>`
          : install === 'ios'
            ? html`<p class="entry__install small">📲 באייפון: ⬆️ שיתוף ← ״הוספה למסך הבית״ — ומדורה על המסך כמו אפליקציה.</p>`
            : null}
        <${Button} type="submit" variant="accent" size="lg" block loading=${busy}>המשך 🔥</${Button}>
      </form>
    </${Card}>
  </${Shell}>`;
}
