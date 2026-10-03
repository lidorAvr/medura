// "💰 בקשת תשלום / איסוף כסף": ask the others for money (after paying, or to collect before buying) with a due
// date and how you'd like to get it. Each share → "שילמתי" → the requester's "✅ קיבלתי" (a regular payment,
// so balances, "📥 מחכה לך" and the morning reminders follow). Lives on the money screen.
// Money collected before buying stays "בקופה" (out of the settle-up) until the purchase is recorded.
import { html } from 'htm/preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { actions, store } from '../store.js?v=6fb25aa';
import { href } from '../router.js?v=6fb25aa';
import {
  actorName, balanceSettled, balances, displayName, expenseShares, formatMoney, headcountTotal, hebrewCount, moneyPots,
  partyBalances, personPhone, personsOf, titleSimilarity, whatsappChatUrl,
} from '../lib/logic.js?v=6fb25aa';
import {
  Avatar, Button, Card, CopyButton, Field, MemberPicker, MoneyInput, Segmented, Sheet, TextInput, Toggle, confirmDialog,
} from '../ui/components.js?v=6fb25aa';

const cx = (...a) => a.filter(Boolean).join(' ');
const METHOD = { bit: '📱 ביט', paybox: '📦 פייבוקס', bank: '🏦 העברה בנקאית', cash: '💵 מזומן' };
const PAY_AS = { bit: 'bit', paybox: 'paybox', bank: 'transfer', cash: 'cash' };
const dm = (ymd) => (ymd ? `${Number(ymd.slice(8, 10))}.${Number(ymd.slice(5, 7))}` : '');
const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const heads1 = (m) => Math.max(1, Number(m?.headcount) || 1);

/** Per request: its shares with their payment state — a couple that pays each their own part (SPEC §19) also has
 *  `parts` (one per person, same states); the share is done when every part is. */
export function moneyRequestsModel(snap) {
  const pays = new Map((snap.payments || []).map((p) => [p.id, p]));
  const members = new Map((snap.members || []).map((m) => [m.id, m]));
  const stateOf = (pay) => (!pay ? 'owes' : pay.status === 'confirmed' ? 'done' : 'paid');
  return (snap.money_requests || []).map((q) => {
    const shares = (snap.money_request_members || []).filter((x) => x.request_id === q.id).map((x) => {
      const member = members.get(x.member_id);
      const people = member?.people || [];
      const parts = (snap.money_request_parts || []).filter((pt) => pt.request_id === q.id && pt.member_id === x.member_id)
        .sort((a, b) => people.indexOf(a.person) - people.indexOf(b.person))
        .map((pt) => {
          const pay = pt.payment_id ? pays.get(pt.payment_id) : null;
          return { ...pt, payment: pay, state: stateOf(pay) };
        });
      const pay = x.payment_id ? pays.get(x.payment_id) : null;
      const state = parts.length
        ? (parts.every((pt) => pt.state === 'done') ? 'done' : parts.every((pt) => pt.state !== 'owes') ? 'paid' : 'owes')
        : stateOf(pay);
      return { ...x, member, payment: pay, parts, state };
    });
    const by = members.get(q.requested_by);
    return { ...q, by, byName: actorName(by, q.by_person), shares, done: shares.filter((s) => s.state === 'done').length };
  });
}

/** How a member likes to get paid, from their latest request that says so (open first): {bit, paybox, bank, cash} | null. */
export function payMethodsOf(snap, memberId) {
  const reqs = (snap.money_requests || []).filter((q) => q.requested_by === memberId && q.methods
    && (q.methods.bit || q.methods.paybox || q.methods.bank));
  const pick = reqs.filter((q) => q.status === 'open').pop() || reqs.pop();
  return pick ? pick.methods : null;
}

/** Split a total in agorot by headcount among the asked (+ my own part): {shares: Map id→cents, self}. SQL twin:
 *  create_money_request's total mode (agorot to the first ones, the asked before me). */
function splitTotal(total, members, selfHeads) {
  const cents = Math.round(total * 100);
  const all = members.reduce((n, m) => n + heads1(m), 0) + selfHeads;
  if (!all) return { shares: new Map(), self: 0 };
  const base = members.map((m) => Math.floor((cents * heads1(m)) / all));
  let self = Math.floor((cents * selfHeads) / all);
  let left = cents - self - base.reduce((a, b) => a + b, 0);
  self += Math.max(0, left - members.length);
  const shares = new Map(members.map((m, i) => [m.id, base[i] + (left-- > 0 ? 1 : 0)]));
  return { shares, self };
}

