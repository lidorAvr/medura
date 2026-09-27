# Integration TODO (orchestrator notes)

**Deployment steps live in [DEPLOY.md](DEPLOY.md)** (schema → seed → config → live smoke test → hosting).

- Supabase project: ref `ocyxyqovculndfefjwlx` (Frankfurt), org Sentinel-Trading (free). Anonymous sign-ins ON (verified via /auth/v1/settings).
- Project created with **"Automatically expose new tables" = OFF** and **automatic RLS = ON** — schema.sql grants
  `usage on schema public` + table SELECT + RPC EXECUTE to `authenticated` explicitly; `tools/db_deploy.py verify` checks it.
- Real config (publishable key) stashed in private/config.supabase.js — copied into config.js during deployment (DEPLOY.md §6).
  E2E tests always boot with `?demo=1`, so they stay on the in-browser demo backend.
- Consider CAPTCHA (Turnstile) for anonymous sign-ins later (Supabase recommends it).
