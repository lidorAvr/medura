// "🤝 מגיע/ה יחד עם…" — who I'm arriving with (prefs.transport.with = [member ids]). Shown to everyone on the crew
// arrival card; the others in the list see it from their side too (the link is read both ways, see crewArrival).
import { html } from 'htm/preact';
import { displayName } from '../lib/logic.js?v=853199b';
import { Chip } from './components.js?v=853199b';

/** The ids I'm with: mine, plus everybody who named me (a link is read both ways). Only members that still exist. */
export function withIds(members, meId) {
  const ids = new Set((members || []).map((m) => m.id));
  const mine = (members || []).find((m) => m.id === meId)?.prefs?.transport?.with;
  const out = new Set((Array.isArray(mine) ? mine : []).filter((id) => ids.has(id) && id !== meId));
  for (const m of members || []) {
    const w = m.prefs?.transport?.with;
    if (m.id !== meId && Array.isArray(w) && w.includes(meId)) out.add(m.id);
  }
  return [...out];
}

export function WithPicker({ members, meId, value, onChange, label = '🤝 מגיעים יחד עם מישהו?' }) {
  const others = (members || []).filter((m) => m.id !== meId);
  if (others.length < 2) return null;                                 // nobody to choose between
  const set = new Set(value);
  const toggle = (id) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };
  return html`<div class="arrive-with" data-testid="arrive-with">
    <span class="field__label">${label}</span>
    <div class="me-chips" role="group" aria-label="מי מגיע איתי">
      ${others.map((m) => html`<${Chip} key=${m.id} active=${set.has(m.id)} data-with=${m.id} onClick=${() => toggle(m.id)}>${displayName(m)}</${Chip}>`)}
    </div>
  </div>`;
}
