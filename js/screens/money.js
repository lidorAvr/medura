// Money (SPEC §8.7): my balance, "who pays whom", payments, expenses, per-member table,
// plus the new/edit expense sheet and the "I paid / I got it" payment sheet.
// Every number comes from logic.js (balances, settlePlan, expenseShares, tripTotals).
import { html } from 'htm/preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { actions, store, useTrip } from '../store.js?v=d288b77';
import { navigate } from '../router.js?v=d288b77';
import {
  balances, buildSummaryText, displayName, expenseShares, formatDate, formatMoney, headcountTotal, hebrewCount,
  membersById, settlePlan, timeAgo, tripTotals, whatsappChatUrl,
} from '../lib/logic.js?v=d288b77';
import {
  Avatar, Button, Card, Chip, CopyButton, EmptyState, Fab, Field, IconButton, MemberPicker, MoneyInput, Pill,
  ProgressBar, Segmented, ShareButton, Sheet, Skeleton, TextInput, confirmDialog, fireConfetti,
} from '../ui/components.js?v=d288b77';
import { Icon } from '../ui/icons.js?v=d288b77';
import { CURRENCIES, rateOn, symbolOf, toShekels } from '../lib/fx.js?v=d288b77';
import { MoneyRequests } from './money-requests.js?v=d288b77';

const cx = (...a) => a.filter(Boolean).join(' ');

