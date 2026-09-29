// People (SPEC §8.9): who's coming (stats), member cards (role, claimed, what they bring,
// balance, WhatsApp), a "who has X at home?" search, the admin election (votes + promote /
// demote), the invite link, and admin tools (add a placeholder profile, remove a member).
import { html } from 'htm/preact';
import { useState, useMemo, useEffect } from 'preact/hooks';
import { useTrip, actions } from '../store.js?v=6582265';
import {
  Avatar, AvatarStack, Button, Card, CopyButton, Field, Pill, Sheet, ShareButton, Skeleton,
  TextArea, TextInput, confirmDialog,
} from '../ui/components.js?v=6582265';
import { Icon } from '../ui/icons.js?v=6582265';
import {
  adminVoteCounts, balances, buildInviteText, displayName, formatMoney, formatQty, headcountTotal,
  hebrewCount, inviteUrl, isAdmin, membersById, rideModel, timeAgo, whatsappChatUrl,
} from '../lib/logic.js?v=6582265';
import { ProfileForm } from './me.js?v=6582265';

const cx = (...a) => a.filter(Boolean).join(' ');

let seq = 0;
const useFormId = (prefix) => useState(() => `${prefix}-${++seq}`)[0];

const appBase = () => `${location.origin}${location.pathname}`;
const norm = (s) => String(s || '').trim().toLowerCase();
const money = (n) => html`<bdi class="num">${formatMoney(n)}</bdi>`;
/** Link text without the scheme, so the interesting end (the code) fits. */
const shortUrl = (u) => String(u).replace(/^https?:\/\//, '');
const roleLabel = (m) => (m.role === 'owner' ? '👑 יוצר/ת הטיול' : m.role === 'admin' ? '👑 מנהל/ת' : null);

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
  useEffect(() => {
    if (route?.query?.member) setSheet({ open: true, id: route.query.member });
  }, [route?.query?.member]);

  const byId = useMemo(() => membersById(snap.members), [snap.members]);
  const counts = useMemo(() => pledgeCounts(snap), [snap.items, snap.pledges]);
  const bal = useMemo(() => new Map(balances(snap).map((b) => [b.member_id, b])), [snap]);
  const hasMoney = (snap.expenses || []).length > 0 || (snap.payments || []).length > 0;
  const invite = inviteUrl(appBase(), snap.trip.invite_code);

  const ordered = [...snap.members].sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : 0));
  const query = norm(q);
  const rows = ordered.map((m) => ({ m, ...memberMatches(m, query) })).filter((r) => r.hit);
  const invHits = query ? rows.filter((r) => r.inv.length) : [];

  const open = (id) => setSheet({ open: true, id });
  const sheetMember = sheet.id ? byId.get(sheet.id) : null;

  return html`<div class="screen ppl-screen">
    <${Stats} members=${snap.members} />

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
      ${rows.map(({ m, inv }) => html`<${PersonCard}
        key=${m.id}
        m=${m}
        meId=${me.id}
        count=${counts.get(m.id) || 0}
        bal=${hasMoney ? bal.get(m.id) : null}
        invHits=${inv}
        onOpen=${() => open(m.id)}
      />`)}
    </div>

    <${Election} snap=${snap} me=${me} admin=${admin} />
    <${InviteCard} trip=${snap.trip} url=${invite} admin=${admin} tripId=${tripId} />
    ${admin ? html`<${AdminTools} onAdd=${() => setAdding(true)} />` : null}

    <${MemberSheet}
      open=${sheet.open && Boolean(sheetMember)}
      m=${sheetMember}
      snap=${snap}
      me=${me}
      admin=${admin}
      bal=${sheetMember ? bal.get(sheetMember.id) : null}
      hasMoney=${hasMoney}
      invite=${invite}
      onClose=${() => setSheet({ ...sheet, open: false })}
    />
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

function Stats({ members }) {
  const heads = headcountTotal(members);
  const sizes = members.map((m) => Number(m.headcount) || 1);
  const couples = sizes.filter((h) => h === 2).length;
  const singles = sizes.filter((h) => h === 1).length;
  const families = sizes.filter((h) => h > 2).length;
  const admins = members.filter(isAdmin).length;
  const waiting = members.filter((m) => !m.claimed).length;
  const parts = [
    hebrewCount(heads, 'איש', 'אנשים'),
    couples ? hebrewCount(couples, 'זוג', 'זוגות') : null,
    singles ? hebrewCount(singles, 'יחיד', 'יחידים') : null,
    families ? hebrewCount(families, 'משפחה', 'משפחות') : null,
  ].filter(Boolean);
  return html`<section class="hero ppl-hero" aria-label="מי מגיע">
    <div class="ppl-hero__top">
      <div class="ppl-hero__text">
        <span class="ppl-hero__kicker">החבר'ה סביב המדורה 🔥</span>
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
      <${AvatarStack} members=${members} max=${7} size=${34} />
      <div class="ppl-hero__pills">
        <${Pill}>${admins === 1 ? '👑 מנהל/ת אחד/ת' : `👑 ${admins} מנהלים`}</${Pill}>
        ${waiting ? html`<${Pill}>⏳ ${waiting} עוד לא נכנסו</${Pill}>` : null}
      </div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// member card + sheet
