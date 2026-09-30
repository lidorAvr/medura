// Import (SPEC §8.6): paste a WhatsApp list → live preview grouped by detected category
// (parseListText) → per-row include / type / category edits → add_items_bulk → back to lists.
import { html } from 'htm/preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { actions, useTrip } from '../store.js?v=c11e2d1';
import { navigate, href } from '../router.js?v=c11e2d1';
import { formatQty, hebrewCount, parseListText, similarItems, titleSimilarity } from '../lib/logic.js?v=c11e2d1';
import { Button, Chip, Field, IconButton, Pill, Sheet, Skeleton, TextArea, fireConfetti } from '../ui/components.js?v=c11e2d1';
import { Icon } from '../ui/icons.js?v=c11e2d1';
import { cx, emojiKey, matchCategory, normText, sortedCategories } from './lists.js?v=c11e2d1';

const BULK_MAX = 150; // add_items_bulk limit per call (SPEC §4)

const DUP_LABEL = {
  same: () => 'כבר ברשימה',
  similar: (title) => `דומה ל: ${title}`,
  pasted: () => 'מופיע פעמיים ברשימה',
};

const TYPES = [
  { value: 'buy', emoji: '🛒', label: 'קנייה' },
  { value: 'bring', emoji: '🎒', label: 'מהבית' },
  { value: 'each', emoji: '🙋', label: 'כל אחד' },
  { value: 'task', emoji: '✅', label: 'משימה' },
];

const SAMPLE = `🥩 בשרים
פרגיות - פר אדם 300 גרם
2 חבילות נקניקיות

🥤 שתייה
3 שישיות מים
24 בקבוקי בירה

חלוקה של כל אחד מהבית
2 מלקחיים
קרש חיתוך - כל זוג
נפנף - למי יש?`;

const draftKey = (tripId) => `medura:import:${tripId}`;
function readDraft(tripId) {
  try {
    return sessionStorage.getItem(draftKey(tripId)) || '';
  } catch {
    return '';
  }
}
function writeDraft(tripId, text) {
  try {
    if (text) sessionStorage.setItem(draftKey(tripId), text);
    else sessionStorage.removeItem(draftKey(tripId));
  } catch {
    /* storage unavailable — the draft just isn't kept */
  }
}

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const isTasksCategory = (c) => !!c && (emojiKey(c.emoji) === '📋' || normText(c.name) === 'משימות');
const MEASURES = new Set(['ק"ג', 'גרם', 'ליטר', 'מ"ל']);

function rowQtyText(r) {
  if (r.type === 'buy' && r.qty > 0) return `${formatQty(r.qty, r.unit)}${r.per_person ? ' לאדם' : ''}`;
  if (r.type === 'bring' && r.qty > 0) return MEASURES.has(r.unit) ? formatQty(r.qty, r.unit) : `צריך ${Math.min(200, Math.round(r.qty))}`;
  return '';
}

function toPayload(r, newCats) {
  const p = { title: r.title.trim().slice(0, 120), type: r.type, note: r.note ? String(r.note).trim().slice(0, 500) || null : null };
  if (r.cat.startsWith('id:')) p.category_id = r.cat.slice(3);
  else if (r.cat.startsWith('new:')) {
    const name = r.cat.slice(4);
    p.category_name = name.slice(0, 40);
    p.category_emoji = newCats.get(name) || '📦';
  }
  if (r.type === 'buy' && r.qty > 0) {
    p.qty = r.qty;
    p.unit = r.unit || null;
    p.per_person = !!r.per_person;
  } else if (r.type === 'bring' && r.qty > 0) {
    if (MEASURES.has(r.unit)) {
      p.qty = r.qty;
      p.unit = r.unit;
    } else {
      p.needed = Math.max(1, Math.min(200, Math.round(r.qty))); // "2 מלקחיים" → needed 2
    }
  }
  return p;
}

