// A short first-run tour (5 slides, skippable) shown once per device when entering a trip.
// Re-openable from the Me screen. Automated browsers skip it unless the URL has ?tour=1.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { Button, Sheet } from './components.js';

const KEY = 'medura:tour:v1';

const SLIDES = [
  { emoji: '🔥', title: 'ברוכים הבאים למדורה!', text: 'כל מה שצריך לטיול — במקום אחד. חצי דקה ואתם מכירים הכול.' },
  { emoji: '📋', title: 'מי מביא מה', text: 'לוחצים "✋ אני על זה" על פריט — וכולם רואים שזה מכוסה. בלשונית "⭐ שלי" יש את כל מה שאתם מביאים.' },
  { emoji: '🚗', title: 'הסעות וטרמפים', text: 'יש לך מקום ברכב? מוסיפים. צריך טרמפ? מצטרפים בלחיצה — במסך הטיול (לוחצים על שם הטיול למעלה).' },
  { emoji: '💸', title: 'כסף בלי כאב ראש', text: 'מוסיפים הוצאה, והאפליקציה מחשבת מי מעביר למי וכמה. בסוף — כפתור Bit וסגרנו.' },
  { emoji: '🔔', title: 'לא מפספסים כלום', text: 'עדכונים מהמנהלים, תזכורת בערב שלפני ובבוקר היציאה — באפליקציה, בהתראה ובמייל. את הכול מכוונים במסך "אני".' },
];

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

/** Should the tour open by itself now? */
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

export function Tour({ open, onClose }) {
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

  return html`<${Sheet}
    open=${open}
    onClose=${close}
    title=${`${s.emoji} ${s.title}`}
    class="tour-sheet"
    footer=${html`
      <${Button} variant="accent" size="lg" icon=${last ? 'check' : undefined} onClick=${() => (last ? close() : setI(i + 1))}>
        ${last ? 'יאללה, מתחילים!' : 'הבא'}
      </${Button}>
      ${last ? null : html`<${Button} variant="ghost" onClick=${close}>דלג</${Button}>`}`}
  >
    <div class="tour" data-testid="tour">
      <div class="tour__art" aria-hidden="true" key=${i}>${s.emoji}</div>
      <p class="tour__text">${s.text}</p>
      <div class="tour__dots" role="tablist" aria-label="שקפי המדריך">
        ${SLIDES.map((x, j) => html`<button
          type="button" key=${j} role="tab" aria-selected=${j === i ? 'true' : 'false'}
          aria-label=${`שקף ${j + 1}: ${x.title}`} class=${j === i ? 'tour__dot is-on' : 'tour__dot'}
          onClick=${() => setI(j)}
        ></button>`)}
      </div>
    </div>
  </${Sheet}>`;
}
