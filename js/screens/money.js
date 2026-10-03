// Money (SPEC §8.7): my balance, "who pays whom", payments, expenses, per-member table,
// plus the new/edit expense sheet and the "I paid / I got it" payment sheet.
// Every number comes from logic.js (balances, settlePlan, expenseShares, tripTotals).
import { html } from 'htm/preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { actions, store, useTrip } from '../store.js?v=9252f89';
import { href, navigate } from '../router.js?v=9252f89';
import {
  balances, buildSummaryText, displayName, expenseShares, formatDate, formatMoney, headcountTotal, hebrewCount,
  memberNets, membersById, openMoneyRequests, partyBalances, partyName, partyOf, payingMembers, personPhone, personsOf, potSettings,
  settleNets, splitsMoney, timeAgo, titleSimilarity, tripPlan, tripTotals, whatsappChatUrl, whatsappShareUrl,
} from '../lib/logic.js?v=9252f89';
import {
  Avatar, Button, Card, Chip, CopyButton, EmptyState, Fab, Field, Fold, MemberPicker, MoneyInput, OverBanner, Pill,
  ProgressBar, Segmented, ShareButton, Sheet, Skeleton, TextInput, Toggle, confirmDialog, fireConfetti, tripOver,
} from '../ui/components.js?v=9252f89';
import { Icon } from '../ui/icons.js?v=9252f89';
import { CURRENCIES, dayOf, rateOn, symbolOf, toShekels } from '../lib/fx.js?v=9252f89';
import { MoneyRequests, payMethodsOf } from './money-requests.js?v=9252f89';
import { FxToggle, PotCard, PotSetupLink, useFx } from './money-pot.js?v=9252f89';
import { expenseTagsFor } from '../lib/templates.js?v=9252f89';
import { PAY_OPTIONS, chooseCouple, prefOf } from '../ui/couple.js?v=9252f89';

const cx = (...a) => a.filter(Boolean).join(' ');

/** Under ₪1 counts as settled — settlePlan drops transfers under ₪1 too. Every "how much" on this screen is the
 *  plan's own whole-shekel number (settleNets), so the header always equals the transfers under it. */
const EVEN_BELOW = 1;
const MAX_AMOUNT = 100000;
const PAYMENTS_PREVIEW = 5;
const YOU = 'את/ה';

const METHODS = [
  { value: 'bit', label: 'ביט', emoji: '📱' },
  { value: 'paybox', label: 'פייבוקס', emoji: '📲' },
  { value: 'cash', label: 'מזומן', emoji: '💵' },
  { value: 'transfer', label: 'העברה בנקאית', emoji: '🏦' },
  { value: 'other', label: 'אחר', emoji: '✨' },
];
const methodOf = (value) => METHODS.find((m) => m.value === value) || METHODS[METHODS.length - 1];

/**
 * The trip's expense tags ([{e, n}]) when it has its own (settings.money.tags — seeded from the sub-type, design
 * §2.4); null ⇒ the older trips keep today's category chips.
 */
export function tripTags(trip) {
  const own = trip?.settings?.money?.tags;
  if (!Array.isArray(own) || !own.length) return null;
  const tags = expenseTagsFor(trip);
  return tags.length ? tags : null;
}
/** A stored tag name → {e, n} (a tag since removed from the trip still shows, with a generic emoji). */
const tagOf = (tags, name) => (name ? (tags || []).find((t) => t.n === name) || { e: '🏷️', n: name } : null);

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Today in Israel as 'YYYY-MM-DD' (what `spent_on` stores). */
const todayYmd = () => ymdFmt.format(new Date());

function shiftYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 'היום' / 'אתמול' / '26 בספט׳' for a spent_on date. */
function dayLabel(ymd) {
  if (!ymd || typeof ymd !== 'string') return '';
  const day = ymd.slice(0, 10);
  const today = todayYmd();
  if (day === today) return 'היום';
  if (day === shiftYmd(today, -1)) return 'אתמול';
  return formatDate(`${day}T12:00:00Z`, { day: 'numeric', month: 'short' });
}

/** Israeli mobile → '050-123-4567' for display; anything else as typed. */
function prettyPhone(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (/^05\d{8}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return raw;
}
const copyablePhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return /^05\d{8}$/.test(digits) ? digits : String(phone || '').trim();
};

const moneyError = (amount) => {
  if (amount === null || amount === undefined || !(amount > 0)) return 'הקלידו סכום 🙂';
  if (amount > MAX_AMOUNT) return 'עד ₪100,000 להוצאה';
  return null;
};

/** A shekel amount that keeps its sign on the right side in RTL text. */
function Money({ value, signed = false, class: klass, ...rest }) {
  const n = Number(value) || 0;
  const text = signed && n >= 0.005 ? `+${formatMoney(n)}` : formatMoney(n);
  return html`<bdi class=${cx('num', klass)} dir="ltr" ...${rest}>${text}</bdi>`;
}

