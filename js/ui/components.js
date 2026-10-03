// Shared UI components (SPEC §7.6). Styles live in css/styles.css (one class family per component).
// Everything is RTL-first (logical CSS properties), keyboard reachable and ≥44px to tap.
import { html } from 'htm/preact';
import { render, cloneElement, isValidElement, toChildArray } from 'preact';
import { useState, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { Icon } from './icons.js?v=6fb25aa';
import { whatsappShareUrl, displayName, tripOver } from '../lib/logic.js?v=6fb25aa';

// ---------------------------------------------------------------------------
// helpers (module-private)
// ---------------------------------------------------------------------------

const cx = (...parts) => parts.filter(Boolean).join(' ');

// Unique ids across every render root. (Preact's useId restarts per root, so ids inside
// portalled sheets/dialogs would collide with ids in the main tree.)
let idSeq = 0;
const useUid = (prefix = 'md') => useState(() => `${prefix}-${(++idSeq).toString(36)}`)[0];
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

const PROFILE_EMOJIS = ['⛺', '🔥', '🌲', '🦊', '🐻', '🦉', '🦔', '🐢', '🦎', '🌙', '⭐', '🍉', '🥩', '🍺', '🎸', '🏕️', '🌈', '🐬', '🦄', '🌵'];
const SWATCHES = [
  ['#2F6B4F', 'ירוק יער'], ['#F28C28', 'כתום'], ['#E4572E', 'גחלת'], ['#3A86FF', 'כחול'], ['#8E44AD', 'סגול'],
  ['#16A085', 'טורקיז'], ['#D4A017', 'חרדל'], ['#C0392B', 'אדום'], ['#2C3E50', 'כחול לילה'], ['#FF6B9A', 'ורוד'],
];
const HEX_RE = /^#[0-9a-f]{3,8}$/i;
const safeColor = (c) => (typeof c === 'string' && HEX_RE.test(c) ? c : '#2F6B4F');
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function memberName(member) {
  if (!member) return '';
  try {
    return displayName(member) || '';
  } catch {
    return member.display_name || '';
  }
}

/** Icon prop → node: a known icon name, an emoji/text, or a ready vnode. */
function renderIcon(icon, size) {
  if (icon == null || icon === false || icon === '') return null;
  if (typeof icon === 'string') {
    return /^[a-z][a-z-]*$/.test(icon)
      ? html`<${Icon} name=${icon} size=${size} />`
      : html`<span class="emoji-icon" aria-hidden="true">${icon}</span>`;
  }
  return icon;
}

function hasContent(children) {
  return toChildArray(children).some((c) => c !== '' && c != null && c !== false);
}

function portalRoot() {
  let el = document.getElementById('portal-root');
  if (!el) {
    el = document.createElement('div');
    el.id = 'portal-root';
    document.body.appendChild(el);
  }
  return el;
}

/** Renders children into #portal-root (outside transformed/overflow ancestors). */
function Portal({ children }) {
  const host = useRef(null);
  if (!host.current && typeof document !== 'undefined') host.current = document.createElement('div');
  useLayoutEffect(() => {
    const el = host.current;
    portalRoot().appendChild(el);
    return () => {
      render(null, el);
      el.remove();
    };
  }, []);
  useLayoutEffect(() => {
    render(html`${children}`, host.current);
  });
  return null;
}

// Stack of open modal layers so ESC / Tab only affect the top-most one.
const modalStack = [];
let scrollLocks = 0;
function lockScroll() {
  if (scrollLocks++ === 0) document.documentElement.classList.add('is-scroll-locked');
}
function unlockScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) document.documentElement.classList.remove('is-scroll-locked');
}
function trapTab(e, container) {
  const items = [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!items.length) {
    e.preventDefault();
    container.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === container)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Shared modal behaviour: scroll lock, ESC, focus in/out + light focus trap. */
function useModal(ref, onEscape) {
  const escRef = useRef(onEscape);
  escRef.current = onEscape;
  // Layout effect: keyboard handling is live as soon as the modal is in the DOM.
  useLayoutEffect(() => {
    const token = {};
    modalStack.push(token);
    lockScroll();
    const previous = document.activeElement;
    const onKey = (e) => {
      if (modalStack[modalStack.length - 1] !== token || !ref.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        escRef.current?.();
      } else if (e.key === 'Tab') {
        trapTab(e, ref.current);
      }
    };
    document.addEventListener('keydown', onKey, true);
    const focusTimer = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      // The user (or a test) already moved focus into the modal — don't yank it back.
      const active = document.activeElement;
      if (active && active !== el && el.contains(active)) return;
      const target = el.querySelector('[autofocus],[data-autofocus]') || el;
      target.focus({ preventScroll: true });
    }, 40);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKey, true);
      const i = modalStack.indexOf(token);
      if (i >= 0) modalStack.splice(i, 1);
      unlockScroll();
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);
}

