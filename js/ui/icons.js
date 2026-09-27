// Inline SVG icon set (SPEC §7.6). 24×24 grid, 2px round strokes, `currentColor`.
// Usage: html`<${Icon} name="bell" size=${20} />`. Decorative by default (aria-hidden);
// pass `title` to expose it to assistive tech.
import { html } from 'htm/preact';

const P = (d) => html`<path d=${d} />`;
const C = (cx, cy, r) => html`<circle cx=${cx} cy=${cy} r=${r} />`;

const ICONS = {
  home: () => html`${P('M3 10.5 12 3l9 7.5')}${P('M5.5 9v10.5a1.5 1.5 0 0 0 1.5 1.5h3.5v-6h3v6H17a1.5 1.5 0 0 0 1.5-1.5V9')}`,
  list: () => html`${P('M9 6h11M9 12h11M9 18h11')}${C(4.5, 6, 1)}${C(4.5, 12, 1)}${C(4.5, 18, 1)}`,
  wallet: () => html`${P('M19 7V5.5A1.5 1.5 0 0 0 17.5 4H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6')}${P('M16.5 14h.01')}`,
  bell: () => html`${P('M6 8.5a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15 6 8.5')}${P('M10.3 20.5a2 2 0 0 0 3.4 0')}`,
  users: () => html`${C(9, 8, 3.5)}${P('M2.5 20.5v-.5a6 6 0 0 1 6-6h1a6 6 0 0 1 6 6v.5')}${P('M16 4.6a3.5 3.5 0 0 1 0 6.8')}${P('M18.5 14.3a6 6 0 0 1 3 5.2v1')}`,
  user: () => html`${C(12, 8, 4)}${P('M4 20.5v-.5a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7v.5')}`,
  plus: () => P('M12 5v14M5 12h14'),
  minus: () => P('M5 12h14'),
  check: () => P('M20 6 9 17l-5-5'),
  x: () => P('M18 6 6 18M6 6l12 12'),
  edit: () => html`${P('M12 20h9')}${P('M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z')}`,
  trash: () => html`${P('M3 6h18')}${P('M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6')}${P('m18.5 6-.9 13.1a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9L5.5 6')}${P('M10 11v5.5M14 11v5.5')}`,
  share: () => html`${C(18, 5, 2.8)}${C(6, 12, 2.8)}${C(18, 19, 2.8)}${P('m8.5 13.4 7 4.2M15.5 6.4l-7 4.2')}`,
  copy: () => html`<rect x="9" y="9" width="12" height="12" rx="2.5" />${P('M5 15h-.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5')}`,
  cart: () => html`${C(9, 20, 1.4)}${C(18, 20, 1.4)}${P('M2.5 3h2.7l2.4 11.6a2 2 0 0 0 2 1.6h8a2 2 0 0 0 2-1.5L21.5 7H6')}`,
  'chevron-left': () => P('m15 18-6-6 6-6'),
  'chevron-right': () => P('m9 18 6-6-6-6'),
  'chevron-down': () => P('m6 9 6 6 6-6'),
  settings: () => html`${P('M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1')}${C(15, 6, 2)}${C(9, 12, 2)}${C(17, 18, 2)}`,
  'map-pin': () => html`${P('M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z')}${C(12, 10, 3)}`,
  calendar: () => html`<rect x="3" y="4.5" width="18" height="17" rx="3" />${P('M16 2.5v4M8 2.5v4M3 10h18')}`,
  clock: () => html`${C(12, 12, 9)}${P('M12 7v5l3.2 2')}`,
  sun: () => html`${C(12, 12, 4)}${P('M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4')}`,
  moon: () => P('M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7Z'),
  flame: () => P('M12 22c-4 0-7-2.7-7-6.6 0-2.6 1.5-4.4 3-5.9.3 1.5 1.1 2.6 2.2 3.1C9.6 9.4 11 5.6 14.5 2.5c.2 3.2 1.8 5.1 3.2 6.8 1.1 1.4 2.3 3 2.3 5.6C20 19.1 16.3 22 12 22Z'),
  tent: () => html`${P('M12 3.5 2 20.5h20L12 3.5Z')}${P('M12 12.5 8.5 20.5M12 12.5l3.5 8')}`,
  search: () => html`${C(11, 11, 7)}${P('m20.5 20.5-4.2-4.2')}`,
  filter: () => P('M3.5 5h17l-6.5 8v6l-4 2v-8Z'),
  send: () => html`${P('M21.5 2.5 10.5 13.5')}${P('M21.5 2.5 14.8 21.5l-4.3-8-8-4.3Z')}`,
  crown: () => html`${P('m2.5 7.5 4 10.5h11l4-10.5-5.5 4L12 4l-4 7.5Z')}${P('M6.5 21h11')}`,
  sparkles: () => html`${P('M11 3.5 12.9 8.6 18 10.5l-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9Z')}${P('M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z')}`,
  receipt: () => html`${P('M5 3v18l2.3-1.4L9.7 21 12 19.6l2.3 1.4 2.4-1.4L19 21V3l-2.3 1.4L14.3 3 12 4.4 9.7 3 7.3 4.4Z')}${P('M9 9h6M9 13h6')}`,
  'arrow-left-right': () => html`${P('M8 3.5 4 7.5l4 4')}${P('M4 7.5h16')}${P('m16 20.5 4-4-4-4')}${P('M20 16.5H4')}`,
  'arrow-left': () => P('M19 12H5m6-6-6 6 6 6'),
  'arrow-right': () => P('M5 12h14m-6-6 6 6-6 6'),
  download: () => html`${P('M12 3.5v12')}${P('m7 10.5 5 5 5-5')}${P('M5 20.5h14')}`,
  link: () => html`${P('M10 13.5a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7')}${P('M14 10.5a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7')}`,
  logout: () => html`${P('M9 21H5.5A1.5 1.5 0 0 1 4 19.5v-15A1.5 1.5 0 0 1 5.5 3H9')}${P('m16 17 5-5-5-5')}${P('M21 12H9')}`,
  more: () => html`${C(5, 12, 1.2)}${C(12, 12, 1.2)}${C(19, 12, 1.2)}`,
  refresh: () => html`${P('M20.5 12a8.5 8.5 0 1 1-2.5-6')}${P('M20.5 3.5V8H16')}`,
  phone: () => P('M21 16.4v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 1.1 3.7 2 2 0 0 1 3.1 1.5h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L7.1 9.4a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z'),
  info: () => html`${C(12, 12, 9)}${P('M12 11v5.5M12 7.5h.01')}`,
  lock: () => html`<rect x="4" y="10.5" width="16" height="11" rx="2.5" />${P('M8 10.5V7a4 4 0 0 1 8 0v3.5')}`,
  'wifi-off': () => html`${P('M2 2l20 20')}${P('M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2.1-1.6M2 8.8a15 15 0 0 1 4.2-2.7M22 8.8A15 15 0 0 0 11 4.8')}${P('M12 20h.01')}`,
};

/**
 * @param {{name: string, size?: number, title?: string, class?: string}} props
 */
export function Icon({ name, size = 20, title, class: klass }) {
  const draw = ICONS[name];
  return html`<svg
    class=${klass ? `icon icon--${name} ${klass}` : `icon icon--${name}`}
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden=${title ? undefined : 'true'}
    role=${title ? 'img' : undefined}
    focusable="false"
  >${title ? html`<title>${title}</title>` : null}${draw ? draw() : null}</svg>`;
}