/** Animates a number from its previous value (0 on mount) to `target`. */
function useCountUp(target, ms = 650) {
  const [shown, setShown] = useState(() => (reducedMotion() ? target : 0));
  const prev = useRef(null);
  useEffect(() => {
    const from = prev.current ?? 0;
    prev.current = target;
    if (reducedMotion() || from === target) {
      setShown(target);
      return undefined;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const eased = 1 - (1 - k) ** 3;
      setShown(k >= 1 ? target : Math.round(from + (target - from) * eased));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}

/** Sheet state that survives the close animation; `seq` remounts the form on every open. */
function useSheetState() {
  const [state, setState] = useState({ open: false, data: null, seq: 0 });
  return [
    state,
    (data) => setState((s) => ({ open: true, data, seq: s.seq + 1 })),
    () => setState((s) => ({ ...s, open: false })),
  ];
}

function scrollToId(id) {
  const el = document.getElementById(id);
  const fold = el?.closest('details');            // a trip that's over keeps its sections folded: open the one asked for
  if (fold) fold.open = true;
  el?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

export default function MoneyScreen({ route }) {
  const { snap, me, isAdmin: admin } = useTrip();
  const tripId = route.params.tripId;
  const ready = !!(snap && me && snap.trip?.id === tripId);

  const [expenseSheet, openExpense, closeExpense] = useSheetState();
  const [paySheet, openPay, closePay] = useSheetState();
  const [flashId, setFlashId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const flashTimer = useRef(0);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const fx = useFx(snap);                                // ₪ + a foreign currency at each day's rate (SPEC §8.7b)

  const model = useMemo(() => {
    if (!ready) return null;
    const bals = balances(snap);
    // who settles (SPEC §19): a couple that pays each their own part settles per person — its rows are keyed
    // `${member_id}::${person}`; with nobody splitting this is exactly balances() / settlePlan(balances)
    const pbals = partyBalances(snap);
    const person = snap.me?.person || null;
    const split = splitsMoney(me) && Boolean(person) && (me.people || []).includes(person);
    const myKey = split ? `${me.id}::${person}` : me.id;
    const plan = tripPlan(snap);
    return {
      bals,
      pbals,
      myKey,
      plan,
      nets: settleNets(plan),
      mnets: memberNets(snap, plan),
      totals: tripTotals(snap),
      byId: membersById(snap.members),
      mine: pbals.find((b) => b.key === myKey) || bals.find((b) => b.member_id === me.id) || null,
      ours: split ? bals.find((b) => b.member_id === me.id) || null : null,
      balById: new Map(bals.map((b) => [b.member_id, b])),
    };
  }, [ready, snap, me?.id]);

  // Deep link: #/t/<id>/money?new=1 opens the new-expense sheet.
  useEffect(() => {
    if (ready && route.query.new === '1') {
      openExpense({});
      navigate(`/t/${tripId}/money`, { replace: true });
    }
  }, [ready, route.query.new]);

  // Deep link: #/t/<id>/money?show=requests ("לתשלום" on a request, from the home inbox) lands on the requests —
  // the amount that was just read — not on the hero's net, which is another number (testers 2026-10-02).
  useEffect(() => {
    if (!ready || route.query.show !== 'requests') return;
    requestAnimationFrame(() => scrollToId('money-requests'));
    navigate(`/t/${tripId}/money`, { replace: true });
  }, [ready, route.query.show]);

  // Deep link: #/t/<id>/money?pay=me (the home "✓ שילמתי") opens "I paid" for my (first) transfer in the plan.
  useEffect(() => {
    if (!ready || !model || route.query.pay !== 'me') return;
    const t = model.plan.find((x) => x.from === model.myKey || partyOf(x.from).member_id === me.id);
    if (t) openPay({ kind: 'paid', from: t.from, to: t.to, amount: t.amount });
    navigate(`/t/${tripId}/money`, { replace: true });
  }, [ready, route.query.pay]);

  // Someone else deleted the expense whose sheet is open → close it gently.
  // (My own delete closes the sheet itself; `selfDeleted` keeps it from double-toasting.)
  const selfDeleted = useRef(null);
  const openExpId = expenseSheet.open ? expenseSheet.data?.expense?.id || null : null;
  const expGone = !!(ready && openExpId && !snap.expenses.some((e) => e.id === openExpId));
  useEffect(() => {
    if (!expGone) return;
    closeExpense();
    if (selfDeleted.current !== openExpId) actions.toast('ההוצאה הזו נמחקה בינתיים 🙂', 'info');
  }, [expGone]);

  if (!ready || !model) return html`<${MoneySkeleton} />`;
  const over = tripOver(snap.trip);

  const { bals, pbals, myKey, plan, nets, mnets, totals, byId, mine, ours, balById } = model;
  // a settle-up party (a profile, or one person of a couple that pays each their own part)
  const nameOf = (key) => (key === myKey || key === me.id ? YOU : partyName(snap, key));
  // mine: my own line — or, on a device that hasn't said who it is, any line of my profile
  const isMine = (key) => key === myKey || (myKey === me.id && partyOf(key).member_id === me.id);
  // a payment's side: the person when that profile pays each their own part
  const sideKey = (memberId, person) => (person && splitsMoney(byId.get(memberId)) ? `${memberId}::${person}` : memberId);
  const active = snap.expenses.length > 0 || snap.payments.length > 0;
  // my one number: what my transfers in the plan add up to (whole shekels; + = I get, − = I pay)
  const netOf = (p) => p.reduce((n, t) => n + (isMine(t.to) ? t.amount : 0) - (isMine(t.from) ? t.amount : 0), 0);
  const myNet = netOf(plan);

  const onExpenseSaved = (id) => {
    if (!id) return;
    clearTimeout(flashTimer.current);
    setFlashId(id);
    requestAnimationFrame(() => {
      document.querySelector(`[data-expense-id="${id}"]`)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    });
    flashTimer.current = setTimeout(() => setFlashId(null), 2200);
  };

  // A payment that settles my own debt deserves a little party.
  const onPaymentSaved = () => {
    const after = store.get().snap;
    if (!after || after.trip?.id !== tripId) return;
    if (myNet <= -EVEN_BELOW && Math.abs(netOf(tripPlan(after))) < EVEN_BELOW) fireConfetti();
  };

  const confirmPayment = async (p) => {
    setBusyId(p.id);
    await actions.run((api) => api.confirmPayment(p.id), {
      success: p.to_member === me.id ? 'מעולה — סימנת שהכסף הגיע ✅' : 'ההעברה אושרה ✅',
    });
    setBusyId(null);
  };

  const deletePayment = async (p) => {
    const ok = await confirmDialog({
      title: 'למחוק את ההעברה?',
      text: `${nameOf(sideKey(p.from_member, p.from_person))} ← ${nameOf(sideKey(p.to_member, p.to_person))} · ${formatMoney(p.amount)}. ההתחשבנות תחושב מחדש.`,
      confirmText: 'כן, למחוק',
      danger: true,
    });
    if (!ok) return;
    setBusyId(p.id);
    await actions.run((api) => api.deletePayment(p.id), { success: 'ההעברה נמחקה' });
    setBusyId(null);
  };

  const waitingForMe = snap.payments.filter((p) => p.status !== 'confirmed' && p.from_member !== me.id && (p.to_member === me.id || admin)).length;
  const payments = snap.payments.length
    ? html`<${PaymentsSection}
        snap=${snap}
        me=${me}
        admin=${admin}
        byId=${byId}
        nameOf=${nameOf}
        sideKey=${sideKey}
        busyId=${busyId}
        onConfirm=${confirmPayment}
        onDelete=${deletePayment}
        bare=${over}
        fx=${fx}
      />`
    : null;
  const expenses = html`<${ExpensesSection}
    snap=${snap}
    me=${me}
    byId=${byId}
    totals=${totals}
    flashId=${flashId}
    onOpen=${(expense) => openExpense({ expense })}
    onAdd=${active ? () => openExpense({}) : null}
    onQuick=${over ? null : (tag) => openExpense({ tag })}
    bare=${over}
    fx=${fx}
  />`;
  const table = active ? html`<${MembersTable} snap=${snap} me=${me} balById=${balById} pbals=${pbals} myKey=${myKey} nets=${nets} mnets=${mnets} />` : null;
  // open = something is still to pay or to confirm (a share the settle-up covered isn't)
  const openReqs = openMoneyRequests(snap).length;

  // order (ux M1): hero → who pays whom (my row first) → requests → transfers → expenses → the table.
  // Once the trip is over (A2): the same, folded to one row each, no FAB.
  return html`<div class="screen money">
    <${OverBanner} trip=${snap.trip} text="סוגרים חשבון" />
    <${FxToggle} fx=${fx} />
    ${potSettings(snap)
      ? html`<${PotCard} snap=${snap} me=${me} admin=${admin} over=${over} busyId=${busyId} onConfirm=${confirmPayment}
          onSpend=${() => openExpense({ fromPot: true })} />`
      : null}
    <${Hero}
      snap=${snap}
      me=${me}
      mine=${mine}
      net=${myNet}
      oursNet=${ours ? mnets.get(me.id) || 0 : null}
      totals=${totals}
      plan=${plan}
      isMine=${isMine}
      nameOf=${nameOf}
      active=${active}
      over=${over}
      onAdd=${() => openExpense({})}
      onQuick=${over ? null : (tag) => openExpense({ tag })}
    />

    <${LateJoinNote} snap=${snap} me=${me} byId=${byId} />

    ${active
      ? html`<${SettleCard}
          snap=${snap}
          me=${me}
          admin=${admin}
          plan=${plan}
          bals=${bals}
          byId=${byId}
          nameOf=${nameOf}
          isMine=${isMine}
          onPay=${openPay}
          over=${over}
          fx=${fx}
        />`
      : null}

    ${over
      ? html`
        ${active ? html`<${Fold} emoji="🧾" title="הוצאות" count=${snap.expenses.length} meta=${html`<${Money} value=${totals.spent} />`} data-testid="fold-expenses">${expenses}</${Fold}>` : null}
        ${payments ? html`<${Fold} emoji="💳" title="העברות" count=${snap.payments.length} open=${waitingForMe > 0} data-testid="fold-payments">${payments}</${Fold}>` : null}
        ${(snap.money_requests || []).length
          ? html`<${Fold} emoji="💰" title="בקשות" count=${openReqs ? (openReqs === 1 ? 'אחת פתוחה' : `${openReqs} פתוחות`) : (snap.money_requests || []).length} data-testid="fold-requests">
              <${MoneyRequests} snap=${snap} me=${me} admin=${admin} />
            </${Fold}>`
          : null}
        ${table ? html`<${Fold} emoji="⚖️" title="מאזן לפי חבר׳ה" count=${snap.members.length} data-testid="fold-table">${table}</${Fold}>` : null}
        <button type="button" class="link money-forgot" data-testid="money-forgot" onClick=${() => openExpense({})}>שכחנו הוצאה? + הוספה</button>`
      : html`
        <${MoneyRequests} snap=${snap} me=${me} admin=${admin} />
        ${payments}
        ${active || snap.expenses.length ? expenses : null}
        ${table ? html`<${Fold} emoji="⚖️" title="מאזן לפי חבר׳ה" count=${snap.members.length} data-testid="fold-table">${table}</${Fold}>` : null}`}

    ${admin
      ? html`<a class="money-settings small" href=${href(`/t/${tripId}/trip?edit=1&section=money`)} data-testid="money-settings">⚙️ מטבעות · פטורים ‹</a>
        ${!over && !potSettings(snap) ? html`<${PotSetupLink} snap=${snap} />` : null}`
      : null}

    ${!over && active ? html`<${Fab} icon="🧾" label="הוצאה חדשה" onClick=${() => openExpense({})} />` : null}

    <${ExpenseSheet}
      key=${`exp-${expenseSheet.seq}`}
      open=${expenseSheet.open}
      data=${expenseSheet.data}
      snap=${snap}
      me=${me}
      admin=${admin}
      onClose=${closeExpense}
      onSaved=${onExpenseSaved}
      onDeleting=${(id) => { selfDeleted.current = id; }}
    />
    <${PaymentSheet}
      key=${`pay-${paySheet.seq}`}
      open=${paySheet.open}
      data=${paySheet.data}
      snap=${snap}
      me=${me}
      byId=${byId}
      myKey=${myKey}
      nameOf=${nameOf}
      onClose=${closePay}
      onSaved=${onPaymentSaved}
    />
  </div>`;
}

function MoneySkeleton() {
  return html`<div class="screen money" aria-busy="true">
    <div class="money-hero money-hero--loading" role="status" aria-label="טוען את הכסף…">
      <span class="money-skel money-skel--sm"></span>
      <span class="money-skel money-skel--lg"></span>
      <span class="money-skel money-skel--md"></span>
      <div class="money-hero__stats">
        <span class="money-skel money-skel--tile"></span>
        <span class="money-skel money-skel--tile"></span>
        <span class="money-skel money-skel--tile"></span>
      </div>
    </div>
    <${Skeleton} lines=${4} />
    <${Skeleton} lines=${5} />
  </div>`;
}

// ---------------------------------------------------------------------------
// hero: my balance + trip totals
// ---------------------------------------------------------------------------

const HOW_STEPS = [
  ['🧾', 'מי שקונה משהו לטיול — רושם/ת כאן הוצאה'],
  ['👫', 'החשבון מתחלק אוטומטית לפי ראשים: זוג = 2 חלקים'],
  ['🤝', 'בסוף רואים מי מעביר למי, ומסמנים ״שילמתי ✓״'],
];

function Hero({ snap, me, mine, net = 0, oursNet = null, totals, plan, isMine, nameOf, active, onAdd, onQuick = null, over = false }) {
  // the plan's own number (whole shekels) — the same one the transfers below add up to
  const state = !active ? 'empty' : net >= EVEN_BELOW ? 'credit' : net <= -EVEN_BELOW ? 'debt' : 'even';
  const animated = useCountUp(Math.abs(net));

  if (state === 'empty') {
    // one card (ux M7): what this is, three steps as text, one button
    return html`<section class="money-hero money-hero--empty" data-testid="money-hero" data-state="empty" aria-labelledby="money-hero-title">
      <span class="money-hero__art" aria-hidden="true">🧾</span>
      <div class="money-hero__kicker">💸 הקופה של הטיול</div>
      <h1 class="money-hero__title" id="money-hero-title">עוד לא נרשמו הוצאות</h1>
      <p class="money-hero__how-title">איך זה עובד?</p>
      <ol class="money-how money-how--hero">
        ${HOW_STEPS.map(([emoji, text]) => html`<li class="money-how__step"><span aria-hidden="true">${emoji}</span><span>${text}</span></li>`)}
      </ol>
      <div class="money-hero__cta">
        <${Button} variant="primary" icon="plus" onClick=${onAdd}>הוספת הוצאה ראשונה</${Button}>
      </div>
      ${onQuick && tripTags(snap.trip) ? html`<${QuickChips} tags=${tripTags(snap.trip)} onQuick=${onQuick} />` : null}
    </section>`;
  }

  const toMe = plan.filter((t) => isMine(t.to)).length;
  const fromMe = plan.filter((t) => isMine(t.from));
  const parts = [
    html`החלק שלך <${Money} value=${mine?.owed ?? 0} />`,
    html`שילמת <${Money} value=${mine?.paid ?? 0} />`,
  ];
  if (mine?.sent > 0) parts.push(html`העברת <${Money} value=${mine.sent} />`);
  if (mine?.received > 0) parts.push(html`קיבלת <${Money} value=${mine.received} />`);
  const exempt = new Set(Array.isArray(snap.trip.settings?.money?.exempt) ? snap.trip.settings.money.exempt : []);
  const exemptNames = snap.members.filter((m) => exempt.has(m.id)).map(displayName);

  const art = { credit: '💰', debt: '💸', even: '✨' }[state];
  return html`<section class=${cx('money-hero', `money-hero--${state}`, over && 'money-hero--over')} data-testid="money-hero" data-state=${state} aria-labelledby="money-hero-title">
    <span class="money-hero__art" aria-hidden="true">${art}</span>
    ${state === 'even'
      ? html`<h1 class="money-hero__title money-hero__title--even" id="money-hero-title" data-testid="money-balance-label">את/ה מאוזנ/ת ✨</h1>`
      // the amount is written once: the count-up is what's seen, the heading's label is what's read out
      : html`<h1 class="money-hero__balance" id="money-hero-title" aria-label=${`${state === 'credit' ? 'מגיע לך' : 'עליך להעביר'} ${formatMoney(Math.abs(net))}`}>
          <span class="money-hero__label" data-testid="money-balance-label">${state === 'credit' ? 'מגיע לך' : 'עליך להעביר'}</span>
          <span class="money-hero__amount" data-testid="money-balance-amount" data-amount=${Math.abs(net)}><${Money} value=${animated} /></span>
        </h1>`}
    <p class="money-hero__breakdown" data-testid="money-breakdown">
      ${parts.map((p, i) => html`${i ? html`<span class="money-hero__sep" aria-hidden="true"> · </span>` : null}<span>${p}</span>`)}
    </p>
    ${oursNet !== null
      // each of us pays our own part (§19): the hero is me; the couple as a whole in one small line
      ? html`<p class="money-hero__ours small" data-testid="money-ours">💑 ${(me.people || []).length > 2 ? 'המשפחה' : 'הזוג'} יחד:${' '}
          ${Math.abs(oursNet) < EVEN_BELOW ? 'מאוזנים ✨' : html`${oursNet > 0 ? 'מגיע לכם' : 'עליכם'} <${Money} value=${Math.abs(oursNet)} />`}</p>`
      : null}
    <p class="money-hero__line" data-testid="money-line">
      <span><${Money} value=${totals.spent} data-testid="money-total" /> הוצאות</span><span class="money-hero__sep" aria-hidden="true"> · </span>
      <span><${Money} value=${totals.perHead} data-testid="money-per-head" /> לאדם</span><span class="money-hero__sep" aria-hidden="true"> · </span>
      <span><span class="num" data-testid="money-heads">${totals.heads}</span> משתתפים</span>
      ${exemptNames.length ? html`<span class="money-hero__sep" aria-hidden="true"> · </span><span>${exemptNames.join(', ')} ${exemptNames.length > 1 ? 'פטורים' : 'פטור/ה'} 🎁</span>` : null}
    </p>
    ${over
      ? null
      : state === 'debt' && fromMe.length
      ? html`<div class="money-hero__cta"><${Button} variant="secondary" size="sm" icon="chevron-down" onClick=${() => scrollToId('money-settle')}>
          למי: ${fromMe.map((t) => nameOf(t.to)).join(', ')}
        </${Button}></div>`
      : state === 'credit' && toMe
        ? html`<div class="money-hero__cta"><${Button} variant="secondary" size="sm" icon="chevron-down" onClick=${() => scrollToId('money-settle')}>
            ${toMe === 1 ? 'מחכה לך העברה אחת' : `מחכות לך ${toMe} העברות`}
          </${Button}></div>`
        : null}
  </section>`;
}

/**
 * Someone who joined after money was already recorded: an expense split among "everyone" includes whoever joins
 * later, a payment request sent before doesn't. Say which expenses are in my part (and how much), and which
 * requests I'm not on — instead of an unexplained "עליך ₪1,700".
 */
function LateJoinNote({ snap, me, byId }) {
  const joined = Date.parse(me.created_at || '');
  if (!Number.isFinite(joined)) return null;
  const rows = snap.expenses
    .filter((x) => x.split_mode !== 'members' && Date.parse(x.created_at) < joined)
    .map((x) => ({ exp: x, share: expenseShares(x, snap).find((s) => s.member_id === me.id)?.amount || 0 }))
    .filter((r) => r.share > 0);
  const onIt = new Set((snap.money_request_members || []).filter((x) => x.member_id === me.id).map((x) => x.request_id));
  const missed = (snap.money_requests || []).filter((q) => q.status === 'open' && q.requested_by !== me.id
    && !onIt.has(q.id) && Date.parse(q.created_at) < joined);
  if (!rows.length && !missed.length) return null;
  const sum = rows.reduce((n, r) => n + Math.round(r.share * 100), 0) / 100;
  const askers = [...new Set(missed.map((q) => displayName(byId.get(q.requested_by))))].join(', ');
  return html`<details class="money-late" data-testid="money-late">
    <summary class="money-late__row">
      <span aria-hidden="true">ℹ️</span>
      <span class="money-late__text">${rows.length
        ? html`הצטרפת אחרי ש${rows.length === 1 ? 'הוצאה אחת כבר נרשמה' : `־${rows.length} הוצאות כבר נרשמו`} — החלק שלך ${rows.length === 1 ? 'בה' : 'בהן'} <b><${Money} value=${sum} /></b>`
        : 'בקשות תשלום שנשלחו לפני שהצטרפת לא כוללות אותך'}</span>
      <${Icon} name="chevron-down" size=${16} />
    </summary>
    ${rows.length
      ? html`<p class="small">הוצאה שמתחלקת בין ״כולם״ כוללת גם את מי שמצטרף אחר כך — לכן היא חלק מהחשבון שלך:</p>
        <ul class="money-late__list">
          ${rows.map((r) => html`<li key=${r.exp.id}><span class="truncate">${r.exp.title} · ${displayName(byId.get(r.exp.paid_by))}</span>
            <span class="num">חלקך <${Money} value=${r.share} /></span></li>`)}
        </ul>
        <p class="tiny muted">לא השתתפת באחת מהן? מי ששילם/ה אותה (או מנהל/ת) יכולים לערוך אותה ולבחור ״רק חלק״.</p>`
      : null}
    ${missed.length
      ? html`<p class="small" data-testid="money-late-requests">${rows.length ? 'ולהפך: ' : ''}בקשות תשלום שנשלחו לפני שהצטרפת לא כוללות אותך —${' '}
          ${missed.map((q) => `״${q.title}״`).join(', ')}. גם את/ה משתתף/ת? בקשו מ${askers} להוסיף אותך לבקשה.</p>`
      : null}
  </details>`;
}

// ---------------------------------------------------------------------------
// settle plan: who pays whom
// ---------------------------------------------------------------------------

function SettleCard({ snap, me, admin, plan, bals, byId, nameOf, isMine, onPay, over, fx }) {
  const trip = snap.trip;
  const rank = (t) => (isMine(t.from) ? 0 : isMine(t.to) ? 1 : 2);
  const rows = [...plan].sort((a, b) => rank(a) - rank(b));
  const mineRows = rows.filter((t) => rank(t) < 2);
  // after the trip (ux A2): my row, then "עוד N העברות בין החבר'ה" folded
  const others = over ? rows.filter((t) => rank(t) === 2) : [];
  const listed = over ? mineRows : rows;

  // Progress: what was already sent vs. what is still left to transfer.
  const sentCents = bals.reduce((s, b) => s + Math.round(b.sent * 100), 0);
  const leftCents = plan.reduce((s, t) => s + t.amount * 100, 0);
  const pct = sentCents + leftCents > 0 ? Math.round((sentCents / (sentCents + leftCents)) * 100) : 100;
  const summary = buildSummaryText(snap, 'settle');

  return html`<section id="money-settle" class="money-anchor" aria-labelledby="money-settle-title">
    <${Card} class="money-settle">
      <div class="card__head">
        <span class="card__emoji" aria-hidden="true">🤝</span>
        <h2 class="card__title" id="money-settle-title">איך מתחשבנים</h2>
        ${rows.length ? html`<${Pill} tone="accent">${hebrewCount(rows.length, 'העברה', 'העברות')}</${Pill}>` : null}
      </div>

      ${sentCents > 0 || leftCents > 0
        ? html`<div class="money-progress" data-testid="money-progress">
            <div class="row row--between small">
              <span>הועברו <${Money} value=${Math.round(sentCents / 100)} /> מתוך <${Money} value=${Math.round((sentCents + leftCents) / 100)} /></span>
              <strong class="num">${pct}%</strong>
            </div>
            <${ProgressBar} value=${pct} tone="success" label="התקדמות ההתחשבנות" />
          </div>`
        : null}

      ${mineRows.length && !over ? html`<${PayStyle} snap=${snap} me=${me} />` : null}
      ${rows.length
        ? html`<ul class="settle-list" data-testid="settle-list">
            ${listed.map((t) => html`<${SettleRow}
              key=${`${t.from}>${t.to}`}
              t=${t}
              trip=${trip}
              me=${me}
              admin=${admin}
              from=${byId.get(partyOf(t.from).member_id)}
              to=${byId.get(partyOf(t.to).member_id)}
              toPay=${payMethodsOf(snap, partyOf(t.to).member_id)}
              nameOf=${nameOf}
              isMine=${isMine}
              onPay=${onPay}
              fx=${fx}
            />`)}
          </ul>
          ${others.length
            ? html`<${Fold} title="עוד העברות בין החבר׳ה" count=${others.length} class="settle-more" data-testid="settle-more">
                <ul class="settle-list">
                  ${others.map((t) => html`<${SettleRow} key=${`${t.from}>${t.to}`} t=${t} trip=${trip} me=${me} admin=${admin}
                    from=${byId.get(partyOf(t.from).member_id)} to=${byId.get(partyOf(t.to).member_id)}
                    toPay=${payMethodsOf(snap, partyOf(t.to).member_id)} nameOf=${nameOf} isMine=${isMine} onPay=${onPay} fx=${fx} />`)}
                </ul>
              </${Fold}>`
            : null}
          ${over ? null : html`<p class="tiny muted money-note">הסכומים מעוגלים לשקל. אחרי ההעברה מסמנים כאן — וזה יורד מהחשבון.</p>`}`
        : html`<div class="money-settled" data-testid="settle-empty">
            <span class="money-settled__emoji" aria-hidden="true">🎉</span>
            <div>
              <strong>כולם מאוזנים!</strong>
              <div class="small muted">אין צורך בהעברות — נתראה במדורה 🔥</div>
            </div>
          </div>`}

      <div class="money-settle__foot">
        <${ShareButton} text=${summary} label="שיתוף ההתחשבנות" size="sm" variant="ghost" />
        <${Button} variant="ghost" size="sm" icon="plus" onClick=${() => onPay({ kind: 'free' })}>רישום העברה</${Button}>
      </div>
    </${Card}>
  </section>`;
}

/** How a profile of 2+ settles (prefs.pay, SPEC §19) — a shortcut to the "💑 הזוג שלנו" choice on "אני". */
function PayStyle({ snap, me }) {
  if ((me.people || []).length < 2) return null;
  return html`<div class="money-paystyle" data-testid="pay-style">
    <span class="small"><b>איך אתם משלמים?</b></span>
    <${Segmented} label="איך אתם משלמים?" value=${prefOf(me, 'pay')} onChange=${(v) => chooseCouple(snap, me, 'pay', v)}
      options=${PAY_OPTIONS} class="me-couple__seg" />
  </div>`;
}

function SettleRow({ t, trip, me, admin, from, to, toPay, nameOf, isMine, onPay, fx }) {
  const mineOut = isMine(t.from);
  const mineIn = !mineOut && isMine(t.to);
  // inside one profile (a couple that pays each their own part, §19): "עידו → נועה · בתוך הזוג"
  const inside = partyOf(t.from).member_id === partyOf(t.to).member_id;
  const toPerson = partyOf(t.to).person;
  const fromPerson = partyOf(t.from).person;
  const phoneOf = (m, person) => (person ? personPhone(m, personsOf(m).find((p) => p.name === person) || null) : m?.phone || null);
  const tripLabel = `${trip.emoji || '⛺'} ${trip.name}`;
  let actionsNode = null;
  // a sentence, not an arrow (ux M2): "את/ה מעביר/ה למאיה ורון ₪153"
  const who = mineOut
    ? html`<span class="money-name">${YOU}</span> מעביר/ה ל<span class="money-name">${nameOf(t.to)}</span>`
    : mineIn
      ? html`<span class="money-name">${nameOf(t.from)}</span> מעביר/ה לך`
      : html`<span class="money-name">${nameOf(t.from)}</span> מעביר/ה ל<span class="money-name">${nameOf(t.to)}</span>`;

  if (mineOut) {
    // how they like to get paid: the Bit / PayBox of their payment requests, else the profile phone
    const bit = toPay?.bit || null;
    const paybox = toPay?.paybox || null;
    const phone = (inside ? phoneOf(to, toPerson) : phoneOf(to, toPerson) || bit) || null;
    const chat = phone ? whatsappChatUrl(phone, `היי! לגבי ${tripLabel} — מעביר/ה לך ${formatMoney(t.amount)} 💸`) : null;
    actionsNode = html`<div class="settle-row__actions">
      <${Button} block onClick=${() => onPay({ kind: 'paid', from: t.from, to: t.to, amount: t.amount })}>שילמתי ✓</${Button}>
      <div class="settle-row__links">
        ${bit
          ? html`<${CopyButton} text=${copyablePhone(bit)} size="sm" variant="ghost" label=${html`📱 ביט <bdi dir="ltr">${prettyPhone(bit)}</bdi>`} />`
          : phone
            ? html`<${CopyButton} text=${copyablePhone(phone)} size="sm" variant="ghost" label=${html`<bdi dir="ltr">${prettyPhone(phone)}</bdi>`} />`
            : null}
        ${paybox
          ? html`<${CopyButton} text=${paybox} size="sm" variant="ghost" label=${html`📦 פייבוקס <bdi dir="ltr">${paybox.length > 18 ? `${paybox.slice(0, 16)}…` : paybox}</bdi>`} />`
          : null}
        ${chat
          ? html`<${Button} variant="ghost" size="sm" icon="send" href=${chat} target="_blank" rel="noopener noreferrer">וואטסאפ</${Button}>`
          : null}
      </div>
      ${!phone && !paybox
        ? html`<p class="settle-row__hint tiny muted" data-testid="settle-no-phone">ל${nameOf(t.to)} אין מספר בפרופיל — בקשו אותו בקבוצה 🙂</p>`
        : null}
    </div>`;
  } else if (mineIn) {
    const myPhone = me.phone ? prettyPhone(me.phone) : '';
    const fromPhone = phoneOf(from, fromPerson);
    // no phone on their profile (one the organiser added): the same words, and WhatsApp asks whom to send them to
    const nudgeText = `לפי ההתחשבנות במדורה (${tripLabel}) נשאר ${formatMoney(t.amount)} להעביר לי${myPhone ? ` — אפשר בביט ל-${myPhone}` : ''} 🙏`;
    const nudge = fromPhone
      ? whatsappChatUrl(fromPhone, `היי! 🙂 ${nudgeText}`)
      : whatsappShareUrl(`היי ${nameOf(t.from)}! 🙂 ${nudgeText}`);
    actionsNode = html`<div class="settle-row__actions">
      <${Button} variant="secondary" onClick=${() => onPay({ kind: 'received', from: t.from, to: t.to, amount: t.amount })}>קיבלתי ✓</${Button}>
      ${nudge
        ? html`<${Button} variant="ghost" size="sm" icon="send" href=${nudge} target="_blank" rel="noopener noreferrer">תזכורת עדינה</${Button}>`
        : null}
    </div>`;
  }

  const top = html`<span class="settle-row__main">
      <span class="settle-row__who">${who}</span>
      ${mineOut ? html`<span class="settle-row__tag">👈 ההעברה שלך</span>` : null}
      ${mineIn ? html`<span class="settle-row__tag">💚 מגיע לך</span>` : null}
      ${inside ? html`<span class="settle-row__tag settle-row__inside" data-testid="settle-inside">💑 בתוך ${(from?.people || []).length > 2 ? 'המשפחה' : 'הזוג'}</span>` : null}
    </span>
    <span class="settle-row__sum"><${Money} value=${t.amount} class="settle-row__amount" />${fx?.tag(t.amount)}</span>`;

  return html`<li class=${cx('settle-row', mineOut && 'is-out', mineIn && 'is-in')} data-testid="settle-row">
    ${admin && !mineOut && !mineIn
      // admins mark someone else's transfer by tapping the row itself — no extra link per row
      ? html`<button type="button" class="settle-row__top settle-row__tap" aria-label=${`סימון ששולם — ${nameOf(t.from)} ל${nameOf(t.to)} ${formatMoney(t.amount)}`}
          onClick=${() => onPay({ kind: 'admin', from: t.from, to: t.to, amount: t.amount })}>${top}<${Icon} name="chevron-left" size=${16} /></button>`
      : html`<div class="settle-row__top">${top}</div>`}
    ${actionsNode}
  </li>`;
}

// ---------------------------------------------------------------------------
// payments
// ---------------------------------------------------------------------------

function PaymentsSection({ snap, me, admin, byId, nameOf, sideKey, busyId, onConfirm, onDelete, bare, fx }) {
  const [all, setAll] = useState(false);
  const list = [...snap.payments].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const shown = all ? list : list.slice(0, PAYMENTS_PREVIEW);
  // the receiver confirms (an admin may, for them) — never the one who paid, even an admin; inside one profile
  // (§19): only the partner who got it (a same-named person of another profile is not them)
  const canConfirmOf = (p) => p.status !== 'confirmed' && (p.from_member === p.to_member
    ? (p.to_member === me.id ? p.to_person === snap.me?.person : admin)
    : p.from_member !== me.id && (p.to_member === me.id || admin));
  const waiting = list.filter(canConfirmOf).length;

  return html`<section class="money-section" aria-labelledby="money-pay-title">
    <div class=${cx('money-section__head', bare && 'sr-only')}>
      <h2 class="money-section__title" id="money-pay-title"><span aria-hidden="true">💳</span> העברות</h2>
      <span class="section__count num">${list.length}</span>
      ${waiting ? html`<${Pill} tone="warning">${waiting} מחכות לאישור</${Pill}>` : null}
    </div>
    <ul class="list money-pay-list" data-testid="payments-list">
      ${shown.map((p) => {
        const confirmed = p.status === 'confirmed';
        const canConfirm = canConfirmOf(p);
        const canDelete = admin || (p.created_by === me.id && !confirmed);
        const m = methodOf(p.method);
        const busy = busyId === p.id;
        return html`<li key=${p.id} class="pay-row" data-testid="payment-row" data-status=${p.status}>
          <div class="pay-row__main">
            <span class="pay-row__who"><span class="money-name">${nameOf(sideKey(p.from_member, p.from_person))}</span> ${nameOf(sideKey(p.from_member, p.from_person)) === YOU ? 'העברת' : 'העביר/ה'} ל<span class="money-name">${nameOf(sideKey(p.to_member, p.to_person)) === YOU ? 'ך' : nameOf(sideKey(p.to_member, p.to_person))}</span></span>
            <span class="pay-row__sub">${p.pot ? html`<span class="pot-tag" data-testid="pot-tag" title="קופה משותפת">🪙 לקופה · </span>` : null}${m.emoji} ${m.label}${p.note ? html` · <span class="pay-row__note">${p.note}</span>` : null} · ${timeAgo(p.created_at)}</span>
            ${canConfirm
              ? html`<${Button} size="sm" icon="check" class="pay-row__confirm" loading=${busy} onClick=${() => onConfirm(p)}>
                  ${p.to_member === me.id ? 'הכסף הגיע' : 'אישור קבלה'}
                </${Button}>`
              : null}
          </div>
          <div class="pay-row__end">
            <${Money} value=${p.amount} class="pay-row__amount" />
            ${fx?.tag(p.amount, dayOf(p.created_at))}
            <${Pill} tone=${confirmed ? 'success' : 'warning'}>${confirmed ? 'אושר ✅' : 'נשלח ⏳'}</${Pill}>
            ${canDelete
              ? html`<button type="button" class="link pay-row__delete" aria-label="מחיקת ההעברה" disabled=${busy} onClick=${() => onDelete(p)}>מחיקה</button>`
              : null}
          </div>
        </li>`;
      })}
    </ul>
    ${list.length > PAYMENTS_PREVIEW
      ? html`<${Button} variant="ghost" size="sm" onClick=${() => setAll(!all)}>
          ${all ? 'הצג פחות' : `הצג את כל ${list.length} ההעברות`}
        </${Button}>`
      : null}
  </section>`;
}

// ---------------------------------------------------------------------------
// expenses
// ---------------------------------------------------------------------------

function splitText(expense, snap) {
  if (expense.split_mode === 'members') {
    const n = snap.expense_shares.filter((s) => s.expense_id === expense.id).length;
    return n === 1 ? 'משתתף/ת אחד/ת' : `${n} משתתפים`;
  }
  // "everyone" = who pays: the exempt are out ("כולם · 8 אנשים · אבי פטור/ה 🎁")
  const payers = payingMembers(snap);
  const out = snap.members.filter((m) => !payers.includes(m));
  return `כולם · ${hebrewCount(headcountTotal(payers), 'איש', 'אנשים')}${out.length ? ` · ${out.map(displayName).join(', ')} פטור/ה 🎁` : ''}`;
}

/** One tap on a kind of expense (the trip type's tags) opens the new-expense sheet with it chosen — me paying, split among everyone. */
function QuickChips({ tags, onQuick }) {
  return html`<div class="h-scroll money-quick" role="group" aria-label="הוצאה מהירה" data-testid="expense-quick">
    <span class="money-quick__label tiny muted">➕ מהר:</span>
    ${tags.map((t) => html`<${Chip} key=${t.n} data-tag=${t.n} onClick=${() => onQuick(t.n)}><span aria-hidden="true">${t.e}</span> ${t.n}</${Chip}>`)}
  </div>`;
}

function sortExpenses(list) {
  return [...list].sort((a, b) => String(b.spent_on).localeCompare(String(a.spent_on))
    || String(b.created_at).localeCompare(String(a.created_at)));
}

function ExpensesSection({ snap, me, byId, totals, flashId, onOpen, onAdd, onQuick, bare, fx }) {
  const cats = new Map(snap.categories.map((c) => [c.id, c]));
  const all = sortExpenses(snap.expenses);
  const tags = tripTags(snap.trip);
  // tag filter (only when the trip has tags and some expense carries one)
  const used = tags ? [...new Set(all.map((e) => e.tag).filter(Boolean))].map((n) => tagOf(tags, n))
    .sort((a, b) => tags.findIndex((t) => t.n === a.n) - tags.findIndex((t) => t.n === b.n)) : [];
  const [filter, setFilter] = useState(null);
  const active = filter && used.some((t) => t.n === filter) ? filter : null;
  const list = active ? all.filter((e) => e.tag === active) : all;
  const shown = active ? list.reduce((sum, e) => sum + Number(e.amount || 0), 0) : totals.spent;

  return html`<section class="money-section" aria-labelledby="money-exp-title">
    <div class=${cx('money-section__head', bare && 'sr-only')}>
      <h2 class="money-section__title" id="money-exp-title"><span aria-hidden="true">🧾</span> הוצאות</h2>
      ${all.length ? html`<span class="section__count num">${list.length}</span>` : null}
      <span class="spacer"></span>
      ${all.length ? html`<span class="money-section__sum" data-testid="expenses-sum">סה״כ <${Money} value=${shown} /></span>` : null}
    </div>
    ${tags && onQuick ? html`<${QuickChips} tags=${tags} onQuick=${onQuick} />` : null}
    ${used.length
      ? html`<div class="h-scroll money-tag-filter" role="group" aria-label="סינון לפי סוג" data-testid="expense-tag-filter">
          <${Chip} active=${!active} onClick=${() => setFilter(null)} data-tag="">הכל</${Chip}>
          ${used.map((t) => html`<${Chip} key=${t.n} active=${active === t.n} data-tag=${t.n}
            onClick=${() => setFilter(active === t.n ? null : t.n)}>
            <span aria-hidden="true">${t.e}</span> ${t.n} <span class="money-tag-filter__n num">${all.filter((e) => e.tag === t.n).length}</span>
          </${Chip}>`)}
        </div>`
      : null}
    ${list.length
      ? html`<ul class="list money-exp-list" data-testid="expenses-list">
          ${list.map((e) => {
            const payer = byId.get(e.paid_by);
            const cat = cats.get(e.category_id);
            const tag = tags || e.tag ? tagOf(tags, e.tag) : null;
            const myShare = expenseShares(e, snap).find((s) => s.member_id === me.id)?.amount || 0;
            const who = paidByText(e, payer, me, snap);
            return html`<li key=${e.id}>
              <button
                type="button"
                class=${cx('list-row', 'exp-row', flashId === e.id && 'is-new')}
                data-testid="expense-row"
                data-expense-id=${e.id}
                onClick=${() => onOpen(e)}
              >
                <span class="exp-row__icon" aria-hidden="true">
                  <${Avatar} member=${payer} size=${42} />
                  <span class="exp-row__cat">${tag?.e || cat?.emoji || '🧾'}</span>
                </span>
                <span class="list-row__main">
                  <span class="list-row__title">${e.title}</span>
                  <span class="list-row__sub">${who} · <span class="exp-row__split" data-testid="expense-split">${splitText(e, snap)}</span></span>
                  <span class="list-row__sub exp-row__meta">${e.from_pot ? html`<span class="pot-tag" data-testid="pot-tag" title="שולם מהקופה">🪙 מהקופה · </span>` : null}${dayLabel(e.spent_on)}${tag ? html` · <span class="exp-row__tag" data-testid="expense-tag">${tag.e} ${tag.n}</span>` : null}${e.note ? html` · <span class="exp-row__note">📝 ${e.note}</span>` : null}</span>
                </span>
                <span class="exp-row__end">
                  <${Money} value=${e.amount} class="exp-row__amount" data-testid="expense-amount" />
                  ${e.currency ? html`<span class="exp-row__orig num" dir="ltr">${symbolOf(e.currency)}${Number(e.orig_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>` : null}
                  ${fx?.code && e.currency !== fx.code ? fx.tag(e.amount, dayOf(e.spent_on), e) : null}
                  ${myShare > 0 ? html`<span class="exp-row__mine">${splitsMoney(me) ? 'חלקכם' : 'חלקך'} <${Money} value=${myShare} /></span>` : null}
                </span>
              </button>
            </li>`;
          })}
        </ul>`
      : html`<${Card}>
          <${EmptyState}
            emoji="🧾"
            title="עוד אין הוצאות"
            text="קניתם בשר, פחמים או שתייה? רשמו כאן — וכל אחד יראה כמה יוצא לו."
            action=${onAdd ? html`<${Button} variant="accent" icon="plus" onClick=${onAdd}>הוספת הוצאה</${Button}>` : null}
          />
        </${Card}>`}
  </section>`;
}

// ---------------------------------------------------------------------------
// per-member table
// ---------------------------------------------------------------------------

function MembersTable({ snap, me, balById, pbals = [], myKey, nets = new Map(), mnets = new Map() }) {
  return html`<section class="money-section" aria-label="מאזן לפי חבר׳ה">
    <div class="money-table-wrap">
      <table class="money-table" data-testid="members-table">
        <thead>
          <tr>
            <th scope="col" class="money-table__who">מי</th>
            <th scope="col">שילמו</th>
            <th scope="col">החלק</th>
            <th scope="col">יתרה</th>
          </tr>
        </thead>
        <tbody>
          ${snap.members.map((m) => {
            const b = balById.get(m.id) || { paid: 0, owed: 0, balance: 0 };
            // the balance column is the plan's whole-shekel number — the same one the transfers above say
            const net = mnets.get(m.id) || 0;
            const tone = net >= EVEN_BELOW ? 'plus' : net <= -EVEN_BELOW ? 'minus' : 'even';
            return html`<tr key=${m.id} class=${cx(m.id === me.id && 'is-me')} data-testid="member-balance-row" data-member-id=${m.id}>
              <th scope="row" class="money-table__who">
                <span class="money-table__name">
                  <${Avatar} member=${m} size=${26} />
                  <span class="truncate">${displayName(m)}</span>
                  ${m.id === me.id ? html`<span class="sr-only">(${YOU})</span>` : null}
                </span>
              </th>
              <td data-col="paid"><${Money} value=${b.paid} /></td>
              <td data-col="owed"><${Money} value=${b.owed} /></td>
              <td data-col="balance" class=${`money-table__bal is-${tone}`}><${Money} value=${net} signed /></td>
            </tr>
            ${splitsMoney(m)
              // each of them pays their own part (§19): one small row per person
              ? pbals.filter((r) => r.member_id === m.id && r.person).map((r) => {
                const n2 = nets.get(r.key) || 0;
                const t2 = n2 >= EVEN_BELOW ? 'plus' : n2 <= -EVEN_BELOW ? 'minus' : 'even';
                return html`<tr key=${r.key} class=${cx('money-table__sub', r.key === myKey && 'is-me')} data-testid="member-person-row" data-person=${r.person}>
                  <th scope="row" class="money-table__who"><span class="money-table__name money-table__person">↳ ${r.person}</span></th>
                  <td data-col="paid"><${Money} value=${r.paid} /></td>
                  <td data-col="owed"><${Money} value=${r.owed} /></td>
                  <td data-col="balance" class=${`money-table__bal is-${t2}`}><${Money} value=${n2} signed /></td>
                </tr>`;
              })
              : null}`;
          })}
        </tbody>
      </table>
    </div>
    <p class="tiny muted money-note">יתרה = מה ששילמו − החלק שלהם, כולל העברות שכבר סומנו — מעוגלת לשקל, כמו ב״איך מתחשבנים״. פלוס = מגיע להם.</p>
  </section>`;
}

// ---------------------------------------------------------------------------
// expense sheet (new / edit / read-only)
// ---------------------------------------------------------------------------

function ExpenseSheet({ open, data, snap, me, admin, onClose, onSaved, onDeleting }) {
  const exp = data?.expense || null;
  const editing = !!exp;
  const canEdit = !exp || admin || exp.created_by === me.id || exp.paid_by === me.id;
  if (exp && !canEdit) {
    return html`<${ExpenseDetails} open=${open} exp=${exp} snap=${snap} me=${me} onClose=${onClose} />`;
  }
  return html`<${ExpenseForm}
    open=${open}
    exp=${exp}
    editing=${editing}
    preset=${data || null}
    snap=${snap}
    me=${me}
    admin=${admin}
    onClose=${onClose}
    onSaved=${onSaved}
    onDeleting=${onDeleting}
  />`;
}

function ExpenseForm({ open, exp, editing, preset, snap, me, admin, onClose, onSaved, onDeleting }) {
  const members = snap.members;
  const byId = membersById(members);
  const initialChosen = exp && exp.split_mode === 'members'
    ? snap.expense_shares.filter((s) => s.expense_id === exp.id).map((s) => ({ member_id: s.member_id, weight: s.weight }))
    : [{ member_id: exp?.paid_by || me.id }];

  const [amount, setAmount] = useState(exp ? Number(exp.amount) : null);
  const offered = Array.isArray(snap.trip.settings?.money?.currencies) ? snap.trip.settings.money.currencies : [];
  const [cur, setCur] = useState(exp?.currency || 'ILS');
  const [orig, setOrig] = useState(exp?.orig_amount != null ? Number(exp.orig_amount) : null);
  const [rate, setRate] = useState(exp?.rate != null ? Number(exp.rate) : null);
  const [rateState, setRateState] = useState(exp?.rate != null ? 'saved' : 'idle'); // idle | loading | auto | manual | failed | saved
  const foreign = cur !== 'ILS';
  const amountIls = foreign ? (orig > 0 && rate > 0 ? toShekels(orig, rate) : null) : amount;
  const [title, setTitle] = useState(exp?.title || '');
  // paid out of the shared cash pot (SPEC §8.7a): the keeper is the payer — only the keeper, or an admin for them
  const potCfg = potSettings(snap);
  const canPot = Boolean(potCfg) && (potCfg.keeper === me.id || admin);
  const [fromPot, setFromPot] = useState(Boolean(exp ? exp.from_pot && potCfg : preset?.fromPot && canPot));
  const [paidBy, setPaidBy] = useState(exp?.paid_by || (!exp && preset?.fromPot && canPot ? potCfg.keeper : me.id));
  const [categoryId, setCategoryId] = useState(exp?.category_id || null);
  const tags = tripTags(snap.trip);
  const [tag, setTag] = useState(exp?.tag || (!exp && tags && preset?.tag ? preset.tag : null));   // a quick chip starts with its tag
  const tagChips = tags ? (tag && !tags.some((t) => t.n === tag) ? [...tags, tagOf(tags, tag)] : tags) : null;
  const [mode, setMode] = useState(exp?.split_mode === 'members' ? 'members' : 'all');
  const [chosen, setChosen] = useState(initialChosen);
  const [note, setNote] = useState(exp?.note || '');
  const [spentOn, setSpentOn] = useState(exp?.spent_on ? String(exp.spent_on).slice(0, 10) : todayYmd());
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [secret, setSecret] = useState(Boolean(exp?.secret));       // groom mode: a surprise (a gift…), hidden from the guest of honour

  // the day's rate, automatically (unless typed by hand, or kept from a saved expense)
  useEffect(() => {
    if (!foreign || rateState === 'manual' || rateState === 'saved') return undefined;
    let alive = true;
    setRateState('loading');
    rateOn(cur, spentOn).then((v) => {
      if (!alive) return;
      if (v) {
        setRate(Math.round(v * 10000) / 10000);
        setRateState('auto');
        setErrors((e) => (e.amount ? { ...e, amount: null } : e));
      } else setRateState('failed');
    });
    return () => { alive = false; };
  }, [cur, spentOn, foreign]);

  // "הוספת הוצאה" pressed while the rate is still on its way (a slow connection): it saves the moment the rate is
  // here — or says what's missing — instead of doing nothing visible
  const [queued, setQueued] = useState(false);
  useEffect(() => {
    if (!queued) return;
    if (!open) { setQueued(false); return; }               // the sheet was closed meanwhile: nothing is saved behind its back
    if (rateState === 'loading') return;
    setQueued(false);
    save();
  }, [queued, rateState, open]);

  const chosenIds = chosen.map((c) => c.member_id);
  const setChosenIds = (ids) => setChosen(ids.map((id) => chosen.find((c) => c.member_id === id) || { member_id: id }));

  // Live preview (logic.js: expenseShares / tripTotals).
  const participants = mode === 'all' ? payingMembers(snap) : chosenIds.map((id) => byId.get(id)).filter(Boolean);
  const valid = amountIls > 0 && amountIls <= MAX_AMOUNT && participants.length > 0;
  const draft = { amount: valid ? amountIls : 0, split_mode: mode, members: mode === 'members' ? chosen : undefined };
  const shares = valid ? expenseShares(draft, snap) : [];
  const customWeights = mode === 'members' && chosen.some((c) => c.weight != null && Number(c.weight) !== (Number(byId.get(c.member_id)?.headcount) || 1));
  const perHead = valid && !customWeights ? tripTotals({ members: participants, expenses: [{ amount: amountIls }] }).perHead : null;
  const heads = headcountTotal(participants);

  // A new expense that looks like a money request's purchase: recorded again it counts twice (testers 2026-10-02).
  // "כבר שילמתי" requests have their expense already; a collection's purchase is recorded from the request itself,
  // so the money in its pot is counted with it.
  const reqTwin = !editing && title.trim().length > 1
    ? (snap.money_requests || []).map((q) => {
        if (!titleSimilarity(title, q.title)) return null;
        const e = q.expense_id ? snap.expenses.find((x) => x.id === q.expense_id) : null;
        if (e) return { q, expense: e };
        return !q.expense_id && q.pot !== false ? { q, expense: null } : null;
      }).find(Boolean) || null
    : null;

  const payer = byId.get(paidBy);
  const canPickPayer = admin && !fromPot;
  // a couple that pays each their own part (§19): which of them paid — me by default, "ביחד" = together
  const myPerson = (me.people || []).includes(snap.me?.person) ? snap.me.person : null;
  const payerSplits = splitsMoney(payer);
  const [payPerson, setPayPerson] = useState(exp ? exp.paid_by_person ?? null : paidBy === me.id ? myPerson : null);
  const pickPayer = (id) => {
    setPaidBy(id);
    setPayPerson(exp && id === exp.paid_by ? exp.paid_by_person ?? null : id === me.id ? myPerson : null);
  };
  const togglePot = (on) => {
    setFromPot(on);
    pickPayer(on ? potCfg.keeper : exp?.paid_by || me.id);
    // a pot kept in euros: the receipt is most likely in euros too
    if (on && potCfg.currency !== 'ILS' && offered.includes(potCfg.currency) && !foreign && !amount) {
      setCur(potCfg.currency);
      if (rateState !== 'manual') setRateState('idle');
    }
  };

  const save = async () => {
    if (saving || deleting) return; // Enter in a field while a call is in flight
    if (foreign && rateState === 'loading') return setQueued(true);        // goes through when the rate is here
    const errs = {};
    const amountErr = foreign
      ? (!(orig > 0) ? 'כמה זה עלה?' : !(rate > 0) ? 'חסר שער — הקלידו אותו ידנית' : moneyError(amountIls))
      : moneyError(amount);
    if (amountErr) errs.amount = amountErr;
    if (!title.trim()) errs.title = 'על מה ההוצאה?';
    if (mode === 'members' && !chosen.length) errs.members = 'בחרו לפחות משתתף/ת אחד/ת';
    setErrors(errs);
    if (Object.keys(errs).length) {
      // the field that's wrong may be scrolled out of sight (the button sits at the bottom): bring it back
      requestAnimationFrame(() => document.querySelector('.money-form .field__error')
        ?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' }));
      return;
    }

    const payload = {
      title: title.trim(),
      amount: amountIls,
      currency: foreign ? cur : null,
      ...(foreign ? { orig_amount: orig, rate } : {}),
      category_id: categoryId,
      ...(tags || exp?.tag ? { tag: tag || null } : {}),
      note: note.trim() || null,
      spent_on: spentOn || todayYmd(),
      split_mode: mode,
    };
    if (potCfg || exp?.from_pot) payload.from_pot = fromPot && Boolean(potCfg);
    if (canPickPayer || fromPot) payload.paid_by = paidBy;
    if (payerSplits) payload.paid_by_person = (payer.people || []).includes(payPerson) ? payPerson : null;
    if (mode === 'members') {
      payload.members = chosen.map((c) => (c.weight != null ? { member_id: c.member_id, weight: Number(c.weight) } : { member_id: c.member_id }));
    }
    setSaving(true);
    const res = await actions.run(
      async (api) => {
        const id = await (editing ? api.updateExpense(exp.id, payload) : api.addExpense(snap.trip.id, payload));
        const eid = editing ? exp.id : id;
        if (admin && snap.trip.settings?.groom && Boolean(exp?.secret) !== secret) await api.setSecret('expense', eid, secret);
        return id;
      },
      { success: editing ? 'ההוצאה עודכנה ✏️' : 'ההוצאה נוספה 🧾 החשבון התעדכן' },
    );
    setSaving(false);
    if (res === undefined) return;
    onClose();
    onSaved?.(editing ? exp.id : res);
  };

  const remove = async () => {
    if (saving || deleting) return;
    const ok = await confirmDialog({
      title: 'למחוק את ההוצאה?',
      // transfers already made stay as they are: the plan is recomputed around them (testers 2026-10-03)
      text: `״${exp.title}״ · ${formatMoney(exp.amount)} — החלוקה תתעדכן לכולם.${snap.payments.length
        ? ' העברות שכבר נרשמו נשארות, אז אם כבר שילמו על ההוצאה הזו — אחרי המחיקה בודקים את ההתחשבנות (ייתכן שמישהו ״קיבל יותר מדי״).' : ''}`,
      confirmText: 'כן, למחוק',
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    onDeleting?.(exp.id);
    const res = await actions.run((api) => api.deleteExpense(exp.id), { success: 'ההוצאה נמחקה 🗑️' });
    setDeleting(false);
    if (res !== undefined) onClose();
  };

  const footer = html`
    <${Button} variant="secondary" onClick=${onClose} disabled=${saving || deleting}>ביטול</${Button}>
    <${Button} variant="primary" icon="check" loading=${saving || queued} disabled=${deleting} onClick=${save} data-testid="expense-save">
      ${editing ? 'שמירה' : 'הוספת הוצאה'}
    </${Button}>`;

  return html`<${Sheet} open=${open} onClose=${onClose} title=${editing ? 'עריכת הוצאה ✏️' : 'הוצאה חדשה 🧾'} footer=${footer} class="money-sheet">
    <form class="stack-lg money-form" onSubmit=${(e) => { e.preventDefault(); save(); }} novalidate>
      ${offered.length || foreign
        ? html`<div class="money-cur" role="group" aria-label="מטבע" data-testid="expense-currency">
            ${['ILS', ...offered.filter((c) => c !== 'ILS')].map((c) => html`<${Chip} key=${c} active=${cur === c}
              onClick=${() => { setCur(c); if (c !== cur && rateState !== 'manual') setRateState('idle'); if (errors.amount) setErrors({ ...errors, amount: null }); }}>
              ${symbolOf(c)} ${c === 'ILS' ? 'שקל' : CURRENCIES.find((x) => x.code === c)?.label || c}
            </${Chip}>`)}
          </div>`
        : null}
      <${Field} label=${foreign ? `כמה זה עלה? (ב${CURRENCIES.find((x) => x.code === cur)?.label || cur})` : 'כמה זה עלה?'} error=${errors.amount}>
        ${foreign
          ? html`<${MoneyInput} symbol=${symbolOf(cur)} value=${orig} onChange=${(v) => { setOrig(v); if (errors.amount) setErrors({ ...errors, amount: null }); }} />`
          : html`<${MoneyInput} value=${amount} onChange=${(v) => { setAmount(v); if (errors.amount) setErrors({ ...errors, amount: null }); }} />`}
      </${Field}>
      ${foreign
        ? html`<div class="money-rate" data-testid="expense-rate">
            <span class="money-rate__label">שער ${symbolOf(cur)}1 =</span>
            <input class="input money-rate__input num" dir="ltr" inputmode="decimal" aria-label="שער בשקלים"
              value=${rate ?? ''} onInput=${(e) => { const v = Number(e.target.value.replace(',', '.')); setRate(v > 0 ? v : null); setRateState('manual'); }} />
            <span class="money-rate__label">₪</span>
            <span class="tiny muted money-rate__state">${rateState === 'loading' ? 'מביאים את השער…'
              : rateState === 'auto' ? `לפי ${dayLabel(spentOn)} ✓` : rateState === 'failed' ? 'לא הצלחנו להביא שער — הקלידו ידנית'
                : rateState === 'manual' ? 'שער ידני' : ''}</span>
            ${amountIls ? html`<strong class="money-rate__ils">= <${Money} value=${amountIls} /></strong>` : null}
          </div>`
        : null}

      <${Field} label="על מה?" error=${errors.title}>
        <${TextInput}
          value=${title}
          maxLength=${80}
          placeholder="קניות בסופר, פחמים, דלק…"
          enterkeyhint="done"
          onInput=${(e) => { setTitle(e.target.value); if (errors.title) setErrors({ ...errors, title: null }); }}
        />
      </${Field}>
      ${reqTwin
        ? html`<div class="mreq-warn small" role="note" data-testid="expense-request-twin">
            ${reqTwin.expense
              ? html`<span>כבר רשומה הוצאה ״${reqTwin.expense.title}״ (${formatMoney(reqTwin.expense.amount)}) — היא נרשמה עם בקשת התשלום. אם זו אותה קנייה, לא רושמים אותה שוב.</span>`
              : html`<span>יש בקשת תשלום ״${reqTwin.q.title}״ שהכסף שלה מחכה בקופה. אם זו הקנייה שלה — רושמים אותה מהבקשה (🧾 רישום הקנייה), כדי שמה שנאסף ייספר.</span>`}
            <${Button} size="sm" variant="secondary" onClick=${() => { onClose(); scrollToId('money-requests'); }}>לבקשות התשלום</${Button}>
          </div>`
        : null}

      ${canPot || (exp?.from_pot && potCfg)
        ? html`<div class="pot-toggle" data-testid="expense-from-pot">
            <${Toggle} checked=${fromPot} onChange=${togglePot} disabled=${!canPot} label="💵 שולם מהקופה" hint=${fromPot ? `המזומן יצא מהקופה של ${displayName(byId.get(potCfg.keeper))} — לא נרשם חוב` : 'מזומן מהקופה המשותפת'} />
          </div>`
        : null}

      <${Field} label="מי שילם?" hint=${canPickPayer ? 'כמנהל/ת אפשר לרשום הוצאה גם בשם מישהו אחר' : null}>
        ${canPickPayer
          ? html`<${MemberPicker} members=${members} value=${paidBy} onChange=${(id) => id && pickPayer(id)} label="מי שילם?" />`
          : html`<div class="money-payer">
              <${Avatar} member=${payer} size=${32} />
              <strong>${paidBy === me.id ? `${YOU} (${displayName(me)})` : displayName(payer)}</strong>
            </div>`}
        ${payerSplits
          ? html`<div class="money-payer-person" role="group" aria-label="מי מאיתנו שילם?" data-testid="expense-payer-person">
              ${(payer.people || []).map((n) => html`<${Chip} key=${n} active=${payPerson === n} onClick=${() => setPayPerson(n)}>${n}</${Chip}>`)}
              <${Chip} active=${!(payer.people || []).includes(payPerson)} onClick=${() => setPayPerson(null)}>💑 ביחד</${Chip}>
            </div>`
          : null}
      </${Field}>

      ${tagChips
        ? html`<${Field} label="סוג ההוצאה (לא חובה)">
            <div class="h-scroll money-cats money-tags" data-testid="expense-tags">
              ${tagChips.map((t) => html`<${Chip}
                key=${t.n}
                active=${tag === t.n}
                data-tag=${t.n}
                onClick=${() => setTag(tag === t.n ? null : t.n)}
              ><span aria-hidden="true">${t.e}</span> ${t.n}</${Chip}>`)}
            </div>
          </${Field}>`
        : snap.categories.length
        ? html`<${Field} label="קטגוריה (לא חובה)">
            <div class="h-scroll money-cats">
              ${[...snap.categories].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).map((c) => html`<${Chip}
                key=${c.id}
                active=${categoryId === c.id}
                onClick=${() => setCategoryId(categoryId === c.id ? null : c.id)}
              ><span aria-hidden="true">${c.emoji || '📦'}</span> ${c.name}</${Chip}>`)}
            </div>
          </${Field}>`
        : null}

      <${Field} label="על מי זה מתחלק?" error=${errors.members}>
        <div class="stack">
          <${Segmented}
            label="אופן החלוקה"
            value=${mode}
            onChange=${(v) => {
              setMode(v);
              // starts from whoever shares "כולם": the exempt aren't ticked (they can be added by hand)
              if (v === 'members' && chosen.length <= 1) setChosen(payingMembers(snap).map((m) => ({ member_id: m.id })));
              if (errors.members) setErrors({ ...errors, members: null });
            }}
            options=${[
              { value: 'all', label: '👥 כולם (לפי ראשים)' },
              { value: 'members', label: '🙋 רק חלק / כולם חוץ מ…' },
            ]}
          />
          ${mode === 'members'
            ? html`<${MemberPicker} members=${members} value=${chosenIds} onChange=${(ids) => { setChosenIds(ids); if (errors.members) setErrors({ ...errors, members: null }); }} multi label="מי משתתף/ת?"
                tags=${new Map((snap.trip.settings?.money?.exempt || []).map((id) => [id, '🎁 פטור/ה']))} />
              ${chosenIds.some((id) => (snap.trip.settings?.money?.exempt || []).includes(id))
                ? html`<p class="tiny muted" data-testid="expense-exempt-note">🎁 מי שפטור/ה וסומן/ה כאן — כן משלם/ת על ההוצאה הזו</p>` : null}`
            : null}
        </div>
      </${Field}>

      <${SplitPreview}
        valid=${valid}
        shares=${shares}
        perHead=${perHead}
        heads=${heads}
        units=${participants.length}
        customWeights=${customWeights}
        byId=${byId}
        me=${me}
      />

      ${admin && snap.trip.settings?.groom
        ? html`<${Toggle} checked=${secret} onChange=${setSecret} label="🤫 הפתעה — בלי החוגג/ת"
            hint="למשל מתנה: ההוצאה לא תוצג לחוגג/ת" data-testid="expense-secret" />` : null}

      <div class="grid-2 money-form__extra">
        <${Field} label="מתי?">
          <${TextInput} type="date" value=${spentOn} max=${todayYmd()} onInput=${(e) => setSpentOn(e.target.value)} />
        </${Field}>
        <${Field} label="הערה">
          <${TextInput} value=${note} maxLength=${500} placeholder="לא חובה" onInput=${(e) => setNote(e.target.value)} />
        </${Field}>
      </div>

      ${editing
        ? html`<div class="money-form__danger">
            <${Button} variant="ghost" size="sm" icon="trash" class="money-danger-link" loading=${deleting} disabled=${saving} onClick=${remove}>מחיקת ההוצאה</${Button}>
          </div>`
        : null}
    </form>
  </${Sheet}>`;
}

function SplitPreview({ valid, shares, perHead, heads, units, customWeights, byId, me }) {
  if (!valid) {
    return html`<div class="split-preview is-idle" data-testid="split-preview">
      <span class="split-preview__emoji" aria-hidden="true">🧮</span>
      <span class="small muted">הקלידו סכום ונראה כמה יוצא לכל אחד</span>
    </div>`;
  }
  return html`<div class="split-preview" data-testid="split-preview" aria-live="polite">
    <div class="split-preview__head">
      ${perHead !== null
        ? html`<span>יוצא <strong class="split-preview__big" data-testid="split-per-head"><${Money} value=${perHead} /></strong> לאדם</span>
            <span class="small muted">${hebrewCount(heads, 'איש', 'אנשים')}${units < heads ? ' · זוג משלם כפול' : ''}</span>`
        : html`<span>חלוקה לפי משקלים שנקבעו</span>`}
    </div>
    <ul class="split-preview__list">
      ${shares.map((s) => {
        const m = byId.get(s.member_id);
        return html`<li key=${s.member_id} class=${cx('split-chip', s.member_id === me.id && 'is-me')} data-testid="split-share" data-member-id=${s.member_id}>
          <${Avatar} member=${m} size=${24} />
          <span class="split-chip__name">${s.member_id === me.id ? YOU : displayName(m)}</span>
          <${Money} value=${s.amount} class="split-chip__amount" />
        </li>`;
      })}
    </ul>
  </div>`;
}

/** "שילמת" / "שולם ע״י …" — and, in a couple that pays each their own part (§19), which of them. */
function paidByText(exp, payer, me, snap) {
  if (splitsMoney(payer)) {
    const person = (payer.people || []).includes(exp.paid_by_person) ? exp.paid_by_person : null;
    if (!person) return exp.paid_by === me.id ? 'שילמתם ביחד' : `שולם ביחד ע״י ${displayName(payer)}`;
    return exp.paid_by === me.id && person === snap.me?.person ? 'שילמת' : `שילם/ה: ${person}`;
  }
  return exp.paid_by === me.id ? 'שילמת' : `שולם ע״י ${displayName(payer)}`;
}

function ExpenseDetails({ open, exp, snap, me, onClose }) {
  const byId = membersById(snap.members);
  const cat = snap.categories.find((c) => c.id === exp.category_id);
  const tag = exp.tag ? tagOf(tripTags(snap.trip), exp.tag) : null;
  const shares = expenseShares(exp, snap);
  const payer = byId.get(exp.paid_by);
  const footer = html`<${Button} variant="secondary" onClick=${onClose}>סגירה</${Button}>`;
  return html`<${Sheet} open=${open} onClose=${onClose} title=${exp.title} footer=${footer} class="money-sheet">
    <div class="stack-lg">
      <div class="money-detail">
        <${Money} value=${exp.amount} class="money-detail__amount" />
        <div class="money-detail__meta">
          <span class="row"><${Avatar} member=${payer} size=${24} /> ${paidByText(exp, payer, me, snap)}</span>
          <span class="small muted">${dayLabel(exp.spent_on)}${tag ? ` · ${tag.e} ${tag.n}` : cat ? ` · ${cat.emoji || '📦'} ${cat.name}` : ''} · ${splitText(exp, snap)}</span>
          ${exp.note ? html`<span class="small">📝 ${exp.note}</span>` : null}
        </div>
      </div>
      <div class="split-preview">
        <div class="split-preview__head"><span>איך זה מתחלק</span></div>
        <ul class="split-preview__list">
          ${shares.map((s) => html`<li key=${s.member_id} class=${cx('split-chip', s.member_id === me.id && 'is-me')} data-testid="split-share">
            <${Avatar} member=${byId.get(s.member_id)} size=${24} />
            <span class="split-chip__name">${s.member_id === me.id ? YOU : displayName(byId.get(s.member_id))}</span>
            <${Money} value=${s.amount} class="split-chip__amount" />
          </li>`)}
        </ul>
      </div>
      <p class="small muted money-readonly" data-testid="expense-readonly">🔒 רק מי ששילם/ה, מי שרשם/ה או מנהל/ת יכולים לערוך את ההוצאה הזו.</p>
    </div>
  </${Sheet}>`;
}

// ---------------------------------------------------------------------------
// payment sheet: "שילמתי" / "קיבלתי" / admin record / free-form record
// ---------------------------------------------------------------------------

const PAY_COPY = {
  paid: { title: 'סימון תשלום 💸', cta: 'כן, שילמתי ✓' },
  received: { title: 'קיבלתי כסף 💰', cta: 'קיבלתי ✓' },
  admin: { title: 'רישום העברה 📝', cta: 'רישום ההעברה' },
  free: { title: 'רישום העברה 📝', cta: 'רישום ההעברה' },
};

function PaymentSheet({ open, data, snap, me, byId, myKey, nameOf, onClose, onSaved }) {
  const kind = data?.kind || 'free';
  const [amount, setAmount] = useState(data?.amount ?? null);
  const [method, setMethod] = useState('bit');
  const [note, setNote] = useState('');
  const [dir, setDir] = useState('paid');
  const [other, setOther] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  // from / to are settle-up parties: a profile id, or `${member_id}::${person}` (a couple that pays each their own part)
  let fromKey = data?.from || null;
  let toKey = data?.to || null;
  if (kind === 'free') {
    fromKey = dir === 'paid' ? me.id : other;
    toKey = dir === 'paid' ? other : me.id;
  }
  const fromParty = partyOf(fromKey);
  const toParty = partyOf(toKey);
  const fromId = fromKey ? fromParty.member_id : null;
  const toId = toKey ? toParty.member_id : null;
  const from = byId.get(fromId);
  const to = byId.get(toId);
  const label = (key) => (nameOf ? nameOf(key) : key === me.id ? YOU : displayName(byId.get(key)));
  const others = snap.members.filter((m) => m.id !== me.id);
  const copy = PAY_COPY[kind] || PAY_COPY.free;

  let hint = '';
  if (kind === 'paid' || (kind === 'free' && dir === 'paid')) {
    hint = to ? `נשלח ל${toParty.person || displayName(to)} התראה לאישור קבלה 🔔` : '';
  } else if (kind === 'received' || (kind === 'free' && dir === 'received')) {
    hint = 'ההעברה תירשם כמאושרת ✅';
  } else if (kind === 'admin') {
    hint = to ? `נשלח ל${toParty.person || displayName(to)} התראה לאישור קבלה 🔔` : '';
  }

  const save = async () => {
    if (saving) return;
    const errs = {};
    const amountErr = moneyError(amount);
    if (amountErr) errs.amount = amountErr;
    if (!fromId || !toId) errs.other = dir === 'paid' ? 'למי העברת?' : 'ממי קיבלת?';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    const received = toKey === (myKey || me.id) || (toId === me.id && fromId !== me.id);
    const success = fromKey === (myKey || me.id) || (fromId === me.id && !fromParty.person)
      ? `סימנת ששילמת ${formatMoney(amount)} ל${label(toKey)} 💸`
      : received
        ? `נרשם שקיבלת ${formatMoney(amount)} מ${label(fromKey)} ✅`
        : 'ההעברה נרשמה ✅';
    const pay = { from_member: fromId, to_member: toId, amount, method, note: note.trim() || null };
    if (fromParty.person) pay.from_person = fromParty.person;
    if (toParty.person) pay.to_person = toParty.person;
    setSaving(true);
    const res = await actions.run((api) => api.addPayment(snap.trip.id, pay), { success });
    setSaving(false);
    if (res === undefined) return;
    onClose();
    onSaved?.(res);
  };

  // "I paid" from the plan (ux M8): one question — the amount and how stay behind "שינוי"
  const quick = kind === 'paid' && data?.amount > 0 && Boolean(to);
  const fieldsNode = html`      <${Field} label="כמה?" error=${errors.amount} hint=${data?.amount ? `לפי ההתחשבנות: ${formatMoney(data.amount)}` : null}>
        <${MoneyInput} value=${amount} onChange=${(v) => { setAmount(v); if (errors.amount) setErrors({ ...errors, amount: null }); }} />
      </${Field}>

      <${Field} label="איך?">
        <div class="money-methods">
          ${METHODS.map((m) => html`<${Chip} key=${m.value} active=${method === m.value} onClick=${() => setMethod(m.value)}>
            <span aria-hidden="true">${m.emoji}</span> ${m.label}
          </${Chip}>`)}
        </div>
      </${Field}>

      <${Field} label="הערה">
        <${TextInput} value=${note} maxLength=${500} placeholder="לא חובה — למשל: על הבשר 🥩" onInput=${(e) => setNote(e.target.value)} />
      </${Field}>`;

  const footer = html`
    <${Button} variant="secondary" onClick=${onClose} disabled=${saving}>ביטול</${Button}>
    <${Button} variant="primary" loading=${saving} onClick=${save} data-testid="payment-save">${copy.cta}</${Button}>`;

  return html`<${Sheet} open=${open} onClose=${onClose} title=${copy.title} footer=${footer} class="money-sheet">
    <form class="stack-lg money-form" onSubmit=${(e) => { e.preventDefault(); save(); }} novalidate>
      ${kind === 'free'
        ? html`<div class="stack">
            <${Segmented}
              label="כיוון ההעברה"
              value=${dir}
              onChange=${(v) => { setDir(v); setErrors({}); }}
              options=${[{ value: 'paid', label: '💸 שילמתי ל…' }, { value: 'received', label: '💰 קיבלתי מ…' }]}
            />
            <${Field} label=${dir === 'paid' ? 'למי?' : 'ממי?'} error=${errors.other}>
              <${MemberPicker} members=${others} value=${other} onChange=${(id) => { setOther(id); setErrors({ ...errors, other: null }); }} label=${dir === 'paid' ? 'למי?' : 'ממי?'} />
            </${Field}>
          </div>`
        : null}

      ${from && to
        ? html`<div class="pay-hero" data-testid="pay-hero">
            <div class="pay-hero__side">
              <${Avatar} member=${from} size=${56} />
              <span class="pay-hero__name">${label(fromKey)}</span>
            </div>
            <div class="pay-hero__flow" aria-hidden="true">
              <span class="pay-hero__coin">₪</span>
              <span class="pay-hero__track"></span>
            </div>
            <div class="pay-hero__side">
              <${Avatar} member=${to} size=${56} />
              <span class="pay-hero__name">${label(toKey)}</span>
            </div>
          </div>`
        : null}

      ${quick
        ? html`<p class="pay-ask" data-testid="pay-ask">שילמת <b><${Money} value=${amount} /></b> ל${label(toKey)} ב${methodOf(method).label}?</p>
          <details class="pay-more" open=${Object.values(errors).some(Boolean) || undefined}>
            <summary class="link pay-more__toggle">שינוי סכום או אמצעי ‹</summary>
            <div class="stack">${fieldsNode}</div>
          </details>`
        : fieldsNode}

      ${hint ? html`<p class="small muted money-pay-hint">${hint}</p>` : null}
    </form>
  </${Sheet}>`;
}
