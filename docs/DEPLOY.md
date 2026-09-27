# העלאה לאוויר — Runbook

מסמך הפעלה צעד-אחר-צעד להעלאת מדורה ל-Supabase האמיתי ולאינטרנט.
נכתב כך שסשן Claude על המחשב של לידור (Windows, עם הרחבת הדפדפן) יוכל לבצע אותו מתחילתו ועד סופו.
כל שלב מסתיים בבדיקה — לא ממשיכים לשלב הבא אם הבדיקה נכשלה.

| | |
|---|---|
| פרויקט Supabase | `ocyxyqovculndfefjwlx` (Frankfurt) — https://supabase.com/dashboard/project/ocyxyqovculndfefjwlx |
| תיקיית הפרויקט | `C:\Users\lidor\Projects\medura` |
| קבצים פרטיים (לא ב-git) | `private\config.supabase.js` (URL + publishable key), `private\seed_trip.sql` (נתוני הקבוצה) |
| כבר הוגדר | Anonymous sign-ins = ON · "Automatically expose new tables" = OFF · automatic RLS = ON |

> ⚠️ אסור להעלות ל-git: את תיקיית `private\`, את סיסמת מסד הנתונים, או את `DATABASE_URL`.
> מותר ל-git: `config.js` עם ה-URL וה-**publishable/anon** key (הם ציבוריים מעצם הגדרתם; ההגנה היא ה-RLS).

---

## 1. סנכרון הקוד

```powershell
cd C:\Users\lidor\Projects\medura
git status                      # לוודא שאין שינויים מקומיים חשובים שלא נשמרו
git fetch origin
git checkout master
git pull origin master
```
✅ בדיקה: `git log --oneline -5` מציג את הקומיט "warn before adding duplicate items".

## 2. בדיקות מקומיות (דמו)

```powershell
.venv\Scripts\python.exe -m pip install -q psycopg[binary] pgserver pytest playwright   # אם חסר
.venv\Scripts\python.exe -m pytest -q --ignore=tests/live
```
✅ בדיקה: 0 failed.

**בדיקות נתוני הקבוצה** (`tests/db/test_seed.py`) רצות רק כשיש גם `private\seed_trip.sql` וגם `private\seed_names.json`.
השמות האמיתיים של החבר'ה, שם הטיול והמקום האמיתי לא נמצאים בריפו — הם בקובץ הפרטי הזה. אם הוא חסר, ליצור אותו פעם אחת:
שם הטיול והמקום כפי שהם ב-`private\seed_trip.sql`, ושמות התצוגה של 5 הפרופילים **לפי הסדר שבו הם נוצרים שם**
(אפשר גם לקחת אותם מהגרסה הישנה של הבדיקה: `git show a562d49:tests/db/test_seed.py`, השורות `TRIP_NAME` ו-`PLACEHOLDERS = [...]`).
```json
{"trip_name": "<שם הטיול>", "location": "<המקום>",
 "members": ["<שם 1>", "<שם 2>", "<שם 3>", "<שם 4>", "<שם 5>"]}
