// Trip types: each one sets the starting point of a new trip — which modules are on, the shared
// lists (categories + items), the personal packing list and the one-tap schedule rows.
// Everything here is a suggestion: the admin edits, deletes and toggles all of it later.
// Pure data + tiny helpers (no DOM, no API) so the logic tests can check it.

/** Modules an admin can switch on/off per trip ("⚙️ מה יש בטיול"). Missing = on. */
export const MODULES = [
  { key: 'rides', emoji: '🚗', label: 'הגעה והסעות', hint: 'טרמפים, מונית משותפת, מי נוהג' },
  { key: 'money', emoji: '💸', label: 'כסף והתחשבנות', hint: 'הוצאות משותפות ומי מעביר למי' },
  { key: 'polls', emoji: '📊', label: 'סקרים', hint: 'מתי יוצאים, מה אוכלים — כולם מצביעים' },
];

/** Ways to get there an admin can offer. car/taxi/meet are "rides" (someone organises, others ask/join). */
export const ARRIVAL_MODES = [
  { key: 'car', emoji: '🚗', label: 'טרמפים ברכבים', offer: 'אני נוהג/ת — יש לי מקום' },
  { key: 'taxi', emoji: '🚕', label: 'מונית משותפת', offer: 'מארגן/ת מונית משותפת' },
  { key: 'meet', emoji: '🚆', label: 'נקודת מפגש (רכבת / אוטובוס / בשדה)', offer: 'קובע/ת נקודת מפגש' },
  { key: 'own', emoji: '🧍', label: 'כל אחד בדרך שלו' },
];
const CAR_ONLY = { modes: ['car', 'own'], flights: false };
const FLYING = { modes: ['taxi', 'car', 'meet', 'own'], flights: true };

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

