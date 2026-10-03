// PlaceInput (design §3.2): a text field with OpenStreetMap suggestions. Free text is always allowed;
// picking a suggestion fills {name, address, lat, lon, osm, kind}. Combobox/listbox semantics, arrows / Enter /
// Esc, rows ≥44px, "© OpenStreetMap" under the list. Enter with no highlighted row = "חיפוש מלא" (Nominatim).
//
//   <PlaceInput label="לאן?" value=${place} text=${text} onChange=${(place, text) => …} where="il"
//               near=${{lat, lon}} placeholder="חניון, חוף, יישוב…" testid="trip-place" />
// Optional: kinds=${['aerodrome']} (only these OSM kinds), nav=${false} (no Waze/Maps on the picked card),
//           hint, autoFocus, disabled, maxlength (default 80 — rides' from/to on the server; a trip's place: 120).
//           Typed text and a picked name are both cut to it, so a long OSM name never fails a save.
import { html } from 'htm/preact';
import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'preact/hooks';
import { createSearcher, navLinks, placeEmoji, ATTRIBUTION } from '../lib/places.js?v=8d87c37';

let seq = 0;
export const PLACE_MAX = 80;
/** At most `max` characters (code points, like the server counts). */
const cut = (s, max) => {
  const chars = [...String(s ?? '')];
  return chars.length > max ? chars.slice(0, max).join('').trim() : String(s ?? '');
};
const cx = (...parts) => parts.filter(Boolean).join(' ');

