// Waiting to join a profile: the trip read-only (plan, who's coming, what's on the lists) until
// the profile's people answer. Polls, and opens the trip the moment the request is approved.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { actions, store } from '../store.js?v=6582265';
import { navigate } from '../router.js?v=6582265';
import { formatDate, formatTime } from '../lib/logic.js?v=6582265';
import { Avatar, Button, Card, Skeleton } from './components.js?v=6582265';

const POLL_MS = 15000;

export function PendingGate({ tripId, fallback }) {
  const [view, setView] = useState(undefined); // undefined = loading, null = not pending
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = async () => {
      try {
        const v = await store.get().api.pendingView(tripId);
        if (!alive) return;
        setView(v);
        if (v.request.status === 'pending') timer = setTimeout(load, POLL_MS);
      } catch {
        if (!alive) return;
        // approved meanwhile (now a member) → open the trip; otherwise this isn't a pending join
        const snap = await actions.openTrip(tripId, { force: true }).catch(() => null);
        if (!alive) return;
        if (snap) {
          await actions.loadTrips();
          actions.toast('אושרת! ברוכים הבאים 🔥', 'success', 3600);
        } else setView(null);
      }
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [tripId]);

  if (view === undefined) return html`<div class="screen gate"><${Skeleton} lines=${3} /></div>`;
  if (view === null) return fallback;
  const { request, trip } = view;
  const schedule = Array.isArray(trip.info?.schedule) ? trip.info.schedule : [];
  const rules = Array.isArray(trip.info?.rules) ? trip.info.rules : [];
  const cancel = async () => {
    setBusy(true);
    await actions.run(async (api) => { await api.cancelProfileRequest(tripId); return true; }, { refresh: false, success: 'הבקשה בוטלה' });
    navigate('/', { replace: true });
  };

  return html`<div class="screen pending" data-testid="pending">
    <div class="gate__brand" aria-hidden="true">🔥 מדורה</div>
    <${Card}>
      <div class="pending__status">
        ${request.status === 'pending'
          ? html`<p class="pending__title">⏳ הבקשה שלך להצטרף ל״${request.profile}״ מחכה לאישור</p>
              <p class="muted small">שלחנו להם התראה ומייל. בינתיים אפשר להסתכל — עדכונים ושינויים אחרי האישור.</p>
              <${Button} variant="ghost" size="sm" loading=${busy} onClick=${cancel}>ביטול הבקשה</${Button}>`
          : html`<p class="pending__title">הבקשה להצטרף ל״${request.profile}״ לא אושרה</p>
              <p class="muted small">אפשר לדבר איתם, או לפתוח שוב את קישור ההזמנה ולבחור אחרת.</p>
              <${Button} variant="secondary" size="sm" href="#/">למסך הראשי</${Button}>`}
      </div>
    </${Card}>

    <${Card} emoji=${trip.emoji || '⛺'} title=${trip.name}>
      <p class="muted">${[trip.starts_at && `${formatDate(trip.starts_at, { weekday: 'long' })} ${formatTime(trip.starts_at)}`, trip.location].filter(Boolean).join(' · ')}</p>
      ${schedule.length
        ? html`<ul class="pending__list">${schedule.map((r, i) => html`<li key=${i}><b>${r.time || ''}</b> ${r.emoji || ''} ${r.label}</li>`)}</ul>`
        : null}
      ${rules.length
        ? html`<ul class="pending__list">${rules.map((r, i) => html`<li key=${i}>${r.emoji || '💡'} ${r.text}</li>`)}</ul>`
        : null}
    </${Card}>

    <${Card} emoji="👥" title="מי מגיע">
      <div class="pending__people">
        ${view.members.map((m, i) => html`<span class="pending__person" key=${i}><${Avatar} member=${{ ...m, claimed: true }} size=${26} /> ${m.display_name}</span>`)}
      </div>
    </${Card}>

    <${Card} emoji="📋" title="מה מביאים (לקריאה בלבד)">
      <ul class="pending__list pending__items">
        ${view.items.map((it, i) => html`<li key=${i}><span>${it.emoji || '•'} ${it.title}</span>${it.who ? html`<span class="muted small">${it.who}</span>` : html`<span class="pending__missing small">חסר</span>`}</li>`)}
      </ul>
    </${Card}>
  </div>`;
}
