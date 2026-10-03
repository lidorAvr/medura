// Exchange rates to ₪ by date (ECB reference rates via Frankfurter — free, no key, CORS open).
// Weekends/holidays get the last business day's rate. Cached per currency × day for the session.

export const CURRENCIES = [
  { code: 'EUR', symbol: '€', label: 'אירו' },
  { code: 'USD', symbol: '$', label: 'דולר' },
  { code: 'GBP', symbol: '£', label: 'לירה שטרלינג' },
  { code: 'CHF', symbol: 'CHF', label: 'פרנק שוויצרי' },
  { code: 'CZK', symbol: 'Kč', label: 'קורונה צ׳כית' },
  { code: 'HUF', symbol: 'Ft', label: 'פורינט' },
  { code: 'PLN', symbol: 'zł', label: 'זלוטי' },
  { code: 'RON', symbol: 'lei', label: 'לאו' },
  { code: 'TRY', symbol: '₺', label: 'לירה טורקית' },
  { code: 'THB', symbol: '฿', label: 'באט' },
  { code: 'JPY', symbol: '¥', label: 'ין' },
];

export const symbolOf = (code) => (!code || code === 'ILS' ? '₪' : CURRENCIES.find((c) => c.code === code)?.symbol || code);

const cache = new Map();
const known = new Map(); // `${code}@${day}` → rate, for what already came back (render-time reads)

const RATE_TIMEOUT_MS = 8000;

/** ₪ per 1 unit of `code` on `ymd` ('YYYY-MM-DD'; future/empty → latest). Resolves null when unavailable
 *  (also when the answer takes more than RATE_TIMEOUT_MS). */
export async function rateOn(code, ymd) {
  if (!code || code === 'ILS') return 1;
  const today = new Date().toISOString().slice(0, 10);
  const day = ymd && ymd <= today ? ymd : 'latest';
  const key = `${code}@${day}`;
  if (cache.has(key)) return cache.get(key);
  // never left hanging: on a connection that stalls, the form says "type the rate" after a few seconds
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(RATE_TIMEOUT_MS) : undefined;
  const p = fetch(`https://api.frankfurter.dev/v1/${day}?base=${encodeURIComponent(code)}&symbols=ILS`, { signal })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const v = Number(j?.rates?.ILS);
      if (Number.isFinite(v) && v > 0) known.set(key, v);
      return Number.isFinite(v) && v > 0 ? v : null;
    })
    .catch(() => null);
  cache.set(key, p);
  const v = await p;
  if (v == null) cache.delete(key); // try again next time
  return v;
}

const RANGE_MAX_DAYS = 90; // Frankfurter answers longer ranges with weekly rates only
const ymdShift = (ymd, days) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/**
 * Warms the rate cache for many days at once with ONE time-series request (the money screen shows a "≈ €" per row —
 * a request per day would be dozens). `days` are 'YYYY-MM-DD' (a '' / future day means today's latest rate). Every day
 * gets the rate of the last business day on or before it (weekends / holidays), like rateOn. Fails quietly: a day
 * without a rate just shows ₪ only. A span longer than 90 days falls back to single requests (the 12 latest days).
 */
export async function prefetchRates(code, days) {
  if (!code || code === 'ILS') return;
  const today = new Date().toISOString().slice(0, 10);
  const dated = [...new Set(days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today))].sort();
  const from = ymdShift(dated[0] || today, -6);                  // a weekend start needs the business day before it
  if (ymdShift(from, RANGE_MAX_DAYS) < today) {
    await Promise.all([...dated.slice(-12), ''].map((d) => rateOn(code, d || undefined)));
    return;
  }
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(RATE_TIMEOUT_MS) : undefined;
  const rows = await fetch(`https://api.frankfurter.dev/v1/${from}..${today}?base=${encodeURIComponent(code)}&symbols=ILS`, { signal })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => Object.entries(j?.rates || {})
      .map(([d, v]) => [d, Number(v?.ILS)])
      .filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(v) && v > 0)
      .sort((a, b) => a[0].localeCompare(b[0])))
    .catch(() => []);
  if (!rows.length) return;
  const set = (day, v) => {
    known.set(`${code}@${day}`, v);
    cache.set(`${code}@${day}`, Promise.resolve(v));
  };
  const onOrBefore = (d) => rows.filter(([x]) => x <= d).pop()?.[1];
  for (const d of dated) {
    const v = onOrBefore(d);
    if (v) set(d, v);
  }
  set('latest', rows[rows.length - 1][1]);
}

