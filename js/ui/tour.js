// First-run guide (once per device, re-openable from Me), three short screens: what Medura does,
// installing it as an app, turning on notifications. Automated browsers skip it unless the URL has ?tour=1.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { actions } from '../store.js?v=9252f89';
import { Button, Sheet } from './components.js?v=9252f89';
import { enablePush, installState, onInstallChange, promptInstall, pushState } from '../lib/device.js?v=9252f89';

const KEY = 'medura:tour:v2';
const cx = (...a) => a.filter(Boolean).join(' ');

function seen() {
  try {
    return localStorage.getItem(KEY) === 'done';
  } catch {
    return true;
  }
}

function markSeen() {
  try {
    localStorage.setItem(KEY, 'done');
  } catch {
    /* storage unavailable */
  }
}

/** Should the guide open by itself now? */
export function tourDue() {
  let forced = false;
  try {
    forced = new URLSearchParams(location.search).get('tour') === '1';
  } catch {
    /* no location */
  }
  if (forced) return !seen();
  if (typeof navigator !== 'undefined' && navigator.webdriver) return false;
  return !seen();
}

// ---- slide bodies ----------------------------------------------------------------------

function Welcome() {
  return html`<ul class="tour-points">
      <li><span aria-hidden="true">📋</span> <b>מי מביא מה</b> — לוקחים דבר מהרשימה בלחיצה</li>
      <li><span aria-hidden="true">🚗</span> <b>איך מגיעים</b> — מבקשים מקום, הנהג/ת מאשר/ת</li>
      <li><span aria-hidden="true">💸</span> <b>כסף</b> — רושמים הוצאה, החשבון מתחלק לבד</li>
      <li><span aria-hidden="true">📥</span> <b>מה מחכה לך</b> — תמיד למעלה במסך הבית</li>
    </ul>
    <p class="tour__text tour__text--soft">הכול לפני ואחרי הטיול. בטיול עצמו — מדורה נחה 🙂</p>`;
}

function InstallSlide() {
  const [state, setState] = useState(installState);
  useEffect(() => onInstallChange(() => setState(installState())), []);
  if (state === 'installed') {
    return html`<div class="tour-art" aria-hidden="true"><span>📲</span></div>
      <p class="tour__text"><b>✅ מדורה כבר מותקנת אצלך.</b> אפשר להמשיך.</p>`;
  }
  if (state === 'prompt') {
    return html`<div class="tour-art" aria-hidden="true"><span>📲</span></div>
      <p class="tour__text">מדורה לא בחנות — אבל אפשר להתקין אותה <b>בלחיצה אחת</b>, עם אייקון משלה במסך הבית.</p>
      <${Button} variant="accent" onClick=${async () => {
        if (await promptInstall()) actions.toast('מדורה הותקנה 📲', 'success');
        setState(installState());
      }}>📲 התקנה עכשיו</${Button}>`;
  }
  if (state === 'ios') {
    return html`<p class="tour__text">מדורה לא בחנות — מוסיפים אותה למסך הבית ב־3 צעדים (בספארי):</p>
      <ol class="tour-steps">
        <li><span class="tour-steps__icon" aria-hidden="true">⬆️</span> לוחצים על <b>שיתוף</b> למטה</li>
        <li><span class="tour-steps__icon" aria-hidden="true">➕</span> גוללים ובוחרים <b>״הוספה למסך הבית״</b></li>
        <li><span class="tour-steps__icon" aria-hidden="true">🔥</span> פותחים את מדורה <b>מהאייקון</b></li>
      </ol>
      <p class="tour__text tour__text--soft">באייפון, התראות עובדות רק מהאייקון — שווה לעשות את זה עכשיו.</p>`;
  }
  if (state === 'android') {
    return html`<div class="tour-art" aria-hidden="true"><span>📲</span></div>
      <p class="tour__text">בכרום: תפריט <b>⋮</b> ← <b>״הוספה למסך הבית״ / ״התקנת אפליקציה״</b> — ומדורה תקבל אייקון משלה.</p>`;
  }
  return html`<div class="tour-art" aria-hidden="true"><span>📱</span></div>
    <p class="tour__text">הכי נוח בטלפון: פתחו את הקישור בנייד והוסיפו את מדורה למסך הבית.</p>`;
}