```
שמירה כ-UTF-8 ב-`private\seed_names.json`, ואז:
```powershell
.venv\Scripts\python.exe -m pytest -q tests\db\test_seed.py
```
✅ בדיקה: 6 passed (לא skipped) — נתוני הקבוצה נבדקו על Postgres מקומי לפני שנוגעים בענן.

## 3. מחרוזת חיבור למסד הנתונים

בדפדפן: Dashboard → כפתור **Connect** (למעלה) → **Session pooler** → להעתיק את ה-URI.
צריך את סיסמת מסד הנתונים. אם לא ידועה: Project Settings → Database → **Reset database password** (ללידור לבחור/לשמור אותה — לא לשמור בשום קובץ).

```powershell
$env:DATABASE_URL = "<ה-URI מהדשבורד, עם הסיסמה במקום [YOUR-PASSWORD]>"
.venv\Scripts\python.exe tools\db_deploy.py verify
```
✅ בדיקה: החיבור מצליח (על פרויקט ריק יופיעו "missing table…" — זה צפוי בשלב הזה).

> דרך חלופית בלי סיסמה: SQL Editor בדשבורד (https://supabase.com/dashboard/project/ocyxyqovculndfefjwlx/sql/new).
> להעתיק את הקובץ ללוח: `Get-Content supabase\schema.sql -Raw | Set-Clipboard`, להדביק ב-Editor (Ctrl+V), **Run**.
> הצפוי: "Success. No rows returned". אותו דבר ל-seed. אחר כך להריץ את בדיקות סעיף 4 ידנית.

## 4. סכמה

```powershell
.venv\Scripts\python.exe tools\db_deploy.py apply supabase\schema.sql
```
הקובץ רץ בטרנזקציה אחת (הכל או כלום) ובטוח להרצה חוזרת.
✅ בדיקה — הכלי מדפיס בסוף:
```
tables: 17/17
rpcs: 45/45
grants: authenticated can call RPCs=True, anon blocked=True, schema usage=True
direct table writes for clients: 0 (want 0)
realtime publication: ['trips']
✓ database looks good
```

## 5. נתוני הקבוצה

```powershell
.venv\Scripts\python.exe tools\db_deploy.py apply private\seed_trip.sql
```
✅ בדיקה: מופיעה שורה `trip: … · invite XXXXXXXX · N members · M items` — לרשום את קוד ההזמנה.

> ⚠️ **לידור צריך להיכנס ראשון לטיול הזה.** לטיול שנטען מ-seed אין מנהל; **מי שמצטרף ראשון הופך לבעלים** (SPEC §3).

```powershell
Remove-Item Env:DATABASE_URL      # לא להשאיר את הסיסמה בסביבה
```

## 6. חיבור האתר לשרת האמיתי

להעתיק את `supabaseUrl` ו-`supabaseAnonKey` מ-`private\config.supabase.js` לתוך `config.js` (להשאיר `vapidPublicKey: ""` — התראות Push הן שלב 2).
בדיקות ה-E2E תמיד רצות עם `?demo=1`, כך שהן לא נוגעות בשרת האמיתי גם אחרי השינוי.

## 7. בדיקת עשן מול השרת האמיתי

```powershell
$env:MEDURA_LIVE = "1"
.venv\Scripts\python.exe -m pytest -q tests\live
Remove-Item Env:MEDURA_LIVE
```
בודק: התחברות אנונימית, יצירה/הצטרפות, הצעה→אישור, "אני מביא", הוצאות, בידוד בין טיולים (RLS), חסימת כתיבה ישירה לטבלאות, ועדכון בזמן אמת.
✅ בדיקה: 0 failed. אחר כך לנקות (SQL Editor, או `db_deploy.py verify` יזכיר):
```sql
delete from public.trips where name like 'LIVE TEST%';
```

## 8. בדיקה ידנית בדפדפן

```powershell
.venv\Scripts\python.exe tools\devserver.py 5178
```
1. http://localhost:5178/ — מסך הפתיחה, **בלי** פס "מצב הדגמה".
2. להיכנס עם קוד ההזמנה מסעיף 5 (`http://localhost:5178/#/join/<קוד>`) → לבחור את הפרופיל של לידור → לוודא שהוא **בעלים** (במסך "אנשים").
3. מעבר על המסכים: בית, רשימות (להוסיף "פחם" → אמורה להופיע אזהרת "כבר ברשימה"), ייבוא מוואטסאפ, כסף, הודעות, אנשים, אני.
4. חלון גלישה בסתר = "חבר" שני: להצטרף מאותו קישור, להציע פריט → לוודא שהוא מופיע אצל לידור ב"לאישור" **בלי רענון** (realtime).
5. Dashboard → **Advisors → Security**: לוודא שאין אזהרות אדומות.

## 9. אחסון באינטרנט — ריפו ציבורי חדש ונקי (לידור אישר)