/** Mount → animate in; open=false → animate out → unmount. */
function usePresence(open, exitMs = 240) {
  const [mounted, setMounted] = useState(!!open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    let timer = 0;
    if (open) {
      setMounted(true);
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setShown(true));
      });
    } else {
      setShown(false);
      timer = setTimeout(() => setMounted(false), exitMs);
    }
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(timer);
    };
  }, [open]);
  return { mounted, shown };
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export function Button({
  variant = 'primary', size = 'md', icon, block, loading, disabled, onClick, type = 'button',
  children, href, class: klass, className, ...rest
}) {
  const classes = cx('btn', `btn--${variant}`, `btn--${size}`, block && 'btn--block', loading && 'is-loading', klass, className);
  const iconSize = size === 'sm' ? 16 : size === 'lg' ? 22 : 18;
  const inner = html`${loading
    ? html`<span class="btn__spinner" aria-hidden="true"></span>`
    : renderIcon(icon, iconSize)}${hasContent(children) ? html`<span class="btn__label">${children}</span>` : null}`;
  if (href && !disabled && !loading) {
    return html`<a class=${classes} href=${href} onClick=${onClick} ...${rest}>${inner}</a>`;
  }
  return html`<button
    type=${type}
    class=${classes}
    disabled=${disabled || loading}
    aria-busy=${loading ? 'true' : undefined}
    onClick=${onClick}
    ...${rest}
  >${inner}</button>`;
}

export function IconButton({ icon, label, onClick, badge, href, size = 22, class: klass, ...rest }) {
  const count = typeof badge === 'number' ? badge : 0;
  const badgeNode = badge
    ? html`<span class=${cx('badge', badge === true && 'badge--dot')} aria-hidden="true">${badge === true ? '' : count > 99 ? '99+' : badge}</span>`
    : null;
  const aria = badge && badge !== true ? `${label} (${badge})` : label;
  const inner = html`${renderIcon(icon, size)}${badgeNode}`;
  if (href) {
    return html`<a class=${cx('icon-btn', klass)} href=${href} aria-label=${aria} title=${label} onClick=${onClick} ...${rest}>${inner}</a>`;
  }
  return html`<button type="button" class=${cx('icon-btn', klass)} aria-label=${aria} title=${label} onClick=${onClick} ...${rest}>${inner}</button>`;
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({ title, emoji, action, tone = 'default', onClick, children, class: klass, ...rest }) {
  const clickable = typeof onClick === 'function';
  const onKeyDown = clickable
    ? (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
        e.preventDefault();
        onClick(e);
      }
    }
    : undefined;
  const head = title || emoji || action
    ? html`<div class="card__head">
        ${emoji ? html`<span class="card__emoji" aria-hidden="true">${emoji}</span>` : null}
        ${title ? html`<h2 class="card__title">${title}</h2>` : html`<span class="card__spacer"></span>`}
        ${action ? html`<div class="card__action" onClick=${(e) => e.stopPropagation()}>${action}</div>` : null}
      </div>`
    : null;
  return html`<div
    class=${cx('card', `card--${tone}`, clickable && 'card--clickable', klass)}
    role=${clickable ? 'button' : undefined}
    tabIndex=${clickable ? 0 : undefined}
    onClick=${onClick}
    onKeyDown=${onKeyDown}
    ...${rest}
  >${head}${children}</div>`;
}