/** What the "sent" toast may promise: whoever isn't in the app yet got nothing — say so instead of "to everyone". */
function sentText(asked) {
  const out = asked.filter((m) => m && m.claimed === false);
  if (!out.length) return 'הבקשה נשלחה 💰 מי שהפעיל התראות יקבל אותה עכשיו';
  const names = out.slice(0, 2).map(displayName).join(', ') + (out.length > 2 ? ` ועוד ${out.length - 2}` : '');
  return `הבקשה נשלחה 💰 ${names} עוד לא באפליקציה — כדאי לשלוח ${out.length > 1 ? 'להם' : 'גם'} בוואטסאפ`;
}

export function MoneyRequests({ snap, me, admin }) {
  const [sheet, setSheet] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const all = moneyRequestsModel(snap);
  const open = all.filter((q) => q.status === 'open');
  const closed = all.filter((q) => q.status !== 'open');
  const pots = new Map(moneyPots(snap).map((p) => [p.request.id, p]));
  const row = (q) => html`<${RequestRow} key=${q.id} q=${q} snap=${snap} me=${me} admin=${admin} pot=${pots.get(q.id)} />`;
  // a closed collection still holding money waits for its purchase — keep it in sight
  const potClosed = closed.filter((q) => pots.has(q.id));
  const restClosed = closed.filter((q) => !pots.has(q.id));
  if (!all.length) {
    // nothing asked yet (ux M4): one text link, no card, no paragraph
    return html`<section id="money-requests" class="money-anchor mreq-empty" data-testid="money-requests">
      <button type="button" class="link mreq-empty__link" onClick=${() => setSheet(true)}>💰 בקשת תשלום מראש +</button>
      <${RequestSheet} open=${sheet} snap=${snap} me=${me} onClose=${() => setSheet(false)} />
    </section>`;
  }
  return html`<section id="money-requests" class="money-anchor" data-testid="money-requests">
    <${Card} emoji="💰" title="בקשות תשלום" class="mreq-card"
      action=${html`<${Button} size="sm" variant="ghost" icon="plus" onClick=${() => setSheet(true)}>בקשה</${Button}>`}>
      ${open.length || potClosed.length
        ? html`<ul class="mreq-list">${[...open, ...potClosed].map(row)}</ul>`
        : html`<p class="muted small">אין בקשות פתוחות 🙂</p>`}
      ${restClosed.length
        ? html`<button type="button" class="link mreq-closed" onClick=${() => setShowClosed(!showClosed)}>
            ${showClosed ? 'הסתרת בקשות שנסגרו' : `${hebrewCount(restClosed.length, 'בקשה שנסגרה', 'בקשות שנסגרו')} ▾`}
          </button>
          ${showClosed ? html`<ul class="mreq-list">${restClosed.map(row)}</ul>` : null}`
        : null}
    </${Card}>
    <${RequestSheet} open=${sheet} snap=${snap} me=${me} onClose=${() => setSheet(false)} />
  </section>`;
}