לידור אישר אתר ציבורי ב-GitHub Pages. **לא הופכים את `medura-dev` לציבורי**: ההיסטוריה הישנה שלו
כוללת שמות אמיתיים של חברים (הם הוסרו מהקוד הנוכחי, אבל נשארו בקומיטים ישנים).
במקום זה מפרסמים את הקוד הנוכחי לריפו ציבורי חדש, **`lidorAvr/medura`**, בקומיט אחד בלי היסטוריה.
`medura-dev` נשאר פרטי ומשמש לפיתוח. הכתובת תהיה `https://lidoravr.github.io/medura/` — בדיוק הכתובת
שקובץ ה-seed כבר מדפיס בקישור ההזמנה.

1. לוודא ש-`master` כולל את `config.js` המעודכן (סעיף 6) ושהכל עבר (סעיפים 2, 7, 8).
2. להכין עותק נקי (בלי `.git` ובלי `private\` — `private\` ממילא לא ב-git):
   ```powershell
   $pub = "$env:TEMP\medura-public"
   if (Test-Path $pub) { Remove-Item -Recurse -Force $pub }
   git clone --depth 1 --branch master C:\Users\lidor\Projects\medura $pub
   Remove-Item -Recurse -Force "$pub\.git"
   ```
3. **בדיקת פרטיות לפני פרסום** — אף שם אמיתי ואף מקום אמיתי מ-`private\seed_names.json` לא מופיעים בעותק:
   ```powershell
   $priv = Get-Content C:\Users\lidor\Projects\medura\private\seed_names.json -Raw -Encoding UTF8 | ConvertFrom-Json
   $names = @($priv.members | ForEach-Object { $_ -split ' ו| ' } | Where-Object { $_.Length -ge 2 }) +
            @($priv.location, $priv.trip_name) | Sort-Object -Unique
   Get-ChildItem $pub -Recurse -File -Include *.js,*.py,*.sql,*.md,*.html,*.json,*.css |
     Select-String -Pattern $names -SimpleMatch -Encoding UTF8
   ```
   ✅ בדיקה: **אין פלט**. אם יש — לעצור, לתקן ב-`medura-dev`, ולחזור לשלב 2.
   (ייתכן false positive על מילה רגילה שהיא גם שם — לבדוק בעין.)
4. ליצור את הריפו ולדחוף (עם `gh` אם מותקן; אחרת ליצור ריפו ריק **Public** בשם `medura` ב-github.com/new, ואז `git remote add` + `push`):
   ```powershell
   cd $pub
   git init -b main
   git add -A
   git commit -m "מדורה 🔥"
   gh repo create lidorAvr/medura --public --source . --push
   ```
5. ב-github.com/lidorAvr/medura: Settings → Pages → Source: *Deploy from a branch* → `main` / `/ (root)` → Save.
6. אחרי ~דקה: `https://lidoravr.github.io/medura/` → לחזור על סעיף 8.2–8.4 מול הכתובת הזו.

**עדכונים בהמשך:** מפתחים ב-`medura-dev`, ומפרסמים שוב: שלבים 2–3, ואז במקום שלב 4:
```powershell
git clone --depth 1 https://github.com/lidorAvr/medura "$env:TEMP\medura-site"
robocopy $pub "$env:TEMP\medura-site" /MIR /XD .git
cd "$env:TEMP\medura-site"; git add -A; git commit -m "עדכון"; git push
```

## 10. סיום

- [ ] `config.js` המעודכן נשמר ב-git (`git add config.js && git commit -m "config: live Supabase project"` + push).
- [ ] נמחקו טיולי `LIVE TEST`.
- [ ] `DATABASE_URL` לא נשאר בשום מקום.
- [ ] לשלוח לקבוצה את קישור ההזמנה (מסך הטיול → "הזמנת חברים") רק **אחרי** שלידור נכנס ראשון.
- [ ] בהמשך (לא חוסם): CAPTCHA (Turnstile) להתחברות אנונימית; שלב 2 — התראות Push ותזכורות.
