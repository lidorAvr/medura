// Draft items editor (import + quick build, SPEC §8.6–§8.7): rows grouped by category, every field of every
// row editable in place (title, qty + unit, type, "לכל אדם", category, who), duplicates flagged, and a
// multi-select bar to move / retype / delete many rows at once. Plus the shared payload + save helpers.
//
// A draft row: { key, title, qty: number|null, unit, per_person, note, type, cat: 'id:<id>'|'new:<name>'|'none',
//                who: member id|null, done, include (import only), dup?: {kind, title, id},
//                link?: {itemId, who} (import only: the item is already in the list — put `who` on it instead) }
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { actions } from '../store.js?v=9252f89';
import { hebrewError } from '../api/errors.js?v=9252f89';
import { displayName, personsOf, similarItems, titleSimilarity } from '../lib/logic.js?v=9252f89';
import { itemTypeOn } from '../lib/templates.js?v=9252f89';
import { Chip, Pill, Sheet } from './components.js?v=9252f89';
import { Icon } from './icons.js?v=9252f89';
import { UNIT_CHIPS, cx, emojiKey, normText } from '../screens/lists.js?v=9252f89';

export const BULK_MAX = 150; // add_items_bulk limit per call (SPEC §4)

export const DRAFT_TYPES = [
  { value: 'buy', emoji: '🛒', label: 'לקנות' },
  { value: 'bring', emoji: '🎒', label: 'מהבית' },
  { value: 'each', emoji: '🙋', label: 'כל אחד' },
  { value: 'task', emoji: '✅', label: 'משימה' },
];

const DUP_LABEL = {
  same: () => 'כבר ברשימה',
  similar: (title) => `דומה ל: ${title}`,
  pasted: () => 'מופיע פעמיים ברשימה',
};

const MEASURES = new Set(['ק"ג', 'גרם', 'ליטר', 'מ"ל']);

export const isTasksCategory = (c) => !!c && (emojiKey(c.emoji) === '📋' || normText(c.name) === 'משימות');

/**
 * The trip's names for the parser ({names}) and a name → member id map: every person of a profile and the
 * profile's display name. A name two profiles share goes to the first one.
 */
export function tripNames(snap) {
  const byName = new Map();
  for (const m of snap?.members || []) {
    if (!m) continue;
    for (const n of [...personsOf(m).map((p) => p.name), displayName(m)]) {
      const k = String(n ?? '').trim();
      if (k && !byName.has(k)) byName.set(k, m.id);
    }
  }
  return { names: [...byName.keys()], byName };
}

/** A parsed `who` ('__me__' | one of the names) → member id, within what I may assign ('all' | 'me' | 'none'). */
export function resolveWho(who, byName, meId, canAssign) {
  if (!who || canAssign === 'none') return null;
  const id = who === '__me__' ? meId : byName.get(who) || null;
  if (!id) return null;
  return canAssign === 'all' || id === meId ? id : null;
}

/** Who may I put on items here: admins anyone, others only themselves — nobody when it goes for approval. */
export function assignMode(snap, isAdmin, meId) {
  if (!meId) return 'none';
  if (isAdmin) return 'all';
  return snap?.trip?.settings?.require_approval !== false ? 'none' : 'me';
}

/** Rows with `dup` set: same / look-alike of an item already in the trip, or the same title earlier in the draft. */
export function markDups(rows, items) {
  return rows.map((r, i) => {
    const like = similarItems(r.title, items, { limit: 1 })[0] || null;
    if (like) return { ...r, dup: { kind: like.match, title: like.item.title, id: like.item.id } };
    const twice = rows.find((o, j) => j < i && o.include !== false && titleSimilarity(o.title, r.title) === 'same');
    return { ...r, dup: twice ? { kind: 'pasted', title: twice.title } : null };
  });
}

