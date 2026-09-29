// Error model shared by both API implementations (SPEC §3 "Errors", §7.2).
// Every API method rejects with an ApiError whose `code` is one of ERROR_CODES.

/** Codes raised by the RPCs (SPEC §3) plus the two client-side codes. */
export const ERROR_CODES = Object.freeze([
  'not_authenticated',
  'forbidden',
  'not_found',
  'invalid_input',
  'invalid_code',
  'already_claimed',
  'email_not_verified',
  'needs_approval',
  'already_settled',
  'already_member',
  'last_admin',
  'owner_locked',
  'has_money_records',
  'limit_reached',
  'not_allowed_state',
  'rate_limited',
  'code_expired',
  'ride_full',
  'network',
  'unknown',
]);

const HEBREW = Object.freeze({
  not_authenticated: 'החיבור פג — רעננו את הדף ונמשיך 🔄',
  forbidden: 'אין לך הרשאה לפעולה הזו 🙅',
  not_found: 'לא מצאנו את זה — אולי זה כבר נמחק?',
  invalid_input: 'משהו בפרטים לא תקין — בדקו ונסו שוב ✏️',
  invalid_code: 'הקוד או הקישור לא תקינים — בדקו שהעתקתם את כולו 🔗',
  already_claimed: 'מישהו כבר נכנס לפרופיל הזה 🙃',
  email_not_verified: 'קודם מאמתים את המייל — שולחים קוד ומקלידים 🔐',
  needs_approval: 'לפרופיל הזה נכנסים באישור של מי שכבר בפנים — שולחים בקשה 🤝',
  already_settled: 'החשבון שלך כבר מאוזן — אין מה להעביר 🙂',
  already_member: 'את/ה כבר חלק מהטיול הזה 🙂',
  last_admin: 'חייב להישאר לפחות מנהל/ת אחד/ת בטיול 👑',
  owner_locked: 'אי אפשר לשנות או להסיר את יוצר/ת הטיול 👑',
  has_money_records: 'יש כאן הוצאות או העברות על השם הזה — קודם מוחקים אותן 💸',
  limit_reached: 'הגעתם למגבלה — אי אפשר להוסיף עוד 📦',
  not_allowed_state: 'אי אפשר לעשות את זה כרגע — אולי זה כבר עודכן? רעננו ונסו שוב 🔄',
  rate_limited: 'יותר מדי ניסיונות — נסו שוב בעוד כמה דקות ⏳',
  code_expired: 'הקוד פג או נוצל — שלחו קוד חדש 🔁',
  ride_full: 'אין מספיק מקומות ברכב הזה 🚗',
  network: 'אין חיבור לאינטרנט — נסו שוב כשהרשת תחזור 📶',
  unknown: 'אופס, משהו השתבש. נסו שוב 🙏',
});

/** Friendly Hebrew text for an error code (falls back to the 'unknown' text). */
export function hebrewError(code) {
  return Object.prototype.hasOwnProperty.call(HEBREW, code) ? HEBREW[code] : HEBREW.unknown;
}

export class ApiError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} [message] defaults to the Hebrew text for the code
   */
  constructor(code, message) {
    const known = ERROR_CODES.includes(code) ? code : 'unknown';
    super(message || hebrewError(known));
    this.name = 'ApiError';
    this.code = known;
  }
}

// RPC codes only (never match 'network'/'unknown' inside server text).
// Longest first so a longer code wins if a message ever mentions two.
const SERVER_CODES = ERROR_CODES.filter((c) => c !== 'network' && c !== 'unknown')
  .sort((a, b) => b.length - a.length);

const NETWORK_RE = /failed to fetch|networkerror|network request failed|network error|load failed|fetch failed|err_internet|err_network|err_connection|timed? ?out|econnrefused|enotfound/i;
const AUTH_RE = /jwt|not authenticated|auth session missing|invalid refresh token|refresh token not found/i;

function textOf(v) {
  return typeof v === 'string' ? v : '';
}

function findServerCode(texts) {
  // Exact match first (the normal case: `raise exception 'forbidden'`).
  for (const t of texts) {
    const s = t.trim();
    if (SERVER_CODES.includes(s)) return s;
  }
  for (const t of texts) {
    for (const code of SERVER_CODES) {
      if (new RegExp(`(^|[^a-z_])${code}([^a-z_]|$)`).test(t)) return code;
    }
  }
  return null;
}

/**
 * Normalize anything thrown/returned by supabase-js, fetch or our own code into an ApiError.
 * - PostgREST/Postgres errors: `message` equals (or contains) one of the §3 codes.
 * - fetch/transport failures → 'network'.
 */
export function toApiError(err) {
  if (err instanceof ApiError) return err;
  if (err == null) return new ApiError('unknown');
  if (typeof err === 'string') {
    const code = findServerCode([err]);
    return withDetail(new ApiError(code || (NETWORK_RE.test(err) ? 'network' : 'unknown')), err);
  }

  const message = textOf(err.message) || textOf(err.error_description) || textOf(err.msg) || textOf(err.error);
  const texts = [message, textOf(err.details), textOf(err.hint)].filter(Boolean);
  const pgCode = textOf(err.code);
  const name = textOf(err.name);

  const serverCode = findServerCode(texts);
  if (serverCode) return withDetail(new ApiError(serverCode), message);

  const isNetwork =
    name === 'AuthRetryableFetchError' ||
    name === 'FetchError' ||
    name === 'NetworkError' ||
    name === 'AbortError' ||
    (name === 'TypeError' && NETWORK_RE.test(message)) ||
    (err.status === 0 && !pgCode) ||
    NETWORK_RE.test(message) ||
    (typeof navigator !== 'undefined' && navigator.onLine === false);
  if (isNetwork) return withDetail(new ApiError('network'), message);

  // Calling a function that is granted to `authenticated` only, while signed out.
  if (pgCode === '42501' || pgCode === 'PGRST301' || err.status === 401 || AUTH_RE.test(message)) {
    return withDetail(new ApiError('not_authenticated'), message);
  }
  // Postgres data/constraint errors (22xxx data exception, 23xxx integrity violation).
  if (/^2[23][0-9A-Z]{3}$/.test(pgCode)) return withDetail(new ApiError('invalid_input'), message);

  return withDetail(new ApiError('unknown'), message);
}

function withDetail(apiErr, detail) {
  if (detail) apiErr.detail = detail;
  return apiErr;
}