function RequestRow({ q, snap, me, admin, pot }) {
  const [busy, setBusy] = useState(null);
  const [adding, setAdding] = useState(null);
  const share = q.shares.find((s) => s.member_id === me.id);
  // a couple that pays each their own part (§19): what's asked of me is my part (a device that hasn't said who
  // it is: what's still open of the share); the partner's part shows next to it
  const person = (me.people || []).includes(snap.me?.person) ? snap.me.person : null;
  const myPart = share?.parts.length && person ? share.parts.find((pt) => pt.person === person) || null : null;
  const openParts = share?.parts.filter((pt) => pt.state === 'owes') || [];
  const mine = !share ? null : myPart ? { ...share, amount: myPart.amount, state: myPart.state }
    : share.parts.length && openParts.length ? { ...share, amount: openParts.reduce((n, pt) => n + Number(pt.amount), 0), state: 'owes' }
      : share;
  const partners = share?.parts.filter((pt) => pt !== myPart) || [];
  const bals = new Map(balances(snap).map((b) => [b.member_id, b.balance]));
  const pbals = new Map(partyBalances(snap).map((b) => [b.key, b.balance]));
  // a share of an expense is part of the balance: if theirs is even, it was settled another way
  const coveredBySettle = (id, who = null) => Boolean(q.expense_id)
    && balanceSettled((who && pbals.has(`${id}::${who}`) ? pbals.get(`${id}::${who}`) : bals.get(id)) ?? 0);
  const settledElsewhere = coveredBySettle(me.id, myPart ? person : null);
  const iAsked = q.requested_by === me.id;
  const overdue = q.due && q.due < todayYmd() && q.status === 'open';
  const methods = Object.keys(METHOD).filter((k) => q.methods?.[k]);
  const run = async (key, fn, success) => {
    setBusy(key);
    const ok = await actions.run(async (api) => { await fn(api); return true; }, success ? { success } : {});
    setBusy(null);
    return ok;
  };
  const pay = (method) => run('pay', (api) => api.payMoneyRequest(q.id, PAY_AS[method] || 'other'),
    `סימנת ששילמת — ${q.byName} יאשר/תאשר 🙏`);
  const nudge = (s, who = null) => {
    const phone = who ? personPhone(s.member, personsOf(s.member).find((p) => p.name === who) || null) : s.member?.phone;
    return phone ? whatsappChatUrl(phone,
      `היי ${who || displayName(s.member)} 🙂 תזכורת קטנה: ${formatMoney(s.amount)} על "${q.title}"${q.due ? ` עד ${dm(q.due)}` : ''}${q.methods?.bit ? ` — בביט ל-${q.methods.bit}` : ''} 🙏`) : null;
  };
  const collecting = !q.expense_id;
  const collected = q.shares.reduce((n, s) => n + (s.parts.length
    ? s.parts.filter((pt) => pt.state !== 'owes').reduce((m, pt) => m + Number(pt.amount), 0)
    : s.state !== 'owes' ? Number(s.amount) : 0), 0);
  const record = () => run('record', (api) => api.recordMoneyRequestExpense(q.id), 'הקנייה נרשמה כהוצאה 🧾 — הכסף שנאסף נכנס להתחשבנות');
  const close = async () => {
    const paidAny = q.shares.some((s) => s.state !== 'owes' || s.parts.some((pt) => pt.state !== 'owes'));
    if (collecting && paidAny && q.pot !== false) {
      // money collected before buying: close it by recording the purchase (or keep it open for now). Not a
      // collection from before the pot rule (pot === false): its money is already in the settle-up and its
      // purchase may be an expense recorded by hand — that one just closes
      const total = collected + Number(q.self_amount || 0);
      const yes = await confirmDialog({
        title: 'לסגור את האיסוף?',
        text: `נאספו ${formatMoney(collected)}. לרשום עכשיו את הקנייה כהוצאה שלך (${formatMoney(total)})? כך הכסף שנאסף נכנס להתחשבנות. מי שעוד לא שילם יקבל הודעה שאין צורך להעביר.`,
        confirmText: `לרשום הוצאה ${formatMoney(total)}`,
        cancelText: 'עוד לא',
      });
      if (!yes) return;
      if (await run('close', (api) => api.cancelMoneyRequest(q.id), null)) await record();
      return;
    }
    const text = collecting
      ? 'מי שעוד לא שילם יקבל הודעה שאין צורך להעביר.'
      : q.linked_expense
        ? 'ההוצאה עצמה נשארת — מי שעוד לא שילם ממשיך לראות את החלק שלו ב״איך מתחשבנים״.'
        : paidAny
          ? 'מה ששולם נשאר כהוצאה שלך; מי שעוד לא שילם כבר לא יחויב. קיבלת ממישהו במזומן? עדיף לסמן ״💵 קיבלתי במזומן״ לפני הסגירה.'
          : 'ההוצאה שנרשמה מהבקשה תימחק, ואף אחד לא יחויב.';
    const yes = await confirmDialog({ title: 'לסגור את הבקשה?', text, confirmText: 'סגירה' });
    if (yes) run('close', (api) => api.cancelMoneyRequest(q.id), 'הבקשה נסגרה');
  };
  // whoever joined after the request was sent isn't on it — the requester (or an admin) adds them in one tap
  const exemptIds = new Set(Array.isArray(snap.trip?.settings?.money?.exempt) ? snap.trip.settings.money.exempt : []);
  const onIt = new Set(q.shares.map((s) => s.member_id));
  const linkedExp = q.linked_expense ? (snap.expenses || []).find((x) => x.id === q.expense_id) || null : null;
  const linkedShares = linkedExp ? new Map(expenseShares(linkedExp, snap).map((s) => [s.member_id, s.amount])) : null;
  const askedHeads = q.shares.reduce((n, s) => n + heads1(s.member), 0);
  const perHead = askedHeads ? q.shares.reduce((n, s) => n + Number(s.amount), 0) / askedHeads : 0;
  const suggestFor = (m) => (linkedShares ? linkedShares.get(m.id) || 0 : Math.round(perHead * heads1(m) * 100) / 100);
  const newcomers = q.status === 'open' && (iAsked || admin)
    ? (snap.members || []).filter((m) => m.id !== q.requested_by && !onIt.has(m.id)
      && Date.parse(m.created_at) > Date.parse(q.created_at)
      && (linkedShares ? (linkedShares.get(m.id) || 0) > 0 : !exemptIds.has(m.id)))
    : [];
  return html`<li class=${cx('mreq', q.status !== 'open' && 'is-closed')} data-testid="money-request">
    <div class="mreq__head">
      <${Avatar} member=${q.by} size=${38} />
      <div class="mreq__main">
        <b class="mreq__title">${q.title}</b>
        <span class="muted small">${iAsked ? 'הבקשה שלך' : `${q.byName} מבקש/ת`}${q.due ? html` · <span class=${cx(overdue && 'mreq__late')}>${overdue ? '⏰ עבר המועד' : `עד ${dm(q.due)}`}</span>` : ''}</span>
      </div>
      <span class="mreq__progress" title="שילמו ואושרו">${q.done}/${q.shares.length} ✓</span>
    </div>
    ${q.note ? html`<p class="small mreq__note">📝 ${q.note}</p>` : null}
    ${Number(q.self_amount) > 0 && (iAsked || admin)
      ? html`<p class="tiny muted">כולל החלק של ${iAsked ? 'עצמך' : q.byName}: ${formatMoney(q.self_amount)}</p>`
      : null}

    ${pot
      ? html`<div class="mreq__pot" data-testid="mreq-pot">
          <p class="small">💰 בקופה אצל ${iAsked ? 'עצמך' : q.byName}: <b class="num">${formatMoney(pot.collected)}</b> — לא נכנס להתחשבנות עד שרושמים את הקנייה</p>
          ${iAsked || admin
            ? html`<${Button} size="sm" variant="secondary" loading=${busy === 'record'} onClick=${record} data-testid="mreq-record">🧾 רישום הקנייה</${Button}>`
            : null}
        </div>`
      : null}

    ${mine && q.status === 'open'
      ? mine.state === 'owes' && settledElsewhere
        ? html`<p class="mreq__ok small">✅ מאוזן בהתחשבנות — אין מה להעביר כאן</p>`
        : mine.state === 'owes' && q.expense_id
        // a share of a recorded expense is already inside my net (ux M4) — pay it there, once
        ? html`<a class="mreq__ok mreq__incl small" href="#money-settle" data-testid="mreq-included"
            onClick=${(e) => { e.preventDefault(); document.getElementById('money-settle')?.scrollIntoView({ block: 'start' }); }}>כלול בהתחשבנות ✓ ‹</a>`
        : mine.state === 'owes'
        ? html`<div class="mreq__owe" data-testid="mreq-owe">
            <p>עליך <b class="num">${formatMoney(mine.amount)}</b> ל${q.byName}</p>
            ${methods.length
              ? html`<ul class="mreq__methods">${methods.map((k) => html`<li key=${k}>
                  <span>${METHOD[k]}${k !== 'cash' ? html` <bdi dir="ltr" class="num">${q.methods[k]}</bdi>` : ''}</span>
                  ${k !== 'cash' ? html`<${CopyButton} text=${String(q.methods[k]).replace(k === 'bank' ? /$^/ : /[^\d+]/g, '')} size="sm" label="העתקה" />` : null}
                </li>`)}</ul>`
              : null}
            <div class="mreq__pay">
              <span class="small">שילמתי ב־</span>
              ${(methods.length ? methods : ['bit', 'paybox', 'bank', 'cash']).map((k) => html`<${Button} key=${k} size="sm" variant="secondary"
                loading=${busy === 'pay'} onClick=${() => pay(k)}>${METHOD[k]} ✓</${Button}>`)}
            </div>
          </div>`
        : mine.state === 'paid'
          ? html`<p class="mreq__wait small">⏳ סימנת ששילמת — מחכה לאישור של ${q.byName}</p>`
          : html`<p class="mreq__ok small">✅ שולם ואושר</p>`
      : null}
    ${mine && q.status === 'open' && myPart && partners.length
      ? html`<p class="tiny muted mreq__partner" data-testid="mreq-partner">${partners.map((pt) => `${pt.person}: ${pt.state === 'owes' ? `עוד לא (${formatMoney(pt.amount)})` : pt.state === 'paid' ? 'שילם/ה ⏳' : 'שילם/ה ✓'}`).join(' · ')}</p>`
      : null}

    ${iAsked || admin
      ? html`<ul class="mreq__who">${q.shares.flatMap((s) => (s.parts.length
          // a couple that pays each their own part (§19): one line per person
          ? s.parts.map((pt) => ({ s, key: `${s.member_id}:${pt.person}`, who: pt.person, name: pt.person, amount: pt.amount, state: pt.state, payment: pt.payment }))
          : [{ s, key: s.member_id, who: null, name: displayName(s.member), amount: s.amount, state: s.state, payment: s.payment }]))
          .map((r) => {
          const covered = r.state === 'owes' && q.status === 'open' && coveredBySettle(r.s.member_id, r.who);
          const hint = nudge({ ...r.s, amount: r.amount }, r.who);
          // paid through the settle-up: one net transfer (smaller than the share) stands for it
          const net = r.payment && Boolean(q.expense_id) && Number(r.payment.amount) + 1 < Number(r.amount);
          return html`<li key=${r.key} class=${`is-${r.state}`} data-testid="mreq-share" data-state=${covered ? 'covered' : r.state} data-person=${r.who || undefined}>
          <span class="mreq__who-name">${r.state === 'done' || covered ? '✅' : r.state === 'paid' ? '⏳' : '▫️'} ${r.name}</span>
          <span class="num small mreq__who-amt">${formatMoney(r.amount)}</span>
          ${net ? html`<span class="mreq__covered tiny" data-testid="mreq-net">בהתחשבנות · העברה של ${formatMoney(r.payment.amount)}</span>` : null}
          ${r.state === 'paid' && iAsked
            ? html`<${Button} size="sm" loading=${busy === r.key} onClick=${() => run(r.key, (api) => api.confirmPayment(r.payment.id), `אישרת שקיבלת מ${r.name} ✅`)}>קיבלתי ✓</${Button}>`
            : covered
              ? html`<span class="mreq__covered tiny" data-testid="mreq-covered">מכוסה בהתחשבנות ✓</span>`
              : r.state === 'owes' && q.status === 'open'
                ? html`<span class="mreq__who-acts">
                    ${iAsked
                      ? html`<${Button} size="sm" variant="ghost" loading=${busy === `cash:${r.key}`}
                          onClick=${() => run(`cash:${r.key}`, (api) => api.settleMoneyRequestShare(q.id, r.s.member_id, r.who), `סומן ששילם/ה במזומן ✅`)}>💵 קיבלתי במזומן</${Button}>`
                      : null}
                    ${hint ? html`<${Button} size="sm" variant="ghost" href=${hint} target="_blank" rel="noopener noreferrer">💬 תזכורת</${Button}>` : null}
                  </span>`
                : null}
        </li>`;
        })}</ul>
        ${newcomers.length
          ? html`<ul class="mreq__joined" data-testid="mreq-late">${newcomers.map((m) => html`<li key=${m.id}>
              <span class="small">🆕 ${displayName(m)} — הצטרפ/ה אחרי הבקשה</span>
              <${Button} size="sm" variant="secondary" onClick=${() => setAdding(m)}>הוספה לבקשה</${Button}>
            </li>`)}</ul>`
          : null}
        ${q.status === 'open' && (iAsked || admin) ? html`<${Button} size="sm" variant="ghost" loading=${busy === 'close'} onClick=${close}>סגירת הבקשה</${Button}>` : null}`
      : null}
    <${AddToRequestSheet} q=${q} member=${adding} suggested=${adding ? suggestFor(adding) : 0} fixed=${Boolean(linkedShares)}
      onClose=${() => setAdding(null)} />
  </li>`;
}