/** add_items_bulk payload for a draft row (`newCats`: name → emoji of categories to create). */
export function draftPayload(r, newCats) {
  const p = { title: String(r.title).trim().slice(0, 120), type: r.type, note: r.note ? String(r.note).trim().slice(0, 500) || null : null };
  if (r.cat.startsWith('id:')) p.category_id = r.cat.slice(3);
  else if (r.cat.startsWith('new:')) {
    const name = r.cat.slice(4);
    p.category_name = name.slice(0, 40);
    p.category_emoji = newCats.get(name) || '📦';
  }
  const qty = Number(r.qty) > 0 ? Number(r.qty) : 0;
  if (r.type === 'buy' && qty) {
    p.qty = qty;
    p.unit = r.unit || null;
    p.per_person = !!r.per_person;
  } else if (r.type === 'bring' && qty) {
    if (MEASURES.has(r.unit)) {
      p.qty = qty;
      p.unit = r.unit;
    } else {
      p.needed = Math.max(1, Math.min(200, Math.round(qty))); // "2 מלקחיים" → needed 2
    }
  }
  if (r.who && r.type !== 'each') p.assign_to = r.who;
  if (r.done) p.done = true; // "✓ כבר סומן": saved as done (the assigned pledge too)
  return p;
}

/**
 * Save draft rows (in add_items_bulk chunks). Resolves the number added, or undefined on error (toasted).
 * `onSaved(keys)` runs after each chunk that saved, so the caller drops those rows and a retry only sends the rest.
 */
export function saveDrafts(tripId, rows, newCats, onSaved = () => {}) {
  const good = rows.filter((r) => String(r.title).trim());
  let saved = 0;
  return actions.run(async (api) => {
    let n = 0;
    for (let i = 0; i < good.length; i += BULK_MAX) {
      const chunk = good.slice(i, i + BULK_MAX);
      n += Number(await api.addItemsBulk(tripId, chunk.map((r) => draftPayload(r, newCats)))) || 0;
      saved += chunk.length;
      onSaved(chunk.map((r) => r.key));
    }
    return n;
  }, { error: (code) => (saved ? `נשמרו ${saved}, נכשלו ${good.length - saved} — אפשר לנסות שוב` : hebrewError(code)) });
}

/** "🥩 בשר ועוף" for a row's category key. */
export function catLabelOf(key, cats, newCats) {
  if (key.startsWith('id:')) {
    const c = cats.find((x) => x.id === key.slice(3));
    return c ? `${c.emoji || '📦'} ${c.name}` : '📦 בלי קטגוריה';
  }
  if (key.startsWith('new:')) return `${newCats.get(key.slice(4)) || '📦'} ${key.slice(4)}`;
  return '📦 בלי קטגוריה';
}

/** Groups in category order: trip categories → new categories → uncategorised. */
function groupRows(rows, cats, newCats) {
  const order = [...cats.map((c) => `id:${c.id}`), ...[...newCats.keys()].map((n) => `new:${n}`), 'none'];
  for (const r of rows) if (!order.includes(r.cat)) order.push(r.cat);
  return order
    .map((key) => ({ key, rows: rows.filter((r) => r.cat === key) }))
    .filter((g) => g.rows.length)
    .map((g) => {
      const [emoji, ...name] = catLabelOf(g.key, cats, newCats).split(' ');
      return { ...g, emoji, name: name.join(' '), isNew: g.key.startsWith('new:') };
    });
}

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

const qtyText = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '' : String(Number(v)));

/** Quantity box that keeps what's typed ("1." while typing 1.5) and reports numbers (null when empty). */
function QtyInput({ value, onChange, label }) {
  const [text, setText] = useState(qtyText(value));
  useEffect(() => {
    const t = text.replace(',', '.');
    const cur = t === '' ? null : Number(t);
    if (cur !== (value ?? null)) setText(qtyText(value));
  }, [value]);
  return html`<input
    type="text"
    inputmode="decimal"
    autocomplete="off"
    dir="ltr"
    class="input dr-qty num"
    aria-label=${label}
    placeholder="כמה"
    value=${text}
    onInput=${(e) => {
      const t = e.currentTarget.value.replace(/[^\d.,]/g, '').slice(0, 7);
      if (t !== e.currentTarget.value) e.currentTarget.value = t;
      setText(t);
      const n = Number(t.replace(',', '.'));
      if (t === '') onChange(null);
      else if (Number.isFinite(n) && n > 0) onChange(n);
    }}
  />`;
}

