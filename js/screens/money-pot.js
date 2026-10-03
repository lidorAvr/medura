// The shared cash pot (SPEC §8.7a) and the dual-currency display (§8.7b) of the money screen.
// Pot: a contribution is an ordinary payment to the keeper (payments.pot), an expense paid out of it is the keeper's
// (expenses.from_pot) — every number comes from logic.js potModel(); balances/tripPlan need nothing new.
// Dual currency: "≈ €12" next to a ₪ amount at the rate of that transaction's day (fx.js; no rate → ₪ only).
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { actions } from '../store.js?v=9252f89';
import { displayName, formatMoney, potModel, potSettings } from '../lib/logic.js?v=9252f89';
import {
  CURRENCIES, dayOf, expenseInForeign, foreignCurrencies, formatForeign, fxModeOf, fxModes, inForeign, knownRate,
  loadFxMode, prefetchRates, rateOn, saveFxMode, symbolOf, toShekels,
} from '../lib/fx.js?v=9252f89';
import { Avatar, Button, Card, Chip, Field, MemberPicker, MoneyInput, Pill, ProgressBar, Segmented, ShareButton, Sheet, TextInput, confirmDialog } from '../ui/components.js?v=9252f89';

const cx = (...a) => a.filter(Boolean).join(' ');
const YOU = 'את/ה';
const MAX_AMOUNT = 100000;

function Money({ value, class: klass, ...rest }) {
  return html`<bdi class=${cx('num', klass)} dir="ltr" ...${rest}>${formatMoney(Number(value) || 0)}</bdi>`;
}

// ---------------------------------------------------------------------------
// dual-currency display
// ---------------------------------------------------------------------------

/**
 * The money header's currency mode (₪ · ₪+€ · ₪+lei…, remembered on this device) and the rates it needs: the rate of
 * every transaction's own day (an expense typed in that currency needs none — its own sum is exact). `fx.tag(ils, day,
 * expense?)` is the small "≈ €12" next to a ₪ amount, or null while there's no rate (₪ only, quietly).
 */
export function useFx(snap) {
  const trip = snap?.trip || null;
  const [stored, setStored] = useState(loadFxMode);
  const [, bump] = useState(0);
  const modes = trip ? fxModes(trip) : ['ILS'];
  const mode = trip ? fxModeOf(trip, stored) : 'ILS';
  const code = mode === 'ILS' ? null : mode;
  const expenses = snap?.expenses;
  const payments = snap?.payments;

  useEffect(() => {
    if (!code) return undefined;
    let alive = true;
    const days = new Set(['']);                                         // '' = today's (latest) — the settle-up and the pot
    for (const e of expenses || []) if (!(e.currency === code && Number(e.orig_amount) > 0)) days.add(dayOf(e.spent_on) || '');
    for (const p of payments || []) days.add(dayOf(p.created_at) || '');
    const todo = [...days].filter((d) => knownRate(code, d) === undefined).slice(0, 40);
    if (!todo.length) return undefined;
    prefetchRates(code, todo).then(() => { if (alive) bump((n) => n + 1); });
    return () => { alive = false; };
  }, [code, expenses, payments]);

  const tag = (ils, ymd = null, expense = null) => {
    if (!code) return null;
    const rate = knownRate(code, ymd || '') ?? null;
    const v = expense ? expenseInForeign(expense, code, rate) : inForeign(ils, rate);
    return v == null ? null : html`<span class="fx num" dir="ltr" data-testid="fx-amount">${formatForeign(v, code)}</span>`;
  };
  return {
    code, mode, modes, tag,
    set: (m) => { saveFxMode(m); setStored(m); },
  };
}

/** The compact ₪ · ₪+€ switch of the money header (only when the trip has a foreign currency). */
export function FxToggle({ fx }) {
  if (fx.modes.length < 2) return null;
  return html`<div class="money-fx" data-testid="fx-toggle">
    <${Segmented} label="הצגת סכומים" value=${fx.mode} onChange=${fx.set}
      options=${fx.modes.map((m) => ({ value: m, label: m === 'ILS' ? '₪' : `₪+${symbolOf(m)}` }))} />
  </div>`;
}