// ---------------------------------------------------------------------------

function BalancePill({ b }) {
  if (!b) return null;
  if (b.balance >= 0.5) return html`<${Pill} tone="success">💰 מגיע ${money(b.balance)}</${Pill}>`;
  if (b.balance <= -0.5) return html`<${Pill} tone="accent">💸 צריך להעביר ${money(-b.balance)}</${Pill}>`;
  return html`<${Pill}>✨ מאוזן/ת</${Pill}>`;
}

function PersonCard({ m, meId, count, bal, invHits, onOpen }) {
  const mine = m.id === meId;
  const name = displayName(m);
  const people = (m.people || []).filter(Boolean);
  const peopleLine = people.length > 1 && people.join(' ו') !== name ? people.join(' · ') : null;
  const chat = !mine && m.phone ? whatsappChatUrl(m.phone) : null;
  const inv = m.inventory || [];
  const invShown = invHits.length ? invHits : inv.slice(0, 4);
  const invMore = inv.length - invShown.length;
  const role = roleLabel(m);
  return html`<article class=${cx('ppl-card', mine && 'ppl-card--me', !m.claimed && 'ppl-card--ghost', invHits.length && 'is-hit')}>
    <${Avatar} member=${m} size=${52} />
    <div class="ppl-card__main">
      <div class="ppl-card__head">
        <button type="button" class="ppl-card__name" onClick=${onOpen} aria-label=${`${name} — פרטים`}>${name}</button>
        ${mine ? html`<${Pill} tone="primary">את/ה</${Pill}>` : null}
        ${role ? html`<${Pill} tone="accent">${role}</${Pill}>` : null}
      </div>
      ${peopleLine ? html`<span class="ppl-card__people">${peopleLine}</span>` : null}
      <div class="ppl-card__pills">
        ${!m.claimed ? html`<${Pill} tone="warning">⏳ עוד לא נכנס/ה</${Pill}>` : null}
        ${count
          ? html`<${Pill} tone="primary">🎒 מביא/ה ${hebrewCount(count, 'פריט', 'פריטים')}</${Pill}>`
          : html`<${Pill}>עוד בלי פריטים</${Pill}>`}
        <${BalancePill} b=${bal} />
      </div>
      ${inv.length
        ? html`<p class="ppl-card__inv">
            <span aria-hidden="true">🏠 </span><span class="sr-only">יש בבית: </span>
            ${invShown.map((x, i) => html`${i ? ' · ' : ''}<span class=${cx(invHits.includes(x) && 'ppl-hit')}>${x}</span>`)}
            ${invMore > 0 ? html`<span class="muted"> · +${invMore}</span>` : null}
          </p>`
        : null}
      ${m.prefs?.diet ? html`<p class="ppl-card__diet"><span aria-hidden="true">🍽️ </span>${m.prefs.diet}</p>` : null}
    </div>
    ${chat
      ? html`<a class="ppl-card__chat" href=${chat} target="_blank" rel="noopener noreferrer" aria-label=${`וואטסאפ ל${name}`} title="וואטסאפ">
          <span aria-hidden="true">💬</span>
        </a>`
      : html`<span class="ppl-card__chev" aria-hidden="true"><${Icon} name="chevron-left" size=${18} /></span>`}
  </article>`;
}

