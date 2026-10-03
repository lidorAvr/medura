// Trip families & sub-types: each one sets the starting point of a new trip — which modules are on, the
// shared lists (categories + items), the personal packing list, the one-tap schedule rows (per day), the
// expense tags and how people get there. A trip is stored as settings {type: family, subtype, where, custom};
// trips from before families keep their flat `type` and are mapped by resolveType (nothing is rewritten).
// Everything here is a suggestion: the admin edits, deletes and toggles all of it later.
// Pure data + tiny helpers (no DOM, no API) so the logic tests can check it.
import { adminPersons } from './logic.js?v=5ff55d3';

/**
 * Features the creator picks for a trip (defaults by type) and admins switch on/off later ("⚙️ מה יש בטיול").
 * Missing = on (older trips keep everything). Off hides a feature — its data stays. `tracks`: what the app
 * follows up on while it's on (the participant's daily summary + the admins' "אצל החבר׳ה").
 */
export const MODULES = [
  { key: 'rides', emoji: '🚗', label: 'הגעה והסעות', hint: 'טרמפים, מונית משותפת, מי נוהג', tracks: 'מי עוד לא סימן איך מגיע' },
  { key: 'money', emoji: '💸', label: 'כסף והתחשבנות', hint: 'הוצאות משותפות, בקשות תשלום ומי מעביר למי', tracks: 'מי עוד לא שילם' },
  { key: 'lists', emoji: '🛒', label: 'מי מביא מה', hint: 'רשימות משותפות — כל אחד לוקח משהו', tracks: 'מי עוד לא לקח כלום' },
  { key: 'packing', emoji: '🎒', label: 'רשימת אריזה אישית', hint: 'כל אחד והרשימה שלו', tracks: 'תזכורת לארוז לפני היציאה' },
  { key: 'tasks', emoji: '✅', label: 'משימות', hint: 'מי אחראי על מה ועד מתי', tracks: 'תזכורת כשמגיע הזמן' },
  { key: 'polls', emoji: '📊', label: 'סקרים', hint: 'מתי יוצאים, מה אוכלים — כולם מצביעים', tracks: 'מי עוד לא הצביע' },
  { key: 'schedule', emoji: '⏰', label: 'לו״ז', hint: 'מה קורה ומתי' },
  { key: 'rooms', emoji: '🛏️', label: 'חדרים', hint: 'מי ישן איפה', tracks: 'מי עוד בלי חדר' },
  { key: 'bookings', emoji: '🏨', label: 'הזמנות ועלויות', hint: 'טיסות, לינה וכמה זה עולה לאדם' },
];

/** All modules on, then `off` switched off: {rides: true, …}. */
const mods = (...off) => Object.fromEntries(MODULES.map((m) => [m.key, !off.includes(m.key)]));

/** Ways to get there an admin can offer. car/taxi/meet are "rides" (someone organises, others ask/join). */
export const ARRIVAL_MODES = [
  { key: 'car', emoji: '🚗', label: 'טרמפים ברכבים', offer: 'אני נוהג/ת — יש לי מקום' },
  { key: 'taxi', emoji: '🚕', label: 'מונית משותפת', offer: 'מארגן/ת מונית משותפת' },
  { key: 'meet', emoji: '🚆', label: 'נקודת מפגש (רכבת / אוטובוס / בשדה)', offer: 'קובע/ת נקודת מפגש' },
  { key: 'own', emoji: '🧍', label: 'כל אחד בדרך שלו' },
  // to the airport: someone drops me off / train or bus / we park at the airport (a car ride that may offer seats)
  { key: 'drop', emoji: '🙋', label: 'מקפיצים אותי' },
  { key: 'transit', emoji: '🚆', label: 'רכבת / אוטובוס' },
  { key: 'park', emoji: '🅿️', label: 'חניה בשדה', offer: 'חונה בשדה — יש לי מקום' },
];
const CAR_ONLY = { modes: ['car', 'own'], flights: false };
const FLYING = { modes: ['taxi', 'car', 'meet', 'own'], flights: true };
const AIRPORT_MODES = ['taxi', 'car', 'drop', 'transit', 'park'];
const TO_AIRPORT = { modes: AIRPORT_MODES, flights: true };

/** Airports a trip abroad flies from (chips); anything else is a free 3-letter IATA code. */
export const AIRPORTS = [
  { iata: 'TLV', label: 'נתב״ג' },
  { iata: 'ETM', label: 'רמון' },
  { iata: 'HFA', label: 'חיפה' },
];
const IATA_RE = /^[A-Z]{3}$/;

const cat = (emoji, name) => ({ emoji, name });

// Shared items: t = title, c = category name, k = kind ('buy' | 'bring' | 'each' | 'task'), n = how many.
const it = (c, t, k = 'bring', n = 1) => ({ c, t, k, n });

const CAMP_CATS = [
  cat('🥩', 'בשר ועוף'), cat('🥗', 'ירקות ופירות'), cat('🥫', 'מזווה ורטבים'), cat('🍿', 'נשנושים ומתוקים'),
  cat('🥤', 'שתייה ואלכוהול'), cat('🔥', 'מנגל ובישול'), cat('🍽️', 'חד־פעמי'), cat('⛺', 'ציוד קבוצתי'),
  cat('🎲', 'כיף ומשחקים'), cat('📋', 'משימות'),
];

const ABROAD_PACKING = [
  'דרכון (בתוקף לחצי שנה לפחות)', 'ביטוח נסיעות', 'כרטיס טיסה / בורדינג פס', 'כרטיס אשראי + קצת מזומן במטבע המקומי',
  'מתאם חשמל', 'מטען + סוללה ניידת', 'אוזניות', 'תרופות אישיות', 'משקפי שמש', 'ערכת רחצה (עד 100 מ״ל ביד)',
  'ביגוד לפי מזג האוויר', 'בגדים ליציאה בערב', 'נעליים נוחות להליכה', 'בגד ים + כפכפים', 'עט (לטפסים בשדה)',
];

/**
 * The flat trip types from before families (legacy `settings.type`). Kept as is: old trips map onto families
 * through resolveType, and the old signatures (typeModules(key), tripSeed(key), schedulePresets(key)) still
 * return exactly what they did. The families below reuse this content.
 */