function SheetView({ shown, onClose, title, footer, children, klass }) {
  const ref = useRef(null);
  const titleId = useUid();
  const [drag, setDrag] = useState(0);
  const dragRef = useRef(null);
  useModal(ref, () => onClose?.());

  const onPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest('button,a,input,textarea,select')) return;
    dragRef.current = { y: e.clientY, id: e.pointerId, dy: 0 };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    d.dy = Math.max(0, e.clientY - d.y);
    setDrag(d.dy);
  };
  const onPointerEnd = (e) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    setDrag(0);
    if (d.dy > 90) onClose?.();
  };

  return html`<div class=${cx('sheet-layer', shown && 'is-shown')}>
    <div class="sheet-backdrop" aria-hidden="true" onClick=${() => onClose?.()}></div>
    <div
      class=${cx('sheet', klass)}
      role="dialog"
      aria-modal="true"
      aria-labelledby=${title ? titleId : undefined}
      aria-label=${title ? undefined : 'חלונית'}
      tabIndex="-1"
      ref=${ref}
      style=${drag ? `transform: translateY(${drag}px); transition: none;` : undefined}
    >
      <div
        class="sheet__grab"
        onPointerDown=${onPointerDown}
        onPointerMove=${onPointerMove}
        onPointerUp=${onPointerEnd}
        onPointerCancel=${onPointerEnd}
      >
        <span class="sheet__handle" aria-hidden="true"></span>
        ${title
          ? html`<div class="sheet__head">
              <h2 class="sheet__title" id=${titleId}>${title}</h2>
              <${IconButton} icon="x" label="סגירה" onClick=${() => onClose?.()} class="sheet__close" />
            </div>`
          : null}
      </div>
      <div class="sheet__body">${children}</div>
      ${footer ? html`<div class="sheet__footer">${footer}</div>` : null}
    </div>
  </div>`;
}

/** Bottom sheet. Keep it mounted and toggle `open`; content is portalled to #portal-root. */
export function Sheet({ open, onClose, title, children, footer, class: klass }) {
  const { mounted, shown } = usePresence(open);
  if (!mounted) return null;
  return html`<${Portal}>
    <${SheetView} shown=${shown} onClose=${onClose} title=${title} footer=${footer} klass=${klass}>${children}</${SheetView}>
  </${Portal}>`;
}

function ConfirmView({ title, text, confirmText, cancelText, danger, onDone }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);
  const [closing, setClosing] = useState(false);
  const titleId = useUid();
  const textId = useUid();
  const finish = (value) => {
    if (closing) return;
    setClosing(true);
    onDone(value);
  };
  useModal(ref, () => finish(false));
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);
  return html`<div class=${cx('dialog-layer', shown && !closing && 'is-shown')}>
    <div class="dialog-backdrop" aria-hidden="true" onClick=${() => finish(false)}></div>
    <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby=${titleId} aria-describedby=${text ? textId : undefined} tabIndex="-1" ref=${ref}>
      <div class="dialog__emoji" aria-hidden="true">${danger ? '🗑️' : '🤔'}</div>
      <h2 class="dialog__title" id=${titleId}>${title}</h2>
      ${text ? html`<p class="dialog__text" id=${textId}>${text}</p>` : null}
      <div class="dialog__actions">
        <${Button} variant=${danger ? 'danger' : 'primary'} onClick=${() => finish(true)} data-autofocus=${danger ? undefined : ''}>${confirmText}</${Button}>
        <${Button} variant="secondary" onClick=${() => finish(false)} data-autofocus=${danger ? '' : undefined}>${cancelText}</${Button}>
      </div>
    </div>
  </div>`;
}

/** Imperative confirm. `await confirmDialog({title, text, confirmText, danger})` → boolean. */
export function confirmDialog({ title = 'בטוח?', text = '', confirmText = 'אישור', cancelText = 'ביטול', danger = false } = {}) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    portalRoot().appendChild(host);
    let settled = false;
    // leaving the screen ("חזרה") answers no — the question must not stay over another screen, still live.
    // Only a change of path counts: a deep link dropping its own query (navigate(…, {replace})) is the same screen.
    const pathOf = () => location.hash.split('?')[0];
    const askedAt = pathOf();
    const onRoute = () => { if (pathOf() !== askedAt) onDone(false); };
    window.addEventListener('hashchange', onRoute);
    const onDone = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('hashchange', onRoute);
      resolve(value);
      setTimeout(() => {
        render(null, host);
        host.remove();
      }, 200);
    };
    render(html`<${ConfirmView}
      title=${title} text=${text} confirmText=${confirmText} cancelText=${cancelText} danger=${danger} onDone=${onDone}
    />`, host);
  });
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export function Avatar({ member, size = 40, class: klass }) {
  const name = memberName(member);
  const heads = Number(member?.headcount) || 1;
  const ghost = member && member.claimed === false;
  return html`<span
    class=${cx('avatar', !member && 'avatar--empty', ghost && 'avatar--ghost', klass)}
    style=${`--av-size:${size}px;--av-color:${safeColor(member?.color)}`}
    role="img"
    aria-label=${name || 'פרופיל'}
    title=${name || undefined}
  >
    <span class="avatar__emoji" aria-hidden="true">${member ? member.emoji || '🙂' : '?'}</span>
    ${heads >= 2 ? html`<span class="avatar__badge" aria-hidden="true">${heads}</span>` : null}
  </span>`;
}