function MemberSheet({ open, m, snap, me, admin, bal, hasMoney, invite, onClose }) {
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
  const canRole = admin && x.role !== 'owner';
  const canRemove = admin && x.role !== 'owner' && !mine;

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

  return html`<${Sheet} open=${open} onClose=${onClose} title=${name} class="ppl-sheet">
    <div class="stack">
      <div class="ppl-sheet__hero">
        <${Avatar} member=${x} size=${68} />
        <div class="ppl-sheet__who">
          ${people.length ? html`<span class="ppl-sheet__people">${people.join(' · ')}</span>` : null}
          <div class="ppl-card__pills">
            <${Pill} tone="primary">${(x.headcount || 1) >= 2 ? `👫 ${x.headcount} אנשים` : '🧍 יחיד/ה'}</${Pill}>
            ${roleLabel(x) ? html`<${Pill} tone="accent">${roleLabel(x)}</${Pill}>` : null}
          </div>
          <span class="tiny muted">${statusLine}</span>
        </div>
      </div>

      ${x.phone && !mine
        ? html`<div class="ppl-sheet__contact">
            ${chat
              ? html`<${Button} variant="share" icon="💬" href=${chat} target="_blank" rel="noopener noreferrer">וואטסאפ</${Button}>`
              : null}
            <${Button} variant="secondary" icon="phone" href=${`tel:${String(x.phone).replace(/[^\d+]/g, '')}`}>חיוג</${Button}>
            <bdi class="ppl-sheet__phone num" dir="ltr">${x.phone}</bdi>
          </div>`
        : null}

      ${!x.claimed && admin
        ? html`<div class="ppl-sheet__invite">
            <p class="small">📨 ${name} עוד לא בפנים. שלחו הזמנה אישית — הם יבחרו ״זה אני!״ וזהו.</p>
            <${ShareButton} text=${unclaimedInviteText(snap.trip, x, invite)} label=${`שליחת הזמנה ל${name}`} block />
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
            <span class=${cx('ppl-money__cell', bal.balance >= 0.5 && 'is-plus', bal.balance <= -0.5 && 'is-minus')}>
              <span class="ppl-money__v">${money(bal.balance)}</span><span class="ppl-money__l">מאזן</span>
            </span>
          </a>`
        : null}

      ${(admin || mine) && open ? html`<${PrivateDetails} key=${x.id} x=${x} snap=${snap} admin=${admin} mine=${mine} />` : null}

      ${canRole || canRemove
        ? html`<section class="ppl-sheet__admin" aria-label="ניהול">
            <h3 class="ppl-sheet__h">🛠️ ניהול</h3>
            <div class="ppl-sheet__admin-actions">
              ${canRole
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
      ${x.role === 'owner' ? html`<p class="tiny muted">👑 יוצר/ת הטיול תמיד נשאר/ת מנהל/ת.</p>` : null}
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
    setBusy(m.id);
    await actions.run((api) => api.setRole(m.id, role), {
      success: role === 'admin' ? `${displayName(m)} מנהל/ת עכשיו 👑` : `${displayName(m)} כבר לא מנהל/ת`,
    });
    setBusy(null);
  };

  return html`<${Card} emoji="👑" title="בחירת מנהלים" class="ppl-elect">
    <p class="muted small ppl-elect__lead">
      מי ינהל את הרשימות, יאשר הצעות וישבץ? הצביעו 👍 למי שתרצו — אפשר לכמה.
      ${admin ? ' המנהלים ממנים לפי התוצאות.' : ''}
    </p>
    <ul class="ppl-elect__list">
      ${members.map((m) => {
        const on = voted(m.id);
        const count = countOf(m.id);
        const leading = !isAdmin(m) && top > 0 && count === top;
        const role = roleLabel(m);
        return html`<li key=${m.id} class=${cx('ppl-elect__row', leading && 'is-leading', isAdmin(m) && 'is-admin')}>
          <${Avatar} member=${m} size=${38} />
          <div class="ppl-elect__main">
            <span class="ppl-elect__name">${displayName(m)}${m.id === me.id ? ' (את/ה)' : ''}</span>
            <span class="ppl-elect__sub">
              ${role || (leading ? '🔥 מוביל/ה בהצבעה' : count ? hebrewCount(count, 'קול', 'קולות') : 'חבר/ה')}
            </span>
            ${admin && m.role !== 'owner'
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
  </${Card}>`;
}

// ---------------------------------------------------------------------------
// invite + admin tools
// ---------------------------------------------------------------------------

function InviteCard({ trip, url, admin, tripId }) {
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
    <p class="muted small">שלחו את הקישור בקבוצה — כל אחד נכנס, בוחר פרופיל ומתחיל לסמן מה מביא ✋</p>
    <div class="ppl-linkbox" title=${url}><bdi dir="ltr">${shortUrl(url)}</bdi></div>
    <div class="ppl-invite__actions">
      <${ShareButton} text=${buildInviteText(trip, url)} label="שליחה בוואטסאפ" />
      <${CopyButton} text=${url} label="העתקה" />
    </div>
    ${admin
      ? html`<${Button} variant="ghost" size="sm" icon="refresh" class="ppl-invite__rotate" loading=${busy} onClick=${rotate}>
          קישור חדש (מבטל את הקודם)
        </${Button}>`
      : null}
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