export function PlaceInput({
  label, value = null, text, onChange, where = 'il', near = null, placeholder = 'חיפוש מקום…', testid = 'place',
  kinds = null, nav = true, hint, autoFocus, disabled, maxlength = PLACE_MAX,
}) {
  const [uid] = useState(() => `pl-${(++seq).toString(36)}`);
  const max = Number(maxlength) > 0 ? Number(maxlength) : PLACE_MAX;
  const searcher = useMemo(() => createSearcher(), []);
  const [own, setOwn] = useState(text ?? '');
  const q = text ?? own;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState('');
  const [active, setActive] = useState(-1);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);
  const token = useRef(0);
  const refocus = useRef(false);
  const nearKey = near && near.lat != null ? `${near.lat},${near.lon}` : '';

  useEffect(() => () => searcher.cancel(), [searcher]);
  // After "✕ שינוי" the input comes back — put the cursor in it.
  useLayoutEffect(() => {
    if (!value && refocus.current && inputRef.current) {
      refocus.current = false;
      inputRef.current.focus();
    }
  }, [value]);

  const filtered = kinds && kinds.length ? results.filter((r) => kinds.includes(r.kind)) : results;
  const trimmed = q.trim();
  const showFree = trimmed.length > 0;
  const count = filtered.length + (showFree ? 1 : 0);
  // Hebrew for a place abroad: the as-you-type service (Photon) knows it only in English — a Hebrew name finds
  // something in Israel instead. Nominatim answers Hebrew but may only be asked on purpose, so the list offers
  // "חפשו בעברית" (Enter does the same) rather than guessing while typing.
  const hebAbroad = where === 'abroad' && /[֐-׿]/.test(trimmed) && trimmed.length >= 2;
  const offerHeb = hebAbroad && searched !== trimmed && !busy;
  const listOpen = open && !value && (filtered.length > 0 || offerHeb || (trimmed.length >= 2 && (busy || searched === trimmed)));

  function run(textNow, full) {
    const my = ++token.current;
    const t = textNow.trim();
    if (t.length < 2) {
      searcher.cancel();
      setBusy(false);
      setResults([]);
      setSearched('');
      return;
    }
    if (!full && where === 'abroad' && /[֐-׿]/.test(t)) {       // see hebAbroad: asked on purpose only
      searcher.cancel();
      setBusy(false);
      setResults([]);
      setSearched('');
      return;
    }
    setBusy(true);
    const p = full ? searcher.full(t, { where, near }) : searcher.search(t, { where, near });
    p.then((list) => {
      if (list === null || my !== token.current) return; // superseded
      setBusy(false);
      setResults(list);
      setSearched(t);
      setActive(-1);
    });
  }

  // A new `where` / `near` changes the answers — search again if the list is showing.
  useEffect(() => {
    if (open && !value && trimmed.length >= 2) run(q, false);
  }, [where, nearKey]);

  function setText(t) {
    if (text === undefined) setOwn(t);
    onChange?.(null, t);
  }

  function onInput(e) {
    const t = cut(e.currentTarget.value, max);
    setText(t);
    setOpen(true);
    setActive(-1);
    run(t, false);
  }

  function pick(p) {
    token.current++;
    searcher.cancel();
    setBusy(false);
    setOpen(false);
    setActive(-1);
    const place = {
      name: cut(p.name, max), address: p.address || '', lat: p.lat, lon: p.lon, osm: p.osm || null, kind: p.kind || null,
    };
    if (text === undefined) setOwn(place.name);
    onChange?.(place, place.name);
  }

  function takeFree() {
    token.current++;
    searcher.cancel();
    setBusy(false);
    setOpen(false);
    setActive(-1);
    onChange?.(null, trimmed);
    if (text === undefined) setOwn(trimmed);
  }

  function choose(i) {
    if (i >= 0 && i < filtered.length) pick(filtered[i]);
    else if (showFree && i === filtered.length) takeFree();
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!count) return;
      e.preventDefault();
      if (!open) setOpen(true);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => {
        if (a < 0) return step > 0 ? 0 : count - 1;
        return (a + step + count) % count;
      });
    } else if (e.key === 'Enter') {
      if (e.isComposing) return;
      e.preventDefault(); // never submit the surrounding form from here
      if (listOpen && active >= 0) choose(active);
      else if (trimmed.length >= 2) {
        setOpen(true);
        run(q, true);
      }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  // Esc closes the list before a surrounding Sheet sees it (the sheet listens on document, capture phase).
  useLayoutEffect(() => {
    if (!listOpen) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.target !== inputRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setActive(-1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listOpen]);

  // Keep the highlighted row visible.
  useEffect(() => {
    if (active < 0 || !wrapRef.current) return;
    const el = wrapRef.current.querySelector(`#${uid}-o${active}`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const inputId = `${uid}-i`;
  const listId = `${uid}-l`;
  const hintId = hint ? `${uid}-h` : undefined;

  if (value) {
    const links = nav ? navLinks(value) : {};
    const clear = () => {
      refocus.current = true;
      setOpen(false);
      setResults([]);
      setSearched('');
      if (text === undefined) setOwn(value.name || '');
      onChange?.(null, value.name || '');
    };
    return html`<div class="field place" data-testid=${testid} data-picked="1">
      ${label ? html`<span class="field__label" id=${`${uid}-lab`}>${label}</span>` : null}
      <div class="place-card" role="group" aria-labelledby=${label ? `${uid}-lab` : undefined}>
        <div class="place-card__top">
          <span class="place-card__emoji" aria-hidden="true">${placeEmoji(value.kind)}</span>
          <span class="place-card__name" data-testid=${`${testid}-name`}>${value.name}</span>
          <button type="button" class="place-card__change" onClick=${clear} disabled=${disabled}
            data-testid=${`${testid}-clear`} aria-label=${`שינוי המקום ${value.name}`}>✕ שינוי</button>
        </div>
        ${value.address && value.address !== value.name ? html`<div class="place-card__addr">${value.address}</div>` : null}
        ${links.waze || links.maps
          ? html`<div class="place-card__nav">
              ${links.waze && where !== 'abroad' ? html`<a class="btn btn--secondary btn--sm" href=${links.waze} target="_blank" rel="noopener noreferrer"><span class="emoji-icon" aria-hidden="true">🚙</span><span class="btn__label">Waze</span></a>` : null}
              ${links.maps ? html`<a class="btn btn--secondary btn--sm" href=${links.maps} target="_blank" rel="noopener noreferrer"><span class="emoji-icon" aria-hidden="true">🗺️</span><span class="btn__label">מפות</span></a>` : null}
            </div>`
          : null}
      </div>
      ${hint ? html`<span class="field__hint">${hint}</span>` : null}
    </div>`;
  }

  const activeId = listOpen && active >= 0 ? `${uid}-o${active}` : undefined;
  const status = busy
    ? 'מחפשים…'
    : listOpen
      ? filtered.length ? `${filtered.length} תוצאות` : 'לא מצאנו ברשימה — אפשר להשתמש בטקסט'
      : '';

  return html`<div class="field place" data-testid=${testid} ref=${wrapRef}>
    ${label ? html`<label class="field__label" for=${inputId}>${label}</label>` : null}
    <div class="place__box">
      <span class="place__icon" aria-hidden="true">🔍</span>
      <input
        ref=${inputRef}
        id=${inputId}
        class="input place__input"
        type="text"
        role="combobox"
        autocomplete="off"
        enterkeyhint="search"
        spellcheck=${false}
        aria-autocomplete="list"
        aria-expanded=${listOpen ? 'true' : 'false'}
        aria-controls=${listId}
        aria-activedescendant=${activeId}
        aria-describedby=${hintId}
        placeholder=${placeholder}
        maxlength=${max}
        value=${q}
        disabled=${disabled}
        autoFocus=${autoFocus}
        data-testid=${`${testid}-input`}
        onInput=${onInput}
        onKeyDown=${onKeyDown}
        onFocus=${() => {
          setOpen(true);
          if (trimmed.length >= 2 && searched !== trimmed && !busy) run(q, false);
        }}
        onBlur=${() => setOpen(false)}
      />
      ${busy ? html`<span class="place__spin" aria-hidden="true"></span>` : null}
    </div>
    <div class=${cx('place__pop', !listOpen && 'is-hidden')}>
      <ul id=${listId} class="place__list" role="listbox" aria-label="הצעות למקום">
        ${listOpen && offerHeb
          ? html`<li role="option" aria-selected="false" class="place__opt place__opt--heb" data-testid=${`${testid}-heb`}
              onMouseDown=${(e) => e.preventDefault()} onClick=${() => run(q, true)}>
              <span class="place__opt-emoji" aria-hidden="true">🔎</span>
              <span class="place__opt-text"><span class="place__opt-name">חפשו ״${trimmed}״ בעברית</span>
                <span class="place__opt-addr">או לחצו Enter · בחו״ל ההצעות בזמן הקלדה הן באנגלית</span></span>
            </li>`
          : null}
        ${listOpen
          ? filtered.map((p, i) => html`<li
              id=${`${uid}-o${i}`}
              role="option"
              aria-selected=${active === i ? 'true' : 'false'}
              class=${cx('place__opt', active === i && 'is-active')}
              data-testid=${`${testid}-opt`}
              onMouseDown=${(e) => e.preventDefault()}
              onClick=${() => pick(p)}
            >
              <span class="place__opt-emoji" aria-hidden="true">${placeEmoji(p.kind)}</span>
              <span class="place__opt-text">
                <span class="place__opt-name">${p.name}</span>
                ${p.address && p.address !== p.name ? html`<span class="place__opt-addr">${p.address}</span>` : null}
              </span>
            </li>`)
          : null}
        ${listOpen && showFree
          ? html`<li
              id=${`${uid}-o${filtered.length}`}
              role="option"
              aria-selected=${active === filtered.length ? 'true' : 'false'}
              class=${cx('place__opt', 'place__opt--free', active === filtered.length && 'is-active')}
              data-testid=${`${testid}-free`}
              onMouseDown=${(e) => e.preventDefault()}
              onClick=${takeFree}
            >
              <span class="place__opt-emoji" aria-hidden="true">📍</span>
              <span class="place__opt-text"><span class="place__opt-name">להשתמש ב״${trimmed}״</span></span>
            </li>`
          : null}
      </ul>
      ${listOpen
        ? html`<div class="place__foot">
            <button type="button" class="place__full" data-testid=${`${testid}-full`}
              onMouseDown=${(e) => e.preventDefault()} onClick=${() => run(q, true)}>🔎 חיפוש מלא</button>
            <span class="place__attr">${ATTRIBUTION}</span>
          </div>`
        : null}
    </div>
    <span class="sr-only" role="status" aria-live="polite">${status}</span>
    ${hint ? html`<span class="field__hint" id=${hintId}>${hint}</span>` : null}
  </div>`;
}