/**
 * The editor. props:
 *  rows (with dup), cats (trip categories in order), newCats (Map name → emoji), trip, members, meId,
 *  canAssign ('all'|'me'|'none'), onPatch(keys, patch), onRemove(keys), includable (import: per-row include),
 *  grouped (default true), emptyText.
 */
export function DraftRows({
  rows, cats, newCats, trip, members = [], meId, canAssign = 'none', onPatch, onRemove, includable = false, grouped = true,
}) {
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [picker, setPicker] = useState(null); // {keys, title, current}
  const types = DRAFT_TYPES.filter((t) => itemTypeOn(trip, t.value));
  const selKeys = rows.filter((r) => sel.has(r.key)).map((r) => r.key);

  useEffect(() => {
    if (!selecting) setSel(new Set());
  }, [selecting]);

  const toggleSel = (keys, on) => setSel((s) => {
    const next = new Set(s);
    for (const k of keys) (on ? next.add(k) : next.delete(k));
    return next;
  });
  const others = canAssign === 'all' ? members.filter((m) => m.id !== meId) : [];

  const row = (r) => {
    const t = r.title || '';
    const qtyOn = r.type === 'buy' || r.type === 'bring';
    const units = [...UNIT_CHIPS, ...(r.unit && !UNIT_CHIPS.includes(r.unit) ? [r.unit] : [])];
    const picked = sel.has(r.key);
    const off = includable && !r.include;
    // already in the list with a name next to it: nothing to edit — that person goes on the existing item
    const linked = Boolean(r.link) && !off;
    const linkName = r.link ? (r.link.who === meId ? null : displayName(members.find((m) => m.id === r.link.who))) : null;
    return html`<div key=${r.key} class=${cx('dr-row', off && 'is-off', picked && 'is-picked')} data-title=${t}>
      ${selecting
        ? html`<button type="button" class="check dr-row__sel" role="checkbox" aria-checked=${picked ? 'true' : 'false'}
            aria-label=${`בחירה: ${t}`} onClick=${() => toggleSel([r.key], !picked)}><${Icon} name="check" /></button>`
        : includable
          ? html`<button type="button" class="check" role="checkbox" aria-checked=${r.include ? 'true' : 'false'}
              aria-label=${`לייבא: ${t}`} onClick=${() => onPatch([r.key], { include: !r.include })}><${Icon} name="check" /></button>`
          : null}
      <div class="dr-row__main">
        <div class="dr-row__top">
          ${off || linked
            // not imported (ux L6): just its name — tick it to edit
            ? html`<span class="dr-title dr-title--off">${t}</span>`
            : html`<input
                type="text"
                class="input dr-title"
                aria-label=${`שם הפריט: ${t}`}
                value=${t}
                maxlength="120"
                onInput=${(e) => onPatch([r.key], { title: e.currentTarget.value })}
              />
              <button type="button" class="dr-del" aria-label=${`מחיקה: ${t}`} title="מחיקה" onClick=${() => onRemove([r.key])}>
                <${Icon} name="x" size=${18} />
              </button>`}
        </div>
        ${r.dup || r.done || r.note
          ? html`<div class="dr-row__flags">
              ${r.done ? html`<${Pill} tone="success">✓ כבר סומן</${Pill}>` : null}
              ${r.link
                ? html`<${Pill} tone="info" class="dr-link" data-testid="dr-link">🔗 כבר ברשימה — ${linkName ? `נשבץ את ${linkName}` : 'נרשום אותך עליו'}</${Pill}>`
                : r.dup ? html`<${Pill} tone="warning" class="dr-dup">${DUP_LABEL[r.dup.kind](r.dup.title)}</${Pill}>` : null}
              ${r.note ? html`<span class="dr-row__note">${r.note}</span>` : null}
            </div>`
          : null}
        ${off || linked ? null : html`<div class="dr-row__controls">
          ${types.length > 1
            ? html`<div class="dr-types" role="radiogroup" aria-label=${`סוג: ${t}`}>
                ${types.map((ty) => html`<button
                  key=${ty.value}
                  type="button"
                  role="radio"
                  class=${cx('dr-type', r.type === ty.value && 'is-on')}
                  aria-checked=${r.type === ty.value ? 'true' : 'false'}
                  aria-label=${ty.label}
                  title=${ty.label}
                  onClick=${() => onPatch([r.key], { type: ty.value })}
                ><span aria-hidden="true">${ty.emoji}</span>${r.type === ty.value ? html`<span class="dr-type__label">${ty.label}</span>` : null}</button>`)}
              </div>`
            : null}
          ${qtyOn
            ? html`<span class="dr-qtybox">
                <${QtyInput} value=${r.qty} label=${`כמות: ${t}`} onChange=${(qty) => onPatch([r.key], { qty })} />
                <select class="dr-unit" aria-label=${`יחידה: ${t}`} value=${r.unit || ''}
                  onChange=${(e) => onPatch([r.key], { unit: e.currentTarget.value || null })}>
                  <option value="">${r.type === 'bring' ? 'יח׳' : '—'}</option>
                  ${units.filter((u) => !(r.type === 'bring' && u === 'יח׳')).map((u) => html`<option key=${u} value=${u}>${u}</option>`)}
                </select>
              </span>`
            : null}
          ${r.type === 'buy'
            ? html`<button type="button" class=${cx('dr-pp', r.per_person && 'is-on')} aria-pressed=${r.per_person ? 'true' : 'false'}
                onClick=${() => onPatch([r.key], { per_person: !r.per_person })}>👥 לכל אדם</button>`
            : null}
          <button type="button" class="dr-cat" aria-label=${`קטגוריה: ${catLabelOf(r.cat, cats, newCats)} — שינוי`}
            onClick=${() => setPicker({ keys: [r.key], title: `קטגוריה ל"${t}"`, current: r.cat })}>
            <span class="truncate">${catLabelOf(r.cat, cats, newCats)}</span><span aria-hidden="true" class="dr-cat__chev">▾</span>
          </button>
          ${canAssign !== 'none' && r.type !== 'each'
            ? html`<select class=${cx('dr-who', r.who && 'is-set')} aria-label=${`מי: ${t}`} value=${r.who || ''}
                onChange=${(e) => onPatch([r.key], { who: e.currentTarget.value || null })}>
                <option value="">👤 מי?</option>
                ${meId ? html`<option value=${meId}>🙋 אני</option>` : null}
                ${others.map((m) => html`<option key=${m.id} value=${m.id}>${displayName(m)}</option>`)}
              </select>`
            : null}
        </div>`}
      </div>
    </div>`;
  };

  const groups = grouped
    ? groupRows(rows, cats, newCats)
    : [{ key: 'all', rows, name: '', emoji: '', isNew: false, flat: true }];

  return html`<div class="dr">
    ${rows.length > 1
      ? html`<div class=${cx('dr-bar', selecting && 'is-on')} role=${selecting ? 'toolbar' : undefined} aria-label=${selecting ? 'פעולות על הנבחרים' : undefined}>
          ${selecting
            ? html`
              <span class="dr-bar__count"><strong class="num">${selKeys.length}</strong> נבחרו</span>
              <button type="button" class="link small" onClick=${() => toggleSel(rows.map((r) => r.key), selKeys.length < rows.length)}>
                ${selKeys.length < rows.length ? 'הכל' : 'אף אחד'}
              </button>
              <span class="dr-bar__acts">
                <button type="button" class="dr-bar__btn" disabled=${!selKeys.length}
                  onClick=${() => setPicker({ keys: selKeys, title: `קטגוריה ל־${selKeys.length} פריטים`, current: null })}>📂 קטגוריה</button>
                ${types.length > 1
                  ? html`<select class="dr-bar__btn dr-bar__type" aria-label="סוג לנבחרים" value="" disabled=${!selKeys.length}
                      onChange=${(e) => {
                        const v = e.currentTarget.value;
                        e.currentTarget.value = '';
                        if (v) onPatch(selKeys, { type: v });
                      }}>
                      <option value="">🔁 סוג</option>
                      ${types.map((ty) => html`<option key=${ty.value} value=${ty.value}>${ty.emoji} ${ty.label}</option>`)}
                    </select>`
                  : null}
                <button type="button" class="dr-bar__btn dr-bar__btn--danger" disabled=${!selKeys.length}
                  onClick=${() => {
                    onRemove(selKeys);
                    setSel(new Set());
                  }}>🗑️ מחיקה</button>
                <button type="button" class="dr-bar__btn" onClick=${() => setSelecting(false)}>סיום</button>
              </span>`
            : html`<button type="button" class="link small dr-bar__start" onClick=${() => setSelecting(true)}>☑️ בחירה של כמה פריטים</button>`}
        </div>`
      : null}

    ${groups.map((g) => html`<section key=${g.key} class="dr-group" aria-label=${g.flat ? undefined : g.name}>
      ${g.flat
        ? null
        : html`<div class="dr-group__head">
            <span class="dr-group__emoji" aria-hidden="true">${g.emoji}</span>
            <h2 class="dr-group__name">${g.name}</h2>
            ${g.isNew ? html`<${Pill} tone="info">קטגוריה חדשה</${Pill}>` : null}
            <span class="dr-group__count num">${includable ? `${g.rows.filter((r) => r.include).length}/${g.rows.length}` : g.rows.length}</span>
            ${selecting
              ? html`<button type="button" class="link small dr-group__change" onClick=${() => toggleSel(g.rows.map((r) => r.key), true)}>בחירת הקבוצה</button>`
              : html`<button type="button" class="link small dr-group__change"
                  onClick=${() => setPicker({ keys: g.rows.map((r) => r.key), title: `קטגוריה ל"${g.name}"`, current: g.key })}>העברה</button>`}
          </div>`}
      <div class="list dr-list">${g.rows.map(row)}</div>
    </section>`)}

    <${CategoryPicker}
      picker=${picker}
      cats=${cats}
      newCats=${newCats}
      onPick=${(key) => {
        onPatch(picker.keys, { cat: key });
        setPicker(null);
        if (selecting) setSel(new Set());
      }}
      onClose=${() => setPicker(null)}
    />
  </div>`;
}

