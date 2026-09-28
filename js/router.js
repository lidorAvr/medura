// Hash router (SPEC §7.4). Works under any sub-path because only the hash changes.
import { useState, useEffect } from 'preact/hooks';

/** [pattern, name] — `name` is what app.js maps to a screen. */
const ROUTES = [
  ['/', 'landing'],
  ['/new', 'new'],
  ['/join/:code', 'join'],
  ['/link/:code', 'link'],
  ['/signin', 'signin'],
  ['/t/:tripId', 'home'],
  ['/t/:tripId/lists', 'lists'],
  ['/t/:tripId/shop', 'shop'],
  ['/t/:tripId/import', 'import'],
  ['/t/:tripId/money', 'money'],
  ['/t/:tripId/messages', 'messages'],
  ['/t/:tripId/people', 'people'],
  ['/t/:tripId/me', 'me'],
  ['/t/:tripId/trip', 'trip'],
  ['/t/:tripId/welcome', 'welcome'],
];

const COMPILED = ROUTES.map(([pattern, name]) => {
  const keys = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { name, keys, re: new RegExp(`^${source}$`) };
});

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parse a location hash ('#/t/abc/lists?tab=buy') → {path, params, query, name}. */
export function parseHash(hash) {
  let raw = String(hash || '').replace(/^#/, '');
  const qi = raw.indexOf('?');
  const queryString = qi >= 0 ? raw.slice(qi + 1) : '';
  raw = qi >= 0 ? raw.slice(0, qi) : raw;
  let path = raw.startsWith('/') ? raw : `/${raw}`;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const query = {};
  new URLSearchParams(queryString).forEach((v, k) => {
    query[k] = v;
  });
  for (const r of COMPILED) {
    const m = r.re.exec(path);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = safeDecode(m[i + 1]);
      });
      return { path, params, query, name: r.name };
    }
  }
  return { path, params: {}, query, name: 'notfound' };
}

/** '#/x' → '#/x'; '/x' → '#/x'. */
export function href(path) {
  const p = String(path || '/');
  if (p.startsWith('#')) return p;
  return `#${p.startsWith('/') ? p : `/${p}`}`;
}

/** Go to a route. `navigate('/t/1/lists')` or `navigate('#/t/1/lists')`. */
export function navigate(hash, { replace = false } = {}) {
  const target = href(hash);
  if (replace) {
    const url = `${location.pathname}${location.search}${target}`;
    history.replaceState(history.state, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else if (location.hash !== target) {
    location.hash = target;
  }
}

/** Current route; re-renders on hash changes. */
export function useRoute() {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => {
      const next = parseHash(location.hash);
      setRoute((prev) => (prev.path === next.path && JSON.stringify(prev.query) === JSON.stringify(next.query) ? prev : next));
    };
    window.addEventListener('hashchange', onChange);
    onChange();
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
