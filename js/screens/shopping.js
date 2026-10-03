// Shopping mode (SPEC §8.5): a full-screen, big-row list of `buy` items for one buyer
// (default: me), grouped by category. Tap toggles "bought" (check + strike + moves down),
// the screen stays awake, and "סיימתי!" records the receipt as a shared expense (+ confetti).
import { html } from 'htm/preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { actions, useTrip } from '../store.js?v=6fb25aa';
import { navigate, href } from '../router.js?v=6fb25aa';
import { displayName, expenseShares, formatMoney, headcountTotal, hebrewCount, itemEffectiveQty, membersById } from '../lib/logic.js?v=6fb25aa';
import {
  Avatar, Button, Chip, EmptyState, Field, IconButton, MemberPicker, MoneyInput, ProgressBar, Segmented, Sheet, Skeleton,
  TextInput, fireConfetti,
} from '../ui/components.js?v=6fb25aa';
import { Icon } from '../ui/icons.js?v=6fb25aa';
import { ChipScroller, cx, groupByCategory, runOk, sortedCategories } from './lists.js?v=6fb25aa';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const SETTLE_MS = 650; // how long a toggled row stays in place before it moves

/** Trip emoji + name, without doubling an emoji the name already carries ("… בכנרת 🌊"). */
const tripLabel = (trip) => {
  const name = String(trip?.name || '');
  const emoji = trip?.emoji || '⛺';
  return name.includes(emoji) ? name : `${emoji} ${name}`;
};

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

function buildShop(snap, me) {
  const members = snap.members || [];
  const byMember = membersById(members);
  const cats = sortedCategories(snap);
  const catById = new Map(cats.map((c) => [c.id, c]));
  const pledgesByItem = new Map();
  for (const p of snap.pledges || []) {
    if (!pledgesByItem.has(p.item_id)) pledgesByItem.set(p.item_id, []);
    pledgesByItem.get(p.item_id).push(p);
  }
  const items = (snap.items || [])
    .filter((i) => i.type === 'buy' && i.status === 'active')
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.created_at).localeCompare(String(b.created_at)));
  const buyersOf = (it) => (pledgesByItem.get(it.id) || []).map((p) => p.member_id);
  const defaultBuyer = (it) => catById.get(it.category_id)?.default_buyer_id || null;

  /** Items in a buyer's view: pledged to them, plus unassigned items of categories they buy by default. */
  const viewOf = (buyer) => items.filter((it) => {
    const b = buyersOf(it);
    if (buyer === 'none') return b.length === 0;
    return b.includes(buyer) || (b.length === 0 && defaultBuyer(it) === buyer);
  });

  const buyerIds = new Set();
  for (const it of items) {
    buyersOf(it).forEach((id) => buyerIds.add(id));
    const d = defaultBuyer(it);
    if (d && !buyersOf(it).length) buyerIds.add(d);
  }
  const heads = headcountTotal(members);
  return { snap, members, byMember, cats, catById, items, buyersOf, defaultBuyer, viewOf, buyerIds, heads, me };
}

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

/** Keep the screen on while shopping (Screen Wake Lock API; silently absent elsewhere). */
function useWakeLock() {
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return undefined;
    let lock = null;
    let alive = true;
    const acquire = async () => {
      if (!alive || document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      try {
        lock = await navigator.wakeLock.request('screen');
        if (!alive) {
          lock.release().catch(() => {});
          return;
        }
        setAwake(true);
        lock.addEventListener('release', () => alive && setAwake(false));
      } catch {
        setAwake(false);
      }
    };
    acquire();
    const onVisible = () => acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      if (lock && !lock.released) lock.release().catch(() => {});
    };
  }, []);
  return awake;
}

