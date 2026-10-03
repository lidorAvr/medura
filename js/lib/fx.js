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
      return Number.isFinite(v) && v > 0 ? v : null;
    })
    .catch(() => null);
  cache.set(key, p);
  const v = await p;
  if (v == null) cache.delete(key); // try again next time
  return v;
}

/** `amount` in `code` → ₪, rounded to agorot. */
export const toShekels = (amount, rate) => Math.round(Number(amount) * Number(rate) * 100) / 100;
