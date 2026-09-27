# מדורה (Medura)

Group-trip organizer (Sukkot camping): shared lists with "who brings what", WhatsApp list import,
expense split by headcount, announcements/polls. Hebrew, RTL, mobile-first PWA. The user (לידור) prefers **Hebrew**.

- **Contract:** `docs/SPEC.md` — tables, RPCs, screens, logic API. Follow it; update it when an API changes.
- **Deploying to the real Supabase + hosting:** `docs/DEPLOY.md` (step-by-step runbook; start there).

## Layout
- Static site, no build step: `index.html`, `js/` (Preact + htm, vendored in `js/vendor/`), `css/`, `sw.js`.
- `js/lib/logic.js` — pure domain logic (money in agorot, Asia/Jerusalem dates, WhatsApp parser, duplicate matching).
- `js/api/` — `supabase-api.js` (real) and `demo-api.js` (in-browser fake, same rules). Empty `config.js` or `?demo=1` ⇒ demo.
- `js/screens/*.js` — one file per screen; `js/store.js` — app state; `js/ui/components.js` — shared UI.
- `supabase/schema.sql` — whole backend (RLS, SECURITY DEFINER RPCs); idempotent, safe to re-run.
- `private/` — gitignored: real config, `seed_trip.sql`, `seed_names.json`. Never commit it, never paste its contents into commits/PRs.
- **No real names of the group's members anywhere in the repo** (tests use fictional names). This repo stays private;
  the site is published as a clean snapshot to the public repo `lidorAvr/medura` (DEPLOY.md §9).

## Commands (Windows, from the project root)
```powershell
.venv\Scripts\python.exe tools\devserver.py 5178          # http://localhost:5178/?demo=1
.venv\Scripts\python.exe -m pytest -q --ignore=tests/live  # full suite (~5 min): logic, API, DB (embedded Postgres), E2E
.venv\Scripts\python.exe -m pytest -q tests/e2e/test_e2e_lists.py -k dup   # a subset
.venv\Scripts\python.exe tools\db_deploy.py verify         # live DB checks (needs $env:DATABASE_URL)
```
- E2E tests use Playwright with the installed Edge/Chrome (`channel="msedge"`, falling back to `"chrome"`), always `?demo=1`.
- After booting, tests must wait for the trip snapshot (`Session.boot` does) — the nav renders before data arrives.
- Sheets reset their form in `useLayoutEffect` on open (not `useEffect`) so fast typing isn't overwritten.