export default function ImportScreen({ route }) {
  const { snap, isAdmin } = useTrip();
  const tripId = route.params.tripId;
  const ready = !!snap && snap.trip?.id === tripId;
  const [text, setText] = useState(() => readDraft(tripId));
  const [edits, setEdits] = useState({}); // row key → {include, type, cat}
  const [picker, setPicker] = useState(null); // {keys, title, current}
  const [saving, setSaving] = useState(false);
  const debounced = useDebounced(text, 160);

  useEffect(() => writeDraft(tripId, text), [text]);

  const parsed = useMemo(() => {
    const seen = new Map();
    return parseListText(debounced).map((r) => {
      const n = (seen.get(r.raw) || 0) + 1;
      seen.set(r.raw, n);
      return { ...r, key: `${r.raw}#${n}` };
    });
  }, [debounced]);

  const model = useMemo(() => {
    if (!ready) return null;
    const cats = sortedCategories(snap);
    const catById = new Map(cats.map((c) => [c.id, c]));
    const newCats = new Map(); // name → emoji (admins create unknown categories)
    const autoCat = (r) => {
      if (!r.category) return 'none';
      const c = matchCategory(cats, r.category);
      if (c) return `id:${c.id}`;
      if (!isAdmin) return 'none';
      if (!newCats.has(r.category.name)) newCats.set(r.category.name, r.category.emoji || '📦');
      return `new:${r.category.name}`;
    };
    const rows = parsed.map((r, i) => {
      const e = edits[r.key] || {};
      // Already in the trip (same or look-alike title), or pasted twice in this list.
      const like = similarItems(r.title, snap.items, { limit: 1 })[0] || null;
      const twiceAt = like ? -1 : parsed.findIndex((o, j) => j < i && titleSimilarity(o.title, r.title) === 'same');
      const dup = like
        ? { kind: like.match, title: like.item.title }
        : twiceAt >= 0 ? { kind: 'pasted', title: parsed[twiceAt].title } : null;
      const cat = e.cat ?? autoCat(r);
      // A row moved into a new category that no longer has auto rows keeps that category visible.
      if (cat.startsWith('new:') && !newCats.has(cat.slice(4))) newCats.set(cat.slice(4), '📦');
      const inTasks = cat.startsWith('id:') && isTasksCategory(catById.get(cat.slice(3)));
      // Same item → left out by default; a mere look-alike stays in (flagged) so nothing needed gets dropped silently.
      const include = e.include ?? (!dup || dup.kind === 'similar');
      return { ...r, cat, dup, type: e.type ?? (inTasks ? 'task' : r.type), include };
    });
    // groups: trip categories in order → new categories → uncategorised
    const order = [...cats.map((c) => `id:${c.id}`), ...[...newCats.keys()].map((n) => `new:${n}`), 'none'];
    const groups = order
      .map((key) => ({ key, rows: rows.filter((r) => r.cat === key) }))
      .filter((g) => g.rows.length)
      .map((g) => {
        if (g.key.startsWith('id:')) {
          const c = catById.get(g.key.slice(3));
          return { ...g, emoji: c.emoji || '📦', name: c.name, isNew: false };
        }
        if (g.key.startsWith('new:')) {
          const name = g.key.slice(4);
          return { ...g, emoji: newCats.get(name), name, isNew: true };
        }
        return { ...g, emoji: '📦', name: 'בלי קטגוריה', isNew: false };
      });
    return { cats, catById, newCats, rows, groups };
  }, [ready, snap, parsed, edits, isAdmin]);

  if (!model) {
    return html`<div class="screen imp-screen" aria-busy="true">
      <div class="ls-head"><span class="ls-skel-title"></span></div>
      <${Skeleton} lines=${6} />
    </div>`;
  }

  const setEdit = (keys, patch) => setEdits((all) => {
    const next = { ...all };
    for (const k of keys) next[k] = { ...(next[k] || {}), ...patch };
    return next;
  });

  const chosen = model.rows.filter((r) => r.include);
  const proposal = !isAdmin && snap.trip?.settings?.require_approval !== false;
  const catLabel = (key) => {
    if (key.startsWith('id:')) {
      const c = model.catById.get(key.slice(3));
      return c ? `${c.emoji || '📦'} ${c.name}` : '📦 בלי קטגוריה';
    }
    if (key.startsWith('new:')) return `${model.newCats.get(key.slice(4)) || '📦'} ${key.slice(4)}`;
    return '📦 בלי קטגוריה';
  };

  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t && t.trim()) setText((prev) => (prev.trim() ? `${prev}\n${t}` : t));
      else actions.toast('הלוח ריק — העתיקו קודם את ההודעה מוואטסאפ', 'info');
    } catch {
      actions.toast('לא הצלחנו לקרוא מהלוח — הדביקו ידנית בתיבה', 'info', 3600);
    }
  };

  const submit = async () => {
    if (!chosen.length || saving) return;
    setSaving(true);
    const payload = chosen.map((r) => toPayload(r, model.newCats));
    const count = await actions.run(async (api) => {
      let n = 0;
      for (let i = 0; i < payload.length; i += BULK_MAX) n += Number(await api.addItemsBulk(tripId, payload.slice(i, i + BULK_MAX))) || 0;
      return n;
    });
    setSaving(false);
    if (count === undefined) return;
    writeDraft(tripId, '');
    setText('');
    setEdits({});
    fireConfetti();
    actions.toast(
      proposal ? `${hebrewCount(count, 'הצעה נשלחה', 'הצעות נשלחו')} לאישור ⏳` : `נוספו ${hebrewCount(count, 'פריט', 'פריטים')} לרשימה 🎉`,
      'success',
      3600,
    );
    navigate(`/t/${tripId}/lists${proposal ? '?tab=pending' : ''}`);
  };

  const hasText = !!text.trim();
  return html`<div class="screen imp-screen">
    <div class="ls-head">
      <${IconButton} icon="arrow-right" label="חזרה לרשימות" href=${href(`/t/${tripId}/lists`)} class="ls-head__btn" />
      <div class="ls-head__text">
        <h1 class="ls-head__title">ייבוא רשימה 📥</h1>
        <p class="ls-head__sub">מדביקים הודעה מוואטסאפ — ואנחנו מסדרים לפי קטגוריות ✨</p>
      </div>
    </div>

    <div class="card imp-input">
      <${Field} label="הדביקו כאן רשימה מוואטסאפ">
        <${TextArea}
          value=${text}
          onInput=${(e) => setText(e.currentTarget.value)}
          rows=${6}
          placeholder=${'למשל:\n🥩 בשרים\nפרגיות - פר אדם 300 גרם\n3 חבילות פחמים'}
          class="imp-textarea"
        />
      </${Field}>
      <div class="imp-input__actions">
        ${typeof navigator !== 'undefined' && navigator.clipboard?.readText
          ? html`<${Button} size="sm" variant="secondary" icon="copy" onClick=${paste}>הדבקה מהלוח</${Button}>`
          : null}
        ${hasText
          ? html`<${Button} size="sm" variant="ghost" icon="x" onClick=${() => { setText(''); setEdits({}); }}>ניקוי</${Button}>`
          : html`<${Button} size="sm" variant="ghost" icon="sparkles" onClick=${() => setText(SAMPLE)}>לנסות עם דוגמה</${Button}>`}
      </div>
    </div>

    ${!hasText
      ? html`<div class="card imp-tips">
          <h2 class="imp-tips__title">💡 איך זה עובד?</h2>
          <ul class="imp-tips__list">
            <li><span aria-hidden="true">📝</span> כל שורה הופכת לפריט</li>
            <li><span aria-hidden="true">🥩</span> כותרת עם אימוג׳י ("🥩 בשרים") = קטגוריה</li>
            <li><span aria-hidden="true">🔢</span> "3 חבילות פחמים" → כמות ויחידה</li>
            <li><span aria-hidden="true">👥</span> "פר אדם 300 גרם" → כמות לכל אחד</li>
            <li><span aria-hidden="true">🎒</span> "חלוקה של כל אחד מהבית" → פריטים שמביאים מהבית</li>
            <li><span aria-hidden="true">🙋</span> "כל זוג" → כל אחד מביא משלו</li>
          </ul>
        </div>`
      : null}

    ${hasText && !model.rows.length && debounced === text
      ? html`<div class="card imp-none">
          <span class="imp-none__emoji" aria-hidden="true">🤔</span>
          <p>לא זיהינו פריטים. נסו שורה נפרדת לכל פריט.</p>
        </div>`
      : null}

    ${model.rows.length
      ? html`<div class="imp-summary">
          <p class="imp-summary__text">
            זיהינו <strong class="num">${hebrewCount(model.rows.length, 'פריט', 'פריטים')}</strong>
            ${model.groups.length > 1 ? html` ב־<span class="num">${model.groups.length}</span> קבוצות` : null}
          </p>
          <div class="imp-summary__links">
            <button type="button" class="link small" onClick=${() => setEdit(model.rows.map((r) => r.key), { include: true })}>סמן הכל</button>
            <button type="button" class="link small" onClick=${() => setEdit(model.rows.map((r) => r.key), { include: false })}>נקה הכל</button>
          </div>
        </div>`
      : null}
    ${model.rows.length && proposal
      ? html`<p class="ls-approval-hint" role="note">⏳ הפריטים יישלחו לאישור מנהל לפני שייכנסו לרשימה.</p>`
      : null}
    ${model.rows.some((r) => r.dup && r.dup.kind !== 'similar')
      ? html`<p class="ls-hint">🔁 פריטים שכבר ברשימה לא סומנו, כדי שלא יגיעו פעמיים — אפשר לסמן אותם בכל זאת.</p>`
      : null}
    ${model.rows.some((r) => r.dup?.kind === 'similar')
      ? html`<p class="ls-hint">👀 פריטים שמסומנים "דומה ל…" — כדאי לבדוק שזה לא אותו דבר לפני הייבוא.</p>`
      : null}

    ${model.groups.map((g) => html`<section key=${g.key} class="imp-group" aria-label=${g.name}>
      <div class="imp-group__head">
        <span class="imp-group__emoji" aria-hidden="true">${g.emoji}</span>
        <h2 class="imp-group__name">${g.name}</h2>
        ${g.isNew ? html`<${Pill} tone="info">קטגוריה חדשה</${Pill}>` : null}
        <span class="imp-group__count num">${g.rows.filter((r) => r.include).length}/${g.rows.length}</span>
        <button type="button" class="link small imp-group__change"
          onClick=${() => setPicker({ keys: g.rows.map((r) => r.key), title: `קטגוריה ל"${g.name}"`, current: g.key })}>שינוי</button>
      </div>
      <div class="list imp-list">
        ${g.rows.map((r) => {
          const qty = rowQtyText(r);
          return html`<div key=${r.key} class=${cx('imp-row', !r.include && 'is-off')}>
            <button
              type="button"
              class="check"
              role="checkbox"
              aria-checked=${r.include ? 'true' : 'false'}
              aria-label=${`לייבא: ${r.title}`}
              onClick=${() => setEdit([r.key], { include: !r.include })}
            ><${Icon} name="check" /></button>
            <div class="imp-row__main">
              <div class="imp-row__title">
                <span class="imp-row__name">${r.title}</span>
                ${qty ? html`<span class="ls-qty num">${qty}</span>` : null}
                ${r.dup ? html`<${Pill} tone="warning">${DUP_LABEL[r.dup.kind](r.dup.title)}</${Pill}>` : null}
              </div>
              ${r.note ? html`<div class="imp-row__note">${r.note}</div>` : null}
              <div class="imp-row__controls">
                <div class="imp-types" role="radiogroup" aria-label=${`סוג: ${r.title}`}>
                  ${TYPES.map((t) => html`<button
                    key=${t.value}
                    type="button"
                    role="radio"
                    class=${cx('imp-type', r.type === t.value && 'is-on')}
                    aria-checked=${r.type === t.value ? 'true' : 'false'}
                    aria-label=${t.label}
                    title=${t.label}
                    onClick=${() => setEdit([r.key], { type: t.value })}
                  ><span aria-hidden="true">${t.emoji}</span>${r.type === t.value ? html`<span class="imp-type__label">${t.label}</span>` : null}</button>`)}
                </div>
                <button type="button" class="imp-cat" aria-label=${`קטגוריה: ${catLabel(r.cat)} — שינוי`}
                  onClick=${() => setPicker({ keys: [r.key], title: `קטגוריה ל"${r.title}"`, current: r.cat })}>
                  <span class="truncate">${catLabel(r.cat)}</span><span aria-hidden="true" class="imp-cat__chev">▾</span>
                </button>
              </div>
            </div>
          </div>`;
        })}
      </div>
    </section>`)}

    ${model.rows.length
      ? html`<div class="imp-footer">
          <${Button} variant="accent" size="lg" block icon=${proposal ? 'send' : 'download'} loading=${saving} disabled=${!chosen.length} onClick=${submit}>
            ${chosen.length
              ? proposal ? `שליחת ${hebrewCount(chosen.length, 'הצעה', 'הצעות')}` : `ייבוא ${hebrewCount(chosen.length, 'פריט', 'פריטים')}`
              : 'לא נבחרו פריטים'}
          </${Button}>
        </div>`
      : null}

    <${CategoryPicker}
      picker=${picker}
      model=${model}
      onPick=${(key) => {
        setEdit(picker.keys, { cat: key });
        setPicker(null);
      }}
      onClose=${() => setPicker(null)}
    />
  </div>`;
}