/** Today's rate of a currency (₪ per unit): null until it arrives, or when it can't be had. */
function useRate(code) {
  const [rate, setRate] = useState(() => (code && code !== 'ILS' ? knownRate(code, '') ?? null : 1));
  useEffect(() => {
    if (!code || code === 'ILS') { setRate(1); return undefined; }
    let alive = true;
    rateOn(code).then((v) => { if (alive) setRate(v || null); });
    return () => { alive = false; };
  }, [code]);
  return rate;
}

// ---------------------------------------------------------------------------
// the card
// ---------------------------------------------------------------------------

const amountFx = (ils, code, rate) => (code && code !== 'ILS' && rate ? formatForeign(inForeign(ils, rate), code) : null);

/** "🪙 קופה משותפת" — who holds it, collected / spent / left, who put in what, and the buttons for my role. */
export function PotCard({ snap, me, admin, over, busyId, onConfirm, onSpend }) {
  const cfg = potSettings(snap);
  const rate = useRate(cfg?.currency);
  const [put, setPut] = useState({ open: false, seq: 0 });
  const [setup, setSetup] = useState({ open: false, seq: 0 });
  if (!cfg) return null;
  const pot = potModel(snap, { rate: cfg.currency === 'ILS' ? 1 : rate, meId: me.id });
  const iAmKeeper = pot.keeperId === me.id;
  const sym = symbolOf(pot.currency);
  const keeperName = iAmKeeper ? YOU : displayName(pot.keeper);
  const waiting = snap.payments.filter((p) => p.pot === true && p.status !== 'confirmed' && p.to_member === me.id);
  const byId = new Map(snap.members.map((m) => [m.id, m]));
  const askText = [
    `🪙 קופה משותפת ל${snap.trip.emoji || ''} ${snap.trip.name}`.trim(),
    pot.perPerson ? `מבקשים להפקיד ${pot.perPerson.toLocaleString('en-US')} ${sym} (מזומן) אצל ${displayName(pot.keeper)}.` : `מבקשים להפקיד כסף (מזומן) אצל ${displayName(pot.keeper)}.`,
    pot.note || null,
    'אחרי שמפקידים — לסמן ״שמתי לקופה״ במדורה 🙏',
  ].filter(Boolean).join('\n');
  const stat = (label, ils, fxLine, testid, tone) => html`<div class=${cx('pot-stat', tone && `pot-stat--${tone}`)}>
    <span class="pot-stat__label tiny muted">${label}</span>
    <${Money} value=${ils} class="pot-stat__num" data-testid=${testid} />
    ${fxLine ? html`<span class="fx num tiny" dir="ltr" data-testid=${`${testid}-fx`}>${fxLine}</span>` : null}
  </div>`;

  return html`<section class="money-anchor" id="money-pot" aria-labelledby="money-pot-title" data-testid="pot-card">
    <${Card} class="money-pot">
      <div class="card__head">
        <span class="card__emoji" aria-hidden="true">🪙</span>
        <h2 class="card__title" id="money-pot-title">קופה משותפת</h2>
        <${Pill} tone="accent">אצל ${keeperName}</${Pill}>
        ${admin && !over
          ? html`<button type="button" class="link pot-edit" aria-label="עריכת הקופה" data-testid="pot-edit" onClick=${() => setSetup((s) => ({ open: true, seq: s.seq + 1 }))}>✏️</button>`
          : null}
      </div>
      ${pot.note ? html`<p class="small muted pot-note">${pot.note}</p>` : null}
      <div class="pot-stats" data-testid="pot-stats">
        ${stat('נאסף', pot.collected, amountFx(pot.collected, pot.currency, rate), 'pot-collected')}
        ${stat('הוצא', pot.spent, amountFx(pot.spent, pot.currency, rate), 'pot-spent')}
        ${stat('נשאר', pot.left, amountFx(pot.left, pot.currency, rate), 'pot-left', 'left')}
      </div>
      ${pot.pending > 0 ? html`<p class="tiny muted pot-pending" data-testid="pot-pending">מתוכם <${Money} value=${pot.pending} /> מחכים לאישור של ${keeperName}</p>` : null}

      ${pot.rows.length
        ? html`<ul class="pot-rows" data-testid="pot-rows">
            ${pot.rows.map((r) => {
              const all = r.put + r.pending;
              return html`<li key=${r.member_id} class=${cx('pot-row', r.member_id === me.id && 'is-me')} data-testid="pot-row" data-member-id=${r.member_id}>
                <${Avatar} member=${r.member} size=${26} />
                <span class="pot-row__name truncate">${r.member_id === me.id ? YOU : displayName(r.member)}</span>
                ${r.pct !== null && pot.perPerson
                  ? html`<span class="pot-row__bar"><${ProgressBar} value=${r.pct} tone=${r.pct >= 100 ? 'success' : 'primary'} label=${`הפקדה של ${displayName(r.member)}`} /></span>`
                  : html`<span class="pot-row__bar"></span>`}
                <span class="pot-row__amt">
                  <${Money} value=${all} />${r.pending > 0 ? html` <span class="tiny muted" title="מחכה לאישור">⏳</span>` : null}
                  ${amountFx(all, pot.currency, rate) ? html`<span class="fx num tiny" dir="ltr">${amountFx(all, pot.currency, rate)}</span>` : null}
                </span>
              </li>`;
            })}
          </ul>`
        : null}

      ${iAmKeeper && waiting.length
        ? html`<ul class="pot-wait" data-testid="pot-waiting">
            ${waiting.map((p) => html`<li key=${p.id} class="pot-wait__row">
              <span>${displayName(byId.get(p.from_member))} · <${Money} value=${p.amount} /></span>
              <${Button} size="sm" icon="check" loading=${busyId === p.id} onClick=${() => onConfirm(p)} data-testid="pot-confirm">קיבלתי</${Button}>
            </li>`)}
          </ul>`
        : null}

      ${over
        ? null
        : html`<div class="pot-actions">
            ${iAmKeeper
              ? html`<${Button} variant="primary" icon="plus" onClick=${onSpend} data-testid="pot-spend">הוצאה מהקופה</${Button}>`
              : html`<${Button} variant="primary" onClick=${() => setPut((s) => ({ open: true, seq: s.seq + 1 }))} data-testid="pot-put">שמתי לקופה 🪙</${Button}>`}
            ${iAmKeeper || admin
              ? html`<${ShareButton} text=${askText} label="בקשת הפקדה" size="sm" variant="ghost" />`
              : null}
          </div>`}
    </${Card}>

    <${PotPutSheet} key=${`put-${put.seq}`} open=${put.open} snap=${snap} me=${me} pot=${pot} rate=${rate} onClose=${() => setPut((s) => ({ ...s, open: false }))} />
    <${PotSetupSheet} key=${`setup-${setup.seq}`} open=${setup.open} snap=${snap} cfg=${cfg} rows=${pot.count + pot.spentCount > 0}
      onClose=${() => setSetup((s) => ({ ...s, open: false }))} />
  </section>`;
}

