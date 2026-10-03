// People (SPEC §8.9): who's coming (stats), a card per profile — and in a couple / family one row
// per person (👑 per person, in or not yet, "🟢 מחובר/ת עכשיו", their own WhatsApp / phone, a personal
// invite) — what they bring, balance, a "who has X at home?" search, the admin election (votes +
// crowning: a whole single profile, or one person of a couple), the invite link, and admin tools
// (add a placeholder profile, remove a member).
import { html } from 'htm/preact';
import { useState, useMemo, useEffect, useLayoutEffect } from 'preact/hooks';
import { useTrip, useStore, actions, store } from '../store.js?v=8a35ae3';
import {
  Avatar, AvatarStack, Button, Card, CopyButton, EmptyState, Field, Pill, Sheet, ShareButton, Skeleton,
  TextArea, TextInput, Toggle, confirmDialog, Fold, OverBanner, tripOver,
} from '../ui/components.js?v=8a35ae3';
import { Icon } from '../ui/icons.js?v=8a35ae3';
import { hebrewError, toApiError } from '../api/errors.js?v=8a35ae3';
import {
  adminPersons, adminVoteCounts, balances, buildInviteText, displayName, formatMoney, formatQty, headcountTotal,
  hebrewCount, inviteUrl, isAdmin, memberNets, membersById, personPhone, personsOf, presence, rideModel, timeAgo, whatsappChatUrl,
  whatsappShareUrl, splitsItems, splitsMoney,
} from '../lib/logic.js?v=8a35ae3';
import { ProfileForm } from './me.js?v=8a35ae3';

const cx = (...a) => a.filter(Boolean).join(' ');

let seq = 0;
const useFormId = (prefix) => useState(() => `${prefix}-${++seq}`)[0];

const appBase = () => `${location.origin}${location.pathname}`;
const norm = (s) => String(s || '').trim().toLowerCase();
const money = (n) => html`<bdi class="num">${formatMoney(n)}</bdi>`;
const roleLabel = (m) => (m.role === 'owner' ? '👑 יוצר/ת הטיול' : m.role === 'admin' ? '👑 מנהל/ת' : null);
/** The crown of one person who holds their profile's rights. */
const crownLabel = (m) => (m.role === 'owner' ? '👑 יוצר/ת הטיול' : '👑 מנהל/ת');
const telHref = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;

/** Admin rights per person (a newer server sends members[].persons): a couple / family gets one row per person. */
const perPerson = (m) => Array.isArray(m?.persons) && m.persons.length > 1;

/** Is this person row me — this device's person, or (a device that hasn't said) my e-mail on another one? */
const isMyRow = (snap, m, p) => m.id === snap.me?.member_id && (p.name === snap.me?.person || (!snap.me?.person && Boolean(p.mine)));

/** Where a person stands: in (✓ / ✉️ with a verified e-mail), maybe in (a device that hasn't said who it is), not yet. */
function personStatus(m, p) {
  if (p.joined) return p.verified ? { text: '✉️ מאומת/ת', tone: 'in', hint: 'בפנים, עם מייל מאומת' } : { text: '✓ בפנים', tone: 'in' };
  if (Number(m.unknown_devices) > 0) return { text: '❔ אולי בפנים', tone: 'maybe', hint: 'יש בפרופיל מכשיר שעוד לא אמר מי הוא' };
  return { text: '⏳ עוד לא נכנס/ה', tone: 'out' };
}

/** "🟢 מחובר/ת עכשיו" / "נראה/תה לפני 5 דק׳" — me: always now (unless I hid it); `device` for a phone with no person. */
function seenText({ seenAt, now, me = false, hidden = false, device = false }) {
  if (me) return hidden ? '🙈 מוסתר/ת' : '🟢 מחובר/ת עכשיו';
  const at = presence(seenAt, now);
  if (!at) return null;
  if (at === 'now') return device ? '🟢 מחובר עכשיו' : '🟢 מחובר/ת עכשיו';
  return `${device ? 'נראה' : 'נראה/תה'} ${at}`;
}

/** How many things a member took on (bring / buy / task pledges on non-rejected items). */
function pledgeCounts(snap) {
  const itemById = new Map((snap.items || []).map((i) => [i.id, i]));
  const counts = new Map();
  for (const p of snap.pledges || []) {
    const item = itemById.get(p.item_id);
    if (!item || item.status === 'rejected' || item.type === 'each') continue;
    counts.set(p.member_id, (counts.get(p.member_id) || 0) + 1);
  }
  return counts;
}

function memberMatches(m, q) {
  if (!q) return { hit: true, inv: [] };
  const inv = (m.inventory || []).filter((x) => norm(x).includes(q));
  const text = [m.display_name, ...(m.people || []), m.prefs?.diet].map(norm).join(' ');
  return { hit: inv.length > 0 || text.includes(q), inv };
}

/** A personal invite for one person of a profile (a couple's partner who isn't in yet, or a placeholder). */
function personInviteText(trip, m, name, url) {
  const inside = personsOf(m).filter((p) => p.joined).map((p) => p.name);
  const where = `ב${trip.emoji || '⛺'} *${trip.name}* במדורה 🔥`;
  return [
    `היי ${name}! 👋`,
    inside.length ? `${inside.join(' ו')} כבר ${where} — חסר/ה רק את/ה` : `שמרנו לך מקום ${where}`,
    `נכנסים מהקישור, בוחרים ״${name}״ ומסמנים מה מביאים ✋`,
    '',
    `👈 ${url}`,
  ].join('\n');
}

