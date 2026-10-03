// Couples & families inside one profile (SPEC §19): the profile's own two choices — how it settles money
// (prefs.pay) and how it brings "כל אחד מביא" items (prefs.bring). Only the profile's own people change them
// (the server refuses anyone else, admins included). Used by the "💑 הזוג שלנו" card (me.js) and the
// shortcut on the settle-up card (money.js).
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { actions } from '../store.js?v=8a35ae3';
import { Button, Card, Segmented, confirmDialog } from './components.js?v=8a35ae3';

const names = (m) => (m?.people || []).filter(Boolean);

/** The profile is a couple / family (2+ people). */
export const isGroupProfile = (m) => (Number(m?.headcount) || 1) >= 2 || names(m).length >= 2;

export const PAY_OPTIONS = [
  { value: 'together', label: '💑 משלמים ביחד' },
  { value: 'each', label: '🙋 כל אחד את החלק שלו' },
];
export const BRING_OPTIONS = [
  { value: 'together', label: '💑 מביאים ביחד' },
  { value: 'each', label: '🙋 כל אחד את שלו' },
];
const HINT = {
  pay: { together: 'העברה אחת בשם שניכם', each: 'כל אחד רואה ומעביר את החלק שלו' },
  bring: { together: 'פריט זוגי — מסמנים פעם אחת', each: 'מתחלקים: כל אחד מסמן את שלו' },
};
const SAVED = {
  pay: { together: 'מעכשיו העברה אחת לשניכם 💑', each: 'מעכשיו כל אחד רואה ומעביר את החלק שלו 🙋' },
  bring: { together: 'מעכשיו מביאים ביחד 💑', each: 'מעכשיו כל אחד מביא ומסמן את שלו 🙋' },
};

export const prefOf = (m, key) => (m?.prefs?.[key] === 'each' ? 'each' : 'together');

/** Saves one of the two choices; switching money once there is money recorded asks first. Resolves true when saved. */
export async function chooseCouple(snap, me, key, value) {
  if (prefOf(me, key) === value) return false;
  const money = (snap?.expenses || []).length || (snap?.payments || []).length || (snap?.money_requests || []).length;
  if (key === 'pay' && money) {
    const ok = await confirmDialog({
      title: value === 'each' ? 'כל אחד את החלק שלו?' : 'משלמים ביחד?',
      text: 'זה משנה רק את החלוקה ביניכם — הסכום של הזוג לא משתנה.',
      confirmText: 'כן, לשנות',
    });
    if (!ok) return false;
  }
  const res = await actions.run(async (api) => { await api.updateMember(me.id, { prefs: { [key]: value } }); return true; },
    { success: SAVED[key][value] });
  return res === true;
}

/** "💑 הזוג שלנו": the two choices, one line of hint each. Only for a profile of 2+ people. */
export function CoupleCard({ snap, me, onEdit }) {
  const [busy, setBusy] = useState(null);
  if (!isGroupProfile(me)) return null;
  const family = (Number(me.headcount) || 1) > 2 || names(me).length > 2;
  const title = family ? 'המשפחה שלנו' : 'הזוג שלנו';
  const emoji = family ? '👨‍👩‍👧' : '💑';
  const people = names(me);
  if (people.length < 2) {
    return html`<${Card} emoji=${emoji} title=${title} class="me-couple" data-testid="couple-card">
      <p class="small muted" data-testid="couple-need-names">כדי לבחור — הוסיפו את השם של ${family ? 'כל אחד מכם' : 'בן/בת הזוג'}</p>
      ${onEdit ? html`<${Button} variant="secondary" size="sm" icon="edit" onClick=${onEdit}>עריכה</${Button}>` : null}
    </${Card}>`;
  }
  const set = async (key, value) => {
    setBusy(key);
    await chooseCouple(snap, me, key, value);
    setBusy(null);
  };
  const row = (key, label, options) => {
    const value = prefOf(me, key);
    return html`<div class="me-couple__row" data-testid=${`couple-${key}`} aria-busy=${busy === key ? 'true' : undefined}>
      <span class="me-couple__label">${label}</span>
      <${Segmented} label=${label} value=${value} onChange=${(v) => set(key, v)} options=${options} class="me-couple__seg" />
      <span class="tiny muted me-couple__hint">${HINT[key][value]}</span>
    </div>`;
  };
  return html`<${Card} emoji=${emoji} title=${title} class="me-couple" data-testid="couple-card"
    action=${html`<span class="small muted me-couple__people">${people.join(' · ')}</span>`}>
    ${row('pay', '💸 כסף', PAY_OPTIONS)}
    ${row('bring', '🎒 ״כל אחד מביא״', BRING_OPTIONS)}
  </${Card}>`;
}
