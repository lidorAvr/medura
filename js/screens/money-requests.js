// "💰 בקשת תשלום / איסוף כסף": ask the others for money (after paying, or to collect before buying) with a due
// date and how you'd like to get it. Each share → "שילמתי" → the requester's "✅ קיבלתי" (a regular payment,
// so balances, "📥 מחכה לך" and the morning reminders follow). Lives on the money screen.
import { html } from 'htm/preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { actions, store } from '../store.js?v=d288b77';
import { balances, displayName, formatMoney, headcountTotal, hebrewCount, whatsappChatUrl } from '../lib/logic.js?v=d288b77';
import {
  Avatar, Button, Card, Chip, CopyButton, Field, MemberPicker, MoneyInput, Segmented, Sheet, TextInput, Toggle, confirmDialog,
} from '../ui/components.js?v=d288b77';

const cx = (...a) => a.filter(Boolean).join(' ');
const METHOD = { bit: '📱 ביט', paybox: '📦 פייבוקס', bank: '🏦 העברה בנקאית', cash: '💵 מזומן' };
const PAY_AS = { bit: 'bit', paybox: 'paybox', bank: 'transfer', cash: 'cash' };
const dm = (ymd) => (ymd ? `${Number(ymd.slice(8, 10))}.${Number(ymd.slice(5, 7))}` : '');
const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

/** Per request: its shares with their payment state. */
export function moneyRequestsModel(snap) {
  const pays = new Map((snap.payments || []).map((p) => [p.id, p]));
  const members = new Map((snap.members || []).map((m) => [m.id, m]));
  return (snap.money_requests || []).map((q) => {
    const shares = (snap.money_request_members || []).filter((x) => x.request_id === q.id).map((x) => {
      const pay = x.payment_id ? pays.get(x.payment_id) : null;
      return { ...x, member: members.get(x.member_id), payment: pay, state: !pay ? 'owes' : pay.status === 'confirmed' ? 'done' : 'paid' };
    });
    return { ...q, by: members.get(q.requested_by), shares, done: shares.filter((s) => s.state === 'done').length };
  });
}

export function MoneyRequests({ snap, me, admin }) {
  const [sheet, setSheet] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const all = moneyRequestsModel(snap);
  const open = all.filter((q) => q.status === 'open');
  const closed = all.filter((q) => q.status !== 'open');
  return html`<section id="money-requests" class="money-anchor" data-testid="money-requests">
    <${Card} emoji="💰" title="בקשות תשלום" class="mreq-card"
      action=${html`<${Button} size="sm" variant="secondary" icon="plus" onClick=${() => setSheet(true)}>בקשה</${Button}>`}>
      ${open.length
        ? html`<ul class="mreq-list">${open.map((q) => html`<${RequestRow} key=${q.id} q=${q} snap=${snap} me=${me} admin=${admin} />`)}</ul>`
        : html`<p class="muted small">שילמת על משהו לכולם, או רוצים לאסוף כסף לפני שקונים? מבקשים כאן — כל אחד רואה כמה, למי ועד מתי, ומקבל תזכורת עדינה.</p>`}
      ${closed.length
        ? html`<button type="button" class="link mreq-closed" onClick=${() => setShowClosed(!showClosed)}>
            ${showClosed ? 'הסתרת בקשות שנסגרו' : `${hebrewCount(closed.length, 'בקשה שנסגרה', 'בקשות שנסגרו')} ▾`}
          </button>
          ${showClosed ? html`<ul class="mreq-list">${closed.map((q) => html`<${RequestRow} key=${q.id} q=${q} snap=${snap} me=${me} admin=${admin} />`)}</ul>` : null}`
        : null}
    </${Card}>
    <${RequestSheet} open=${sheet} snap=${snap} me=${me} onClose=${() => setSheet(false)} />
  </section>`;
}

