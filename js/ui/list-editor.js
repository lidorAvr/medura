// The trip's group lists & tasks, shown to its organiser while the trip is being made — theirs to shape: rename,
// reorder, add, remove (nothing ready-made knows the trip better than the person running it).
//
//   value = { categories: [{name, emoji}], items: [{k, title, type, needed, category_name}], packing: [string] }
//   <ListEditor value onChange allowedTypes=['buy','bring','each','task'] showPacking />
//   toSeed(value) → what create_trip / add_items_bulk take: {categories, items, packing}
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DRAFT_TYPES } from './draft-rows.js?v=5ff55d3';
import { confirmDialog } from './components.js?v=5ff55d3';

const MAX_CATEGORIES = 20;
const MAX_ITEMS = 300;
const NAME_MAX = 40;
const TITLE_MAX = 120;
const EMOJI_CHOICES = ['📦', '🛒', '🥩', '🥗', '🥤', '🍾', '🔥', '⛺', '🎒', '🎲', '🎉', '🎁', '👕', '📋', '✈️', '🧴', '🔊', '🏖️', '🍽️', '🧊'];

let keySeq = 0;
const nextKey = () => `li${++keySeq}`;

/** The editor's value from a tripSeed(): categories, items (with keys) and the personal packing list. */
export function fromSeed(seed) {
  return {
    categories: (seed.categories || []).map((c) => ({ name: c.name, emoji: c.emoji || '📦', ...(c.secret ? { secret: true } : {}) })),
    items: (seed.items || []).map((x) => ({
      k: nextKey(), title: x.title, type: x.type || 'bring', needed: x.needed || 1, category_name: x.category_name || null,
    })),
    packing: Array.isArray(seed.info?.packing) ? seed.info.packing.map((p) => String(p)) : [],
  };
}

/** Back to what create_trip + add_items_bulk take. Blank titles and unnamed categories are dropped. */
export function toSeed(value) {
  const cats = value.categories.filter((c) => String(c.name).trim()).slice(0, MAX_CATEGORIES)
    .map((c) => ({ name: String(c.name).trim().slice(0, NAME_MAX), emoji: c.emoji || '📦', ...(c.secret ? { secret: true } : {}) }));
  const names = new Set(cats.map((c) => c.name));
  const emojiOf = new Map(cats.map((c) => [c.name, c.emoji]));
  const items = value.items.filter((x) => String(x.title).trim() && names.has(x.category_name)).map((x) => ({
    title: String(x.title).trim().slice(0, TITLE_MAX), type: x.type, needed: x.needed || 1,
    category_name: x.category_name, category_emoji: emojiOf.get(x.category_name) || null,
  }));
  return { categories: cats, items, packing: value.packing.map((p) => String(p).trim()).filter(Boolean).slice(0, 80) };
}

/**
 * Tick / un-tick a focus pack (templates.js FOCUS_PACKS): adds its categories (when missing) and items (not twice), each
 * marked with `pack` so un-ticking takes out exactly what ticking brought — items the organiser added themselves stay,
 * and so does a category that has anything else in it.
 */
export function applyPack(value, key, seed, on) {
  if (on) {
    const have = new Set(value.categories.map((c) => c.name));
    const categories = [...value.categories, ...seed.categories.filter((c) => !have.has(c.name)).map((c) => ({ ...c, pack: key }))];
    const taken = new Set(value.items.map((x) => `${x.category_name}|${String(x.title).trim()}`));
    const items = [...value.items, ...seed.items.filter((x) => !taken.has(`${x.category_name}|${x.title}`))
      .map((x) => ({ k: nextKey(), ...x, pack: key }))].slice(0, MAX_ITEMS);
    return { ...value, categories: categories.slice(0, MAX_CATEGORIES), items };
  }
  const items = value.items.filter((x) => x.pack !== key);
  const used = new Set(items.map((x) => x.category_name));
  return { ...value, items, categories: value.categories.filter((c) => c.pack !== key || used.has(c.name)) };
}