export function AvatarStack({ members = [], max = 4, size = 28 }) {
  const list = (members || []).filter(Boolean);
  const shown = list.slice(0, max);
  const extra = list.length - shown.length;
  const label = list.map(memberName).filter(Boolean).join(', ');
  return html`<span class="avatar-stack" role="group" aria-label=${label} style=${`--av-size:${size}px`}>
    ${shown.map((m) => html`<${Avatar} key=${m.id} member=${m} size=${size} />`)}
    ${extra > 0 ? html`<span class="avatar avatar--more" style=${`--av-size:${size}px`} aria-hidden="true" dir="ltr">+${extra}</span>` : null}
  </span>`;
}

// ---------------------------------------------------------------------------
// Small controls
// ---------------------------------------------------------------------------

export function Chip({ active, onClick, children, tone, class: klass, ...rest }) {
  const classes = cx('chip', tone && `chip--${tone}`, active && 'is-active', klass);
  if (onClick) {
    return html`<button type="button" class=${classes} aria-pressed=${active ? 'true' : 'false'} onClick=${onClick} ...${rest}>${children}</button>`;
  }
  return html`<span class=${classes} ...${rest}>${children}</span>`;
}

export function Segmented({ options = [], value, onChange, label, class: klass }) {
  const ref = useRef(null);
  const activeIndex = options.findIndex((o) => o.value === value);

  // Keep the active option visible inside the horizontal scroller (never scrolls the page).
  useEffect(() => {
    const box = ref.current;
    const el = box?.querySelector('[aria-selected="true"]');
    if (!box || !el || box.scrollWidth <= box.clientWidth) return;
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.left >= b.left && r.right <= b.right) return;
    const delta = r.left + r.width / 2 - (b.left + b.width / 2);
    box.scrollBy({ left: delta, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [value]);

  const onKeyDown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const forward = (e.key === 'ArrowLeft') === rtl;
    let i = activeIndex < 0 ? 0 : activeIndex;
    if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = options.length - 1;
    else i = (i + (forward ? 1 : -1) + options.length) % options.length;
    const next = options[i];
    if (next) {
      onChange?.(next.value);
      requestAnimationFrame(() => ref.current?.querySelectorAll('[role="tab"]')[i]?.focus());
    }
  };

  return html`<div class=${cx('segmented', klass)} role="tablist" aria-label=${label} ref=${ref} onKeyDown=${onKeyDown}>
    ${options.map((o, i) => {
      const active = o.value === value;
      return html`<button
        type="button"
        role="tab"
        key=${String(o.value)}
        class=${cx('segmented__opt', active && 'is-active')}
        aria-selected=${active ? 'true' : 'false'}
        tabIndex=${active || (activeIndex < 0 && i === 0) ? 0 : -1}
        onClick=${() => onChange?.(o.value)}
      >
        <span>${o.label}</span>
        ${o.badge ? html`<span class="segmented__badge">${o.badge}</span>` : null}
      </button>`;
    })}
  </div>`;
}

export function ProgressRing({ value = 0, size = 64, stroke = 8, children, label }) {
  const target = clamp(Number(value), 0, 100);
  const [shown, setShown] = useState(reducedMotion() ? target : 0);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(target));
    return () => cancelAnimationFrame(r);
  }, [target]);
  const gid = useUid('ring');
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  const complete = target >= 100;
  return html`<div
    class=${cx('ring', complete && 'is-complete')}
    style=${`width:${size}px;height:${size}px`}
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow=${Math.round(target)}
    aria-label=${label}
  >
    <svg width=${size} height=${size} viewBox=${`0 0 ${size} ${size}`} aria-hidden="true">
      <defs>
        <linearGradient id=${gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" class="ring__stop-a" />
          <stop offset="1" class="ring__stop-b" />
        </linearGradient>
      </defs>
      <circle class="ring__track" cx=${mid} cy=${mid} r=${r} stroke-width=${stroke} />
      <circle
        class="ring__value"
        cx=${mid}
        cy=${mid}
        r=${r}
        stroke-width=${stroke}
        stroke=${`url(#${gid})`}
        stroke-dasharray=${c}
        stroke-dashoffset=${c * (1 - shown / 100)}
        transform=${`rotate(-90 ${mid} ${mid})`}
      />
    </svg>
    <div class="ring__center">${children}</div>
  </div>`;
}

export function ProgressBar({ value = 0, tone = 'primary', label }) {
  const v = clamp(Number(value), 0, 100);
  return html`<div
    class=${cx('progress', `progress--${tone}`, v >= 100 && 'is-complete')}
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow=${Math.round(v)}
    aria-label=${label}
  ><span class="progress__fill" style=${`width:${v}%`}></span></div>`;
}

export function Pill({ tone = 'default', children, class: klass, ...rest }) {
  return html`<span class=${cx('pill', `pill--${tone}`, klass)} ...${rest}>${children}</span>`;
}

export function Stepper({ value = 0, min = 0, max = 99, onChange, label = 'כמות', step = 1 }) {
  const v = Number(value) || 0;
  return html`<div class="stepper" role="group" aria-label=${label}>
    <button type="button" class="stepper__btn" aria-label="פחות" disabled=${v <= min} onClick=${() => onChange?.(Math.max(min, v - step))}>
      <${Icon} name="minus" size=${18} />
    </button>
    <output class="stepper__value num" aria-live="polite">${v}</output>
    <button type="button" class="stepper__btn" aria-label="עוד" disabled=${v >= max} onClick=${() => onChange?.(Math.min(max, v + step))}>
      <${Icon} name="plus" size=${18} />
    </button>
  </div>`;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

/**
 * Label + hint + error around a control. A single element child gets `id`,
 * `aria-describedby` and `aria-invalid` wired automatically.
 */
export function Field({ label, hint, error, children, class: klass }) {
  const base = useUid();
  const kids = toChildArray(children).filter((c) => c !== '' && c != null && c !== false);
  // Only real text controls get `for=`/id wiring; pickers etc. become a labelled group.
  const only = kids.length === 1 && isValidElement(kids[0]) && LABELABLE.has(kids[0].type) ? kids[0] : null;
  const controlId = only ? only.props.id || `${base}-c` : null;
  const hintId = hint ? `${base}-h` : undefined;
  const errId = error ? `${base}-e` : undefined;
  const describedBy = [errId, hintId].filter(Boolean).join(' ') || undefined;
  const control = only
    ? cloneElement(only, {
      id: controlId,
      'aria-describedby': describedBy,
      'aria-invalid': error ? 'true' : undefined,
    })
    : children;
  const labelNode = label
    ? only
      ? html`<label class="field__label" for=${controlId}>${label}</label>`
      : html`<span class="field__label" id=${`${base}-l`}>${label}</span>`
    : null;
  return html`<div
    class=${cx('field', error && 'has-error', klass)}
    role=${only ? undefined : 'group'}
    aria-labelledby=${!only && label ? `${base}-l` : undefined}
  >
    ${labelNode}
    ${control}
    ${error ? html`<span class="field__error" id=${errId} role="alert">${error}</span>` : null}
    ${hint ? html`<span class="field__hint" id=${hintId}>${hint}</span>` : null}
  </div>`;
}

export function TextInput({ class: klass, type = 'text', ...props }) {
  return html`<input type=${type} ...${props} class=${cx('input', klass)} />`;
}

export function TextArea({ class: klass, onInput, rows = 3, ...props }) {
  const ref = useRef(null);
  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 420)}px`;
  };
  useLayoutEffect(grow, [props.value]);
  return html`<textarea
    ref=${ref}
    rows=${rows}
    ...${props}
    class=${cx('input', 'textarea', klass)}
    onInput=${(e) => {
      grow();
      onInput?.(e);
    }}
  ></textarea>`;
}