/** "להוסיף לבקשה": the amount the others were asked (editable) — or, for a recorded expense, their part of it. */
function AddToRequestSheet({ q, member, suggested, fixed, onClose }) {
  const [amount, setAmount] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useLayoutEffect(() => {
    if (!member) return;
    setAmount(suggested > 0 ? suggested : null); setBusy(false); setError(null);
  }, [member?.id]);
  const name = member ? displayName(member) : '';
  const submit = async (ev) => {
    ev?.preventDefault();
    if (!fixed && !(amount > 0)) return setError('כמה?');
    setBusy(true);
    const ok = await actions.run(async (api) => { await api.addMoneyRequestMember(q.id, member.id, fixed ? null : amount); return true; },
      { success: `${name} נוסף/ה לבקשה וקיבל/ה הודעה 💰` });
    setBusy(false);
    if (ok) onClose();
    return undefined;
  };
  return html`<${Sheet} open=${Boolean(member)} onClose=${onClose} title="הוספה לבקשה"
    footer=${html`<${Button} type="submit" form=${`mreq-add-${q.id}`} icon="check" loading=${busy}>הוספה</${Button}>
      <${Button} variant="secondary" onClick=${onClose}>ביטול</${Button}>`}>
    <form id=${`mreq-add-${q.id}`} class="stack" onSubmit=${submit} noValidate data-testid="mreq-add">
      <p>${name} יתבקש/ו להעביר ל${q.byName} על ״${q.title}״:</p>
      ${fixed
        ? html`<p class="mreq-split small"><b class="num">${formatMoney(suggested)}</b> — החלק שלו/ה בהוצאה, כפי שהיא מתחלקת עכשיו. גם החלקים של האחרים מתעדכנים.</p>`
        : html`<${Field} label="כמה?" hint="כמו שהתבקשו האחרים (לפי ראשים) — אפשר לשנות">
            <${MoneyInput} value=${amount} onChange=${(v) => { setAmount(v); setError(null); }} />
          </${Field}>`}
      ${error ? html`<p class="field__error" role="alert">${error}</p>` : null}
    </form>
  </${Sheet}>`;
}