function RequestRow({ q, snap, me, admin }) {
  const [busy, setBusy] = useState(null);
  const mine = q.shares.find((s) => s.member_id === me.id);
  // an "already paid" share is part of the balance: if mine is even, it was settled another way
  const settledElsewhere = Boolean(q.expense_id) && (balances(snap).find((b) => b.member_id === me.id)?.balance ?? 0) >= -1;
  const iAsked = q.requested_by === me.id;
  const overdue = q.due && q.due < todayYmd() && q.status === 'open';
  const methods = Object.keys(METHOD).filter((k) => q.methods?.[k]);
  const run = async (key, fn, success) => {
    setBusy(key);
    await actions.run(async (api) => { await fn(api); return true; }, { success });
    setBusy(null);
  };
  const pay = (method) => run('pay', (api) => api.payMoneyRequest(q.id, PAY_AS[method] || 'other'),
    `סימנת ששילמת — ${displayName(q.by)} יאשר/תאשר 🙏`);
  const nudge = (s) => (s.member?.phone ? whatsappChatUrl(s.member.phone,
    `היי ${displayName(s.member)} 🙂 תזכורת קטנה: ${formatMoney(s.amount)} על "${q.title}"${q.due ? ` עד ${dm(q.due)}` : ''}${q.methods?.bit ? ` — בביט ל-${q.methods.bit}` : ''} 🙏`) : null);
  const close = async () => {
    const paidAny = q.shares.some((s) => s.state !== 'owes');
    const text = !q.expense_id
      ? 'מי שעוד לא שילם יקבל הודעה שאין צורך להעביר.'
      : paidAny
        ? 'מה ששולם נשאר כהוצאה שלך; מי שעוד לא שילם כבר לא יחויב. קיבלת ממישהו במזומן? עדיף לסמן ״💵 קיבלתי במזומן״ לפני הסגירה.'
        : 'ההוצאה שנרשמה מהבקשה תימחק, ואף אחד לא יחויב.';
    const yes = await confirmDialog({ title: 'לסגור את הבקשה?', text, confirmText: 'סגירה' });
    if (yes) run('close', (api) => api.cancelMoneyRequest(q.id), 'הבקשה נסגרה');
  };
  return html`<li class=${cx('mreq', q.status !== 'open' && 'is-closed')} data-testid="money-request">
    <div class="mreq__head">
      <${Avatar} member=${q.by} size=${38} />
      <div class="mreq__main">
        <b class="mreq__title">${q.title}</b>
        <span class="muted small">${iAsked ? 'הבקשה שלך' : `${displayName(q.by)} מבקש/ת`}${q.due ? html` · <span class=${cx(overdue && 'mreq__late')}>${overdue ? '⏰ עבר המועד' : `עד ${dm(q.due)}`}</span>` : ''}</span>
      </div>
      <span class="mreq__progress" title="שילמו ואושרו">${q.done}/${q.shares.length} ✓</span>
    </div>
    ${q.note ? html`<p class="small mreq__note">📝 ${q.note}</p>` : null}

    ${mine && q.status === 'open'
      ? mine.state === 'owes' && settledElsewhere
        ? html`<p class="mreq__ok small">✅ מאוזן בהתחשבנות — אין מה להעביר כאן</p>`
        : mine.state === 'owes'
        ? html`<div class="mreq__owe" data-testid="mreq-owe">
            <p>עליך <b class="num">${formatMoney(mine.amount)}</b> ל${displayName(q.by)}</p>
            ${methods.length
              ? html`<ul class="mreq__methods">${methods.map((k) => html`<li key=${k}>
                  <span>${METHOD[k]}${k !== 'cash' ? html` <bdi dir="ltr" class="num">${q.methods[k]}</bdi>` : ''}</span>
                  ${k !== 'cash' ? html`<${CopyButton} text=${String(q.methods[k]).replace(k === 'bank' ? /$^/ : /[^\d+]/g, '')} size="sm" label="העתקה" />` : null}
                </li>`)}</ul>`
              : null}
            <div class="mreq__pay">
              <span class="small">שילמתי ב־</span>
              ${(methods.length ? methods : ['bit', 'paybox', 'bank', 'cash']).map((k) => html`<${Button} key=${k} size="sm"
                loading=${busy === 'pay'} onClick=${() => pay(k)}>${METHOD[k]} ✓</${Button}>`)}
            </div>
          </div>`
        : mine.state === 'paid'
          ? html`<p class="mreq__wait small">⏳ סימנת ששילמת — מחכה לאישור של ${displayName(q.by)}</p>`
          : html`<p class="mreq__ok small">✅ שולם ואושר</p>`
      : null}

    ${iAsked || admin
      ? html`<ul class="mreq__who">${q.shares.map((s) => html`<li key=${s.member_id} class=${`is-${s.state}`}>
          <span class="mreq__who-name">${s.state === 'done' ? '✅' : s.state === 'paid' ? '⏳' : '▫️'} ${displayName(s.member)}</span>
          <span class="num small">${formatMoney(s.amount)}</span>
          ${s.state === 'paid' && iAsked
            ? html`<${Button} size="sm" loading=${busy === s.member_id} onClick=${() => run(s.member_id, (api) => api.confirmPayment(s.payment.id), `אישרת שקיבלת מ${displayName(s.member)} ✅`)}>קיבלתי ✓</${Button}>`
            : s.state === 'owes' && q.status === 'open'
              ? html`<span class="mreq__who-acts">
                  <${Button} size="sm" variant="ghost" loading=${busy === `cash:${s.member_id}`}
                    onClick=${() => run(`cash:${s.member_id}`, (api) => api.settleMoneyRequestShare(q.id, s.member_id), `סומן ששילם/ה במזומן ✅`)}>💵 קיבלתי במזומן</${Button}>
                  ${nudge(s) ? html`<${Button} size="sm" variant="ghost" href=${nudge(s)} target="_blank" rel="noopener noreferrer">💬 תזכורת</${Button}>` : null}
                </span>`
              : null}
        </li>`)}</ul>
        ${q.status === 'open' && (iAsked || admin) ? html`<${Button} size="sm" variant="ghost" loading=${busy === 'close'} onClick=${close}>סגירת הבקשה</${Button}>` : null}`
      : null}
  </li>`;
}