export const countOf = (value) => ({
  categories: value.categories.length,
  items: value.items.filter((x) => String(x.title).trim()).length,
});

const typeOf = (t) => DRAFT_TYPES.find((x) => x.value === t) || DRAFT_TYPES[1];

function AddLine({ placeholder, label, onAdd, max = TITLE_MAX }) {
  const [text, setText] = useState('');
  const submit = (e) => {
    e?.preventDefault();
    const v = text.trim();
    if (!v) return;
    onAdd(v);
    setText('');
  };
  return html`<form class="lied__add" onSubmit=${submit}>
    <input class="input lied__input" value=${text} maxlength=${max} placeholder=${placeholder} aria-label=${label}
      enterkeyhint="done" onInput=${(e) => setText(e.target.value)} />
    <button type="submit" class="btn btn--secondary btn--sm lied__plus" aria-label=${`${label} — הוספה`} disabled=${!text.trim()}>＋</button>
  </form>`;
}

/** "מה חשוב לכם בטיול הזה?" — the focus packs as chips; `picked` is the set of ticked keys. */
export function PackPicker({ packs, picked, onToggle }) {
  if (!packs.length) return null;
  return html`<section class="lied__packs" data-testid="pack-picker" aria-labelledby="lied-packs-h">
    <h2 class="lied__h" id="lied-packs-h">מה חשוב לכם בטיול הזה?</h2>
    <p class="muted small">סמנו — ונוסיף את הרשימות, המשימות והמסמכים המתאימים. אפשר לשנות הכול למטה, וגם אחר כך.</p>
    <div class="lied__packchips" role="group" aria-label="מה חשוב בטיול">
      ${packs.map((p) => html`<button type="button" key=${p.key} class=${`lied__pack${picked.has(p.key) ? ' is-on' : ''}`} data-pack=${p.key}
        aria-pressed=${picked.has(p.key) ? 'true' : 'false'} title=${p.hint} onClick=${() => onToggle(p)}>
        <span aria-hidden="true">${p.emoji}</span> ${p.label}</button>`)}
    </div>
  </section>`;
}

