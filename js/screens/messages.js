// Messages (SPEC §8.8): the feed of announcements + system notices (unread / urgent styling,
// mark-read on open, read receipts for authors & admins), the admin composer (audience, urgent,
// share to WhatsApp) and polls (create, vote, live result bars, close / delete).
import { html } from 'htm/preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { useTrip, actions } from '../store.js';
import {
  Avatar, AvatarStack, Button, Card, Chip, EmptyState, Field, IconButton, MemberPicker, Pill,
  ProgressBar, Segmented, Sheet, ShareButton, Skeleton, TextArea, TextInput, Toggle, confirmDialog,
} from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import {
  displayName, membersById, visibleNotifications, pollResults, timeAgo, formatDate, formatDateTime,
  formatTime, hebrewCount,
} from '../lib/logic.js';

const cx = (...a) => a.filter(Boolean).join(' ');
const TZ = 'Asia/Jerusalem';

let seq = 0;
const useFormId = (prefix) => useState(() => `${prefix}-${++seq}`)[0];

/** Only in-app hash routes of a trip are followed (never arbitrary URLs from the database). */
const safeLink = (l) => (typeof l === 'string' && /^#\/t\/[^\s"'<>]+$/.test(l) ? l : null);

const appBase = () => `${location.origin}${location.pathname}`;

/** Re-render every minute so "לפני 5 דק׳" stays true while the screen is open. */
function useNow(ms = 60000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function dayKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : dayFmt.format(d);
}
function dayLabel(iso, now) {
  const key = dayKey(iso);
  if (key === dayKey(now)) return 'היום';
  if (key === dayKey(new Date(now.getTime() - 86400000))) return 'אתמול';
  return formatDate(iso);
}

/** A friendly icon for a system notice, from its link and wording. */
function noticeEmoji(n) {
  if (n.kind === 'reminder') return '⏰';
  const t = String(n.title || '');
  const link = String(n.link || '');
  if (t.startsWith('שובצת')) return '🙋';
  if (t.startsWith('הצעה חדשה')) return '💡';
  if (t.includes('אושרה')) return '✅';
  if (t.includes('נדחתה')) return '🙅';
  if (t.includes('הצטרפ')) return '🎉';
  if (t.includes('מונית')) return '👑';
  if (link.includes('/money') || t.includes('₪')) return '💸';
  if (link.includes('/lists')) return '📋';
  if (link.includes('/people')) return '👥';
  if (link.includes('/trip')) return '🏕️';
  return '🔔';
}

function announcementText(trip, { title, body, urgent }) {
  const lines = [`${urgent ? '🔴' : '📣'} *${title}*`];
  if (body) lines.push(body);
  lines.push('', `— ${trip.emoji || '⛺'} ${trip.name} · מדורה 🔥`, `👈 ${appBase()}#/t/${trip.id}/messages`);
  return lines.join('\n');
}

function pollShareText(trip, poll, results) {
  const lines = [`📊 *${poll.question}*`];
  for (const r of results) lines.push(`• ${r.label} — ${hebrewCount(r.count, 'קול', 'קולות')}`);
  lines.push('', poll.closed ? '🔒 הסקר נסגר' : `👈 מצביעים במדורה: ${appBase()}#/t/${trip.id}/messages?tab=polls`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

export default function MessagesScreen({ route }) {
  const { snap, me, isAdmin, tripId } = useTrip();
  const wanted = route?.params?.tripId || tripId;
  if (!snap || !me || snap.trip?.id !== wanted) {
    return html`<div class="screen msg-screen" aria-busy="true">
      <${Skeleton} lines=${2} />
      <${Skeleton} lines=${4} />
      <${Skeleton} lines=${3} />
    </div>`;
  }
  return html`<${MessagesBody} key=${me.id} route=${route} snap=${snap} me=${me} admin=${isAdmin} tripId=${snap.trip.id} />`;
}

/**
 * Marks everything visible as read (once per id per visit) and remembers which notices were
 * unread when they first showed up, so they stay highlighted as "new" for the whole visit.
 */
function useFreshAndMarkRead(tripId, notices, myReads, meId) {
  const fresh = useRef(null);
  const asked = useRef(new Set());
  const isUnread = (n) => !myReads.has(n.id) && n.author_member !== meId;
  if (fresh.current === null) fresh.current = new Set(notices.filter(isUnread).map((n) => n.id));
  useEffect(() => {
    const ids = notices.filter((n) => isUnread(n) && !asked.current.has(n.id)).map((n) => n.id);
    if (!ids.length) return;
    ids.forEach((id) => {
      asked.current.add(id);
      fresh.current.add(id);
    });
    actions.run((api) => api.markRead(tripId, ids), { error: () => '' });
  }, [notices, myReads]);
  return fresh.current;
}

function MessagesBody({ route, snap, me, admin, tripId }) {
  const now = useNow();
  const query = route?.query || {};
  const byId = useMemo(() => membersById(snap.members), [snap.members]);
  const notices = useMemo(() => visibleNotifications(snap), [snap.notifications, snap.members, snap.me]);
  const myReads = useMemo(
    () => new Set((snap.reads || []).filter((r) => r.member_id === me.id).map((r) => r.notification_id)),
    [snap.reads, me.id],
  );
  const fresh = useFreshAndMarkRead(tripId, notices, myReads, me.id);
  const [tab, setTab] = useState(query.tab === 'polls' ? 'polls' : 'feed');
  const [pollSheet, setPollSheet] = useState(query.poll === 'new');

  const polls = snap.polls || [];
  const myPollVotes = new Set((snap.poll_votes || []).filter((v) => v.member_id === me.id).map((v) => v.poll_id));
  const waiting = polls.filter((p) => !p.closed && !myPollVotes.has(p.id));
  const freshCount = notices.filter((n) => fresh.has(n.id)).length;

  return html`<div class="screen msg-screen">
    <header class="msg-head">
      <div class="msg-head__text">
        <h1 class="h1">הודעות</h1>
        <p class="muted small">
          ${freshCount
            ? html`<span class="msg-head__fresh">${hebrewCount(freshCount, 'הודעה חדשה', 'הודעות חדשות')} ✨</span>`
            : 'כל העדכונים של הטיול במקום אחד'}
        </p>
      </div>
      <span class="msg-head__emoji" aria-hidden="true">📣</span>
    </header>

    ${admin ? html`<${Composer} snap=${snap} me=${me} tripId=${tripId} startOpen=${query.compose === '1'} />` : null}

    <${Segmented}
      label="מה להציג"
      class="msg-tabs"
      value=${tab}
      onChange=${setTab}
      options=${[
        { value: 'feed', label: '📣 עדכונים' },
        { value: 'polls', label: '📊 סקרים', badge: waiting.length || undefined },
      ]}
    />

    ${tab === 'feed'
      ? html`<${Feed}
          notices=${notices}
          fresh=${fresh}
          snap=${snap}
          me=${me}
          admin=${admin}
          byId=${byId}
          now=${now}
          waiting=${waiting}
          onGoPolls=${() => setTab('polls')}
        />`
      : html`<${Polls} snap=${snap} me=${me} admin=${admin} byId=${byId} now=${now} onCreate=${() => setPollSheet(true)} />`}

    <${CreatePollSheet}
      open=${pollSheet}
      onClose=${() => setPollSheet(false)}
      tripId=${tripId}
      onCreated=${() => setTab('polls')}
    />
  </div>`;
}

// ---------------------------------------------------------------------------
// feed
// ---------------------------------------------------------------------------

const FILTERS = [
  { value: 'all', label: 'הכל' },
  { value: 'ann', label: '📣 מהמנהלים' },
  { value: 'sys', label: '⚙️ עדכוני מערכת' },
];

function Feed({ notices, fresh, snap, me, admin, byId, now, waiting, onGoPolls }) {
  const [filter, setFilter] = useState('all');
  const hasAnn = notices.some((n) => n.kind === 'announcement');
  const hasSys = notices.some((n) => n.kind !== 'announcement');
  const active = hasAnn && hasSys ? filter : 'all';
  const shown = notices.filter((n) => active === 'all' || (active === 'ann') === (n.kind === 'announcement'));

  const groups = [];
  for (const n of shown) {
    const key = dayKey(n.created_at);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: dayLabel(n.created_at, now), items: [] };
      groups.push(g);
    }
    g.items.push(n);
  }

  return html`<div class="stack msg-feed">
    ${waiting.length
      ? html`<button type="button" class="msg-nudge" onClick=${onGoPolls}>
          <span class="msg-nudge__emoji" aria-hidden="true">🗳️</span>
          <span class="msg-nudge__text">
            <span class="msg-nudge__title">${waiting.length === 1 ? 'סקר פתוח מחכה לקול שלך' : `${waiting.length} סקרים מחכים לקול שלך`}</span>
            <span class="msg-nudge__sub">${waiting[0].question}</span>
          </span>
          <${Icon} name="chevron-left" size=${20} />
        </button>`
      : null}

    ${hasAnn && hasSys
      ? html`<div class="h-scroll msg-filters" role="group" aria-label="סינון עדכונים">
          ${FILTERS.map((f) => html`<${Chip} key=${f.value} active=${active === f.value} onClick=${() => setFilter(f.value)}>${f.label}</${Chip}>`)}
        </div>`
      : null}

    ${shown.length
      ? groups.map((g) => html`<section class="msg-day" key=${g.key} aria-label=${g.label}>
          <h2 class="msg-day__label">${g.label}</h2>
          <div class="stack-sm">
            ${g.items.map((n) => html`<${Notice}
              key=${n.id}
              n=${n}
              fresh=${fresh.has(n.id)}
              snap=${snap}
              me=${me}
              admin=${admin}
              byId=${byId}
              now=${now}
            />`)}
          </div>
        </section>`)
      : html`<${Card}>
          <${EmptyState}
            emoji="📭"
            title="שקט פה… בינתיים"
            text="הודעות מהמנהלים ועדכונים על שיבוצים, הצעות וכסף יופיעו כאן."
          />
        </${Card}>`}
  </div>`;
}

function Notice({ n, fresh, snap, me, admin, byId, now }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const ann = n.kind === 'announcement';
  const author = n.author_member ? byId.get(n.author_member) : null;
  const mine = n.author_member === me.id;
  const link = safeLink(n.link);
  const body = String(n.body || '');
  const long = body.length > 220 || body.split('\n').length > 5;
  const audience = Array.isArray(n.audience) && n.audience.length ? n.audience : null;

  let audienceText = null;
  if (ann && audience) {
    if (mine || admin) {
      const first = byId.get(audience[0]);
      audienceText = audience.length === 1 && first ? `רק ל${displayName(first)}` : `רק ל-${audience.length}`;
    } else {
      audienceText = 'נשלח אליך אישית';
    }
  }

  const remove = async () => {
    const ok = await confirmDialog({
      title: 'למחוק את ההודעה?',
      text: 'היא תיעלם אצל כולם.',
      confirmText: 'מחיקה',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    await actions.run((api) => api.deleteNotification(n.id), { success: 'ההודעה נמחקה 🗑️' });
    setBusy(false);
  };

  return html`<article
    class=${cx('msg-notice', ann ? 'msg-notice--ann' : 'msg-notice--sys', n.urgent && 'msg-notice--urgent', fresh && 'is-fresh', link && 'msg-notice--link')}
    aria-label=${`${n.urgent ? 'דחוף: ' : ''}${n.title}`}
  >
    <div class="msg-notice__icon" aria-hidden="true">
      ${ann && author
        ? html`<${Avatar} member=${author} size=${40} />`
        : html`<span class="msg-notice__emoji">${ann ? '📣' : noticeEmoji(n)}</span>`}
    </div>
    <div class="msg-notice__main">
      <div class="msg-notice__meta">
        <span class="msg-notice__who">${ann ? (author ? displayName(author) : 'מנהל/ת') : 'עדכון'}</span>
        <span aria-hidden="true">·</span>
        <time datetime=${n.created_at} title=${formatDateTime(n.created_at)}>${timeAgo(n.created_at, now)}</time>
        ${fresh ? html`<span class="msg-notice__new"><span class="dot" aria-hidden="true"></span>חדש</span>` : null}
      </div>
      ${link
        ? html`<a class="msg-notice__title" href=${link}>${n.title}<${Icon} name="chevron-left" size=${16} class="msg-notice__chev" /></a>`
        : html`<h3 class="msg-notice__title">${n.title}</h3>`}
      ${body
        ? html`<p class=${cx('msg-notice__body', long && !expanded && 'is-clamped')}>${body}</p>`
        : null}
      ${long
        ? html`<button type="button" class="link msg-notice__more" aria-expanded=${expanded ? 'true' : 'false'} onClick=${() => setExpanded(!expanded)}>
            ${expanded ? 'פחות' : 'להמשך קריאה'}
          </button>`
        : null}
      ${n.urgent || audienceText
        ? html`<div class="msg-notice__tags">
            ${n.urgent ? html`<${Pill} tone="ember">🔴 דחוף</${Pill}>` : null}
            ${audienceText ? html`<${Pill} tone="info">🎯 ${audienceText}</${Pill}>` : null}
          </div>`
        : null}
      ${ann && (admin || mine) ? html`<${Receipts} n=${n} snap=${snap} byId=${byId} />` : null}
    </div>
    ${ann && (admin || mine)
      ? html`<${IconButton} icon="trash" label="מחיקת ההודעה" class="msg-notice__del" size=${18} disabled=${busy} onClick=${remove} />`
      : null}
  </article>`;
}

/** "נקרא ע״י 3/4" — expandable to who read it and who didn't (authors and admins only). */
function Receipts({ n, snap, byId }) {
  const [open, setOpen] = useState(false);
  const panelId = useFormId('receipts');
  const recipients = (Array.isArray(n.audience) && n.audience.length ? n.audience : snap.members.map((m) => m.id))
    .filter((id) => id !== n.author_member && byId.has(id));
  const readAt = new Map((snap.reads || []).filter((r) => r.notification_id === n.id).map((r) => [r.member_id, r.read_at]));
  const readers = recipients.filter((id) => readAt.has(id));
  const pending = recipients.filter((id) => !readAt.has(id));
  if (!recipients.length) return null;
  const all = readers.length === recipients.length;
  const person = (id, read) => {
    const m = byId.get(id);
    return html`<li class=${cx('msg-receipt', read && 'is-read')} key=${id}>
      <${Avatar} member=${m} size=${26} />
      <span class="msg-receipt__name">${displayName(m)}</span>
      ${read ? html`<span class="msg-receipt__time" title=${formatDateTime(readAt.get(id))}>${formatTime(readAt.get(id))}</span>` : null}
    </li>`;
  };
  return html`<div class=${cx('msg-receipts', open && 'is-open')}>
    <button type="button" class="msg-receipts__toggle" aria-expanded=${open ? 'true' : 'false'} aria-controls=${panelId} onClick=${() => setOpen(!open)}>
      <span aria-hidden="true">${all ? '✅' : '👀'}</span>
      <span>נקרא ע״י <bdi class="num">${readers.length}/${recipients.length}</bdi></span>
      <${Icon} name="chevron-down" size=${16} class="msg-receipts__chev" />
    </button>
    ${open
      ? html`<div class="msg-receipts__panel" id=${panelId}>
          <${ProgressBar} value=${(readers.length / recipients.length) * 100} tone=${all ? 'success' : 'accent'} label="כמה קראו" />
          ${readers.length
            ? html`<div class="msg-receipts__group">
                <span class="msg-receipts__label">✓ קראו</span>
                <ul class="msg-receipts__list">${readers.map((id) => person(id, true))}</ul>
              </div>`
            : null}
          ${pending.length
            ? html`<div class="msg-receipts__group">
                <span class="msg-receipts__label">⏳ עוד לא</span>
                <ul class="msg-receipts__list">${pending.map((id) => person(id, false))}</ul>
              </div>`
            : html`<p class="msg-receipts__all">כולם קראו 🙌</p>`}
          ${pending.length
            ? html`<${ShareButton} size="sm" variant="secondary" label="להזכיר בוואטסאפ" text=${announcementText(snap.trip, n)} />`
            : null}
        </div>`
      : null}
  </div>`;
}

// ---------------------------------------------------------------------------
// admin composer
// ---------------------------------------------------------------------------

function templates(trip) {
  const leave = trip.starts_at ? formatTime(trip.starts_at) : '';
  return [
    {
      key: 'leave',
      label: '🚗 יוצאים',
      title: leave ? `יוצאים ב-${leave} 🚗` : 'מתי יוצאים 🚗',
      body: 'מי שצריך/ה טרמפ או יכול/ה לקחת עוד מישהו — כתבו לי 🙏',
    },
    {
      key: 'pack',
      label: '🎒 לארוז',
      title: 'תזכורת: אורזים הערב 🎒',
      body: 'עברו על "המשימות שלי" במדורה וסמנו מה כבר ארוז ✅',
    },
    {
      key: 'missing',
      label: '🙋 עוד חסר',
      title: 'עדיין חסרים כמה דברים 🙋',
      body: 'היכנסו לרשימות וסמנו "אני מביא/ה" על מה שיש לכם בבית 🙏',
    },
    {
      key: 'money',
      label: '💸 מתחשבנים',
      title: 'מתחשבנים! 💸',
      body: 'במסך הכסף כתוב למי להעביר וכמה. אחרי ההעברה — לוחצים "שילמתי" ✅',
    },
  ];
}

function Composer({ snap, me, tripId, startOpen }) {
  const [open, setOpen] = useState(Boolean(startOpen));
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [mode, setMode] = useState('all');
  const [picked, setPicked] = useState([]);
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [sent, setSent] = useState(null);
  const formId = useFormId('composer');
  const others = snap.members.filter((m) => m.id !== me.id);

  const reset = () => {
    setTitle('');
    setBody('');
    setMode('all');
    setPicked([]);
    setUrgent(false);
    setErrors({});
  };

  const submit = async (e) => {
    e.preventDefault();
    const t = title.trim();
    const b = body.trim();
    const errs = {};
    if (!t) errs.title = 'מה הכותרת? ✍️';
    if (mode === 'some' && !picked.length) errs.audience = 'בחרו לפחות חבר/ה אחד/ת 🎯';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    const audience = mode === 'some' ? picked : null;
    const id = await actions.run(
      (api) => api.sendAnnouncement(tripId, { title: t, body: b || null, audience, urgent }),
      { success: urgent ? 'ההודעה הדחופה נשלחה 🔴' : 'ההודעה נשלחה 📣' },
    );
    setBusy(false);
    if (id === undefined) return;
    setSent({ title: t, body: b, urgent, count: audience ? audience.length : null });
    reset();
  };

  if (sent) {
    return html`<${Card} tone="success" class="msg-sent" emoji="📣" title="ההודעה יצאה לדרך!">
      <p class="small">
        ${sent.count ? `נשלחה ל-${hebrewCount(sent.count, 'חבר/ה', 'חברים')} במדורה.` : 'כל החבר\'ה יראו אותה במדורה.'}
        ${' '}רוצים לוודא שכולם רואים? שתפו גם בקבוצה:
      </p>
      <div class="row wrap msg-sent__actions">
        <${ShareButton} text=${announcementText(snap.trip, sent)} label="שתף גם בוואטסאפ" />
        <${Button} variant="ghost" icon="plus" onClick=${() => {
          setSent(null);
          setOpen(true);
        }}>הודעה נוספת</${Button}>
      </div>
    </${Card}>`;
  }

  if (!open) {
    return html`<button type="button" class="msg-compose-prompt" onClick=${() => setOpen(true)}>
      <${Avatar} member=${me} size=${38} />
      <span class="msg-compose-prompt__text">
        <span class="msg-compose-prompt__kicker">📣 הודעה לקבוצה</span>
        <span class="msg-compose-prompt__hint">מה רוצים להגיד לחבר'ה?</span>
      </span>
      <span class="msg-compose-prompt__icon" aria-hidden="true"><${Icon} name="send" size=${18} /></span>
    </button>`;
  }

  return html`<${Card}
    class="msg-composer"
    emoji="📣"
    title="הודעה חדשה"
    action=${html`<${IconButton} icon="x" label="סגירת ההודעה" onClick=${() => {
      setOpen(false);
      setErrors({});
    }} />`}
  >
    <form id=${formId} class="stack" onSubmit=${submit} noValidate>
      <div class="h-scroll msg-templates" role="group" aria-label="תבניות מהירות">
        ${templates(snap.trip).map((tp) => html`<${Chip}
          key=${tp.key}
          tone="accent"
          onClick=${() => {
            setTitle(tp.title);
            setBody(tp.body);
            setErrors({});
          }}
        >${tp.label}</${Chip}>`)}
      </div>
      <${Field} label="כותרת" error=${errors.title}>
        <${TextInput}
          value=${title}
          maxlength="80"
          placeholder="למשל: יוצאים ב-09:00 🚗"
          onInput=${(e) => {
            setTitle(e.target.value);
            if (errors.title) setErrors({ ...errors, title: undefined });
          }}
        />
      </${Field}>
      <${Field} label="פרטים (לא חובה)">
        <${TextArea} value=${body} maxlength="2000" rows=${3} placeholder="כל מה שכדאי לדעת…" onInput=${(e) => setBody(e.target.value)} />
      </${Field}>
      <${Field} label="למי?" error=${errors.audience}>
        <${Segmented}
          label="למי לשלוח"
          value=${mode}
          onChange=${(v) => {
            setMode(v);
            if (errors.audience) setErrors({ ...errors, audience: undefined });
          }}
          options=${[
            { value: 'all', label: '👥 לכולם' },
            { value: 'some', label: '🎯 רק לחלק' },
          ]}
        />
        ${mode === 'some'
          ? html`<div class="msg-audience">
              <${MemberPicker}
                multi
                label="למי לשלוח"
                members=${others}
                value=${picked}
                onChange=${(ids) => {
                  setPicked(ids);
                  if (errors.audience) setErrors({ ...errors, audience: undefined });
                }}
              />
              <span class="field__hint">${picked.length ? `נבחרו ${picked.length}` : 'בחרו למי ההודעה מיועדת'}</span>
            </div>`
          : null}
      </${Field}>
      <div class=${cx('msg-urgent', urgent && 'is-on')}>
        <${Toggle}
          checked=${urgent}
          onChange=${setUrgent}
          label="🔴 הודעה דחופה"
          hint="תופיע באדום בראש הפיד ותקפיץ רטט"
        />
      </div>
      <${Button} type="submit" variant=${urgent ? 'danger' : 'accent'} size="lg" block icon="send" loading=${busy}>
        ${urgent ? 'שליחה דחופה' : 'שליחה'}
      </${Button}>
    </form>
  </${Card}>`;
}

// ---------------------------------------------------------------------------
// polls
// ---------------------------------------------------------------------------

function Polls({ snap, me, admin, byId, now, onCreate }) {
  const polls = [...(snap.polls || [])].sort(
    (a, b) => Number(a.closed) - Number(b.closed) || Date.parse(b.created_at) - Date.parse(a.created_at),
  );
  return html`<div class="stack msg-polls">
    <div class="msg-polls__head">
      <p class="muted small">רוצים להחליט משהו ביחד? כולם מצביעים, כולם רואים ✋</p>
      <${Button} size="sm" variant="primary" icon="plus" onClick=${onCreate}>סקר חדש</${Button}>
    </div>
    ${polls.length
      ? polls.map((p) => html`<${PollCard} key=${p.id} poll=${p} snap=${snap} me=${me} admin=${admin} byId=${byId} now=${now} />`)
      : html`<${Card}>
          <${EmptyState}
            emoji="🗳️"
            title="עוד אין סקרים"
            text="מה אוכלים בבוקר? מתי יוצאים? פתחו סקר וכולם יצביעו בקליק."
            action=${html`<${Button} variant="accent" icon="plus" onClick=${onCreate}>סקר חדש</${Button}>`}
          />
        </${Card}>`}
  </div>`;
}

function PollCard({ poll, snap, me, admin, byId, now }) {
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const serverVotes = (snap.poll_votes || []).filter((v) => v.poll_id === poll.id);
  const serverMine = serverVotes.filter((v) => v.member_id === me.id).map((v) => v.option_id);
  const mine = pending || serverMine;
  // Show my choice right away (optimistic) until the fresh snapshot arrives.
  const votes = pending
    ? [...serverVotes.filter((v) => v.member_id !== me.id), ...pending.map((o) => ({ poll_id: poll.id, member_id: me.id, option_id: o }))]
    : serverVotes;
  const results = pollResults(poll, votes);
  const voters = new Set(votes.map((v) => v.member_id)).size;
  const top = Math.max(0, ...results.map((r) => r.count));
  const creator = poll.created_by ? byId.get(poll.created_by) : null;
  const canManage = admin || (poll.created_by && poll.created_by === me.id);

  const vote = async (optionId) => {
    if (poll.closed || busy) return;
    let next;
    if (poll.multi) next = mine.includes(optionId) ? mine.filter((x) => x !== optionId) : [...mine, optionId];
    else next = mine.includes(optionId) ? [] : [optionId];
    setPending(next);
    setBusy(true);
    await actions.run(async (api) => {
      await api.votePoll(poll.id, next);
      return true;
    });
    setBusy(false);
    setPending(null);
  };

  const toggleClosed = async () => {
    setBusy(true);
    await actions.run((api) => api.closePoll(poll.id, !poll.closed), {
      success: poll.closed ? 'הסקר נפתח מחדש 🔓' : 'הסקר נסגר 🔒',
    });
    setBusy(false);
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: 'למחוק את הסקר?',
      text: 'כל ההצבעות יימחקו. אי אפשר לבטל.',
      confirmText: 'מחיקה',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    await actions.run((api) => api.deletePoll(poll.id), { success: 'הסקר נמחק 🗑️' });
    setBusy(false);
  };

  return html`<article class=${cx('card', 'msg-poll', poll.closed && 'is-closed')} aria-label=${`סקר: ${poll.question}`}>
    <div class="msg-poll__head">
      <span class="msg-poll__icon" aria-hidden="true">${poll.closed ? '🏁' : '📊'}</span>
      <div class="msg-poll__titles">
        <h3 class="msg-poll__q">${poll.question}</h3>
        <p class="msg-poll__meta">
          ${creator ? `${displayName(creator)} · ` : ''}${timeAgo(poll.created_at, now)} · ${poll.multi ? 'אפשר לבחור כמה' : 'תשובה אחת'}
        </p>
      </div>
      ${poll.closed ? html`<${Pill}>🔒 נסגר</${Pill}>` : html`<${Pill} tone="success">פתוח</${Pill}>`}
    </div>

    <div class="msg-poll__opts" role=${poll.multi ? 'group' : 'radiogroup'} aria-label=${poll.question}>
      ${results.map((r) => {
        const on = mine.includes(r.id);
        const win = poll.closed && top > 0 && r.count === top;
        const people = r.voters.map((id) => byId.get(id)).filter(Boolean);
        return html`<button
          type="button"
          key=${r.id}
          role=${poll.multi ? 'checkbox' : 'radio'}
          aria-checked=${on ? 'true' : 'false'}
          aria-label=${`${r.label} — ${hebrewCount(r.count, 'קול', 'קולות')}`}
          class=${cx('msg-opt', on && 'is-mine', win && 'is-winner')}
          style=${`--pct:${r.pct}%`}
          disabled=${poll.closed || busy}
          onClick=${() => vote(r.id)}
        >
          <span class="msg-opt__bar" aria-hidden="true"></span>
          <span class=${cx('msg-opt__mark', poll.multi && 'msg-opt__mark--square')} aria-hidden="true">
            ${on ? html`<${Icon} name="check" size=${14} />` : null}
          </span>
          <span class="msg-opt__label">${win ? '🏆 ' : ''}${r.label}</span>
          ${people.length ? html`<${AvatarStack} members=${people} max=${3} size=${22} />` : null}
          <span class="msg-opt__count num" aria-hidden="true">${r.count ? `${r.pct}%` : ''}</span>
        </button>`;
      })}
    </div>

    <div class="msg-poll__foot">
      <span class="msg-poll__votes">
        ${voters ? `הצביעו ${voters} מתוך ${snap.members.length}` : 'עוד אין קולות — תהיו ראשונים!'}
      </span>
      <div class="msg-poll__actions">
        <${ShareButton} size="sm" variant="ghost" label="שיתוף" text=${pollShareText(snap.trip, poll, results)} />
        ${canManage
          ? html`<${Button} size="sm" variant="ghost" disabled=${busy} onClick=${toggleClosed}>${poll.closed ? '🔓 פתיחה מחדש' : '🔒 סגירה'}</${Button}>
              <${IconButton} icon="trash" label="מחיקת הסקר" size=${18} disabled=${busy} onClick=${remove} />`
          : null}
      </div>
    </div>
  </article>`;
}

const POLL_IDEAS = [
  { key: 'breakfast', label: '🍳 ארוחת בוקר', q: 'מה אוכלים בבוקר? 🍳', o: ['שקשוקה', 'טוסטים על המנגל', 'פנקייקים'] },
  { key: 'night', label: '🌙 מה בלילה', q: 'מה עושים בלילה? 🌙', o: ['מדורה ושירים 🎸', 'טורניר קלפים 🃏', 'הולכים לישון מוקדם 😴'] },
  { key: 'leave', label: '🚗 מתי יוצאים', q: 'באיזו שעה יוצאים? 🚗', o: ['07:30', '08:00', '09:00'] },
];

let optSeq = 0;
const newOpt = (text = '') => ({ id: `opt-${++optSeq}`, text });

function CreatePollSheet({ open, onClose, tripId, onCreated }) {
  const [question, setQuestion] = useState('');
  const [opts, setOpts] = useState(() => [newOpt(), newOpt()]);
  const [multi, setMulti] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const formId = useFormId('poll-form');

  const reset = () => {
    setQuestion('');
    setOpts([newOpt(), newOpt()]);
    setMulti(false);
    setErrors({});
  };

  const setOpt = (id, text) => {
    setOpts(opts.map((o) => (o.id === id ? { ...o, text } : o)));
    if (errors.opts) setErrors({ ...errors, opts: undefined });
  };

  const submit = async (e) => {
    e.preventDefault();
    const q = question.trim();
    const options = opts.map((o) => o.text.trim()).filter(Boolean);
    const errs = {};
    if (!q) errs.q = 'על מה מצביעים? 🙂';
    if (options.length < 2) errs.opts = 'צריך לפחות 2 אפשרויות';
    else if (new Set(options).size !== options.length) errs.opts = 'יש אפשרות שמופיעה פעמיים';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    const id = await actions.run((api) => api.createPoll(tripId, { question: q, options, multi }), {
      success: 'הסקר באוויר! 📊',
    });
    setBusy(false);
    if (id === undefined) return;
    reset();
    onClose();
    onCreated?.();
  };

  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title="📊 סקר חדש"
    footer=${html`<${Button} type="submit" form=${formId} variant="accent" size="lg" block icon="send" loading=${busy}>פרסום הסקר</${Button}>`}
  >
    <form id=${formId} class="stack msg-poll-form" onSubmit=${submit} noValidate>
      <div class="h-scroll" role="group" aria-label="רעיונות לסקר">
        ${POLL_IDEAS.map((idea) => html`<${Chip}
          key=${idea.key}
          tone="accent"
          onClick=${() => {
            setQuestion(idea.q);
            setOpts(idea.o.map((t) => newOpt(t)));
            setErrors({});
          }}
        >💡 ${idea.label}</${Chip}>`)}
      </div>
      <${Field} label="השאלה" error=${errors.q}>
        <${TextInput}
          value=${question}
          maxlength="140"
          placeholder="למשל: מה עושים בלילה? 🌙"
          onInput=${(e) => {
            setQuestion(e.target.value);
            if (errors.q) setErrors({ ...errors, q: undefined });
          }}
        />
      </${Field}>
      <${Field} label="אפשרויות" error=${errors.opts}>
        <div class="msg-poll-form__opts">
          ${opts.map((o, i) => html`<div class="msg-poll-form__opt" key=${o.id}>
            <span class="msg-poll-form__num num" aria-hidden="true">${i + 1}</span>
            <input
              class="input"
              value=${o.text}
              maxlength="80"
              aria-label=${`אפשרות ${i + 1}`}
              placeholder=${`אפשרות ${i + 1}`}
              onInput=${(e) => setOpt(o.id, e.target.value)}
            />
            ${opts.length > 2
              ? html`<${IconButton} icon="x" size=${18} label=${`הסרת אפשרות ${i + 1}`} onClick=${() => setOpts(opts.filter((x) => x.id !== o.id))} />`
              : null}
          </div>`)}
          ${opts.length < 8
            ? html`<${Button} variant="ghost" size="sm" icon="plus" onClick=${() => setOpts([...opts, newOpt()])}>עוד אפשרות</${Button}>`
            : html`<span class="field__hint">עד 8 אפשרויות</span>`}
        </div>
      </${Field}>
      <${Toggle} checked=${multi} onChange=${setMulti} label="אפשר לבחור כמה תשובות" hint="למשל: ״מה בא לכם לאכול?״" />
    </form>
  </${Sheet}>`;
}
