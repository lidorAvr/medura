// Supabase implementation of the Medura API (SPEC §7.2).
// Every method is a thin camelCase wrapper around one RPC from SPEC §4 with the exact
// `p_*` parameter names. All failures are normalized to ApiError via toApiError.

import { ApiError, FLIGHT_ERROR_CODES, flightFailure, flightInput, toApiError } from './errors.js?v=853199b';

const POLL_MS = 45000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The JSON body of a non-2xx edge-function answer ({ ok:false, error }), when there is one. */
async function functionBody(error) {
  const ctx = error && error.context;
  if (!ctx || typeof ctx.json !== 'function') return null;
  try {
    const body = await (typeof ctx.clone === 'function' ? ctx.clone() : ctx).json();
    return isObj(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {object} [opts.client]  injected supabase client (tests); otherwise created from url/anonKey
 * @param {string} [opts.url]
 * @param {string} [opts.anonKey]
 * @param {number} [opts.pollMs]  fallback poll interval for subscribe (default 45 s)
 */
export function createSupabaseApi({ client, url, anonKey, pollMs = POLL_MS, getCaptchaToken = null } = {}) {
  let sb = client || null;
  let userId = null;
  let authListening = false;
  let sessionPromise = null;

  function getClient() {
    if (sb) return sb;
    const factory = globalThis.supabase && globalThis.supabase.createClient;
    if (typeof factory !== 'function') throw new ApiError('unknown', 'supabase-js is not loaded');
    sb = factory(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'medura-auth' },
    });
    return sb;
  }

  async function rpc(name, params) {
    let res;
    try {
      res = await getClient().rpc(name, params);
    } catch (err) {
      throw toApiError(err);
    }
    if (res && res.error) throw toApiError(res.error);
    return res ? res.data ?? null : null;
  }

  const normCode = (code) => String(code ?? '').trim().toLowerCase();
  const orNull = (v) => (v === undefined ? null : v);
  const audienceOrNull = (a) => (Array.isArray(a) && a.length ? a : null);
  const plainSub = (sub) => (sub && typeof sub.toJSON === 'function' ? sub.toJSON() : sub);

  const api = {
    mode: 'supabase',

    async init() {
      const c = getClient();
      if (!authListening && c.auth && typeof c.auth.onAuthStateChange === 'function') {
        authListening = true;
        c.auth.onAuthStateChange((_event, session) => {
          userId = session && session.user ? session.user.id : null;
        });
      }
      return api;
    },

    ensureSession() {
      if (!sessionPromise) {
        sessionPromise = (async () => {
          const auth = getClient().auth;
          let res;
          try {
            res = await auth.getSession();
          } catch (err) {
            throw toApiError(err);
          }
          if (res.error) throw toApiError(res.error);
          let session = res.data && res.data.session;
          if (!session) {
            try {
              // First visit on this device: prove we're human (Turnstile) when the project asks for it.
              const captchaToken = getCaptchaToken ? await getCaptchaToken() : null;
              res = await auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined);
            } catch (err) {
              throw toApiError(err);
            }
            if (res.error) throw toApiError(res.error);
            session = res.data && res.data.session;
            const user = (res.data && res.data.user) || (session && session.user);
            userId = user ? user.id : null;
          } else {
            userId = session.user ? session.user.id : null;
          }
          if (!userId) throw new ApiError('not_authenticated');
          return { userId };
        })().finally(() => {
          sessionPromise = null;
        });
      }
      return sessionPromise;
    },

    /** Synchronous: the signed-in user id known from ensureSession/auth events (or null). */
    getUserId() {
      return userId;
    },

    myTrips: () => rpc('my_trips', {}).then((rows) => rows || []),
    createTrip: (trip, profile) => rpc('create_trip', { p_trip: trip, p_profile: profile }),
    previewInvite: (code) => rpc('preview_invite', { p_code: normCode(code) }),
    joinTrip: (code, { claimMemberId, profile, person } = {}) =>
      rpc('join_trip', {
        p_code: normCode(code),
        p_claim_member: claimMemberId ?? null,
        p_profile: profile ?? null,
        p_person: person ?? null,
      }),
    linkDevice: (code) => rpc('link_device', { p_device_code: normCode(code) }),
    getDeviceCode: (memberId) => rpc('get_device_code', { p_member: memberId }),

    getSnapshot: (tripId) => rpc('get_trip_snapshot', { p_trip: tripId }),

    /**
     * Realtime: channel `trip-<id>` on UPDATE of that trips row, plus refetch triggers on
     * tab focus / reconnect and a 45 s poll fallback. Synchronous; returns unsubscribe().
     */
    subscribe(tripId, onChange) {
      let active = true;
      const fire = () => {
        if (!active) return;
        try {
          onChange();
        } catch (err) {
          console.error('[medura] subscribe callback failed', err);
        }
      };
      const c = getClient();
      let channel = null;
      let joinedOnce = false;
      try {
        channel = c
          .channel(`trip-${tripId}`)
          .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'trips', filter: `id=eq.${tripId}` },
            fire,
          )
          .subscribe((status) => {
            // After a reconnect we may have missed updates → refetch once.
            if (status === 'SUBSCRIBED') {
              if (joinedOnce) fire();
              joinedOnce = true;
            }
          });
      } catch (err) {
        console.warn('[medura] realtime unavailable, polling only', err);
      }
      const onVisible = () => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') fire();
      };
      const hasDoc = typeof document !== 'undefined';
      const hasWin = typeof window !== 'undefined';
      if (hasDoc) document.addEventListener('visibilitychange', onVisible);
      if (hasWin) window.addEventListener('online', fire);
      const timer = setInterval(() => {
        if (!hasDoc || document.visibilityState !== 'hidden') fire();
      }, pollMs);

      return function unsubscribe() {
        if (!active) return;
        active = false;
        clearInterval(timer);
        if (hasDoc) document.removeEventListener('visibilitychange', onVisible);
        if (hasWin) window.removeEventListener('online', fire);
        if (channel) {
          try {
            c.removeChannel(channel);
          } catch (err) {
            console.warn('[medura] removeChannel failed', err);
          }
        }
      };
    },

    updateTrip: (tripId, patch) => rpc('update_trip', { p_trip: tripId, p_patch: patch }),
    rotateInvite: (tripId) => rpc('rotate_invite', { p_trip: tripId }),
    deleteTrip: (tripId) => rpc('delete_trip', { p_trip: tripId }),
    updateMember: (memberId, patch) => rpc('update_member', { p_member: memberId, p_patch: patch }),
    createMember: (tripId, profile) => rpc('create_member', { p_trip: tripId, p_profile: profile }),
    setRole: (memberId, role) => rpc('set_role', { p_member: memberId, p_role: role }),
    setPersonAdmin: (memberId, person, admin) =>
      rpc('set_person_admin', { p_member: memberId, p_person: person, p_admin: Boolean(admin) }),
    touchPresence: (tripId) => rpc('touch_presence', { p_trip: tripId }),
    nudgeMembers: (tripId, module) => rpc('nudge_members', { p_trip: tripId, p_module: module }),
    removeMember: (memberId) => rpc('remove_member', { p_member: memberId }),
    leaveTrip: (tripId) => rpc('leave_trip', { p_trip: tripId }),
    voteAdmin: (candidateId, on) => rpc('vote_admin', { p_candidate: candidateId, p_on: Boolean(on) }),

    upsertCategory: (tripId, cat) => rpc('upsert_category', { p_trip: tripId, p_cat: cat }),
    setSecret: (kind, id, secret) => rpc('set_secret', { p_kind: kind, p_id: id, p_secret: Boolean(secret) }),
    deleteCategory: (categoryId) => rpc('delete_category', { p_category: categoryId }),

    addItem: (tripId, item) => rpc('add_item', { p_trip: tripId, p_item: item }),
    addItemsBulk: (tripId, items) => rpc('add_items_bulk', { p_trip: tripId, p_items: items }),
    updateItem: (itemId, patch) => rpc('update_item', { p_item: itemId, p_patch: patch }),
    reviewItem: (itemId, approve, reason) =>
      rpc('review_item', { p_item: itemId, p_approve: Boolean(approve), p_reason: orNull(reason) }),
    deleteItem: (itemId) => rpc('delete_item', { p_item: itemId }),

    pledge: (itemId, qty) => rpc('pledge', { p_item: itemId, p_qty: qty ?? 1 }),
    assign: (itemId, memberId, qty) => rpc('assign', { p_item: itemId, p_member: memberId, p_qty: qty ?? 1 }),
    setPledgeDone: (itemId, done) => rpc('set_pledge_done', { p_item: itemId, p_done: Boolean(done) }),
    setEachPart: (itemId, patch) => rpc('set_each_part', { p_item: itemId, p_patch: patch }),
    setItemDone: (itemId, done) => rpc('set_item_done', { p_item: itemId, p_done: Boolean(done) }),

    addPersonal: (tripId, title) => rpc('add_personal', { p_trip: tripId, p_title: title }),
    addPersonalTemplate: (tripId) => rpc('add_personal_template', { p_trip: tripId }),
    updatePersonal: (id, patch) => rpc('update_personal', { p_id: id, p_patch: patch }),
    deletePersonal: (id) => rpc('delete_personal', { p_id: id }),

    addExpense: (tripId, exp) => rpc('add_expense', { p_trip: tripId, p_exp: exp }),
    updateExpense: (id, patch) => rpc('update_expense', { p_expense: id, p_patch: patch }),
    deleteExpense: (id) => rpc('delete_expense', { p_expense: id }),

    addPayment: (tripId, pay) => rpc('add_payment', { p_trip: tripId, p_pay: pay }),
    createMoneyRequest: (tripId, req) => rpc('create_money_request', { p_trip: tripId, p_req: req }),
    payMoneyRequest: (requestId, method) => rpc('pay_money_request', { p_request: requestId, p_method: method ?? null }),
    cancelMoneyRequest: (requestId) => rpc('cancel_money_request', { p_request: requestId }),
    settleMoneyRequestShare: (requestId, memberId, person) =>
      rpc('settle_money_request_share', { p_request: requestId, p_member: memberId, p_person: person ?? null }),
    recordMoneyRequestExpense: (requestId, amount) => rpc('record_money_request_expense', { p_request: requestId, p_amount: amount ?? null }),
    addMoneyRequestMember: (requestId, memberId, amount) =>
      rpc('add_money_request_member', { p_request: requestId, p_member: memberId, p_amount: amount ?? null }),
    confirmPayment: (id) => rpc('confirm_payment', { p_payment: id }),
    deletePayment: (id) => rpc('delete_payment', { p_payment: id }),

    sendAnnouncement: (tripId, { title, body, audience, urgent, digest } = {}) =>
      rpc('send_announcement', {
        p_trip: tripId,
        p_title: title,
        p_body: orNull(body),
        p_audience: audienceOrNull(audience),
        p_urgent: Boolean(urgent),
        p_digest: Boolean(digest),
      }),
    deleteNotification: (id) => rpc('delete_notification', { p_notification: id }),
    markRead: (tripId, ids) => rpc('mark_read', { p_trip: tripId, p_ids: ids || [] }),

    createPoll: (tripId, { question, options, multi } = {}) =>
      rpc('create_poll', { p_trip: tripId, p_question: question, p_options: options, p_multi: Boolean(multi) }),
    votePoll: (pollId, optionIds) => rpc('vote_poll', { p_poll: pollId, p_option_ids: optionIds || [] }),
    closePoll: (pollId, closed) => rpc('close_poll', { p_poll: pollId, p_closed: closed !== false }),
    deletePoll: (pollId) => rpc('delete_poll', { p_poll: pollId }),

    savePushSubscription: (tripId, sub) =>
      rpc('save_push_subscription', { p_trip: tripId, p_sub: plainSub(sub) }),
    deletePushSubscription: (endpoint) => rpc('delete_push_subscription', { p_endpoint: endpoint }),

    myEmail: () => rpc('my_email', {}),
    requestEmailCode: (email) => rpc('request_email_code', { p_email: email }).then(() => ({ sent: true })),
    verifyEmailCode: (code) => rpc('verify_email_code', { p_code: code }),
    getMemberEmails: (memberId) => rpc('get_member_emails', { p_member: memberId }).then((r) => r || []),
    memberDetails: (memberId) => rpc('member_details', { p_member: memberId }),
    setMemberEmails: (memberId, emails) => rpc('set_member_emails', { p_member: memberId, p_emails: emails || [] }),

    upsertRide: (tripId, ride) => rpc('upsert_ride', { p_trip: tripId, p_ride: ride }),
    deleteRide: (rideId) => rpc('delete_ride', { p_ride: rideId }),
    takeSeat: (rideId, seats = 1) => rpc('take_seat', { p_ride: rideId, p_seats: seats }),
    leaveSeat: (tripId) => rpc('leave_seat', { p_trip: tripId }),
    sendTestNotification: (tripId) => rpc('send_test_notification', { p_trip: tripId }),
    linkByEmail: () => rpc('link_by_email', {}).then((r) => r || []),
    setMyPerson: (tripId, person) => rpc('set_my_person', { p_trip: tripId, p_person: person }),
    myAccount: () => rpc('my_account', {}),
    saveAccount: (patch) => rpc('save_account', { p_patch: patch }),
    requestProfileJoin: (code, memberId, { person = null, name = null } = {}) =>
      rpc('request_profile_join', { p_code: normCode(code), p_member: memberId, p_person: person, p_name: name }),
    cancelProfileRequest: (tripId) => rpc('cancel_profile_request', { p_trip: tripId }),
    respondProfileRequest: (requestId, approve) => rpc('respond_profile_request', { p_request: requestId, p_approve: Boolean(approve) }),
    pendingView: (tripId) => rpc('pending_view', { p_trip: tripId }),
    inviteToRide: (rideId, memberId, seats = null) => rpc('invite_to_ride', { p_ride: rideId, p_member: memberId, p_seats: seats }),
    respondSeat: (rideId, memberId, approve) => rpc('respond_seat', { p_ride: rideId, p_member: memberId, p_approve: Boolean(approve) }),
    respondAssignment: (itemId, accept, reason = null) =>
      rpc('respond_assignment', { p_item: itemId, p_accept: Boolean(accept), p_reason: reason ?? null }),

    // "הבית שלי" + invites from past trips (SPEC §16.1)
    myOverview: () => rpc('my_overview', {}).then((r) => r || []),
    myInvites: () => rpc('my_invites', {}).then((r) => r || []),
    tripContacts: (tripId) => rpc('trip_contacts', { p_trip: tripId }).then((r) => r || []),
    inviteContacts: (tripId, keys, { memberId } = {}) =>
      rpc('invite_contacts', { p_trip: tripId, p_keys: keys || [], p_member: memberId ?? null }),
    respondInvite: (inviteId, accept, { with: names, person } = {}) =>
      rpc('respond_invite', {
        p_invite: inviteId, p_accept: Boolean(accept), p_with: names?.length ? names : null, p_person: person ?? null,
      }),
    cancelInvite: (inviteId) => rpc('cancel_invite', { p_invite: inviteId }),

    /**
     * Live flight details (design §4.4): the `flight` edge function with this user's JWT.
     * Never rejects — resolves { ok: true, cached, flight } or { ok: false, error, message }
     * (error ∈ FLIGHT_ERROR_CODES) so the UI falls back to manual fields.
     */
    async lookupFlight(tripId, number, date) {
      const input = flightInput(number, date);
      if (!input || typeof tripId !== 'string' || !tripId) return flightFailure('bad_input');
      let res;
      try {
        const c = getClient();
        if (!c.functions || typeof c.functions.invoke !== 'function') return flightFailure('upstream');
        res = await c.functions.invoke('flight', { body: { trip_id: tripId, number: input.number, date: input.date }, timeout: 20000 });
      } catch (err) {
        return flightFailure(toApiError(err).code === 'network' ? 'network' : 'upstream');
      }
      let data = res ? res.data : null;
      const error = res ? res.error : null;
      if (error) {
        data = await functionBody(error);
        if (!isObj(data)) {
          const netErr = error.name === 'FunctionsFetchError' || toApiError(error.context || error).code === 'network';
          return flightFailure(netErr ? 'network' : 'upstream');
        }
      }
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          data = null;
        }
      }
      if (isObj(data) && data.ok === true && isObj(data.flight)) {
        return { ok: true, cached: data.cached === true, flight: data.flight };
      }
      if (isObj(data) && data.ok === false) {
        return flightFailure(FLIGHT_ERROR_CODES.includes(data.error) ? data.error : 'upstream');
      }
      return flightFailure('upstream');
    },
  };

  return api;
}
