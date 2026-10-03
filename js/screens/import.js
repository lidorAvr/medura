// Import (SPEC §8.6): paste a WhatsApp list → live preview grouped by detected category
// (parseListText with the trip's names) → every field of every row editable in place (DraftRows) →
// add_items_bulk (with who takes what) → back to lists.
import { html } from 'htm/preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { actions, useTrip } from '../store.js?v=853199b';
import { navigate, href } from '../router.js?v=853199b';
import { hebrewCount, parseListText } from '../lib/logic.js?v=853199b';
import { itemTypeOn } from '../lib/templates.js?v=853199b';
import { Button, Field, IconButton, Skeleton, TextArea, fireConfetti } from '../ui/components.js?v=853199b';
import {
  DraftRows, assignMode, isTasksCategory, markDups, resolveWho, saveDrafts, tripNames,
} from '../ui/draft-rows.js?v=853199b';
import { matchCategory, sortedCategories } from './lists.js?v=853199b';

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

// Row edits (incl. rows already saved by a save that failed half-way) are kept with the text.
const editsKey = (tripId) => `medura:import-edits:${tripId}`;
function readEdits(tripId) {
  try {
    const v = JSON.parse(sessionStorage.getItem(editsKey(tripId)) || 'null');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
function writeEdits(tripId, edits) {
  try {
    if (Object.keys(edits).length) sessionStorage.setItem(editsKey(tripId), JSON.stringify(edits));
    else sessionStorage.removeItem(editsKey(tripId));
  } catch {
    /* storage unavailable — the edits just aren't kept */
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

export default function ImportScreen({ route }) {
  const { snap, me, isAdmin } = useTrip();
  const tripId = route.params.tripId;
  const ready = !!snap && snap.trip?.id === tripId;
  const [text, setText] = useState(() => readDraft(tripId));
  const [edits, setEdits] = useState(() => readEdits(tripId)); // row key → {include, removed, title, qty, unit, per_person, type, cat, who}
  const [saving, setSaving] = useState(false);
  const debounced = useDebounced(text, 160);

  useEffect(() => writeDraft(tripId, text), [text]);
  useEffect(() => writeEdits(tripId, edits), [edits]);

  const who = useMemo(() => (ready ? tripNames(snap) : { names: [], byName: new Map() }), [ready, snap?.members]);

  const parsed = useMemo(() => {
    const seen = new Map();
    return parseListText(debounced, { names: who.names }).map((r) => {
      const n = (seen.get(r.raw) || 0) + 1;
      seen.set(r.raw, n);
      return { ...r, key: `${r.raw}#${n}` };
    });
  }, [debounced, who]);

  const model = useMemo(() => {
    if (!ready) return null;
    const trip = snap.trip;
    const cats = sortedCategories(snap);
    const catById = new Map(cats.map((c) => [c.id, c]));
    const newCats = new Map(); // name → emoji (admins create unknown categories)
    const canAssign = assignMode(snap, isAdmin, me?.id);
    const autoCat = (r) => {
      if (!r.category) return 'none';
      const c = matchCategory(cats, r.category);
      if (c) return `id:${c.id}`;
      if (!isAdmin) return 'none';
      if (!newCats.has(r.category.name)) newCats.set(r.category.name, r.category.emoji || '📦');
      return `new:${r.category.name}`;
    };
    const has = (e, k) => Object.prototype.hasOwnProperty.call(e, k);
    const base = [];
    for (const r of parsed) {
      const e = edits[r.key] || {};
      if (e.removed) continue;
      const cat = e.cat ?? autoCat(r);
      // A row moved into a new category that no longer has auto rows keeps that category visible.
      if (cat.startsWith('new:') && !newCats.has(cat.slice(4))) newCats.set(cat.slice(4), '📦');
      const inTasks = cat.startsWith('id:') && isTasksCategory(catById.get(cat.slice(3)));
      let type = e.type ?? (inTasks ? 'task' : r.type);
      if (!itemTypeOn(trip, type)) type = itemTypeOn(trip, 'task') ? 'task' : 'buy';
      base.push({
        key: r.key,
        title: e.title ?? r.title,
        qty: has(e, 'qty') ? e.qty : r.qty,
        unit: has(e, 'unit') ? e.unit : r.unit,
        per_person: e.per_person ?? !!r.per_person,
        note: r.note,
        type,
        cat,
        who: has(e, 'who') ? e.who : resolveWho(r.who, who.byName, me?.id, canAssign),
        done: !!r.done,
        include: e.include,
      });
    }
    // Same item → left out by default; a mere look-alike stays in (flagged) so nothing needed gets dropped silently.
    // … unless the line says who takes it ("משחק קופסה - רותם", "גיל: אני מביא בירות"): then it isn't a duplicate to
    // drop — that person goes on the item that's already there (admins: anyone; everyone: themselves).
    const itemById = new Map((snap.items || []).map((i) => [i.id, i]));
    const saidBy = new Map(parsed.map((r) => [r.key, r.who]));
    const rows = markDups(base, snap.items).map((r) => {
      const item = r.dup?.kind === 'same' ? itemById.get(r.dup.id) : null;
      const said = saidBy.get(r.key);
      const saidId = said === '__me__' ? me?.id : said ? who.byName.get(said) || null : null;
      const target = r.who || (saidId && saidId === me?.id ? saidId : null);
      const link = item && item.status === 'active' && item.type !== 'each' && target
        && !(snap.pledges || []).some((p) => p.item_id === item.id && p.member_id === target)
        ? { itemId: item.id, who: target, type: item.type } : null;
      return { ...r, link, include: r.include ?? (link ? true : !r.dup || r.dup.kind === 'similar') };
    });
    return { trip, cats, newCats, rows, canAssign, groups: new Set(rows.map((r) => r.cat)).size };
  }, [ready, snap, parsed, edits, isAdmin, me?.id, who]);

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

  const chosen = model.rows.filter((r) => r.include && r.title.trim());
  const links = chosen.filter((r) => r.link);          // people to put on items that are already in the list
  const fresh = chosen.filter((r) => !r.link);
  const proposal = !isAdmin && snap.trip?.settings?.require_approval !== false;
  const linksText = (n) => (n === 1 ? 'שיבוץ אחד' : `${n} שיבוצים`);

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
    // rows of each chunk that saved leave the draft right away, so a retry after a failure sends only the rest
    const count = fresh.length ? await saveDrafts(tripId, fresh, model.newCats, (keys) => setEdit(keys, { removed: true })) : 0;
    if (count === undefined) {
      setSaving(false);
      return;
    }
    // "X - name" on an item that's already in the list: the name goes on that item (never a second copy)
    const linked = links.length
      ? await actions.run(async (api) => {
        let n = 0;
        for (const r of links) {
          const qty = r.link.type === 'bring' ? Math.max(1, Math.min(200, Math.round(Number(r.qty) || 1))) : 1;
          if (r.link.who === me.id) await api.pledge(r.link.itemId, qty);
          else await api.assign(r.link.itemId, r.link.who, qty);
          n += 1;
          setEdit([r.key], { removed: true });
        }
        return n;
      })
      : 0;
    setSaving(false);
    if (linked === undefined) return;
    writeDraft(tripId, '');
    writeEdits(tripId, {});
    setText('');
    setEdits({});
    fireConfetti();
    const added = count ? (proposal ? `${hebrewCount(count, 'הצעה נשלחה', 'הצעות נשלחו')} לאישור ⏳` : `נוספו ${hebrewCount(count, 'פריט', 'פריטים')} לרשימה 🎉`) : '';
    const tied = linked ? `🔗 ${linksText(linked)} לפריטים שכבר ברשימה` : '';
    actions.toast([added, tied].filter(Boolean).join(' · '), 'success', 3600);
    navigate(`/t/${tripId}/lists${proposal && count ? '?tab=pending' : ''}`);
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
          ? html`<${Button} variant=${hasText ? 'secondary' : 'primary'} size=${hasText ? 'sm' : 'md'} icon="copy" onClick=${paste}>הדבקה מהלוח</${Button}>`
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
            <li><span aria-hidden="true">📝</span> כל שורה הופכת לפריט — ואפשר לתקן כל שדה אחרי ההדבקה</li>
            <li><span aria-hidden="true">🥩</span> כותרת עם אימוג׳י ("🥩 בשרים") = קטגוריה</li>
            <li><span aria-hidden="true">🔢</span> "3 חבילות פחמים" → כמות ויחידה</li>
            <li><span aria-hidden="true">👥</span> "פר אדם 300 גרם" → כמות לכל אחד</li>
            <li><span aria-hidden="true">🙋</span> "שם - פחמים" או "אני מביא/ה…" → כבר משובץ</li>
            <li><span aria-hidden="true">🎒</span> "חלוקה של כל אחד מהבית" → פריטים שמביאים מהבית</li>
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
            ${model.groups > 1 ? html` ב־<span class="num">${model.groups}</span> קבוצות` : null}
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
    ${model.rows.some((r) => r.link)
      ? html`<p class="ls-hint" data-testid="imp-link-hint">🔗 פריט שכבר ברשימה ויש שם לידו — לא מתווסף שוב: מי שכתוב לידו משובץ לפריט הקיים.</p>`
      : null}
    ${model.rows.some((r) => r.dup && r.dup.kind !== 'similar' && !r.link)
      ? html`<p class="ls-hint">🔁 פריטים שכבר ברשימה לא סומנו, כדי שלא יגיעו פעמיים — אפשר לסמן אותם בכל זאת.</p>`
      : null}
    ${model.rows.some((r) => r.dup?.kind === 'similar')
      ? html`<p class="ls-hint">👀 פריטים שמסומנים "דומה ל…" — כדאי לבדוק שזה לא אותו דבר לפני הייבוא.</p>`
      : null}

    ${model.rows.length
      ? html`<${DraftRows}
          rows=${model.rows}
          cats=${model.cats}
          newCats=${model.newCats}
          trip=${model.trip}
          members=${snap.members || []}
          meId=${me?.id}
          canAssign=${model.canAssign}
          includable
          onPatch=${setEdit}
          onRemove=${(keys) => setEdit(keys, { removed: true })}
        />`
      : null}

    ${model.rows.length
      ? html`<div class="imp-footer">
          <${Button} variant="accent" size="lg" block icon=${proposal ? 'send' : 'download'} loading=${saving} disabled=${!chosen.length} onClick=${submit}>
            ${fresh.length
              ? `${proposal ? `שליחת ${hebrewCount(fresh.length, 'הצעה', 'הצעות')}` : `ייבוא ${hebrewCount(fresh.length, 'פריט', 'פריטים')}`}${links.length ? ` + ${linksText(links.length)}` : ''}`
              : links.length ? `${linksText(links.length)} לפריטים שכבר ברשימה` : 'לא נבחרו פריטים'}
          </${Button}>
        </div>`
      : null}
  </div>`;
}