function RequestSheet({ open, snap, me, onClose }) {
  const others = (snap.members || []).filter((m) => m.id !== me.id);
  const exempt = new Set(Array.isArray(snap.trip?.settings?.money?.exempt) ? snap.trip.settings.money.exempt : []);
  const iAmExempt = exempt.has(me.id);
  // expenses I paid that nobody is being asked for right now — a request can ask for their shares
  const asked = new Set((snap.money_requests || []).filter((q) => q.status === 'open' && q.expense_id).map((q) => q.expense_id));
  const myExpenses = (snap.expenses || []).filter((e) => e.paid_by === me.id && !asked.has(e.id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 8);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState('per_person');
  const [amount, setAmount] = useState(null);
  const [expId, setExpId] = useState(null);
  const [who, setWho] = useState([]);
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  const [m, setM] = useState({ bit: '', paybox: '', bank: '', cash: false });
  // null = not answered yet. Never guessed: "כבר שילמתי" records an expense, so a wrong default counts the
  // purchase twice once it's recorded for real (testers 2026-10-02)
  const [paid, setPaid] = useState(null);
  const [withMe, setWithMe] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    setTitle(''); setMode('per_person'); setAmount(null); setExpId(null); setPaid(null); setWithMe(!iAmExempt);
    setWho(others.filter((x) => !exempt.has(x.id)).map((x) => x.id)); setDue(''); setNote(''); setError(null); setBusy(false);
    setM({ bit: me.phone || '', paybox: '', bank: '', cash: false });
    // how I like to get paid, saved once in my profile
    store.get().api.myAccount?.().then((acc) => {
      const p = acc?.prefs?.pay;
      if (p) setM({ bit: p.bit || me.phone || '', paybox: p.paybox || '', bank: p.bank || '', cash: Boolean(p.cash) });
    }).catch(() => {});
  }, [open]);

  const exp = mode === 'expense' ? myExpenses.find((e) => e.id === expId) || null : null;
  const expShares = exp ? new Map(expenseShares(exp, snap).map((s) => [s.member_id, s.amount])) : null;
  const pickable = exp ? others.filter((x) => (expShares.get(x.id) || 0) > 0) : others;
  const chosen = pickable.filter((x) => who.includes(x.id));
  const heads = headcountTotal(chosen);
  const selfHeads = mode === 'total' && withMe ? heads1(me) : 0;
  const split = mode === 'total' && amount > 0 ? splitTotal(amount, chosen, selfHeads) : null;
  const askedSum = exp ? chosen.reduce((n, x) => n + (expShares.get(x.id) || 0), 0) : null;
  const exemptOut = others.filter((x) => exempt.has(x.id) && !who.includes(x.id));
  // "כבר שילמתי" on a title I already recorded as an expense → it would count twice
  const twin = mode !== 'expense' && paid !== false && title.trim().length > 1
    ? myExpenses.find((e) => titleSimilarity(title, e.title)) : null;

  const useExpense = (e) => {
    if (!e) return;
    setMode('expense'); setExpId(e.id); if (!title.trim()) setTitle(e.title);
    const shares = new Map(expenseShares(e, snap).map((s) => [s.member_id, s.amount]));
    setWho(others.filter((x) => (shares.get(x.id) || 0) > 0).map((x) => x.id));
    setError(null);
  };
  const pickMode = (v) => {
    if (v === 'expense') {
      useExpense(myExpenses.find((e) => e.id === expId) || myExpenses[0]);
      return;
    }
    if (mode === 'expense') setWho(others.filter((x) => !exempt.has(x.id)).map((x) => x.id));
    setMode(v);
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (!title.trim()) return setError('על מה? (למשל: מקדמה לווילה)');
    if (mode === 'expense' ? !exp : !(amount > 0)) return setError(mode === 'expense' ? 'על איזו הוצאה?' : 'כמה?');
    if (!chosen.length) return setError('ממי מבקשים?');
    if (mode !== 'expense' && paid === null) return setError('כבר שילמת על זה, או שאוספים לפני הקנייה? בוחרים אחת למעלה');
    setBusy(true);
    const methods = { bit: m.bit.trim(), paybox: m.paybox.trim(), bank: m.bank.trim(), cash: m.cash };
    const body = { title: title.trim(), note: note.trim() || null, due: due || null, members: chosen.map((x) => x.id), methods };
    if (mode === 'expense') body.expense = exp.id;
    else Object.assign(body, { [mode]: amount, already_paid: paid }, mode === 'total' ? { include_me: withMe } : {});
    const res = await actions.run(async (api) => {
      const id = await api.createMoneyRequest(snap.trip.id, body);
      api.saveAccount?.({ prefs: { pay: methods } }).catch(() => {});           // remembered for next time
      return id;
    }, { success: sentText(chosen) });
    setBusy(false);
    if (res) onClose();
    return undefined;
  };

  const modes = [{ value: 'per_person', label: '👤 סכום לאדם' }, { value: 'total', label: '🧮 סכום כולל' }];
  if (myExpenses.length) modes.push({ value: 'expense', label: '🧾 הוצאה קיימת' });

  return html`<${Sheet} open=${open} onClose=${onClose} title="💰 בקשת תשלום"
    footer=${html`<${Button} type="submit" form="mreq-form" icon="check" loading=${busy}>שליחת הבקשה</${Button}>
      <${Button} variant="secondary" onClick=${onClose}>ביטול</${Button}>`}>
    <form id="mreq-form" class="stack" onSubmit=${submit} noValidate>
      <${Field} label="על מה?"><${TextInput} value=${title} maxlength="80" placeholder="מקדמה לווילה / מתנה / כרטיסים" onInput=${(e) => { setTitle(e.target.value); setError(null); }} /></${Field}>
      <${Segmented} label="איך מחשבים" value=${mode} onChange=${pickMode} options=${modes} />
      ${mode === 'expense'
        ? html`<div class="stack" data-testid="mreq-expenses">
            <${Segmented} label="איזו הוצאה?" value=${expId} onChange=${(id) => useExpense(myExpenses.find((x) => x.id === id))}
              options=${myExpenses.map((x) => ({ value: x.id, label: `${x.title} · ${formatMoney(x.amount)}` }))} />
            <p class="tiny muted">כל אחד מתבקש בדיוק את החלק שלו בהוצאה — בלי לרשום אותה שוב.</p>
          </div>`
        : html`<${Field} label=${mode === 'per_person' ? 'כמה לאדם? (זוג משלם כפול)' : 'כמה בסך הכול?'}>
            <${MoneyInput} value=${amount} onChange=${(v) => { setAmount(v); setError(null); }} />
          </${Field}>`}
      ${mode === 'total'
        ? html`<${Toggle} checked=${withMe} onChange=${setWithMe} label="גם אני משתתף/ת בעלות"
            hint=${withMe ? 'הסכום מתחלק גם עליך — מבקשים מהאחרים רק את החלק שלהם' : 'הסכום כולו מתחלק רק בין מי שמבקשים ממנו'} />`
        : null}
      ${mode === 'total' && split && heads
        ? html`<p class="mreq-split small" data-testid="mreq-split">סה״כ ${formatMoney(amount)} · החלק שלך ${formatMoney(split.self / 100)} · מבקשים ${formatMoney((Math.round(amount * 100) - split.self) / 100)}
            <span class="muted"> (בערך ${formatMoney(amount / (heads + selfHeads))} לאדם · ${hebrewCount(heads + selfHeads, 'איש', 'אנשים')})</span></p>`
        : mode === 'per_person' && amount > 0 && heads
          ? html`<p class="small muted" data-testid="mreq-split">סך הכול ${formatMoney(amount * heads)} מ־${hebrewCount(heads, 'איש', 'אנשים')}</p>`
          : exp && chosen.length
            ? html`<p class="mreq-split small" data-testid="mreq-split">סה״כ ${formatMoney(exp.amount)} · מבקשים ${formatMoney(askedSum)} מ־${hebrewCount(chosen.length, 'פרופיל', 'פרופילים')}</p>`
            : null}
      ${mode !== 'expense'
        ? html`<${Field} label="כבר שילמת על זה?" class="mreq-paid"
            hint=${paid === null ? 'בוחרים אחת — כך נדע אם לרשום את זה כהוצאה עכשיו, או לחכות לקנייה'
              : paid ? 'נרשם עכשיו כהוצאה שלך — וכשמשלמים לך, החשבון מתאזן. לא רושמים אותה שוב ב״הוצאה חדשה״'
                : 'איסוף לפני קנייה: הכסף נשאר ״בקופה״ (מחוץ להתחשבנות) עד שרושמים את הקנייה — מכאן, מהבקשה'}>
            <${Segmented} label="כבר שילמת על זה?" value=${paid === null ? null : paid ? 'yes' : 'no'}
              onChange=${(v) => { setPaid(v === 'yes'); setError(null); }}
              options=${[{ value: 'yes', label: '✅ כן, שילמתי' }, { value: 'no', label: '🛒 עוד לא' }]} />
          </${Field}>`
        : null}
      ${twin
        ? html`<div class="mreq-warn small" role="note" data-testid="mreq-twin">
            <span>כבר רשמת את ״${twin.title}״ (${formatMoney(twin.amount)}) כהוצאה — בקשה עם ״כבר שילמתי״ תרשום אותה פעם שנייה.</span>
            <${Button} size="sm" variant="secondary" onClick=${() => useExpense(twin)}>לבקש על ההוצאה הקיימת</${Button}>
          </div>`
        : null}
      <${Field} label="ממי?">
        ${pickable.length
          ? html`<${MemberPicker} members=${pickable} value=${who} onChange=${setWho} multi label="ממי מבקשים?" />
            ${exemptOut.length && mode !== 'expense'
              ? html`<p class="tiny muted" data-testid="mreq-exempt">🎁 פטורים — לא סומנו: ${exemptOut.map(displayName).join(', ')} (אפשר להוסיף ידנית)</p>`
              : null}`
          : html`<div class="mreq-nobody" data-testid="mreq-nobody">
              <p class="small">עוד אין בטיול אף אחד חוץ ממך 🙂 קודם מזמינים את החבר׳ה (או מוסיפים להם פרופילים) — ואז מבקשים.</p>
              <${Button} size="sm" variant="secondary" href=${href(`/t/${snap.trip.id}/people`)} onClick=${onClose}>👥 למסך החבר׳ה</${Button}>
            </div>`}
      </${Field}>
      <${Field} label="עד מתי? (לא חובה)" hint="כולל תזכורת עדינה בבוקר למי שעוד לא שילם"><${TextInput} type="date" value=${due} onInput=${(e) => setDue(e.target.value)} /></${Field}>
      <details class="mreq-form__how" data-testid="mreq-methods">
        <summary class="mreq-form__how-row">
          <span>איך נוח לך לקבל?</span>
          <span class="muted small">${[m.bit.trim() && `ביט ${m.bit.trim()}`, m.paybox.trim() && 'פייבוקס', m.bank.trim() && 'בנק', m.cash && 'מזומן'].filter(Boolean).join(' · ') || 'לבחור'} ✎</span>
        </summary>
        <div class="mreq-form__methods">
          <${Field} label="📱 ביט (טלפון)"><${TextInput} type="tel" dir="ltr" value=${m.bit} maxlength="20" placeholder="050-1234567" onInput=${(e) => setM({ ...m, bit: e.target.value })} /></${Field}>
          <${Field} label="📦 פייבוקס (טלפון / קישור)"><${TextInput} dir="ltr" value=${m.paybox} maxlength="160" onInput=${(e) => setM({ ...m, paybox: e.target.value })} /></${Field}>
          <${Field} label="🏦 העברה בנקאית (בנק, סניף, חשבון, שם)"><${TextInput} value=${m.bank} maxlength="160" placeholder="לאומי 10 · סניף 123 · חשבון 456789" onInput=${(e) => setM({ ...m, bank: e.target.value })} /></${Field}>
          <${Toggle} checked=${m.cash} onChange=${(v) => setM({ ...m, cash: v })} label="💵 אפשר גם במזומן" />
        </div>
      </details>
      <${Field} label="הערה (לא חובה)"><${TextInput} value=${note} maxlength="200" onInput=${(e) => setNote(e.target.value)} /></${Field}>
      ${error ? html`<p class="field__error" role="alert">${error}</p>` : null}
    </form>
  </${Sheet}>`;
}