/** The admin's way in when the trip has no pot yet: a quiet link that opens the same setup sheet. */
export function PotSetupLink({ snap }) {
  const [s, setS] = useState({ open: false, seq: 0 });
  return html`<button type="button" class="link money-pot-link" data-testid="pot-setup-link" onClick=${() => setS((x) => ({ open: true, seq: x.seq + 1 }))}>🪙 הקמת קופה משותפת ‹</button>
    <${PotSetupSheet} key=${`setup-${s.seq}`} open=${s.open} snap=${snap} cfg=${null} rows=${false} onClose=${() => setS((x) => ({ ...x, open: false }))} />`;
}

// ---------------------------------------------------------------------------
// "שמתי לקופה"
// ---------------------------------------------------------------------------

function PotPutSheet({ open, snap, me, pot, rate, onClose }) {
  const foreign = pot.currency !== 'ILS';
  const [cur, setCur] = useState(foreign ? pot.currency : 'ILS');
  const left = pot.perPerson ? Math.max(0, pot.perPerson - (rate && foreign ? (pot.myPut + pot.myPending) / rate : pot.myPut + pot.myPending)) : null;
  const [amount, setAmount] = useState(left > 0 ? Math.round(left * 100) / 100 : null);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const inPot = cur === pot.currency && foreign;
  const ils = inPot ? (amount > 0 && rate ? toShekels(amount, rate) : null) : amount;

  const save = async () => {
    if (saving) return;
    if (!(amount > 0)) return setErr('כמה שמתם בקופה?');
    if (inPot && !rate) return setErr('אין שער כרגע — אפשר להקליד בשקלים');
    if (!(ils > 0) || ils > MAX_AMOUNT) return setErr('עד ₪100,000');
    setErr(null);
    setSaving(true);
    const note = inPot ? `${symbolOf(pot.currency)}${amount} · שער ${Math.round(rate * 10000) / 10000}` : null;
    const res = await actions.run((api) => api.addPayment(snap.trip.id, {
      to_member: pot.keeperId, amount: ils, method: 'cash', note, pot: true,
    }), { success: 'סימנו שהכסף בקופה 🪙 — ממתין לאישור של מי שמחזיק אותה' });
    setSaving(false);
    if (res !== undefined) onClose();
  };
  const footer = html`
    <${Button} variant="secondary" onClick=${onClose} disabled=${saving}>ביטול</${Button}>
    <${Button} variant="primary" loading=${saving} onClick=${save} data-testid="pot-put-save">שמתי ✓</${Button}>`;
  return html`<${Sheet} open=${open} onClose=${onClose} title="שמתי לקופה 🪙" footer=${footer} class="money-sheet">
    <form class="stack-lg money-form" onSubmit=${(e) => { e.preventDefault(); save(); }} novalidate>
      <p class="small muted">מזומן ל${displayName(pot.keeper)}, שמחזיק/ה את הקופה. ${pot.perPerson ? `הסכום המבוקש: ${pot.perPerson.toLocaleString('en-US')} ${symbolOf(pot.currency)}.` : ''}</p>
      ${foreign
        ? html`<div class="money-cur" role="group" aria-label="מטבע" data-testid="pot-currency">
            ${[pot.currency, 'ILS'].map((c) => html`<${Chip} key=${c} active=${cur === c} onClick=${() => { setCur(c); setErr(null); }}>${symbolOf(c)} ${c === 'ILS' ? 'שקל' : CURRENCIES.find((x) => x.code === c)?.label || c}</${Chip}>`)}
          </div>`
        : null}
      <${Field} label="כמה?" error=${err}>
        <${MoneyInput} symbol=${symbolOf(cur)} value=${amount} onChange=${(v) => { setAmount(v); setErr(null); }} />
      </${Field}>
      ${inPot && ils ? html`<p class="small muted num" dir="ltr">= <${Money} value=${ils} /> · ${symbolOf(pot.currency)}1 = ₪${Math.round(rate * 10000) / 10000}</p>` : null}
      ${inPot && !rate ? html`<p class="small muted">מביאים את השער… (או להקליד בשקלים)</p>` : null}
    </form>
  </${Sheet}>`;
}

