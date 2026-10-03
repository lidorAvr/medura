// API factory (SPEC §7.2): picks the Supabase backend or the in-browser demo backend.
// Demo mode when config.js has no supabaseUrl, or when the page URL has ?demo=1.

/**
 * True when the app should run against the demo backend.
 * @param {{supabaseUrl?: string}} [config]
 * @param {string} [search] a location.search string
 */
export function isDemoMode(config, search) {
  const url = config && typeof config.supabaseUrl === 'string' ? config.supabaseUrl.trim() : '';
  let demoParam = null;
  try {
    demoParam = new URLSearchParams(search || '').get('demo');
  } catch {
    demoParam = null;
  }
  return !url || demoParam === '1';
}

/**
 * Create the API for this page. Call `await api.init()` and `await api.ensureSession()` next.
 * Options exist for tests only; the app calls `createApi()` with no arguments.
 * @param {{config?: object, search?: string}} [opts]
 */
export async function createApi(opts = {}) {
  const config = opts.config ?? globalThis.MEDURA_CONFIG ?? {};
  const search = opts.search ?? (globalThis.location ? globalThis.location.search : '');
  if (isDemoMode(config, search)) {
    const { createDemoApi } = await import('./demo-api.js?v=8d87c37');
    return createDemoApi();
  }
  const { createSupabaseApi } = await import('./supabase-api.js?v=8d87c37');
  const siteKey = String(config.turnstileSiteKey || '').trim();
  const getCaptchaToken = siteKey
    ? () => import('../lib/turnstile.js?v=8d87c37').then((m) => m.turnstileToken(siteKey))
    : null;
  return createSupabaseApi({ url: config.supabaseUrl.trim(), anonKey: config.supabaseAnonKey, getCaptchaToken });
}
