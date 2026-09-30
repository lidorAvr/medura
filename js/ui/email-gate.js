// First visit to a trip on this device: verify an e-mail (phase 2). Reminders, the 09:30 daily
// summary and every push also go there. Two steps: address → 6-digit code.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { actions, store, useStore } from '../store.js?v=65baf9b';
import { navigate } from '../router.js?v=65baf9b';
import { hebrewError, toApiError } from '../api/errors.js?v=65baf9b';
import { Button, Card, Field, TextInput } from './components.js?v=65baf9b';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s.]{2,}$/;
const RESEND_S = 30;

/** Link this device to every profile its verified e-mail belongs to. Returns the new links. */
export async function linkThisDevice() {
  try {
    const linked = (await store.get().api.linkByEmail()) || [];
    if (linked.length) await actions.loadTrips();
    return linked;
  } catch {
    return [];
  }
}

/**
 * mode 'gate'   — first visit to a trip: verify an e-mail before using it.
 * mode 'signin' — "כבר הצטרפתי ממכשיר אחר": verify → this device joins the profiles of that e-mail.
 */
export function EmailGate({ mode: purpose = 'gate', initialEmail = '', onLater = null }) {
  const mode = useStore((s) => s.mode);
  const signin = purpose === 'signin';
  const inline = purpose === 'inline';
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [demoCode, setDemoCode] = useState(null);
  const [wait, setWait] = useState(0);
  const codeRef = useRef(null);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  useEffect(() => {
    if (step === 'code') codeRef.current?.querySelector('input')?.focus();
  }, [step]);

  const call = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn(store.get().api);
    } catch (e) {
      setError(hebrewError(toApiError(e).code));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const send = async (e) => {
    e?.preventDefault();
    const v = email.trim().toLowerCase();
    if (!EMAIL_RE.test(v)) {
      setError('המייל לא נראה תקין — בדקו ונסו שוב ✏️');
      return;
    }
    const res = await call((api) => api.requestEmailCode(v));
    if (!res) return;
    setDemoCode(res.demo_code || null);
    setCode('');
    setWait(RESEND_S);
    setStep('code');
  };

  const verify = async (value = code) => {
    const digits = String(value).replace(/\D/g, '');
    if (digits.length !== 6) {
      setError('הקוד הוא 6 ספרות 🙂');
      return;
    }
    const res = await call((api) => api.verifyEmailCode(digits));
    if (!res) return;
    if (!res.verified) {
      setError('הקוד לא נכון — בדקו ונסו שוב');
      setCode('');
      return;
    }
    actions.setContact(res);
    const linked = await linkThisDevice();
    if (signin) {
      if (linked.length) {
        actions.toast('התחברת ✅ ברוכים השבים!', 'success', 3200);
        navigate(`/t/${linked[0].trip_id}`, { replace: true });
      } else {
        setStep('none');
      }
      return;
    }
    if (inline) return;
    actions.toast(linked.length ? 'המייל אומת ✅ והמכשיר חובר לפרופיל שלך' : 'המייל אומת ✅ מעכשיו העדכונים יגיעו גם לשם', 'success', 3200);
  };

  const onCode = (e) => {
    const v = e.target.value.replace(/\D/g, '').slice(0, 6);
    setCode(v);
    setError(null);
    if (v.length === 6) verify(v);
  };

  const card = html`<${Card}>
    <div class="email-gate__head">
      <span class="email-gate__emoji" aria-hidden="true">${step === 'email' ? (signin ? '🔑' : '📬') : step === 'none' ? '🤔' : '🔐'}</span>
      <h1 class="email-gate__title">
        ${step === 'email' ? (signin ? 'התחברות עם המייל' : 'רגע לפני שנכנסים — מה המייל שלך?') : step === 'none' ? 'לא מצאנו פרופיל עם המייל הזה' : 'שלחנו לך קוד'}
      </h1>
      <p class="email-gate__text">
        ${step === 'email'
          ? (signin
            ? 'המייל שאימתתם כשהצטרפתם — ונחזיר אתכם לפרופיל ולטיולים שלכם, בכל מכשיר.'
            : 'לשם יגיעו התזכורות, העדכונים מהמנהלים והסיכום היומי — גם כשהאפליקציה סגורה. המייל לא מוצג לאף אחד.')
          : step === 'none'
            ? 'אולי הצטרפתם עם מייל אחר? אפשר לנסות שוב, או להיכנס מקישור ההזמנה של הטיול.'
            : html`הקלידו את 6 הספרות שנשלחו אל <bdi dir="ltr">${email.trim().toLowerCase()}</bdi>. לא מוצאים? הציצו בספאם.`}
      </p>
    </div>

    ${step === 'none'
      ? html`<div class="stack">
          <${Button} variant="accent" block onClick=${() => { setStep('email'); setError(null); }}>ניסיון עם מייל אחר</${Button}>
          <${Button} variant="ghost" block href="#/">למסך הראשי</${Button}>
        </div>`
      : step === 'email'
      ? html`<form class="stack" onSubmit=${send} noValidate>
          <${Field} label="המייל שלך" error=${error}>
            <${TextInput} type="email" inputmode="email" autocomplete="email" dir="ltr" value=${email}
              placeholder="name@example.com" data-autofocus
              onInput=${(e) => { setEmail(e.target.value); setError(null); }} />
          </${Field}>
          <${Button} type="submit" variant="accent" size="lg" block loading=${busy}>שלחו לי קוד</${Button}>
        </form>`
      : html`<form class="stack" ref=${codeRef} onSubmit=${(e) => { e.preventDefault(); verify(); }} noValidate>
          ${mode === 'demo' && demoCode
            ? html`<p class="email-gate__demo" role="note">🎭 מצב הדגמה — לא נשלח מייל באמת. הקוד: <b dir="ltr">${demoCode}</b></p>`
            : null}
          <${Field} label="הקוד" error=${error}>
            <${TextInput} class="email-gate__code" inputmode="numeric" autocomplete="one-time-code" dir="ltr"
              maxlength="6" value=${code} placeholder="••••••" onInput=${onCode} />
          </${Field}>
          <${Button} type="submit" variant="accent" size="lg" block loading=${busy}>אימות</${Button}>
          ${typeof navigator !== 'undefined' && navigator.clipboard?.readText
            ? html`<${Button} variant="secondary" block onClick=${async () => {
                try {
                  const text = await navigator.clipboard.readText();
                  const digits = String(text || '').replace(/\D/g, '').slice(0, 6);
                  if (digits.length === 6) {
                    setCode(digits);
                    verify(digits);
                  } else setError('לא מצאנו קוד בהעתקה — העתיקו את 6 הספרות מהמייל');
                } catch {
                  setError('לא הצלחנו לקרוא את ההעתקה — הקלידו את הקוד');
                }
              }}>📋 הדבקת הקוד מהמייל</${Button}>`
            : null}
          ${onLater
            ? html`<button type="button" class="link email-gate__later" onClick=${() => onLater(email.trim().toLowerCase())}>אאמת אחר כך ←</button>`
            : null}
          <div class="row row--center wrap email-gate__more">
            <${Button} variant="ghost" size="sm" disabled=${wait > 0 || busy} onClick=${send}>
              ${wait > 0 ? `שליחה חוזרת בעוד ${wait}` : 'שלחו קוד חדש'}
            </${Button}>
            <${Button} variant="ghost" size="sm" onClick=${() => { setStep('email'); setError(null); }}>שינוי מייל</${Button}>
          </div>
        </form>`}
  </${Card}>`;
  if (inline) return card;
  return html`<div class="screen gate email-gate">
    <div class="gate__brand" aria-hidden="true">🔥 מדורה</div>
    ${card}
  </div>`;
}
