// "איך כולם מגיעים" — the whole crew's way of getting there on one card, for everyone to read: who drives (and how many
// seats are left), who is in whose car, who is looking, who comes some other way, who hasn't said yet. Built only
// from what the members already told the app (prefs.transport, rides, seats, prefs.travel) — nothing new is stored.
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { actions } from '../store.js?v=853199b';
import { displayName, formatTime, hebrewCount, rideModel } from '../lib/logic.js?v=853199b';
import { Avatar, Button, Card, Chip } from './components.js?v=853199b';
import { withIds } from './arrive-with.js?v=853199b';

const SELF = { own: '🧍 מגיעים בדרך שלהם', drop: '🙋 מקפיצים אותם', transit: '🚆 ברכבת / באוטובוס', park: '🅿️ חונים בשדה' };

/** The groups the summary chips filter by, in the order they're shown. */
export const ARRIVAL_GROUPS = [
  { key: 'drive', emoji: '🚗', label: 'נוהגים' },
  { key: 'in', emoji: '✅', label: 'יש להם מקום' },
  { key: 'seek', emoji: '🙋', label: 'מחפשים מקום' },
  { key: 'other', emoji: '🧍', label: 'בדרך אחרת' },
  { key: 'unset', emoji: '❓', label: 'עוד לא בחרו' },
];

const timeOf = (iso) => (iso ? formatTime(iso) : '');

/**
 * One line per profile: {member, group, text, detail}. `group` ∈ ARRIVAL_GROUPS keys.
 *   drive → "🚗 נוהג/ת · 2 מקומות פנויים"      in → "✅ ברכב של X"      seek → "🙋 מחפש/ת מקום" / "⏳ ביקש/ה מקום אצל X"
 *   other → own way / dropped / train / airport parking                    unset → "❓ עוד לא בחרו"
 */
export function crewArrival(snap) {
  const members = (snap?.members || []).filter((m) => m && m.id != null);
  const rows = members.map((m) => {
    const model = rideModel(snap, m.id);
    const mode = m.prefs?.transport?.mode || null;
    const from = m.prefs?.transport?.from || null;
    const flight = m.prefs?.travel?.out?.flight ? `✈️ ${String(m.prefs.travel.out.flight).toUpperCase()}${m.prefs.travel.out.at ? ` · ${timeOf(m.prefs.travel.out.at)}` : ''}` : null;
    const r = model.myRide;
    const together = withIds(members, m.id).map((id) => members.find((x) => x.id === id)).filter(Boolean).map(displayName);
    const withText = together.length ? `🤝 יחד עם ${together.join(', ')}` : '';
    if (r) {
      const kind = r.kind || 'car';
      const emoji = kind === 'taxi' ? '🚕' : kind === 'meet' ? '🚆' : '🚗';
      const what = kind === 'taxi' ? 'מונית משותפת' : kind === 'meet' ? 'נקודת מפגש' : mode === 'park' ? 'חונים בשדה' : 'נוהג/ת';
      const room = kind === 'meet' ? hebrewCount(r.taken, 'מצטרף/ת', 'מצטרפים') : r.free ? hebrewCount(r.free, 'מקום פנוי', 'מקומות פנויים') : 'מלא';
      const detail = [withText, r.from_text && `מ־${r.from_text}`, r.depart_at && timeOf(r.depart_at), flight].filter(Boolean).join(' · ');
      return { member: m, group: 'drive', text: `${emoji} ${what} · ${room}`, detail, free: kind === 'meet' ? 0 : r.free };
    }
    if (model.mySeat) {
      const kind = model.mySeat.kind || 'car';
      const who = displayName(model.mySeat.driver);
      return { member: m, group: 'in', text: `✅ ${kind === 'taxi' ? 'במונית של' : kind === 'meet' ? 'בנקודת המפגש של' : 'ברכב של'} ${who}`, detail: [withText, model.mySeat.depart_at && timeOf(model.mySeat.depart_at), flight].filter(Boolean).join(' · ') };
    }
    if (model.myAsk) return { member: m, group: 'seek', text: `⏳ ביקש/ה מקום אצל ${displayName(model.myAsk.driver)}`, detail: [withText, flight].filter(Boolean).join(' · ') };
    if (mode === 'need' || mode === 'taxi') return { member: m, group: 'seek', text: mode === 'taxi' ? '🚕 מחפש/ת מונית משותפת' : '🙋 מחפש/ת מקום', detail: [withText, from && `מ־${from}`, flight].filter(Boolean).join(' · ') };
    if (SELF[mode]) return { member: m, group: 'other', text: SELF[mode], detail: [withText, flight].filter(Boolean).join(' · ') };
    return { member: m, group: 'unset', text: '❓ עוד לא בחרו', detail: [withText, flight].filter(Boolean).join(' · ') };
  });
  const counts = Object.fromEntries(ARRIVAL_GROUPS.map((g) => [g.key, rows.filter((x) => x.group === g.key).length]));
  const people = (g) => rows.filter((x) => x.group === g).reduce((n, x) => n + (Number(x.member.headcount) || 1), 0);
  const seatsFree = rows.reduce((n, x) => n + (x.free || 0), 0);
  return { rows, counts, seatsFree, people };
}

