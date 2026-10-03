// Lists (SPEC §8.4): tabs, search, category sections, item rows with a quick action, the item
// sheet (details, pledges, "💡 למי יש בבית?", admin tools), the add-item sheet, "⭐ שלי"
// (private personal gear + my items) and the overflow menu (import / shopping mode / share).
// Also exports small helpers that shopping.js and import.js reuse.
import { html } from 'htm/preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { actions, useTrip } from '../store.js?v=853199b';
import { navigate, href } from '../router.js?v=853199b';
import {
  actorName, buildSummaryText, dueInfo, displayName, eachSplitOf, formatQty, headcountTotal, hebrewCount, itemEffectiveQty,
  itemProgress, membersById, myAgenda, parseListText, similarItems, timeAgo, tripReadiness, whatsappChatUrl,
  ilIso as ilIsoDue, ilWall as ilWallDue,
} from '../lib/logic.js?v=853199b';
import {
  Avatar, AvatarStack, Button, Card, Chip, EmptyState, Fab, Field, IconButton, MemberPicker, OverBanner, Pill, ProgressBar,
  Section, Segmented, Sheet, ShareButton, Skeleton, Stepper, TextArea, TextInput, Toggle, confirmDialog, fireConfetti, tripOver,
} from '../ui/components.js?v=853199b';
import { Icon } from '../ui/icons.js?v=853199b';
import { hasModule, itemTypeOn } from '../lib/templates.js?v=853199b';

// ---------------------------------------------------------------------------
// Shared helpers (also used by shopping.js and import.js)
// ---------------------------------------------------------------------------

export const cx = (...a) => a.filter(Boolean).join(' ');

// Invisible / combining characters are built from code points so the source stays plain ASCII-safe.
const ch = (code) => String.fromCharCode(code);
const VS16 = ch(0xfe0f);
const NIQQUD_RE = new RegExp(`[${ch(0x0591)}-${ch(0x05bd)}${ch(0x05bf)}-${ch(0x05c7)}]`, 'g');
const PUNCT_CHARS = `${ch(0x05be)}-_/+,.;:!?()[]{}"'׳״•·*–—`;
const PUNCT_RE = new RegExp(`[${PUNCT_CHARS.replace(/[\]\\^-]/g, '\\$&')}]`, 'g');

