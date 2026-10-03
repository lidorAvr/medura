// Quick list builder (SPEC §8.7): one step per category — shopping first, then gear, tasks last. Each step
// has a big input (Enter adds a row and keeps focus; "פחמים 2" / "עוף 3 ק״ג" are parsed; a pasted block
// adds many), one-tap suggestion chips and the step's rows (DraftRows). A final review of everything →
// one save (add_items_bulk in chunks) → lists.
import { html } from 'htm/preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { actions, useTrip } from '../store.js?v=9252f89';
import { navigate, href } from '../router.js?v=9252f89';
import { hebrewCount, parseListText, similarItems, titleSimilarity } from '../lib/logic.js?v=9252f89';
import { hasModule, itemTypeOn, suggestionsFor, tripType } from '../lib/templates.js?v=9252f89';
import { Button, EmptyState, IconButton, Skeleton, fireConfetti } from '../ui/components.js?v=9252f89';
import {
  DraftRows, assignMode, isTasksCategory, markDups, resolveWho, saveDrafts, tripNames,
} from '../ui/draft-rows.js?v=9252f89';
import { cx, emojiKey, matchCategory, normText, sortedCategories } from './lists.js?v=9252f89';

const SUGGESTIONS_SHOWN = 12;
// A category hints at the likely item type when neither its items nor the trip type say otherwise.
const TYPE_BY_EMOJI = { '⛺': 'bring', '🎲': 'bring', '🧳': 'bring', '🎵': 'bring', '🥾': 'bring', '🎤': 'bring', '💊': 'bring', '🧸': 'bring', '📋': 'task' };
const TYPE_RANK = { buy: 0, bring: 1, each: 1, task: 2 };
const TYPE_HINT = {
  buy: '🛒 פה בעיקר קונים',
  bring: '🎒 פה בעיקר מביאים מהבית',
  each: '🙋 כל אחד מביא משלו',
  task: '✅ מה צריך לסדר — ומי',
};

// The draft survives a reload, a closed app or a phone call (localStorage per trip, 14 days) — building
// 30 items in 11 steps and losing them to a tap on "back" is real work lost.
const storeKey = (tripId) => `medura:build:${tripId}`;
const DRAFT_DAYS = 14;
function readRows(tripId, storage = globalThis.localStorage) {
  try {
    const raw = storage.getItem(storeKey(tripId)) ?? globalThis.sessionStorage?.getItem(storeKey(tripId)) ?? 'null';
    const v = JSON.parse(raw);
    if (!v || !Array.isArray(v.rows) || !v.rows.length) return null;
    if (v.saved_at && Date.now() - v.saved_at > DRAFT_DAYS * 86400000) {
      storage.removeItem(storeKey(tripId));
      return null;
    }
    return v;
  } catch {
    return null;
  }
}
function writeRows(tripId, state, storage = globalThis.localStorage) {
  try {
    if (state.rows.length) storage.setItem(storeKey(tripId), JSON.stringify({ ...state, saved_at: Date.now() }));
    else storage.removeItem(storeKey(tripId));
    globalThis.sessionStorage?.removeItem(storeKey(tripId));   // the old home of drafts
  } catch {
    /* storage unavailable — the draft just isn't kept */
  }
}

let seq = 0;
const newKey = () => `b${Date.now().toString(36)}${(++seq).toString(36)}`;

const parseSafe = (text, names) => {
  try {
    return parseListText(text, { names });
  } catch {
    return [];
  }
};
const PROBE = 'זזזז'; // a word no category knows

/** Does a pasted block have category headers — a line that isn't an item but gives the line after it a category? */
function hasHeaders(lines, parsed, names) {
  const raws = new Set(parsed.map((p) => p.raw));
  return lines.some((l) => !raws.has(l) && parseSafe(`${l}\n${PROBE}`, names).some((p) => p.title === PROBE && p.category));
}