export function CrewArrival({ snap, me, isAdmin, tripId }) {
  const [filter, setFilter] = useState(null);
  const [busy, setBusy] = useState(false);
  const { rows, counts, seatsFree } = crewArrival(snap);
  if (rows.length < 2) return null;
  const shown = rows.filter((r) => !filter || r.group === filter);
  // me first, then the ones with something to say (drivers), then the rest in the crew's order
  const order = { drive: 0, in: 1, seek: 2, other: 3, unset: 4 };
  shown.sort((a, b) => (a.member.id === me.id ? -1 : b.member.id === me.id ? 1 : 0) || order[a.group] - order[b.group]);
  const unset = rows.filter((r) => r.group === 'unset' && r.member.id !== me.id);
  const reachable = unset.filter((r) => r.member.claimed !== false);        // the app can only nudge who has it
  const nudge = async () => {
    setBusy(true);
    const n = await actions.run((api) => api.nudgeMembers(tripId, 'rides'));
    setBusy(false);
    if (n !== undefined) actions.toast(n ? `נשלחה תזכורת עדינה ל־${hebrewCount(n, 'משתתף/ת', 'משתתפים')} 🙂` : 'כולם כבר קיבלו תזכורת היום 🙂', 'success', 3200);
  };
  return html`<${Card} emoji="🗺️" title="איך כולם מגיעים" class="crew-arrival" data-testid="crew-arrival">
    <div class="crew-arrival__chips" role="group" aria-label="סינון לפי דרך הגעה">
      ${ARRIVAL_GROUPS.filter((g) => counts[g.key]).map((g) => html`<${Chip} key=${g.key} active=${filter === g.key} data-group=${g.key}
        onClick=${() => setFilter(filter === g.key ? null : g.key)}>${g.emoji} ${counts[g.key]} ${g.label}</${Chip}>`)}
    </div>
    ${seatsFree ? html`<p class="small muted crew-arrival__seats" data-testid="crew-arrival-seats">🚗 ${hebrewCount(seatsFree, 'מקום פנוי אחד', 'מקומות פנויים')} ברכבים — מי שמחפש/ת, למטה אפשר לבקש</p>` : null}
    <ul class="crew-arrival__list">
      ${shown.map((r) => html`<li key=${r.member.id} class=${`crew-arrival__row is-${r.group}`} data-testid="crew-arrival-row" data-group=${r.group}>
        <${Avatar} member=${r.member} size=${34} />
        <div class="crew-arrival__text">
          <b>${r.member.id === me.id ? 'את/ה' : displayName(r.member)}${(Number(r.member.headcount) || 1) > 1 ? html` <span class="muted small">(${r.member.headcount})</span>` : ''}</b>
          <span class="small">${r.text}</span>
          ${r.detail ? html`<span class="small muted">${r.detail}</span>` : null}
        </div>
      </li>`)}
    </ul>
    ${isAdmin && unset.length
      ? html`<div class="crew-arrival__admin">
          ${reachable.length
            ? html`<${Button} variant="secondary" size="sm" loading=${busy} onClick=${nudge} data-testid="crew-arrival-nudge">🔔 להזכיר ל־${reachable.length} שעוד לא סימנו</${Button}>` : null}
          ${unset.length > reachable.length
            ? html`<p class="tiny muted" data-testid="crew-arrival-nophone">${hebrewCount(unset.length - reachable.length, 'פרופיל אחד', 'פרופילים')} עוד בלי האפליקציה — אפשר לשאול אותם בוואטסאפ</p>` : null}
        </div>`
      : null}
  </${Card}>`;
}