/** `amount` in `code` → ₪, rounded to agorot. */
export const toShekels = (amount, rate) => Math.round(Number(amount) * Number(rate) * 100) / 100;

// ---- dual-currency display (SPEC §8.7b): "≈ €12" next to a ₪ amount, at the rate of the transaction's own day ----

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });

/** 'YYYY-MM-DD' (Asia/Jerusalem) of a timestamp or a date string; null when it isn't one. */
export function dayOf(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = v ? new Date(v) : null;
  return t && !Number.isNaN(t.getTime()) ? dayFmt.format(t) : null;
}

/** The rate that came back for `code` on `ymd` (future/empty → latest), undefined while it hasn't. Never fetches. */
export function knownRate(code, ymd) {
  if (!code || code === 'ILS') return 1;
  const today = new Date().toISOString().slice(0, 10);
  return known.get(`${code}@${ymd && ymd <= today ? ymd : 'latest'}`);
}

/** The trip's one relevant foreign currency (first of settings.money.currencies that isn't ₪), else null. */
export function foreignCurrencies(trip) {
  const list = trip?.settings?.money?.currencies;
  return Array.isArray(list) ? [...new Set(list.filter((c) => typeof c === 'string' && /^[A-Z]{3}$/.test(c) && c !== 'ILS'))] : [];
}
export const foreignCurrency = (trip) => foreignCurrencies(trip)[0] || null;

/** `ils` shown in `code` at `rate` (₪ per unit): rounded to 2 decimals, null without a usable rate. */
export function inForeign(ils, rate) {
  const n = Number(ils);
  const r = Number(rate);
  return Number.isFinite(n) && Number.isFinite(r) && r > 0 ? Math.round((n / r) * 100) / 100 : null;
}

/**
 * What an expense is in `code` (the "≈ €X" next to its ₪ amount): its own sum when it was entered in that currency
 * (exact — the rate it was saved with), else its ₪ amount at `rate` (the rate of its day); null with neither.
 */
export function expenseInForeign(exp, code, rate) {
  if (!exp || !code) return null;
  if (exp.currency === code && Number(exp.orig_amount) > 0) return Number(exp.orig_amount);
  return inForeign(exp.amount, rate);
}

/** "≈ €12" / "≈ 480 lei" — whole units from 100 up, else two decimals at most. */
export function formatForeign(amount, code) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  const sym = symbolOf(code);
  const num = n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2 });
  return sym.length > 1 ? `≈ ${num} ${sym}` : `≈ ${sym}${num}`;
}

/** The display modes of the money header: ₪ only, or ₪ + one of the trip's foreign currencies. */
export const fxModes = (trip) => ['ILS', ...foreignCurrencies(trip).slice(0, 3)];

/** The mode in force: the device's own choice when it is still on offer, else the first foreign currency (₪ alone
 *  when the trip has none). `stored` is what localStorage held ('ILS' = ₪ only). */
export function fxModeOf(trip, stored) {
  const modes = fxModes(trip);
  if (stored && modes.includes(stored)) return stored;
  return modes[1] || 'ILS';
}

const FX_KEY = 'medura.fx';
export function loadFxMode() {
  try {
    return localStorage.getItem(FX_KEY);
  } catch {
    return null;
  }
}
export function saveFxMode(v) {
  try {
    localStorage.setItem(FX_KEY, v);
  } catch { /* private window / blocked storage: the choice just doesn't stick */ }
}
