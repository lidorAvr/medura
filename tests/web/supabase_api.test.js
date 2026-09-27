// Contract tests for js/api/supabase-api.js (SPEC §4, §7.2) using a fake supabase client that
// records every rpc() call, plus js/api/errors.js and js/api/index.js mode selection.

import { createSupabaseApi } from '../../js/api/supabase-api.js';
import { createDemoApi } from '../../js/api/demo-api.js';
import { ApiError, ERROR_CODES, hebrewError, toApiError } from '../../js/api/errors.js';
import { createApi, isDemoMode } from '../../js/api/index.js';

// ---------- tiny harness ----------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

class AssertionError extends Error {}
const show = (v) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};
function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new AssertionError(msg);
}
function eq(actual, expected, msg = 'eq') {
  if (actual !== expected) throw new AssertionError(`${msg}: expected ${show(expected)}, got ${show(actual)}`);
}
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
function deepEq(actual, expected, msg = 'deepEq') {
  const a = show(canon(actual));
  const b = show(canon(expected));
  if (a !== b) throw new AssertionError(`${msg}: expected ${b}, got ${a}`);
}
async function rejects(promise, code, msg = 'rejects') {
  try {
    await promise;
  } catch (e) {
    if (!(e instanceof ApiError)) throw new AssertionError(`${msg}: expected ApiError(${code}), got ${e && e.stack}`);
    eq(e.code, code, msg);
    return e;
  }
  throw new AssertionError(`${msg}: expected rejection with '${code}'`);
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
    } catch (e) {
      failed++;
      failures.push({ name: t.name, error: String((e && e.stack) || e) });
    }
  }
  return { passed, failed, failures };
}

// ---------- fake supabase client ----------

