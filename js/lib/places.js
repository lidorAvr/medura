// Place search on OpenStreetMap (design §3): Photon for as-you-type suggestions, Nominatim only for an explicit
// "חיפוש מלא" (its usage policy forbids autocomplete), ≤1 request / second, a small LRU + sessionStorage cache.
// Pure helpers + a searcher with injectable fetch/clock/timers so tests never touch the network.
// Demo (?demo=1, or no backend configured) uses the built-in fixture provider unless ?osm=1.

export const PHOTON_URL = 'https://photon.komoot.io/api/';
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
/** Israel bounding box (minLon,minLat,maxLon,maxLat) and a central bias point. */
export const IL_BBOX = '34.2,29.4,35.95,33.4';
export const IL_CENTER = { lat: 31.8, lon: 35.0 };
export const ATTRIBUTION = '© OpenStreetMap';

const CACHE_SIZE = 60;
const STORAGE_PREFIX = 'medura:places:';
const STORAGE_TTL_MS = 24 * 3600 * 1000;

const KIND_EMOJI = {
  camp_site: '⛺', caravan_site: '⛺', picnic_site: '🧺', hotel: '🏨', motel: '🏨', hostel: '🏨', guest_house: '🏡',
  apartment: '🏡', chalet: '🏡', aerodrome: '✈️', airport: '✈️', terminal: '✈️', station: '🚆', halt: '🚆',
  train_station: '🚆', bus_station: '🚌', bus_stop: '🚌', restaurant: '🍽️', cafe: '☕', bar: '🍸', pub: '🍺',
  fast_food: '🍔', beach: '🏖️', park: '🌳', nature_reserve: '🌳', national_park: '🌳', wood: '🌳', forest: '🌳',
  spring: '💧', water: '🌊', peak: '⛰️', viewpoint: '👀', attraction: '🎡', museum: '🏛️', parking: '🅿️',
  fuel: '⛽', mall: '🛍️', supermarket: '🛒', city: '🏙️', town: '🏘️', village: '🏘️', hamlet: '🏘️',
};

/** Emoji for an OSM kind (osm_value / Nominatim type). */
export function placeEmoji(kind) {
  return KIND_EMOJI[String(kind || '')] || '📍';
}