/** FLIP: rows that change position glide there instead of jumping. */
function useFlip(containerRef, signature) {
  const positions = useRef(new Map());
  useLayoutEffect(() => {
    const box = containerRef.current;
    if (!box) return;
    const next = new Map();
    const rows = box.querySelectorAll('[data-flip]');
    rows.forEach((r) => next.set(r.dataset.flip, r.offsetTop));
    if (!reducedMotion() && typeof Element !== 'undefined' && Element.prototype.animate) {
      rows.forEach((r) => {
        const before = positions.current.get(r.dataset.flip);
        const now = next.get(r.dataset.flip);
        if (before !== undefined && Math.abs(before - now) > 2) {
          r.animate([{ transform: `translateY(${before - now}px)` }, { transform: 'none' }], {
            duration: 360,
            easing: 'cubic-bezier(0.22, 0.8, 0.24, 1)',
          });
        }
      });
    }
    positions.current = next;
  }, [signature]);
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

export default function ShoppingScreen({ route }) {
  const { snap, me, isAdmin } = useTrip();
  const tripId = route.params.tripId;
  const ready = !!snap && snap.trip?.id === tripId;
  const [optimistic, setOptimistic] = useState({}); // itemId → done (shown immediately)
  const [frozen, setFrozen] = useState({}); // itemId → done value used for ordering while settling
  const [receiptOpen, setReceiptOpen] = useState(false);
  const adopted = useRef(new Set()); // unassigned items I just took — keep them in the "לא משובץ" view
  const listRef = useRef(null);
  const awake = useWakeLock();

  const model = useMemo(() => (ready ? buildShop(snap, me) : null), [ready, snap, me]);
  const buyerParam = route.query.buyer || 'me';
  const buyer = buyerParam === 'me' ? me?.id || 'none' : buyerParam;

  let view = [];
  if (model) {
    view = model.viewOf(buyer);
    if (buyer === 'none' && adopted.current.size) {
      const extra = model.items.filter((it) => adopted.current.has(it.id) && !view.includes(it));
      view = [...view, ...extra].sort((a, b) => model.items.indexOf(a) - model.items.indexOf(b));
    }
  }
  const doneOf = (it) => optimistic[it.id] ?? !!it.done;
  const orderDone = (it) => (it.id in frozen ? frozen[it.id] : doneOf(it));
  const groups = model
    ? groupByCategory(view, model.cats).map((g) => ({
      ...g,
      items: [...g.items].sort((a, b) => Number(orderDone(a)) - Number(orderDone(b)) || view.indexOf(a) - view.indexOf(b)),
    }))
    : [];
  const signature = groups.map((g) => g.items.map((i) => i.id).join(',')).join('|');
  useFlip(listRef, signature);

  if (!model) {
    return html`<div class="screen shop-screen" aria-busy="true">
      <div class="shop-head"><span class="ls-skel-title"></span></div>
      <${Skeleton} lines=${2} />
      <${Skeleton} lines=${6} />
    </div>`;
  }

  const total = view.length;
  const bought = view.filter(doneOf).length;
  const pct = total ? Math.round((bought * 100) / total) : 0;
  const allDone = total > 0 && bought === total;

  const setBuyer = (b) => navigate(`/t/${tripId}/shop${b === 'me' ? '' : `?buyer=${encodeURIComponent(b)}`}`, { replace: true });

  const readOnly = (it) => {
    const b = model.buyersOf(it);
    return b.length > 0 && !(me && b.includes(me.id)) && !isAdmin;
  };

  const toggle = async (it) => {
    if (!me || it.id in optimistic) return;
    const next = !doneOf(it);
    const unassigned = model.buyersOf(it).length === 0;
    setFrozen((f) => ({ ...f, [it.id]: !next }));
    setOptimistic((o) => ({ ...o, [it.id]: next }));
    if (unassigned && next && buyer === 'none') adopted.current.add(it.id);
    navigator.vibrate?.(12);
    const ok = await runOk(async (api) => {
      if (unassigned && next) await api.pledge(it.id, 1); // bought it → it's mine
      await api.setItemDone(it.id, next);
    });
    setOptimistic((o) => {
      const c = { ...o };
      delete c[it.id];
      return c;
    });
    setTimeout(() => setFrozen((f) => {
      const c = { ...f };
      delete c[it.id];
      return c;
    }), ok ? SETTLE_MS : 0);
    if (ok && next && view.every((x) => x.id === it.id || doneOf(x))) {
      actions.toast('הכל בעגלה! 🎉 עכשיו רק לשמור את הקבלה', 'success', 3200);
    }
  };

  // buyer chips: me · other buyers · unassigned
  const remaining = (b) => model.viewOf(b).filter((it) => !it.done).length;
  const chips = [];
  if (me) chips.push({ value: 'me', label: 'אני', member: me, count: remaining(me.id) });
  for (const m of model.members) {
    if (me && m.id === me.id) continue;
    if (model.buyerIds.has(m.id)) chips.push({ value: m.id, label: displayName(m), member: m, count: remaining(m.id) });
  }
  chips.push({ value: 'none', label: 'לא משובץ', emoji: '🤷', count: remaining('none') });
  if (buyerParam !== 'me' && buyerParam !== 'none' && !chips.some((c) => c.value === buyerParam)) {
    const m = model.byMember.get(buyerParam);
    if (m) chips.splice(1, 0, { value: m.id, label: displayName(m), member: m, count: 0 });
  }
  const selectedChip = buyerParam === 'me' && !me ? 'none' : buyerParam;
  const viewedMember = buyer !== 'none' ? model.byMember.get(buyer) : null;
  const othersView = viewedMember && me && viewedMember.id !== me.id;

  // receipt defaults: categories of what was bought (else everything in view)
  const boughtItems = view.filter(doneOf);
  const basis = boughtItems.length ? boughtItems : view;
  const catIds = [...new Set(basis.map((it) => it.category_id).filter((id) => model.catById.has(id)))];
  const catNames = catIds.map((id) => model.catById.get(id).name);
  const receiptTitle = (catNames.length ? `קניות — ${catNames.join(', ')}` : 'קניות לטיול').slice(0, 80);

  return html`<div class="screen shop-screen">
    <header class="shop-head">
      <${IconButton} icon="arrow-right" label="חזרה לרשימות" href=${href(`/t/${tripId}/lists?tab=buy`)} class="shop-back" />
      <div class="shop-head__text">
        <h1 class="shop-head__title">🛒 מצב קנייה</h1>
        <p class="shop-head__sub truncate">${tripLabel(snap.trip)}</p>
      </div>
      ${awake ? html`<span class="shop-awake" title="המסך יישאר דלוק בזמן הקנייה" role="status"><span aria-hidden="true">🔆</span> מסך דלוק</span>` : null}
    </header>

    <div class="h-scroll shop-buyers" role="group" aria-label="רשימת קניות של">
      ${chips.map((c) => html`<${Chip} key=${c.value} active=${selectedChip === c.value} onClick=${() => setBuyer(c.value)} class="shop-chip">
        <span class="shop-chip__pic" aria-hidden="true">${c.member ? html`<${Avatar} member=${c.member} size=${24} />` : c.emoji}</span>
        <span>${c.label}</span>
        ${c.count ? html`<span class="shop-chip__count num">${c.count}</span>` : null}
      </${Chip}>`)}
    </div>

    ${total
      ? html`<div class=${cx('shop-progress', allDone && 'is-complete')}>
          <div class="shop-progress__row">
            <strong class="num">${allDone ? 'הכל בעגלה! 🎉' : `${bought} מתוך ${total} בעגלה`}</strong>
            <span class="shop-progress__pct num">${pct}%</span>
          </div>
          <${ProgressBar} value=${pct} tone="accent" label="כמה כבר בעגלה" />
        </div>`
      : null}

    ${othersView && !isAdmin
      ? html`<p class="ls-hint">👀 זו הרשימה של ${displayName(viewedMember)} — רק לצפייה. פריטים בלי קונה אפשר לקחת.</p>`
      : null}

    ${!total
      ? html`<div class="card"><${EmptyState}
          emoji=${buyer === 'none' ? '🙌' : '🧺'}
          title=${buyer === 'none' ? 'כל הקניות משובצות' : othersView ? `ל${displayName(viewedMember)} אין קניות` : 'אין לך מה לקנות'}
          text=${buyer === 'none' ? 'לכל פריט יש כבר מי שקונה אותו.' : 'אפשר לקחת פריטים מ"לא משובץ", או להוסיף ברשימת הקניות.'}
          action=${html`<div class="row row--center wrap">
            ${buyer !== 'none' ? html`<${Button} variant="secondary" onClick=${() => setBuyer('none')}>🤷 לא משובץ</${Button}>` : null}
            <${Button} variant="ghost" href=${href(`/t/${tripId}/lists?tab=buy`)}>לרשימת הקניות</${Button}>
          </div>`}
        /></div>`
      : null}

    <div class="shop-groups" ref=${listRef}>
      ${groups.map((g) => {
        const left = g.items.filter((it) => !doneOf(it)).length;
        return html`<section key=${g.key} class="shop-group" aria-label=${g.cat ? g.cat.name : 'שונות'}>
          <h2 class="shop-group__title">
            <span aria-hidden="true">${g.cat ? g.cat.emoji || '📦' : '📦'}</span>
            <span>${g.cat ? g.cat.name : 'שונות'}</span>
            <span class="shop-group__count num">${left ? `נשארו ${left}` : '✓'}</span>
          </h2>
          <div class="shop-list">
            ${g.items.map((it) => {
              const done = doneOf(it);
              const qty = itemEffectiveQty(it, model.heads).text;
              const ro = readOnly(it);
              const byDefault = model.buyersOf(it).length === 0 && buyer !== 'none';
              return html`<button
                key=${it.id}
                type="button"
                data-flip=${it.id}
                class=${cx('shop-row', done && 'is-bought', ro && 'is-readonly')}
                role="checkbox"
                aria-checked=${done ? 'true' : 'false'}
                aria-disabled=${ro ? 'true' : undefined}
                onClick=${() => (ro ? actions.toast(`רק ${displayName(viewedMember)} (או מנהל/ת) מסמנים את זה`, 'info') : toggle(it))}
              >
                <span class=${cx('check', 'shop-row__check', done && 'is-checked')} aria-hidden="true"><${Icon} name="check" /></span>
                <span class="shop-row__main">
                  <span class="shop-row__title">${it.title}</span>
                  ${it.note ? html`<span class="shop-row__note">${it.note}</span>` : null}
                  ${byDefault ? html`<span class="shop-row__tag">🤷 עוד בלי קונה</span>` : null}
                </span>
                ${qty ? html`<span class="shop-row__qty num">${qty}</span>` : null}
              </button>`;
            })}
          </div>
        </section>`;
      })}
    </div>

    ${total || boughtItems.length
      ? html`<div class="shop-finish">
          <${Button} variant=${allDone ? 'accent' : 'primary'} size="lg" block onClick=${() => setReceiptOpen(true)}>
            סיימתי! 🧾 הוסף את הקבלה
          </${Button}>
        </div>`
      : null}

    <${ReceiptSheet}
      open=${receiptOpen}
      onClose=${() => setReceiptOpen(false)}
      model=${model}
      me=${me}
      isAdmin=${isAdmin}
      tripId=${tripId}
      defaults=${{ title: receiptTitle, categoryId: catIds.length === 1 ? catIds[0] : null }}
    />
  </div>`;
}

// ---------------------------------------------------------------------------
// receipt → add_expense
// ---------------------------------------------------------------------------

function ReceiptSheet({ open, onClose, model, me, isAdmin, tripId, defaults }) {
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState(null);
  const [paidBy, setPaidBy] = useState(null);
  const [categoryId, setCategoryId] = useState(null);
  const [split, setSplit] = useState('all');
  const [chosen, setChosen] = useState([]);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    setTitle(defaults.title);
    setAmount(null);
    setPaidBy(me?.id || null);
    setCategoryId(defaults.categoryId);
    setSplit('all');
    setChosen(model.members.map((m) => m.id));
    setErrors({});
  }, [open]);

  const snap = model.snap;
  const selected = split === 'members' ? chosen : model.members.map((m) => m.id);
  const people = model.members.filter((m) => selected.includes(m.id)).reduce((s, m) => s + (Number(m.headcount) || 1), 0);
  let preview = null;
  if (amount > 0 && selected.length) {
    const shares = expenseShares(
      split === 'all' ? { amount, split_mode: 'all' } : { amount, split_mode: 'members', members: chosen.map((id) => ({ member_id: id })) },
      snap,
    );
    const mine = me ? shares.find((s) => s.member_id === me.id) : null;
    preview = html`<div class="shop-split-preview" aria-live="polite">
      <span>${formatMoney(amount)} ÷ ${hebrewCount(people, 'איש', 'אנשים')} ≈ <strong class="num">${formatMoney(Math.round((amount * 100) / Math.max(people, 1)) / 100)}</strong> לאדם</span>
      ${mine ? html`<span class="small">החלק שלך: <strong class="num">${formatMoney(mine.amount)}</strong></span>` : null}
    </div>`;
  }

  const save = async () => {
    const errs = {};
    if (!title.trim()) errs.title = 'צריך שם להוצאה';
    if (!(amount > 0)) errs.amount = 'כמה יצא? 🙂';
    else if (amount > 100000) errs.amount = 'הסכום גבוה מדי';
    if (split === 'members' && !chosen.length) errs.split = 'בחרו לפחות משתתף/ת אחד/ת';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    const payload = {
      title: title.trim().slice(0, 80),
      amount,
      paid_by: paidBy || me?.id,
      category_id: categoryId || null,
      split_mode: split,
    };
    if (split === 'members') payload.members = chosen.map((id) => ({ member_id: id }));
    const id = await actions.run((api) => api.addExpense(tripId, payload));
    setSaving(false);
    if (id === undefined) return;
    onClose();
    fireConfetti();
    actions.toast('הקבלה נשמרה ומתחלקת אוטומטית 🧾 — לחצו למעבר לכסף', 'success', 4600, { href: `#/t/${tripId}/money`, icon: '🎉' });
  };

  const payer = paidBy ? model.byMember.get(paidBy) : null;
  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title="הקבלה 🧾"
    class="shop-receipt"
    footer=${html`
      <${Button} variant="accent" icon="check" loading=${saving} onClick=${save}>שמירת ההוצאה</${Button}>
      <${Button} variant="secondary" onClick=${onClose}>ביטול</${Button}>`}
  >
    <form class="stack" onSubmit=${(e) => { e.preventDefault(); save(); }}>
      <${Field} label="כמה יצא?" error=${errors.amount}>
        <${MoneyInput} value=${amount} onChange=${setAmount} data-autofocus />
      </${Field}>
      ${preview}
      <${Field} label="על מה" error=${errors.title}>
        <${TextInput} value=${title} onInput=${(e) => setTitle(e.currentTarget.value)} maxlength="80" />
      </${Field}>
      ${isAdmin
        ? html`<${Field} label="מי שילם/ה">
            <${MemberPicker} members=${model.members} value=${paidBy} onChange=${setPaidBy} label="מי שילם/ה" />
          </${Field}>`
        : html`<p class="shop-payer">${payer ? html`<${Avatar} member=${payer} size=${28} />` : null} שולם ע״י: <strong>את/ה</strong></p>`}
      <${Field} label="קטגוריה">
        <${ChipScroller} label="קטגוריה" selected=${categoryId || ''}>
          ${model.cats.map((c) => html`<${Chip} key=${c.id} data-key=${c.id} active=${categoryId === c.id} onClick=${() => setCategoryId(categoryId === c.id ? null : c.id)}>
            <span aria-hidden="true">${c.emoji || '📦'}</span> ${c.name}
          </${Chip}>`)}
        </${ChipScroller}>
      </${Field}>
      <${Field} label="מתחלקים" error=${errors.split}>
        <${Segmented}
          options=${[{ value: 'all', label: 'כולם (לפי ראשים)' }, { value: 'members', label: 'רק חלק' }]}
          value=${split}
          onChange=${setSplit}
          label="איך מתחלקים"
        />
      </${Field}>
      ${split === 'members'
        ? html`<${MemberPicker} members=${model.members} value=${chosen} onChange=${setChosen} multi label="מי משתתף/ת בהוצאה" />`
        : null}
      <button type="submit" hidden></button>
    </form>
  </${Sheet}>`;
}