/** Lower-case text without niqqud or punctuation — for search and fuzzy matching. */
export function normText(s) {
  return String(s ?? '')
    .replace(PUNCT_RE, ' ')
    .replace(NIQQUD_RE, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Emoji without the variation selector (🍽️ === 🍽). */
export const emojiKey = (e) => String(e ?? '').split(VS16).join('').trim();

export const TYPE_META = {
  buy: { emoji: '🛒', label: 'לקנות', short: 'קנייה', done: 'נקנה ✓', check: 'קניתי' },
  bring: { emoji: '🎒', label: 'להביא מהבית', short: 'מהבית', done: 'ארוז ✓', check: 'ארזתי' },
  each: { emoji: '🙋', label: 'כל אחד מביא', short: 'כל אחד', done: 'ארוז ✓', check: 'ארזתי את שלי' },
  task: { emoji: '✅', label: 'משימה', short: 'משימה', done: 'בוצע ✓', check: 'בוצע' },
};
export const typeMeta = (type) => TYPE_META[type] || TYPE_META.buy;

export const UNIT_CHIPS = ['יח׳', 'ק"ג', 'גרם', 'חבילות', 'בקבוקים', 'שישיות', 'ליטר'];

/** Categories in display order. */
export function sortedCategories(snap) {
  return [...(snap?.categories || [])].sort(
    (a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.created_at || '').localeCompare(String(b.created_at || '')),
  );
}

const byItemOrder = (a, b) =>
  (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.created_at || '').localeCompare(String(b.created_at || ''));

/** Items grouped by category (category order), uncategorised last. */
export function groupByCategory(items, cats) {
  const known = new Set(cats.map((c) => c.id));
  const groups = new Map();
  for (const it of items) {
    const key = known.has(it.category_id) ? it.category_id : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const out = cats.filter((c) => groups.has(c.id)).map((c) => ({ key: c.id, cat: c, items: groups.get(c.id) }));
  if (groups.has('')) out.push({ key: 'none', cat: null, items: groups.get('') });
  return out;
}

/** Existing trip category that a parsed `{name, emoji}` refers to (by name, else by a unique emoji). */
export function matchCategory(categories, cat) {
  if (!cat) return null;
  const n = normText(cat.name);
  const byName = categories.find((c) => normText(c.name) === n);
  if (byName) return byName;
  const e = emojiKey(cat.emoji);
  if (!e || e === '📦') return null;
  const byEmoji = categories.filter((c) => emojiKey(c.emoji) === e);
  return byEmoji.length === 1 ? byEmoji[0] : null;
}

/** actions.run for void RPCs: resolves true on success, false on error (the error is toasted). */
export async function runOk(fn, opts) {
  const r = await actions.run(async (api) => {
    await fn(api);
    return true;
  }, opts);
  return r === true;
}

/** Short Hebrew status for an item row / sheet. */
export function itemStatus(item, prog) {
  const meta = typeMeta(item.type);
  switch (prog.state) {
    case 'proposed':
      return { text: 'ממתין לאישור', tone: 'warning' };
    case 'rejected':
      return { text: 'נדחה', tone: 'danger' };
    case 'done':
      return { text: item.type === 'each' ? 'כולם ארזו ✓' : meta.done, tone: 'success' };
    case 'covered':
      return { text: item.type === 'task' ? 'בטיפול' : 'מכוסה', tone: 'primary' };
    case 'partial':
      return item.type === 'each'
        ? { text: `${prog.doneCount}/${prog.total} ארזו`, tone: 'accent' }
        : { text: `חלקי ${prog.pledged}/${prog.needed}`, tone: 'accent' };
    default:
      return item.type === 'each' ? { text: `0/${prog.total} ארזו`, tone: 'ember' } : { text: '🙋 אף אחד עוד לא לקח', tone: 'ember' };
  }
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// "💡 למי יש בבית?" — fuzzy match item titles against members' inventory
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(['עם', 'של', 'או', 'גם', 'כל', 'לכל', 'זוג', 'אחד', 'אחת', 'גדול', 'גדולה', 'גדולים', 'גדולות',
  'קטן', 'קטנה', 'קטנים', 'קטנות', 'נייד', 'ניידת', 'חדש', 'ישן', 'מתקפל', 'מתקפלת']);

function stem(word) {
  let s = word;
  if (s.length >= 5 && /(ים|ות)$/.test(s)) s = s.slice(0, -2);
  if (s.length >= 4 && /[הת]$/.test(s)) s = s.slice(0, -1);
  if (s.length > 3) s = s[0] + s.slice(1).replace(/[וי]/g, '');
  return s;
}

function stems(norm) {
  return new Set(norm.split(' ').filter((w) => w.length >= 3 && !STOP_WORDS.has(w)).map(stem).filter((w) => w.length >= 3));
}

const hasPhrase = (hay, needle) => needle.length >= 3 && ` ${hay} `.includes(` ${needle} `);

/** Members whose inventory ("מה יש לי בבית") matches the title → [{member, what}]. */
export function inventoryMatches(title, members, excludeIds = new Set()) {
  const t = normText(title);
  if (!t) return [];
  const tStems = stems(t);
  const out = [];
  for (const m of members) {
    if (excludeIds.has(m.id)) continue;
    for (const inv of m.inventory || []) {
      const n = normText(inv);
      if (!n) continue;
      const hit = hasPhrase(t, n) || hasPhrase(n, t) || [...stems(n)].some((s) => tStems.has(s));
      if (hit) {
        out.push({ member: m, what: inv });
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// "🔁 כבר ברשימה?" — warn before adding a duplicate (also used by home.js)
// ---------------------------------------------------------------------------

const PLEDGE_VERB = { buy: 'קונה', bring: 'מביא/ה', task: 'על זה' };

/** Look-alike items of `title` already in the trip, each opening the existing item. */
export function SimilarItemsNotice({ title, snap, onOpen }) {
  const matches = useMemo(() => similarItems(title, snap?.items), [title, snap?.items]);
  const byId = useMemo(() => membersById(snap?.members), [snap?.members]);
  if (!matches.length) return null;
  const same = matches.some((m) => m.match === 'same');
  return html`<div class=${cx('dup-notice', same && 'dup-notice--same')} role="status" data-testid="dup-notice">
    <p class="dup-notice__head"><span aria-hidden="true">🔁</span> ${same ? 'זה כבר ברשימה:' : 'אולי זה כבר ברשימה?'}</p>
    <ul class="dup-notice__list">
      ${matches.map(({ item }) => {
        const prog = itemProgress(item, snap.pledges, snap.members);
        const status = itemStatus(item, prog);
        const who = item.type === 'each' ? [] : prog.pledgers.map((p) => byId.get(p.member_id)).filter(Boolean).map(displayName);
        return html`<li key=${item.id}>
          <button type="button" class="dup-notice__item" onClick=${() => onOpen?.(item.id)} aria-label=${`לפתוח את ${item.title}`}>
            <span class="dup-notice__title">${item.title}</span>
            <${Pill} tone=${status.tone}>${status.text}</${Pill}>
            ${who.length ? html`<span class="dup-notice__who">${who.join(', ')} ${PLEDGE_VERB[item.type] || ''}</span>` : null}
          </button>
        </li>`;
      })}
    </ul>
    <p class="dup-notice__hint">עדיף להצטרף לפריט הקיים (✋ אני) — ככה לא מגיעים עם אותו דבר פעמיים.</p>
  </div>`;
}

/** For admins reviewing a proposal: the other (non-rejected) item it most looks like, or null. */
function lookAlikeOf(item, items) {
  return similarItems(item.title, items, { excludeId: item.id, limit: 1 })[0]?.item || null;
}

/** Before adding `title`: if the very same item exists, ask. Resolves true to go ahead. */
export async function confirmNotDuplicate(title, snap) {
  const same = similarItems(title, snap?.items).find((m) => m.match === 'same');
  if (!same) return true;
  return confirmDialog({
    title: `"${same.item.title}" כבר ברשימה`,
    text: 'כדי שלא יגיעו שניים עם אותו דבר, עדיף לפתוח את הפריט הקיים ולהצטרף אליו. להוסיף בכל זאת?',
    confirmText: 'להוסיף בכל זאת',
    cancelText: 'חזרה',
  });
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const TAB_ALIASES = {
  all: 'all', buy: 'buy', shop: 'buy', shopping: 'buy', bring: 'bring', each: 'each', task: 'task', tasks: 'task',
  pending: 'pending', proposed: 'pending', approval: 'pending', mine: 'mine', my: 'mine', me: 'mine', personal: 'mine',
};
const normalizeTab = (t) => TAB_ALIASES[String(t || '').toLowerCase()] || 'all';

/** Is this lists tab there for the trip's features? ("שלי" always: what's on me + the packing list) */
function tabOn(trip, tab) {
  if (tab === 'mine') return true;
  if (tab === 'all' || tab === 'pending') return hasModule(trip, 'lists') || hasModule(trip, 'tasks');
  return itemTypeOn(trip, tab);
}

function buildModel(snap, me) {
  const members = snap.members || [];
  const heads = headcountTotal(members);
  const byMember = membersById(members);
  const cats = sortedCategories(snap);
  const catById = new Map(cats.map((c) => [c.id, c]));
  const pledgesByItem = new Map();
  for (const p of snap.pledges || []) {
    if (!pledgesByItem.has(p.item_id)) pledgesByItem.set(p.item_id, []);
    pledgesByItem.get(p.item_id).push(p);
  }
  const items = [...(snap.items || [])].sort(byItemOrder);
  const progress = new Map();
  for (const it of items) progress.set(it.id, itemProgress(it, pledgesByItem.get(it.id) || [], members));
  const pending = items.filter((i) => i.status === 'proposed');
  return {
    snap, me, members, heads, byMember, cats, catById, pledgesByItem, items, progress,
    pendingCount: pending.length,
    readiness: tripReadiness(snap),
    requireApproval: snap.trip?.settings?.require_approval !== false,
  };
}

const coveredState = (s) => s === 'covered' || s === 'done';
const needsPeople = (s) => s === 'missing' || s === 'partial';

/** Per-category completion, for the "category completed 🎉" celebration. */
function categoryCompletion(model) {
  const complete = new Map();
  const incomplete = new Set();
  const counts = new Map();
  for (const it of model.items) {
    if (it.status !== 'active' || !model.catById.has(it.category_id)) continue;
    const c = counts.get(it.category_id) || { total: 0, covered: 0 };
    c.total++;
    if (coveredState(model.progress.get(it.id).state)) c.covered++;
    counts.set(it.category_id, c);
  }
  for (const [id, c] of counts) {
    if (c.covered === c.total) complete.set(id, model.catById.get(id));
    else incomplete.add(id);
  }
  return { complete, incomplete };
}

/** Confetti + toast when the trip hits 100% or a category becomes fully covered (not on first load). */
function useCelebrations(model) {
  const prev = useRef(null);
  useEffect(() => {
    if (!model) return;
    const now = { pct: model.readiness.pct, total: model.readiness.total, ...categoryCompletion(model) };
    const before = prev.current;
    prev.current = now;
    if (!before) return;
    if (before.pct < 100 && now.pct === 100 && now.total > 0) {
      fireConfetti();
      actions.toast('הכל מכוסה! 🎉 אפשר לצאת לדרך', 'success', 3800);
      return;
    }
    for (const [id, cat] of now.complete) {
      if (before.incomplete.has(id)) {
        fireConfetti();
        actions.toast(`${cat.emoji || '📦'} ${cat.name} — הכל מכוסה! 🎉`, 'success', 3200);
        break;
      }
    }
  }, [model]);
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const TAB_EMPTY = {
  all: { emoji: '🏕️', title: 'הרשימה עוד ריקה', text: 'מוסיפים פריט ראשון, או מייבאים רשימה שכבר נכתבה בוואטסאפ.' },
  buy: { emoji: '🛒', title: 'אין עדיין מה לקנות', text: 'מה צריך מהסופר? הוסיפו פריט ונחלק את הקניות.' },
  bring: { emoji: '🎒', title: 'עוד אין ציוד מהבית', text: 'כסאות, מנגל, צידנית… מה כל אחד מביא?' },
  each: { emoji: '🙋', title: 'אין פריטים ל"כל אחד מביא"', text: 'למשל קרש חיתוך או פנס — כל זוג/יחיד מביא משלו.' },
  task: { emoji: '📋', title: 'אין משימות פתוחות', text: 'להזמין כרטיסים, לשריין מקום… מה צריך לסדר?' },
  pending: { emoji: '🎉', title: 'אין הצעות שמחכות', text: 'כל ההצעות טופלו. אפשר לנשום.' },
};

export default function ListsScreen({ route }) {
  const { snap, me, isAdmin } = useTrip();
  const tripId = route.params.tripId;
  const ready = !!snap && snap.trip?.id === tripId;
  const trip = snap?.trip;
  const shared = !!trip && (hasModule(trip, 'lists') || hasModule(trip, 'tasks'));
  // a tab of a feature that's off falls back to "הכל", or to "שלי" when only the packing list is on
  const asked = normalizeTab(route.query.tab);
  const tab = !trip || tabOn(trip, asked) ? asked : shared ? 'all' : 'mine';
  const itemId = route.query.item || null;

  const [query, setQuery] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addPrefill, setAddPrefill] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [flashId, setFlashId] = useState(null);
  const pushedItem = useRef(false);
  const deleted = useRef(new Set());

  const model = useMemo(() => (ready ? buildModel(snap, me) : null), [ready, snap, me]);
  useCelebrations(model);

  const listPath = (t, extra = {}) => {
    const qs = new URLSearchParams();
    if (t && t !== 'all') qs.set('tab', t);
    for (const [k, v] of Object.entries(extra)) if (v) qs.set(k, v);
    const s = qs.toString();
    return `/t/${tripId}/lists${s ? `?${s}` : ''}`;
  };
  const setTab = (t) => navigate(listPath(t), { replace: true });
  const openItem = (id) => {
    pushedItem.current = true;
    navigate(listPath(tab, { item: id }));
  };
  const closeItem = () => {
    if (pushedItem.current) {
      pushedItem.current = false;
      history.back();
    } else {
      navigate(listPath(tab), { replace: true });
    }
  };
  const openAdd = (prefill = null) => {
    setAddPrefill(prefill);
    setAddOpen(true);
  };

  // "?add=1" deep link (e.g. "➕ הצע פריט" on the home screen) opens the add sheet once.
  useEffect(() => {
    if (route.query.add === '1' || route.query.new === '1') {
      openAdd();
      navigate(listPath(tab), { replace: true });
    }
  }, [route.query.add, route.query.new]);

  useEffect(() => {
    if (!itemId) pushedItem.current = false;
  }, [itemId]);

  // Deep link to an item that isn't (or is no longer) visible to me.
  const item = model && itemId ? model.items.find((i) => i.id === itemId) || null : null;
  useEffect(() => {
    if (!model || !itemId || item) return;
    if (deleted.current.has(itemId)) {
      closeItem(); // I just deleted it from its sheet
      return;
    }
    actions.toast('הפריט הזה כבר לא ברשימה 🤷', 'info');
    pushedItem.current = false;
    navigate(listPath(tab), { replace: true });
  }, [model, itemId, item]);

  // Scroll a freshly added item into view and let it glow for a moment.
  useEffect(() => {
    if (!flashId) return undefined;
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector(`[data-item="${flashId}"]`);
      el?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    });
    const t = setTimeout(() => setFlashId(null), 2400);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [flashId, model]);

  if (!model) {
    return html`<div class="screen ls-screen" aria-busy="true">
      <div class="ls-head"><span class="ls-skel-title"></span></div>
      <${Skeleton} lines=${2} />
      <${Skeleton} lines=${5} />
      <${Skeleton} lines=${4} />
    </div>`;
  }

  // once the trip is over the lists are history (ux A3): read only — no FAB, no ✋ / done buttons
  const over = tripOver(snap.trip);
  const ctx = {
    model, me, isAdmin, tripId, flashId, over,
    open: openItem,
    forget: (id) => deleted.current.add(id),
    pendingTab: tab === 'pending',
    mineTab: tab === 'mine',
  };

  // "הכל", "שלי" and (admins, when there are some) "לאישור" first — then the types (ux L2)
  const tabs = [
    { value: 'all', label: 'הכל' },
    { value: 'mine', label: '⭐ שלי' },
    { value: 'pending', label: '⏳ לאישור', badge: model.pendingCount || null },
    { value: 'buy', label: '🛒 קניות' },
    { value: 'bring', label: '🎒 מהבית' },
    { value: 'each', label: '🙋 כל אחד' },
    { value: 'task', label: '✅ משימות' },
  ].filter((x) => tabOn(snap.trip, x.value) && (x.value !== 'pending' || model.pendingCount || tab === 'pending' || !isAdmin));

  const q = normText(query);
  const matchesQuery = (it) => {
    if (!q) return true;
    const cat = model.catById.get(it.category_id);
    return normText(`${it.title} ${it.note || ''} ${cat ? cat.name : ''}`).includes(q);
  };

  const r = model.readiness;
  let body;
  if (tab === 'mine') {
    body = html`<${MineTab} ctx=${ctx} matchesQuery=${matchesQuery} missingOnly=${missingOnly} query=${query} />`;
  } else {
    body = html`<${CategoryTab}
      ctx=${ctx}
      tab=${tab}
      matchesQuery=${matchesQuery}
      missingOnly=${missingOnly}
      query=${query}
      onAdd=${openAdd}
      onClearFilters=${() => {
        setQuery('');
        setMissingOnly(false);
      }}
      onImport=${() => navigate(`/t/${tripId}/import`)}
      onBuild=${() => navigate(`/t/${tripId}/build`)}
    />`;
  }

  const arrived = model.items.filter((it) => it.status === 'active' && coveredState(model.progress.get(it.id).state)).length;
  return html`<div class=${cx('screen ls-screen', over && 'is-over')}>
    <${OverBanner} trip=${snap.trip} />
    <div class="ls-head">
      <div class="ls-head__text">
        <h1 class="ls-head__title">רשימות</h1>
        <p class="ls-head__sub">
          ${!r.total
            ? 'בואו נתחיל למלא 📝'
            : over
              ? html`<span class="num">${hebrewCount(r.total, 'פריט', 'פריטים')}</span> · <span class="num">${arrived}</span> הגיעו`
              : html`<span class="num">${hebrewCount(r.total, 'פריט', 'פריטים')}</span> · <span class="num">${r.pct}%</span> מוכן${
                model.pendingCount ? html` · <span class="num">${model.pendingCount}</span> ממתינים לאישור` : null}`}
        </p>
      </div>
      ${over ? null : html`<${Button} variant="secondary" size="sm" href=${href(`/t/${tripId}/shop`)} class="ls-head__shop" aria-label="מצב קנייה">🛒 מצב קנייה</${Button}>`}
      <${IconButton} icon="more" label="עוד אפשרויות" onClick=${() => setMenuOpen(true)} class="ls-head__btn" />
    </div>
    ${r.total && !over ? html`<${ProgressBar} value=${r.pct} tone="accent" label="מוכנות הטיול" />` : null}

    <${Segmented} options=${tabs} value=${tab} onChange=${setTab} label="סינון רשימות" class="ls-tabs" />

    <div class="ls-tools">
      <label class="ls-search">
        <${Icon} name="search" size=${18} />
        <input
          type="search"
          class="ls-search__input"
          placeholder="חיפוש פריט…"
          aria-label="חיפוש ברשימות"
          enterkeyhint="search"
          value=${query}
          onInput=${(e) => setQuery(e.currentTarget.value)}
        />
        ${query
          ? html`<button type="button" class="ls-search__clear" aria-label="ניקוי החיפוש" onClick=${() => setQuery('')}>
              <${Icon} name="x" size=${16} />
            </button>`
          : null}
      </label>
      <${Chip} active=${missingOnly} tone=${missingOnly ? undefined : 'muted'} onClick=${() => setMissingOnly(!missingOnly)} class="ls-missing-chip">
        <${Icon} name="filter" size=${15} /> רק מה שחסר
      </${Chip}>
    </div>

    ${body}

    ${over || tab === 'mine' ? null : html`<${Fab} icon="plus" label="פריט" onClick=${() => openAdd()} />`}
    <${AddItemSheet} open=${addOpen} prefill=${addPrefill} tab=${tab} ctx=${ctx}
      onClose=${() => setAddOpen(false)}
      onAdded=${(id) => {
        setAddOpen(false);
        if (id) setFlashId(id);
      }}
      onOpenExisting=${(id) => {
        setAddOpen(false);
        openItem(id);
      }} />
    <${ItemSheet} open=${!!item} item=${item} ctx=${ctx} onClose=${closeItem} />
    <${MenuSheet} open=${menuOpen} onClose=${() => setMenuOpen(false)} ctx=${ctx} />
  </div>`;
}

// ---------------------------------------------------------------------------
// Category tabs (הכל / type tabs / לאישור)
// ---------------------------------------------------------------------------

function CategoryTab({ ctx, tab, matchesQuery, missingOnly, query, onAdd, onClearFilters, onImport, onBuild }) {
  const { model, isAdmin } = ctx;
  const inTab = model.items.filter((it) => {
    if (tab === 'pending') return it.status === 'proposed';
    if (it.status === 'rejected') return false;
    return tab === 'all' || it.type === tab;
  });
  const shown = inTab.filter((it) => {
    if (!matchesQuery(it)) return false;
    if (missingOnly && tab !== 'pending') return it.status === 'active' && needsPeople(model.progress.get(it.id).state);
    return true;
  });
  const groups = groupByCategory(shown, model.cats);
  const rejected = tab === 'pending' ? model.items.filter((it) => it.status === 'rejected' && matchesQuery(it)) : [];

  // Per-category "x/y" is over this tab's active items (ignores the search / missing filters).
  const stats = new Map();
  for (const it of inTab) {
    if (it.status !== 'active') continue;
    const key = model.catById.has(it.category_id) ? it.category_id : 'none';
    const s = stats.get(key) || { total: 0, covered: 0 };
    s.total++;
    if (coveredState(model.progress.get(it.id).state)) s.covered++;
    stats.set(key, s);
  }

  let empty = null;
  if (!shown.length) {
    if (query) {
      empty = html`<${EmptyState}
        emoji="🔍"
        title=${`לא מצאנו "${query}"`}
        text="אולי זה עוד לא ברשימה?"
        action=${html`<div class="row row--center wrap">
          <${Button} icon="plus" onClick=${() => onAdd({ title: query.trim() })}>להוסיף את "${query.trim()}"</${Button}>
        </div>`}
      />`;
    } else if (missingOnly && inTab.length) {
      empty = html`<${EmptyState}
        emoji="🎉"
        title="שום דבר לא חסר פה!"
        text="כל מה שברשימה הזו כבר מכוסה."
        action=${html`<${Button} variant="secondary" onClick=${onClearFilters}>להציג הכל</${Button}>`}
      />`;
    } else {
      const e = TAB_EMPTY[tab] || TAB_EMPTY.all;
      empty = html`<${EmptyState}
        emoji=${e.emoji}
        title=${e.title}
        text=${e.text}
        action=${tab === 'pending'
          ? null
          : html`<div class="row row--center wrap">
              <${Button} icon="plus" onClick=${() => onAdd(null)}>הוספת פריט</${Button}>
              ${tab === 'all' && (hasModule(ctx.model.snap.trip, 'lists') || hasModule(ctx.model.snap.trip, 'tasks')) ? html`<${Button} variant="secondary" icon="sparkles" onClick=${onBuild}>בניית רשימה מהירה</${Button}>` : null}
              ${tab === 'all' && hasModule(ctx.model.snap.trip, 'lists') ? html`<${Button} variant="secondary" icon="download" onClick=${onImport}>ייבוא מוואטסאפ</${Button}>` : null}
            </div>`}
      />`;
    }
  }

  return html`<div class="ls-groups">
    ${tab === 'pending' && isAdmin && shown.length
      ? html`<p class="ls-hint">👑 הצעות של החבר'ה — מאשרים בלחיצה, או פותחים פריט כדי לערוך / לדחות.</p>`
      : null}
    ${tab === 'pending' && !isAdmin && shown.length
      ? html`<p class="ls-hint">⏳ הצעות שמחכות לאישור של מנהל/ת הטיול.</p>`
      : null}
    ${empty ? html`<div class="card ls-empty">${empty}</div>` : null}
    ${!empty && isAdmin && !ctx.over && tab === 'all' && !query && inTab.length < 10 && hasModule(model.snap.trip, 'lists')
      ? html`<div class="card ls-fill" data-testid="ls-fill">
          <p class="small"><b>הרשימה עוד קצרה</b> — ממלאים מהר:</p>
          <div class="row wrap">
            <${Button} size="sm" variant="secondary" onClick=${onImport}>📥 הדבקה מוואטסאפ</${Button}>
            <${Button} size="sm" variant="secondary" onClick=${onBuild}>✨ בנייה מהירה</${Button}>
          </div>
        </div>`
      : null}
    ${groups.map((g) => html`<${CategoryGroup} key=${g.key} group=${g} stat=${stats.get(g.key)} ctx=${ctx} />`)}
    ${rejected.length
      ? html`<${Section} title="נדחו" emoji="🚫" count=${rejected.length} collapsible defaultOpen=${false} class="ls-rejected">
          <div class="list ls-list">
            ${rejected.map((it) => html`<${ItemRow} key=${it.id} item=${it} ctx=${ctx} />`)}
          </div>
        </${Section}>`
      : null}
  </div>`;
}

function CategoryGroup({ group, stat, ctx }) {
  const { cat, items } = group;
  const buyer = cat?.default_buyer_id ? ctx.model.byMember.get(cat.default_buyer_id) : null;
  const pct = stat && stat.total ? Math.round((stat.covered * 100) / stat.total) : 0;
  const complete = stat && stat.total > 0 && stat.covered === stat.total;
  return html`<${Section}
    title=${cat ? cat.name : 'שונות'}
    emoji=${cat ? cat.emoji || '📦' : '📦'}
    count=${stat && stat.total ? `${stat.covered}/${stat.total}` : undefined}
    collapsible
    class=${cx('ls-cat', complete && 'is-complete')}
    right=${html`${buyer
      ? html`<span class="ls-cat__buyer small" title=${`קונה ברירת מחדל: ${displayName(buyer)}`}>קונה: ${displayName(buyer)}</span>`
      : null}${ctx.isAdmin && cat && ctx.model.snap.trip.settings?.groom
      ? html`<button type="button" class=${cx('ls-cat__secret', cat.secret && 'is-on')} data-testid="cat-secret" aria-pressed=${cat.secret ? 'true' : 'false'}
          title=${cat.secret ? 'הקטגוריה מוסתרת מהחוגג/ת — לחיצה לביטול' : 'להסתיר את כל הקטגוריה מהחוגג/ת'}
          onClick=${() => runOk((api) => api.setSecret('category', cat.id, !cat.secret), { success: cat.secret ? 'הקטגוריה גלויה לכולם' : 'הקטגוריה מוסתרת מהחוגג/ת 🤫' })}>🤫</button>` : null}`}
  >
    <div class="list ls-list">
      ${stat && stat.total
        ? html`<div class="ls-cat__bar" aria-hidden="true"><span style=${`width:${pct}%`}></span></div>`
        : null}
      ${items.map((it) => html`<${ItemRow} key=${it.id} item=${it} ctx=${ctx} />`)}
    </div>
  </${Section}>`;
}

// ---------------------------------------------------------------------------
// Item row
// ---------------------------------------------------------------------------

const PLEDGE_TOAST = {
  buy: 'סגור! הקנייה עליך 🛒',
  bring: 'מעולה! רשמנו שאת/ה מביא/ה 🎒',
  task: 'תודה! המשימה אצלך 💪',
};

function rowQtyText(item, heads) {
  if (item.type === 'buy' || item.type === 'task') return itemEffectiveQty(item, heads).text;
  if (item.type === 'bring') return item.needed > 1 ? `×${item.needed}` : item.qty ? formatQty(item.qty, item.unit) : '';
  if (item.type === 'each') return item.each_qty > 1 ? `×${item.each_qty} לזוג` : '';      // per couple / family (§19)
  return '';
}

/** My row of an "each" item (§19): {split, target, part (my person's share, when we split it), open, done} or null. */
export function myEachPart(item, me, snap) {
  if (!me || item?.type !== 'each') return null;
  const raw = (snap?.pledges || []).find((p) => p.item_id === item.id && p.member_id === me.id) || null;
  const s = eachSplitOf(item, me, raw);
  const person = snap?.me?.member_id === me.id && (me.people || []).includes(snap.me.person) ? snap.me.person : null;
  const part = s.split && person ? s.parts.find((x) => x.person === person) || null : null;
  return { ...s, raw, person, part, others: s.parts.filter((x) => x !== part),
    mineDone: part ? part.qty > 0 && part.done : !!raw?.done };
}

function ItemRow({ item, ctx }) {
  const { model, me, isAdmin, pendingTab, mineTab, flashId } = ctx;
  const prog = model.progress.get(item.id);
  const meta = typeMeta(item.type);
  const status = itemStatus(item, prog);
  const myPledge = me ? prog.pledgers.find((p) => p.member_id === me.id) : null;
  const pledgers = prog.pledgers.map((p) => model.byMember.get(p.member_id)).filter(Boolean);
  const [busy, setBusy] = useState(false);
  const [optimistic, setOptimistic] = useState(null);
  const [waved, setWaved] = useState(false);

  const qtyText = rowQtyText(item, model.heads);
  const due = dueInfo(item.due_at, new Date(), prog.state === 'done' || item.done);
  const canPledge = !!me && (item.status === 'active' || (item.status === 'proposed' && item.created_by === me.id));
  const lookAlike = isAdmin && item.status === 'proposed' ? lookAlikeOf(item, model.items) : null;

  const run = async (fn, opts, optimisticValue = null) => {
    if (busy) return;
    setBusy(true);
    if (optimisticValue !== null) setOptimistic(optimisticValue);
    await runOk(fn, opts);
    setOptimistic(null);
    setBusy(false);
  };

  let action = null;
  if (ctx.over) {
    action = null;
  } else if (pendingTab && isAdmin && item.status === 'proposed') {
    action = html`<button type="button" class="ls-approve" disabled=${busy} aria-busy=${busy ? 'true' : undefined}
      aria-label=${`אישור: ${item.title}`}
      onClick=${() => run((api) => api.reviewItem(item.id, true, null), { success: `אושר ✅ ${item.title} ברשימה` })}>
      <${Icon} name="check" size=${16} /> אישור
    </button>`;
  } else if (item.status !== 'rejected') {
    let done = null;
    let toggle = null;
    const each = item.type === 'each' && item.status === 'active' ? myEachPart(item, me, model.snap) : null;
    if (each && !(each.part && each.part.qty === 0 && each.open === 0)) {
      // a couple that splits it ticks per person; nothing of it mine (all my partner's) → no tick here
      done = each.mineDone;
      toggle = (next) => (api) => api.setPledgeDone(item.id, next);
    } else if (myPledge && item.type !== 'each') {
      done = item.type === 'bring' ? !!myPledge.done : !!item.done;
      toggle = item.type === 'bring' ? (next) => (api) => api.setPledgeDone(item.id, next) : (next) => (api) => api.setItemDone(item.id, next);
    }
    if (toggle) {
      const shownDone = optimistic ?? done;
      action = html`<button
        type="button"
        class="check ls-check"
        role="checkbox"
        aria-checked=${shownDone ? 'true' : 'false'}
        aria-label=${`${meta.check}: ${item.title}`}
        disabled=${busy}
        onClick=${() => run(toggle(!shownDone), {}, !shownDone)}
      ><${Icon} name="check" /></button>`;
    } else if (canPledge && item.type !== 'each' && (needsPeople(prog.state) || item.status === 'proposed')) {
      action = html`<button
        type="button"
        class=${cx('ls-hand', waved && 'is-waving')}
        disabled=${busy}
        aria-busy=${busy ? 'true' : undefined}
        aria-label=${`אני על זה: ${item.title}`}
        onClick=${() => {
          setWaved(true);
          run((api) => api.pledge(item.id, 1), { success: PLEDGE_TOAST[item.type] || PLEDGE_TOAST.bring });
        }}
      ><span aria-hidden="true">✋</span> אני</button>`;
    }
  }

  return html`<div
    class=${cx('ls-row', `ls-row--${prog.state}`, flashId === item.id && 'is-new', myPledge && !mineTab && 'is-mine')}
    data-item=${item.id}
  >
    <button type="button" class="ls-row__open" onClick=${() => ctx.open(item.id)}>
      <span class="ls-row__main">
        <span class="ls-row__title">
          <span class="ls-row__name">${item.title}</span>
          ${ctx.isAdmin && (item.secret || ctx.model.catById.get(item.category_id)?.secret) ? html`<span class="ls-secret" title="הפתעה — מוסתר מהחוגג/ת" aria-label="הפתעה">🤫</span>` : null}
          ${qtyText ? html`<span class="ls-qty num">${qtyText}</span>` : null}
        </span>
        <span class="ls-row__meta">
          <${Pill} tone=${status.tone}>${status.text}</${Pill}>
          ${due ? html`<${Pill} tone=${due.late ? 'danger' : 'default'} class="ls-due" data-testid="item-due">${due.text}</${Pill}>` : null}
          ${lookAlike ? html`<${Pill} tone="warning" class="ls-dup-pill">🔁 דומה ל: ${lookAlike.title}</${Pill}>` : null}
          ${myPledge && item.type !== 'each' && (!mineTab || myPledge.qty > 1)
            ? html`<${Pill} tone="solid" class="ls-mine-pill">⭐ שלי${myPledge.qty > 1 && item.type === 'bring' ? ` ×${myPledge.qty}` : ''}</${Pill}>`
            : null}
          ${pledgers.length && item.type !== 'each' ? html`<${AvatarStack} members=${pledgers} max=${3} size=${22} />` : null}
          ${item.note ? html`<span class="ls-row__note">${item.note}</span>` : null}
        </span>
      </span>
    </button>
    ${action ? html`<span class="ls-row__action">${action}</span>` : null}
  </div>`;
}

// ---------------------------------------------------------------------------
// ⭐ שלי — private personal gear + everything I'm on
// ---------------------------------------------------------------------------

function MineTab({ ctx, matchesQuery, missingOnly, query }) {
  const { model, me } = ctx;
  if (!me) {
    return html`<div class="card"><${EmptyState} emoji="🙂" title="עוד לא בחרת פרופיל" text="אחרי שנכנסים לטיול אפשר לראות פה את כל מה שעליך." /></div>`;
  }
  const agenda = myAgenda(model.snap, me.id);
  const keep = (item, done) => matchesQuery(item) && (!missingOnly || !done);
  const bring = agenda.bring.filter(({ item, pledge }) => keep(item, pledge.done));
  const buy = agenda.buy.filter(({ item }) => keep(item, item.done));
  const tasks = agenda.tasks.filter(({ item }) => keep(item, item.done));
  const each = agenda.each.filter(({ item, done }) => keep(item, done));
  const inAgenda = new Set([...agenda.bring, ...agenda.buy, ...agenda.tasks, ...agenda.each].map((e) => e.item.id));
  const proposals = model.items.filter(
    (it) => it.created_by === me.id && it.status !== 'active' && !inAgenda.has(it.id) && matchesQuery(it),
  );
  const total = agenda.bring.length + agenda.buy.length + agenda.tasks.length + agenda.each.length;
  const anything = bring.length + buy.length + tasks.length + each.length + proposals.length;

  const group = (title, emoji, entries) => (entries.length
    ? html`<${Section} title=${title} emoji=${emoji} count=${entries.length} collapsible>
        <div class="list ls-list">
          ${entries.map(({ item }) => html`<${ItemRow} key=${item.id} item=${item} ctx=${ctx} />`)}
        </div>
      </${Section}>`
    : null);

  return html`<div class="ls-groups">
    ${hasModule(model.snap.trip, 'packing') ? html`<${PersonalGear} ctx=${ctx} query=${query} missingOnly=${missingOnly} />` : null}

    ${total
      ? html`<div class="card ls-mine-card">
          <div class="ls-mine-card__row">
            <div class="ls-mine-card__text">
              <span class="kicker">מה עליי לטיול</span>
              <strong class="ls-mine-card__pct num">${agenda.packedPct}% מוכן</strong>
            </div>
            <${ShareButton} text=${buildSummaryText(model.snap, 'mine', me.id)} label="לשלוח לעצמי" size="sm" />
          </div>
          <${ProgressBar} value=${agenda.packedPct} tone="success" label="כמה מהדברים שלי כבר מוכנים" />
        </div>`
      : null}

    ${group('מביא/ה מהבית', '🎒', bring)}
    ${group('קונה', '🛒', buy)}
    ${group('משימות שלי', '✅', tasks)}
    ${group('כל אחד מביא', '🙋', each)}
    ${group('ההצעות שלי', '💡', proposals.map((item) => ({ item })))}

    ${!anything
      ? html`<div class="card ls-empty">
          <${EmptyState}
            emoji=${query || missingOnly ? '🔍' : '🙌'}
            title=${query || missingOnly ? 'אין פה כלום כרגע' : 'עוד לא לקחת כלום'}
            text=${query || missingOnly ? 'נסו לנקות את החיפוש או את הסינון.' : 'מה חסר? בוחרים משהו ולוחצים ✋ — וזה שלך.'}
            action=${query || missingOnly
              ? null
              : html`<${Button} icon="list" href=${href(`/t/${ctx.tripId}/lists`)}>לכל הרשימות</${Button}>`}
          />
        </div>`
      : null}
  </div>`;
}

function PersonalGear({ ctx, query, missingOnly }) {
  const { model, tripId, me } = ctx;
  const all = [...(model.snap.personal_items || [])].sort(byItemOrder);
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [tplBusy, setTplBusy] = useState(false);
  const [optimistic, setOptimistic] = useState({});
  const inputRef = useRef(null);

  const isDone = (it) => optimistic[it.id] ?? !!it.done;
  const doneCount = all.filter(isDone).length;
  const q = normText(query);
  const shown = all.filter((it) => (!q || normText(it.title).includes(q)) && (!missingOnly || !isDone(it)));

  const add = async (e) => {
    e?.preventDefault();
    const t = title.trim();
    if (!t || adding) return;
    setAdding(true);
    const id = await actions.run((api) => api.addPersonal(tripId, t));
    setAdding(false);
    if (id !== undefined) setTitle('');
    inputRef.current?.focus();
  };

  const toggle = async (it) => {
    const next = !isDone(it);
    setOptimistic((o) => ({ ...o, [it.id]: next }));
    const ok = await runOk((api) => api.updatePersonal(it.id, { done: next }));
    setOptimistic((o) => {
      const c = { ...o };
      delete c[it.id];
      return c;
    });
    if (ok && next && all.length > 1 && all.every((x) => x.id === it.id || x.done)) {
      fireConfetti();
      actions.toast('הציוד האישי ארוז! 🎒🎉', 'success');
    }
  };

  const removing = useRef(new Set());
  const remove = async (it) => {
    if (removing.current.has(it.id)) return; // a double tap must not send a second delete
    removing.current.add(it.id);
    await runOk((api) => api.deletePersonal(it.id));
    removing.current.delete(it.id);
  };

  const addTemplate = async () => {
    setTplBusy(true);
    const n = await actions.run((api) => api.addPersonalTemplate(tripId));
    setTplBusy(false);
    if (n === undefined) return;
    actions.toast(n ? `נוספו ${hebrewCount(n, 'פריט', 'פריטים')} לציוד האישי 🎒` : 'כל הפריטים מהרשימה המוכנה כבר אצלך 👌', 'success');
  };

  const pct = all.length ? Math.round((doneCount * 100) / all.length) : 0;

  return html`<${Section}
    title="הציוד האישי שלי"
    emoji="🎒"
    count=${all.length ? `${doneCount}/${all.length}` : undefined}
    collapsible
    class="ls-personal"
  >
    <div class="card ls-personal__card">
      <p class="ls-private"><${Icon} name="lock" size=${14} /> ${(me?.people || []).length > 1
        ? `רק את/ה רואה את הרשימה הזו — לכל אחד מ${displayName(me)} רשימה משלו`
        : 'רק את/ה רואה את הרשימה הזו'}</p>
      ${all.length ? html`<${ProgressBar} value=${pct} tone="success" label="ציוד אישי ארוז" />` : null}
      ${all.length === 0
        ? html`<div class="ls-personal__empty">
            <span class="ls-personal__emoji" aria-hidden="true">🧳</span>
            <p>אוהל, שק שינה, קרם הגנה… רשימת ציוד מוכנה — ואת/ה רק מסמנ/ת מה נארז.</p>
            <${Button} variant="accent" icon="sparkles" loading=${tplBusy} onClick=${addTemplate}>להוסיף רשימת ציוד מוכנה</${Button}>
          </div>`
        : html`<ul class="ls-personal__list" role="list">
            ${shown.map((it) => html`<li key=${it.id} class=${cx('ls-pitem', isDone(it) && 'is-done')}>
              <button
                type="button"
                class="check"
                role="checkbox"
                aria-checked=${isDone(it) ? 'true' : 'false'}
                aria-label=${`ארזתי: ${it.title}`}
                onClick=${() => toggle(it)}
              ><${Icon} name="check" /></button>
              <span class="ls-pitem__title" onClick=${() => toggle(it)}>${it.title}</span>
              <${IconButton} icon="x" size=${18} label=${`הסרה: ${it.title}`} class="ls-pitem__del" onClick=${() => remove(it)} />
            </li>`)}
            ${!shown.length ? html`<li class="ls-pitem ls-pitem--empty muted small">אין התאמות 🙂</li>` : null}
          </ul>`}
      <form class="ls-personal__add" onSubmit=${add}>
        <input
          ref=${inputRef}
          class="input ls-personal__input"
          placeholder="עוד משהו לתיק…"
          aria-label="פריט חדש לציוד האישי"
          maxlength="80"
          enterkeyhint="done"
          value=${title}
          onInput=${(e) => setTitle(e.currentTarget.value)}
        />
        <${Button} type="submit" size="sm" icon="plus" loading=${adding} disabled=${!title.trim()}>הוספה</${Button}>
      </form>
      ${all.length
        ? html`<${Button} variant="ghost" size="sm" icon="sparkles" loading=${tplBusy} onClick=${addTemplate} class="ls-personal__tpl">השלמה מהרשימה המוכנה</${Button}>`
        : null}
    </div>
  </${Section}>`;
}

// ---------------------------------------------------------------------------
// Add / edit item form
// ---------------------------------------------------------------------------

const TYPE_OPTIONS = [
  { value: 'buy', label: '🛒 לקנות' },
  { value: 'bring', label: '🎒 מהבית' },
  { value: 'each', label: '🙋 כל אחד' },
  { value: 'task', label: '✅ משימה' },
];

const SELF_LABEL = { buy: 'אני קונה את זה', bring: 'אני מביא/ה את זה', task: 'אני לוקח/ת את זה' };

function blankForm(patch) {
  return {
    title: '', category_id: null, type: 'buy', qty: '', unit: null, per_person: false, needed: 1, each_qty: 1, note: '', due: '',
    self: false, selfQty: 1, catTouched: false, typeTouched: false, ...patch,
  };
}

function formFromItem(item) {
  return blankForm({
    title: item.title || '',
    category_id: item.category_id || null,
    type: item.type || 'buy',
    qty: item.qty === null || item.qty === undefined ? '' : String(item.qty),
    unit: item.unit || null,
    per_person: !!item.per_person,
    needed: item.needed || 1,
    each_qty: item.each_qty || 1,
    note: item.note || '',
    due: item.due_at ? (({ ymd, hm }) => `${ymd}T${hm}`)(ilWallDue(new Date(item.due_at))) : '',
    catTouched: true,
    typeTouched: true,
  });
}

function parseQty(v) {
  const t = String(v ?? '').trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function validateForm(form) {
  const errors = {};
  const title = form.title.trim();
  if (!title) errors.title = 'איך קוראים לזה? 🙂';
  else if ([...title].length > 120) errors.title = 'שם קצר יותר, בבקשה (עד 120 תווים)';
  if (form.type === 'buy') {
    const q = parseQty(form.qty);
    if (Number.isNaN(q) || (q !== null && (q <= 0 || q > 1000000))) errors.qty = 'כמות לא תקינה';
  }
  if ([...form.note].length > 500) errors.note = 'ההערה ארוכה מדי';
  return errors;
}

function formToPayload(form, { creating }) {
  const p = {
    title: form.title.trim(),
    category_id: form.category_id || null,
    type: form.type,
    note: form.note.trim() || null,
    due_at: form.due ? ilIsoDue(form.due.slice(0, 10), form.due.slice(11, 16) || '09:00') : null,
  };
  if (form.type === 'buy') {
    const q = parseQty(form.qty);
    p.qty = q;
    p.unit = q !== null ? form.unit : null;
    p.per_person = q !== null && !!form.per_person;
  } else {
    p.qty = null;
    p.unit = null;
    p.per_person = false;
  }
  if (form.type === 'bring') p.needed = Math.max(1, Math.min(200, Number(form.needed) || 1));
  // "כל אחד מביא": how many per couple / family (§19) — 1 is the default (null)
  if (form.type === 'each') {
    const n = Math.max(1, Math.min(20, Number(form.each_qty) || 1));
    if (n > 1 || !creating) p.each_qty = n > 1 ? n : null;
  }
  if (creating && form.self && form.type !== 'each') p.pledge_qty = form.type === 'bring' ? form.selfQty : 1;
  return p;
}

/** Suggest a category/type from the title (reuses the WhatsApp list parser's keyword map). */
function suggestFromTitle(title, cats) {
  const t = title.trim();
  if (t.length < 2) return null;
  const [row] = parseListText(t);
  if (!row) return null;
  return { category: matchCategory(cats, row.category), type: row.type };
}

/** One-line horizontal chip scroller that keeps the selected chip (data-key) in view. */
export function ChipScroller({ label, selected, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const box = ref.current;
    const el = box && [...box.children].find((c) => c.dataset.key === String(selected));
    if (!box || !el || box.scrollWidth <= box.clientWidth) return;
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.left >= b.left + 8 && r.right <= b.right - 8) return;
    box.scrollBy({ left: r.left + r.width / 2 - (b.left + b.width / 2), behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [selected]);
  return html`<div class="h-scroll ls-scroller" role="group" aria-label=${label} ref=${ref}>${children}</div>`;
}

function ItemFormFields({ form, set, errors, ctx, creating, lockType, afterTitle = null }) {
  const { model, isAdmin } = ctx;
  const cats = model.cats;
  const onTitle = (e) => {
    const title = e.currentTarget.value;
    const patch = { title };
    if (creating) {
      const s = suggestFromTitle(title, cats);
      if (s && !form.catTouched && s.category) patch.category_id = s.category.id;
      if (s && !form.typeTouched && !lockType && s.type && itemTypeOn(model.snap.trip, s.type)) patch.type = s.type;
    }
    set(patch);
  };
  const q = parseQty(form.qty);
  const perPersonPreview = form.type === 'buy' && form.per_person && q > 0
    ? `${formatQty(q, form.unit)} × ${model.heads} אנשים = ${itemEffectiveQty({ qty: q, unit: form.unit, per_person: true }, model.heads).text}`
    : '';
  const showApprovalHint = creating && !isAdmin && model.requireApproval;
  const perPersonToggle = html`<${Toggle}
    checked=${form.per_person}
    onChange=${(v) => set({ per_person: v })}
    label="לאדם"
    hint=${perPersonPreview || 'הכמות מוכפלת במספר האנשים בטיול'}
  />`;
  const moreFields = html`<${Field} label="הערה" error=${errors.note}>
      <${TextArea} value=${form.note} onInput=${(e) => set({ note: e.currentTarget.value })} rows=${2} placeholder="מותג, גודל, למי לפנות… (לא חובה)" maxlength="500" />
    </${Field}>
    <${Field} label="⏰ עד מתי? (לא חובה)" hint="בזמן הזה מי שלקח את זה ועוד לא סימן — מקבל תזכורת בפוש ובמייל">
      <${TextInput} type="datetime-local" value=${form.due} onInput=${(e) => set({ due: e.currentTarget.value })} />
    </${Field}>`;

  return html`<div class="stack ls-form">
    <${Field} label="מה צריך?" error=${errors.title}>
      <${TextInput}
        value=${form.title}
        onInput=${onTitle}
        placeholder="למשל: פחמים, כסאות, מטקות…"
        maxlength="120"
        enterkeyhint="next"
        data-autofocus
      />
    </${Field}>
    ${afterTitle}

    <${Field} label="סוג">
      <${Segmented}
        options=${TYPE_OPTIONS.filter((o) => o.value === form.type || itemTypeOn(ctx.model.snap.trip, o.value))}
        value=${form.type}
        onChange=${(type) => set({ type, typeTouched: true })}
        label="סוג הפריט"
        class="ls-type-seg"
      />
    </${Field}>

    <${Field} label="קטגוריה">
      <${ChipScroller} label="קטגוריה" selected=${form.category_id || 'none'}>
        ${cats.map((c) => html`<${Chip}
          key=${c.id}
          data-key=${c.id}
          active=${form.category_id === c.id}
          onClick=${() => set({ category_id: form.category_id === c.id ? null : c.id, catTouched: true })}
        ><span aria-hidden="true">${c.emoji || '📦'}</span> ${c.name}</${Chip}>`)}
        <${Chip} data-key="none" active=${!form.category_id} tone="muted" onClick=${() => set({ category_id: null, catTouched: true })}>📦 בלי</${Chip}>
      </${ChipScroller}>
    </${Field}>

    ${form.type === 'buy'
      ? html`<div class="ls-qty-block">
          <${Field} label="כמות" error=${errors.qty}>
            <${TextInput}
              value=${form.qty}
              onInput=${(e) => set({ qty: e.currentTarget.value.replace(/[^\d.,]/g, '').slice(0, 9) })}
              inputmode="decimal"
              placeholder="לא חובה"
              class="ls-qty-input num"
            />
          </${Field}>
          <${ChipScroller} label="יחידה" selected=${form.unit || ''}>
            ${UNIT_CHIPS.map((u) => html`<${Chip} key=${u} data-key=${u} active=${form.unit === u} onClick=${() => set({ unit: form.unit === u ? null : u })}>${u}</${Chip}>`)}
          </${ChipScroller}>
          ${creating ? null : perPersonToggle}
        </div>`
      : null}

    ${form.type === 'bring'
      ? html`<div class="ls-needed">
          <span class="ls-needed__text">
            <span class="field__label">כמה צריך בסה״כ?</span>
            <span class="field__hint">למשל 8 כסאות — כל אחד מסמן כמה הוא מביא</span>
          </span>
          <${Stepper} value=${form.needed} min=${1} max=${200} onChange=${(v) => set({ needed: v })} label="כמה צריך" />
        </div>`
      : null}

    ${form.type === 'each'
      ? html`<div class="ls-needed" data-testid="each-qty">
          <span class="ls-needed__text">
            <span class="field__label">כמה לכל זוג/משפחה?</span>
            <span class="field__hint">יחיד/ה מביא/ה ${Math.ceil((Number(form.each_qty) || 1) / 2)} · כל זוג בוחר: ביחד או כל אחד את שלו</span>
          </span>
          <${Stepper} value=${form.each_qty || 1} min=${1} max=${20} onChange=${(v) => set({ each_qty: v })} label="כמה לכל זוג" />
        </div>`
      : null}

    ${creating
      // a new item asks only what's needed (ux L5): the rest waits behind "+ עוד פרטים"
      ? html`<details class="ls-more" open=${Boolean(errors.note) || undefined} data-testid="item-more">
          <summary class="ls-more__toggle link">+ עוד פרטים (הערה${form.type === 'buy' ? ', לאדם' : ''}, עד מתי)</summary>
          <div class="stack">${form.type === 'buy' ? perPersonToggle : null}${moreFields}</div>
        </details>`
      : moreFields}

    ${creating && form.type !== 'each'
      ? html`<div class="ls-self">
          <${Toggle} checked=${form.self} onChange=${(v) => set({ self: v, selfQty: Math.max(1, form.needed || 1) })} label=${`✋ ${SELF_LABEL[form.type]}`} />
          ${form.self && form.type === 'bring' && form.needed > 1
            ? html`<div class="ls-needed">
                <span class="ls-needed__text"><span class="field__label">כמה אני מביא/ה?</span></span>
                <${Stepper} value=${form.selfQty} min=${1} max=${form.needed} onChange=${(v) => set({ selfQty: v })} label="כמה אני מביא/ה" />
              </div>`
            : null}
        </div>`
      : null}

    ${showApprovalHint
      ? html`<p class="ls-approval-hint" role="note">⏳ ההצעה תישלח לאישור מנהל — ותופיע ברשימה עם "ממתין לאישור".</p>`
      : null}
  </div>`;
}

function AddItemSheet({ open, prefill, tab, ctx, onClose, onAdded, onOpenExisting }) {
  const { tripId, isAdmin, model } = ctx;
  const typeFromTab = ['buy', 'bring', 'each', 'task'].includes(tab) ? tab : null;
  const [form, setForm] = useState(() => blankForm());
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  useLayoutEffect(() => {
    if (!open) return;
    const base = blankForm({ type: typeFromTab || 'buy', typeTouched: !!typeFromTab });
    let next = base;
    if (prefill?.title) {
      const s = suggestFromTitle(prefill.title, model.cats);
      next = {
        ...base,
        title: prefill.title,
        category_id: s?.category?.id || null,
        type: typeFromTab || s?.type || 'buy',
      };
    }
    // "מי מביא מה" off: a new item is a task (and the other way round)
    if (!itemTypeOn(model.snap.trip, next.type)) next = { ...next, type: itemTypeOn(model.snap.trip, 'buy') ? 'buy' : 'task' };
    setForm(next);
    setErrors({});
  }, [open]);

  const submit = async () => {
    const errs = validateForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    if (!(await confirmNotDuplicate(form.title, model.snap))) return;
    setSaving(true);
    const proposal = !isAdmin && model.requireApproval;
    const id = await actions.run((api) => api.addItem(tripId, formToPayload(form, { creating: true })), {
      success: proposal ? 'ההצעה נשלחה למנהלים ⏳' : 'נוסף לרשימה ✨',
    });
    setSaving(false);
    if (id !== undefined) onAdded(id);
  };

  const proposal = !isAdmin && model.requireApproval;
  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title=${proposal ? 'הצעת פריט ✨' : 'פריט חדש ✨'}
    class="ls-sheet"
    footer=${html`
      <${Button} variant="accent" icon=${proposal ? 'send' : 'plus'} loading=${saving} onClick=${submit}>
        ${proposal ? 'שליחת הצעה' : 'הוספה לרשימה'}
      </${Button}>
      <${Button} variant="secondary" onClick=${onClose}>ביטול</${Button}>`}
  >
    <form onSubmit=${(e) => { e.preventDefault(); submit(); }}>
      <${ItemFormFields} form=${form} set=${set} errors=${errors} ctx=${ctx} creating=${true} lockType=${!!typeFromTab}
        afterTitle=${html`<${SimilarItemsNotice} title=${form.title} snap=${model.snap} onOpen=${onOpenExisting} />`} />
      <button type="submit" hidden></button>
    </form>
  </${Sheet}>`;
}

// ---------------------------------------------------------------------------
// Item sheet
// ---------------------------------------------------------------------------

function ItemSheet({ open, item, ctx, onClose }) {
  const last = useRef(item);
  if (item) last.current = item;
  const it = item || last.current;
  const [mode, setMode] = useState('view'); // view | edit | reject
  const [form, setForm] = useState(() => blankForm());
  const [errors, setErrors] = useState({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    setMode('view');
    setReason('');
    setErrors({});
    setBusy(null);
  }, [it?.id, open]);

  const act = async (key, fn, opts) => {
    setBusy(key);
    const ok = await runOk(fn, opts);
    setBusy(null);
    return ok;
  };

  const startEdit = () => {
    setForm(formFromItem(it));
    setErrors({});
    setMode('edit');
  };
  const saveEdit = async () => {
    const errs = validateForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const patch = formToPayload(form, { creating: false });
    if (await act('save', (api) => api.updateItem(it.id, patch), { success: 'נשמר ✓' })) setMode('view');
  };
  const reject = async () => {
    const why = reason.trim() || null;
    if (await act('reject', (api) => api.reviewItem(it.id, false, why), { success: 'ההצעה נדחתה' })) setMode('view');
  };
  const approve = () => act('approve', (api) => api.reviewItem(it.id, true, null), { success: 'אושר ✅ ונוסף לרשימה' });

  let footer = null;
  if (it && mode === 'edit') {
    footer = html`
      <${Button} icon="check" loading=${busy === 'save'} onClick=${saveEdit}>שמירה</${Button}>
      <${Button} variant="secondary" onClick=${() => setMode('view')}>ביטול</${Button}>`;
  } else if (it && mode === 'reject') {
    footer = html`
      <${Button} variant="danger" loading=${busy === 'reject'} onClick=${reject}>דחיית ההצעה</${Button}>
      <${Button} variant="secondary" onClick=${() => setMode('view')}>ביטול</${Button}>`;
  } else if (it && ctx.isAdmin && it.status === 'proposed') {
    footer = html`
      <${Button} icon="check" loading=${busy === 'approve'} onClick=${approve}>אישור</${Button}>
      <${Button} variant="secondary" icon="x" onClick=${() => setMode('reject')}>דחייה</${Button}>`;
  }

  let body = null;
  if (it && mode === 'edit') {
    body = html`<form onSubmit=${(e) => { e.preventDefault(); saveEdit(); }}>
      <${ItemFormFields} form=${form} set=${(p) => setForm((f) => ({ ...f, ...p }))} errors=${errors} ctx=${ctx} creating=${false} />
      <button type="submit" hidden></button>
    </form>`;
  } else if (it && mode === 'reject') {
    body = html`<div class="stack">
      <p class="muted">למה לא? ההסבר יישלח למי שהציע/ה (לא חובה).</p>
      <${Field} label="סיבת הדחייה">
        <${TextArea} value=${reason} onInput=${(e) => setReason(e.currentTarget.value)} rows=${3} maxlength="500"
          placeholder="למשל: כבר יש לנו מספיק 🙂" data-autofocus />
      </${Field}>
    </div>`;
  } else if (it) {
    body = html`<${ItemDetails} key=${it.id} item=${it} ctx=${ctx} busy=${busy} act=${act}
      onEdit=${startEdit} onReject=${() => setMode('reject')} />`;
  }

  const title = it ? (mode === 'edit' ? 'עריכת פריט' : mode === 'reject' ? `דחיית "${it.title}"` : it.title) : '';
  return html`<${Sheet} open=${open} onClose=${onClose} title=${title} footer=${footer} class="ls-sheet">${body}</${Sheet}>`;
}

function ItemDetails({ item, ctx, busy, act, onEdit, onReject }) {
  const { model, me, isAdmin } = ctx;
  const prog = model.progress.get(item.id) || itemProgress(item, [], model.members);
  const meta = typeMeta(item.type);
  const status = itemStatus(item, prog);
  const cat = model.catById.get(item.category_id);
  const creator = model.byMember.get(item.created_by);
  const lookAlike = isAdmin && item.status === 'proposed' ? lookAlikeOf(item, model.items) : null;
  const myPledge = me ? prog.pledgers.find((p) => p.member_id === me.id) : null;
  const eff = itemEffectiveQty(item, model.heads);
  const isCreator = !!me && item.created_by === me.id;
  const canEdit = isAdmin || (isCreator && item.status === 'proposed');
  const canDelete = isAdmin || (isCreator && item.status !== 'active');
  const due = dueInfo(item.due_at, new Date(), item.done);

  const remove = async () => {
    const ok = await confirmDialog({
      title: `למחוק את "${item.title}"?`,
      text: prog.pledgers.length ? 'מי שהתחייב/ה להביא את זה יוסר/ו מהפריט.' : 'אי אפשר לבטל את זה.',
      confirmText: 'מחיקה',
      danger: true,
    });
    if (!ok) return;
    ctx.forget(item.id); // the list closes this sheet as soon as the item leaves the snapshot
    await act('delete', (api) => api.deleteItem(item.id), { success: 'הפריט נמחק' });
  };

  return html`<div class="ls-details">
    <div class="ls-details__chips">
      <${Pill} tone="solid" class="ls-details__type"><span aria-hidden="true">${meta.emoji}</span> ${meta.label}</${Pill}>
      ${cat ? html`<${Pill}><span aria-hidden="true">${cat.emoji || '📦'}</span> ${cat.name}</${Pill}>` : null}
      <${Pill} tone=${status.tone}>${status.text}</${Pill}>
      ${due ? html`<${Pill} tone=${due.late ? 'danger' : 'default'} data-testid="details-due">${due.text}</${Pill}>` : null}
    </div>

    ${eff.text && item.type !== 'each'
      ? html`<div class="ls-qtybox">
          <span class="ls-qtybox__big num">${eff.text}</span>
          ${item.per_person
            ? html`<span class="ls-qtybox__formula num">${formatQty(item.qty, item.unit)} לאדם × ${model.heads} אנשים = ${eff.text}</span>`
            : null}
        </div>`
      : null}

    ${item.note ? html`<p class="ls-note"><span aria-hidden="true">📝</span> ${item.note}</p>` : null}

    ${item.status === 'proposed'
      ? html`<div class="ls-banner ls-banner--warning">
          <span class="ls-banner__emoji" aria-hidden="true">⏳</span>
          <span><strong>ממתין לאישור מנהל</strong><br />
            <span class="small">הוצע ע״י ${creator ? actorName(creator, item.by_person) : 'מישהו'} · ${timeAgo(item.created_at)}</span></span>
        </div>`
      : null}
    ${lookAlike
      ? html`<div class="ls-banner ls-banner--warning" data-testid="dup-banner">
          <span class="ls-banner__emoji" aria-hidden="true">🔁</span>
          <span><strong>דומה לפריט שכבר ברשימה:</strong>${' '}
            <button type="button" class="link" onClick=${() => ctx.open(lookAlike.id)}>${lookAlike.title}</button><br />
            <span class="small">אם זה אותו דבר — עדיף לדחות, והמציע/ה יוכל/תוכל להצטרף לפריט הקיים.</span></span>
        </div>`
      : null}
    ${item.status === 'rejected'
      ? html`<div class="ls-banner ls-banner--danger">
          <span class="ls-banner__emoji" aria-hidden="true">🚫</span>
          <span><strong>ההצעה נדחתה</strong>${item.reject_reason ? html`<br /><span class="small">${item.reject_reason}</span>` : null}</span>
        </div>`
      : null}

    <${ProgressBlock} item=${item} prog=${prog} model=${model} />
    <${MyPart} item=${item} prog=${prog} ctx=${ctx} myPledge=${myPledge} busy=${busy} act=${act} />
    <${PledgeList} item=${item} prog=${prog} ctx=${ctx} act=${act} />
    <${InventoryHint} item=${item} prog=${prog} ctx=${ctx} act=${act} busy=${busy} />
    ${isAdmin && item.type !== 'each' && item.status !== 'rejected'
      ? html`<${AssignBox} item=${item} ctx=${ctx} act=${act} busy=${busy} />`
      : null}

    ${canEdit || canDelete
      ? html`<div class="ls-details__manage">
          ${canEdit ? html`<${Button} variant="secondary" icon="edit" onClick=${onEdit}>עריכה</${Button}>` : null}
          ${isAdmin && model.snap.trip.settings?.groom
            ? html`<${Button} variant=${item.secret || cat?.secret ? 'accent' : 'secondary'} loading=${busy === 'secret'} data-testid="item-secret"
                disabled=${Boolean(cat?.secret && !item.secret)}
                onClick=${() => act('secret', (api) => api.setSecret('item', item.id, !item.secret), { success: item.secret ? 'הפריט גלוי לכולם' : 'מוסתר מהחוגג/ת 🤫' })}>
                🤫 ${item.secret ? 'מוסתר מהחוגג/ת — ביטול' : cat?.secret ? 'הקטגוריה מוסתרת' : 'הסתרה מהחוגג/ת'}</${Button}>` : null}
          ${isAdmin && item.status === 'proposed' ? html`<${Button} variant="secondary" icon="x" onClick=${onReject}>דחייה</${Button}>` : null}
          ${canDelete ? html`<${Button} variant="ghost" icon="trash" class="ls-danger-ghost" loading=${busy === 'delete'} onClick=${remove}>מחיקה</${Button}>` : null}
        </div>`
      : null}
    ${item.created_at
      ? html`<p class="ls-details__foot tiny muted">נוסף ע״י ${creator ? actorName(creator, item.by_person) : 'מישהו'} · ${timeAgo(item.created_at)}</p>`
      : null}
  </div>`;
}

function ProgressBlock({ item, prog, model }) {
  if (item.status !== 'active') return null;
  if (item.type === 'bring' && prog.needed > 1) {
    const missing = Math.max(0, prog.needed - prog.pledged);
    return html`<div class="ls-progress">
      <div class="row row--between">
        <strong class="num">${prog.pledged} מתוך ${prog.needed}</strong>
        <span class=${cx('small', missing ? 'ls-missing-text' : 'ls-ok-text')}>${missing ? `חסרים ${missing}` : 'מכוסה 🎉'}</span>
      </div>
      <${ProgressBar} value=${(Math.min(prog.pledged, prog.needed) * 100) / prog.needed} tone=${missing ? 'accent' : 'success'} label="כמה כבר מכוסה" />
    </div>`;
  }
  if (item.type === 'each') {
    const doneIds = new Set(prog.pledgers.filter((p) => p.done).map((p) => p.member_id));
    const done = model.members.filter((m) => doneIds.has(m.id));
    const notYet = model.members.filter((m) => !doneIds.has(m.id));
    // per couple / family (§19): how many things, and how many are packed
    const units = prog.units && prog.units.needed !== prog.total ? prog.units : null;
    return html`<div class="ls-progress">
      <div class="row row--between">
        <strong class="num">${prog.doneCount} מתוך ${prog.total} ארזו</strong>
        ${units ? html`<span class="small muted num" data-testid="each-units">${units.done} מתוך ${units.needed} ${item.title}</span>` : null}
      </div>
      <${ProgressBar} value=${prog.total ? (prog.doneCount * 100) / prog.total : 0} tone="success" label="כמה כבר ארזו" />
      <div class="ls-each-who">
        ${done.length
          ? html`<div class="ls-each-who__row"><span class="small muted">ארזו ✓</span><${AvatarStack} members=${done} max=${8} size=${28} /></div>`
          : null}
        ${notYet.length
          ? html`<div class="ls-each-who__row"><span class="small muted">עוד לא</span><${AvatarStack} members=${notYet} max=${8} size=${28} /></div>`
          : null}
      </div>
    </div>`;
  }
  return null;
}

function MyPart({ item, prog, ctx, myPledge, busy, act }) {
  const { isAdmin, me } = ctx;
  const meta = typeMeta(item.type);
  const pledgeInit = myPledge?.qty || Math.max(1, Math.min(200, prog.needed - prog.pledged));
  const [qty, setQty] = useState(pledgeInit);
  useEffect(() => setQty(pledgeInit), [myPledge?.qty]);
  if (!me || item.status === 'rejected') return null;

  const canPledge = item.status === 'active' || (item.status === 'proposed' && item.created_by === me.id);

  if (item.type === 'each') {
    if (item.status !== 'active') return null;
    return html`<${EachPart} item=${item} ctx=${ctx} busy=${busy} act=${act} />`;
  }

  if (!canPledge && !isAdmin) {
    return html`<p class="ls-hint">אחרי שמנהל/ת יאשר/תאשר — אפשר יהיה להתחייב ✋</p>`;
  }

  const pledge = (n, success) => act('pledge', (api) => api.pledge(item.id, n), { success });
  const unpledge = async () => {
    const ok = await confirmDialog({ title: 'לוותר על הפריט?', text: 'הוא יחזור לרשימת "חסר" כדי שמישהו אחר ייקח.', confirmText: 'כן, לוותר' });
    if (ok) pledge(0, 'הורדנו אותך מהפריט');
  };
  const doneToggle = (label) => {
    const checked = item.type === 'bring' ? !!myPledge?.done : !!item.done;
    return html`<${Toggle} checked=${checked} disabled=${busy === 'done'} label=${label}
      onChange=${(v) => act('done', (api) => (item.type === 'bring' ? api.setPledgeDone(item.id, v) : api.setItemDone(item.id, v)))} />`;
  };

  const verb = { buy: 'אני קונה 🛒', bring: 'אני מביא/ה 🎒', task: 'אני לוקח/ת את זה ✋' }[item.type] || 'אני על זה ✋';
  const othersOn = prog.pledgers.some((p) => p.member_id !== me.id);

  return html`<div class=${cx('ls-mypart', myPledge && 'is-mine')}>
    <h3 class="ls-mypart__title">${myPledge ? '⭐ זה עליך' : 'החלק שלי'}</h3>
    ${!myPledge && canPledge
      ? item.type === 'bring'
        ? html`<div class="ls-mypart__row">
            ${prog.needed > 1 || qty > 1 ? html`<${Stepper} value=${qty} min=${1} max=${200} onChange=${setQty} label="כמה אני מביא/ה" />` : null}
            <${Button} variant="accent" class="ls-grow" loading=${busy === 'pledge'} onClick=${() => pledge(qty, PLEDGE_TOAST.bring)}>${verb}</${Button}>
          </div>`
        : html`<${Button} variant=${othersOn ? 'secondary' : 'accent'} block loading=${busy === 'pledge'} onClick=${() => pledge(1, PLEDGE_TOAST[item.type])}>
            ${othersOn ? 'גם אני ✋' : verb}
          </${Button}>`
      : null}
    ${myPledge && item.type === 'bring'
      ? html`<div class="ls-mypart__row">
          <span class="ls-mypart__label">מביא/ה</span>
          <${Stepper} value=${qty} min=${1} max=${200} onChange=${setQty} label="כמה אני מביא/ה" />
          ${qty !== myPledge.qty
            ? html`<${Button} size="sm" loading=${busy === 'pledge'} onClick=${() => pledge(qty, 'הכמות עודכנה ✓')}>עדכון</${Button}>`
            : null}
        </div>`
      : null}
    ${myPledge ? doneToggle(`${meta.check} ✓`) : null}
    ${!myPledge && isAdmin && (item.type === 'buy' || item.type === 'task') && item.status === 'active'
      ? doneToggle(item.type === 'buy' ? 'סימון כנקנה' : 'סימון כבוצע')
      : null}
    ${myPledge
      ? html`<${Button} variant="ghost" size="sm" class="ls-danger-ghost ls-mypart__drop" loading=${busy === 'pledge' && qty === myPledge.qty} onClick=${unpledge}>
          ${item.type === 'buy' ? 'לא קונה בסוף' : item.type === 'task' ? 'לא אני בסוף' : 'לא מביא/ה בסוף'}
        </${Button}>`
      : null}
  </div>`;
}

/**
 * "החלק שלנו" of an "each" item (§19). Together (the default): one tick for the profile, "2 לזוג". A couple that
 * brings it each their own: my tick ("ארזתי את שלי (1)"), the partner's line, open units "עוד 1 — מי מביא? [אני]",
 * and one small link to change it for this item only.
 */
function EachPart({ item, ctx, busy, act }) {
  const { me, model } = ctx;
  const e = myEachPart(item, me, model.snap);
  if (!e) return null;
  const people = (me.people || []).filter(Boolean);
  const group = people.length >= 2;
  const unit = group ? ((Number(me.headcount) || 1) > 2 || people.length > 2 ? 'למשפחה' : 'לזוג') : null;
  const tick = (v) => act('done', (api) => api.setPledgeDone(item.id, v));
  const override = group
    ? html`<button type="button" class="link small ls-each-override" data-testid="each-override" disabled=${busy === 'split'}
        onClick=${() => act('split', (api) => api.setEachPart(item.id, { split: e.split ? 'together' : 'each' }),
          { success: e.split ? 'בפריט הזה — מביאים ביחד 💑' : 'בפריט הזה — כל אחד את שלו 🙋' })}>
        ${e.split ? `רק בפריט הזה: מביאים ביחד` : `רק בפריט הזה: כל אחד את שלו`}
      </button>`
    : null;
  if (!e.split || !e.part) {
    return html`<div class="ls-mypart" data-testid="each-part">
      <h3 class="ls-mypart__title">${group ? 'החלק שלנו' : 'החלק שלי'}</h3>
      <${Toggle} checked=${!!e.raw?.done} disabled=${busy === 'done'} label=${group ? 'ארזנו ✓' : 'ארזתי את שלי ✓'}
        hint=${e.target > 1 ? `${e.target} ${unit || 'שלך'}` : group ? `אחד ${unit}` : 'כל זוג/יחיד מביא משלו'}
        onChange=${tick} />
      ${override}
    </div>`;
  }
  const mine = e.part;
  return html`<div class="ls-mypart" data-testid="each-part">
    <h3 class="ls-mypart__title">החלק שלנו <span class="small muted">· ${e.target} ${unit}</span></h3>
    ${mine.qty > 0
      ? html`<${Toggle} checked=${mine.done} disabled=${busy === 'done'} label=${`ארזתי את שלי (${mine.qty})`} onChange=${tick} />`
      : null}
    ${e.others.map((o) => html`<p class="small ls-each-partner" key=${o.person} data-testid="each-partner">
      ${o.person}: ${o.qty === 0 ? 'לא מביא/ה מזה' : o.done ? `ארז/ה ✓ (${o.qty})` : `עוד לא (${o.qty})`}</p>`)}
    ${e.open > 0
      ? html`<div class="ls-mypart__row" data-testid="each-open">
          <span class="ls-mypart__label">עוד ${e.open} — מי מביא?</span>
          <${Button} size="sm" variant="accent" loading=${busy === 'claim'}
            onClick=${() => act('claim', (api) => api.setEachPart(item.id, { claim: mine.qty + 1 }), { success: `סגור — ${mine.qty + 1} עליך ✋` })}>אני</${Button}>
        </div>`
      : null}
    ${override}
  </div>`;
}

function PledgeList({ item, prog, ctx, act }) {
  const { model, isAdmin } = ctx;
  if (item.type === 'each' || !prog.pledgers.length) return null;
  const pledges = model.pledgesByItem.get(item.id) || [];
  const unassign = async (m) => {
    const ok = await confirmDialog({ title: `להסיר את ${displayName(m)}?`, text: `הפריט "${item.title}" יחזור להיות פתוח.`, confirmText: 'הסרה', danger: true });
    if (ok) act(`un-${m.id}`, (api) => api.assign(item.id, m.id, 0), { success: 'הוסר מהפריט' });
  };
  return html`<div class="ls-pledges">
    <h3 class="ls-subtitle">${item.type === 'buy' ? 'מי קונה' : item.type === 'task' ? 'מי אחראי/ת' : 'מי מביא'}</h3>
    <ul class="list ls-pledges__list" role="list">
      ${prog.pledgers.map((p) => {
        const m = model.byMember.get(p.member_id);
        if (!m) return null;
        const raw = pledges.find((x) => x.member_id === p.member_id);
        const by = raw?.assigned_by ? model.byMember.get(raw.assigned_by) : null;
        return html`<li key=${p.member_id} class="list-row ls-pledge">
          <${Avatar} member=${m} size=${34} />
          <span class="list-row__main">
            <span class="list-row__title">${displayName(m)}${item.type === 'bring' && p.qty > 1 ? html` <span class="ls-qty num">×${p.qty}</span>` : null}</span>
            ${by && by.id !== m.id ? html`<span class="list-row__sub">שובץ/ה ע״י ${actorName(by, raw.by_person)}</span>` : null}
          </span>
          <span class="list-row__end">
            ${item.type === 'bring'
              ? html`<${Pill} tone=${p.done ? 'success' : 'default'}>${p.done ? 'ארוז ✓' : 'עוד לא ארוז'}</${Pill}>`
              : null}
            ${isAdmin
              ? html`<${IconButton} icon="x" size=${18} label=${`הסרת ${displayName(m)} מהפריט`} class="ls-pledge__del" onClick=${() => unassign(m)} />`
              : null}
          </span>
        </li>`;
      })}
    </ul>
  </div>`;
}

function InventoryHint({ item, prog, ctx, act, busy }) {
  const { model, me, isAdmin } = ctx;
  if (item.type === 'each' || item.status === 'rejected' || coveredState(prog.state)) return null;
  const taken = new Set(prog.pledgers.map((p) => p.member_id));
  const matches = inventoryMatches(item.title, model.members, taken);
  if (!matches.length) return null;
  const tripName = model.snap.trip?.name || 'הטיול';
  return html`<div class="ls-inventory">
    <h3 class="ls-subtitle">💡 למי יש בבית?</h3>
    <ul class="list" role="list">
      ${matches.map(({ member, what }) => {
        const isMe = me && member.id === me.id;
        const wa = !isMe && member.phone
          ? whatsappChatUrl(member.phone, `היי ${displayName(member)}! 🔥 ראיתי במדורה שיש לך ${what} — יש מצב שתביאו ל${tripName}? 🙏`)
          : null;
        return html`<li key=${member.id} class="list-row ls-inv-row">
          <${Avatar} member=${member} size=${34} />
          <span class="list-row__main">
            <span class="list-row__title">${isMe ? 'את/ה 😉' : displayName(member)}</span>
            <span class="list-row__sub">יש בבית: ${what}</span>
          </span>
          <span class="list-row__end">
            ${isAdmin && item.status !== 'rejected'
              ? html`<${Button} size="sm" variant="secondary" loading=${busy === `as-${member.id}`}
                  onClick=${() => act(`as-${member.id}`, (api) => api.assign(item.id, member.id, 1), { success: `שובץ ל${displayName(member)} 👍` })}>שיבוץ</${Button}>`
              : null}
            ${wa ? html`<${IconButton} icon="phone" size=${18} href=${wa} target="_blank" rel="noopener noreferrer" label=${`לבקש מ${displayName(member)} בוואטסאפ`} class="ls-wa" />` : null}
          </span>
        </li>`;
      })}
    </ul>
  </div>`;
}

function AssignBox({ item, ctx, act, busy }) {
  const { model } = ctx;
  const [to, setTo] = useState(null);
  const [qty, setQty] = useState(1);
  const target = to ? model.byMember.get(to) : null;
  const assign = async () => {
    if (!target) return;
    const ok = await act('assign', (api) => api.assign(item.id, target.id, item.type === 'bring' ? qty : 1), {
      success: `שובץ ל${displayName(target)} 👍`,
    });
    if (ok) setTo(null);
  };
  return html`<details class="ls-admin">
    <summary class="ls-admin__summary"><span aria-hidden="true">👑</span> שיבוץ חבר/ה<${Icon} name="chevron-down" size=${18} class="ls-admin__chev" /></summary>
    <div class="stack ls-admin__body">
      <${MemberPicker} members=${model.members} value=${to} onChange=${(id) => setTo(to === id ? null : id)} label="למי לשבץ" />
      <div class="ls-mypart__row">
        ${item.type === 'bring' ? html`<${Stepper} value=${qty} min=${1} max=${200} onChange=${setQty} label="כמה" />` : null}
        <${Button} class="ls-grow" icon="check" disabled=${!target} loading=${busy === 'assign'} onClick=${assign}>
          ${target ? `שיבוץ ל${displayName(target)}` : 'בחרו למי'}
        </${Button}>
      </div>
    </div>
  </details>`;
}

// ---------------------------------------------------------------------------
// Overflow menu
// ---------------------------------------------------------------------------

function MenuSheet({ open, onClose, ctx }) {
  const { model, tripId, me } = ctx;
  const missingText = open ? buildSummaryText(model.snap, 'missing') : '';
  const mineText = open && me ? buildSummaryText(model.snap, 'mine', me.id) : '';
  const go = (path) => {
    onClose();
    navigate(path);
  };
  return html`<${Sheet} open=${open} onClose=${onClose} title="עוד אפשרויות">
    <div class="stack">
      <div class="list">
        ${hasModule(model.snap.trip, 'lists') || hasModule(model.snap.trip, 'tasks') ? html`<button type="button" class="list-row ls-menu-row" onClick=${() => go(`/t/${tripId}/build`)}>
          <span class="kbd-emoji" aria-hidden="true">✨</span>
          <span class="list-row__main">
            <span class="list-row__title">בניית רשימה מהירה</span>
            <span class="list-row__sub">קטגוריה אחרי קטגוריה — כותבים, Enter, והלאה</span>
          </span>
          <${Icon} name="chevron-left" size=${18} />
        </button>` : null}
        ${hasModule(model.snap.trip, 'lists') ? html`<button type="button" class="list-row ls-menu-row" onClick=${() => go(`/t/${tripId}/import`)}>
          <span class="kbd-emoji" aria-hidden="true">📥</span>
          <span class="list-row__main">
            <span class="list-row__title">ייבוא רשימה מוואטסאפ</span>
            <span class="list-row__sub">מדביקים הודעה — והיא הופכת לפריטים מסודרים</span>
          </span>
          <${Icon} name="chevron-left" size=${18} />
        </button>` : null}
      </div>
      <${ShareButton} text=${missingText} label="📤 שתף מה חסר" block />
      ${me ? html`<${ShareButton} text=${mineText} label="לשלוח לעצמי את הרשימה שלי" variant="secondary" block />` : null}
    </div>
  </${Sheet}>`;
}