export function CategoryPicker({ picker, cats, newCats, onPick, onClose }) {
  const [last, setLast] = useState(picker);
  useEffect(() => {
    if (picker) setLast(picker);
  }, [picker]);
  const p = picker || last;
  const newKeys = [...newCats.keys()].map((n) => `new:${n}`);
  return html`<${Sheet} open=${!!picker} onClose=${onClose} title=${p ? p.title : 'קטגוריה'}>
    <div class="ls-chips dr-picker" role="group" aria-label="בחירת קטגוריה">
      ${cats.map((c) => html`<${Chip} key=${c.id} active=${p?.current === `id:${c.id}`} onClick=${() => onPick(`id:${c.id}`)}>
        <span aria-hidden="true">${c.emoji || '📦'}</span> ${c.name}
      </${Chip}>`)}
      ${newKeys.map((k) => html`<${Chip} key=${k} tone="info" active=${p?.current === k} onClick=${() => onPick(k)}>
        <span aria-hidden="true">${newCats.get(k.slice(4))}</span> ${k.slice(4)} (חדשה)
      </${Chip}>`)}
      <${Chip} tone="muted" active=${p?.current === 'none'} onClick=${() => onPick('none')}>📦 בלי קטגוריה</${Chip}>
    </div>
  </${Sheet}>`;
}