function fakeClient({ session = null, anonUser = { id: 'anon-user-1' } } = {}) {
  let current = session;
  const client = {
    calls: [],
    channels: [],
    removed: [],
    authCallback: null,
    rpcImpl: async () => ({ data: null, error: null }),
    rpc(name, params) {
      client.calls.push({ name, params: JSON.parse(JSON.stringify(params === undefined ? '__undefined__' : params)) });
      return client.rpcImpl(name, params);
    },
    auth: {
      getSessionCalls: 0,
      signInCalls: 0,
      getSessionImpl: null,
      signInImpl: null,
      async getSession() {
        client.auth.getSessionCalls++;
        if (client.auth.getSessionImpl) return client.auth.getSessionImpl();
        return { data: { session: current }, error: null };
      },
      async signInAnonymously() {
        client.auth.signInCalls++;
        await tick(5);
        if (client.auth.signInImpl) return client.auth.signInImpl();
        current = { access_token: 'tok', user: anonUser };
        return { data: { user: anonUser, session: current }, error: null };
      },
      onAuthStateChange(cb) {
        client.authCallback = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
    channel(name) {
      const ch = {
        name,
        handlers: [],
        subscribed: false,
        on(type, filter, cb) {
          ch.handlers.push({ type, filter, cb });
          return ch;
        },
        subscribe(statusCb) {
          ch.subscribed = true;
          ch.statusCb = statusCb;
          return ch;
        },
      };
      client.channels.push(ch);
      return ch;
    },
    removeChannel(ch) {
      client.removed.push(ch);
      return Promise.resolve('ok');
    },
  };
  return client;
}

// ---------- the contract: every method → exact RPC name + exact §4 params ----------

const T = 'trip-1';
const M = 'member-1';
const I = 'item-1';

// [method, args, rpc name, exact params]
const CASES = [
  ['myTrips', [], 'my_trips', {}],
  ['createTrip', [{ name: 'פארק החבשושיות' }, { display_name: 'לידור' }], 'create_trip', { p_trip: { name: 'פארק החבשושיות' }, p_profile: { display_name: 'לידור' } }],
  ['previewInvite', ['abc234defg'], 'preview_invite', { p_code: 'abc234defg' }],
  ['previewInvite', [' ABC234DEFG '], 'preview_invite', { p_code: 'abc234defg' }],
  ['joinTrip', ['abc', { claimMemberId: M, profile: { phone: '050' } }], 'join_trip', { p_code: 'abc', p_claim_member: M, p_profile: { phone: '050' } }],
  ['joinTrip', ['abc', { profile: { display_name: 'x' } }], 'join_trip', { p_code: 'abc', p_claim_member: null, p_profile: { display_name: 'x' } }],
  ['joinTrip', ['abc'], 'join_trip', { p_code: 'abc', p_claim_member: null, p_profile: null }],
  ['linkDevice', ['dev234code'], 'link_device', { p_device_code: 'dev234code' }],
  ['getDeviceCode', [M], 'get_device_code', { p_member: M }],
  ['getSnapshot', [T], 'get_trip_snapshot', { p_trip: T }],
  ['updateTrip', [T, { name: 'n', settings: { require_approval: false } }], 'update_trip', { p_trip: T, p_patch: { name: 'n', settings: { require_approval: false } } }],
  ['rotateInvite', [T], 'rotate_invite', { p_trip: T }],
  ['updateMember', [M, { emoji: '🦊' }], 'update_member', { p_member: M, p_patch: { emoji: '🦊' } }],
  ['createMember', [T, { display_name: 'זיו' }], 'create_member', { p_trip: T, p_profile: { display_name: 'זיו' } }],
  ['setRole', [M, 'admin'], 'set_role', { p_member: M, p_role: 'admin' }],
  ['removeMember', [M], 'remove_member', { p_member: M }],
  ['leaveTrip', [T], 'leave_trip', { p_trip: T }],
  ['voteAdmin', [M, true], 'vote_admin', { p_candidate: M, p_on: true }],
  ['voteAdmin', [M, false], 'vote_admin', { p_candidate: M, p_on: false }],
  ['upsertCategory', [T, { name: 'צל' }], 'upsert_category', { p_trip: T, p_cat: { name: 'צל' } }],
  ['deleteCategory', ['cat-1'], 'delete_category', { p_category: 'cat-1' }],
  ['addItem', [T, { title: 'פחמים', pledge_qty: 1 }], 'add_item', { p_trip: T, p_item: { title: 'פחמים', pledge_qty: 1 } }],
  ['addItemsBulk', [T, [{ title: 'a', category_name: 'b' }]], 'add_items_bulk', { p_trip: T, p_items: [{ title: 'a', category_name: 'b' }] }],
  ['updateItem', [I, { qty: 2 }], 'update_item', { p_item: I, p_patch: { qty: 2 } }],
  ['reviewItem', [I, false, 'אין מקום'], 'review_item', { p_item: I, p_approve: false, p_reason: 'אין מקום' }],
  ['reviewItem', [I, true], 'review_item', { p_item: I, p_approve: true, p_reason: null }],
  ['deleteItem', [I], 'delete_item', { p_item: I }],
  ['pledge', [I, 3], 'pledge', { p_item: I, p_qty: 3 }],
  ['pledge', [I], 'pledge', { p_item: I, p_qty: 1 }],
  ['pledge', [I, 0], 'pledge', { p_item: I, p_qty: 0 }],
  ['assign', [I, M, 2], 'assign', { p_item: I, p_member: M, p_qty: 2 }],
  ['assign', [I, M], 'assign', { p_item: I, p_member: M, p_qty: 1 }],
  ['setPledgeDone', [I, true], 'set_pledge_done', { p_item: I, p_done: true }],
  ['setItemDone', [I, false], 'set_item_done', { p_item: I, p_done: false }],
  ['addPersonal', [T, 'מגבת'], 'add_personal', { p_trip: T, p_title: 'מגבת' }],
  ['addPersonalTemplate', [T], 'add_personal_template', { p_trip: T }],
  ['updatePersonal', ['p-1', { done: true }], 'update_personal', { p_id: 'p-1', p_patch: { done: true } }],
  ['deletePersonal', ['p-1'], 'delete_personal', { p_id: 'p-1' }],
  ['addExpense', [T, { title: 'סופר', amount: 10 }], 'add_expense', { p_trip: T, p_exp: { title: 'סופר', amount: 10 } }],
  ['updateExpense', ['e-1', { amount: 12 }], 'update_expense', { p_expense: 'e-1', p_patch: { amount: 12 } }],
  ['deleteExpense', ['e-1'], 'delete_expense', { p_expense: 'e-1' }],
  ['addPayment', [T, { to_member: M, amount: 5 }], 'add_payment', { p_trip: T, p_pay: { to_member: M, amount: 5 } }],
  ['confirmPayment', ['pay-1'], 'confirm_payment', { p_payment: 'pay-1' }],
  ['deletePayment', ['pay-1'], 'delete_payment', { p_payment: 'pay-1' }],
  ['sendAnnouncement', [T, { title: 't', body: 'b', audience: [M], urgent: true }], 'send_announcement', { p_trip: T, p_title: 't', p_body: 'b', p_audience: [M], p_urgent: true }],
  ['sendAnnouncement', [T, { title: 't' }], 'send_announcement', { p_trip: T, p_title: 't', p_body: null, p_audience: null, p_urgent: false }],
  ['sendAnnouncement', [T, { title: 't', audience: [] }], 'send_announcement', { p_trip: T, p_title: 't', p_body: null, p_audience: null, p_urgent: false }],
  ['deleteNotification', ['n-1'], 'delete_notification', { p_notification: 'n-1' }],
  ['markRead', [T, ['n-1', 'n-2']], 'mark_read', { p_trip: T, p_ids: ['n-1', 'n-2'] }],
  ['createPoll', [T, { question: 'q', options: ['a', 'b'], multi: true }], 'create_poll', { p_trip: T, p_question: 'q', p_options: ['a', 'b'], p_multi: true }],
  ['createPoll', [T, { question: 'q', options: ['a', 'b'] }], 'create_poll', { p_trip: T, p_question: 'q', p_options: ['a', 'b'], p_multi: false }],
  ['votePoll', ['poll-1', ['o1']], 'vote_poll', { p_poll: 'poll-1', p_option_ids: ['o1'] }],
  ['votePoll', ['poll-1', []], 'vote_poll', { p_poll: 'poll-1', p_option_ids: [] }],
  ['closePoll', ['poll-1', true], 'close_poll', { p_poll: 'poll-1', p_closed: true }],
  ['closePoll', ['poll-1', false], 'close_poll', { p_poll: 'poll-1', p_closed: false }],
  ['deletePoll', ['poll-1'], 'delete_poll', { p_poll: 'poll-1' }],
  ['savePushSubscription', [T, { endpoint: 'https://push.test/x', keys: { p256dh: 'k', auth: 'a' } }], 'save_push_subscription', { p_trip: T, p_sub: { endpoint: 'https://push.test/x', keys: { p256dh: 'k', auth: 'a' } } }],
  ['savePushSubscription', [T, { toJSON: () => ({ endpoint: 'https://push.test/y', keys: { p256dh: 'k2', auth: 'a2' } }) }], 'save_push_subscription', { p_trip: T, p_sub: { endpoint: 'https://push.test/y', keys: { p256dh: 'k2', auth: 'a2' } } }],
  ['deletePushSubscription', ['https://push.test/x'], 'delete_push_subscription', { p_endpoint: 'https://push.test/x' }],
];

// SPEC §4 — all 45 RPC names.
const SPEC_RPCS = [
  'my_trips', 'create_trip', 'preview_invite', 'join_trip', 'link_device', 'get_device_code', 'get_trip_snapshot',
  'update_trip', 'rotate_invite', 'update_member', 'create_member', 'set_role', 'remove_member', 'leave_trip',
  'vote_admin', 'upsert_category', 'delete_category', 'add_item', 'add_items_bulk', 'update_item', 'review_item',
  'delete_item', 'pledge', 'assign', 'set_pledge_done', 'set_item_done', 'add_personal', 'add_personal_template',
  'update_personal', 'delete_personal', 'add_expense', 'update_expense', 'delete_expense', 'add_payment',
  'confirm_payment', 'delete_payment', 'send_announcement', 'delete_notification', 'mark_read', 'create_poll',
  'vote_poll', 'close_poll', 'delete_poll', 'save_push_subscription', 'delete_push_subscription',
];

// SPEC §7.2 — the exact public surface of both implementations.
const SPEC_METHODS = [
  'init', 'ensureSession', 'getUserId', 'myTrips', 'createTrip', 'previewInvite', 'joinTrip', 'linkDevice',
  'getDeviceCode', 'getSnapshot', 'subscribe', 'updateTrip', 'rotateInvite', 'updateMember', 'createMember',
  'setRole', 'removeMember', 'leaveTrip', 'voteAdmin', 'upsertCategory', 'deleteCategory', 'addItem',
  'addItemsBulk', 'updateItem', 'reviewItem', 'deleteItem', 'pledge', 'assign', 'setPledgeDone', 'setItemDone',
  'addPersonal', 'addPersonalTemplate', 'updatePersonal', 'deletePersonal', 'addExpense', 'updateExpense',
  'deleteExpense', 'addPayment', 'confirmPayment', 'deletePayment', 'sendAnnouncement', 'deleteNotification',
  'markRead', 'createPoll', 'votePoll', 'closePoll', 'deletePoll', 'savePushSubscription', 'deletePushSubscription',
];

test('surface: both implementations expose exactly the SPEC §7.2 methods', async () => {
  const sb = createSupabaseApi({ client: fakeClient() });
  const demo = createDemoApi({ storage: null, latency: 0 });
  deepEq(Object.keys(sb).sort(), ['mode', ...SPEC_METHODS].sort(), 'supabase keys');
  deepEq(Object.keys(demo).sort(), ['demo', 'mode', ...SPEC_METHODS].sort(), 'demo keys (+ api.demo)');
  eq(sb.mode, 'supabase');
  eq(demo.mode, 'demo');
  for (const m of SPEC_METHODS) {
    eq(typeof sb[m], 'function', `supabase.${m}`);
    eq(typeof demo[m], 'function', `demo.${m}`);
  }
  deepEq(Object.keys(demo.demo).sort(), ['actAs', 'currentUserId', 'reset', 'switchUser'], 'api.demo tools');
});

test('contract: every method calls the exact RPC name with exactly the §4 params', async () => {
  const client = fakeClient();
  const api = createSupabaseApi({ client });
  for (const [method, args, name, params] of CASES) {
    client.calls.length = 0;
    await api[method](...args);
    eq(client.calls.length, 1, `${method}: one rpc call`);
    eq(client.calls[0].name, name, `${method}: rpc name`);
    deepEq(client.calls[0].params, params, `${method}(${show(args)}) params`);
  }
  const coveredRpcs = new Set(CASES.map((c) => c[2]));
  deepEq(SPEC_RPCS.filter((n) => !coveredRpcs.has(n)), [], 'every §4 RPC covered');
  const coveredMethods = new Set(CASES.map((c) => c[0]));
  const rpcMethods = SPEC_METHODS.filter((m) => !['init', 'ensureSession', 'getUserId', 'subscribe'].includes(m));
  deepEq(rpcMethods.filter((m) => !coveredMethods.has(m)), [], 'every api method covered');
  eq(new Set(rpcMethods).size, SPEC_RPCS.length, 'one method per RPC');
});

test('contract: rpc data is returned as-is; myTrips never returns null', async () => {
  const client = fakeClient();
  const api = createSupabaseApi({ client });
  client.rpcImpl = async (name) => ({ data: name === 'create_trip' ? { trip_id: 't', member_id: 'm' } : null, error: null });
  deepEq(await api.createTrip({ name: 'x' }, { display_name: 'y' }), { trip_id: 't', member_id: 'm' });
  deepEq(await api.myTrips(), [], 'null → []');
  eq(await api.markRead(T, []), null, 'void → null');
  const snapshot = { trip: { id: T }, members: [] };
  client.rpcImpl = async () => ({ data: snapshot, error: null });
  deepEq(await api.getSnapshot(T), snapshot);
});

test('errors: rpc errors and thrown fetch failures become ApiError codes', async () => {
  const client = fakeClient();
  const api = createSupabaseApi({ client });
  const pg = (message, extra = {}) => async () => ({ data: null, error: { message, details: null, hint: null, code: 'P0001', ...extra } });
  for (const code of ERROR_CODES.filter((c) => c !== 'network' && c !== 'unknown')) {
    client.rpcImpl = pg(code);
    const e = await rejects(api.getSnapshot(T), code, `raise '${code}'`);
    eq(e.message, hebrewError(code));
  }
  client.rpcImpl = pg('ERROR:  already_claimed (member 42)', { code: 'P0001' });
  await rejects(api.joinTrip('abc', { claimMemberId: M }), 'already_claimed', 'message contains the code');
  client.rpcImpl = async () => ({ data: null, error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' }, status: 0 });
  await rejects(api.myTrips(), 'network', 'postgrest fetch error');
  client.rpcImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  await rejects(api.addItem(T, { title: 'x' }), 'network', 'thrown TypeError');
  client.rpcImpl = pg('permission denied for function get_trip_snapshot', { code: '42501' });
  await rejects(api.getSnapshot(T), 'not_authenticated', 'anon role');
  client.rpcImpl = pg('new row for relation "items" violates check constraint "items_title_check"', { code: '23514' });
  await rejects(api.addItem(T, { title: '' }), 'invalid_input', 'check violation');
  client.rpcImpl = pg('Could not find the function public.nope', { code: 'PGRST202' });
  await rejects(api.getSnapshot(T), 'unknown', 'anything else');
});

test('errors.js: hebrewError, ApiError, toApiError mapping', async () => {
  for (const code of ERROR_CODES) {
    const text = hebrewError(code);
    assert(typeof text === 'string' && /[֐-׿]/.test(text), `Hebrew text for ${code}`);
  }
  eq(new Set(ERROR_CODES.map(hebrewError)).size, ERROR_CODES.length, 'distinct texts');
  eq(hebrewError('no_such_code'), hebrewError('unknown'));
  eq(hebrewError(undefined), hebrewError('unknown'));

  const e = new ApiError('forbidden');
  assert(e instanceof Error && e instanceof ApiError, 'is an Error');
  eq(e.code, 'forbidden');
  eq(e.name, 'ApiError');
  eq(e.message, hebrewError('forbidden'));
  eq(new ApiError('weird').code, 'unknown');
  eq(new ApiError('network', 'custom').message, 'custom');

  const cases = [
    [{ message: 'forbidden', code: 'P0001' }, 'forbidden'],
    [{ message: 'not_found' }, 'not_found'],
    [{ message: 'ERROR: invalid_code' }, 'invalid_code'],
    [{ message: 'x', details: 'has_money_records' }, 'has_money_records'],
    [{ message: 'invalid_input: title too long' }, 'invalid_input'],
    [{ message: 'unforbiddenx', code: 'XX000' }, 'unknown'],
    [{ message: 'not_founding', code: 'XX000' }, 'unknown'],
    [{ message: 'TypeError: Failed to fetch', code: '', details: '' }, 'network'],
    [new TypeError('Failed to fetch'), 'network'],
    [new TypeError('NetworkError when attempting to fetch resource.'), 'network'],
    [new TypeError('Load failed'), 'network'],
    [{ name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 }, 'network'],
    [{ name: 'FetchError', message: 'boom' }, 'network'],
    [{ name: 'AbortError', message: 'The user aborted a request.' }, 'network'],
    [{ message: 'JWT expired', code: 'PGRST301' }, 'not_authenticated'],
    [{ message: 'permission denied for function x', code: '42501' }, 'not_authenticated'],
    [{ message: 'value too long for type character varying(40)', code: '22001' }, 'invalid_input'],
    [{ message: 'invalid input syntax for type uuid: "x"', code: '22P02' }, 'invalid_input'],
    [{ message: 'Anonymous sign-ins are disabled', status: 422 }, 'unknown'],
    ['limit_reached', 'limit_reached'],
    ['something else', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ];
  for (const [input, code] of cases) {
    const out = toApiError(input);
    assert(out instanceof ApiError, `ApiError for ${show(input)}`);
    eq(out.code, code, `toApiError(${show(input)})`);
  }
  const same = new ApiError('last_admin');
  eq(toApiError(same), same, 'ApiError passes through');
  eq(toApiError({ message: 'forbidden' }).detail, 'forbidden', 'keeps the raw message as detail');
});

// ---------- session ----------

test('ensureSession: reuses an existing session (no anonymous sign-in)', async () => {
  const client = fakeClient({ session: { user: { id: 'u-existing' } } });
  const api = createSupabaseApi({ client });
  await api.init();
  eq(api.getUserId(), null, 'unknown before ensureSession');
  deepEq(await api.ensureSession(), { userId: 'u-existing' });
  eq(client.auth.signInCalls, 0);
  eq(api.getUserId(), 'u-existing');
});

test('ensureSession: signs in anonymously once when there is no session (deduped)', async () => {
  const client = fakeClient();
  const api = createSupabaseApi({ client });
  await api.init();
  const [a, b] = await Promise.all([api.ensureSession(), api.ensureSession()]);
  deepEq(a, { userId: 'anon-user-1' });
  deepEq(b, { userId: 'anon-user-1' });
  eq(client.auth.signInCalls, 1, 'one sign-in for concurrent calls');
  deepEq(await api.ensureSession(), { userId: 'anon-user-1' });
  eq(client.auth.signInCalls, 1, 'session reused afterwards');
  eq(api.getUserId(), 'anon-user-1');

  assert(typeof client.authCallback === 'function', 'init listens to auth changes');
  client.authCallback('SIGNED_IN', { user: { id: 'u-2' } });
  eq(api.getUserId(), 'u-2');
  client.authCallback('SIGNED_OUT', null);
  eq(api.getUserId(), null);
});

test('ensureSession: auth failures become ApiError', async () => {
  const client = fakeClient();
  const api = createSupabaseApi({ client });
  client.auth.signInImpl = async () => ({ data: { user: null, session: null }, error: { message: 'Anonymous sign-ins are disabled', status: 422 } });
  await rejects(api.ensureSession(), 'unknown', 'sign-in disabled');
  client.auth.signInImpl = async () => ({ data: null, error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } });
  await rejects(api.ensureSession(), 'network', 'offline');
  client.auth.getSessionImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  await rejects(api.ensureSession(), 'network', 'getSession threw');
});

test('createSupabaseApi: builds the client with the SPEC auth options', async () => {
  const saved = globalThis.supabase;
  const created = [];
  globalThis.supabase = {
    createClient: (...args) => {
      created.push(args);
      return fakeClient({ session: { user: { id: 'u' } } });
    },
  };
  try {
    const api = createSupabaseApi({ url: 'https://abc.supabase.co', anonKey: 'anon-key' });
    await api.init();
    await api.init();
    await api.myTrips();
    eq(created.length, 1, 'one client');
    deepEq(created[0], ['https://abc.supabase.co', 'anon-key', { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'medura-auth' } }]);
  } finally {
    globalThis.supabase = saved;
  }
});

// ---------- subscribe ----------

test('subscribe: realtime channel on the trips row + visibility/online + poll; unsubscribe cleans up', async () => {
  const client = fakeClient();
  const api = createSupabaseApi({ client, pollMs: 40 });
  let hits = 0;
  const unsub = api.subscribe(T, () => hits++);
  eq(typeof unsub, 'function', 'returns unsubscribe synchronously');
  eq(client.channels.length, 1);
  const ch = client.channels[0];
  eq(ch.name, `trip-${T}`);
  eq(ch.subscribed, true);
  eq(ch.handlers.length, 1);
  eq(ch.handlers[0].type, 'postgres_changes');
  deepEq(ch.handlers[0].filter, { event: 'UPDATE', schema: 'public', table: 'trips', filter: `id=eq.${T}` });

  ch.handlers[0].cb({ new: { id: T, rev: 2 } });
  eq(hits, 1, 'realtime update');
  ch.statusCb('SUBSCRIBED');
  eq(hits, 1, 'first join does not refetch');
  ch.statusCb('CHANNEL_ERROR');
  ch.statusCb('SUBSCRIBED');
  eq(hits, 2, 'rejoin after a drop refetches');
  hits = 1;
  window.dispatchEvent(new Event('online'));
  eq(hits, 2, 'back online');
  document.dispatchEvent(new Event('visibilitychange'));
  eq(hits, document.visibilityState === 'visible' ? 3 : 2, 'tab visible again');
  const before = hits;
  await tick(130);
  assert(hits >= before + 2, `poll fallback fired (${hits - before}×)`);

  unsub();
  eq(client.removed.length, 1);
  eq(client.removed[0], ch, 'channel removed');
  const after = hits;
  ch.handlers[0].cb({});
  window.dispatchEvent(new Event('online'));
  document.dispatchEvent(new Event('visibilitychange'));
  await tick(130);
  eq(hits, after, 'nothing fires after unsubscribe');
  unsub();
  eq(client.removed.length, 1, 'unsubscribe is idempotent');
});

test('subscribe: a throwing callback does not break the subscription', async () => {
  const client = fakeClient();
  const api = createSupabaseApi({ client, pollMs: 100000 });
  let hits = 0;
  const origError = console.error;
  console.error = () => {};
  try {
    const unsub = api.subscribe(T, () => {
      hits++;
      throw new Error('boom');
    });
    client.channels[0].handlers[0].cb({});
    client.channels[0].handlers[0].cb({});
    eq(hits, 2);
    unsub();
  } finally {
    console.error = origError;
  }
});

// ---------- index.js ----------

test('createApi: demo when no supabaseUrl or ?demo=1, otherwise supabase', async () => {
  eq(isDemoMode({ supabaseUrl: '' }, ''), true);
  eq(isDemoMode({ supabaseUrl: '   ' }, ''), true);
  eq(isDemoMode({}, ''), true);
  eq(isDemoMode(undefined, ''), true);
  eq(isDemoMode({ supabaseUrl: 'https://x.supabase.co' }, ''), false);
  eq(isDemoMode({ supabaseUrl: 'https://x.supabase.co' }, '?demo=1'), true);
  eq(isDemoMode({ supabaseUrl: 'https://x.supabase.co' }, '?a=b&demo=1'), true);
  eq(isDemoMode({ supabaseUrl: 'https://x.supabase.co' }, '?demo=0'), false);

  const demo = await createApi({ config: { supabaseUrl: '', supabaseAnonKey: '' }, search: '' });
  eq(demo.mode, 'demo');
  const demo2 = await createApi({ config: { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'k' }, search: '?demo=1' });
  eq(demo2.mode, 'demo');

  const saved = globalThis.supabase;
  const created = [];
  globalThis.supabase = { createClient: (...args) => (created.push(args), fakeClient({ session: { user: { id: 'u' } } })) };
  try {
    const sb = await createApi({ config: { supabaseUrl: ' https://x.supabase.co ', supabaseAnonKey: 'anon' }, search: '' });
    eq(sb.mode, 'supabase');
    await sb.init();
    deepEq(created[0].slice(0, 2), ['https://x.supabase.co', 'anon']);
  } finally {
    globalThis.supabase = saved;
  }

  // No arguments: reads window.MEDURA_CONFIG (config.js ships with an empty URL) → demo.
  const savedCfg = window.MEDURA_CONFIG;
  window.MEDURA_CONFIG = { supabaseUrl: '', supabaseAnonKey: '', vapidPublicKey: '' };
  try {
    eq((await createApi()).mode, 'demo');
  } finally {
    window.MEDURA_CONFIG = savedCfg;
  }
});
