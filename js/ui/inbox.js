// "📥 מחכה לך" — everything waiting for MY answer, with one-tap answers. The other side is always
// told (the RPCs send the notification). Shown on the home screen; hidden when empty.
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { actions } from '../store.js?v=9252f89';
import { href } from '../router.js?v=9252f89';
import { displayName, formatMoney, formatTime, hebrewCount, myInbox } from '../lib/logic.js?v=9252f89';
import { Avatar, Button, Card, TextInput } from './components.js?v=9252f89';

const ok = (fn) => async (api) => {
  await fn(api);
  return true;
};

export function InboxCard({ snap, me, skip = [], only = null }) {
  const entries = myInbox(snap, me.id).filter((e) => !skip.includes(e.kind) && (!only || only.includes(e.kind)));
  const [busy, setBusy] = useState(null);
  const [declining, setDeclining] = useState(null); // pledge id → asking "why?"
  const [reason, setReason] = useState('');
  if (!entries.length) return null;
  const tripId = snap.trip.id;

  const go = async (key, fn, success) => {
    setBusy(key);
    await actions.run(ok(fn), { success });
    setBusy(null);
  };
  const rideLine = (ride) => [ride.from_text && `מ${ride.from_text}`, ride.depart_at && `ב-${formatTime(ride.depart_at)}`].filter(Boolean).join(' ');

  const row = (e) => {
    if (e.kind === 'profile_request') {
      const r = e.request;
      const what = r.merging ? 'מצטרף/ת מפרופיל נפרד — הכול עובר אליכם' : r.person ? `כבר ברשימה של הפרופיל (${r.person})` : 'חדש/ה בפרופיל — יגדל באחד';
      return html`<span class="inbox__emoji" aria-hidden="true">🤝</span>
        <div class="inbox__text"><b>${r.name}</b> מבקש/ת להצטרף לפרופיל ${e.profile && e.profile.id !== me.id ? `״${displayName(e.profile)}״` : 'שלכם'}
          <span class="muted small" style="display:block"><bdi dir="ltr">${r.email}</bdi> · ${what}</span></div>
        <div class="inbox__acts">
          <${Button} size="sm" loading=${busy === e.key}
            onClick=${() => go(e.key, (api) => api.respondProfileRequest(r.id, true), `${r.name} בפרופיל ✅`)}>אישור</${Button}>
          <${Button} size="sm" variant="ghost" onClick=${() => go(e.key, (api) => api.respondProfileRequest(r.id, false), 'הבקשה נדחתה')}>לא</${Button}>
        </div>`;
    }
    if (e.kind === 'ride_ask') {
      return html`<${Avatar} member=${e.member} size=${34} />
        <div class="inbox__text"><b>${displayName(e.member)}</b> מבקש/ת להצטרף לרכב שלך${e.seats > 1 ? ` (${e.seats} מקומות)` : ''}</div>
        <div class="inbox__acts">
          <${Button} size="sm" loading=${busy === e.key} disabled=${e.seats > e.ride.free}
            onClick=${() => go(e.key, (api) => api.respondSeat(e.ride.id, e.member.id, true), `${displayName(e.member)} ברכב ✅`)}>אישור</${Button}>
          <${Button} size="sm" variant="ghost" onClick=${() => go(e.key, (api) => api.respondSeat(e.ride.id, e.member.id, false), 'עדכנו אותם 🙏')}>לא הפעם</${Button}>
        </div>`;
    }
    if (e.kind === 'ride_invite') {
      return html`<${Avatar} member=${e.ride.driver} size=${34} />
        <div class="inbox__text"><b>${displayName(e.ride.driver)}</b> מזמין/ה אותך לרכב 🚗 <span class="muted">${rideLine(e.ride)}</span></div>
        <div class="inbox__acts">
          <${Button} size="sm" loading=${busy === e.key}
            onClick=${() => go(e.key, (api) => api.respondSeat(e.ride.id, me.id, true), 'מסודרים! 🚗')}>מצטרפים</${Button}>
          <${Button} size="sm" variant="ghost" onClick=${() => go(e.key, (api) => api.respondSeat(e.ride.id, me.id, false), 'עדכנו אותם 🙏')}>לא, תודה</${Button}>
        </div>`;
    }
    if (e.kind === 'assignment') {
      const asking = declining === e.pledge.id;
      return html`<span class="inbox__emoji" aria-hidden="true">🙋</span>
        <div class="inbox__text"><b>${e.byName || displayName(e.by) || 'מנהל/ת'}</b> שיבץ/ה אותך: <a href=${href(`/t/${tripId}/lists?item=${e.item.id}`)}>${e.item.title}</a>${e.pledge.qty > 1 ? ` ×${e.pledge.qty}` : ''}</div>
        ${asking
          ? html`<form class="inbox__why" onSubmit=${(ev) => {
              ev.preventDefault();
              go(e.key, (api) => api.respondAssignment(e.item.id, false, reason.trim() || null), 'עדכנו שלא מסתדר 🙏').then(() => setDeclining(null));
            }}>
              <${TextInput} value=${reason} maxlength="200" placeholder="למה? (לא חובה) — למשל: אין לי כזה" aria-label="למה לא מסתדר"
                onInput=${(ev) => setReason(ev.target.value)} />
              <${Button} type="submit" size="sm" loading=${busy === e.key}>שליחה</${Button}>
              <${Button} size="sm" variant="ghost" onClick=${() => setDeclining(null)}>ביטול</${Button}>
            </form>`
          : html`<div class="inbox__acts">
              <${Button} size="sm" loading=${busy === e.key}
                onClick=${() => go(e.key, (api) => api.respondAssignment(e.item.id, true), 'סגור ✅ עדכנו אותם')}>✅ סגור</${Button}>
              <${Button} size="sm" variant="ghost" onClick=${() => { setReason(''); setDeclining(e.pledge.id); }}>🙅 לא מסתדר</${Button}>
            </div>`}`;
    }
    if (e.kind === 'money_request') {
      return html`<span class="inbox__emoji" aria-hidden="true">💰</span>
        <div class="inbox__text"><b>${formatMoney(e.amount)}</b> ל${e.request.by_person || displayName(e.from)} — ${e.request.title}
          ${e.request.due ? html`<span class="muted small" style="display:block">עד ${Number(e.request.due.slice(8, 10))}.${Number(e.request.due.slice(5, 7))}</span>` : null}</div>
        <div class="inbox__acts">
          <${Button} size="sm" href=${href(`/t/${tripId}/money?show=requests`)}>לתשלום</${Button}>
        </div>`;
    }
    if (e.kind === 'payment') {
      return html`<${Avatar} member=${e.from} size=${34} />
        <div class="inbox__text"><b>${displayName(e.from)}</b> סימן/ה שהעביר/ה לך <b>${formatMoney(e.payment.amount)}</b></div>
        <div class="inbox__acts">
          <${Button} size="sm" loading=${busy === e.key}
            onClick=${() => go(e.key, (api) => api.confirmPayment(e.payment.id), 'אישרת שקיבלת ✅')}>קיבלתי ✅</${Button}>
          <${Button} size="sm" variant="ghost" href=${href(`/t/${tripId}/money`)}>פרטים</${Button}>
        </div>`;
    }
    return html`<span class="inbox__emoji" aria-hidden="true">⏳</span>
      <div class="inbox__text">${hebrewCount(e.count, 'הצעה אחת מחכה', 'הצעות מחכות')} לאישור שלך</div>
      <div class="inbox__acts"><${Button} size="sm" variant="secondary" href=${href(`/t/${tripId}/lists?tab=pending`)}>לאישורים</${Button}></div>`;
  };

  return html`<${Card} emoji="📥" title="מחכה לך" class="inbox" action=${html`<span class="inbox__count">${entries.length}</span>`}>
    <ul class="inbox__list" data-testid="inbox">
      ${entries.map((e) => html`<li class="inbox__row" key=${e.key} data-kind=${e.kind}>${row(e)}</li>`)}
    </ul>
  </${Card}>`;
}