export function ListEditor({ value, onChange, allowedTypes = ['buy', 'bring', 'each', 'task'], showPacking = true, showLists = true, showSecret = false }) {
  const [openCat, setOpenCat] = useState(() => value.categories[0]?.name ?? null);
  const [emojiFor, setEmojiFor] = useState(null);
  const total = useRef(0);
  total.current = value.items.length;
  // a pack that was just ticked opens its first category, so the organiser sees what came in
  const seenNames = useRef(new Set(value.categories.map((c) => c.name)));
  useEffect(() => {
    const added = value.categories.filter((c) => !seenNames.current.has(c.name) && c.pack);
    seenNames.current = new Set(value.categories.map((c) => c.name));
    if (added.length) setOpenCat(added[0].name);
  }, [value.categories]);
  const types = DRAFT_TYPES.filter((t) => allowedTypes.includes(t.value));
  const patch = (p) => onChange({ ...value, ...p });

  const setItem = (k, p) => patch({ items: value.items.map((x) => (x.k === k ? { ...x, ...p } : x)) });
  const cycleType = (x) => {
    if (types.length < 2) return;
    const i = types.findIndex((t) => t.value === x.type);
    setItem(x.k, { type: types[(i + 1) % types.length].value });
  };
  const removeItem = (k) => patch({ items: value.items.filter((x) => x.k !== k) });
  const moveItem = (k, dir) => {
    const at = value.items.findIndex((x) => x.k === k);
    const cat = value.items[at].category_name;
    let to = at + dir;
    while (to >= 0 && to < value.items.length && value.items[to].category_name !== cat) to += dir;
    if (to < 0 || to >= value.items.length) return;
    const items = [...value.items];
    [items[at], items[to]] = [items[to], items[at]];
    patch({ items });
  };
  const addItem = (cat, title) => {
    if (value.items.length >= MAX_ITEMS || !types.length) return;
    const base = types.find((t) => t.value === 'bring') || types[0];
    // a tasks category adds tasks
    const isTasks = /משימות/u.test(cat) && types.some((t) => t.value === 'task');
    patch({ items: [...value.items, { k: nextKey(), title, type: isTasks ? 'task' : base.value, needed: 1, category_name: cat }] });
  };

  const renameCategory = (idx, name) => {
    const old = value.categories[idx].name;
    const clean = name.slice(0, NAME_MAX);
    const taken = value.categories.some((c, i) => i !== idx && c.name === clean);
    if (taken) return;                                          // two categories can't share a name
    patch({
      categories: value.categories.map((c, i) => (i === idx ? { ...c, name: clean } : c)),
      items: value.items.map((x) => (x.category_name === old ? { ...x, category_name: clean } : x)),
    });
    if (openCat === old) setOpenCat(clean);
  };
  const moveCategory = (idx, dir) => {
    const to = idx + dir;
    if (to < 0 || to >= value.categories.length) return;
    const categories = [...value.categories];
    [categories[idx], categories[to]] = [categories[to], categories[idx]];
    patch({ categories });
  };
  const removeCategory = async (idx) => {
    const name = value.categories[idx].name;
    const n = value.items.filter((x) => x.category_name === name).length;
    if (n && !(await confirmDialog({ title: 'למחוק את הקטגוריה?', text: `״${name}״ ו־${n} הפריטים שבה יימחקו מהרשימות של הטיול.`, confirmText: 'כן, למחוק', danger: true }))) return;
    patch({ categories: value.categories.filter((_, i) => i !== idx), items: value.items.filter((x) => x.category_name !== name) });
  };
  const addCategory = (name) => {
    if (value.categories.length >= MAX_CATEGORIES || value.categories.some((c) => c.name === name)) return;
    patch({ categories: [...value.categories, { name: name.slice(0, NAME_MAX), emoji: '📦' }] });
    setOpenCat(name.slice(0, NAME_MAX));
  };

  const { categories, items } = countOf(value);
  return html`<div class="lied" data-testid="list-editor">
    ${showLists ? html`<p class="lied__count muted small" data-testid="list-editor-count">${categories} קטגוריות · ${items} פריטים</p>` : null}
    ${(showLists ? value.categories : []).map((c, idx) => {
      const rows = value.items.filter((x) => x.category_name === c.name);
      const open = openCat === c.name;
      return html`<section class=${`lied__cat${open ? ' is-open' : ''}`} key=${c.name} data-testid="list-editor-cat" data-cat=${c.name}>
        <div class="lied__cathead">
          <button type="button" class="lied__emoji" aria-label=${`אימוג׳י של ${c.name}`} onClick=${() => setEmojiFor(emojiFor === c.name ? null : c.name)}>${c.emoji}</button>
          <input class="input lied__catname" value=${c.name} maxlength=${NAME_MAX} aria-label="שם הקטגוריה" onFocus=${() => setOpenCat(c.name)}
            onChange=${(e) => renameCategory(idx, e.target.value.trim() || c.name)} />
          <button type="button" class="lied__count-pill" aria-expanded=${open ? 'true' : 'false'} aria-label=${`${c.name}: ${rows.length} פריטים — פתיחה וסגירה`}
            onClick=${() => setOpenCat(open ? null : c.name)}>${rows.length}</button>
          <span class="lied__ctrls">
            ${showSecret ? html`<button type="button" class=${`lied__secret${c.secret ? ' is-on' : ''}`} aria-pressed=${c.secret ? 'true' : 'false'}
              aria-label=${c.secret ? `${c.name}: הפתעה — מוסתרת מהחוגג/ת (לחיצה לביטול)` : `סימון ${c.name} כהפתעה — להסתיר מהחוגג/ת`} title="הפתעה — מוסתר מהחוגג/ת"
              data-testid="cat-secret" onClick=${() => patch({ categories: value.categories.map((x, i) => (i === idx ? { ...x, secret: !x.secret } : x)) })}>🤫</button>` : null}
            <button type="button" aria-label=${`הזזת ${c.name} למעלה`} disabled=${idx === 0} onClick=${() => moveCategory(idx, -1)}>▲</button>
            <button type="button" aria-label=${`הזזת ${c.name} למטה`} disabled=${idx === value.categories.length - 1} onClick=${() => moveCategory(idx, 1)}>▼</button>
            <button type="button" class="lied__del" aria-label=${`מחיקת הקטגוריה ${c.name}`} onClick=${() => removeCategory(idx)}>✕</button>
          </span>
        </div>
        ${emojiFor === c.name
          ? html`<div class="lied__emojis" role="group" aria-label="בחירת אימוג׳י">
              ${EMOJI_CHOICES.map((e) => html`<button type="button" key=${e} class=${e === c.emoji ? 'is-on' : ''}
                onClick=${() => { patch({ categories: value.categories.map((x, i) => (i === idx ? { ...x, emoji: e } : x)) }); setEmojiFor(null); }}>${e}</button>`)}
            </div>`
          : null}
        ${open
          ? html`<ul class="lied__items">
              ${rows.map((x, i) => html`<li class="lied__item" key=${x.k} data-testid="list-editor-item" data-title=${x.title}>
                <button type="button" class="lied__type" disabled=${types.length < 2}
                  aria-label=${`סוג: ${typeOf(x.type).label} — לחצו להחלפה`} onClick=${() => cycleType(x)}>${typeOf(x.type).emoji}</button>
                <input class="input lied__input" value=${x.title} maxlength=${TITLE_MAX} aria-label="שם הפריט" onInput=${(e) => setItem(x.k, { title: e.target.value })} />
                <span class="lied__ctrls">
                  <button type="button" aria-label=${`הזזת ${x.title} למעלה`} disabled=${i === 0} onClick=${() => moveItem(x.k, -1)}>▲</button>
                  <button type="button" aria-label=${`הזזת ${x.title} למטה`} disabled=${i === rows.length - 1} onClick=${() => moveItem(x.k, 1)}>▼</button>
                  <button type="button" class="lied__del" aria-label=${`מחיקת ${x.title}`} onClick=${() => removeItem(x.k)}>✕</button>
                </span>
              </li>`)}
              <li class="lied__itemadd"><${AddLine} placeholder="פריט חדש…" label=${`פריט חדש ב${c.name}`} onAdd=${(t) => addItem(c.name, t)} /></li>
            </ul>`
          : null}
      </section>`;
    })}
    ${showLists && value.categories.length < MAX_CATEGORIES
      ? html`<div class="lied__newcat"><${AddLine} placeholder="קטגוריה חדשה… (למשל: ציוד לצלילה)" label="קטגוריה חדשה" max=${NAME_MAX} onAdd=${addCategory} /></div>`
      : null}
    ${showPacking
      ? html`<section class="lied__packing" data-testid="list-editor-packing">
          <h3 class="lied__h">🧳 רשימת האריזה האישית (לכל אחד)</h3>
          <div class="lied__chips">
            ${value.packing.map((p, i) => html`<span class="lied__chip" key=${`${p}-${i}`}>${p}
              <button type="button" aria-label=${`הסרת ${p}`} onClick=${() => patch({ packing: value.packing.filter((_, j) => j !== i) })}>✕</button></span>`)}
          </div>
          <${AddLine} placeholder="להוסיף לאריזה…" label="פריט לרשימת האריזה" max=${60} onAdd=${(t) => patch({ packing: [...value.packing, t] })} />
        </section>`
      : null}
    ${showLists ? html`<p class="lied__clear"><button type="button" class="link small" onClick=${async () => { if (await confirmDialog({ title: 'להתחיל מאפס?', text: 'כל הקטגוריות, הפריטים והאריזה שהכנו ימחקו, ותבנו את הרשימות בעצמכם.', confirmText: 'כן, מאפס', danger: true })) { patch({ categories: [], items: [], packing: [] }); setOpenCat(null); } }}>להתחיל מרשימה ריקה</button></p>` : null}
  </div>`;
}