// ---------------------------------------------------------------------------
// setup (admin)
// ---------------------------------------------------------------------------

function PotSetupSheet({ open, snap, cfg, rows, onClose }) {
  const me = snap.me?.member_id;
  const offered = [...new Set(['EUR', 'RON', 'ILS', ...foreignCurrencies(snap.trip)])];
  const [keeper, setKeeper] = useState(cfg?.keeper || me || snap.members[0]?.id || null);
  const [currency, setCurrency] = useState(cfg?.currency || foreignCurrencies(snap.trip)[0] || 'ILS');
  const [per, setPer] = useState(cfg?.per_person ?? null);
  const [note, setNote] = useState(cfg?.note || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const write = async (pot, success) => {
    setSaving(true);
    const res = await actions.run((api) => api.updateTrip(snap.trip.id, {
      settings: { money: { ...(snap.trip.settings?.money || {}), pot } },
    }), { success });
    setSaving(false);
    if (res !== undefined) onClose();
  };
  const save = () => {
    if (saving) return;
    if (!keeper) return setErr('מי מחזיק/ה את הקופה?');
    write({ keeper, currency, per_person: per > 0 ? per : null, note: note.trim() || null }, cfg ? 'הקופה עודכנה 🪙' : 'הקופה נפתחה 🪙');
  };
  const off = async () => {
    const ok = await confirmDialog({ title: 'לסגור את הקופה המשותפת?',
      text: 'ההפקדות וההוצאות שנרשמו נשארות בחשבון — רק הכרטיס נעלם. אפשר לפתוח אותה שוב.', confirmText: 'כן, לסגור', danger: true });
    if (ok) write(null, 'הקופה נסגרה');
  };
  const footer = html`
    <${Button} variant="secondary" onClick=${onClose} disabled=${saving}>ביטול</${Button}>
    <${Button} variant="primary" loading=${saving} onClick=${save} data-testid="pot-save">${cfg ? 'שמירה' : 'פתיחת הקופה'}</${Button}>`;
  return html`<${Sheet} open=${open} onClose=${onClose} title=${cfg ? 'עריכת הקופה 🪙' : 'קופה משותפת 🪙'} footer=${footer} class="money-sheet">
    <form class="stack-lg money-form" onSubmit=${(e) => { e.preventDefault(); save(); }} novalidate>
      <p class="small muted">קופת מזומן קטנה לכולם (מוניות, כניסות, ארוחות). כל אחד מפקיד אצל מי שמחזיק/ה אותה, והיא מוציאה ממנה. בסוף ההתחשבנות מחזירה את מה שנשאר.</p>
      <${Field} label="מי מחזיק/ה את הקופה?" error=${err} hint=${rows ? 'אי אפשר להחליף אחרי שיש הפקדות או הוצאות מהקופה' : null}>
        <${MemberPicker} members=${rows ? snap.members.filter((m) => m.id === keeper) : snap.members} value=${keeper}
          onChange=${(id) => { if (id) { setKeeper(id); setErr(null); } }} label="מי מחזיק/ה את הקופה?" />
      </${Field}>
      <${Field} label="באיזה מטבע?">
        <div class="money-cur" role="group" aria-label="מטבע הקופה" data-testid="pot-setup-currency">
          ${offered.map((c) => html`<${Chip} key=${c} active=${currency === c} onClick=${() => setCurrency(c)}>${symbolOf(c)} ${c === 'ILS' ? 'שקל' : CURRENCIES.find((x) => x.code === c)?.label || c}</${Chip}>`)}
        </div>
      </${Field}>
      <${Field} label="כמה מפקיד כל אחד? (לא חובה)">
        <${MoneyInput} symbol=${symbolOf(currency)} value=${per} onChange=${setPer} />
      </${Field}>
      <${Field} label="הערה (לא חובה)">
        <${TextInput} value=${note} maxLength=${120} placeholder="למשל: למוניות ולכניסות" onInput=${(e) => setNote(e.target.value)} />
      </${Field}>
      ${cfg ? html`<div class="money-form__danger"><${Button} variant="ghost" size="sm" class="money-danger-link" disabled=${saving} onClick=${off} data-testid="pot-off">סגירת הקופה</${Button}></div>` : null}
    </form>
  </${Sheet}>`;
}