function RequestSheet({ open, snap, me, onClose }) {
  const others = (snap.members || []).filter((m) => m.id !== me.id);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState('per_person');
  const [amount, setAmount] = useState(null);
  const [who, setWho] = useState([]);
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  const [m, setM] = useState({ bit: '', paybox: '', bank: '', cash: false });
  const [paid, setPaid] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    setTitle(''); setMode('per_person'); setAmount(null); setPaid(true); setWho(others.map((x) => x.id)); setDue(''); setNote(''); setError(null); setBusy(false);
    setM({ bit: me.phone || '', paybox: '', bank: '', cash: false });
    // how I like to get paid, saved once in my profile
    store.get().api.myAccount?.().then((acc) => {
      const p = acc?.prefs?.pay;
      if (p) setM({ bit: p.bit || me.phone || '', paybox: p.paybox || '', bank: p.bank || '', cash: Boolean(p.cash) });
    }).catch(() => {});
  }, [open]);

  const heads = headcountTotal(others.filter((x) => who.includes(x.id)));
  const submit = async (e) => {
    e?.preventDefault();
    if (!title.trim()) return setError('על מה? (למשל: מקדמה לווילה)');
    if (!(amount > 0)) return setError('כמה?');
    if (!who.length) return setError('ממי מבקשים?');
    setBusy(true);
    const methods = { bit: m.bit.trim(), paybox: m.paybox.trim(), bank: m.bank.trim(), cash: m.cash };
    const res = await actions.run(async (api) => {
      const id = await api.createMoneyRequest(snap.trip.id, {
        title: title.trim(), note: note.trim() || null, due: due || null, members: who, methods, [mode]: amount, already_paid: paid,
      });
      api.saveAccount?.({ prefs: { pay: methods } }).catch(() => {});           // remembered for next time
      return id;
    }, { success: 'הבקשה נשלחה לכולם 💰 בפוש ובמייל' });
    setBusy(false);
    if (res) onClose();
    return undefined;
  };

  return html`<${Sheet} open=${open} onClose=${onClose} title="💰 בקשת תשלום"
    footer=${html`<${Button} type="submit" form="mreq-form" icon="check" loading=${busy}>שליחת הבקשה</${Button}>
      <${Button} variant="secondary" onClick=${onClose}>ביטול</${Button}>`}>
    <form id="mreq-form" class="stack" onSubmit=${submit} noValidate>
      <${Field} label="על מה?"><${TextInput} value=${title} maxlength="80" placeholder="מקדמה לווילה / מתנה / כרטיסים" onInput=${(e) => { setTitle(e.target.value); setError(null); }} /></${Field}>
      <${Segmented} label="איך מחשבים" value=${mode} onChange=${setMode}
        options=${[{ value: 'per_person', label: '👤 סכום לאדם' }, { value: 'total', label: '🧮 סכום כולל (מתחלק)' }]} />
      <${Field} label=${mode === 'per_person' ? 'כמה לאדם? (זוג משלם כפול)' : 'כמה בסך הכול?'}>
        <${MoneyInput} value=${amount} onChange=${(v) => { setAmount(v); setError(null); }} />
      </${Field}>
      ${amount > 0 && heads
        ? html`<p class="small muted">${mode === 'per_person'
          ? `סך הכול ${formatMoney(amount * heads)} מ־${hebrewCount(heads, 'איש', 'אנשים')}`
          : `בערך ${formatMoney(amount / heads)} לאדם (${hebrewCount(heads, 'איש', 'אנשים')})`}</p>`
        : null}
      <${Toggle} checked=${paid} onChange=${setPaid} label="כבר שילמתי על זה"
        hint=${paid ? 'נרשם כהוצאה שלך — וכשמשלמים לך, החשבון מתאזן' : 'איסוף לפני קנייה: אחרי שקונים, רושמים את הקנייה כהוצאה'} />
      <${Field} label="ממי?"><${MemberPicker} members=${others} value=${who} onChange=${setWho} multi label="ממי מבקשים?" /></${Field}>
      <${Field} label="עד מתי? (לא חובה)" hint="כולל תזכורת עדינה בבוקר למי שעוד לא שילם"><${TextInput} type="date" value=${due} onInput=${(e) => setDue(e.target.value)} /></${Field}>
      <p class="field__label">איך נוח לך לקבל?</p>
      <div class="mreq-form__methods">
        <${Field} label="📱 ביט (טלפון)"><${TextInput} type="tel" dir="ltr" value=${m.bit} maxlength="20" placeholder="050-1234567" onInput=${(e) => setM({ ...m, bit: e.target.value })} /></${Field}>
        <${Field} label="📦 פייבוקס (טלפון / קישור)"><${TextInput} dir="ltr" value=${m.paybox} maxlength="160" onInput=${(e) => setM({ ...m, paybox: e.target.value })} /></${Field}>
        <${Field} label="🏦 העברה בנקאית (בנק, סניף, חשבון, שם)"><${TextInput} value=${m.bank} maxlength="160" placeholder="לאומי 10 · סניף 123 · חשבון 456789" onInput=${(e) => setM({ ...m, bank: e.target.value })} /></${Field}>
        <${Toggle} checked=${m.cash} onChange=${(v) => setM({ ...m, cash: v })} label="💵 אפשר גם במזומן" />
      </div>
      <${Field} label="הערה (לא חובה)"><${TextInput} value=${note} maxlength="200" onInput=${(e) => setNote(e.target.value)} /></${Field}>
      ${error ? html`<p class="field__error" role="alert">${error}</p>` : null}
    </form>
  </${Sheet}>`;
}