function CategoryPicker({ picker, model, onPick, onClose }) {
  const [last, setLast] = useState(picker);
  useEffect(() => {
    if (picker) setLast(picker);
  }, [picker]);
  const p = picker || last;
  const newKeys = [...model.newCats.keys()].map((n) => `new:${n}`);
  return html`<${Sheet} open=${!!picker} onClose=${onClose} title=${p ? p.title : 'קטגוריה'}>
    <div class="ls-chips imp-picker" role="group" aria-label="בחירת קטגוריה">
      ${model.cats.map((c) => html`<${Chip} key=${c.id} active=${p?.current === `id:${c.id}`} onClick=${() => onPick(`id:${c.id}`)}>
        <span aria-hidden="true">${c.emoji || '📦'}</span> ${c.name}
      </${Chip}>`)}
      ${newKeys.map((k) => html`<${Chip} key=${k} tone="info" active=${p?.current === k} onClick=${() => onPick(k)}>
        <span aria-hidden="true">${model.newCats.get(k.slice(4))}</span> ${k.slice(4)} (חדשה)
      </${Chip}>`)}
      <${Chip} tone="muted" active=${p?.current === 'none'} onClick=${() => onPick('none')}>📦 בלי קטגוריה</${Chip}>
    </div>
  </${Sheet}>`;
}