function PushSlide({ tripId }) {
  const [state, setState] = useState('loading');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    pushState().then((s) => alive && setState(s)).catch(() => alive && setState('unsupported'));
    return () => { alive = false; };
  }, []);
  const enable = async () => {
    setBusy(true);
    try {
      setState(await enablePush((json) => actions.run(async (api) => {
        await api.savePushSubscription(tripId, json);
        return true;
      }, { refresh: false })));
    } catch {
      actions.toast('לא הצלחנו להפעיל התראות כרגע — אפשר גם מאוחר יותר במסך ״אני״', 'error');
    } finally {
      setBusy(false);
    }
  };
  const art = html`<div class="tour-art tour-art--bell" aria-hidden="true"><span>🔔</span></div>`;
  const note = html`<p class="tour__text tour__text--soft">בלי הצפות: מה שלא דחוף מגיע מרוכז פעם ביום, בשעות נורמליות. ובמייל — ממילא.</p>`;
  if (state === 'on') return html`${art}<p class="tour__text"><b>✅ ההתראות פעילות במכשיר הזה.</b> תדעו מיד כשמאשרים לכם טרמפ או כשמשבצים אתכם.</p>${note}`;
  if (state === 'ios-install') return html`${art}<p class="tour__text">באייפון מפעילים התראות <b>מהאייקון במסך הבית</b> (השלב הקודם) — ואז מדורה תשאל אתכם כאן.</p>${note}`;
  if (state === 'denied') return html`${art}<p class="tour__text">ההתראות חסומות בדפדפן 🔒 — אפשר לשחרר בהגדרות האתר. העדכונים יגיעו במייל בינתיים.</p>`;
  if (state === 'unsupported') return html`${art}<p class="tour__text">הדפדפן הזה לא תומך בהתראות — העדכונים יגיעו אליכם במייל.</p>`;
  return html`${art}<p class="tour__text">כשמישהו מבקש מקום ברכב שלכם, כשמאשרים לכם, או ערב לפני היציאה — שתדעו.</p>
    <${Button} variant="accent" icon="bell" loading=${busy || state === 'loading'} onClick=${enable}>הפעלת התראות</${Button}>
    ${note}`;
}

const SLIDES = [
  { key: 'hi', emoji: '👋', title: 'ברוכים הבאים למדורה!', Body: Welcome },
  { key: 'install', emoji: '📲', title: 'מדורה על המסך שלכם', Body: InstallSlide },
  { key: 'push', emoji: '🔔', title: 'שלא תפספסו', Body: PushSlide },
];

export function Tour({ open, onClose, tripId }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (open) setI(0);
  }, [open]);
  const close = () => {
    markSeen();
    onClose();
  };
  const s = SLIDES[i];
  const last = i === SLIDES.length - 1;
  const Body = s.Body;

  return html`<${Sheet}
    open=${open}
    onClose=${close}
    title=${`${s.emoji} ${s.title}`}
    class="tour-sheet"
    footer=${html`
      <${Button} variant="accent" size="lg" icon=${last ? 'check' : undefined} onClick=${() => (last ? close() : setI(i + 1))}>
        ${last ? 'יאללה, מתחילים! 🔥' : 'הבא'}
      </${Button}>
      ${i > 0 ? html`<${Button} variant="ghost" onClick=${() => setI(i - 1)}>חזרה</${Button}>` : null}
      ${last ? null : html`<${Button} variant="ghost" onClick=${close}>דלג</${Button}>`}`}
  >
    <div class="tour" data-testid="tour" key=${s.key}>
      <${Body} tripId=${tripId} />
      <div class="tour__dots" role="tablist" aria-label="שקפי המדריך">
        ${SLIDES.map((x, j) => html`<button
          type="button" key=${x.key} role="tab" aria-selected=${j === i ? 'true' : 'false'}
          aria-label=${`שקף ${j + 1}: ${x.title}`} class=${j === i ? 'tour__dot is-on' : 'tour__dot'}
          onClick=${() => setI(j)}
        ></button>`)}
      </div>
    </div>
  </${Sheet}>`;
}