export const TRIP_TYPES = [
  {
    key: 'camping', emoji: '⛺', label: 'קמפינג', hint: 'אוהלים, מנגל ומדורה',
    placeholder: 'למשל: קמפינג סוכות בכנרת',
    modules: mods('rooms', 'bookings'),
    arrival: CAR_ONLY,
    ask: { home: true }, // welcome: "what do you have at home?"
    categories: CAMP_CATS,
    items: [
      it('ציוד קבוצתי', 'גזיבו / צל'), it('ציוד קבוצתי', 'שולחן מתקפל'), it('ציוד קבוצתי', 'כיסאות', 'each'),
      it('ציוד קבוצתי', 'תאורה לחניון'), it('ציוד קבוצתי', 'צידנית + קרח', 'bring', 2), it('מנגל ובישול', 'מנגל + רשת'),
      it('מנגל ובישול', 'פחמים', 'buy', 2), it('מנגל ובישול', 'גזייה + פינג׳אן'), it('חד־פעמי', 'צלחות, כוסות וסכו״ם', 'buy'),
      it('חד־פעמי', 'שקיות זבל', 'buy'), it('שתייה ואלכוהול', 'מים', 'buy', 6), it('כיף ומשחקים', 'רמקול'),
      it('משימות', 'לתאם מקום בחניון', 'task'),
    ],
    packing: [
      'אוהל', 'מזרן / מזרן מתנפח + משאבה', 'שק שינה / שמיכה', 'כרית', 'מגבת', 'בגד ים', 'כפכפים', 'קרם הגנה', 'כובע',
      'פנס ראש / פנס', 'סוללה ניידת + מטען', 'בגדים חמים ללילה', 'ביגוד להחלפה', 'מברשת שיניים ומשחה',
      'תרופות אישיות', 'בקבוק מים אישי', 'תעודה מזהה / כרטיסי כניסה',
    ],
    schedule: (s, e) => [
      ['🚗', 'יציאה', s], ['⛺', 'הקמת המחנה', add(s, 120)], ['🥪', 'ארוחת צהריים', '13:30'], ['🔥', 'על האש', '19:30'],
      ['🎶', 'מדורה ושירים', '21:30'], ['☕', 'קפה וארוחת בוקר', '08:30'], ['🧹', 'פירוק וניקיון', add(e, -120)], ['🏠', 'חזרה הביתה', e],
    ],
  },
  {
    key: 'abroad', emoji: '✈️', label: 'חו״ל', hint: 'טיסות, מטבע, דרכונים',
    placeholder: 'למשל: סופ״ש בברצלונה',
    modules: mods(),
    arrival: FLYING,
    ask: { home: false }, // welcome: "what do you have at home?"
    categories: [cat('📄', 'מסמכים'), cat('🧳', 'ציוד משותף'), cat('💊', 'עזרה ראשונה'), cat('🎲', 'כיף ומשחקים'), cat('📋', 'משימות')],
    items: [
      it('מסמכים', 'דרכון בתוקף (6 חודשים לפחות)', 'each'), it('מסמכים', 'ביטוח נסיעות', 'each'),
      it('משימות', 'להזמין לינה', 'task'), it('משימות', 'השכרת רכב / העברות בשדה', 'task'),
      it('משימות', 'צ׳ק־אין לטיסה', 'task'), it('ציוד משותף', 'מפצל חשמל'), it('ציוד משותף', 'רמקול קטן'),
      it('עזרה ראשונה', 'ערכת עזרה ראשונה'), it('עזרה ראשונה', 'אקמול / נורופן'),
    ],
    packing: ABROAD_PACKING,
    schedule: (s, e) => [
      ['🚕', 'יוצאים לשדה', add(s, -180)], ['✈️', 'טיסה', s], ['🏨', 'צ׳ק־אין במלון', add(s, 240)], ['🍽️', 'ארוחת ערב', '20:30'],
      ['☕', 'ארוחת בוקר', '09:00'], ['🗺️', 'סיור בעיר', '10:30'], ['🧳', 'צ׳ק־אאוט', '11:00'], ['✈️', 'טיסה חזרה', e],
    ],
  },
  {
    key: 'bachelor', emoji: '🥂', label: 'מסיבת רווקים/ות', hint: 'הפתעות, תלבושות, בילויים',
    placeholder: 'למשל: הרווקים של דניאל 🥂',
    modules: mods(),
    arrival: FLYING,
    ask: { home: false }, // welcome: "what do you have at home?"
    categories: [cat('📄', 'מסמכים'), cat('🎁', 'הפתעות'), cat('👕', 'תלבושות ומיתוג'), cat('🍾', 'שתייה ומסיבה'), cat('🎵', 'מוזיקה וציוד'), cat('📋', 'משימות')],
    items: [
      it('מסמכים', 'דרכון בתוקף (6 חודשים לפחות)', 'each'), it('מסמכים', 'ביטוח נסיעות', 'each'),
      it('משימות', 'להזמין לינה', 'task'), it('משימות', 'להחליט על פעילויות ולהזמין מראש', 'task'),
      it('משימות', 'סרטון ברכות מהחברים והמשפחה', 'task'), it('משימות', 'לגבות תקציב משותף', 'task'),
      it('תלבושות ומיתוג', 'חולצות מודפסות לקבוצה', 'buy'), it('תלבושות ומיתוג', 'תחפושת / אביזר לחתן או לכלה', 'buy'),
      it('הפתעות', 'הפתעה לחתן / לכלה', 'task'), it('שתייה ומסיבה', 'משחקי שתייה'), it('מוזיקה וציוד', 'רמקול נייד'),
      it('מוזיקה וציוד', 'פלייליסט משותף', 'task'),
    ],
    packing: [...ABROAD_PACKING, 'חולצת הקבוצה', 'משהו לחגוג בו 🎉'],
    schedule: (s, e) => [
      ['🚕', 'יוצאים לשדה', add(s, -180)], ['✈️', 'טיסה', s], ['🏨', 'צ׳ק־אין', add(s, 240)], ['🍻', 'ערב פתיחה', '21:00'],
      ['😴', 'בוקר עצלן', '11:00'], ['🎯', 'פעילות', '14:00'], ['🍽️', 'ארוחת ערב חגיגית', '20:30'], ['🎉', 'יוצאים לבלות', '23:00'],
      ['✈️', 'טיסה חזרה', e],
    ],
  },
  {
    key: 'villa', emoji: '🏡', label: 'צימר / וילה', hint: 'בישולים, בריכה, חדרים',
    placeholder: 'למשל: סופ״ש בווילה בגליל',
    modules: mods(),
    arrival: CAR_ONLY,
    ask: { home: true }, // welcome: "what do you have at home?"
    categories: [
      cat('🥩', 'בשר ועוף'), cat('🥗', 'ירקות ופירות'), cat('🥐', 'ארוחות בוקר'), cat('🍿', 'נשנושים ומתוקים'),
      cat('🥤', 'שתייה ואלכוהול'), cat('🧻', 'כללי לבית'), cat('🎲', 'כיף ומשחקים'), cat('📋', 'משימות'),
    ],
    items: [
      it('משימות', 'להזמין את המקום ולשלם מקדמה', 'task'), it('משימות', 'חלוקת חדרים', 'task'),
      it('ארוחות בוקר', 'לחמים ומאפים', 'buy'), it('ארוחות בוקר', 'גבינות וממרחים', 'buy'), it('ארוחות בוקר', 'ביצים', 'buy', 2),
      it('כללי לבית', 'נייר טואלט ומגבות נייר', 'buy'), it('כללי לבית', 'סבון כלים וספוגים', 'buy'),
      it('כיף ומשחקים', 'משחקי קופסה'), it('כיף ומשחקים', 'רמקול'),
    ],
    packing: ['בגד ים', 'כפכפים', 'מגבת בריכה', 'פיג׳מה', 'ביגוד להחלפה', 'בגדים חמים לערב', 'מברשת שיניים ומשחה', 'תרופות אישיות', 'מטען'],
    schedule: (s, e) => [
      ['🚗', 'יציאה', s], ['🔑', 'צ׳ק־אין', '15:00'], ['🏊', 'בריכה', '16:00'], ['🍖', 'ארוחת ערב', '20:00'],
      ['🎲', 'ערב משחקים', '22:00'], ['🥐', 'ארוחת בוקר', '09:30'], ['🧹', 'מסדרים ויוצאים', add(e, -60)], ['🏠', 'צ׳ק־אאוט', e],
    ],
  },
  {
    key: 'family', emoji: '👨‍👩‍👧', label: 'משפחות', hint: 'ילדים, ארוחות, תורנויות',
    placeholder: 'למשל: טיול משפחות לגולן',
    modules: mods('rooms', 'bookings'),
    arrival: CAR_ONLY,
    ask: { home: true }, // welcome: "what do you have at home?"
    categories: [...CAMP_CATS.slice(0, 9), cat('🧸', 'לילדים'), cat('📋', 'משימות')],
    items: [
      it('לילדים', 'משחקים וצעצועים לחוץ'), it('לילדים', 'חטיפים לילדים', 'buy'), it('לילדים', 'ערכת יצירה'),
      it('ציוד קבוצתי', 'גזיבו / צל'), it('ציוד קבוצתי', 'שולחן מתקפל'), it('ציוד קבוצתי', 'כיסאות', 'each'),
      it('מנגל ובישול', 'מנגל + רשת'), it('חד־פעמי', 'צלחות, כוסות וסכו״ם', 'buy'), it('משימות', 'לתאם מקום', 'task'),
    ],
    packing: [
      'בגדים להחלפה (גם לילדים)', 'חיתולים ומגבונים', 'בקבוקים ומוצץ', 'עגלה / מנשא', 'כובעים וקרם הגנה',
      'תרופות (גם לילדים)', 'צעצוע / בובה לשינה', 'פיג׳מות', 'מגבות', 'בקבוקי מים', 'חטיפים לדרך',
    ],
    schedule: (s, e) => [
      ['🚗', 'יציאה', s], ['🧺', 'פיקניק', '12:30'], ['🌳', 'פעילות לילדים', '16:00'], ['🍝', 'ארוחת ערב', '18:30'],
      ['😴', 'השכבות', '20:30'], ['☕', 'ארוחת בוקר', '08:00'], ['🧹', 'מסדרים', add(e, -90)], ['🏠', 'חזרה', e],
    ],
  },
  {
    key: 'work', emoji: '💼', label: 'עבודה / גיבוש', hint: 'לו״ז, אישורי הגעה, בלי התחשבנות',
    placeholder: 'למשל: יום גיבוש צוות',
    modules: mods('money', 'rooms', 'bookings'),
    arrival: { modes: ['car', 'meet', 'own'], flights: false },
    ask: { home: false }, // welcome: "what do you have at home?"
    categories: [cat('📋', 'משימות'), cat('🎤', 'ציוד והצגה'), cat('☕', 'כיבוד')],
    items: [
      it('משימות', 'לאשר תקציב', 'task'), it('משימות', 'להזמין מקום / הסעה', 'task'), it('משימות', 'לאסוף העדפות אוכל', 'task'),
      it('ציוד והצגה', 'מחשב + מתאם למקרן'), it('כיבוד', 'קפה ומאפים', 'buy'),
    ],
    packing: ['מחשב נייד + מטען', 'תג עובד', 'בגדים נוחים', 'בקבוק מים', 'כובע'],
    schedule: (s, e) => [
      ['🚌', 'יציאה', s], ['☕', 'התכנסות וקפה', add(s, 60)], ['🎤', 'פתיחה', add(s, 90)], ['🧩', 'פעילות', '11:00'],
      ['🍽️', 'ארוחת צהריים', '13:00'], ['🎯', 'סדנה', '14:30'], ['🏁', 'סיכום', add(e, -60)], ['🏠', 'חזרה', e],
    ],
  },
  {
    key: 'event', emoji: '🎉', label: 'אירוע / מסיבה', hint: 'יום הולדת, ארוחה, מתנה',
    placeholder: 'למשל: יום הולדת 30 לנועה',
    modules: mods('rides', 'packing', 'rooms', 'bookings'),
    arrival: CAR_ONLY,
    ask: { home: false }, // welcome: "what do you have at home?"
    categories: [cat('🍰', 'אוכל'), cat('🥤', 'שתייה'), cat('🎈', 'קישוטים'), cat('🎁', 'מתנה'), cat('📋', 'משימות')],
    items: [
      it('משימות', 'להזמין מקום', 'task'), it('משימות', 'לאסוף כסף למתנה', 'task'), it('מתנה', 'מתנה', 'buy'),
      it('מתנה', 'ברכה משותפת', 'task'), it('קישוטים', 'בלונים', 'buy'), it('אוכל', 'עוגה', 'buy'), it('שתייה', 'שתייה קלה', 'buy', 2),
    ],
    packing: ['בגדים לאירוע', 'מטען', 'מתנה / ברכה'],
    schedule: (s, e) => [['🎈', 'הכנות וקישוטים', add(s, -120)], ['🎉', 'מתחילים', s], ['🍰', 'עוגה וברכות', add(s, 120)], ['🧹', 'מסדרים', add(e, -30)]],
  },
  {
    key: 'trek', emoji: '🥾', label: 'טרק / שטח', hint: 'מסלול, מים, ציוד בטיחות',
    placeholder: 'למשל: שביל ישראל — קטע 3',
    modules: mods('rooms', 'bookings'),
    arrival: { modes: ['car', 'meet', 'own'], flights: false },
    ask: { home: true }, // welcome: "what do you have at home?"
    categories: [cat('🥾', 'ציוד שטח'), cat('🍫', 'אוכל לדרך'), cat('💊', 'עזרה ראשונה'), cat('📋', 'משימות')],
    items: [
      it('משימות', 'לתאם מסלול ורכב איסוף', 'task'), it('משימות', 'לבדוק מזג אוויר וסגירות', 'task'),
      it('ציוד שטח', 'מפה / מסלול במכשיר'), it('ציוד שטח', 'גזייה + קפה'), it('אוכל לדרך', 'חטיפי אנרגיה', 'buy'),
      it('אוכל לדרך', 'פירות יבשים', 'buy'), it('עזרה ראשונה', 'ערכת עזרה ראשונה'),
    ],
    packing: ['נעלי הליכה', '3 ליטר מים', 'כובע', 'קרם הגנה', 'שכבה חמה', 'פנס ראש', 'תיק גב', 'תרופות אישיות', 'סוללה ניידת', 'תעודה מזהה'],
    schedule: (s, e) => [['🚗', 'יציאה', s], ['🥾', 'תחילת המסלול', add(s, 90)], ['🍫', 'הפסקה', '11:00'], ['🥪', 'צהריים', '13:00'], ['🏁', 'סוף המסלול', add(e, -60)], ['🏠', 'חזרה', e]],
  },
];