function unclaimedInviteText(trip, m, url) {
  return [
    `היי ${displayName(m)}! 👋`,
    `שמרנו לך מקום ב${trip.emoji || '⛺'} *${trip.name}* במדורה 🔥`,
    'נכנסים מהקישור, בוחרים ״זה אני!״ ומסמנים מה מביאים ✋',
    '',
    `👈 ${url}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

export default function PeopleScreen({ route }) {
  const { snap, me, isAdmin: admin, tripId } = useTrip();
  const wanted = route?.params?.tripId || tripId;
  if (!snap || !me || snap.trip?.id !== wanted) {
    return html`<div class="screen ppl-screen" aria-busy="true">
      <${Skeleton} lines=${3} />
      <${Skeleton} lines=${4} />
      <${Skeleton} lines=${4} />
    </div>`;
  }
  return html`<${PeopleBody} key=${me.id} route=${route} snap=${snap} me=${me} admin=${admin} tripId=${snap.trip.id} />`;
}

function PeopleBody({ route, snap, me, admin, tripId }) {
  const [q, setQ] = useState('');
  const [sheet, setSheet] = useState({ open: false, id: route?.query?.member || null });
  const [adding, setAdding] = useState(false);
  const [contacts, setContacts] = useState({ open: false, memberId: null });
  useEffect(() => {
    if (route?.query?.member) setSheet({ open: true, id: route.query.member });
  }, [route?.query?.member]);

  const byId = useMemo(() => membersById(snap.members), [snap.members]);
  const counts = useMemo(() => pledgeCounts(snap), [snap.items, snap.pledges]);
  // net = the settle-up's own whole-shekel number (what the money screen says), not the balance with its agorot
  const bal = useMemo(() => {
    const nets = memberNets(snap);
    return new Map(balances(snap).map((b) => [b.member_id, { ...b, net: nets.get(b.member_id) || 0 }]));
  }, [snap]);
  const hasMoney = (snap.expenses || []).length > 0 || (snap.payments || []).length > 0;
  const invite = inviteUrl(appBase(), snap.trip.invite_code);

  const ordered = [...snap.members].sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : 0));
  const query = norm(q);
  const rows = ordered.map((m) => ({ m, ...memberMatches(m, query) })).filter((r) => r.hit);
  const invHits = query ? rows.filter((r) => r.inv.length) : [];

  const open = (id) => setSheet({ open: true, id });
  const sheetMember = sheet.id ? byId.get(sheet.id) : null;
  // my own row is "now" (I'm right here) — unless I turned presence off in "אני"
  const account = useStore((s) => s.account);
  useEffect(() => {
    actions.loadAccount();
  }, []);
  const hidden = account?.prefs?.presence === false;
  const now = snap.me?.server_now || new Date();

  // after the trip (ux A3): read only — no invites, no admin tools, no election; the balance is what matters
  const over = tripOver(snap.trip);
  return html`<div class="screen ppl-screen">
    <${OverBanner} trip=${snap.trip} />
    <${Stats} snap=${snap} />
    ${over
      ? null
      : html`<${InviteCard} trip=${snap.trip} url=${invite} admin=${admin} tripId=${tripId}
          onContacts=${() => setContacts({ open: true, memberId: null })} />`}

    <div class="ppl-search">
      <span class="ppl-search__icon" aria-hidden="true"><${Icon} name="search" size=${18} /></span>
      <${TextInput}
        type="search"
        value=${q}
        class="ppl-search__input"
        placeholder="חיפוש: שם, או ״למי יש רמקול?״"
        aria-label="חיפוש חברים או ציוד שיש להם בבית"
        onInput=${(e) => setQ(e.target.value)}
      />
    </div>
    ${query
      ? html`<p class="ppl-search__result" role="status">
          ${invHits.length
            ? `🙌 ל-${hebrewCount(invHits.length, 'חבר/ה', 'חברים')} יש ״${q.trim()}״ בבית`
            : rows.length
              ? `נמצאו ${rows.length}`
              : 'לא מצאנו… אולי כדאי לשאול בקבוצה 🙂'}
        </p>`
      : null}

    <div class="ppl-list">
      ${rows.map(({ m, inv }) => html`<${ProfileCard}
        key=${m.id}
        m=${m}
        snap=${snap}
        admin=${admin}
        now=${now}
        hidden=${hidden}
        invite=${invite}
        count=${counts.get(m.id) || 0}
        bal=${hasMoney && over ? bal.get(m.id) : null}
        invHits=${inv}
        over=${over}
        onOpen=${() => open(m.id)}
      />`)}
    </div>

    ${over
      ? null
      : html`<${InvitedSection} snap=${snap} admin=${admin} now=${now} />
        ${admin ? html`<${AdminTools} onAdd=${() => setAdding(true)} />` : null}
        <${Election} snap=${snap} me=${me} admin=${admin} />`}

    <${MemberSheet}
      open=${sheet.open && Boolean(sheetMember)}
      m=${sheetMember}
      snap=${snap}
      me=${me}
      admin=${admin}
      bal=${sheetMember ? bal.get(sheetMember.id) : null}
      hasMoney=${hasMoney}
      invite=${invite}
      now=${now}
      hidden=${hidden}
      onClose=${() => setSheet({ ...sheet, open: false })}
      onPickContact=${(memberId) => {
        setSheet({ ...sheet, open: false });
        setTimeout(() => setContacts({ open: true, memberId }), 260);
      }}
    />
    ${admin
      ? html`<${ContactsSheet}
          open=${contacts.open}
          tripId=${tripId}
          memberId=${contacts.memberId}
          target=${contacts.memberId ? byId.get(contacts.memberId) : null}
          onClose=${() => setContacts({ ...contacts, open: false })}
        />`
      : null}
    ${admin
      ? html`<${AddProfileSheet}
          open=${adding}
          tripId=${tripId}
          onClose=${() => setAdding(false)}
          onCreated=${(id) => {
            setAdding(false);
            setTimeout(() => open(id), 260);
          }}
        />`
      : null}
  </div>`;
}

// ---------------------------------------------------------------------------
// header stats
// ---------------------------------------------------------------------------

function Stats({ snap }) {
  const members = snap.members || [];
  const heads = headcountTotal(members);
  const sizes = members.map((m) => Number(m.headcount) || 1);
  const couples = sizes.filter((h) => h === 2).length;
  const singles = sizes.filter((h) => h === 1).length;
  const families = sizes.filter((h) => h > 2).length;
  const admins = adminPersons(snap).length; // per person: a couple's partner counts only once crowned
  // who's in, per person: joined people, plus a device that hasn't said who it is (it's one of the others)
  let people = 0;
  let inside = 0;
  for (const m of members) {
    const persons = personsOf(m);
    const joined = persons.filter((p) => p.joined).length;
    people += persons.length;
    inside += joined + Math.min(Number(m.unknown_devices) || 0, persons.length - joined);
  }
  const parts = [
    hebrewCount(heads, 'איש', 'אנשים'),
    couples ? hebrewCount(couples, 'זוג', 'זוגות') : null,
    singles ? hebrewCount(singles, 'יחיד', 'יחידים') : null,
    families ? hebrewCount(families, 'משפחה', 'משפחות') : null,
  ].filter(Boolean);
  return html`<section class="hero ppl-hero" aria-label="מי מגיע">
    <div class="ppl-hero__top">
      <div class="ppl-hero__text">
        <span class="ppl-hero__kicker">${!snap.trip?.settings?.type || snap.trip.settings.type === 'camping' ? "החבר'ה סביב המדורה 🔥" : "החבר'ה של הטיול"}</span>
        <h1 class="ppl-hero__line" aria-label=${parts.join(' · ')}>
          <span class="ppl-hero__part ppl-hero__part--lead">${parts[0]}</span>
          ${parts.length > 1
            ? html`<span class="ppl-hero__sep ppl-hero__sep--lead" aria-hidden="true"> · </span>
                <span class="ppl-hero__rest">
                  ${parts.slice(1).map((p, i) => html`${i ? html`<span class="ppl-hero__sep" aria-hidden="true"> · </span>` : null}<span class="ppl-hero__part">${p}</span>`)}
                </span>`
            : null}
        </h1>
      </div>
      <span class="ppl-hero__emoji" aria-hidden="true">🏕️</span>
    </div>
    <div class="ppl-hero__bottom">
      <div class="ppl-hero__pills">
        <${Pill}>${admins === 1 ? '👑 מנהל/ת אחד/ת' : `👑 ${admins} מנהלים`}</${Pill}>
        <${Pill} title="כמה מהחבר'ה כבר נכנסו מהטלפון">✓ ${inside}/${people} בפנים</${Pill}>
        ${(snap.invites || []).length ? html`<${Pill} tone="accent" class="ppl-hero__invited">+ ${snap.invites.length} הוזמנו</${Pill}>` : null}
      </div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// member card + sheet
// ---------------------------------------------------------------------------

function BalancePill({ b }) {
  if (!b) return null;
  const net = b.net ?? 0;
  if (net >= 1) return html`<${Pill} tone="success" data-testid="ppl-balance">💰 מגיע ${money(net)}</${Pill}>`;
  if (net <= -1) return html`<${Pill} tone="accent" data-testid="ppl-balance">💸 צריך להעביר ${money(-net)}</${Pill}>`;
  return html`<${Pill} data-testid="ppl-balance">✨ מאוזן/ת</${Pill}>`;
}

function ProfileCard({ m, snap, admin, now, hidden, invite, count, bal, invHits, over, onOpen }) {
  const mine = m.id === snap.me?.member_id;
  const name = displayName(m);
  const many = perPerson(m);
  const persons = personsOf(m);
  const people = (m.people || []).filter(Boolean);
  // an older server (no per-person rows): the names under the title, as before
  const peopleLine = !many && people.length > 1 && people.join(' ו') !== name ? people.join(' · ') : null;
  const solo = persons[0] || null;
  // WhatsApp on the card: a single profile (their own phone, else the profile's); a couple / family has it per
  // person in the rows — until nobody is in yet, then the profile's phone stays on the card
  const cardPhone = mine ? null : !many ? personPhone(m, solo) : persons.some((p) => p.joined) ? null : m.phone;
  const chat = cardPhone ? whatsappChatUrl(cardPhone) : null;
  const soloSeen = !many && m.claimed
    ? seenText({ seenAt: [solo?.seen_at, m.unknown_seen_at].filter(Boolean).sort().pop(), now, me: mine, hidden })
    : null;
  const unknown = Number(m.unknown_devices) || 0;
  const showUnknown = many && unknown > 0 && (admin || mine);
  const thisDevice = mine && !snap.me?.person;
  const inv = m.inventory || [];
  const invShown = invHits.length ? invHits : inv.slice(0, 4);
  const invMore = inv.length - invShown.length;
  const role = many ? null : roleLabel(m);
  // the whole card opens the sheet (ux P2); links and buttons inside keep their own tap
  const onCard = (e) => {
    if (e.target.closest('a, button, input')) return;
    onOpen();
  };
  return html`<article class=${cx('ppl-card', 'ppl-card--tap', many && 'ppl-card--many', mine && 'ppl-card--me', !m.claimed && 'ppl-card--ghost', invHits.length && 'is-hit')}
    onClick=${onCard}>
    <${Avatar} member=${m} size=${52} />
    <div class="ppl-card__main">
      <div class="ppl-card__head">
        <button type="button" class="ppl-card__name" onClick=${onOpen} aria-label=${`${name} — פרטים`}>${name}</button>
        ${mine ? html`<${Pill} tone="primary">את/ה</${Pill}>` : null}
        ${role ? html`<${Pill} tone="accent">${role}</${Pill}>` : null}
      </div>
      ${peopleLine ? html`<span class="ppl-card__people">${peopleLine}</span>` : null}
      <div class="ppl-card__pills">
        ${!m.claimed && !many ? html`<${Pill} tone="warning">⏳ עוד לא נכנס/ה</${Pill}>` : null}
        ${count
          ? html`<${Pill} tone="primary">🎒 מביא/ה ${hebrewCount(count, 'פריט', 'פריטים')}</${Pill}>`
          : html`<${Pill}>עוד בלי פריטים</${Pill}>`}
        <${BalancePill} b=${bal} />
        ${splitsMoney(m) ? html`<${Pill} data-testid="pill-pay-each">🙋 כסף לחוד</${Pill}>` : null}
        ${splitsItems(m) ? html`<${Pill} data-testid="pill-bring-each">🙋 ציוד לחוד</${Pill}>` : null}
        ${soloSeen ? html`<span class="ppl-seen" data-testid="presence">${soloSeen}</span>` : null}
      </div>
      ${inv.length
        ? html`<p class="ppl-card__inv">
            <span aria-hidden="true">🏠 </span><span class="sr-only">יש בבית: </span>
            ${invShown.map((x, i) => html`${i ? ' · ' : ''}<span class=${cx(invHits.includes(x) && 'ppl-hit')}>${x}</span>`)}
            ${invMore > 0 ? html`<span class="muted"> · +${invMore}</span>` : null}
          </p>`
        : null}
    </div>
    <span class="ppl-card__end">
      ${chat
        ? html`<a class="ppl-card__chat" href=${chat} target="_blank" rel="noopener noreferrer" aria-label=${`וואטסאפ ל${name}`} title="וואטסאפ">
            <span aria-hidden="true">💬</span>
          </a>`
        : null}
      <span class="ppl-card__chev" aria-hidden="true"><${Icon} name="chevron-left" size=${18} /></span>
    </span>
    ${many
      ? html`<ul class="ppl-persons" aria-label=${`מי ב${name}`}>
          ${persons.map((p) => html`<${PersonRow}
            key=${p.name}
            m=${m}
            p=${p}
            snap=${snap}
            me=${isMyRow(snap, m, p)}
            canInvite=${(admin || mine) && !over}
            now=${now}
            hidden=${hidden}
            invite=${invite}
          />`)}
          ${showUnknown
            ? html`<li class="ppl-person ppl-person--device" data-testid="unknown-device">
                <span class="ppl-person__who">
                  <span class="ppl-person__name">📱 ${thisDevice && unknown === 1
                    ? 'המכשיר הזה עוד לא אמר מי את/ה'
                    : unknown === 1 ? 'מכשיר שעוד לא אמר מי הוא' : `${unknown} מכשירים שעוד לא אמרו מי הם`}</span>
                </span>
                ${!thisDevice && seenText({ seenAt: m.unknown_seen_at, now, device: true })
                  ? html`<span class="ppl-person__state"><span class="ppl-seen">${seenText({ seenAt: m.unknown_seen_at, now, device: true })}</span></span>`
                  : null}
              </li>`
            : null}
        </ul>`
      : null}
  </article>`;
}

/** One person of a couple / family: 👑, in or not yet, when last seen, their own WhatsApp / phone or an invite. */
function PersonRow({ m, p, snap, me, canInvite, now, hidden, invite }) {
  const status = personStatus(m, p);
  const seen = p.joined || me ? seenText({ seenAt: p.seen_at, now, me, hidden }) : null;
  const phone = !me && p.joined ? personPhone(m, p) : null;
  const chat = phone ? whatsappChatUrl(phone) : null;
  return html`<li class=${cx('ppl-person', me && 'is-me', !p.joined && 'is-out')} data-person=${p.name}>
    <span class="ppl-person__who">
      <span class="ppl-person__name">${p.name}</span>
      ${p.admin ? html`<span class="ppl-person__crown">${crownLabel(m)}</span>` : null}
      ${me ? html`<span class="ppl-person__me">את/ה</span>` : null}
    </span>
    <span class="ppl-person__state">
      <span class=${`ppl-person__status is-${status.tone}`} title=${status.hint || undefined}>${status.text}</span>
      ${seen ? html`<span class="ppl-seen" data-testid="presence">${seen}</span>` : null}
    </span>
    <span class="ppl-person__acts">
      ${chat
        ? html`<a class="ppl-person__act ppl-person__act--chat" href=${chat} target="_blank" rel="noopener noreferrer"
            aria-label=${`וואטסאפ ל${p.name}`} title="וואטסאפ"><span aria-hidden="true">💬</span></a>`
        : null}
      ${phone
        ? html`<a class="ppl-person__act" href=${telHref(phone)} aria-label=${`חיוג ל${p.name}`} title="חיוג"><span aria-hidden="true">📞</span></a>`
        : null}
      ${!p.joined && canInvite && !(Number(m.unknown_devices) > 0)
        ? html`<a class="ppl-person__invite" href=${whatsappShareUrl(personInviteText(snap.trip, m, p.name, invite))}
            target="_blank" rel="noopener noreferrer" aria-label=${`הזמנה אישית ל${p.name}`}>📨 הזמנה אישית</a>`
        : null}
    </span>
  </li>`;
}

/** Why someone who isn't in yet can't be crowned (set_role / set_person_admin answer `not_allowed_state`:
 *  whoever takes the profile later would get the rights) — said in words, never "refresh and try again". */
const notInYet = (name) => `אפשר למנות את ${name} רק אחרי שנכנס/ה מהטלפון 📱`;

/**
 * Crowns per person of a couple / family (admins): a switch each, with the reason when it can't change —
 * someone who isn't in yet, or the owner's profile (only its owner changes it; it always keeps one).
 */
function PersonCrowns({ m, snap }) {
  const [busy, setBusy] = useState(null);
  const persons = personsOf(m);
  const ownerProfile = m.role === 'owner';
  const iAmOwner = snap.me?.role === 'owner';
  const crowned = persons.filter((p) => p.admin).length;
  const reason = (p) => {
    if (ownerProfile && !iAmOwner) return 'רק יוצר/ת הטיול משנה את הניהול בפרופיל הזה';
    if (!p.admin && !p.joined) return 'עוד לא נכנס/ה — אפשר למנות רק מי שכבר בפנים';
    if (p.admin && ownerProfile && crowned === 1 && !(Number(m.unknown_devices) > 0)) return 'יוצר/ת הטיול תמיד נשאר/ת מנהל/ת';
    return null;
  };
  const toggle = async (p, on) => {
    if (!on && isMyRow(snap, m, p)) {
      const yes = await confirmDialog({
        title: 'להסיר לעצמך את הניהול?',
        text: 'לא תוכל/י יותר לאשר הצעות או לשבץ — עד שמישהו ימנה אותך מחדש.',
        confirmText: 'כן, להסיר',
      });
      if (!yes) return;
    }
    setBusy(p.name);
    await actions.run(async (api) => {
      await api.setPersonAdmin(m.id, p.name, on);
      return true;
    }, {
      success: on ? `${p.name} מנהל/ת עכשיו 👑` : `${p.name} כבר לא מנהל/ת`,
      error: (code) => (code === 'not_allowed_state'
        ? notInYet(p.name)
        : code === 'owner_locked' ? 'בפרופיל של יוצר/ת הטיול משנה רק יוצר/ת הטיול, ותמיד נשאר/ת בו מנהל/ת 👑' : hebrewError(code)),
    });
    setBusy(null);
  };
  return html`<div class="ppl-crowns" data-testid="person-crowns">
    ${persons.map((p) => {
      const why = reason(p);
      const hint = why || (p.admin ? 'מנהל/ת — מאשר/ת הצעות, משבץ/ת ושולח/ת הודעות' : '✓ בפנים · לא מנהל/ת');
      return html`<${Toggle}
        key=${p.name}
        checked=${Boolean(p.admin)}
        label=${`👑 ${p.name}${isMyRow(snap, m, p) ? ' (את/ה)' : ''}`}
        hint=${busy === p.name ? 'רגע…' : hint}
        disabled=${Boolean(why) || Boolean(busy)}
        onChange=${(v) => toggle(p, v)}
      />`;
    })}
  </div>`;
}

function MemberSheet({ open, m, snap, me, admin, bal, hasMoney, invite, now, hidden, onClose, onPickContact }) {
  const [busy, setBusy] = useState(false);
  // Keep the last member while the sheet animates out.
  const [shown, setShown] = useState(m);
  useEffect(() => {
    if (m) setShown(m);
  }, [m]);
  const x = m || shown;
  if (!x) return html`<${Sheet} open=${false} onClose=${onClose} title="" />`;

  const name = displayName(x);
  const mine = x.id === me.id;
  const chat = x.phone ? whatsappChatUrl(x.phone) : null;
  const itemById = new Map((snap.items || []).map((i) => [i.id, i]));
  const taking = (snap.pledges || [])
    .filter((p) => p.member_id === x.id)
    .map((p) => ({ p, item: itemById.get(p.item_id) }))
    .filter(({ item }) => item && item.status !== 'rejected' && item.type !== 'each');
  const many = perPerson(x);
  const canRole = admin && x.role !== 'owner' && !many; // a single profile: the whole profile (set_role)
  const canCrown = admin && many; // a couple / family: per person (set_person_admin)
  const canRemove = admin && x.role !== 'owner' && !mine;
  // nobody took this profile yet: it can't be crowned (the server refuses) — the sheet says why instead of the button
  const waitsToJoin = canRole && !isAdmin(x) && x.claimed === false;

  const setRole = async (role) => {
    if (role === 'member' && mine) {
      const yes = await confirmDialog({
        title: 'להסיר לעצמך את הניהול?',
        text: 'לא תוכל/י יותר לאשר הצעות או לשבץ — עד שמישהו ימנה אותך מחדש.',
        confirmText: 'כן, להסיר',
      });
      if (!yes) return;
    }
    setBusy(true);
    await actions.run((api) => api.setRole(x.id, role), {
      success: role === 'admin' ? `${name} מנהל/ת עכשיו 👑` : `${name} כבר לא מנהל/ת`,
      error: (code) => (code === 'not_allowed_state' && role === 'admin' ? notInYet(name) : hebrewError(code)),
    });
    setBusy(false);
  };

  const remove = async () => {
    const yes = await confirmDialog({
      title: `להסיר את ${name} מהטיול?`,
      text: 'השיבוצים וההצבעות שלהם יימחקו. אי אפשר לבטל.',
      confirmText: 'הסרה',
      danger: true,
    });
    if (!yes) return;
    setBusy(true);
    const done = await actions.run(
      async (api) => {
        await api.removeMember(x.id);
        return true;
      },
      { success: `${name} הוסר/ה מהטיול` },
    );
    setBusy(false);
    if (done) onClose();
  };

  const statusLine = x.claimed ? `הצטרפ/ה ${timeAgo(x.created_at)}` : 'עוד לא נכנס/ה מהקישור';
  const people = (x.people || []).filter(Boolean);
  const persons = many ? personsOf(x) : [];
  // a couple / family: WhatsApp / phone per person in the rows below (the profile's phone when theirs isn't known)
  const rowContact = persons.some((p) => p.joined && !isMyRow(snap, x, p));

  return html`<${Sheet} open=${open} onClose=${onClose} title=${name} class="ppl-sheet">
    <div class="stack">
      <div class="ppl-sheet__hero">
        <${Avatar} member=${x} size=${68} />
        <div class="ppl-sheet__who">
          ${people.length ? html`<span class="ppl-sheet__people">${people.join(' · ')}</span>` : null}
          <div class="ppl-card__pills">
            <${Pill} tone="primary">${(x.headcount || 1) >= 2 ? `👫 ${x.headcount} אנשים` : '🧍 יחיד/ה'}</${Pill}>
            ${!many && roleLabel(x) ? html`<${Pill} tone="accent">${roleLabel(x)}</${Pill}>` : null}
          </div>
          <span class="tiny muted">${statusLine}</span>
        </div>
      </div>

      ${x.phone && !mine && !rowContact
        ? html`<div class="ppl-sheet__contact">
            ${chat
              ? html`<${Button} variant="share" icon="💬" href=${chat} target="_blank" rel="noopener noreferrer">וואטסאפ</${Button}>`
              : null}
            <${Button} variant="secondary" icon="phone" href=${`tel:${String(x.phone).replace(/[^\d+]/g, '')}`}>חיוג</${Button}>
            <bdi class="ppl-sheet__phone num" dir="ltr">${x.phone}</bdi>
          </div>`
        : null}

      ${many
        ? html`<section class="ppl-sheet__section" aria-label="מי בפרופיל">
            <h3 class="ppl-sheet__h">👥 מי בפרופיל</h3>
            <ul class="ppl-persons ppl-persons--sheet">
              ${persons.map((p) => html`<${PersonRow} key=${p.name} m=${x} p=${p} snap=${snap} me=${isMyRow(snap, x, p)}
                canInvite=${admin || mine} now=${now} hidden=${hidden} invite=${invite} />`)}
            </ul>
          </section>`
        : null}

      ${!x.claimed && admin
        ? html`<div class="ppl-sheet__invite">
            <p class="small">📨 ${name} עוד לא בפנים. שלחו הזמנה אישית — הם יבחרו ״זה אני!״ וזהו.</p>
            <${ShareButton} text=${unclaimedInviteText(snap.trip, x, invite)} label=${`שליחת הזמנה ל${name}`} block />
            ${contactsAvailable() && onPickContact
              ? html`<${Button} variant="secondary" block class="ppl-sheet__from-past" onClick=${() => onPickContact(x.id)}>➕ לבחור מטיולים קודמים</${Button}>`
              : null}
          </div>`
        : null}

      <section class="ppl-sheet__section" aria-label="מה מביאים">
        <h3 class="ppl-sheet__h">🎒 ${mine ? 'מה אני מביא/ה' : 'מה מביאים'}</h3>
        ${taking.length
          ? html`<ul class="ppl-take">
              ${taking.map(({ p, item }) => {
                const done = item.type === 'bring' ? p.done : item.done;
                const qty = item.type === 'bring' && item.needed > 1 ? `×${p.qty}` : item.qty ? formatQty(item.qty, item.unit) : '';
                return html`<li key=${p.id}>
                  <a class="ppl-take__row" href=${`#/t/${snap.trip.id}/lists?item=${item.id}`}>
                    <span class="ppl-take__type" aria-hidden="true">${item.type === 'buy' ? '🛒' : item.type === 'task' ? '✅' : '🎒'}</span>
                    <span class="ppl-take__title">${item.title}</span>
                    ${qty ? html`<bdi class="ppl-take__qty num">${qty}</bdi>` : null}
                    ${item.status === 'proposed' ? html`<${Pill} tone="warning">ממתין</${Pill}>` : null}
                    ${done ? html`<${Pill} tone="success">✓ ${item.type === 'buy' ? 'נקנה' : item.type === 'task' ? 'בוצע' : 'ארוז'}</${Pill}>` : null}
                  </a>
                </li>`;
              })}
            </ul>`
          : html`<p class="muted small">עוד לא לקח/ה על עצמו/ה כלום.</p>`}
      </section>

      ${(x.inventory || []).length
        ? html`<section class="ppl-sheet__section" aria-label="יש בבית">
            <h3 class="ppl-sheet__h">🏠 יש בבית</h3>
            <div class="ppl-sheet__chips">${x.inventory.map((it) => html`<span class="chip chip--muted" key=${it}>${it}</span>`)}</div>
          </section>`
        : null}

      ${x.prefs?.diet
        ? html`<section class="ppl-sheet__section" aria-label="אוכל והעדפות">
            <h3 class="ppl-sheet__h">🍽️ אוכל והעדפות</h3>
            <p class="small">${x.prefs.diet}</p>
          </section>`
        : null}

      ${hasMoney && bal
        ? html`<a class="ppl-money" href=${`#/t/${snap.trip.id}/money`}>
            <span class="ppl-money__cell"><span class="ppl-money__v">${money(bal.paid)}</span><span class="ppl-money__l">שילמו</span></span>
            <span class="ppl-money__cell"><span class="ppl-money__v">${money(bal.owed)}</span><span class="ppl-money__l">החלק שלהם</span></span>
            <span class=${cx('ppl-money__cell', (bal.net ?? 0) >= 1 && 'is-plus', (bal.net ?? 0) <= -1 && 'is-minus')}>
              <span class="ppl-money__v">${money(bal.net ?? 0)}</span><span class="ppl-money__l">מאזן</span>
            </span>
          </a>`
        : null}

      ${(admin || mine) && open ? html`<${PrivateDetails} key=${x.id} x=${x} snap=${snap} admin=${admin} mine=${mine} />` : null}

      ${canRole || canCrown || canRemove
        ? html`<section class="ppl-sheet__admin" aria-label="ניהול">
            <h3 class="ppl-sheet__h">🛠️ ניהול</h3>
            ${canCrown
              ? html`<p class="tiny muted">👑 מנהלים — לכל אחד/ת בנפרד. מי שמצטרף/ת לפרופיל לא מקבל/ת ניהול לבד.</p>
                  <${PersonCrowns} m=${x} snap=${snap} />`
              : null}
            ${waitsToJoin ? html`<p class="small muted" data-testid="crown-wait">👑 ${notInYet(name)}</p>` : null}
            <div class="ppl-sheet__admin-actions">
              ${canRole && !waitsToJoin
                ? isAdmin(x)
                  ? html`<${Button} variant="secondary" disabled=${busy} onClick=${() => setRole('member')}>הסר ניהול</${Button}>`
                  : html`<${Button} variant="primary" icon="crown" disabled=${busy} onClick=${() => setRole('admin')}>מנה למנהל/ת</${Button}>`
                : null}
              ${canRemove
                ? html`<${Button} variant="ghost" icon="trash" class="ppl-danger" disabled=${busy} onClick=${remove}>הסרה מהטיול</${Button}>`
                : null}
            </div>
          </section>`
        : null}
      ${x.role === 'owner' && !many ? html`<p class="tiny muted">👑 יוצר/ת הטיול תמיד נשאר/ת מנהל/ת.</p>` : null}
    </div>
  </${Sheet}>`;
}

const MAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s.]{2,}$/;
const MODE_TEXT = { car: '🚗 נוהג/ת', need: '🙋 מחפש/ת מקום', own: '🧍 מגיע/ה לבד', seat: '✅ ברכב של מישהו' };

/** Admins (and the member): e-mails and whether they're verified, devices, push, how they get there —
 *  and editing phone + e-mails. */
function PrivateDetails({ x, snap, admin, mine }) {
  const [d, setD] = useState(undefined); // undefined = loading, null = failed
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState(x.phone || '');
  const [emails, setEmails] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => actions.run((api) => api.memberDetails(x.id), { refresh: false, error: () => 'לא הצלחנו לטעון את הפרטים' })
    .then((r) => setD(r || null));
  useEffect(() => { load(); }, [x.id]);

  const rides = rideModel(snap, x.id);
  const mode = x.prefs?.transport?.mode;
  const arrive = rides.myRide ? `🚗 נוהג/ת (${hebrewCount(rides.myRide.free, 'מקום פנוי', 'מקומות פנויים')})`
    : rides.mySeat ? `✅ עם ${displayName(rides.mySeat.driver)}` : rides.myAsk ? `⏳ ביקש/ה מקום אצל ${displayName(rides.myAsk.driver)}`
      : MODE_TEXT[mode] || '— עוד לא סימן/ה';
  const flight = x.prefs?.travel?.out?.flight;

  const startEdit = () => {
    setPhone(x.phone || '');
    setEmails((d?.emails || []).join('\n'));
    setError(null);
    setEditing(true);
  };
  const save = async (e) => {
    e?.preventDefault();
    const list = [...new Set(emails.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
    const bad = list.find((m) => !MAIL_RE.test(m));
    if (bad) return setError(`המייל ${bad} לא נראה תקין`);
    setBusy(true);
    const ok = await actions.run(async (api) => {
      if ((phone.trim() || null) !== (x.phone || null)) await api.updateMember(x.id, { phone: phone.trim() || null });
      await api.setMemberEmails(x.id, list);
      return true;
    }, { success: 'הפרטים נשמרו ✅' });
    setBusy(false);
    if (ok) {
      setEditing(false);
      load();
    }
    return undefined;
  };

  const verified = new Set(d?.verified || []);
  const all = [...new Set([...(d?.verified || []), ...(d?.emails || [])])];
  return html`<section class="ppl-sheet__section ppl-private" aria-label="פרטים" data-testid="private-details">
    <h3 class="ppl-sheet__h">🔐 ${mine && !admin ? 'הפרטים שלך' : 'פרטים (רק מנהלים רואים)'}</h3>
    ${d === undefined
      ? html`<${Skeleton} lines=${2} />`
      : editing
        ? html`<form class="stack" onSubmit=${save} noValidate>
            <${Field} label="טלפון"><${TextInput} type="tel" dir="ltr" value=${phone} maxlength="20" placeholder="050-1234567" onInput=${(e) => setPhone(e.target.value)} /></${Field}>
            <${Field} label="מיילים לעדכונים (אחד בשורה)" hint="מקבלים את העדכונים של הפרופיל. מייל מאומת (✅) מחובר למכשיר ולא נמחק מכאן.">
              <${TextArea} dir="ltr" rows=${3} value=${emails} onInput=${(e) => setEmails(e.target.value)} />
            </${Field}>
            ${error ? html`<p class="field__error" role="alert">${error}</p>` : null}
            <div class="row wrap">
              <${Button} type="submit" size="sm" loading=${busy}>שמירה</${Button}>
              <${Button} variant="ghost" size="sm" onClick=${() => setEditing(false)}>ביטול</${Button}>
            </div>
          </form>`
        : html`<ul class="ppl-private__list">
            <li>✉️ ${all.length
              ? all.map((m, i) => html`${i ? ' · ' : ''}<bdi dir="ltr">${m}</bdi> ${verified.has(m) ? html`<span class="ppl-ok">✅ מאומת</span>` : html`<span class="muted">(לא אומת)</span>`}`)
              : html`<span class="ppl-warn">⚠️ אין מייל — לא יקבלו עדכונים במייל</span>`}</li>
            <li>📞 ${x.phone ? html`<bdi dir="ltr">${x.phone}</bdi>` : html`<span class="muted">אין טלפון</span>`}</li>
            ${d ? html`<li>📱 ${hebrewCount(d.devices, 'מכשיר מחובר', 'מכשירים מחוברים')} · 🔔 ${d.push ? `פוש פעיל (${d.push})` : 'פוש לא הופעל'}</li>` : null}
            <li>🧭 ${arrive}${flight ? html` · ✈️ <bdi dir="ltr">${flight}</bdi>` : ''}</li>
            <li>📝 ${x.prefs?.onboarded ? 'מילא/ה את פרטי ההצטרפות ✓' : 'עוד לא מילא/ה את פרטי ההצטרפות'}</li>
          </ul>
          <${Button} variant="secondary" size="sm" icon="edit" onClick=${startEdit}>עריכת טלפון ומיילים</${Button}>`}
  </section>`;
}

// ---------------------------------------------------------------------------
// admin election
// ---------------------------------------------------------------------------

const ROLE_RANK = { owner: 0, admin: 1, member: 2 };

function Election({ snap, me, admin }) {
  const [optimistic, setOptimistic] = useState({});
  const [busy, setBusy] = useState(null);
  const [choosing, setChoosing] = useState({ open: false, id: null }); // a couple / family: whom to crown
  const counts = adminVoteCounts(snap);
  const myVotes = new Set((snap.admin_votes || []).filter((v) => v.voter_id === me.id).map((v) => v.candidate_id));
  const voted = (id) => (id in optimistic ? optimistic[id] : myVotes.has(id));
  const countOf = (id) => (counts.get(id) || 0) + (id in optimistic ? Number(optimistic[id]) - Number(myVotes.has(id)) : 0);
  const members = [...snap.members].sort((a, b) => (ROLE_RANK[a.role] ?? 2) - (ROLE_RANK[b.role] ?? 2));
  const top = Math.max(0, ...members.filter((m) => !isAdmin(m)).map((m) => countOf(m.id)));

  const toggle = async (m) => {
    if (m.id in optimistic) return; // one vote call per candidate at a time
    const next = !voted(m.id);
    setOptimistic((o) => ({ ...o, [m.id]: next }));
    await actions.run(async (api) => {
      await api.voteAdmin(m.id, next);
      return true;
    });
    setOptimistic((o) => {
      const c = { ...o };
      delete c[m.id];
      return c;
    });
  };

  const setRole = async (m, role) => {
    // nobody took this profile yet: say why, instead of a request the server refuses
    if (role === 'admin' && m.claimed === false) {
      actions.toast(notInYet(displayName(m)), 'info', 4200);
      return;
    }
    setBusy(m.id);
    await actions.run((api) => api.setRole(m.id, role), {
      success: role === 'admin' ? `${displayName(m)} מנהל/ת עכשיו 👑` : `${displayName(m)} כבר לא מנהל/ת`,
      error: (code) => (code === 'not_allowed_state' && role === 'admin' ? notInYet(displayName(m)) : hebrewError(code)),
    });
    setBusy(null);
  };
  const iAmOwner = snap.me?.role === 'owner';
  /** Who holds the rights in a couple / family: "👑 מנהל/ת: מאיה". */
  const crowned = (m) => {
    const names = personsOf(m).filter((p) => p.admin).map((p) => p.name);
    return names.length ? `${crownLabel(m)}: ${names.join(', ')}` : null;
  };
  const chooser = choosing.id ? snap.members.find((m) => m.id === choosing.id) : null;
  const closeChooser = () => setChoosing((c) => ({ ...c, open: false }));

  // once there's an admin (there always is), the election is one row that opens in place (ux P3)
  const adminNames = adminPersons(snap).map((a) => a.name).filter(Boolean);
  return html`<${Fold} emoji="👑" title=${adminNames.length ? `מנהלים: ${adminNames.join(', ')}` : 'בחירת מנהלים'} meta="הצבעה"
    class="ppl-elect" data-testid="election">
    <p class="muted small ppl-elect__lead">
      מי ינהל את הרשימות, יאשר הצעות וישבץ? הצביעו 👍 למי שתרצו — אפשר לכמה.
      ${admin ? ' המנהלים ממנים לפי התוצאות.' : ''}
    </p>
    <ul class="ppl-elect__list">
      ${members.map((m) => {
        const on = voted(m.id);
        const count = countOf(m.id);
        const leading = !isAdmin(m) && top > 0 && count === top;
        const many = perPerson(m);
        const role = many ? crowned(m) : roleLabel(m);
        const crownable = admin && many && (m.role !== 'owner' || iAmOwner);
        return html`<li key=${m.id} class=${cx('ppl-elect__row', leading && 'is-leading', isAdmin(m) && 'is-admin')}>
          <${Avatar} member=${m} size=${38} />
          <div class="ppl-elect__main">
            <span class="ppl-elect__name">${displayName(m)}${m.id === me.id ? ' (את/ה)' : ''}</span>
            <span class="ppl-elect__sub">
              ${role || (leading ? '🔥 מוביל/ה בהצבעה' : count ? hebrewCount(count, 'קול', 'קולות') : 'חבר/ה')}
            </span>
            ${crownable
              ? html`<button type="button" class="link ppl-elect__role" onClick=${() => setChoosing({ open: true, id: m.id })}>
                  ${personsOf(m).some((p) => p.admin) ? '👑 מי מנהל/ת?' : '👑 מנה למנהל/ת'}
                </button>`
              : admin && m.role !== 'owner' && !many
              ? html`<button
                  type="button"
                  class=${cx('link', 'ppl-elect__role', isAdmin(m) && 'is-demote')}
                  disabled=${busy === m.id}
                  onClick=${() => setRole(m, isAdmin(m) ? 'member' : 'admin')}
                >${isAdmin(m) ? 'הסר ניהול' : '👑 מנה למנהל/ת'}</button>`
              : null}
          </div>
          <button
            type="button"
            class=${cx('ppl-vote', on && 'is-on')}
            aria-pressed=${on ? 'true' : 'false'}
            aria-busy=${m.id in optimistic ? 'true' : undefined}
            aria-label=${`הצבעה ל${displayName(m)} כמנהל/ת (${hebrewCount(count, 'קול', 'קולות')})`}
            onClick=${() => toggle(m)}
          >
            <span class="ppl-vote__icon" aria-hidden="true">👍</span>
            <span class="ppl-vote__count num" aria-hidden="true">${count}</span>
          </button>
        </li>`;
      })}
    </ul>
    <${Sheet} open=${choosing.open && Boolean(chooser)} onClose=${closeChooser} title=${chooser ? `👑 מי מנהל/ת ב״${displayName(chooser)}״?` : ''}>
      ${chooser
        ? html`<div class="stack">
            <p class="muted small">כל אחד/ת בנפרד — ממנים רק מי שכבר נכנס/ה מהטלפון שלו/ה.</p>
            <${PersonCrowns} m=${chooser} snap=${snap} />
          </div>`
        : null}
    </${Sheet}>
  </${Fold}>`;
}

// ---------------------------------------------------------------------------
// invite + admin tools
// ---------------------------------------------------------------------------

function InviteCard({ trip, url, admin, tripId, onContacts }) {
  const [busy, setBusy] = useState(false);
  const rotate = async () => {
    const yes = await confirmDialog({
      title: 'ליצור קישור הזמנה חדש?',
      text: 'הקישור הנוכחי יפסיק לעבוד. מי שכבר בפנים — נשאר בפנים.',
      confirmText: 'קישור חדש',
    });
    if (!yes) return;
    setBusy(true);
    await actions.run((api) => api.rotateInvite(tripId), { success: 'נוצר קישור חדש 🔗 הקודם כבר לא עובד' });
    setBusy(false);
  };
  return html`<${Card} emoji="🔗" title="הזמנת חברים" class="ppl-invite">
    <p class="muted small">שולחים את הקישור בקבוצה — כל אחד נכנס, בוחר פרופיל ומתחיל לסמן מה מביא ✋</p>
    <div class="ppl-invite__actions">
      <${ShareButton} text=${buildInviteText(trip, url)} label="שליחה בוואטסאפ" />
      <${CopyButton} text=${url} label="העתקה" />
    </div>
    ${admin
      ? html`<${Button} variant="ghost" size="sm" icon="refresh" class="ppl-invite__rotate" loading=${busy} onClick=${rotate}>
          קישור חדש (מבטל את הקודם)
        </${Button}>`
      : null}
    ${admin && contactsAvailable()
      ? html`<${Button} variant="secondary" block class="ppl-invite__past" onClick=${onContacts}>➕ מטיולים קודמים</${Button}>
`
      : null}
  </${Card}>`;
}

// ---------------------------------------------------------------------------
// invites from past trips (SPEC §16): an admin picks people they've travelled with
// ---------------------------------------------------------------------------

let contactsOff = false; // an older server without trip_contacts → hide the entry points
const contactsAvailable = () => !contactsOff && typeof store.get().api?.tripContacts === 'function';

const CONTACT_STATE = { member: '✓ כבר בטיול', invited: '⏳ הוזמן/ה', declined: 'סירב/ה לאחרונה', recent: 'הוזמן/ה לאחרונה' };
const MAX_INVITES = 30;

function ContactsSheet({ open, tripId, memberId, target, onClose }) {
  const single = Boolean(memberId);
  const [list, setList] = useState(undefined); // undefined = loading, null = failed
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState([]);
  const [busy, setBusy] = useState(false);
  useLayoutEffect(() => {
    if (!open) return undefined;
    setQ('');
    setChosen([]);
    setList(undefined);
    let alive = true;
    store.get().api.tripContacts(tripId).then(
      (rows) => alive && setList(rows || []),
      (e) => {
        if (!alive) return;
        const err = toApiError(e);
        // "function does not exist" on an older server → no more entry points this session
        if (err.code !== 'network' && /function|schema cache/i.test(String(err.detail || e?.message || ''))) contactsOff = true;
        setList(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [open, tripId, memberId]);

  const query = norm(q);
  const rows = (list || []).filter((c) => !query || norm(c.name).includes(query) || norm(c.email_hint).includes(query)
    || (c.trips || []).some((t) => norm(t.name).includes(query)));
  const toggle = (key) => setChosen((c) => {
    if (c.includes(key)) return c.filter((k) => k !== key);
    if (single) return [key];
    return c.length >= MAX_INVITES ? c : [...c, key];
  });
  const send = async () => {
    if (!chosen.length) return;
    setBusy(true);
    const res = await actions.run((api) => api.inviteContacts(tripId, chosen, { memberId: memberId || null }), {
      error: (code) => (code === 'limit_reached' ? 'הטיול מלא — עד 60 פרופילים'
        : code === 'rate_limited' ? 'הרבה הזמנות היום — אפשר להמשיך מחר 🙏'
          : code === 'not_allowed_state' ? 'לפרופיל הזה כבר מחכה הזמנה' : hebrewError(code)),
    });
    setBusy(false);
    if (!res) return;
    const skipped = (res.skipped || []).length;
    const n = Number(res.invited) || 0;
    actions.toast(n
      ? `${n === 1 ? 'נשלחה הזמנה אחת' : `נשלחו ${n} הזמנות`} 📨 — נעדכן כשיענו${skipped ? `, ${skipped} כבר היו` : ''}`
      : 'כולם כבר הוזמנו או בפנים 🙂', 'success', 3600);
    onClose();
  };
  const title = single ? `➕ מי זה ${target ? displayName(target) : ''}?` : '➕ מטיולים קודמים';
  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title=${title}
    class="ppl-contacts"
    footer=${list && list.length
      ? html`<${Button} variant="accent" size="lg" block loading=${busy} disabled=${!chosen.length} onClick=${send}>
          ${single ? 'שליחת הזמנה' : `שליחת הזמנה (${chosen.length})`}
        </${Button}>`
      : null}
  >
    ${list === undefined
      ? html`<${Skeleton} lines=${4} />`
      : list === null
        ? html`<${EmptyState} emoji="📶" title="לא הצלחנו לטעון" text="בדקו את החיבור ונסו שוב עוד רגע." />`
        : !list.length
          ? html`<${EmptyState} emoji="🧭" title="עוד אין חברים מטיולים קודמים"
              text="אחרי טיול משותף הם יופיעו כאן. בינתיים — קישור ההזמנה 👆" />`
          : html`<div class="stack-sm">
              <p class="muted small">${single
                ? 'בוחרים מי זה — ההזמנה תחכה להם, וכשיאשרו הם נכנסים לפרופיל הזה.'
                : 'רק מי שטייל איתך. מקבלים הזמנה במייל ובהתראה — ומצטרפים בלחיצה.'}</p>
              ${list.length > 6
                ? html`<${TextInput} type="search" value=${q} placeholder="חיפוש שם או טיול" aria-label="חיפוש חברים מטיולים קודמים"
                    onInput=${(e) => setQ(e.target.value)} />`
                : null}
              <ul class="ppl-contacts__list">
                ${rows.map((c) => {
                  const off = Boolean(c.state);
                  const on = chosen.includes(c.key);
                  const where = (c.trips || []).slice(0, 2).map((t) => `${t.emoji || '⛺'} ${t.name}`).join(' · ');
                  return html`<li key=${c.key}>
                    <label class=${cx('ppl-contact', on && 'is-on', off && 'is-off')}>
                      <input type=${single ? 'radio' : 'checkbox'} name="ppl-contact" checked=${on} disabled=${off}
                        onChange=${() => toggle(c.key)} aria-label=${c.name} />
                      <span class="ppl-contact__main">
                        <span class="ppl-contact__name">${c.name}</span>
                        <span class="ppl-contact__sub tiny muted"><bdi dir="ltr">${c.email_hint || ''}</bdi>${where ? ` · ${where}` : ''}</span>
                      </span>
                      ${off ? html`<${Pill} tone=${c.state === 'member' ? 'success' : 'default'}>${CONTACT_STATE[c.state] || c.state}</${Pill}>` : null}
                    </label>
                  </li>`;
                })}
              </ul>
              ${!rows.length ? html`<p class="muted small">לא מצאנו… 🤔</p>` : null}
            </div>`}
  </${Sheet}>`;
}

/** "⏳ הוזמנו": pending invitations (everyone sees names; admins see the e-mail hint and can cancel). */
function InvitedSection({ snap, admin, now }) {
  const list = snap.invites || [];
  if (!list.length) return null;
  const cancel = async (inv) => {
    const yes = await confirmDialog({
      title: `לבטל את ההזמנה של ${inv.name}?`,
      text: 'ההזמנה תיסגר. אפשר להזמין שוב אחר כך.',
      confirmText: 'ביטול ההזמנה',
      cancelText: 'השארה',
    });
    if (!yes) return;
    await actions.run((api) => api.cancelInvite(inv.id), { success: 'ההזמנה בוטלה' });
  };
  return html`<${Card} emoji="⏳" title=${`הוזמנו (${list.length})`} class="ppl-invited">
    <ul class="ppl-invited__list">
      ${list.map((inv) => html`<li key=${inv.id} class="ppl-invited__row">
        <span class="ppl-invited__main">
          <span class="ppl-invited__name">${inv.name} <${Pill}>⏳ הוזמן/ה</${Pill}></span>
          <span class="tiny muted">${[inv.invited_by_name ? `הוזמן/ה ע״י ${inv.invited_by_name}` : null, timeAgo(inv.created_at, now)].filter(Boolean).join(' · ')}${admin && inv.email_hint ? html` · <bdi dir="ltr">${inv.email_hint}</bdi>` : null}</span>
        </span>
        ${admin ? html`<${Button} variant="ghost" size="sm" onClick=${() => cancel(inv)} aria-label=${`ביטול ההזמנה של ${inv.name}`}>ביטול</${Button}>` : null}
      </li>`)}
    </ul>
  </${Card}>`;
}


function AdminTools({ onAdd }) {
  return html`<${Card} emoji="🛠️" title="כלים למנהלים" class="ppl-tools">
    <button type="button" class="ppl-tool" onClick=${onAdd}>
      <span class="ppl-tool__icon" aria-hidden="true">➕</span>
      <span class="ppl-tool__text">
        <span class="ppl-tool__title">הוספת פרופיל לחבר/ה</span>
        <span class="ppl-tool__hint">למי שעוד לא נכנס — כשייכנסו מהקישור יבחרו ״זה אני!״</span>
      </span>
      <${Icon} name="chevron-left" size=${18} />
    </button>
    <p class="tiny muted ppl-tools__hint">👆 כדי למנות מנהל/ת או להסיר מישהו — לחצו על הכרטיס שלו/ה למעלה.</p>
  </${Card}>`;
}

function AddProfileSheet({ open, tripId, onClose, onCreated }) {
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const formId = useFormId('ppl-add');
  useEffect(() => {
    if (open) setRound((r) => r + 1);
  }, [open]);
  const submit = async (profile) => {
    setBusy(true);
    const id = await actions.run((api) => api.createMember(tripId, profile), {
      success: `הפרופיל של ${profile.display_name} נוסף 🎉`,
    });
    setBusy(false);
    if (id) onCreated(id);
  };
  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title="➕ פרופיל לחבר/ה"
    footer=${html`<${Button} type="submit" form=${formId} variant="accent" size="lg" block loading=${busy}>הוספה</${Button}>`}
  >
    <p class="muted small ppl-add__lead">יוצרים פרופיל מראש, משבצים לו דברים — וכשהם נכנסים מהקישור, הכל כבר מחכה להם.</p>
    <${ProfileForm} key=${round} id=${formId} allowFamily onSubmit=${submit} />
  </${Sheet}>`;
}