const moneyText = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '' : String(Number(v)));
// "1,240.50" / "1,240" → thousands separators; "12,5" (a comma with 1–2 digits after it, no dot) → decimal comma
const moneyNormalize = (t) => {
  const s = String(t ?? '');
  if (!s.includes(',')) return s;
  if (s.includes('.') || /,\d{3}(?:,|$)/.test(s)) return s.replace(/,/g, '');
  const last = s.lastIndexOf(',');
  return `${s.slice(0, last).replace(/,/g, '')}.${s.slice(last + 1)}`;
};
const moneyParse = (t) => {
  const s = moneyNormalize(t);
  if (!s || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/** Shekel amount input. `onChange(number|null)`. */
export function MoneyInput({ value, onChange, placeholder = '0', symbol = '₪', class: klass, ...rest }) {
  const [text, setText] = useState(moneyText(value));
  // values we told the parent while typing: a late re-render with one of them (even an older one) must not
  // rewrite what's being typed; any other value comes from outside (reset, a picked expense) and is shown
  const sent = useRef(new Set());
  useEffect(() => {
    const incoming = value === '' || value === undefined || value === null ? null : Number(value);
    if (sent.current.has(incoming)) return;
    sent.current.clear();
    if (moneyParse(text) !== incoming) setText(moneyText(value));
  }, [value]);
  const onInput = (e) => {
    // keep what was typed (commas included) — "1,240.50" must not become 1.24 while typing; parse decides
    let t = e.target.value.replace(/[^\d.,]/g, '');
    const dot = t.indexOf('.');
    if (dot >= 0) t = `${t.slice(0, dot + 1)}${t.slice(dot + 1).replace(/[.,]/g, '').slice(0, 2)}`;
    if (t.length > 12) t = t.slice(0, 12);
    if (t !== e.target.value) e.target.value = t;
    setText(t);
    const n = moneyParse(t);
    if (sent.current.size > 50) sent.current.clear();
    sent.current.add(n);
    onChange?.(n);
  };
  return html`<div class=${cx('money-input', klass)}>
    <span class="money-input__sym" aria-hidden="true">${symbol}</span>
    <input
      type="text"
      inputmode="decimal"
      autocomplete="off"
      dir="ltr"
      placeholder=${placeholder}
      ...${rest}
      class="input money-input__field num"
      value=${text}
      onInput=${onInput}
    />
  </div>`;
}

const LABELABLE = new Set([TextInput, TextArea, MoneyInput, 'input', 'select', 'textarea']);

export function Toggle({ checked, onChange, label, hint, disabled }) {
  const id = useUid();
  const sw = html`<button
    type="button"
    role="switch"
    class="toggle"
    aria-checked=${checked ? 'true' : 'false'}
    aria-labelledby=${label ? `${id}-l` : undefined}
    aria-describedby=${hint ? `${id}-h` : undefined}
    disabled=${disabled}
    onClick=${(e) => {
      e.preventDefault();
      onChange?.(!checked);
    }}
  ><span class="toggle__knob" aria-hidden="true"></span></button>`;
  if (!label) return sw;
  return html`<div class=${cx('toggle-row', disabled && 'is-disabled')} onClick=${(e) => {
    if (!disabled && !e.target.closest('.toggle')) onChange?.(!checked);
  }}>
    <span class="toggle-row__text">
      <span class="toggle-row__label" id=${`${id}-l`}>${label}</span>
      ${hint ? html`<span class="toggle-row__hint" id=${`${id}-h`}>${hint}</span>` : null}
    </span>
    ${sw}
  </div>`;
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function EmptyState({ emoji = '🏕️', title, text, action }) {
  return html`<div class="empty">
    <div class="empty__emoji" aria-hidden="true">${emoji}</div>
    ${title ? html`<h3 class="empty__title">${title}</h3>` : null}
    ${text ? html`<p class="empty__text">${text}</p>` : null}
    ${action ? html`<div class="empty__action">${action}</div>` : null}
  </div>`;
}

export function Section({ title, emoji, count, right, collapsible, defaultOpen = true, children, class: klass }) {
  const [open, setOpen] = useState(defaultOpen !== false);
  const bodyId = useUid();
  const heading = html`
    ${emoji ? html`<span class="section__emoji" aria-hidden="true">${emoji}</span>` : null}
    <span class="section__text">${title}</span>
    ${count !== undefined && count !== null && count !== '' ? html`<span class="section__count num">${count}</span>` : null}`;
  return html`<section class=${cx('section', collapsible && 'section--collapsible', !open && 'is-closed', klass)}>
    <div class="section__head">
      <h2 class="section__title">
        ${collapsible
          ? html`<button type="button" class="section__toggle" aria-expanded=${open ? 'true' : 'false'} aria-controls=${bodyId} onClick=${() => setOpen(!open)}>
              ${heading}
              <${Icon} name="chevron-down" size=${18} class="section__chev" />
            </button>`
          : heading}
      </h2>
      ${right ? html`<div class="section__right">${right}</div>` : null}
    </div>
    ${open ? html`<div class="section__body" id=${bodyId}>${children}</div>` : null}
  </section>`;
}

const SKELETON_WIDTHS = [58, 92, 76, 84, 64, 88, 70];
export function Skeleton({ lines = 3 }) {
  const n = Math.max(1, Number(lines) || 3);
  return html`<div class="skeleton" aria-busy="true" aria-label="טוען…" role="status">
    ${Array.from({ length: n }, (_, i) => html`<span class="skeleton__line" style=${`width:${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}%`}></span>`)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

export function EmojiPicker({ value, onChange, options = PROFILE_EMOJIS, label = 'בחירת אימוג׳י' }) {
  return html`<div class="emoji-grid" role="group" aria-label=${label}>
    ${options.map((e) => html`<button
      type="button"
      key=${e}
      class="emoji-opt"
      aria-pressed=${e === value ? 'true' : 'false'}
      aria-label=${e}
      onClick=${() => onChange?.(e)}
    ><span aria-hidden="true">${e}</span></button>`)}
  </div>`;
}

export function ColorPicker({ value, onChange, label = 'בחירת צבע' }) {
  const current = String(value || '').toUpperCase();
  return html`<div class="color-grid" role="group" aria-label=${label}>
    ${SWATCHES.map(([hex, name]) => html`<button
      type="button"
      key=${hex}
      class="color-opt"
      style=${`--swatch:${hex}`}
      aria-pressed=${hex === current ? 'true' : 'false'}
      aria-label=${name}
      title=${name}
      onClick=${() => onChange?.(hex)}
    >${hex === current ? html`<${Icon} name="check" size=${18} />` : null}</button>`)}
  </div>`;
}

/** Single (`value` = id) or multi (`value` = [ids]) member selection. */
/** `tags`: optional Map member_id → short text shown after the name (e.g. "🎁 פטור/ה"). */
export function MemberPicker({ members = [], value, onChange, multi, label = 'בחירת משתתפים', tags = null }) {
  const selected = multi ? new Set(Array.isArray(value) ? value : []) : null;
  const isOn = (id) => (multi ? selected.has(id) : value === id);
  const toggle = (id) => {
    if (!multi) {
      onChange?.(id);
      return;
    }
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange?.(members.map((m) => m.id).filter((mid) => next.has(mid)));
  };
  const all = multi && members.length > 0 && members.every((m) => selected.has(m.id));
  return html`<div class="member-picker" role="group" aria-label=${label}>
    ${multi && members.length > 1
      ? html`<button type="button" class=${cx('member-opt', 'member-opt--all', all && 'is-on')} aria-pressed=${all ? 'true' : 'false'}
          onClick=${() => onChange?.(all ? [] : members.map((m) => m.id))}>
          <span class="member-opt__all" aria-hidden="true">👥</span>
          <span class="member-opt__name">${all ? 'נקה הכל' : 'כולם'}</span>
        </button>`
      : null}
    ${members.map((m) => {
      const on = isOn(m.id);
      return html`<button type="button" key=${m.id} class=${cx('member-opt', on && 'is-on')} aria-pressed=${on ? 'true' : 'false'} onClick=${() => toggle(m.id)}>
        <${Avatar} member=${m} size=${30} />
        <span class="member-opt__name">${memberName(m)}</span>
        ${tags?.get(m.id) ? html`<span class="member-opt__tag tiny muted">${tags.get(m.id)}</span>` : null}
        ${on ? html`<span class="member-opt__check" aria-hidden="true"><${Icon} name="check" size=${14} /></span>` : null}
      </button>`;
    })}
  </div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Floating action button (portalled so it never scrolls with content). */
/** tripOver lives in logic.js; re-exported for the screens that take their UI helpers from here. */
export { tripOver };

/** One line on every tab once the trip ended: "🏁 הטיול הסתיים · לקריאה בלבד". */
export function OverBanner({ trip, text = 'לקריאה בלבד' }) {
  if (!trip || !tripOver(trip)) return null;
  return html`<p class="over-banner" data-testid="over-banner" role="status">
    <span aria-hidden="true">🏁</span> הטיול הסתיים · ${text}
  </p>`;
}

/**
 * Summary first, details on tap: a native <details> whose closed state is one row —
 * "🧾 הוצאות (3) · 940₪ ‹". `meta` sits at the row's end.
 */
export function Fold({ emoji, title, count, meta, open = false, children, class: klass, ...rest }) {
  return html`<details class=${cx('fold', klass)} open=${open || undefined} ...${rest}>
    <summary class="fold__row">
      ${emoji ? html`<span class="fold__emoji" aria-hidden="true">${emoji}</span>` : null}
      <span class="fold__title">${title}${count !== undefined && count !== null && count !== '' ? html` <span class="fold__count num">(${count})</span>` : null}</span>
      ${meta ? html`<span class="fold__meta">${meta}</span>` : null}
      <${Icon} name="chevron-down" size=${18} class="fold__chev" />
    </summary>
    <div class="fold__body">${children}</div>
  </details>`;
}

export function Fab({ icon = 'plus', label, onClick }) {
  return html`<${Portal}>
    <button type="button" class=${cx('fab', label && 'fab--extended')} aria-label=${label || 'הוספה'} onClick=${onClick}>
      ${renderIcon(icon, 24)}
      ${label ? html`<span class="fab__label">${label}</span>` : null}
    </button>
  </${Portal}>`;
}

/** Shares text to WhatsApp. On phones uses the native share sheet when available. */
export function ShareButton({ text = '', label = 'שיתוף בוואטסאפ', size = 'md', block, variant = 'share' }) {
  const url = whatsappShareUrl(text);
  const onClick = async (e) => {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (!navigator.share || !coarse) return; // plain link → wa.me
    e.preventDefault();
    try {
      await navigator.share({ text });
    } catch (err) {
      if (err?.name !== 'AbortError') window.open(url, '_blank', 'noopener,noreferrer');
    }
  };
  return html`<${Button} href=${url} target="_blank" rel="noopener noreferrer" variant=${variant} size=${size} block=${block} icon="share" onClick=${onClick}>${label}</${Button}>`;
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;inset-inline-start:-9999px;top:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function CopyButton({ text = '', label = 'העתקה', size = 'md', block, variant = 'secondary' }) {
  const [state, setState] = useState('idle');
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = async () => {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1800);
  };
  const copied = state === 'copied';
  return html`<${Button}
    variant=${variant}
    size=${size}
    block=${block}
    icon=${copied ? 'check' : 'copy'}
    class=${copied ? 'is-copied' : undefined}
    onClick=${onClick}
    aria-live="polite"
  >${copied ? 'הועתק!' : state === 'failed' ? 'לא הצלחנו להעתיק' : label}</${Button}>`;
}

// ---------------------------------------------------------------------------
// Confetti
// ---------------------------------------------------------------------------

const CONFETTI_COLORS = ['#F28C28', '#E4572E', '#FFD166', '#FFB547', '#2F6B4F', '#62C08F', '#FF6B9A', '#FFF3C4'];

/** Lightweight canvas confetti burst (~1.2s). No-op under prefers-reduced-motion. */
export function fireConfetti() {
  if (typeof document === 'undefined' || reducedMotion()) return Promise.resolve(false);
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return Promise.resolve(false);
  }
  ctx.scale(dpr, dpr);

  const count = Math.round(Math.min(160, Math.max(90, w / 3)));
  const parts = Array.from({ length: count }, (_, i) => {
    const fromSide = i % 3; // 0 = center burst, 1 = right cannon, 2 = left cannon
    const x = fromSide === 0 ? w / 2 : fromSide === 1 ? w - 10 : 10;
    const y = fromSide === 0 ? h * 0.38 : h * 0.72;
    const baseAngle = fromSide === 0 ? -Math.PI / 2 : fromSide === 1 ? -Math.PI * 0.68 : -Math.PI * 0.32;
    const spread = fromSide === 0 ? Math.PI * 0.9 : Math.PI * 0.32;
    const angle = baseAngle + (Math.random() - 0.5) * spread;
    const speed = (fromSide === 0 ? 7 : 11) + Math.random() * 7;
    return {
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      shape: i % 4 === 0 ? 'circle' : 'rect',
      wobble: Math.random() * 10,
    };
  });

  const duration = 1250;
  const start = performance.now();
  return new Promise((resolve) => {
    const frame = (now) => {
      const t = now - start;
      const fade = t > duration - 350 ? Math.max(0, (duration - t) / 350) : 1;
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.vy += 0.32;
        p.vx *= 0.985;
        p.vy *= 0.985;
        p.x += p.vx + Math.sin((t / 120) + p.wobble) * 0.6;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.shape === 'circle') {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2.4, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        }
        ctx.restore();
      }
      if (t < duration) requestAnimationFrame(frame);
      else {
        canvas.remove();
        resolve(true);
      }
    };
    requestAnimationFrame(frame);
  });
}
