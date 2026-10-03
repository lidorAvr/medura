// A short guide per tab, the first time someone opens it: what's here, what you can do, one tip that's easy
// to miss. Once per device per tab; "?" in the top bar opens it again. Automated browsers skip it (?tour=1 forces).
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { Button, Sheet } from './components.js?v=5ff55d3';

export const GUIDES = {
  lists: {
    emoji: '📋', title: 'רשימות — מי מביא מה',
    points: [
      ['✋', 'לוקחים דבר בלחיצה — וכולם רואים שזה מכוסה'],
      ['⭐', '״שלי״ — כל מה שעליך, ורשימת אריזה אישית'],
      ['🛒', 'מצב קניות — מסמנים תוך כדי בסופר'],
      ['➕', 'מוסיפים פריט; המנהלים מאשרים הצעות'],
    ],
    tip: 'לפריט אפשר לתת ⏰ ״עד מתי״ — ומי שלקח יקבל תזכורת בזמן',
  },
  money: {
    emoji: '💸', title: 'כסף — בלי חישובים',
    points: [
      ['🧾', 'רושמים הוצאה — היא מתחלקת לבד לפי אנשים'],
      ['🤝', '״איך מתחשבנים״ — מי מעביר למי, בכמה שפחות העברות'],
      ['💰', 'בקשת תשלום — אוספים כסף, עם תאריך יעד ותזכורות'],
      ['✅', '״שילמתי״ ← המקבל/ת מאשר/ת ← סגור'],
    ],
    tip: 'זוג? בוחרים ״קופה אחת״ או ״כל אחד לחוד״',
  },
  people: {
    emoji: '👥', title: 'החבר׳ה',
    points: [
      ['🙋', 'מי בטיול, מי כבר נכנס ומה כל אחד מביא'],
      ['💬', 'וואטסאפ או חיוג — בלחיצה על מישהו'],
      ['👑', 'מנהלים רואים פרטים ומיילים, ויכולים לערוך'],
    ],
    tip: 'מי שעוד לא נכנס — שולחים לו הזמנה אישית מהכרטיס שלו',
  },
  rides: {
    emoji: '🚗', title: 'הגעה',
    points: [
      ['🧭', 'מסמנים איך מגיעים — לחיצה אחת'],
      ['🙋', 'מחפשים מקום? מבקשים — והנהג/ת מאשר/ת'],
      ['🚕', 'מונית משותפת או נקודת מפגש — מארגנים כאן'],
    ],
    tip: 'בטיסה? מסמנים את הטיסה — ורואים מי טס איתכם',
  },
  messages: {
    emoji: '🔔', title: 'הודעות וסקרים',
    points: [
      ['📣', 'הודעות מהמארגנים — החשוב למעלה'],
      ['📊', 'סקרים — מצביעים בלחיצה, רואים תוצאות מיד'],
    ],
    tip: 'כמה התראות מקבלים ומתי — במסך ״אני״',
  },
  trip: {
    emoji: '⛺', title: 'פרטי הטיול',
    points: [
      ['📍', 'מתי ואיפה, ניווט ומזג אוויר'],
      ['⏰', 'לו״ז, הזמנות, עלויות לאדם וחדרים'],
    ],
    tip: 'מנהלים: ✏️ עריכה, ו״🧩 מה יש בטיול״ כדי להדליק ולכבות חלקים',
  },
  me: {
    emoji: '👤', title: 'אני',
    points: [
      ['📝', 'הפרטים שלך, אוכל ומה יש לך בבית'],
      ['🔔', 'אילו התראות ותזכורות מקבלים'],
    ],
    tip: 'בהתראות: ״📨 שליחת התראת בדיקה לעצמי״ — לוודא שהכול מגיע',
  },
};

const key = (name) => `medura:guide:${name}`;
const seen = (name) => {
  try {
    return localStorage.getItem(key(name)) === 'done';
  } catch {
    return true;
  }
};
const markSeen = (name) => {
  try {
    localStorage.setItem(key(name), 'done');
  } catch {
    /* storage unavailable */
  }
};
const automated = () => {
  try {
    if (new URLSearchParams(location.search).get('tour') === '1') return false;
  } catch {
    /* no location */
  }
  return typeof navigator !== 'undefined' && navigator.webdriver;
};

/** Opens the tab's guide on its first visit (not while the first-run tour is up); `?` reopens it. */
export function TabGuide({ name, blocked }) {
  const guide = GUIDES[name];
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!guide || blocked || automated() || seen(name)) return undefined;
    const t = setTimeout(() => setOpen(true), 450);
    return () => clearTimeout(t);
  }, [name, blocked]);
  useEffect(() => {
    const again = (e) => { if (e.detail === name) setOpen(true); };
    window.addEventListener('medura:guide', again);
    return () => window.removeEventListener('medura:guide', again);
  }, [name]);
  if (!guide) return null;
  const close = () => {
    markSeen(name);
    setOpen(false);
  };
  return html`<${Sheet} open=${open} onClose=${close} title=${`${guide.emoji} ${guide.title}`}>
    <div class="stack" data-testid="tab-guide">
      <ul class="tour-points">
        ${guide.points.map(([e, text]) => html`<li key=${text}><span aria-hidden="true">${e}</span> ${text}</li>`)}
      </ul>
      ${guide.tip ? html`<p class="tab-guide__tip">💡 ${guide.tip}</p>` : null}
      <${Button} variant="accent" block onClick=${close}>הבנתי 👍</${Button}>
    </div>
  </${Sheet}>`;
}

/** The "?" in the top bar: reopen this tab's guide. */
export const openGuide = (name) => window.dispatchEvent(new CustomEvent('medura:guide', { detail: name }));
export const hasGuide = (name) => Boolean(GUIDES[name]);
