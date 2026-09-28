// First visit to a trip on this device: verify an e-mail (phase 2). Reminders, the 09:30 daily
// summary and every push also go there. Two steps: address → 6-digit code.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { actions, store, useStore } from '../store.js';
import { hebrewError, toApiError } from '../api/errors.js';
import { Button, Card, Field, TextInput } from './components.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s.]{2,}$/;
const RESEND_S = 30;

export function EmailGate() {
  const mode = useStore((s) => s.mode);
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
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
    actions.toast('המייל אומת ✅ מעכשיו העדכונים יגיעו גם לשם', 'success', 3200);
  };

  const onCode = (e) => {
    const v = e.target.value.replace(/\D/g, '').slice(0, 6);
    setCode(v);
    setError(null);
    if (v.length === 6) verify(v);
  };

  return html`<div class="screen gate email-gate">
    <div class="gate__brand" aria-hidden="true">🔥 מדורה</div>
    <${Card}>
      <div class="email-gate__head">
        <span class="email-gate__emoji" aria-hidden="true">${step === 'email' ? '📬' : '🔐'}</span>
        <h1 class="email-gate__title">${step === 'email' ? 'רגע לפני שנכנסים — מה המייל שלך?' : 'שלחנו לך קוד'}</h1>
        <p class="email-gate__text">
          ${step === 'email'
            ? 'לשם יגיעו התזכורות, העדכונים מהמנהלים והסיכום היומי — גם כשהאפליקציה סגורה. המייל לא מוצג לאף אחד.'
            : html`הקלידו את 6 הספרות שנשלחו אל <bdi dir="ltr">${email.trim().toLowerCase()}</bdi>. לא מוצאים? הציצו בספאם.`}
        </p>
      </div>

      ${step === 'email'
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
            <div class="row row--center wrap email-gate__more">
              <${Button} variant="ghost" size="sm" disabled=${wait > 0 || busy} onClick=${send}>
                ${wait > 0 ? `שליחה חוזרת בעוד ${wait}` : 'שלחו קוד חדש'}
              </${Button}>
              <${Button} variant="ghost" size="sm" onClick=${() => { setStep('email'); setError(null); }}>שינוי מייל</${Button}>
            </div>
          </form>`}
    </${Card}>
  </div>`;
}
