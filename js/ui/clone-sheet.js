// The "🔁 לעשות את זה שוב" sheet: a name and a start date, then a new trip with this one's structure and lists.
import { html } from 'htm/preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { actions, store } from '../store.js?v=5ff55d3';
import { navigate } from '../router.js?v=5ff55d3';
import { runClone } from '../lib/clone-trip.js?v=5ff55d3';
import { Button, Field, Sheet, TextInput } from './components.js?v=5ff55d3';

/**
 * `tripId` + `name` identify the old trip; `snap` is its snapshot when it is the open trip (the dashboard passes none:
 * it's loaded on demand). onClose() closes. After creating, opens the new trip.
 */
export function CloneSheet({ open, tripId, name, snap = null, onClose }) {
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fetched, setFetched] = useState(null);       // the old trip's notes when the caller passed no snapshot (the dashboard)
  useLayoutEffect(() => {
    if (!open || snap) return;
    let live = true;
    setFetched(null);
    Promise.resolve(store.get().api?.getSnapshot(tripId)).then((x) => { if (live) setFetched(x?.trip?.info?.retro || null); }).catch(() => {});
    return () => { live = false; };
  }, [open, tripId, snap]);
  const retro = snap && snap.trip?.id === tripId ? snap.trip?.info?.retro : fetched;
  const worked = String(retro?.worked || '').trim();
  const change = String(retro?.change || '').trim();
  useLayoutEffect(() => {
    if (!open) return;
    setTitle(`${String(name || 'טיול').replace(/\s+—\s+שוב.*$/u, '')} — שוב 🔁`);
    setStart('');
    setBusy(false);
    setError('');
  }, [open, tripId]);
  const submit = async (e) => {
    e?.preventDefault();
    if (busy) return;
    if (!title.trim()) return setError('איך נקרא לטיול החדש?');
    setBusy(true);
    const id = await actions.run(async (api) => {
      const source = snap && snap.trip?.id === tripId ? snap : await api.getSnapshot(tripId);
      return runClone(api, source, { name: title, startYmd: start });
    }, { refresh: false, success: 'הטיול החדש מוכן 🔁 עכשיו מזמינים את החבורה' });
    setBusy(false);
    if (!id) return;
    onClose?.();
    await actions.loadTrips();
    navigate(`/t/${id}/people`);
  };
  return html`<${Sheet} open=${open} onClose=${onClose} title="🔁 לעשות את זה שוב"
    footer=${html`<${Button} type="submit" form="clone-form" icon="check" loading=${busy} data-testid="clone-go">יצירת הטיול החדש</${Button}>
      <${Button} variant="secondary" onClick=${onClose}>ביטול</${Button}>`}>
    <form id="clone-form" class="stack" onSubmit=${submit} noValidate>
      ${worked || change
        ? html`<div class="clone__retro" data-testid="clone-retro">
            <b>📝 מה סיכמתם בפעם הקודמת</b>
            ${change ? html`<p>🔧 לשנות: ${change}</p>` : null}
            ${worked ? html`<p>👍 עבד: ${worked}</p>` : null}
          </div>`
        : null}
      <p class="muted">נעתיק את סוג הטיול, הרשימות והמשימות, הלו״ז והטיפים. בלי האנשים, ההוצאות וההזמנות — את החבורה מזמינים אחר כך בלחיצה, מ״טיולים קודמים״.</p>
      <${Field} label="שם הטיול החדש" error=${error}>
        <${TextInput} value=${title} maxlength="60" onInput=${(e) => { setTitle(e.target.value); setError(''); }} data-testid="clone-name" />
      </${Field}>
      <${Field} label="מתי יוצאים? (לא חובה)" hint="הטיול החדש נמשך כמו הקודם">
        <${TextInput} type="date" value=${start} onInput=${(e) => setStart(e.target.value)} data-testid="clone-start" />
      </${Field}>
    </form>
  </${Sheet}>`;
}