function cleanText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function num(v) {
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** True when {lat, lon} are usable coordinates (in range, not the 0,0 "null island"). */
export function hasCoords(p) {
  if (!p) return false;
  const lat = num(p.lat);
  const lon = num(p.lon);
  if (lat === null || lon === null) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  return !(lat === 0 && lon === 0);
}

function nearOf(near) {
  return hasCoords(near) ? { lat: +num(near.lat).toFixed(4), lon: +num(near.lon).toFixed(4) } : null;
}

/**
 * Photon autocomplete URL. Domestic: no `lang` (Photon answers with local Hebrew names; `lang=he` is a 400)
 * + the Israel bbox + a bias point. Abroad: `lang=en` + the trip's coordinates as bias when known.
 */
export function placeQuery(text, { where = 'il', near = null } = {}) {
  const q = encodeURIComponent(cleanText(text));
  const bias = nearOf(near);
  if (where === 'abroad') {
    return `${PHOTON_URL}?q=${q}&limit=6&lang=en${bias ? `&lat=${bias.lat}&lon=${bias.lon}` : ''}`;
  }
  const c = bias || IL_CENTER;
  return `${PHOTON_URL}?q=${q}&limit=6&bbox=${IL_BBOX}&lat=${c.lat}&lon=${c.lon}`;
}

/** Nominatim search URL — explicit "full search" only (Enter / button), never per keystroke. */
export function nominatimQuery(text, { where = 'il' } = {}) {
  const q = encodeURIComponent(cleanText(text));
  return `${NOMINATIM_URL}?format=jsonv2&limit=5&addressdetails=1&q=${q}&accept-language=he,en${where === 'abroad' ? '' : '&countrycodes=il'}`;
}

const IL_NAMES = new Set(['ישראל', 'israel', 'il']);
function isIsrael(country, code) {
  return IL_NAMES.has(String(code || '').toLowerCase()) || IL_NAMES.has(String(country || '').trim().toLowerCase());
}

/**
 * "street housenumber · city (or county) · country≠Israel"; the region is added when there's no street. Never
 * empty: a place with nothing more to say (a country, a bare region) gets its own name, so a picked place always
 * has an address line (trip edit tells a pick from typed coordinates by it). placeLine / the UI hide it then.
 */
function addressLine({ name, street, housenumber, city, county, state, country, countrycode }) {
  const streetLine = cleanText([street, housenumber].filter(Boolean).join(' '));
  const locality = cleanText(city || county || '');
  const parts = [streetLine, locality];
  if (!streetLine) parts.push(cleanText(state));
  if (!isIsrael(country, countrycode)) parts.push(cleanText(country));
  const out = [];
  for (const p of parts) if (p && p !== cleanText(name) && !out.includes(p)) out.push(p);
  return out.join(' · ') || cleanText(name);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((p) => {
    const k = `${p.name}|${p.address}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Photon GeoJSON → [{name, address, lat, lon, osm: 'N:123', kind}]. Unusable features are dropped. */
export function parsePhoton(json) {
  const features = json && Array.isArray(json.features) ? json.features : [];
  const out = [];
  for (const f of features) {
    const pr = (f && f.properties) || {};
    const coords = f && f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : [];
    const lat = num(coords[1]);
    const lon = num(coords[0]);
    const name = cleanText(pr.name || [pr.street, pr.housenumber].filter(Boolean).join(' ') || pr.city || pr.county || pr.state);
    if (!name || !hasCoords({ lat, lon })) continue;
    out.push({
      name,
      address: addressLine({ ...pr, name }),
      lat,
      lon,
      osm: pr.osm_type && pr.osm_id != null ? `${String(pr.osm_type).charAt(0).toUpperCase()}:${pr.osm_id}` : null,
      kind: pr.osm_value || pr.type || null,
    });
  }
  return dedupe(out);
}

/** Nominatim jsonv2 (addressdetails=1) → the same shape as parsePhoton. */
export function parseNominatim(json) {
  const rows = Array.isArray(json) ? json : [];
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    const a = r.address || {};
    const lat = num(r.lat);
    const lon = num(r.lon);
    const name = cleanText(r.name || String(r.display_name || '').split(',')[0]);
    if (!name || !hasCoords({ lat, lon })) continue;
    out.push({
      name,
      address: addressLine({
        name,
        street: a.road || a.pedestrian || a.footway,
        housenumber: a.house_number,
        city: a.city || a.town || a.village || a.hamlet || a.suburb,
        county: a.county,
        state: a.state,
        country: a.country,
        countrycode: a.country_code,
      }),
      lat,
      lon,
      osm: r.osm_type && r.osm_id != null ? `${String(r.osm_type).charAt(0).toUpperCase()}:${r.osm_id}` : null,
      kind: r.type || r.category || null,
    });
  }
  return dedupe(out);
}

/** "חניון האלות · עמק הירדן" — name and address on one line. */
export function placeLine(p) {
  if (!p) return '';
  const parts = [];
  for (const x of [cleanText(p.name || p.location), cleanText(p.address)]) if (x && !parts.includes(x)) parts.push(x);
  return parts.join(' · ');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Waze / Google Maps links: coordinates first, else the text (same URLs as the trip screen).
 * Accepts a place ({name, address, lat, lon}) or a trip ({location, lat, lon, location_url}); a trip's own
 * link overrides Waze/Maps by host, any other link comes back as `site`.
 */
export function navLinks(place) {
  const p = place || {};
  let waze = null;
  let maps = null;
  let site = null;
  if (hasCoords(p)) {
    const ll = `${num(p.lat)},${num(p.lon)}`;
    waze = `https://waze.com/ul?ll=${ll}&navigate=yes`;
    maps = `https://www.google.com/maps/search/?api=1&query=${ll}`;
  } else {
    const name = cleanText(p.name || p.location || p.text);
    const addr = cleanText(p.address).replace(/\s*·\s*/g, ', ');
    const q = [name, addr].filter(Boolean).join(', ');
    if (q) {
      waze = `https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`;
      maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
    }
  }
  const own = /^https?:\/\/\S+$/i.test(p.location_url || '') ? p.location_url : null;
  if (own) {
    const host = hostOf(own);
    if (/(^|\.)waze\.com$/.test(host)) waze = own;
    else if (/(^|\.)google\.[a-z.]+$/.test(host) || /(^|\.)goo\.gl$/.test(host)) maps = own;
    else site = own;
  }
  return { waze, maps, site };
}

// ---------------------------------------------------------------------------
// Fixture provider (demo + tests): ~16 places, no network.
// ---------------------------------------------------------------------------

export const FIXTURE_PLACES = [
  { where: 'il', name: 'חניון האלות', address: 'עמק הירדן · מחוז הצפון', lat: 32.8115, lon: 35.6402, osm: 'N:9000001', kind: 'camp_site', tags: 'כנרת כינרת kinneret' },
  { where: 'il', name: 'חוף צאלון', address: 'עמק הירדן · מחוז הצפון', lat: 32.8697, lon: 35.6307, osm: 'W:9000002', kind: 'camp_site', tags: 'כנרת כינרת חניון' },
  { where: 'il', name: 'חוף גופרה', address: 'עמק הירדן · מחוז הצפון', lat: 32.8431, lon: 35.6433, osm: 'W:9000003', kind: 'camp_site', tags: 'כנרת כינרת חניון' },
  { where: 'il', name: 'חוף דוגית', address: 'עמק הירדן · מחוז הצפון', lat: 32.8631, lon: 35.6366, osm: 'W:9000004', kind: 'beach', tags: 'כנרת כינרת חניון' },
  { where: 'il', name: 'חניון יום עין שחל', address: 'עמק הירדן', lat: 32.8003, lon: 35.6189, osm: 'N:9000005', kind: 'picnic_site', tags: 'כנרת כינרת' },
  { where: 'il', name: 'טבריה', address: 'מחוז הצפון', lat: 32.7922, lon: 35.5312, osm: 'R:9000006', kind: 'city', tags: 'tiberias כנרת' },
  { where: 'il', name: 'מסעדת הדייגים', address: 'הטיילת 3 · טבריה', lat: 32.7897, lon: 35.5418, osm: 'N:9000007', kind: 'restaurant', tags: 'מסעדה כנרת' },
  { where: 'il', name: 'נמל התעופה בן גוריון', address: 'לוד · מחוז המרכז', lat: 32.0114, lon: 34.8867, osm: 'W:9000008', kind: 'aerodrome', tags: 'נתב"ג נתבג נתב״ג שדה תעופה TLV ben gurion airport' },
  { where: 'il', name: 'נמל התעופה רמון', address: 'אילת · מחוז הדרום', lat: 29.7236, lon: 35.0114, osm: 'W:9000009', kind: 'aerodrome', tags: 'שדה תעופה ETM ramon airport' },
  { where: 'il', name: 'נמל התעופה חיפה', address: 'חיפה · מחוז חיפה', lat: 32.8094, lon: 35.0431, osm: 'W:9000010', kind: 'aerodrome', tags: 'שדה תעופה HFA haifa airport' },
  { where: 'il', name: 'תחנת רכבת תל אביב - סבידור מרכז', address: 'תל אביב-יפו · מחוז תל אביב', lat: 32.0838, lon: 34.7982, osm: 'N:9000011', kind: 'station', tags: 'רכבת סבידור ארלוזורוב train' },
  { where: 'il', name: 'תחנת רכבת חיפה - חוף הכרמל', address: 'חיפה · מחוז חיפה', lat: 32.7934, lon: 34.9570, osm: 'N:9000012', kind: 'station', tags: 'רכבת train' },
  { where: 'abroad', name: 'Bucharest', address: 'Romania', lat: 44.4361, lon: 26.1027, osm: 'R:9000013', kind: 'city', tags: 'bucuresti bucurești בוקרשט' },
  { where: 'abroad', name: 'Hotel Lipscani Central', address: 'Strada Lipscani 12 · Bucharest · Romania', lat: 44.4318, lon: 26.1006, osm: 'N:9000014', kind: 'hotel', tags: 'bucharest בוקרשט מלון' },
  { where: 'abroad', name: 'Henri Coandă International Airport', address: 'Otopeni · Romania', lat: 44.5711, lon: 26.0850, osm: 'W:9000015', kind: 'aerodrome', tags: 'OTP bucharest airport בוקרשט' },
  { where: 'abroad', name: 'London Heathrow Airport', address: 'London · United Kingdom', lat: 51.4700, lon: -0.4543, osm: 'W:9000016', kind: 'aerodrome', tags: 'LHR london airport לונדון' },
];

function fold(s) {
  return String(s || '').toLowerCase().replace(/["'״׳`\-–]/g, '').replace(/\s+/g, ' ').trim();
}

/** Deterministic in-memory provider: every query word must appear in the name / address / tags. */
export function fixtureProvider(text, { where = 'il' } = {}) {
  const words = fold(text).split(' ').filter(Boolean);
  if (!words.length) return Promise.resolve([]);
  const list = FIXTURE_PLACES
    .filter((p) => (where === 'abroad' ? p.where === 'abroad' : p.where === 'il'))
    .filter((p) => {
      const hay = fold(`${p.name} ${p.address} ${p.tags}`);
      return words.every((w) => hay.includes(w));
    })
    .slice(0, 6)
    .map(({ name, address, lat, lon, osm, kind }) => ({ name, address, lat, lon, osm, kind }));
  return Promise.resolve(list);
}

let providerOverride;

/**
 * Replace the network with `fn(text, {where, near, mode, signal}) → Promise<list>` (tests / demo).
 * `setPlaceProvider(null)` forces the network; `setPlaceProvider(undefined)` restores auto-detection.
 */
export function setPlaceProvider(fn) {
  providerOverride = fn;
}

function pageSearch() {
  try {
    return new URLSearchParams(globalThis.location ? globalThis.location.search : '');
  } catch {
    return new URLSearchParams('');
  }
}

/** Demo pages (?demo=1 or no backend configured) use the fixture unless ?osm=1. */
export function isFixtureMode() {
  const qs = pageSearch();
  if (qs.get('osm') === '1') return false;
  if (qs.get('demo') === '1') return true;
  const cfg = globalThis.MEDURA_CONFIG;
  return !(cfg && typeof cfg.supabaseUrl === 'string' && cfg.supabaseUrl.trim());
}

function defaultStorage() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

/**
 * Debounced, throttled place searcher.
 *   search(text, {where, near}) → Promise<list | null>   Photon; null = superseded by a newer call / cancelled
 *   full(text, {where, near})   → Promise<list | null>   Nominatim, no debounce (explicit Enter / button)
 *   cancel()
 * One request in flight (the older one is aborted), ≥ minGapMs between request starts (only the latest text
 * waits), LRU cache (60) + sessionStorage (1 day). Network errors resolve to [] — free text always works.
 */
export function createSearcher({
  fetch: fetchFn,
  now = () => Date.now(),
  minGapMs = 1000,
  debounceMs = 450,
  minChars = 2,
  where: defWhere = 'il',
  near: defNear = null,
  provider,
  storage = defaultStorage(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  const lru = new Map();
  let pending = null; // {q, o, key, resolve, timer}
  let inflight = null; // {ctrl, resolve}
  let lastStart = -Infinity;

  function source() {
    if (provider) return { fn: provider, tag: 'p' };
    if (providerOverride) return { fn: providerOverride, tag: 'p' };
    if (fetchFn || providerOverride === null) return { fn: null, tag: 'osm' };
    return isFixtureMode() ? { fn: fixtureProvider, tag: 'fx' } : { fn: null, tag: 'osm' };
  }

  function cacheGet(key) {
    if (lru.has(key)) {
      const v = lru.get(key);
      lru.delete(key);
      lru.set(key, v);
      return v;
    }
    if (!storage) return null;
    try {
      const raw = storage.getItem(STORAGE_PREFIX + key);
      if (!raw) return null;
      const { t, list } = JSON.parse(raw);
      if (!Array.isArray(list) || !(now() - t < STORAGE_TTL_MS)) return null;
      lru.set(key, list);
      return list;
    } catch {
      return null;
    }
  }

  function cacheSet(key, list) {
    lru.delete(key);
    lru.set(key, list);
    while (lru.size > CACHE_SIZE) lru.delete(lru.keys().next().value);
    if (!storage) return;
    try {
      storage.setItem(STORAGE_PREFIX + key, JSON.stringify({ t: now(), list }));
    } catch {
      /* quota / blocked */
    }
  }

  function dropPending() {
    if (!pending) return;
    clearTimer(pending.timer);
    pending.resolve(null);
    pending = null;
  }

  function abortInflight() {
    if (!inflight) return;
    const { ctrl, resolve } = inflight;
    inflight = null;
    try {
      ctrl.abort();
    } catch {
      /* ignore */
    }
    resolve(null);
  }

  function cancel() {
    dropPending();
    abortInflight();
  }

  function request(p, signal) {
    const src = source();
    const opts = { where: p.o.where, near: p.o.near, mode: p.o.mode, signal };
    if (src.fn) return Promise.resolve().then(() => src.fn(p.q, opts));
    const url = p.o.mode === 'nominatim' ? nominatimQuery(p.q, opts) : placeQuery(p.q, opts);
    const f = fetchFn || ((...a) => globalThis.fetch(...a));
    return f(url, { signal, headers: { Accept: 'application/json' } })
      .then((r) => {
        if (!r || !r.ok) throw new Error(`http ${r ? r.status : '?'}`);
        return r.json();
      })
      .then((json) => (p.o.mode === 'nominatim' ? parseNominatim(json) : parsePhoton(json)));
  }

  function fire() {
    const p = pending;
    if (!p) return;
    const wait = lastStart + minGapMs - now();
    if (wait > 0) {
      p.timer = setTimer(fire, wait);
      return;
    }
    pending = null;
    abortInflight();
    lastStart = now();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : { signal: undefined, abort() {} };
    const mine = { ctrl, resolve: p.resolve };
    inflight = mine;
    request(p, ctrl.signal).then(
      (list) => {
        const aborted = inflight !== mine;
        if (!aborted) inflight = null;
        if (aborted) return p.resolve(null);
        const clean = Array.isArray(list) ? list.slice(0, 8) : [];
        cacheSet(p.key, clean);
        p.resolve(clean);
      },
      () => {
        const aborted = inflight !== mine;
        if (!aborted) inflight = null;
        p.resolve(aborted ? null : []);
      },
    );
  }

  function start(text, opts, mode, delay) {
    dropPending();
    const q = cleanText(text);
    const o = { where: defWhere, near: defNear, ...(opts || {}), mode };
    if (q.length < minChars) {
      abortInflight();
      return Promise.resolve([]);
    }
    const bias = nearOf(o.near);
    const key = `${source().tag}|${mode}|${o.where === 'abroad' ? 'abroad' : 'il'}|${bias ? `${bias.lat},${bias.lon}` : ''}|${q.toLowerCase()}`;
    const hit = cacheGet(key);
    if (hit) {
      abortInflight();
      return Promise.resolve(hit);
    }
    return new Promise((resolve) => {
      pending = { q, o, key, resolve, timer: null };
      pending.timer = setTimer(fire, delay);
    });
  }

  return {
    search: (text, opts) => start(text, opts, 'photon', debounceMs),
    full: (text, opts) => start(text, opts, 'nominatim', 0),
    cancel,
  };
}