/** |balance| under ₪1 counts as settled — settlePlan drops transfers under ₪1 too. */
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
  document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
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

  const model = useMemo(() => {
    if (!ready) return null;
    const bals = balances(snap);
    return {
      bals,
      plan: settlePlan(bals),
      totals: tripTotals(snap),
      byId: membersById(snap.members),
      mine: bals.find((b) => b.member_id === me.id) || null,
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

  const { bals, plan, totals, byId, mine, balById } = model;
  const nameOf = (id) => (id === me.id ? YOU : displayName(byId.get(id)));
  const active = snap.expenses.length > 0 || snap.payments.length > 0;

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
    const before = mine?.balance ?? 0;
    const after = store.get().snap;
    if (!after || after.trip?.id !== tripId) return;
    const now = balances(after).find((b) => b.member_id === me.id);
    if (before <= -EVEN_BELOW && now && Math.abs(now.balance) < EVEN_BELOW) fireConfetti();
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
      text: `${nameOf(p.from_member)} ← ${nameOf(p.to_member)} · ${formatMoney(p.amount)}. ההתחשבנות תחושב מחדש.`,
      confirmText: 'כן, למחוק',
      danger: true,
    });
    if (!ok) return;
    setBusyId(p.id);
    await actions.run((api) => api.deletePayment(p.id), { success: 'ההעברה נמחקה' });
    setBusyId(null);
  };

  return html`<div class="screen money">
    <${Hero}
      snap=${snap}
      me=${me}
      mine=${mine}
      totals=${totals}
      plan=${plan}
      active=${active}
      onAdd=${() => openExpense({})}
    />

    <${MoneyRequests} snap=${snap} me=${me} admin=${admin} />

    ${active ? html`<${PayStyle} me=${me} />` : null}

    ${active
      ? html`<${SettleCard}
          snap=${snap}
          me=${me}
          admin=${admin}
          plan=${plan}
          bals=${bals}
          byId=${byId}
          nameOf=${nameOf}
          onPay=${openPay}
        />`
      : html`<${HowItWorks} />`}

    ${snap.payments.length
      ? html`<${PaymentsSection}
          snap=${snap}
          me=${me}
          admin=${admin}
          byId=${byId}
          nameOf=${nameOf}
          busyId=${busyId}
          onConfirm=${confirmPayment}
          onDelete=${deletePayment}
        />`
      : null}

    <${ExpensesSection}
      snap=${snap}
      me=${me}
      byId=${byId}
      totals=${totals}
      flashId=${flashId}
      onOpen=${(expense) => openExpense({ expense })}
      onAdd=${active ? () => openExpense({}) : null}
    />

    ${active ? html`<${MembersTable} snap=${snap} me=${me} balById=${balById} />` : null}

    <div class="money__fab-space" aria-hidden="true"></div>
    <${Fab} icon="🧾" label="הוצאה חדשה" onClick=${() => openExpense({})} />

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

function Hero({ snap, me, mine, totals, plan, active, onAdd }) {
  const balance = mine?.balance ?? 0;
  const state = !active ? 'empty' : balance >= EVEN_BELOW ? 'credit' : balance <= -EVEN_BELOW ? 'debt' : 'even';
  const animated = useCountUp(Math.abs(balance));

  if (state === 'empty') {
    return html`<section class="money-hero money-hero--empty" data-testid="money-hero" data-state="empty" aria-labelledby="money-hero-title">
      <span class="money-hero__art" aria-hidden="true">🧾</span>
      <div class="money-hero__kicker">💸 הקופה של הטיול</div>
      <h1 class="money-hero__title" id="money-hero-title">עוד לא נרשמו הוצאות</h1>
      <p class="money-hero__text">קניתם משהו לטיול? רושמים כאן — והחשבון מתחלק לבד לפי ראשים.</p>
      <div class="money-hero__cta">
        <${Button} variant="secondary" icon="plus" onClick=${onAdd}>הוספת הוצאה ראשונה</${Button}>
      </div>
    </section>`;
  }

  const toMe = plan.filter((t) => t.to === me.id).length;
  const fromMe = plan.filter((t) => t.from === me.id).length;
  const parts = [
    html`החלק שלך <${Money} value=${mine?.owed ?? 0} />`,
    html`שילמת <${Money} value=${mine?.paid ?? 0} />`,
  ];
  if (mine?.sent > 0) parts.push(html`העברת <${Money} value=${mine.sent} />`);
  if (mine?.received > 0) parts.push(html`קיבלת <${Money} value=${mine.received} />`);

  const art = { credit: '💰', debt: '💸', even: '✨' }[state];
  return html`<section class=${`money-hero money-hero--${state}`} data-testid="money-hero" data-state=${state} aria-labelledby="money-hero-title">
    <span class="money-hero__art" aria-hidden="true">${art}</span>
    <div class="money-hero__kicker">💸 הקופה של הטיול</div>
    ${state === 'even'
      ? html`<h1 class="money-hero__title money-hero__title--even" id="money-hero-title" data-testid="money-balance-label">את/ה מאוזנ/ת ✨</h1>`
      : html`<h1 class="money-hero__balance" id="money-hero-title">
          <span class="money-hero__label" data-testid="money-balance-label">${state === 'credit' ? 'מגיע לך' : 'עליך להעביר'}</span>
          <span class="money-hero__amount" data-testid="money-balance-amount" aria-hidden="true"><${Money} value=${animated} /></span>
          <span class="sr-only">${formatMoney(Math.abs(balance))}</span>
        </h1>`}
    <p class="money-hero__breakdown" data-testid="money-breakdown">
      ${parts.map((p, i) => html`${i ? html`<span class="money-hero__sep" aria-hidden="true"> · </span>` : null}<span>${p}</span>`)}
    </p>
    ${state === 'debt' && fromMe
      ? html`<div class="money-hero__cta"><${Button} variant="secondary" size="sm" icon="chevron-down" onClick=${() => scrollToId('money-settle')}>למי מעבירים?</${Button}></div>`
      : state === 'credit' && toMe
        ? html`<div class="money-hero__cta"><${Button} variant="secondary" size="sm" icon="chevron-down" onClick=${() => scrollToId('money-settle')}>
            ${toMe === 1 ? 'מחכה לך העברה אחת' : `מחכות לך ${toMe} העברות`}
          </${Button}></div>`
        : null}
    <dl class="money-hero__stats">
      <div class="money-stat">
        <dt class="money-stat__label">סה״כ הוצאות</dt>
        <dd class="money-stat__value" data-testid="money-total"><${Money} value=${totals.spent} /></dd>
      </div>
      <div class="money-stat">
        <dt class="money-stat__label">לאדם</dt>
        <dd class="money-stat__value" data-testid="money-per-head"><${Money} value=${totals.perHead} /></dd>
      </div>
      <div class="money-stat">
        <dt class="money-stat__label">משתתפים</dt>
        <dd class="money-stat__value num" data-testid="money-heads">${totals.heads}</dd>
      </div>
    </dl>
  </section>`;
}

function HowItWorks() {
  const steps = [
    ['🧾', 'מי שקונה משהו לטיול — רושם/ת כאן הוצאה'],
    ['👫', 'החשבון מתחלק אוטומטית לפי ראשים: זוג = 2 חלקים'],
    ['🤝', 'בסוף רואים מי מעביר למי, ומסמנים ״שילמתי ✓״'],
  ];
  return html`<${Card} title="איך זה עובד?" emoji="💡">
    <ol class="money-how">
      ${steps.map(([emoji, text]) => html`<li class="money-how__step"><span class="kbd-emoji" aria-hidden="true">${emoji}</span><span>${text}</span></li>`)}
    </ol>
  </${Card}>`;
}

// ---------------------------------------------------------------------------
// settle plan: who pays whom
// ---------------------------------------------------------------------------

function Pair({ from, to, size = 34 }) {
  return html`<span class="money-pair" aria-hidden="true">
    <${Avatar} member=${from} size=${size} />
    <span class="money-pair__arrow"><${Icon} name="arrow-left" size=${16} /></span>
    <${Avatar} member=${to} size=${size} />
  </span>`;
}

function SettleCard({ snap, me, admin, plan, bals, byId, nameOf, onPay }) {
  const trip = snap.trip;
  const rank = (t) => (t.from === me.id ? 0 : t.to === me.id ? 1 : 2);
  const rows = [...plan].sort((a, b) => rank(a) - rank(b));

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
              <span>הועברו <${Money} value=${sentCents / 100} /> מתוך <${Money} value=${(sentCents + leftCents) / 100} /></span>
              <strong class="num">${pct}%</strong>
            </div>
            <${ProgressBar} value=${pct} tone="success" label="התקדמות ההתחשבנות" />
          </div>`
        : null}

      ${rows.length
        ? html`<ul class="settle-list" data-testid="settle-list">
            ${rows.map((t) => html`<${SettleRow}
              key=${`${t.from}>${t.to}`}
              t=${t}
              trip=${trip}
              me=${me}
              admin=${admin}
              from=${byId.get(t.from)}
              to=${byId.get(t.to)}
              nameOf=${nameOf}
              onPay=${onPay}
            />`)}
          </ul>
          <p class="tiny muted money-note">הסכומים מעוגלים לשקל. אחרי ההעברה מסמנים כאן — וזה יורד מהחשבון.</p>`
        : html`<div class="money-settled" data-testid="settle-empty">
            <span class="money-settled__emoji" aria-hidden="true">🎉</span>
            <div>
              <strong>כולם מאוזנים!</strong>
              <div class="small muted">אין צורך בהעברות — נתראה במדורה 🔥</div>
            </div>
          </div>`}

      <div class="money-settle__foot">
        <${ShareButton} text=${summary} label="שתף התחשבנות" size="sm" />
        <${Button} variant="ghost" size="sm" icon="plus" onClick=${() => onPay({ kind: 'free' })}>רישום העברה</${Button}>
      </div>
    </${Card}>
  </section>`;
}

/** Whole shekels split as evenly as possible (the first ones get the extra shekel). */
function splitWhole(amount, n) {
  const total = Math.round(Number(amount) || 0);
  const base = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => base + (i < total - base * n ? 1 : 0));
}

/** How a profile of 2+ pays its share: one transfer, or each person their part (prefs.pay). */
function PayStyle({ me }) {
  const [busy, setBusy] = useState(false);
  if ((me.people || []).length < 2) return null;
  const value = me.prefs?.pay === 'each' ? 'each' : 'together';
  const set = async (v) => {
    if (v === value) return;
    setBusy(true);
    await actions.run(async (api) => { await api.updateMember(me.id, { prefs: { pay: v } }); return true; },
      { success: v === 'each' ? 'מעכשיו כל אחד רואה ומעביר את החלק שלו 🙋' : 'מעכשיו העברה אחת לכולכם 💑' });
    setBusy(false);
  };
  return html`<div class="money-paystyle" data-testid="pay-style">
    <span class="small"><b>איך אתם משלמים?</b></span>
    <${Segmented} label="איך אתם משלמים?" value=${value} onChange=${set} disabled=${busy}
      options=${[{ value: 'together', label: '💑 קופה אחת' }, { value: 'each', label: '🙋 כל אחד לחוד' }]} />
  </div>`;
}

function SettleRow({ t, trip, me, admin, from, to, nameOf, onPay }) {
  const mineOut = t.from === me.id;
  const mineIn = t.to === me.id;
  const tripLabel = `${trip.emoji || '⛺'} ${trip.name}`;
  let actionsNode = null;

  if (mineOut) {
    const phone = to?.phone;
    const chat = phone ? whatsappChatUrl(phone, `היי! לגבי ${tripLabel} — מעביר/ה לך ${formatMoney(t.amount)} 💸`) : null;
    actionsNode = html`<div class="settle-row__actions">
      <${Button} onClick=${() => onPay({ kind: 'paid', from: t.from, to: t.to, amount: t.amount })}>שילמתי ✓</${Button}>
      ${phone
        ? html`<${CopyButton} text=${copyablePhone(phone)} size="sm" label=${html`<bdi dir="ltr">${prettyPhone(phone)}</bdi>`} />`
        : null}
      ${chat
        ? html`<${Button} variant="share" size="sm" icon="send" href=${chat} target="_blank" rel="noopener noreferrer">וואטסאפ</${Button}>`
        : null}
      ${!phone
        ? html`<p class="settle-row__hint tiny muted">ל${nameOf(t.to)} אין מספר בפרופיל — בקשו אותו בקבוצה 🙂</p>`
        : null}
    </div>`;
  } else if (mineIn) {
    const myPhone = me.phone ? prettyPhone(me.phone) : '';
    const nudge = from?.phone
      ? whatsappChatUrl(
        from.phone,
        `היי! 🙂 לפי ההתחשבנות במדורה (${tripLabel}) נשאר ${formatMoney(t.amount)} להעביר לי${myPhone ? ` — אפשר בביט ל-${myPhone}` : ''} 🙏`,
      )
      : null;
    actionsNode = html`<div class="settle-row__actions">
      <${Button} variant="primary" onClick=${() => onPay({ kind: 'received', from: t.from, to: t.to, amount: t.amount })}>קיבלתי ✓</${Button}>
      ${nudge
        ? html`<${Button} variant="secondary" size="sm" icon="send" href=${nudge} target="_blank" rel="noopener noreferrer">תזכורת עדינה</${Button}>`
        : null}
    </div>`;
  } else if (admin) {
    actionsNode = html`<div class="settle-row__admin">
      <${Button} variant="ghost" size="sm" icon="check" onClick=${() => onPay({ kind: 'admin', from: t.from, to: t.to, amount: t.amount })}>סימון ששולם</${Button}>
    </div>`;
  }

  return html`<li class=${cx('settle-row', mineOut && 'is-out', mineIn && 'is-in')} data-testid="settle-row">
    <div class="settle-row__top">
      <${Pair} from=${from} to=${to} />
      <div class="settle-row__main">
        <span class="settle-row__who"><span class="money-name">${nameOf(t.from)}</span> <span class="settle-row__arrow" aria-hidden="true">←</span><span class="sr-only">מעביר/ה ל</span> <span class="money-name">${nameOf(t.to)}</span></span>
        ${mineOut ? html`<span class="settle-row__tag">👈 ההעברה שלך</span>` : null}
        ${mineIn ? html`<span class="settle-row__tag">💚 מגיע לך</span>` : null}
      </div>
      <${Money} value=${t.amount} class="settle-row__amount" />
    </div>
    ${from?.prefs?.pay === 'each' && (from.people || []).length > 1
      ? html`<p class="settle-row__each small" data-testid="settle-each">כל אחד לחוד: ${splitWhole(t.amount, from.people.length)
          .map((a, i) => `${from.people[i]} ${formatMoney(a)}`).join(' · ')}</p>`
      : null}
    ${actionsNode}
  </li>`;
}

// ---------------------------------------------------------------------------
// payments
// ---------------------------------------------------------------------------

function PaymentsSection({ snap, me, admin, byId, nameOf, busyId, onConfirm, onDelete }) {
  const [all, setAll] = useState(false);
  const list = [...snap.payments].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const shown = all ? list : list.slice(0, PAYMENTS_PREVIEW);
  const waiting = list.filter((p) => p.status !== 'confirmed' && (p.to_member === me.id || admin)).length;

  return html`<section class="money-section" aria-labelledby="money-pay-title">
    <div class="money-section__head">
      <h2 class="money-section__title" id="money-pay-title"><span aria-hidden="true">💳</span> העברות</h2>
      <span class="section__count num">${list.length}</span>
      ${waiting ? html`<${Pill} tone="warning">${waiting} מחכות לאישור</${Pill}>` : null}
    </div>
    <ul class="list money-pay-list" data-testid="payments-list">
      ${shown.map((p) => {
        const confirmed = p.status === 'confirmed';
        const canConfirm = !confirmed && (p.to_member === me.id || admin);
        const canDelete = admin || (p.created_by === me.id && !confirmed);
        const m = methodOf(p.method);
        const busy = busyId === p.id;
        return html`<li key=${p.id} class="pay-row" data-testid="payment-row" data-status=${p.status}>
          <${Pair} from=${byId.get(p.from_member)} to=${byId.get(p.to_member)} size=${28} />
          <div class="pay-row__main">
            <span class="pay-row__who"><span class="money-name">${nameOf(p.from_member)}</span> <span aria-hidden="true">←</span><span class="sr-only">העביר/ה ל</span> <span class="money-name">${nameOf(p.to_member)}</span></span>
            <span class="pay-row__sub">${m.emoji} ${m.label}${p.note ? html` · <span class="pay-row__note">${p.note}</span>` : null} · ${timeAgo(p.created_at)}</span>
            ${canConfirm
              ? html`<${Button} size="sm" icon="check" class="pay-row__confirm" loading=${busy} onClick=${() => onConfirm(p)}>
                  ${p.to_member === me.id ? 'הכסף הגיע' : 'אישור קבלה'}
                </${Button}>`
              : null}
          </div>
          <div class="pay-row__end">
            <${Money} value=${p.amount} class="pay-row__amount" />
            <${Pill} tone=${confirmed ? 'success' : 'warning'}>${confirmed ? 'אושר ✅' : 'נשלח ⏳'}</${Pill}>
            ${canDelete
              ? html`<${IconButton} icon="trash" size=${18} label="מחיקת ההעברה" class="pay-row__delete" disabled=${busy} onClick=${() => onDelete(p)} />`
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
  return `כולם · ${hebrewCount(headcountTotal(snap.members), 'איש', 'אנשים')}`;
}

function sortExpenses(list) {
  return [...list].sort((a, b) => String(b.spent_on).localeCompare(String(a.spent_on))
    || String(b.created_at).localeCompare(String(a.created_at)));
}

function ExpensesSection({ snap, me, byId, totals, flashId, onOpen, onAdd }) {
  const cats = new Map(snap.categories.map((c) => [c.id, c]));
  const list = sortExpenses(snap.expenses);

  return html`<section class="money-section" aria-labelledby="money-exp-title">
    <div class="money-section__head">
      <h2 class="money-section__title" id="money-exp-title"><span aria-hidden="true">🧾</span> הוצאות</h2>
      ${list.length ? html`<span class="section__count num">${list.length}</span>` : null}
      <span class="spacer"></span>
      ${list.length ? html`<span class="money-section__sum">סה״כ <${Money} value=${totals.spent} /></span>` : null}
    </div>
    ${list.length
      ? html`<ul class="list money-exp-list" data-testid="expenses-list">
          ${list.map((e) => {
            const payer = byId.get(e.paid_by);
            const cat = cats.get(e.category_id);
            const myShare = expenseShares(e, snap).find((s) => s.member_id === me.id)?.amount || 0;
            const who = e.paid_by === me.id ? 'שילמת' : `שולם ע״י ${displayName(payer)}`;
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
                  <span class="exp-row__cat">${cat?.emoji || '🧾'}</span>
                </span>
                <span class="list-row__main">
                  <span class="list-row__title">${e.title}</span>
                  <span class="list-row__sub">${who} · <span class="exp-row__split" data-testid="expense-split">${splitText(e, snap)}</span></span>
                  <span class="list-row__sub exp-row__meta">${dayLabel(e.spent_on)}${e.note ? html` · <span class="exp-row__note">📝 ${e.note}</span>` : null}</span>
                </span>
                <span class="exp-row__end">
                  <${Money} value=${e.amount} class="exp-row__amount" data-testid="expense-amount" />
                  ${e.currency ? html`<span class="exp-row__orig num" dir="ltr">${symbolOf(e.currency)}${Number(e.orig_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>` : null}
                  ${myShare > 0 ? html`<span class="exp-row__mine">חלקך <${Money} value=${myShare} /></span>` : null}
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

function MembersTable({ snap, me, balById }) {
  return html`<section class="money-section" aria-labelledby="money-table-title">
    <div class="money-section__head">
      <h2 class="money-section__title" id="money-table-title"><span aria-hidden="true">📊</span> מאזן לפי חבר׳ה</h2>
    </div>
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
            const tone = b.balance >= EVEN_BELOW ? 'plus' : b.balance <= -EVEN_BELOW ? 'minus' : 'even';
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
              <td data-col="balance" class=${`money-table__bal is-${tone}`}><${Money} value=${b.balance} signed /></td>
            </tr>`;
          })}
        </tbody>
      </table>
    </div>
    <p class="tiny muted money-note">יתרה = מה ששילמו − החלק שלהם, כולל העברות שכבר סומנו. פלוס = מגיע להם.</p>
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
    snap=${snap}
    me=${me}
    admin=${admin}
    onClose=${onClose}
    onSaved=${onSaved}
    onDeleting=${onDeleting}
  />`;
}

function ExpenseForm({ open, exp, editing, snap, me, admin, onClose, onSaved, onDeleting }) {
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
  const [paidBy, setPaidBy] = useState(exp?.paid_by || me.id);
  const [categoryId, setCategoryId] = useState(exp?.category_id || null);
  const [mode, setMode] = useState(exp?.split_mode === 'members' ? 'members' : 'all');
  const [chosen, setChosen] = useState(initialChosen);
  const [note, setNote] = useState(exp?.note || '');
  const [spentOn, setSpentOn] = useState(exp?.spent_on ? String(exp.spent_on).slice(0, 10) : todayYmd());
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
      } else setRateState('failed');
    });
    return () => { alive = false; };
  }, [cur, spentOn, foreign]);

  const chosenIds = chosen.map((c) => c.member_id);
  const setChosenIds = (ids) => setChosen(ids.map((id) => chosen.find((c) => c.member_id === id) || { member_id: id }));

  // Live preview (logic.js: expenseShares / tripTotals).
  const participants = mode === 'all' ? members : chosenIds.map((id) => byId.get(id)).filter(Boolean);
  const valid = amountIls > 0 && amountIls <= MAX_AMOUNT && participants.length > 0;
  const draft = { amount: valid ? amountIls : 0, split_mode: mode, members: mode === 'members' ? chosen : undefined };
  const shares = valid ? expenseShares(draft, snap) : [];
  const customWeights = mode === 'members' && chosen.some((c) => c.weight != null && Number(c.weight) !== (Number(byId.get(c.member_id)?.headcount) || 1));
  const perHead = valid && !customWeights ? tripTotals({ members: participants, expenses: [{ amount: amountIls }] }).perHead : null;
  const heads = headcountTotal(participants);

  const payer = byId.get(paidBy);
  const canPickPayer = admin;

  const save = async () => {
    if (saving || deleting) return; // Enter in a field while a call is in flight
    const errs = {};
    const amountErr = foreign
      ? (!(orig > 0) ? 'כמה זה עלה?' : !(rate > 0) ? 'חסר שער — הקלידו אותו ידנית' : moneyError(amountIls))
      : moneyError(amount);
    if (amountErr) errs.amount = amountErr;
    if (!title.trim()) errs.title = 'על מה ההוצאה?';
    if (mode === 'members' && !chosen.length) errs.members = 'בחרו לפחות משתתף/ת אחד/ת';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    const payload = {
      title: title.trim(),
      amount: amountIls,
      currency: foreign ? cur : null,
      ...(foreign ? { orig_amount: orig, rate } : {}),
      category_id: categoryId,
      note: note.trim() || null,
      spent_on: spentOn || todayYmd(),
      split_mode: mode,
    };
    if (canPickPayer) payload.paid_by = paidBy;
    if (mode === 'members') {
      payload.members = chosen.map((c) => (c.weight != null ? { member_id: c.member_id, weight: Number(c.weight) } : { member_id: c.member_id }));
    }
    setSaving(true);
    const res = await actions.run(
      (api) => (editing ? api.updateExpense(exp.id, payload) : api.addExpense(snap.trip.id, payload)),
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
      text: `״${exp.title}״ · ${formatMoney(exp.amount)} — החלוקה תתעדכן לכולם.`,
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
    <${Button} variant="primary" icon="check" loading=${saving} disabled=${deleting} onClick=${save} data-testid="expense-save">
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

      <${Field} label="מי שילם?" hint=${canPickPayer ? 'כמנהל/ת אפשר לרשום הוצאה גם בשם מישהו אחר' : null}>
        ${canPickPayer
          ? html`<${MemberPicker} members=${members} value=${paidBy} onChange=${(id) => id && setPaidBy(id)} label="מי שילם?" />`
          : html`<div class="money-payer">
              <${Avatar} member=${payer} size=${32} />
              <strong>${paidBy === me.id ? `${YOU} (${displayName(me)})` : displayName(payer)}</strong>
            </div>`}
      </${Field}>

      ${snap.categories.length
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
              if (v === 'members' && chosen.length <= 1) setChosen(members.map((m) => ({ member_id: m.id })));
              if (errors.members) setErrors({ ...errors, members: null });
            }}
            options=${[
              { value: 'all', label: '👥 כולם (לפי ראשים)' },
              { value: 'members', label: '🙋 רק חלק / כולם חוץ מ…' },
            ]}
          />
          ${mode === 'members'
            ? html`<${MemberPicker} members=${members} value=${chosenIds} onChange=${(ids) => { setChosenIds(ids); if (errors.members) setErrors({ ...errors, members: null }); }} multi label="מי משתתף/ת?" />`
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

function ExpenseDetails({ open, exp, snap, me, onClose }) {
  const byId = membersById(snap.members);
  const cat = snap.categories.find((c) => c.id === exp.category_id);
  const shares = expenseShares(exp, snap);
  const payer = byId.get(exp.paid_by);
  const footer = html`<${Button} variant="secondary" onClick=${onClose}>סגירה</${Button}>`;
  return html`<${Sheet} open=${open} onClose=${onClose} title=${exp.title} footer=${footer} class="money-sheet">
    <div class="stack-lg">
      <div class="money-detail">
        <${Money} value=${exp.amount} class="money-detail__amount" />
        <div class="money-detail__meta">
          <span class="row"><${Avatar} member=${payer} size=${24} /> ${exp.paid_by === me.id ? 'שילמת' : `שולם ע״י ${displayName(payer)}`}</span>
          <span class="small muted">${dayLabel(exp.spent_on)}${cat ? ` · ${cat.emoji || '📦'} ${cat.name}` : ''} · ${splitText(exp, snap)}</span>
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
  paid: { title: 'סימון תשלום 💸', cta: 'שילמתי ✓' },
  received: { title: 'קיבלתי כסף 💰', cta: 'קיבלתי ✓' },
  admin: { title: 'רישום העברה 📝', cta: 'רישום ההעברה' },
  free: { title: 'רישום העברה 📝', cta: 'רישום ההעברה' },
};

function PaymentSheet({ open, data, snap, me, byId, onClose, onSaved }) {
  const kind = data?.kind || 'free';
  const [amount, setAmount] = useState(data?.amount ?? null);
  const [method, setMethod] = useState('bit');
  const [note, setNote] = useState('');
  const [dir, setDir] = useState('paid');
  const [other, setOther] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  let fromId = data?.from || null;
  let toId = data?.to || null;
  if (kind === 'free') {
    fromId = dir === 'paid' ? me.id : other;
    toId = dir === 'paid' ? other : me.id;
  }
  const from = byId.get(fromId);
  const to = byId.get(toId);
  const label = (id) => (id === me.id ? YOU : displayName(byId.get(id)));
  const others = snap.members.filter((m) => m.id !== me.id);
  const copy = PAY_COPY[kind] || PAY_COPY.free;

  let hint = '';
  if (kind === 'paid' || (kind === 'free' && dir === 'paid')) {
    hint = to ? `נשלח ל${displayName(to)} התראה לאישור קבלה 🔔` : '';
  } else if (kind === 'received' || (kind === 'free' && dir === 'received')) {
    hint = 'ההעברה תירשם כמאושרת ✅';
  } else if (kind === 'admin') {
    hint = to ? `נשלח ל${displayName(to)} התראה לאישור קבלה 🔔` : '';
  }

  const save = async () => {
    if (saving) return;
    const errs = {};
    const amountErr = moneyError(amount);
    if (amountErr) errs.amount = amountErr;
    if (!fromId || !toId) errs.other = dir === 'paid' ? 'למי העברת?' : 'ממי קיבלת?';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    const received = toId === me.id && fromId !== me.id;
    const success = fromId === me.id
      ? `סימנת ששילמת ${formatMoney(amount)} ל${label(toId)} 💸`
      : received
        ? `נרשם שקיבלת ${formatMoney(amount)} מ${label(fromId)} ✅`
        : 'ההעברה נרשמה ✅';
    setSaving(true);
    const res = await actions.run(
      (api) => api.addPayment(snap.trip.id, { from_member: fromId, to_member: toId, amount, method, note: note.trim() || null }),
      { success },
    );
    setSaving(false);
    if (res === undefined) return;
    onClose();
    onSaved?.(res);
  };

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
              <span class="pay-hero__name">${label(fromId)}</span>
            </div>
            <div class="pay-hero__flow" aria-hidden="true">
              <span class="pay-hero__coin">₪</span>
              <span class="pay-hero__track"></span>
            </div>
            <div class="pay-hero__side">
              <${Avatar} member=${to} size=${56} />
              <span class="pay-hero__name">${label(toId)}</span>
            </div>
          </div>`
        : null}

      <${Field} label="כמה?" error=${errors.amount} hint=${data?.amount ? `לפי ההתחשבנות: ${formatMoney(data.amount)}` : null}>
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
      </${Field}>

      ${hint ? html`<p class="small muted money-pay-hint">${hint}</p>` : null}
    </form>
  </${Sheet}>`;
}