/** The step's type: tasks for a tasks category, else what its items / the trip type's items mostly are. */
function stepType(cat, snap, template) {
  if (isTasksCategory(cat)) return 'task';
  const votes = { buy: 0, bring: 0 };
  for (const i of snap.items || []) if (i.category_id === cat.id && i.type !== 'task') votes[i.type === 'buy' ? 'buy' : 'bring']++;
  for (const x of template.items) if (normText(x.c) === normText(cat.name) && x.k !== 'task') votes[x.k === 'buy' ? 'buy' : 'bring']++;
  if (votes.buy !== votes.bring) return votes.buy > votes.bring ? 'buy' : 'bring';
  const e = TYPE_BY_EMOJI[emojiKey(cat.emoji)];
  return e && e !== 'task' ? e : 'buy';
}

/**
 * Steps in order: shopping-ish categories, then gear, then tasks — only what the trip's features show.
 * `key` is unique per step; `cat` is the draft-row category it adds to (two steps may both be 'none').
 */
function buildSteps(snap, isAdmin) {
  const trip = snap.trip;
  const lists = hasModule(trip, 'lists');
  const tasks = hasModule(trip, 'tasks');
  const template = tripType(trip);
  const cats = sortedCategories(snap);
  const steps = [];
  cats.forEach((c, i) => {
    const type = stepType(c, snap, template);
    if (type === 'task' ? !tasks : !lists) return;
    steps.push({ key: `id:${c.id}`, cat: `id:${c.id}`, name: c.name, emoji: c.emoji || '📦', type, order: i });
  });
  if (tasks && !steps.some((s) => s.type === 'task')) {
    const cat = isAdmin ? 'new:משימות' : 'none';
    steps.push({ key: isAdmin ? cat : 'none:tasks', cat, name: 'משימות', emoji: '📋', type: 'task', order: 999 });
  }
  if (lists && !steps.some((s) => s.type !== 'task')) {
    steps.push({ key: 'none:general', cat: 'none', name: 'כללי', emoji: '📦', type: 'buy', order: -1 });
  }
  return steps.sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || a.order - b.order);
}