function add(hm, min) {
  const [h, m] = String(hm || '').split(':').map(Number);
  if (!Number.isFinite(h)) return '';
  const t = (((h * 60 + (m || 0) + min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

const LEGACY = Object.fromEntries(TRIP_TYPES.map((t) => [t.key, t]));

// ───────────────────────── families & sub-types ─────────────────────────
// A family holds the base content; a sub-type adds to it (categories/items/packingExtra) or, with
// `replace`, brings its own categories + items (+ `packing`) instead. `legacy: [key, where]` names the old flat
// type it equals (its key is kept as the composed `.key`). Days: (s, e) => [[emoji, label, time]], s/e = 'HH:MM'.

const KIDS = cat('🧸', 'לילדים');
const TASKS = cat('📋', 'משימות');
const DOCS = cat('📄', 'מסמכים');
const DOC_ITEMS = [it('מסמכים', 'דרכון בתוקף (6 חודשים לפחות)', 'each'), it('מסמכים', 'ביטוח נסיעות', 'each')];
const KIDS_PACKING = [
  'חיתולים ומגבונים', 'בקבוקים ומוצץ', 'עגלה / מנשא', 'בגדים להחלפה לילדים', 'תרופות לילדים', 'צעצוע / בובה לשינה',
  'פיג׳מות', 'חטיפים לדרך',
];
const PARTY_PACKING = ['חולצת הקבוצה', 'משהו לחגוג בו 🎉'];

// Rows around a flight are relative to it and may fall on another day: a 4th element moves the row to the day
// before (−1) or after (+1) in schedulePlan — a 01:30 flight leaves for the airport the evening before, a
// 22:00 flight checks in after midnight. schedulePresets (one day) ignores it.
const ABROAD_DAYS = {
  single: LEGACY.abroad.schedule,
  arrival: (s) => {
    const leave = add(s, -180);
    const checkin = add(s, 240);
    const nextDay = checkin < s;
    return [
      ['🚕', 'יוצאים לשדה', leave, leave > s ? -1 : 0], ['✈️', 'טיסה', s], ['🏨', 'צ׳ק־אין', checkin, nextDay ? 1 : 0],
      ...(nextDay || checkin > '20:00' ? [] : [['🍽️', 'ארוחת ערב', '20:30']]),
    ];
  },
  full: () => [['☕', 'ארוחת בוקר', '09:00'], ['🗺️', 'סיור', '10:30'], ['🍽️', 'צהריים', '13:30'], ['🛍️', 'זמן חופשי', '16:00'], ['🍷', 'ערב', '20:30']],
  last: (s, e) => {
    const go = add(e, -180);
    const before = go > e ? -1 : 0;         // a night flight home: check out and leave the day before
    return [['🧳', 'צ׳ק־אאוט', '11:00', before], ['🛍️', 'קניות אחרונות', '12:00', before], ['🚕', 'לשדה', go, before], ['✈️', 'טיסה חזרה', e]];
  },
};

const FAMILY_DEFS = [
  {
    key: 'camping', emoji: '⛺', label: 'טבע וקמפינג', hint: 'אוהלים, מנגל, משפחות ומסלולים', where: 'il',
    placeholder: LEGACY.camping.placeholder,
    categories: CAMP_CATS, items: LEGACY.camping.items, packing: LEGACY.camping.packing,
    modules: mods('rooms', 'bookings'), arrival: CAR_ONLY, ask: { home: true },
    expenseTags: [['🥩', 'אוכל'], ['🍺', 'שתייה'], ['⛺', 'ציוד'], ['⛽', 'דלק'], ['🎟️', 'כניסה / חניון']],
    days: {
      single: LEGACY.camping.schedule,
      arrival: (s) => [['🚗', 'יציאה', s], ['⛺', 'הקמת המחנה', add(s, 120)], ['🥪', 'צהריים', '13:30'], ['🔥', 'על האש', '19:30'], ['🎶', 'מדורה', '21:30']],
      full: () => [['☕', 'קפה וארוחת בוקר', '08:30'], ['🏊', 'מים / טיול', '10:30'], ['🥪', 'צהריים', '13:30'], ['😴', 'מנוחה', '15:00'], ['🔥', 'ערב', '19:30']],
      last: (s, e) => [['☕', 'ארוחת בוקר', '08:30'], ['🧹', 'פירוק וניקיון', add(e, -120)], ['🏠', 'חזרה הביתה', e]],
    },
    subtypes: [
      { key: 'camping', emoji: '⛺', label: 'קמפינג עם אוהלים', hint: LEGACY.camping.hint, placeholder: LEGACY.camping.placeholder, legacy: ['camping', 'il'] },
      {
        key: 'family', emoji: '👨‍👩‍👧', label: 'משפחות בטבע', hint: LEGACY.family.hint, placeholder: LEGACY.family.placeholder, legacy: ['family', 'il'],
        categories: [KIDS], items: LEGACY.family.items.filter((x) => x.c === 'לילדים'), packingExtra: KIDS_PACKING,
        days: {
          single: LEGACY.family.schedule,
          full: () => [['☕', 'ארוחת בוקר', '08:00'], ['🌳', 'פעילות לילדים', '10:00'], ['🧺', 'צהריים', '12:30'], ['😴', 'מנוחת צהריים', '14:30'], ['🍝', 'ארוחת ערב', '18:30'], ['🌙', 'השכבות', '20:30']],
        },
      },
      {
        key: 'trek', emoji: '🥾', label: 'טרק / שטח', hint: LEGACY.trek.hint, placeholder: LEGACY.trek.placeholder, legacy: ['trek', 'il'],
        replace: true, categories: LEGACY.trek.categories,
        items: [...LEGACY.trek.items, it('משימות', 'לשלוח את המסלול למישהו שנשאר בבית', 'task')],
        packing: LEGACY.trek.packing, arrival: { modes: ['car', 'meet', 'own'], flights: false },
        days: {
          single: LEGACY.trek.schedule,
          arrival: (s) => [['🚗', 'יציאה', s], ['🥾', 'תחילת המסלול', add(s, 90)], ['🥪', 'צהריים', '13:00'], ['⛺', 'חניון לילה', '17:00'], ['🍲', 'ארוחת ערב', '19:00']],
          full: () => [['☕', 'השכמה וקפה', '06:30'], ['🥾', 'יוצאים לדרך', '07:30'], ['🍫', 'הפסקה', '10:30'], ['🥪', 'צהריים', '13:00'], ['⛺', 'חניון לילה', '17:00']],
          last: (s, e) => [['☕', 'השכמה וקפה', '06:30'], ['🥾', 'יוצאים לדרך', '07:30'], ['🏁', 'סוף המסלול', add(e, -60)], ['🏠', 'חזרה', e]],
        },
      },
    ],
  },
  {
    key: 'stay', emoji: '🏡', label: 'חופשה בארץ', hint: 'וילה, צימר או מלון', where: 'il',
    placeholder: LEGACY.villa.placeholder,
    categories: LEGACY.villa.categories, items: LEGACY.villa.items, packing: LEGACY.villa.packing,
    modules: mods(), arrival: CAR_ONLY, ask: { home: true },
    expenseTags: [['🏡', 'לינה'], ['🛒', 'סופר'], ['🍽️', 'מסעדות'], ['⛽', 'דלק'], ['🎯', 'אטרקציות']],
    days: {
      single: LEGACY.villa.schedule,
      arrival: (s) => [['🚗', 'יציאה', s], ['🔑', 'צ׳ק־אין', '15:00'], ['🏊', 'בריכה', '16:00'], ['🍖', 'ארוחת ערב', '20:00'], ['🎲', 'ערב משחקים', '22:00']],
      full: () => [['🥐', 'ארוחת בוקר', '09:30'], ['🗺️', 'טיול באזור', '11:00'], ['🥪', 'צהריים', '14:00'], ['🏊', 'בריכה / מנוחה', '16:00'], ['🍖', 'ארוחת ערב', '20:00']],
      last: (s, e) => [['🥐', 'ארוחת בוקר', '09:30'], ['🧹', 'מסדרים ויוצאים', add(e, -60)], ['🏠', 'צ׳ק־אאוט', e]],
    },
    subtypes: [
      { key: 'villa', emoji: '🏡', label: 'וילה / צימר עם חברים', hint: LEGACY.villa.hint, placeholder: LEGACY.villa.placeholder, legacy: ['villa', 'il'] },
      {
        key: 'couple', emoji: '💑', label: 'צימר זוגי', hint: 'רק שניכם, בלי לחץ', placeholder: 'למשל: סופ״ש זוגי בגליל',
        replace: true, categories: [cat('🥐', 'ארוחות בוקר'), TASKS],
        items: [it('משימות', 'להזמין צימר', 'task'), it('משימות', 'להזמין ארוחת ערב רומנטית', 'task'), it('ארוחות בוקר', 'ארוחת בוקר מפנקת', 'buy')],
        packingExtra: ['בגד ים לג׳קוזי', 'יין / בקבוק לערב', 'נרות ריחניים', 'רמקול קטן', 'משהו יפה לערב'],
        modules: mods('rides', 'money', 'lists', 'polls', 'rooms'), ask: { home: false },
        expenseTags: [['🏡', 'לינה'], ['🍽️', 'מסעדות'], ['💆', 'ספא'], ['🎯', 'אטרקציות'], ['⛽', 'דלק']],
        days: { full: () => [['🥐', 'ארוחת בוקר', '10:00'], ['💆', 'ספא / ג׳קוזי', '12:00'], ['🗺️', 'טיול קטן באזור', '15:00'], ['🍷', 'ארוחת ערב רומנטית', '20:30']] },
      },
      {
        key: 'hotel', emoji: '🏨', label: 'מלון עם הילדים', hint: 'בריכה, מועדון ילדים, חדרי משפחה', placeholder: 'למשל: מלון באילת עם הילדים',
        replace: true, categories: [KIDS, cat('🎲', 'כיף ומשחקים'), TASKS],
        items: [
          it('משימות', 'להזמין חדרים / סוויטות', 'task'), it('משימות', 'לבדוק מועדון ילדים ושעות בריכה', 'task'),
          it('לילדים', 'מצופים וגלגלי ים'), it('לילדים', 'משחקים לבריכה'), it('כיף ומשחקים', 'משחקי קופסה'),
        ],
        packingExtra: [...KIDS_PACKING, 'בגדי ים לכולם', 'כובעים'],
        modules: mods('lists'), ask: { home: false },
        expenseTags: [['🏨', 'לינה'], ['🍽️', 'מסעדות'], ['🎯', 'אטרקציות'], ['🛍️', 'קניות'], ['⛽', 'דלק']],
        days: {
          arrival: (s) => [['🚗', 'יציאה', s], ['🔑', 'צ׳ק־אין', '15:00'], ['🏊', 'בריכה', '16:00'], ['🍝', 'ארוחת ערב', '19:00']],
          full: () => [['🍳', 'ארוחת בוקר', '08:30'], ['🏊', 'בריכה', '10:00'], ['🍽️', 'צהריים', '13:00'], ['🧸', 'מועדון ילדים', '16:00'], ['🍝', 'ארוחת ערב', '19:00'], ['🌙', 'השכבות', '20:30']],
          last: (s, e) => [['🍳', 'ארוחת בוקר', '08:30'], ['🧳', 'צ׳ק־אאוט', '11:00'], ['🏠', 'חזרה הביתה', e]],
        },
      },
    ],
  },
  {
    key: 'abroad', emoji: '✈️', label: 'חו״ל', hint: 'טיסות, מטבע, דרכונים', where: 'abroad',
    placeholder: LEGACY.abroad.placeholder,
    categories: LEGACY.abroad.categories, items: LEGACY.abroad.items, packing: ABROAD_PACKING,
    modules: mods(), arrival: TO_AIRPORT, ask: { home: false },
    expenseTags: [['✈️', 'טיסות'], ['🏨', 'לינה'], ['🚕', 'תחבורה'], ['🍽️', 'אוכל'], ['🎟️', 'אטרקציות'], ['🛍️', 'קניות']],
    days: ABROAD_DAYS,
    subtypes: [
      {
        key: 'couple', emoji: '💑', label: 'חופשה זוגית', hint: 'רק שניכם', placeholder: 'למשל: חופשה זוגית ביוון',
        replace: true, categories: [DOCS, TASKS],
        items: [
          ...DOC_ITEMS, it('משימות', 'להזמין טיסות', 'task'), it('משימות', 'להזמין מלון', 'task'),
          it('משימות', 'להשכיר רכב / העברה מהשדה', 'task'), it('משימות', 'ארוחה חגיגית בערב הראשון', 'task'),
          it('משימות', 'צ׳ק־אין לטיסה 24 שעות לפני', 'task'),
        ],
        packingExtra: ['בגד ערב', 'בושם'],
        modules: mods('rides', 'money', 'lists', 'polls', 'rooms'),
      },
      {
        key: 'family', emoji: '👨‍👩‍👧', label: 'חופשה משפחתית', hint: 'ילדים, מושבים יחד, בוסטר', placeholder: 'למשל: משפחות ביוון באוגוסט',
        categories: [KIDS],
        items: [
          it('מסמכים', 'דרכונים לכל הילדים', 'each'), it('משימות', 'כיסא בטיחות / בוסטר ברכב השכור', 'task'),
          it('משימות', 'לבקש מושבים יחד בטיסה', 'task'), it('משימות', 'להוריד סרטים לטאבלט', 'task'),
          it('לילדים', 'עגלה מתקפלת לטיסה'), it('לילדים', 'חטיפים לטיסה', 'buy'), it('לילדים', 'טאבלט + אוזניות', 'each'),
        ],
        packingExtra: ['חיתולים / מגבונים לטיסה', 'בגדים להחלפה בתיק היד', 'תרופות ילדים (אקמול סירופ, מדחום)'],
      },
      { key: 'friends', emoji: '👯', label: 'חברים', hint: 'סופ״ש או שבוע עם החבר׳ה', placeholder: LEGACY.abroad.placeholder, legacy: ['abroad', 'abroad'] },
      {
        key: 'big', emoji: '🌍', label: 'הטיול הגדול', hint: 'טיול ארוך, תרמילאים', placeholder: 'למשל: שלושה חודשים בדרום אמריקה',
        categories: [cat('🏥', 'בריאות וחיסונים')],
        items: [
          it('משימות', 'חיסונים (4–6 שבועות לפני)', 'task'), it('משימות', 'ויזות / ESTA / eTA', 'task'),
          it('בריאות וחיסונים', 'ביטוח בריאות מורחב', 'each'), it('מסמכים', 'כרטיס אשראי בלי עמלות המרה', 'each'),
          it('מסמכים', 'eSIM / סים מקומי', 'each'), it('מסמכים', 'גיבוי מסמכים בענן', 'each'),
        ],
        packingExtra: ['תרמיל', 'מנעול לתיק', 'שקיות ואקום', 'כלי כביסה', 'פנס ראש', 'מגבת מיקרופייבר', 'ערכת תפירה קטנה'],
      },
    ],
  },
  {
    key: 'celebrate', emoji: '🎉', label: 'חוגגים בגדול', hint: 'יום הולדת, רווקים/ות, מסיבה', where: 'ask',
    placeholder: LEGACY.event.placeholder,
    categories: [cat('🍰', 'אוכל'), cat('🍾', 'שתייה'), cat('🎈', 'קישוטים'), cat('🎁', 'מתנה'), cat('🎵', 'מוזיקה וציוד'), TASKS],
    items: [it('משימות', 'להזמין מקום', 'task'), it('שתייה', 'שתייה קלה', 'buy', 2), it('מוזיקה וציוד', 'פלייליסט משותף', 'task')],
    packing: LEGACY.event.packing,
    modules: mods('rides', 'packing', 'rooms', 'bookings'), modulesAbroad: mods(),
    arrival: CAR_ONLY, ask: { home: false },
    expenseTags: [['🎁', 'מתנה'], ['🏠', 'מקום'], ['🍾', 'שתייה'], ['🍰', 'אוכל'], ['🎈', 'קישוטים'], ['🎯', 'פעילות']],
    expenseTagsAbroad: [['✈️', 'טיסות'], ['🏨', 'לינה']],
    days: {
      single: LEGACY.event.schedule,
      arrival: (s) => [['🚗', 'יציאה', s], ['🔑', 'מתמקמים', add(s, 60)], ['🎈', 'הכנות וקישוטים', '18:00'], ['🎉', 'חוגגים', '20:30']],
      full: () => [['☕', 'ארוחת בוקר', '10:00'], ['🎯', 'פעילות', '13:00'], ['🍽️', 'ארוחה חגיגית', '20:30'], ['🎉', 'מסיבה', '22:30']],
      last: (s, e) => [['☕', 'ארוחת בוקר', '10:00'], ['🧹', 'מסדרים', add(e, -60)], ['🏠', 'חזרה', e]],
    },
    subtypes: [
      {
        key: 'birthday', emoji: '🎂', label: 'יום הולדת', hint: 'עוגה, בלונים, מתנה משותפת', placeholder: 'למשל: יום הולדת 30 לנועה',
        items: [
          it('משימות', 'לאסוף כסף למתנה', 'task'), it('משימות', 'סרטון ברכות', 'task'), it('משימות', 'להזמין עוגה עם שם', 'task'),
          it('מתנה', 'מתנה', 'buy'), it('מתנה', 'ברכה משותפת', 'task'), it('קישוטים', 'בלונים עם מספר', 'buy'),
          it('קישוטים', 'שלט "יום הולדת שמח"', 'buy'), it('אוכל', 'עוגה', 'buy'), it('אוכל', 'נרות + מצית', 'buy'),
        ],
        days: { single: (s, e) => [['🎈', 'הכנות וקישוטים', add(s, -120)], ['🎉', 'מתחילים', s], ['🎂', 'עוגה וברכות', add(s, 120)], ['🎁', 'מתנה', add(s, 150)], ['🧹', 'מסדרים', add(e, -30)]] },
      },
      {
        key: 'bachelor', emoji: '🥂', label: 'מסיבת רווקים', hint: 'הפתעות לחתן, תלבושות, בילויים', legacy: ['bachelor', 'abroad'],
        placeholder: LEGACY.bachelor.placeholder, placeholderAbroad: 'למשל: הרווקים של דניאל בבוקרשט 🥂',
        replace: true, categories: LEGACY.bachelor.categories.filter((c) => c.name !== 'מסמכים'),
        items: [
          it('משימות', 'להזמין לינה', 'task'), it('משימות', 'להחליט על פעילויות ולהזמין מראש', 'task'),
          it('משימות', 'סרטון ברכות מהחברים והמשפחה', 'task'), it('משימות', 'לגבות תקציב משותף', 'task'),
          it('תלבושות ומיתוג', 'חולצות מודפסות לקבוצה', 'buy'), it('תלבושות ומיתוג', 'תחפושת / אביזר לחתן', 'buy'),
          it('הפתעות', 'הפתעה לחתן', 'task'), it('שתייה ומסיבה', 'משחקי שתייה'), it('מוזיקה וציוד', 'רמקול נייד'),
          it('מוזיקה וציוד', 'פלייליסט משותף', 'task'),
        ],
        packingExtra: PARTY_PACKING,
        days: {
          single: (s, e) => [['🚗', 'נפגשים', s], ['🎯', 'פעילות', add(s, 60)], ['🍽️', 'ארוחה חגיגית', '20:30'], ['🎉', 'יוצאים לבלות', '23:00'], ['🏠', 'חזרה', e]],
          full: () => [['😴', 'בוקר עצלן', '11:00'], ['🎯', 'פעילות', '14:00'], ['🍽️', 'ארוחה חגיגית', '20:30'], ['🎉', 'יוצאים לבלות', '23:00']],
        },
        daysAbroad: { single: LEGACY.bachelor.schedule },
      },
      {
        key: 'bachelorette', emoji: '👰', label: 'מסיבת רווקות', hint: 'הפתעות לכלה, ספא, בילויים',
        placeholder: 'למשל: הרווקות של מאיה 👰', placeholderAbroad: 'למשל: הרווקות של מאיה באתונה 👰',
        replace: true, categories: LEGACY.bachelor.categories.filter((c) => c.name !== 'מסמכים'),
        items: [
          it('משימות', 'להזמין לינה', 'task'), it('משימות', 'ספא / סדנה', 'task'), it('משימות', 'מסלול טעימות / מסעדה', 'task'),
          it('משימות', 'צלם/ת לערב', 'task'), it('משימות', 'סרטון ברכות מהחברות והמשפחה', 'task'), it('משימות', 'לגבות תקציב משותף', 'task'),
          it('תלבושות ומיתוג', 'חולצות / גלימות מודפסות', 'buy'), it('תלבושות ומיתוג', 'הינומה / סרט "Bride to be"', 'buy'),
          it('הפתעות', 'הפתעה לכלה', 'task'), it('הפתעות', 'אלבום / קופסת זיכרונות', 'task'), it('שתייה ומסיבה', 'משחקי שתייה'),
          it('מוזיקה וציוד', 'רמקול נייד'), it('מוזיקה וציוד', 'פלייליסט משותף', 'task'),
        ],
        packingExtra: PARTY_PACKING,
        days: {
          single: (s, e) => [['🚗', 'נפגשים', s], ['💆', 'ספא / סדנה', add(s, 60)], ['🍽️', 'ארוחה חגיגית', '20:30'], ['🎉', 'יוצאות לבלות', '23:00'], ['🏠', 'חזרה', e]],
          full: () => [['😴', 'בוקר עצלן', '11:00'], ['💆', 'ספא / סדנה', '14:00'], ['🍽️', 'ארוחה חגיגית', '20:30'], ['🎉', 'יוצאות לבלות', '23:00']],
        },
        daysAbroad: { single: LEGACY.bachelor.schedule },
      },
      {
        key: 'anniversary', emoji: '💍', label: 'יום נישואים', hint: 'מסעדה, הפתעה, אולי בייביסיטר', placeholder: 'למשל: 10 שנים לנו 💍',
        replace: true, categories: [cat('🎁', 'מתנה'), TASKS],
        items: [
          it('משימות', 'להזמין מסעדה / מקום', 'task'), it('משימות', 'מצגת תמונות מהשנים', 'task'), it('משימות', 'לתאם בייביסיטר', 'task'),
          it('מתנה', 'מתנה', 'buy'), it('מתנה', 'זר פרחים', 'buy'),
        ],
        modules: mods('rides', 'money', 'lists', 'packing', 'polls', 'rooms'),
        modulesAbroad: mods('rides', 'money', 'lists', 'polls', 'rooms'),
        days: { single: (s, e) => [['💐', 'פרחים והפתעה', add(s, -60)], ['🍷', 'ארוחה חגיגית', s], ['🎁', 'מתנה', add(s, 90)], ['🏠', 'הביתה', e]] },
      },
      { key: 'event', emoji: '🎈', label: 'ערב / מסיבה', hint: LEGACY.event.hint, placeholder: LEGACY.event.placeholder, legacy: ['event', 'il'], items: LEGACY.event.items },
    ],
  },
  {
    key: 'work', emoji: '💼', label: 'עבודה וגיבוש', hint: 'לו״ז, אישורי הגעה, בלי התחשבנות', where: 'ask',
    placeholder: LEGACY.work.placeholder,
    categories: LEGACY.work.categories, items: LEGACY.work.items, packing: LEGACY.work.packing,
    modules: mods('money', 'rooms', 'bookings'), modulesAbroad: mods('money'),
    arrival: { modes: ['car', 'meet', 'own'], flights: false }, ask: { home: false },
    expenseTags: [['🚌', 'הסעה'], ['🍽️', 'כיבוד'], ['🎯', 'פעילות'], ['🏨', 'לינה']],
    expenseTagsAbroad: [['✈️', 'טיסות']],
    days: {
      single: LEGACY.work.schedule,
      arrival: (s) => [['🚌', 'יציאה', s], ['☕', 'התכנסות וקפה', add(s, 60)], ['🎤', 'פתיחה', add(s, 90)], ['🍽️', 'צהריים', '13:00'], ['🧩', 'סדנה', '14:30'], ['🍷', 'ערב צוות', '19:30']],
      full: () => [['☕', 'התכנסות', '08:30'], ['🎤', 'מושב בוקר', '09:00'], ['🍽️', 'צהריים', '13:00'], ['🧩', 'סדנה', '14:30'], ['🍷', 'ערב צוות', '19:30']],
      last: (s, e) => [['☕', 'ארוחת בוקר', '08:00'], ['🎤', 'מושב סיכום', '09:30'], ['🏁', 'סיכום', add(e, -60)], ['🏠', 'חזרה', e]],
    },
    subtypes: [
      { key: 'teamday', emoji: '🧩', label: 'יום גיבוש', hint: 'יום אחד, פעילות וארוחה', placeholder: LEGACY.work.placeholder, legacy: ['work', 'il'] },
      {
        key: 'offsite', emoji: '🏨', label: 'כנס / אוף־סייט', hint: 'כמה ימים, מלון ואולם', placeholder: 'למשל: אוף־סייט רבעוני באילת',
        items: [
          it('משימות', 'להזמין מלון ואולם', 'task'), it('משימות', 'אישורי הגעה', 'task'), it('משימות', 'תפריט + העדפות אוכל', 'task'),
          it('משימות', 'הסעה', 'task'), it('ציוד והצגה', 'מקרן / מסך'), it('ציוד והצגה', 'כרטיסי שם', 'buy'), it('ציוד והצגה', 'מתנה לצוות', 'buy'),
        ],
        packingExtra: ['בגדים לכמה ימים', 'ערכת רחצה', 'בגדים לערב צוות'],
        modules: mods('money'),
      },
    ],
  },
];

const CUSTOM_SUB = { key: 'custom', emoji: '✏️', label: 'מותאם אישית', hint: 'מתחילים מהבסיס וקוראים לזה איך שרוצים', custom: true };
for (const f of FAMILY_DEFS) f.subtypes.push({ ...CUSTOM_SUB, placeholder: f.placeholder });

const familyDef = (key) => FAMILY_DEFS.find((f) => f.key === key) || null;
const subDef = (f, key) => f?.subtypes.find((x) => x.key === key) || null;
/** Can the admin choose בארץ / בחו״ל for this family + sub-type? (custom may fly; a custom abroad trip stays abroad) */
const asksWhere = (f, s) => f.where === 'ask' || (Boolean(s?.custom) && f.where !== 'abroad');
const defaultWhere = (f) => (f.where === 'abroad' ? 'abroad' : 'il');

/**
 * The trip families for the new-trip wizard, each with its sub-types. `where`: 'il' | 'abroad' (fixed) or
 * 'ask' (the wizard asks בארץ / בחו״ל, default בארץ); a sub-type's `where` is 'ask' also for ✏️ מותאם אישית
 * in the Israeli families.
 */
export const FAMILIES = FAMILY_DEFS.map((f) => ({
  key: f.key, emoji: f.emoji, label: f.label, hint: f.hint, where: f.where,
  subtypes: f.subtypes.map((s) => ({
    key: s.key, emoji: s.emoji, label: s.label, hint: s.hint, placeholder: s.placeholder,
    ...(s.placeholderAbroad ? { placeholderAbroad: s.placeholderAbroad } : {}),
    where: asksWhere(f, s) ? 'ask' : f.where,
  })),
}));

// old flat type → [family, subtype, where] (bachelor: abroad only when it had flights)
const LEGACY_MAP = {
  camping: ['camping', 'camping', 'il'], family: ['camping', 'family', 'il'], trek: ['camping', 'trek', 'il'],
  villa: ['stay', 'villa', 'il'], abroad: ['abroad', 'friends', 'abroad'], bachelor: ['celebrate', 'bachelor', null],
  event: ['celebrate', 'event', 'il'], work: ['work', 'teamday', 'il'],
};

const codepoints = (s) => [...String(s ?? '')].length;
function cleanCustom(custom) {
  if (!custom || typeof custom !== 'object') return null;
  const label = String(custom.label ?? '').trim();
  const emoji = typeof custom.emoji === 'string' ? custom.emoji.trim() : '';
  if (!label && !emoji) return null;
  return {
    label: codepoints(label) >= 1 && codepoints(label) <= 30 ? label : '',
    emoji: emoji && codepoints(emoji) <= 8 ? emoji : null,
  };
}

/**
 * What a trip is: {family, subtype, where, custom}. New trips carry settings {type: family, subtype, where};
 * older ones only a flat `type`, mapped here (unknown / missing ⇒ camping). Nothing is written back.
 */
export function resolveType(settings) {
  const st = settings && typeof settings === 'object' ? settings : {};
  const type = typeof st.type === 'string' ? st.type : '';
  const flights = st.arrival?.flights === true;
  const pick = (fam, sub, where) => {
    const f = familyDef(fam) || FAMILY_DEFS[0];
    const s = subDef(f, sub) || f.subtypes[0];
    const w = asksWhere(f, s) ? (where === 'abroad' || where === 'il' ? where : defaultWhere(f)) : defaultWhere(f);
    return { family: f.key, subtype: s.key, where: w, custom: s.custom ? cleanCustom(st.custom) : null };
  };
  if (typeof st.subtype === 'string' && st.subtype && familyDef(type)) return pick(type, st.subtype, st.where);
  const legacy = LEGACY_MAP[type];
  if (legacy) return pick(legacy[0], legacy[1], legacy[2] ?? (flights ? 'abroad' : 'il'));
  const composite = /^([a-z]+)_([a-z_]+)$/.exec(type);    // a composed key ('stay_couple') saved as a type
  if (composite && subDef(familyDef(composite[1]), composite[2])) {
    return pick(composite[1], composite[2], st.where ?? (flights ? 'abroad' : 'il'));
  }
  if (familyDef(type)) return pick(type, null, st.where);  // a family without a sub-type: its first one
  return pick('camping', 'camping', 'il');
}

const normKey = (s) => String(s ?? '').replace(/[־\-–—_\s]+/g, ' ').trim();
const uniqBy = (list, keyOf) => {
  const seen = new Set();
  return list.filter((x) => {
    const k = keyOf(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const tag = ([e, n]) => ({ e, n });

/**
 * One trip type from a family + sub-type (+ where, + the custom label/emoji): the same shape the flat types
 * had ({key, emoji, label, hint, placeholder, modules, arrival, ask, categories, items, packing, schedule}) plus
 * {family, subtype, where, custom, expenseTags: [{e, n}], days: {single, arrival, full, last}}.
 * Unknown keys fall back (family ⇒ camping, sub-type ⇒ the family's first); `where` counts only where it's asked.
 */
export function composeType(family, subtype, where, custom) {
  const f = familyDef(family) || FAMILY_DEFS[0];
  const s = subDef(f, subtype) || f.subtypes[0];
  const w = asksWhere(f, s) ? (where === 'abroad' ? 'abroad' : where === 'il' ? 'il' : defaultWhere(f)) : defaultWhere(f);
  const abroad = w === 'abroad';
  const addsAbroad = abroad && f.key !== 'abroad';           // celebrate / work / custom taken abroad
  const own = s.replace === true;
  const c = s.custom ? cleanCustom(custom) : null;

  let categories = uniqBy([...(own ? [] : f.categories), ...(s.categories || [])], (x) => normKey(x.name));
  if (abroad && !categories.some((x) => x.name === DOCS.name)) categories = [...categories, DOCS];
  // a surprise category of a celebration is hidden from the guest of honour once there is one (settings.groom)
  if (f.key === 'celebrate') categories = categories.map((x) => (x.name === 'הפתעות' ? { ...x, secret: true } : x));
  const items = uniqBy([...(own ? [] : f.items), ...(s.items || []), ...(abroad ? DOC_ITEMS : [])], (x) => normKey(x.t));
  const packing = uniqBy([...(abroad ? ABROAD_PACKING : (s.packing || f.packing)), ...(s.packingExtra || [])], normKey);

  const modules = { ...(addsAbroad ? (s.modulesAbroad || f.modulesAbroad || mods()) : (s.modules || f.modules)) };
  const baseArrival = abroad ? TO_AIRPORT : (s.arrival || f.arrival);
  const arrival = { modes: [...baseArrival.modes], flights: baseArrival.flights === true, ...(abroad ? { airport: 'TLV' } : {}) };
  const ask = abroad ? { home: false } : { ...(s.ask || f.ask) };
  const expenseTags = uniqBy([...(s.expenseTags || f.expenseTags), ...(addsAbroad ? f.expenseTagsAbroad || [] : [])], ([, n]) => n)
    .slice(0, 12).map(tag);

  const days = {
    ...f.days, ...(addsAbroad ? { arrival: ABROAD_DAYS.arrival, last: ABROAD_DAYS.last } : {}),
    ...(s.days || {}), ...(abroad ? s.daysAbroad || {} : {}),
  };
  const legacyKey = s.legacy && s.legacy[1] === w ? s.legacy[0] : null;

  return {
    key: legacyKey || `${f.key}_${s.key}`,
    family: f.key, subtype: s.key, where: w, custom: c,
    emoji: c?.emoji || (s.custom ? f.emoji : s.emoji),
    label: c?.label || s.label,
    hint: s.hint,
    placeholder: (abroad && s.placeholderAbroad) || s.placeholder,
    modules, arrival, ask, categories: categories.map((x) => ({ ...x })),
    items: items.map((x) => ({ ...x })), packing, expenseTags,
    schedule: days.single, days,
  };
}

// ---------------------------------------------------------------------------
// "What matters in this trip?" — focus packs (the new-trip wizard's lists step). The organiser ticks what matters and
// each pack adds its own category + items (lists, tasks, documents); un-ticking takes them out again. Nothing here
// is final: the organiser edits every row afterwards (js/ui/list-editor.js).
// ---------------------------------------------------------------------------

const pack = (key, emoji, label, hint, cats, items, where = null, families = null) => ({ key, emoji, label, hint, cats, items, where, families });
/** The packs a trip type offers: where = 'abroad' | 'il' | null (both); families = null (all) or a list of family keys. */
export const FOCUS_PACKS = [
  pack('party', '🍾', 'מסיבה וחיי לילה', 'מועדון, ברים, שתייה', [cat('🍾', 'מסיבה ובילויים')], [
    it('מסיבה ובילויים', 'להחליט על מועדון / בר ולהזמין שולחן מראש', 'task'), it('מסיבה ובילויים', 'רמקול נייד'),
    it('מסיבה ובילויים', 'משחקי שתייה / קלפים'), it('מסיבה ובילויים', 'שוטים וכוסות', 'buy'), it('מסיבה ובילויים', 'שתייה לדירה / לחדר', 'buy'),
  ], null, ['celebrate', 'abroad', 'custom']),
  pack('food', '🍽️', 'אוכל ומסעדות', 'ארוחות, שולחנות, מסעדות מקומיות', [cat('🍽️', 'אוכל ומסעדות')], [
    it('אוכל ומסעדות', 'להזמין מסעדה לערב חגיגי', 'task'), it('אוכל ומסעדות', 'לאסוף המלצות למסעדות מקומיות', 'task'),
    it('אוכל ומסעדות', 'להחליט איך משלמים במסעדות (חשבון אחד / כל אחד)', 'task'),
  ]),
  pack('casino', '🎰', 'קזינו', 'מזומן, כניסה, תקציב', [cat('🎰', 'קזינו')], [
    it('קזינו', 'לקבוע תקציב מוסכם לקזינו', 'task'), it('קזינו', 'מזומן לקזינו', 'each'), it('קזינו', 'תעודה מזהה / דרכון לכניסה', 'each'),
  ], 'abroad', ['celebrate', 'abroad', 'custom']),
  pack('sights', '🏛️', 'תיירות ואטרקציות', 'סיורים, מוזיאונים, מקומות לראות', [cat('🏛️', 'אטרקציות וסיורים')], [
    it('אטרקציות וסיורים', 'לבחור 3–4 אטרקציות ולסדר אותן ביומנים', 'task'), it('אטרקציות וסיורים', 'כרטיסים מראש (אם צריך)', 'task'),
    it('אטרקציות וסיורים', 'סיור רגלי / עם מדריך', 'task'),
  ]),
  pack('activities', '🎯', 'פעילויות', 'קארטינג, מטווח, ספורט', [cat('🎯', 'פעילויות')], [
    it('פעילויות', 'להחליט על פעילות אחת-שתיים ולהזמין מראש', 'task'), it('פעילויות', 'ביגוד / נעליים מתאימות', 'each'),
  ], null, ['celebrate', 'abroad', 'custom', 'work']),
  pack('spa', '🧖', 'ספא ורגיעה', 'ספא, בריכה, יום מנוחה', [cat('🧖', 'ספא ורגיעה')], [
    it('ספא ורגיעה', 'להזמין ספא / בריכה', 'task'), it('ספא ורגיעה', 'בגד ים ומגבת', 'each'),
  ]),
  pack('surprise', '🎁', 'הפתעות ומתנה', 'הפתעה, סרטון, מתנה משותפת', [{ ...cat('🎁', 'הפתעות'), secret: true }, cat('📋', 'משימות')], [
    it('הפתעות', 'הפתעה לחתן / לכלה', 'task'), it('משימות', 'סרטון ברכות מהחברים והמשפחה', 'task'), it('משימות', 'לפתוח קופה למתנה', 'task'),
  ], null, ['celebrate']),
  pack('outfit', '👕', 'תלבושות ומיתוג', 'חולצות, אביזרים, תחפושת', [cat('👕', 'תלבושות ומיתוג')], [
    it('תלבושות ומיתוג', 'חולצות מודפסות לקבוצה', 'buy'), it('תלבושות ומיתוג', 'תחפושת / אביזר לחתן או לכלה', 'buy'),
  ], null, ['celebrate']),
  pack('transport', '🚕', 'הסעות והעברות', 'מהשדה, בעיר, חזרה הביתה', [cat('🚕', 'הסעות והעברות'), cat('📋', 'משימות')], [
    it('משימות', 'לסגור מונית / העברה מהשדה אל המלון', 'task'), it('הסעות והעברות', 'אפליקציית מוניות מקומית (Bolt / Uber)', 'each'),
    it('משימות', 'לסגור איך חוזרים הביתה מהשדה', 'task'),
  ], 'abroad'),
  pack('money', '💶', 'כסף ומט״ח', 'מזומן, כרטיסים, קופה משותפת', [cat('💶', 'כסף ומט״ח'), cat('📋', 'משימות')], [
    it('כסף ומט״ח', 'כרטיס אשראי בלי עמלת מט״ח', 'each'), it('כסף ומט״ח', 'קצת מזומן מקומי', 'each'),
    it('משימות', 'להחליט אם פותחים קופה משותפת של מזומן', 'task'),
  ], 'abroad'),
  pack('docs', '📄', 'מסמכים וביטוח', 'דרכון, ביטוח, אישורים', [cat('📄', 'מסמכים')], [
    it('מסמכים', 'דרכון בתוקף (6 חודשים לפחות)', 'each'), it('מסמכים', 'ביטוח נסיעות', 'each'),
    it('מסמכים', 'כרטיסי טיסה — מודפסים ובנייד', 'each'), it('מסמכים', 'אישור הזמנת הלינה (שמור גם בלי קליטה)', 'each'),
    it('מסמכים', 'צילום הדרכון בנייד', 'each'),
  ], 'abroad'),
  pack('flights', '✈️', 'טיסות', 'צ׳ק־אין, כבודה, מושבים', [cat('📋', 'משימות')], [
    it('משימות', 'צ׳ק־אין אונליין לכולם', 'task'), it('משימות', 'לוודא כבודה והזמנת מושבים', 'task'),
  ], 'abroad'),
  pack('bbq', '🔥', 'אש ובישול', 'מנגל, בשר, תבלינים', [cat('🔥', 'מנגל ובישול'), cat('🥩', 'בשר ועוף')], [
    it('בשר ועוף', 'בשר למנגל', 'buy'), it('מנגל ובישול', 'פחמים ומצית', 'buy'), it('מנגל ובישול', 'מלקחיים ורשת'),
  ], 'il', ['camping', 'stay', 'celebrate']),
  pack('kids', '🧒', 'ילדים', 'משחקים, חטיפים, בטיחות', [cat('🧒', 'ילדים')], [
    it('ילדים', 'משחקים וספרים'), it('ילדים', 'חטיפים וממתקים', 'buy'), it('ילדים', 'תרופות וערכת עזרה ראשונה לילדים'),
  ], null, ['camping', 'stay', 'abroad']),
  pack('pool', '🏊', 'בריכה וג׳קוזי', 'מגבות, בגדי ים, ציוד מים', [cat('🏊', 'בריכה ומים')], [
    it('בריכה ומים', 'מגבות לבריכה', 'each'), it('בריכה ומים', 'מצופים וצעצועי מים'),
  ], 'il', ['stay', 'celebrate']),
  pack('trek', '🥾', 'מסלול וציוד שטח', 'מים, ניווט, בטיחות', [cat('🥾', 'ציוד שטח'), cat('💊', 'עזרה ראשונה')], [
    it('ציוד שטח', 'מים — 3 ליטר לאדם', 'each'), it('ציוד שטח', 'מפה / ניווט מחובר', 'task'), it('עזרה ראשונה', 'ערכת עזרה ראשונה'),
  ], 'il', ['camping']),
];

/** The focus packs for a composed trip type (see FOCUS_PACKS). */
export function focusPacksFor(composed) {
  if (!composed) return [];
  return FOCUS_PACKS.filter((p) => (!p.where || p.where === composed.where) && (!p.families || p.families.includes(composed.family)));
}

/** A pack as the list editor holds it: {categories: [{name, emoji}], items: [{title, type, needed, category_name}]}. */
export function packSeed(p) {
  const emojiOf = new Map(p.cats.map((c) => [c.name, c.emoji]));
  const names = new Set(p.cats.map((c) => c.name));
  const cats = [...p.cats, ...p.items.filter((x) => !names.has(x.c)).map((x) => ({ name: x.c, emoji: '📋' }))];
  return {
    categories: uniqBy(cats, (c) => c.name).map((c) => ({ name: c.name, emoji: emojiOf.get(c.name) || c.emoji || '📦', ...(c.secret ? { secret: true } : {}) })),
    items: p.items.map((x) => ({ title: x.t, type: x.k, needed: x.n, category_name: x.c })),
  };
}

/** The trip's composed type (old trips: by their flat type — see resolveType). Keeps .key/.items/.packing/.ask. */
export function tripType(trip) {
  const r = resolveType(trip?.settings);
  return composeType(r.family, r.subtype, r.where, r.custom);
}

/** Is a module on for this trip? Missing = on (older trips keep everything). */
export function hasModule(trip, key) {
  return trip?.settings?.modules?.[key] !== false;
}

/**
 * The snapshot as the app shows it: what belongs to a feature that's off is left out — shared items with
 * "מי מביא מה" (lists), task items with משימות (tasks), the personal packing list with packing. It all stays
 * on the server and comes back when the feature is switched on again.
 */
export function withModules(snap) {
  const trip = snap?.trip;
  if (!trip) return snap;
  const lists = hasModule(trip, 'lists');
  const tasks = hasModule(trip, 'tasks');
  const packing = hasModule(trip, 'packing');
  if (lists && tasks && packing) return snap;
  const items = (Array.isArray(snap.items) ? snap.items : []).filter((i) => (i.type === 'task' ? tasks : lists));
  const ids = new Set(items.map((i) => i.id));
  return {
    ...snap,
    items,
    pledges: (Array.isArray(snap.pledges) ? snap.pledges : []).filter((p) => ids.has(p.item_id)),
    personal_items: packing ? snap.personal_items : [],
  };
}

/** Can items of this type be added / shown? Tasks go with משימות, everything else with "מי מביא מה". */
export function itemTypeOn(trip, type) {
  return type === 'task' ? hasModule(trip, 'tasks') : hasModule(trip, 'lists');
}

/** Does the trip have anything for the "רשימות" tab (shared lists, tasks or the packing list)? */
export function hasLists(trip) {
  return hasModule(trip, 'lists') || hasModule(trip, 'tasks') || hasModule(trip, 'packing');
}

const rows = (list) => list.map(([emoji, label, time]) => ({ emoji, label, time }));

/**
 * One-tap schedule rows for a single day: [{emoji, label, time}]. `typeKey` is an old flat type (unchanged
 * output), a composed type's key ('stay_couple'), a family key, or a composed type object.
 */
export function schedulePresets(typeKey, startHm, endHm) {
  const s = startHm || '09:00';
  const e = endHm || '14:00';
  if (typeKey && typeof typeKey === 'object' && typeof typeKey.schedule === 'function') return rows(typeKey.schedule(s, e));
  if (LEGACY[typeKey]) return rows(LEGACY[typeKey].schedule(s, e));
  const r = resolveType({ type: typeof typeKey === 'string' ? typeKey : '' });
  return rows(composeType(r.family, r.subtype, r.where).schedule(s, e));
}

/**
 * A trip type's features, with the creator's picks on top: {rides: true, …} for every module.
 * typeModules(family, subtype, where, picks) — or the old typeModules(flatTypeKey, picks).
 */
export function typeModules(family, subtype = null, where = null, picks = null) {
  let base;
  if (typeof subtype === 'string') {
    base = composeType(family, subtype, where).modules;
  } else {                                               // old signature: (typeKey, picks)
    picks = subtype;
    base = (LEGACY[family] || TRIP_TYPES[0]).modules;
  }
  const out = {};
  for (const m of MODULES) out[m.key] = typeof picks?.[m.key] === 'boolean' ? picks[m.key] : base[m.key] !== false;
  return out;
}

const seedLists = (type) => {
  const emojiOf = new Map(type.categories.map((c) => [c.name, c.emoji]));
  return {
    categories: type.categories.map((c) => ({ ...c })),
    items: type.items.map((x) => ({
      title: x.t, type: x.k, needed: x.n, category_name: x.c, category_emoji: emojiOf.get(x.c) || null,
    })),
  };
};

/**
 * What create_trip + add_items_bulk get for a new trip, with the features picked (`modules`):
 * tripSeed({family, subtype, where, custom, modules, airport}) → {settings, info: {packing}, categories, items}.
 * The old tripSeed(typeKey, modules) still returns exactly what it did. The type's whole content comes along —
 * a feature that's off only hides its part (withModules), so switching it on later brings the type's own lists
 * back, never a generic one.
 */
export function tripSeed(spec, legacyModules = null) {
  if (typeof spec === 'string' || !spec || typeof spec !== 'object') {
    const type = LEGACY[spec] || TRIP_TYPES[0];
    return {
      settings: { type: type.key, modules: typeModules(type.key, legacyModules), arrival: { ...type.arrival, modes: [...type.arrival.modes] } },
      info: { packing: [...type.packing] },
      ...seedLists(type),
    };
  }
  const type = composeType(spec.family, spec.subtype, spec.where, spec.custom);
  const arrival = { modes: [...type.arrival.modes], flights: type.arrival.flights };
  if (type.where === 'abroad') arrival.airport = IATA_RE.test(String(spec.airport || '')) ? spec.airport : 'TLV';
  return {
    settings: {
      type: type.family, subtype: type.subtype, where: type.where,
      ...(type.custom ? { custom: { label: type.custom.label, emoji: type.custom.emoji } } : {}),
      modules: typeModules(type.family, type.subtype, type.where, spec.modules || null),
      arrival,
      money: { tags: type.expenseTags.map((t) => ({ ...t })) },
    },
    info: { packing: [...type.packing] },
    ...seedLists(type),
  };
}

/** How people get to this trip: {modes, flights, airport}. Older trips: cars + "own way", no flights, TLV. */
export function arrivalOf(trip) {
  const a = trip?.settings?.arrival;
  const modes = Array.isArray(a?.modes) && a.modes.length ? a.modes.filter((m) => ARRIVAL_MODES.some((x) => x.key === m)) : CAR_ONLY.modes;
  const airport = IATA_RE.test(String(a?.airport || '')) ? a.airport : 'TLV';
  return { modes, flights: a?.flights === true, airport };
}

/** The trip's expense tags: settings.money.tags when set, else the type's — [{e, n}]. */
export function expenseTagsFor(trip) {
  const own = trip?.settings?.money?.tags;
  if (Array.isArray(own)) {
    const clean = own
      .filter((t) => t && typeof t.n === 'string' && t.n.trim())
      .map((t) => ({ e: typeof t.e === 'string' ? t.e : '', n: t.n.trim() }));
    if (clean.length) return uniqBy(clean, (t) => t.n).slice(0, 12);
  }
  return tripType(trip).expenseTags.map((t) => ({ ...t }));
}

/**
 * The words of NewTrip step 2 for a composed type: {namePlaceholder, placeLabel, placeWhere, placePlaceholder,
 * dates: 'range' | 'single', startLabel, endLabel, startHourLabel, endHourLabel, hoursOptional, moreDaysLabel,
 * askAirport, airportLabel, askFlight, flightLabel}.
 */
export function wizardCopy(composed) {
  const t = composed && composed.days ? composed : composeType(composed?.family, composed?.subtype, composed?.where);
  const base = {
    namePlaceholder: t.placeholder, placeLabel: 'לאן?', placeWhere: 'il', placePlaceholder: 'חיפוש מקום, חניון או ישוב',
    dates: 'range', startLabel: 'יוצאים', endLabel: 'חוזרים', startHourLabel: 'בשעה', endHourLabel: 'בשעה',
    hoursOptional: false, moreDaysLabel: null,
    askAirport: false, airportLabel: null, askFlight: false, flightLabel: null,
  };
  if (t.where === 'abroad') {
    return {
      ...base, placeLabel: 'לאן טסים?', placeWhere: 'abroad', placePlaceholder: 'עיר או מדינה — למשל: אתונה',
      startLabel: 'טסים', endLabel: 'חוזרים', hoursOptional: true,
      askAirport: true, airportLabel: 'מאיזה שדה ממריאים?', askFlight: true, flightLabel: 'יש כבר מספר טיסה? (לא חובה)',
    };
  }
  const oneDay = t.family === 'celebrate' || (t.family === 'work' && t.subtype === 'teamday');
  if (oneDay) {
    return {
      ...base, placeLabel: t.family === 'work' ? 'איפה נפגשים?' : 'איפה חוגגים?', placePlaceholder: 'מסעדה, בית, מקום אירועים…',
      dates: 'single', startLabel: 'מתי?', endLabel: 'עד מתי?', startHourLabel: 'משעה', endHourLabel: 'עד שעה',
      moreDaysLabel: 'יותר מיום אחד?',
    };
  }
  return base;
}

/** The participant welcome's steps for this trip: 'contact', 'arrive' (rides on), 'fly' (flights), 'food'. */
export function welcomeSteps(trip) {
  const steps = ['contact'];
  if (hasModule(trip, 'rides')) steps.push('arrive');
  if (arrivalOf(trip).flights) steps.push('fly');
  steps.push('food');
  return steps;
}

/**
 * The welcome's "how do you get there" step: {emoji, title, lead, options: [{key, emoji, label, sub, choices?}],
 * askFrom, askSeats (mode keys that need "יוצאים מ…" / free seats), askLate (the "מגיעים בשעה אחרת" row),
 * airports, airport (abroad only; else null)}. The dynamic "already in someone's car" option stays on the screen.
 */
export function arrivalQuestion(trip) {
  const type = tripType(trip);
  const ways = arrivalOf(trip);
  if (type.where === 'abroad') {
    // an old flat-type trip (no sub-type) predates the airport modes: it gets all of them; a trip made or edited
    // since then offers exactly the admin's modes
    const st = trip?.settings;
    const legacy = !(st && typeof st.subtype === 'string' && st.subtype);
    const on = (k) => legacy || ways.modes.includes(k);
    const carChoices = [
      on('car') && { key: 'car', label: 'אני נוהג/ת — יש מקום' }, on('drop') && { key: 'drop', label: 'מקפיצים אותי' },
    ].filter(Boolean);
    const both = carChoices.length === 2;
    const options = [
      on('taxi') && { key: 'taxi', emoji: '🚕', label: 'מונית משותפת', sub: 'נחבר אתכם למי שיוצא מהאזור' },
      carChoices.length && {
        key: 'car', emoji: '🚗',
        label: both ? 'נוסעים ברכב / מישהו מקפיץ' : on('car') ? 'נוסעים ברכב' : 'מישהו מקפיץ אותי',
        sub: on('car') ? 'אפשר לצרף עוד מישהו' : 'בלי לנהוג בעצמכם', choices: carChoices,
      },
      (on('transit') || ways.modes.includes('meet')) && { key: 'transit', emoji: '🚆', label: 'רכבת / אוטובוס', sub: 'אפשר להיפגש בדרך' },
      on('park') && { key: 'park', emoji: '🅿️', label: 'חונים בשדה', sub: 'ואולי יש מקום לעוד מישהו' },
    ].filter(Boolean);
    return {
      emoji: '✈️', title: 'איך מגיעים לשדה התעופה?', lead: 'נתאם מי חולק מונית ומי מקפיץ את מי',
      options, askFrom: ['taxi', 'car', 'park'], askSeats: ['car', 'park'], askLate: false,
      airports: AIRPORTS.map((a) => ({ ...a })), airport: ways.airport,
    };
  }
  const rideWays = ways.modes.filter((m) => m !== 'own');
  const carOnly = rideWays.length === 1 && rideWays[0] === 'car';
  const event = type.family === 'celebrate';
  const options = [
    ways.modes.includes('car') && { key: 'car', emoji: '🚗', label: 'נוסעים ברכב שלנו', sub: 'ואולי יש מקום לעוד מישהו' },
    rideWays.length && {
      key: 'need', emoji: '🙋', label: carOnly ? 'צריכים טרמפ' : 'צריכים מקום',
      sub: carOnly ? 'נראה מי נוסע מהאזור שלכם' : 'טרמפ, מונית משותפת או נקודת מפגש',
    },
    { key: 'own', emoji: '🚌', label: 'מגיעים בדרך אחרת', sub: 'אוטובוס, רכב מלא, מישהו מקפיץ' },
  ].filter(Boolean);
  return {
    emoji: '🚗', title: event ? 'איך מגיעים לאירוע?' : 'איך מגיעים?',
    lead: event ? 'נראה מי יכול לאסוף את מי' : 'נראה מי נוסע עם מי ומי צריך מקום',
    options, askFrom: ['car', 'need'], askSeats: ['car'], askLate: !event,
    airports: null, airport: null,
  };
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ymdDay = (ymd) => {
  const m = YMD_RE.exec(String(ymd || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
};
const dayYmd = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

/** Calendar days of a trip, both ends included (1 when there's no end, the same day, or a bad range). */
export function dayCount(startYmd, endYmd) {
  const a = ymdDay(startYmd);
  const b = ymdDay(endYmd);
  if (a == null || b == null || b <= a) return 1;
  return b - a + 1;
}

const MAX_DAYS = 60;

/**
 * The trip's days with their one-tap rows: [{day, kind, label, ymd, presets: [{emoji, label, time}]}].
 * 1 day ⇒ single; 2 ⇒ arrival + last; 3+ ⇒ arrival, full × (N−2), last (at most 60 days).
 * s/e default to 09:00 / 14:00; for a flight the caller passes the flights' departure times, and `lastYmd` =
 * the flight home's departure date when it's before the trip's end date (days after it: kind 'home', no rows).
 * Rows relative to a flight can move to the day before / after (see ABROAD_DAYS).
 */
export function schedulePlan(composed, { startYmd = null, startHm = null, endYmd = null, endHm = null, lastYmd = null } = {}) {
  const t = composed && composed.days ? composed : composeType(composed?.family, composed?.subtype, composed?.where);
  const n = Math.min(dayCount(startYmd, endYmd), MAX_DAYS);
  const s = startHm || '09:00';
  const e = endHm || '14:00';
  const start = ymdDay(startYmd);
  // the flight home may leave before the trip's last calendar day (ends_at = landing, after midnight or a day later)
  const lastAt = ymdDay(lastYmd);
  const lastDay = n > 1 && start != null && lastAt != null && lastAt > start && lastAt - start + 1 < n ? lastAt - start + 1 : n;
  const out = [];
  for (let day = 1; day <= n; day += 1) {
    const kind = n === 1 ? 'single' : day === 1 ? 'arrival' : day === lastDay ? 'last' : day > lastDay ? 'home' : 'full';
    const word = kind === 'arrival' ? ' · הגעה' : kind === 'last' ? ' · חזרה' : kind === 'home' ? ' · נחיתה' : '';
    out.push({ day, kind, label: `יום ${day}${word}`, ymd: start == null ? null : dayYmd(start + day - 1), presets: [] });
  }
  // rows land on their day; a row "the day before" day 1 stays on day 1 without a time (it sorts first)
  for (const d of out) {
    const list = d.kind === 'home' ? [] : t.days[d.kind](s, e);
    for (const [emoji, label, time, shift = 0] of list) {
      if (d.kind === 'single' || !shift) {
        d.presets.push({ emoji, label, time });
      } else if (out[d.day - 1 + shift]) {
        out[d.day - 1 + shift].presets[shift < 0 ? 'push' : 'unshift']({ emoji, label, time, moved: true });
      } else {
        d.presets.push(shift < 0 ? { emoji, label: `${label} (בערב שלפני, ${time})`, time: '' } : { emoji, label, time });
      }
    }
  }
  for (const d of out) {
    const seen = new Set();
    d.presets = d.presets
      .filter((p) => !seen.has(p.label) && seen.add(p.label))
      .map(({ moved, ...p }) => p);
  }
  return out;
}

/** For admins: what this trip is still missing, by its type — [{key, label, detail?, href}]. */
export function tripSetupGaps(snap) {
  const trip = snap?.trip;
  if (!trip) return [];
  const t = `#/t/${trip.id}`;
  const type = tripType(trip);
  const info = trip.info || {};
  const members = Array.isArray(snap.members) ? snap.members : [];
  const bookings = Array.isArray(info.bookings) ? info.bookings : [];
  const out = [];
  if (!trip.starts_at) out.push({ key: 'dates', label: '📅 מתי יוצאים?', href: `${t}/trip?edit=1` });
  if (!trip.location) out.push({ key: 'place', label: '📍 לאן?', href: `${t}/trip?edit=1` });
  else if (type.where === 'il' && !(trip.lat != null && trip.lon != null && Number.isFinite(Number(trip.lat)) && Number.isFinite(Number(trip.lon)))) {
    out.push({ key: 'place', label: '📍 לאן?', detail: 'לבחור מהרשימה — בשביל ניווט ותחזית', href: `${t}/trip?edit=1` });
  }
  if (arrivalOf(trip).flights && hasModule(trip, 'bookings')) {   // the group's flight goes on the bookings card
    for (const [leg, word] of [['out', 'הלוך'], ['back', 'חזור']]) {
      if (!bookings.some((b) => b.kind === 'flight' && (b.leg || 'out') === leg && b.flight)) {
        out.push({ key: `flight-${leg}`, label: `✈️ מספר טיסה ${word}`, detail: 'שכולם יראו', href: `${t}/trip` });
      }
    }
  }
  if ((type.where === 'abroad' || type.family === 'stay') && hasModule(trip, 'bookings')) {
    const hotel = bookings.find((b) => b.kind === 'hotel');
    if (!hotel) out.push({ key: 'hotel', label: '🏨 איפה ישנים?', href: `${t}/trip` });
    else if (!hotel.address || !hotel.check_in) out.push({ key: 'hotel', label: '🏨 פרטי הלינה', detail: [!hotel.address && 'כתובת', !hotel.check_in && 'צ׳ק־אין'].filter(Boolean).join(' + '), href: `${t}/trip` });
    if (!(Array.isArray(info.costs) && info.costs.length)) out.push({ key: 'costs', label: '🧮 כמה זה עולה לאדם', href: `${t}/trip` });
  }
  if (hasModule(trip, 'schedule') && !(Array.isArray(info.schedule) && info.schedule.length > 1)) out.push({ key: 'schedule', label: '⏰ לו״ז', detail: 'בלחיצה, מהצ׳יפים', href: `${t}/trip?edit=1` });
  if (hasModule(trip, 'rooms') && Array.isArray(info.rooms) && info.rooms.length) {
    const placed = new Set(info.rooms.flatMap((r) => (Array.isArray(r.members) ? r.members : [])));
    const left = members.filter((m) => !placed.has(m.id)).length;
    if (left) out.push({ key: 'rooms', label: '🛏️ חלוקת חדרים', detail: `${left} עוד בלי חדר`, href: `${t}/trip` });
  }
  const unclaimed = members.filter((m) => !m.claimed).length;
  if (unclaimed) out.push({ key: 'invite', label: '👋 עוד לא נכנסו', detail: `${unclaimed} — לשלוח קישור`, href: `${t}/people` });
  if (members.length > 2 && adminPersons(snap).length < 2) {   // per person: a couple's partner isn't one by default
    out.push({ key: 'admins', label: '👑 עוד מנהל/ת לעזרה', href: `${t}/people` });
  }
  return out;
}

/**
 * One-tap suggestions for the quick list builder, per default category name. A string is an item of the
 * step's own type; [title, kind] names its kind ('buy' | 'bring' | 'each' | 'task').
 */
export const SUGGESTIONS = {
  'בשר ועוף': ['סטייקים', 'אנטריקוט', 'פרגיות', 'כנפיים', 'קבבים', 'נקניקיות', 'המבורגרים', 'שיפודי פרגית', 'חזה עוף', 'צלעות'],
  'ירקות ופירות': ['עגבניות', 'מלפפונים', 'בצל', 'פלפלים', 'חסה', 'לימונים', 'תפוחי אדמה', 'אבטיח', 'ענבים', 'בננות'],
  'מזווה ורטבים': ['פיתות', 'לחמניות', 'חומוס', 'טחינה', 'קטשופ', 'מיונז', 'חרדל', 'שמן זית', 'מלח ופלפל', 'קפה', 'סוכר', 'אורז', 'פסטה'],
  'נשנושים ומתוקים': ['במבה', 'ביסלי', 'צ׳יפס', 'גרעינים', 'מרשמלו', 'שוקולד', 'עוגיות', 'פופקורן'],
  'שתייה ואלכוהול': ['מים', 'קולה', 'סודה', 'מיץ', 'בירה', 'וודקה', 'יין', 'קרח'],
  'מנגל ובישול': [
    ['פחמים', 'buy'], ['מנגל + רשת', 'bring'], ['מלקחיים', 'bring'], ['נפנף', 'bring'], ['מצית / גפרורים', 'buy'],
    ['קרש חיתוך', 'bring'], ['סכין חדה', 'bring'], ['סיר', 'bring'], ['מחבת', 'bring'], ['גזייה + גז', 'bring'], ['נייר כסף', 'buy'],
  ],
  'חד־פעמי': ['צלחות', 'כוסות', 'סכו״ם', 'מפיות', 'מגבות נייר', 'שקיות זבל', 'ניילון נצמד', 'מגבונים'],
  'ציוד קבוצתי': [
    'גזיבו / צל', 'שולחן מתקפל', ['כיסאות', 'each'], 'צידנית + קרח', 'תאורה לחניון', 'כבל מאריך', 'פנסים', 'ג׳ריקן מים',
    'מפצל חשמל', 'ערכת עזרה ראשונה',
  ],
  'כיף ומשחקים': ['רמקול', 'מטקות', 'כדור', 'קלפים', 'שש בש', 'פריזבי', 'גיטרה', 'טאקי'],
  'משימות': [
    'לתאם מקום בחניון', 'לאסוף כסף', 'לבדוק מזג אוויר', 'לתאם הסעות', 'לקנות קרח ביום היציאה', 'פלייליסט משותף', 'לסגור מי ישן איפה',
  ],
  'ארוחות בוקר': ['לחם', 'ביצים', 'גבינות', 'חלב', 'קורנפלקס', 'ירקות לסלט', 'קפה ותה'],
  'כללי לבית': ['נייר טואלט', 'סבון כלים', 'ספוגים', 'שקיות זבל', 'מגבות נייר'],
};

const sugKey = normKey;

/**
 * Suggestions for a category of this trip: the trip type's own items in it first, then the common ones —
 * [{title, type}] (type null = the step's own type), each title once.
 */
export function suggestionsFor(trip, categoryName) {
  const key = sugKey(categoryName);
  if (!key) return [];
  const out = [];
  const seen = new Set();
  const push = (title, type) => {
    const k = sugKey(title);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ title, type: type || null });
  };
  for (const x of tripType(trip).items) if (sugKey(x.c) === key) push(x.t, x.k);
  const common = Object.entries(SUGGESTIONS).find(([name]) => sugKey(name) === key);
  for (const s of common ? common[1] : []) (Array.isArray(s) ? push(s[0], s[1]) : push(s, null));
  return out;
}