export const TRIP_TYPES = [
  {
    key: 'camping', emoji: '⛺', label: 'קמפינג', hint: 'אוהלים, מנגל ומדורה',
    placeholder: 'למשל: קמפינג סוכות בכנרת',
    modules: { rides: true, money: true, polls: true },
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
    modules: { rides: true, money: true, polls: true },
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
    modules: { rides: true, money: true, polls: true },
    arrival: FLYING,
    ask: { home: false }, // welcome: "what do you have at home?"
    categories: [cat('📄', 'מסמכים'), cat('🎁', 'הפתעות'), cat('👕', 'תלבושות ומיתוג'), cat('🍾', 'שתייה ומסיבה'), cat('🎵', 'מוזיקה וציוד'), cat('📋', 'משימות')],
    items: [
      it('מסמכים', 'דרכון בתוקף (6 חודשים לפחות)', 'each'), it('מסמכים', 'ביטוח נסיעות', 'each'),
      it('משימות', 'להזמין לינה', 'task'), it('משימות', 'להזמין פעילות (שייט / קארטינג / מסעדה)', 'task'),
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
    modules: { rides: true, money: true, polls: true },
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
    modules: { rides: true, money: true, polls: true },
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
    modules: { rides: true, money: false, polls: true },
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
    modules: { rides: false, money: true, polls: true },
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
    modules: { rides: true, money: true, polls: true },
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

/** The trip's type (trips created before types existed are camping trips). */
export function tripType(trip) {
  const key = trip?.settings?.type;
  return TRIP_TYPES.find((t) => t.key === key) || TRIP_TYPES[0];
}

/** Is a module on for this trip? Missing = on (older trips keep everything). */
export function hasModule(trip, key) {
  return trip?.settings?.modules?.[key] !== false;
}

/** One-tap schedule rows for a trip type: [{emoji, label, time}]. */
export function schedulePresets(typeKey, startHm, endHm) {
  const type = TRIP_TYPES.find((t) => t.key === typeKey) || TRIP_TYPES[0];
  return type.schedule(startHm || '09:00', endHm || '14:00').map(([emoji, label, time]) => ({ emoji, label, time }));
}

/** What create_trip + add_items_bulk get for a new trip of this type. */
export function tripSeed(typeKey) {
  const type = TRIP_TYPES.find((t) => t.key === typeKey) || TRIP_TYPES[0];
  const emojiOf = new Map(type.categories.map((c) => [c.name, c.emoji]));
  return {
    settings: { type: type.key, modules: { ...type.modules }, arrival: { ...type.arrival, modes: [...type.arrival.modes] } },
    info: { packing: [...type.packing] },
    categories: type.categories.map((c) => ({ ...c })),
    items: type.items.map((x) => ({
      title: x.t, type: x.k, needed: x.n, category_name: x.c, category_emoji: emojiOf.get(x.c) || null,
    })),
  };
}

/** How people get to this trip: {modes, flights}. Older trips: cars + "own way", no flights. */
export function arrivalOf(trip) {
  const a = trip?.settings?.arrival;
  const modes = Array.isArray(a?.modes) && a.modes.length ? a.modes.filter((m) => ARRIVAL_MODES.some((x) => x.key === m)) : CAR_ONLY.modes;
  return { modes, flights: a?.flights === true };
}

/** For admins: what this trip is still missing, by its type — [{key, label, detail?, href}]. */
export function tripSetupGaps(snap) {
  const trip = snap?.trip;
  if (!trip) return [];
  const t = `#/t/${trip.id}`;
  const type = tripType(trip).key;
  const info = trip.info || {};
  const members = Array.isArray(snap.members) ? snap.members : [];
  const bookings = Array.isArray(info.bookings) ? info.bookings : [];
  const out = [];
  if (!trip.starts_at) out.push({ key: 'dates', label: '📅 מתי יוצאים?', href: `${t}/trip?edit=1` });
  if (!trip.location) out.push({ key: 'place', label: '📍 לאן?', href: `${t}/trip?edit=1` });
  if (arrivalOf(trip).flights) {
    for (const [leg, word] of [['out', 'הלוך'], ['back', 'חזור']]) {
      if (!bookings.some((b) => b.kind === 'flight' && (b.leg || 'out') === leg && b.flight)) {
        out.push({ key: `flight-${leg}`, label: `✈️ מספר טיסה ${word}`, detail: 'שכולם יראו', href: `${t}/trip` });
      }
    }
  }
  if (['abroad', 'bachelor', 'villa'].includes(type)) {
    const hotel = bookings.find((b) => b.kind === 'hotel');
    if (!hotel) out.push({ key: 'hotel', label: '🏨 איפה ישנים?', href: `${t}/trip` });
    else if (!hotel.address || !hotel.check_in) out.push({ key: 'hotel', label: '🏨 פרטי הלינה', detail: [!hotel.address && 'כתובת', !hotel.check_in && 'צ׳ק־אין'].filter(Boolean).join(' + '), href: `${t}/trip` });
    if (!(Array.isArray(info.costs) && info.costs.length)) out.push({ key: 'costs', label: '🧮 כמה זה עולה לאדם', href: `${t}/trip` });
  }
  if (!(Array.isArray(info.schedule) && info.schedule.length > 1)) out.push({ key: 'schedule', label: '⏰ לו״ז', detail: 'בלחיצה, מהצ׳יפים', href: `${t}/trip?edit=1` });
  if (Array.isArray(info.rooms) && info.rooms.length) {
    const placed = new Set(info.rooms.flatMap((r) => (Array.isArray(r.members) ? r.members : [])));
    const left = members.filter((m) => !placed.has(m.id)).length;
    if (left) out.push({ key: 'rooms', label: '🛏️ חלוקת חדרים', detail: `${left} עוד בלי חדר`, href: `${t}/trip` });
  }
  const unclaimed = members.filter((m) => !m.claimed).length;
  if (unclaimed) out.push({ key: 'invite', label: '👋 עוד לא נכנסו', detail: `${unclaimed} — לשלוח קישור`, href: `${t}/people` });
  if (members.length > 2 && members.filter((m) => m.role === 'owner' || m.role === 'admin').length < 2) {
    out.push({ key: 'admins', label: '👑 עוד מנהל/ת לעזרה', href: `${t}/people` });
  }
  return out;
}