export default function BuildScreen({ route }) {
  const { snap, me, isAdmin } = useTrip();
  const tripId = route.params.tripId;
  const ready = !!snap && snap.trip?.id === tripId;
  const saved = useMemo(() => readRows(tripId), [tripId]);
  const [rows, setRows] = useState(() => saved?.rows || []);
  const [step, setStep] = useState(() => saved?.step || 0);
  const [restored, setRestored] = useState(() => saved?.rows?.length || 0);
  const [text, setText] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);
  const stepsRef = useRef(null);

  useEffect(() => writeRows(tripId, { rows, step }), [rows, step]);

  const model = useMemo(() => {
    if (!ready) return null;
    const steps = buildSteps(snap, isAdmin);
    const cats = sortedCategories(snap);
    const newCats = new Map(steps.filter((s) => s.cat.startsWith('new:')).map((s) => [s.cat.slice(4), s.emoji]));
    for (const r of rows) if (r.cat.startsWith('new:') && !newCats.has(r.cat.slice(4))) newCats.set(r.cat.slice(4), '📦');
    return { steps, cats, newCats, names: tripNames(snap), canAssign: assignMode(snap, isAdmin, me?.id) };
  }, [ready, snap, isAdmin, me?.id, rows]);

  const total = model ? model.steps.length : 0;
  const review = step >= total;
  const cur = model && !review ? model.steps[Math.min(step, total - 1)] : null;

  useLayoutEffect(() => {
    setText('');
    setShowAll(false);
    if (cur) inputRef.current?.focus({ preventScroll: true });
    const box = stepsRef.current;
    const dot = box?.querySelector('.bld-dot.is-on');
    if (box && dot && box.scrollWidth > box.clientWidth) {
      const b = box.getBoundingClientRect();
      const r = dot.getBoundingClientRect();
      if (r.left < b.left + 8 || r.right > b.right - 8) box.scrollBy({ left: r.left + r.width / 2 - (b.left + b.width / 2) });
    }
  }, [step, !!model]);

  const withDups = useMemo(() => (ready ? markDups(rows, snap.items) : []), [ready, rows, snap?.items]);

  if (!model) {
    return html`<div class="screen bld-screen" aria-busy="true">
      <div class="ls-head"><span class="ls-skel-title"></span></div>
      <${Skeleton} lines=${6} />
    </div>`;
  }
  const trip = snap.trip;
  if (!total) {
    return html`<div class="screen bld-screen">
      <${EmptyState} emoji="🙈" title="הרשימות כבויות בטיול הזה" text="מנהל/ת הטיול יכול/ה להדליק אותן ב״⚙️ מה יש בטיול״."
        action=${html`<${Button} variant="secondary" href=${href(`/t/${tripId}`)}>חזרה</${Button}>`} />
    </div>`;
  }

  const proposal = !isAdmin && trip.settings?.require_approval !== false;
  const typeFor = (s, wanted) => {
    if (s.type === 'task') return 'task';
    if (wanted && wanted !== 'task' && itemTypeOn(trip, wanted)) return wanted;
    return s.type;
  };

  /**
   * Rows from typed / pasted text. A pasted block is parsed as a whole (headers, numbering, "הדס:" lines, notes,
   * chatter); when it has headers, their items go to the matching step (else they stay in the current one).
   * A single typed line the parser skips still becomes a row as typed. Returns {n, moved}.
   */
  const addText = (value) => {
    const lines = String(value || '').split(/\r\n|\r|\n|\u2028|\u2029/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !cur) return { n: 0, moved: 0 };
    const names = model.names.names;
    let parsed = parseSafe(String(value), names);
    if (!parsed.length && lines.length === 1) {
      const title = lines[0].replace(/[:：]\s*$/, '').trim();
      if (title) parsed = [{ title, qty: null, unit: null, per_person: false, note: null, type: null }];
    }
    const routed = lines.length > 1 && hasHeaders(lines, parsed, names);
    const stepCats = model.steps.map((s) => ({ id: s.key, name: s.name, emoji: s.emoji }));
    let moved = 0;
    const out = parsed.map((p) => {
      const hit = routed && p.category ? matchCategory(stepCats, p.category) : null;
      const s = (hit && model.steps.find((x) => x.key === hit.id)) || cur;
      if (s !== cur) moved++;
      return {
        key: newKey(),
        title: p.title,
        qty: p.qty ?? null,
        unit: p.unit ?? null,
        per_person: !!p.per_person,
        note: p.note || null,
        type: typeFor(s, p.type === 'each' ? 'each' : null),
        cat: s.cat,
        step: s.key,
        who: resolveWho(p.who, model.names.byName, me?.id, model.canAssign),
        done: !!p.done,
      };
    });
    if (out.length) setRows((rs) => [...rs, ...out]);
    return { n: out.length, moved };
  };

  const onKeyDown = (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (!text.trim()) {
      if (e.currentTarget.value === '' && stepRows.length) next();
      return;
    }
    addText(text);
    setText('');
  };
  const onPaste = (e) => {
    const t = e.clipboardData?.getData('text') || '';
    if (!/[\r\n]/.test(t.trim())) return; // one line: let it land in the box
    e.preventDefault();
    const { n, moved } = addText(`${text}${t}`);
    setText('');
    if (n) actions.toast(`נוספו ${hebrewCount(n, 'שורה', 'שורות')}${moved ? ` (${moved} לקטגוריות שלהן)` : ''} ✨`, 'success', 2400);
    else actions.toast('לא זיהינו פריטים בהדבקה — נסו שורה לכל פריט', 'info', 3000);
  };

  const patch = (keys, p) => setRows((rs) => rs.map((r) => (keys.includes(r.key) ? { ...r, ...p } : r)));
  const remove = (keys) => setRows((rs) => rs.filter((r) => !keys.includes(r.key)));
  const go = (i) => setStep(Math.max(0, Math.min(total, i)));
  const next = () => go(step + 1);

  // Each row belongs to one step: the one it was added in while its category is still that step's, else the
  // first step with its category (moved rows follow their category; a category with no step shows in the review only).
  const stepOf = (r) => (model.steps.some((s) => s.key === r.step && s.cat === r.cat) ? r.step : model.steps.find((s) => s.cat === r.cat)?.key);
  const stepRows = cur ? withDups.filter((r) => stepOf(r) === cur.key) : [];
  const countIn = (s) => rows.filter((r) => stepOf(r) === s.key).length;
  const taken = (title) => similarItems(title, snap.items, { limit: 1 }).some((x) => x.match === 'same')
    || rows.some((r) => titleSimilarity(r.title, title) === 'same');
  const suggestions = cur ? suggestionsFor(trip, cur.name).filter((s) => !taken(s.title)) : [];
  const shownSug = showAll ? suggestions : suggestions.slice(0, SUGGESTIONS_SHOWN);

  const save = async () => {
    const good = rows.filter((r) => String(r.title).trim());
    if (!good.length || saving) return;
    setSaving(true);
    // rows of each chunk that saved leave the draft right away, so a retry after a failure sends only the rest
    const count = await saveDrafts(tripId, good, model.newCats, (keys) => setRows((rs) => rs.filter((r) => !keys.includes(r.key))));
    setSaving(false);
    if (count === undefined) return;
    setRows([]);
    setStep(0);
    writeRows(tripId, { rows: [], step: 0 });
    fireConfetti();
    actions.toast(
      proposal ? `${hebrewCount(count, 'הצעה נשלחה', 'הצעות נשלחו')} לאישור ⏳` : `נוספו ${hebrewCount(count, 'פריט', 'פריטים')} לרשימה 🎉`,
      'success',
      3600,
    );
    navigate(`/t/${tripId}/lists${proposal ? '?tab=pending' : ''}`);
  };

  const draftProps = {
    cats: model.cats, newCats: model.newCats, trip, members: snap.members || [], meId: me?.id,
    canAssign: model.canAssign, onPatch: patch, onRemove: remove,
  };

  return html`<div class="screen bld-screen">
    <div class="ls-head">
      <${IconButton} icon="arrow-right" label="חזרה לרשימות" href=${href(`/t/${tripId}/lists`)} class="ls-head__btn" />
      <div class="ls-head__text">
        <h1 class="ls-head__title">✨ בניית רשימה מהירה</h1>
        <p class="ls-head__sub">קטגוריה אחרי קטגוריה — כותבים ולוחצים Enter</p>
      </div>
    </div>
    ${restored && rows.length
      ? html`<div class="bld-restored small" role="status" data-testid="bld-restored">
          <span>📝 המשכנו מהטיוטה ששמרת (${restored} פריטים) — אפשר להמשיך מאיפה שעצרת.</span>
          <${Button} size="sm" variant="ghost" onClick=${() => { setRows([]); setStep(0); setRestored(0); }}>להתחיל מחדש</${Button}>
        </div>`
      : null}

    <div class="bld-progress">
      <div class="bld-steps h-scroll" role="tablist" aria-label="שלבים" ref=${stepsRef}>
        ${model.steps.map((s, i) => html`<button key=${s.key} type="button" role="tab" aria-selected=${i === step ? 'true' : 'false'}
          class=${cx('bld-dot', i === step && 'is-on', countIn(s) && 'has-rows')} title=${s.name} aria-label=${`${s.name}${countIn(s) ? ` (${countIn(s)})` : ''}`}
          onClick=${() => go(i)}><span aria-hidden="true">${s.emoji}</span>${countIn(s) ? html`<span class="bld-dot__n num">${countIn(s)}</span>` : null}<span class="bld-dot__name" aria-hidden="true">${s.name}</span></button>`)}
        <button type="button" role="tab" aria-selected=${review ? 'true' : 'false'} class=${cx('bld-dot', 'bld-dot--review', review && 'is-on')}
          aria-label=${`סיכום (${rows.length})`} onClick=${() => go(total)}><span aria-hidden="true">🧾</span><span class="bld-dot__n num">${rows.length}</span></button>
      </div>
      <span class="bld-progress__text num" aria-live="polite">${review ? 'סיכום' : `${step + 1}/${total}`}</span>
    </div>

    ${cur
      ? html`<section class="card bld-step" aria-label=${cur.name}>
          <div class="bld-step__head">
            <span class="bld-step__emoji" aria-hidden="true">${cur.emoji}</span>
            <div class="bld-step__text">
              <h2 class="bld-step__name">${cur.name}</h2>
              <p class="bld-step__hint">${TYPE_HINT[cur.type]}</p>
            </div>
          </div>
          <div class="bld-add">
            <input
              ref=${inputRef}
              type="text"
              class="input bld-input"
              aria-label=${`מה להוסיף ל${cur.name}?`}
              placeholder=${cur.type === 'task' ? 'למשל: לתאם מקום · הדס - לאסוף כסף' : 'למשל: פחמים 2 · עוף 3 ק״ג'}
              enterkeyhint="enter"
              autocomplete="off"
              value=${text}
              onInput=${(e) => setText(e.currentTarget.value)}
              onKeyDown=${onKeyDown}
              onPaste=${onPaste}
            />
            <${IconButton} icon="plus" label="הוספה" class="bld-add__btn" onClick=${() => {
              addText(text);
              setText('');
              inputRef.current?.focus();
            }} />
          </div>
          <p class="bld-tip">💡 Enter מוסיף ונשאר בתיבה · אפשר להדביק כמה שורות בבת אחת</p>
          ${shownSug.length
            ? html`<div class="bld-sug" role="group" aria-label="הצעות">
                ${shownSug.map((s) => html`<button key=${s.title} type="button" class="chip bld-sug__chip" onClick=${() => {
                  setRows((rs) => [...rs, {
                    key: newKey(), title: s.title, qty: null, unit: null, per_person: false, note: null,
                    type: typeFor(cur, s.type), cat: cur.cat, step: cur.key, who: null, done: false,
                  }]);
                  inputRef.current?.focus({ preventScroll: true });
                }}>+ ${s.title}</button>`)}
                ${!showAll && suggestions.length > SUGGESTIONS_SHOWN
                  ? html`<button type="button" class="link small" onClick=${() => setShowAll(true)}>עוד ${suggestions.length - SUGGESTIONS_SHOWN}</button>`
                  : null}
              </div>`
            : null}
        </section>

        ${stepRows.length
          ? html`<${DraftRows} ...${draftProps} rows=${stepRows} grouped=${false} />`
          : html`<p class="ls-hint bld-empty">עוד אין פה כלום — כותבים למעלה או לוחצים על הצעה.</p>`}

        <div class="bld-nav">
          <${Button} variant="secondary" icon="arrow-right" disabled=${step === 0} onClick=${() => go(step - 1)}>הקודם</${Button}>
          <${Button} variant="ghost" onClick=${next}>דלג</${Button}>
          <${Button} class="bld-nav__next" onClick=${next}>${step + 1 >= total ? 'לסיכום ←' : 'הבא ←'}</${Button}>
        </div>
        ${rows.length
          // done early? finish from any step (ux L7) — no need to walk every category
          ? html`<${Button} variant="secondary" block icon=${proposal ? 'send' : 'check'} loading=${saving} onClick=${save}
              class="bld-finish" data-testid="bld-finish">
              ${proposal ? `סיום ושליחה (${rows.length})` : `סיום ושמירה (${rows.length})`}
            </${Button}>`
          : null}`
      : html`
        ${rows.length
          ? html`
            <p class="imp-summary__text bld-review__sum">
              <strong class="num">${hebrewCount(rows.length, 'פריט', 'פריטים')}</strong> מוכנים — אפשר לתקן כל שדה לפני השמירה.
            </p>
            ${proposal ? html`<p class="ls-approval-hint" role="note">⏳ הפריטים יישלחו לאישור מנהל לפני שייכנסו לרשימה.</p>` : null}
            ${withDups.some((r) => r.dup) ? html`<p class="ls-hint">🔁 פריטים שמסומנים — כבר ברשימה או דומים למשהו שיש. אפשר למחוק או להשאיר.</p>` : null}
            <${DraftRows} ...${draftProps} rows=${withDups} />`
          : html`<${EmptyState} emoji="📝" title="עוד לא הוספתם כלום" text="חוזרים (״חזרה״ למטה) ומתחילים לכתוב 🙂" />`}
        <div class="imp-footer bld-footer">
          <div class="bld-footer__row">
            <${Button} variant="secondary" icon="arrow-right" onClick=${() => go(total - 1)}>חזרה</${Button}>
            <${Button} class="bld-nav__next" variant="accent" size="lg" icon=${proposal ? 'send' : 'check'} loading=${saving}
              disabled=${!rows.length} onClick=${save}>
              ${proposal ? `שליחת ${hebrewCount(rows.length, 'הצעה', 'הצעות')}` : `שמירה (${rows.length})`}
            </${Button}>
          </div>
        </div>`}
  </div>`;
}
