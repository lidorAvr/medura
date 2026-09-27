-- =====================================================================================
-- מדורה (Medura) — database schema for Supabase (Postgres 15+)
-- =====================================================================================
--
-- What this is
--   The complete backend of the Medura group-trip organizer: tables, row-level security,
--   helper functions and every RPC the web app calls (docs/SPEC.md §3–§6 is the contract).
--
-- How to apply
--   Paste the whole file into the Supabase SQL editor of a fresh project and run it once.
--   It is safe to run again later (tables use "if not exists", functions use
--   "create or replace", policies are dropped and recreated), e.g. after fixing an RPC.
--   Changing the signature of an existing function requires dropping it first.
--
-- Security model
--   * RLS is enabled on every table and there are only SELECT policies.
--     Clients never write tables directly: every write goes through a SECURITY DEFINER RPC
--     (search_path pinned to public, pg_temp) that checks auth.uid(), membership and role.
--   * Client roles get SELECT on the readable tables only (no INSERT/UPDATE/DELETE/TRUNCATE);
--     member_secrets and push_subscriptions are not readable at all.
--   * Functions are executable by "authenticated" only (anonymous sign-ins are authenticated);
--     role "anon" (no session) can call nothing.
--   * RPC errors are raised as plain codes (e.g. 'forbidden', 'invalid_input') that the
--     client maps to Hebrew messages.
--   * Every mutating RPC bumps trips.rev; only "trips" is in the supabase_realtime
--     publication — clients listen to their trip row and refetch get_trip_snapshot().
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- 1. Tables
-- -------------------------------------------------------------------------------------

create table if not exists public.trips (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 1 and 60),
  emoji         text not null default '⛺',
  location      text,
  location_url  text,
  lat           double precision,
  lon           double precision,
  starts_at     timestamptz,
  ends_at       timestamptz,
  info          jsonb not null default '{"schedule":[],"rules":[],"notes":""}'::jsonb
                check (jsonb_typeof(info) = 'object'),
  settings      jsonb not null default '{"require_approval":true}'::jsonb
                check (jsonb_typeof(settings) = 'object'),
  invite_code   text not null unique,
  rev           bigint not null default 0,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- A member is a *unit*: a single person (headcount 1) or a couple (2), up to 8 for families.
create table if not exists public.members (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 1 and 40),
  headcount     int  not null default 1 check (headcount between 1 and 8),
  people        text[] not null default '{}',
  emoji         text not null default '🙂',
  color         text not null default '#2F6B4F',
  role          text not null default 'member' check (role in ('owner', 'admin', 'member')),
  phone         text,
  prefs         jsonb not null default '{}'::jsonb check (jsonb_typeof(prefs) = 'object'),
  inventory     text[] not null default '{}',
  claimed_at    timestamptz,
  created_at    timestamptz not null default now()
);

-- Device-link codes (never readable by clients; only via get_device_code / link_device).
create table if not exists public.member_secrets (
  member_id     uuid primary key references public.members(id) on delete cascade,
  trip_id       uuid not null references public.trips(id) on delete cascade,
  device_code   text not null unique
);

-- auth user <-> member. One member per user per trip; many users (devices / partner) per member.
create table if not exists public.member_users (
  user_id       uuid not null,
  trip_id       uuid not null references public.trips(id) on delete cascade,
  member_id     uuid not null references public.members(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (user_id, trip_id)
);

create table if not exists public.categories (
  id                uuid primary key default gen_random_uuid(),
  trip_id           uuid not null references public.trips(id) on delete cascade,
  name              text not null check (char_length(name) between 1 and 40),
  emoji             text not null default '📦',
  sort              int  not null default 0,
  default_buyer_id  uuid references public.members(id) on delete set null,
  note              text,
  created_at        timestamptz not null default now()
);

create table if not exists public.items (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  category_id   uuid references public.categories(id) on delete set null,
  title         text not null check (char_length(title) between 1 and 120),
  note          text check (note is null or char_length(note) <= 500),
  type          text not null check (type in ('buy', 'bring', 'each', 'task')),
  qty           numeric check (qty is null or qty > 0),
  unit          text check (unit is null or char_length(unit) <= 20),
  per_person    boolean not null default false,
  needed        int  not null default 1 check (needed between 1 and 200),
  status        text not null default 'active' check (status in ('proposed', 'active', 'rejected')),
  done          boolean not null default false,
  done_at       timestamptz,
  reject_reason text,
  created_by    uuid references public.members(id) on delete set null,
  approved_by   uuid references public.members(id) on delete set null,
  sort          int  not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.pledges (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  item_id       uuid not null references public.items(id) on delete cascade,
  member_id     uuid not null references public.members(id) on delete cascade,
  qty           int  not null default 1 check (qty between 1 and 200),
  done          boolean not null default false,
  assigned_by   uuid references public.members(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (item_id, member_id)
);

create table if not exists public.expenses (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 80),
  amount        numeric(10,2) not null check (amount > 0 and amount <= 100000),
  paid_by       uuid not null references public.members(id),
  category_id   uuid references public.categories(id) on delete set null,
  note          text,
  split_mode    text not null default 'all' check (split_mode in ('all', 'members')),
  created_by    uuid references public.members(id),
  spent_on      date not null default current_date,
  created_at    timestamptz not null default now()
);

-- Only used for split_mode = 'members'.
create table if not exists public.expense_shares (
  expense_id    uuid not null references public.expenses(id) on delete cascade,
  trip_id       uuid not null references public.trips(id) on delete cascade,
  member_id     uuid not null references public.members(id) on delete cascade,
  weight        numeric not null check (weight > 0),
  primary key (expense_id, member_id)
);

create table if not exists public.payments (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  from_member   uuid not null references public.members(id),
  to_member     uuid not null references public.members(id),
  amount        numeric(10,2) not null check (amount > 0 and amount <= 100000),
  method        text not null default 'bit' check (method in ('bit', 'paybox', 'cash', 'transfer', 'other')),
  note          text,
  status        text not null default 'sent' check (status in ('sent', 'confirmed')),
  created_by    uuid references public.members(id),
  created_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  check (from_member <> to_member)
);

create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  kind          text not null check (kind in ('announcement', 'system', 'reminder')),
  title         text not null check (char_length(title) between 1 and 80),
  body          text check (body is null or char_length(body) <= 2000),
  audience      uuid[],                -- null = everyone
  author_member uuid references public.members(id) on delete set null,
  urgent        boolean not null default false,
  link          text,                  -- hash route, e.g. #/t/<trip>/lists
  created_at    timestamptz not null default now()
);

create table if not exists public.notification_reads (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  trip_id         uuid not null references public.trips(id) on delete cascade,
  member_id       uuid not null references public.members(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, member_id)
);

create table if not exists public.admin_votes (
  trip_id       uuid not null references public.trips(id) on delete cascade,
  voter_id      uuid not null references public.members(id) on delete cascade,
  candidate_id  uuid not null references public.members(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (voter_id, candidate_id)
);

create table if not exists public.polls (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  question      text not null check (char_length(question) between 1 and 140),
  options       jsonb not null check (
                  case when jsonb_typeof(options) = 'array'
                       then jsonb_array_length(options) between 2 and 8
                       else false end),
  multi         boolean not null default false,
  closed        boolean not null default false,
  created_by    uuid references public.members(id) on delete set null,
  created_at    timestamptz not null default now()
);

create table if not exists public.poll_votes (
  poll_id       uuid not null references public.polls(id) on delete cascade,
  trip_id       uuid not null references public.trips(id) on delete cascade,
  member_id     uuid not null references public.members(id) on delete cascade,
  option_id     text not null,
  primary key (poll_id, member_id, option_id)
);

-- Private packing list of one member (unit). Nobody else sees it, not even admins.
create table if not exists public.personal_items (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  member_id     uuid not null references public.members(id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 80),
  done          boolean not null default false,
  sort          int  not null default 0,
  created_at    timestamptz not null default now()
);

-- Web Push subscriptions (Phase 2 delivery). Never readable by clients.
create table if not exists public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  member_id     uuid not null references public.members(id) on delete cascade,
  user_id       uuid not null,
  endpoint      text not null unique,
  p256dh        text,
  auth          text,
  created_at    timestamptz not null default now()
);

create index if not exists members_trip_idx             on public.members (trip_id);
create index if not exists member_secrets_trip_idx      on public.member_secrets (trip_id);
create index if not exists member_users_member_idx      on public.member_users (member_id);
create index if not exists member_users_trip_idx        on public.member_users (trip_id);
create index if not exists categories_trip_idx          on public.categories (trip_id);
create index if not exists items_trip_idx               on public.items (trip_id);
create index if not exists items_category_idx           on public.items (category_id);
create index if not exists pledges_trip_idx             on public.pledges (trip_id);
create index if not exists pledges_member_idx           on public.pledges (member_id);
create index if not exists expenses_trip_idx            on public.expenses (trip_id);
create index if not exists expense_shares_trip_idx      on public.expense_shares (trip_id);
create index if not exists expense_shares_member_idx    on public.expense_shares (member_id);
create index if not exists payments_trip_idx            on public.payments (trip_id);
create index if not exists notifications_trip_idx       on public.notifications (trip_id, created_at desc);
create index if not exists notification_reads_trip_idx  on public.notification_reads (trip_id);
create index if not exists notification_reads_member_idx on public.notification_reads (member_id);
create index if not exists admin_votes_trip_idx         on public.admin_votes (trip_id);
create index if not exists admin_votes_candidate_idx    on public.admin_votes (candidate_id);
create index if not exists polls_trip_idx               on public.polls (trip_id);
create index if not exists poll_votes_trip_idx          on public.poll_votes (trip_id);
create index if not exists poll_votes_member_idx        on public.poll_votes (member_id);
create index if not exists personal_items_trip_idx      on public.personal_items (trip_id);
create index if not exists personal_items_member_idx    on public.personal_items (member_id);
create index if not exists push_subscriptions_trip_idx  on public.push_subscriptions (trip_id);
create index if not exists push_subscriptions_member_idx on public.push_subscriptions (member_id);
create index if not exists push_subscriptions_user_idx  on public.push_subscriptions (user_id);


-- -------------------------------------------------------------------------------------
-- 2. Helper functions (internal; not callable by clients except the three RLS helpers)
-- -------------------------------------------------------------------------------------

-- Member id of the calling user in a trip, or null.
create or replace function public._my_member(p_trip uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select mu.member_id from public.member_users mu
  where mu.user_id = auth.uid() and mu.trip_id = p_trip
$$;

create or replace function public._is_member(p_trip uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.member_users mu
    where mu.user_id = auth.uid() and mu.trip_id = p_trip)
$$;

create or replace function public._is_admin(p_trip uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.member_users mu
    join public.members m on m.id = mu.member_id
    where mu.user_id = auth.uid() and mu.trip_id = p_trip and m.role in ('owner', 'admin'))
$$;

-- auth.uid() or 'not_authenticated'.
create or replace function public._uid() returns uuid
language plpgsql stable set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  return v_uid;
end $$;

create or replace function public._bump(p_trip uuid) returns void
language sql set search_path = public, pg_temp
as $$
  update public.trips set rev = rev + 1, updated_at = now() where id = p_trip
$$;

-- Raises invalid_input when a required value is missing.
create or replace function public._req(p_value anyelement) returns anyelement
language plpgsql immutable set search_path = public, pg_temp
as $$
begin
  if p_value is null then
    raise exception 'invalid_input';
  end if;
  return p_value;
end $$;

-- Trimmed text; blank -> null; longer than p_max characters -> invalid_input.
create or replace function public._clean(p_text text, p_max int) returns text
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  v text := btrim(p_text, E' \t\r\n');
begin
  if v is null or v = '' then
    return null;
  end if;
  if char_length(v) > p_max then
    raise exception 'invalid_input';
  end if;
  return v;
end $$;

-- Scalar value of a jsonb key as text (null when missing / JSON null). Objects & arrays are invalid.
create or replace function public._j_scalar(p jsonb, p_key text) returns text
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  v jsonb := p -> p_key;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) in ('object', 'array') then
    raise exception 'invalid_input';
  end if;
  return v #>> '{}';
end $$;

create or replace function public._j_text(p jsonb, p_key text, p_max int) returns text
language sql immutable set search_path = public, pg_temp
as $$
  select public._clean(public._j_scalar(p, p_key), p_max)
$$;

create or replace function public._j_num(p jsonb, p_key text) returns numeric
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  t text := btrim(public._j_scalar(p, p_key));
  v numeric;
begin
  if t is null or t = '' then
    return null;
  end if;
  begin
    v := t::numeric;
  exception when others then
    raise exception 'invalid_input';
  end;
  if abs(v) > 1e12 then          -- also rejects NaN and Infinity
    raise exception 'invalid_input';
  end if;
  return v;
end $$;

create or replace function public._j_int(p jsonb, p_key text) returns int
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  v numeric := public._j_num(p, p_key);
begin
  if v is null then
    return null;
  end if;
  if v <> trunc(v) or v > 2147483647 or v < -2147483648 then
    raise exception 'invalid_input';
  end if;
  return v::int;
end $$;

create or replace function public._j_bool(p jsonb, p_key text) returns boolean
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  t text := btrim(public._j_scalar(p, p_key));
begin
  if t is null or t = '' then
    return null;
  end if;
  return t::boolean;
exception when invalid_text_representation then
  raise exception 'invalid_input';
end $$;

create or replace function public._j_uuid(p jsonb, p_key text) returns uuid
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  t text := btrim(public._j_scalar(p, p_key));
begin
  if t is null or t = '' then
    return null;
  end if;
  return t::uuid;
exception when invalid_text_representation then
  raise exception 'invalid_input';
end $$;

create or replace function public._j_ts(p jsonb, p_key text) returns timestamptz
language plpgsql stable set search_path = public, pg_temp
as $$
declare
  t text := btrim(public._j_scalar(p, p_key));
  v timestamptz;
begin
  if t is null or t = '' then
    return null;
  end if;
  begin
    v := t::timestamptz;
  exception when others then
    raise exception 'invalid_input';
  end;
  if not isfinite(v) then
    raise exception 'invalid_input';
  end if;
  return v;
end $$;

create or replace function public._j_date(p jsonb, p_key text) returns date
language plpgsql stable set search_path = public, pg_temp
as $$
declare
  t text := btrim(public._j_scalar(p, p_key));
  v date;
begin
  if t is null or t = '' then
    return null;
  end if;
  begin
    v := t::date;
  exception when others then
    raise exception 'invalid_input';
  end;
  if not isfinite(v) or v < date '2000-01-01' or v > date '2100-12-31' then
    raise exception 'invalid_input';
  end if;
  return v;
end $$;

-- jsonb array of strings -> text[] (trimmed, blanks dropped). JSON null -> '{}'.
create or replace function public._j_text_array(
  p jsonb, p_key text, p_max_items int, p_max_len int, p_dedupe boolean
) returns text[]
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  v jsonb := p -> p_key;
  e jsonb;
  t text;
  r text[] := '{}';
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return r;
  end if;
  if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > p_max_items then
    raise exception 'invalid_input';
  end if;
  for e in select value from jsonb_array_elements(v) loop
    if jsonb_typeof(e) not in ('string', 'number') then
      raise exception 'invalid_input';
    end if;
    t := public._clean(e #>> '{}', p_max_len);
    continue when t is null;
    continue when p_dedupe and t = any (r);
    r := r || t;
  end loop;
  return r;
end $$;

-- Quantity: null/0 -> null (no quantity); negative or absurd -> invalid_input.
create or replace function public._qty(p_value numeric) returns numeric
language plpgsql immutable set search_path = public, pg_temp
as $$
begin
  if p_value is null or p_value = 0 then
    return null;
  end if;
  if p_value < 0 or p_value > 100000 then
    raise exception 'invalid_input';
  end if;
  return p_value;
end $$;

-- Money amount: required, rounded to agorot, 0 < amount <= 100000.
create or replace function public._money(p_value numeric) returns numeric
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  v numeric := round(p_value, 2);
begin
  if v is null or v <= 0 or v > 100000 then
    raise exception 'invalid_input';
  end if;
  return v;
end $$;

-- '₪1,234' / '₪12.50'
create or replace function public._fmt_money(p_amount numeric) returns text
language sql immutable set search_path = public, pg_temp
as $$
  select '₪' || case when p_amount = trunc(p_amount)
                     then to_char(p_amount, 'FM999,999,990')
                     else to_char(p_amount, 'FM999,999,990.00') end
$$;

-- Today's date in Israel (expense default). Falls back to the server date on a Postgres
-- build without the IANA time zone database.
create or replace function public._il_today() returns date
language plpgsql stable set search_path = public, pg_temp
as $$
begin
  return (now() at time zone 'Asia/Jerusalem')::date;
exception when invalid_parameter_value then
  return current_date;
end $$;

-- 10 chars from abcdefghjkmnpqrstuvwxyz23456789 (31 symbols). Randomness comes from
-- gen_random_uuid() (core Postgres, no pgcrypto); rejection sampling keeps it unbiased.
create or replace function public._gen_code() returns text
language plpgsql volatile set search_path = public, pg_temp
as $$
declare
  c_alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  v_bytes bytea := ''::bytea;
  v_pos int := 0;
  v_byte int;
  v_out text := '';
begin
  while char_length(v_out) < 10 loop
    if v_pos >= length(v_bytes) then
      v_bytes := decode(md5(gen_random_uuid()::text), 'hex');
      v_pos := 0;
    end if;
    v_byte := get_byte(v_bytes, v_pos);
    v_pos := v_pos + 1;
    if v_byte < 248 then                    -- 248 = 31 * 8
      v_out := v_out || substr(c_alphabet, (v_byte % 31) + 1, 1);
    end if;
  end loop;
  return v_out;
end $$;

create or replace function public._new_invite_code() returns text
language plpgsql volatile set search_path = public, pg_temp
as $$
declare
  v_code text;
begin
  loop
    v_code := public._gen_code();
    exit when not exists (select 1 from public.trips where invite_code = v_code);
  end loop;
  return v_code;
end $$;

create or replace function public._new_device_code() returns text
language plpgsql volatile set search_path = public, pg_temp
as $$
declare
  v_code text;
begin
  loop
    v_code := public._gen_code();
    exit when not exists (select 1 from public.member_secrets where device_code = v_code);
  end loop;
  return v_code;
end $$;

-- Invite / device codes as typed by people: case and surrounding spaces don't matter.
create or replace function public._norm_code(p_code text) returns text
language sql immutable set search_path = public, pg_temp
as $$
  select lower(btrim(coalesce(p_code, ''), E' \t\r\n'))
$$;

-- SPEC §6 default categories (sort 1..10). Skips names that already exist.
create or replace function public._create_default_categories(p_trip uuid) returns void
language sql set search_path = public, pg_temp
as $$
  insert into public.categories (trip_id, name, emoji, sort)
  select p_trip, d.name, d.emoji, d.sort
  from (values
    ('בשר ועוף',         '🥩',  1),
    ('ירקות ופירות',     '🥗',  2),
    ('מזווה ורטבים',     '🥫',  3),
    ('נשנושים ומתוקים',  '🍿',  4),
    ('שתייה ואלכוהול',   '🥤',  5),
    ('מנגל ובישול',      '🔥',  6),
    ('חד־פעמי',          '🍽️', 7),
    ('ציוד קבוצתי',      '⛺',  8),
    ('כיף ומשחקים',      '🎲',  9),
    ('משימות',           '📋', 10)
  ) as d(name, emoji, sort)
  where not exists (
    select 1 from public.categories c where c.trip_id = p_trip and c.name = d.name)
$$;

-- Owners and admins of a trip (optionally without one member), oldest first.
create or replace function public._admin_ids(p_trip uuid, p_except uuid default null) returns uuid[]
language sql stable set search_path = public, pg_temp
as $$
  select coalesce(array_agg(m.id order by m.created_at, m.id), '{}')
  from public.members m
  where m.trip_id = p_trip and m.role in ('owner', 'admin') and m.id is distinct from p_except
$$;

-- System notification. An empty audience array means "nobody" -> nothing is created.
create or replace function public._notify(
  p_trip uuid, p_title text, p_body text, p_audience uuid[], p_link text
) returns uuid
language plpgsql set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(p_title);
  v_id uuid;
begin
  if p_audience is not null and cardinality(p_audience) = 0 then
    return null;
  end if;
  if char_length(v_title) > 80 then
    v_title := left(v_title, 79) || '…';
  end if;
  insert into public.notifications (trip_id, kind, title, body, audience, link)
  values (p_trip, 'system', v_title, left(nullif(btrim(p_body), ''), 2000), p_audience, p_link)
  returning id into v_id;
  return v_id;
end $$;

-- SPEC §3 notification visibility rule.
create or replace function public._notif_visible(
  p_audience uuid[], p_author uuid, p_kind text, p_me uuid, p_admin boolean
) returns boolean
language sql immutable set search_path = public, pg_temp
as $$
  select p_audience is null
      or p_me = any (p_audience)
      or p_author = p_me
      or (p_kind = 'announcement' and coalesce(p_admin, false))
$$;

-- Category id if it belongs to the trip (null passes through), else invalid_input.
create or replace function public._trip_category(p_trip uuid, p_category uuid) returns uuid
language plpgsql stable set search_path = public, pg_temp
as $$
begin
  if p_category is not null and not exists (
    select 1 from public.categories where id = p_category and trip_id = p_trip) then
    raise exception 'invalid_input';
  end if;
  return p_category;
end $$;

-- Member id if it belongs to the trip, else invalid_input.
create or replace function public._trip_member(p_trip uuid, p_member uuid) returns uuid
language plpgsql stable set search_path = public, pg_temp
as $$
begin
  if p_member is null or not exists (
    select 1 from public.members where id = p_member and trip_id = p_trip) then
    raise exception 'invalid_input';
  end if;
  return p_member;
end $$;

-- Applies a trip patch (keys: name, emoji, location, location_url, lat, lon, starts_at,
-- ends_at, info, settings). Unknown keys are ignored; info/settings are merged key by key.
create or replace function public._apply_trip_patch(p_trip uuid, p_patch jsonb) returns void
language plpgsql set search_path = public, pg_temp
as $$
declare
  r public.trips;
  v jsonb;
begin
  if p_patch is null then
    return;
  end if;
  if jsonb_typeof(p_patch) <> 'object' then
    raise exception 'invalid_input';
  end if;
  select * into r from public.trips where id = p_trip for update;

  if p_patch ? 'name' then
    r.name := public._req(public._j_text(p_patch, 'name', 60));
  end if;
  if p_patch ? 'emoji' then
    r.emoji := public._req(public._j_text(p_patch, 'emoji', 16));
  end if;
  if p_patch ? 'location' then
    r.location := public._j_text(p_patch, 'location', 120);
  end if;
  if p_patch ? 'location_url' then
    r.location_url := public._j_text(p_patch, 'location_url', 1000);
    if r.location_url is not null and r.location_url !~* '^https://' then
      raise exception 'invalid_input';
    end if;
  end if;
  if p_patch ? 'lat' then
    r.lat := public._j_num(p_patch, 'lat');
    if r.lat is not null and r.lat not between -90 and 90 then
      raise exception 'invalid_input';
    end if;
  end if;
  if p_patch ? 'lon' then
    r.lon := public._j_num(p_patch, 'lon');
    if r.lon is not null and r.lon not between -180 and 180 then
      raise exception 'invalid_input';
    end if;
  end if;
  if p_patch ? 'starts_at' then
    r.starts_at := public._j_ts(p_patch, 'starts_at');
  end if;
  if p_patch ? 'ends_at' then
    r.ends_at := public._j_ts(p_patch, 'ends_at');
  end if;
  if r.starts_at is not null and r.ends_at is not null and r.ends_at < r.starts_at then
    raise exception 'invalid_input';
  end if;
  if p_patch ? 'info' then
    v := p_patch -> 'info';
    if jsonb_typeof(v) is distinct from 'object' then
      raise exception 'invalid_input';
    end if;
    v := '{"schedule":[],"rules":[],"notes":""}'::jsonb || r.info || v;
    if jsonb_typeof(v -> 'schedule') <> 'array' or jsonb_array_length(v -> 'schedule') > 60
       or jsonb_typeof(v -> 'rules') <> 'array' or jsonb_array_length(v -> 'rules') > 60
       or jsonb_typeof(v -> 'notes') not in ('string', 'null')
       or length(v::text) > 20000 then
      raise exception 'invalid_input';
    end if;
    r.info := v;
  end if;
  if p_patch ? 'settings' then
    v := p_patch -> 'settings';
    if jsonb_typeof(v) is distinct from 'object' then
      raise exception 'invalid_input';
    end if;
    v := r.settings || v;
    if (v ? 'require_approval' and jsonb_typeof(v -> 'require_approval') <> 'boolean')
       or length(v::text) > 4000 then
      raise exception 'invalid_input';
    end if;
    r.settings := v;
  end if;

  update public.trips
     set name = r.name, emoji = r.emoji, location = r.location, location_url = r.location_url,
         lat = r.lat, lon = r.lon, starts_at = r.starts_at, ends_at = r.ends_at,
         info = r.info, settings = r.settings
   where id = p_trip;
end $$;

-- Applies a profile patch (keys: display_name, headcount, people, emoji, color, phone,
-- prefs, inventory). Unknown keys (including "role") are ignored; prefs are merged.
create or replace function public._apply_member_patch(p_member uuid, p_patch jsonb) returns void
language plpgsql set search_path = public, pg_temp
as $$
declare
  r public.members;
  v jsonb;
begin
  if p_patch is null then
    return;
  end if;
  if jsonb_typeof(p_patch) <> 'object' then
    raise exception 'invalid_input';
  end if;
  select * into r from public.members where id = p_member for update;

  if p_patch ? 'display_name' then
    r.display_name := public._req(public._j_text(p_patch, 'display_name', 40));
  end if;
  if p_patch ? 'headcount' then
    r.headcount := public._req(public._j_int(p_patch, 'headcount'));
    if r.headcount not between 1 and 8 then
      raise exception 'invalid_input';
    end if;
  end if;
  if p_patch ? 'people' then
    r.people := public._j_text_array(p_patch, 'people', 8, 40, false);
  end if;
  if p_patch ? 'emoji' then
    r.emoji := public._req(public._j_text(p_patch, 'emoji', 16));
  end if;
  if p_patch ? 'color' then
    r.color := public._req(public._j_text(p_patch, 'color', 7));
    if r.color !~ '^#[0-9A-Fa-f]{6}$' then
      raise exception 'invalid_input';
    end if;
  end if;
  if p_patch ? 'phone' then
    r.phone := public._j_text(p_patch, 'phone', 20);
    if r.phone is not null and r.phone !~ '^[0-9+() -]+$' then
      raise exception 'invalid_input';
    end if;
  end if;
  if p_patch ? 'prefs' then
    v := p_patch -> 'prefs';
    if jsonb_typeof(v) is distinct from 'object' then
      raise exception 'invalid_input';
    end if;
    r.prefs := r.prefs || v;
    if length(r.prefs::text) > 8000 then
      raise exception 'invalid_input';
    end if;
  end if;
  if p_patch ? 'inventory' then
    r.inventory := public._j_text_array(p_patch, 'inventory', 60, 40, true);
  end if;

  update public.members
     set display_name = r.display_name, headcount = r.headcount, people = r.people,
         emoji = r.emoji, color = r.color, phone = r.phone, prefs = r.prefs,
         inventory = r.inventory
   where id = p_member;
end $$;

-- New member from a profile. display_name falls back to the people's names ("הדס ועידו").
create or replace function public._insert_member(
  p_trip uuid, p_profile jsonb, p_role text, p_claimed boolean
) returns uuid
language plpgsql set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_id uuid;
begin
  if p_profile is null or jsonb_typeof(p_profile) <> 'object' then
    raise exception 'invalid_input';
  end if;
  if (select count(*) from public.members where trip_id = p_trip) >= 60 then
    raise exception 'limit_reached';
  end if;
  v_name := coalesce(
    public._j_text(p_profile, 'display_name', 40),
    public._clean(array_to_string(public._j_text_array(p_profile, 'people', 8, 40, false), ' ו'), 40));
  insert into public.members (trip_id, display_name, role, claimed_at)
  values (p_trip, public._req(v_name), p_role, case when p_claimed then now() end)
  returning id into v_id;
  perform public._apply_member_patch(v_id, p_profile - 'display_name');
  return v_id;
end $$;

-- New item from an add_item object; the category is resolved by the caller.
create or replace function public._insert_item(
  p_trip uuid, p_me uuid, p_admin boolean, p_item jsonb, p_category uuid
) returns uuid
language plpgsql set search_path = public, pg_temp
as $$
declare
  v_type text;
  v_needed int;
  v_pledge int;
  v_status text;
  v_id uuid;
begin
  if p_item is null or jsonb_typeof(p_item) <> 'object' then
    raise exception 'invalid_input';
  end if;
  v_type := coalesce(public._j_text(p_item, 'type', 10), 'buy');
  if v_type not in ('buy', 'bring', 'each', 'task') then
    raise exception 'invalid_input';
  end if;
  v_needed := coalesce(public._j_int(p_item, 'needed'), 1);
  if v_needed not between 1 and 200 then
    raise exception 'invalid_input';
  end if;
  v_pledge := coalesce(public._j_int(p_item, 'pledge_qty'), 0);
  if v_pledge > 200 then
    raise exception 'invalid_input';
  end if;
  v_status := case
    when p_admin then 'active'
    when coalesce((select (t.settings ->> 'require_approval')::boolean
                   from public.trips t where t.id = p_trip), true) then 'proposed'
    else 'active' end;

  insert into public.items (
    trip_id, category_id, title, note, type, qty, unit, per_person, needed, status,
    created_by, approved_by, created_at, updated_at)
  values (
    p_trip, p_category,
    public._req(public._j_text(p_item, 'title', 120)),
    public._j_text(p_item, 'note', 500),
    v_type,
    public._qty(public._j_num(p_item, 'qty')),
    public._j_text(p_item, 'unit', 20),
    coalesce(public._j_bool(p_item, 'per_person'), false),
    v_needed, v_status, p_me,
    case when p_admin then p_me end,
    clock_timestamp(), clock_timestamp())     -- keeps bulk-import order
  returning id into v_id;

  if v_pledge > 0 and v_type <> 'each' then
    insert into public.pledges (trip_id, item_id, member_id, qty)
    values (p_trip, v_id, p_me, v_pledge);
  end if;
  return v_id;
end $$;

-- Called when the last device leaves a member: it becomes an unclaimed profile again, its
-- device code stops working, and it loses owner/admin powers (otherwise anyone holding the
-- invite link could claim it and inherit them). Ownership passes to the longest-standing
-- other admin (claimed admins first).
create or replace function public._release_member(p_member uuid) returns void
language plpgsql set search_path = public, pg_temp
as $$
declare
  r public.members;
  v_heir uuid;
begin
  select * into r from public.members where id = p_member for update;
  if r.role = 'owner' then
    select id into v_heir from public.members
    where trip_id = r.trip_id and role = 'admin' and id <> p_member
    order by claimed_at is null, created_at, id
    limit 1;
    if v_heir is not null then
      update public.members set role = 'owner' where id = v_heir;
    end if;
  end if;
  update public.members set claimed_at = null, role = 'member' where id = p_member;
  delete from public.member_secrets where member_id = p_member;
end $$;

-- Replaces the shares of a split_mode='members' expense. p_members: [{member_id, weight?}]
-- (plain member-id strings are accepted too). weight defaults to the member's headcount.
create or replace function public._set_expense_shares(
  p_expense uuid, p_trip uuid, p_members jsonb
) returns void
language plpgsql set search_path = public, pg_temp
as $$
declare
  e jsonb;
  v_member uuid;
  v_weight numeric;
  v_headcount int;
  v_seen uuid[] := '{}';
begin
  if p_members is null or jsonb_typeof(p_members) <> 'array'
     or jsonb_array_length(p_members) = 0 or jsonb_array_length(p_members) > 60 then
    raise exception 'invalid_input';
  end if;
  delete from public.expense_shares where expense_id = p_expense;
  for e in select value from jsonb_array_elements(p_members) loop
    if jsonb_typeof(e) = 'string' then
      e := jsonb_build_object('member_id', e);
    end if;
    if jsonb_typeof(e) <> 'object' then
      raise exception 'invalid_input';
    end if;
    v_member := public._req(public._j_uuid(e, 'member_id'));
    if v_member = any (v_seen) then
      raise exception 'invalid_input';
    end if;
    select headcount into v_headcount from public.members where id = v_member and trip_id = p_trip;
    if not found then
      raise exception 'invalid_input';
    end if;
    v_weight := coalesce(public._j_num(e, 'weight'), v_headcount);
    if v_weight <= 0 or v_weight > 100 then
      raise exception 'invalid_input';
    end if;
    insert into public.expense_shares (expense_id, trip_id, member_id, weight)
    values (p_expense, p_trip, v_member, v_weight);
    v_seen := v_seen || v_member;
  end loop;
end $$;


-- -------------------------------------------------------------------------------------
-- 3. Row-level security (SELECT policies only — all writes go through RPCs)
-- -------------------------------------------------------------------------------------

alter table public.trips              enable row level security;
alter table public.members            enable row level security;
alter table public.member_secrets     enable row level security;
alter table public.member_users       enable row level security;
alter table public.categories         enable row level security;
alter table public.items              enable row level security;
alter table public.pledges            enable row level security;
alter table public.expenses           enable row level security;
alter table public.expense_shares     enable row level security;
alter table public.payments           enable row level security;
alter table public.notifications      enable row level security;
alter table public.notification_reads enable row level security;
alter table public.admin_votes        enable row level security;
alter table public.polls              enable row level security;
alter table public.poll_votes         enable row level security;
alter table public.personal_items     enable row level security;
alter table public.push_subscriptions enable row level security;

drop policy if exists trips_select on public.trips;
create policy trips_select on public.trips
  for select to authenticated using (public._is_member(id));

drop policy if exists members_select on public.members;
create policy members_select on public.members
  for select to authenticated using (public._is_member(trip_id));

drop policy if exists member_users_select on public.member_users;
create policy member_users_select on public.member_users
  for select to authenticated using (user_id = auth.uid());

drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories
  for select to authenticated using (public._is_member(trip_id));

drop policy if exists items_select on public.items;
create policy items_select on public.items
  for select to authenticated using (public._is_member(trip_id));

drop policy if exists pledges_select on public.pledges;
create policy pledges_select on public.pledges
  for select to authenticated using (public._is_member(trip_id));

drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses
  for select to authenticated using (public._is_member(trip_id));

drop policy if exists expense_shares_select on public.expense_shares;
create policy expense_shares_select on public.expense_shares
  for select to authenticated using (public._is_member(trip_id));

drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
  for select to authenticated using (public._is_member(trip_id));

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated using (
    public._is_member(trip_id)
    and (audience is null
         or public._my_member(trip_id) = any (audience)
         or author_member = public._my_member(trip_id)
         or (kind = 'announcement' and public._is_admin(trip_id))));

drop policy if exists notification_reads_select on public.notification_reads;
create policy notification_reads_select on public.notification_reads
  for select to authenticated using (
    member_id = public._my_member(trip_id) or public._is_admin(trip_id));

drop policy if exists admin_votes_select on public.admin_votes;
create policy admin_votes_select on public.admin_votes
  for select to authenticated using (public._is_member(trip_id));

drop policy if exists polls_select on public.polls;
create policy polls_select on public.polls
  for select to authenticated using (public._is_member(trip_id));

drop policy if exists poll_votes_select on public.poll_votes;
create policy poll_votes_select on public.poll_votes
  for select to authenticated using (public._is_member(trip_id));

drop policy if exists personal_items_select on public.personal_items;
create policy personal_items_select on public.personal_items
  for select to authenticated using (member_id = public._my_member(trip_id));

-- member_secrets, push_subscriptions: intentionally no policy at all.


-- -------------------------------------------------------------------------------------
-- 4. RPCs — trips, joining, devices
-- -------------------------------------------------------------------------------------

create or replace function public.my_trips() returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'trip', jsonb_build_object(
               'id', t.id, 'name', t.name, 'emoji', t.emoji, 'location', t.location,
               'starts_at', t.starts_at, 'ends_at', t.ends_at),
             'member', jsonb_build_object(
               'id', m.id, 'display_name', m.display_name, 'emoji', m.emoji,
               'color', m.color, 'role', m.role))
           order by t.starts_at nulls last, t.created_at)
    from public.member_users mu
    join public.trips t on t.id = mu.trip_id
    join public.members m on m.id = mu.member_id
    where mu.user_id = v_uid), '[]'::jsonb);
end $$;

create or replace function public.create_trip(p_trip jsonb, p_profile jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_trip uuid;
  v_member uuid;
begin
  if p_trip is null or jsonb_typeof(p_trip) <> 'object' then
    raise exception 'invalid_input';
  end if;
  insert into public.trips (name, invite_code, created_by)
  values (public._req(public._j_text(p_trip, 'name', 60)), public._new_invite_code(), v_uid)
  returning id into v_trip;
  perform public._apply_trip_patch(v_trip, p_trip - 'name');

  v_member := public._insert_member(v_trip, p_profile, 'owner', true);
  insert into public.member_users (user_id, trip_id, member_id) values (v_uid, v_trip, v_member);
  perform public._create_default_categories(v_trip);
  perform public._bump(v_trip);
  return jsonb_build_object('trip_id', v_trip, 'member_id', v_member);
end $$;

create or replace function public.preview_invite(p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_trip public.trips;
begin
  select * into v_trip from public.trips where invite_code = public._norm_code(p_code);
  if not found then
    raise exception 'invalid_code';
  end if;
  return jsonb_build_object(
    'trip', jsonb_build_object(
      'id', v_trip.id, 'name', v_trip.name, 'emoji', v_trip.emoji, 'location', v_trip.location,
      'starts_at', v_trip.starts_at, 'ends_at', v_trip.ends_at),
    'member_count', (select count(*) from public.members where trip_id = v_trip.id),
    'headcount', (select coalesce(sum(headcount), 0) from public.members where trip_id = v_trip.id),
    'unclaimed', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'display_name', m.display_name, 'headcount', m.headcount,
               'people', to_jsonb(m.people), 'emoji', m.emoji, 'color', m.color)
             order by m.created_at, m.id)
      from public.members m
      where m.trip_id = v_trip.id and m.claimed_at is null), '[]'::jsonb),
    'my_member_id', public._my_member(v_trip.id));
end $$;

create or replace function public.join_trip(
  p_code text, p_claim_member uuid default null, p_profile jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_trip public.trips;
  v_member uuid;
  v_claimed timestamptz;
  v_had_admin boolean;
  v_name text;
begin
  -- Row lock serializes joins of one trip (claims and "first joiner becomes owner").
  select * into v_trip from public.trips where invite_code = public._norm_code(p_code) for update;
  if not found then
    raise exception 'invalid_code';
  end if;

  select member_id into v_member from public.member_users
  where user_id = v_uid and trip_id = v_trip.id;
  if found then
    return jsonb_build_object('trip_id', v_trip.id, 'member_id', v_member);
  end if;

  v_had_admin := exists (
    select 1 from public.members where trip_id = v_trip.id and role in ('owner', 'admin'));

  if p_claim_member is not null then
    select id, claimed_at into v_member, v_claimed from public.members
    where id = p_claim_member and trip_id = v_trip.id for update;
    if not found then
      raise exception 'not_found';
    end if;
    if v_claimed is not null then
      raise exception 'already_claimed';
    end if;
    update public.members set claimed_at = now() where id = v_member;
    perform public._apply_member_patch(v_member, p_profile);
  else
    v_member := public._insert_member(v_trip.id, p_profile, 'member', true);
  end if;

  if not v_had_admin then
    update public.members set role = 'owner' where id = v_member;
  end if;
  insert into public.member_users (user_id, trip_id, member_id) values (v_uid, v_trip.id, v_member);

  select display_name into v_name from public.members where id = v_member;
  perform public._notify(v_trip.id, v_name || ' הצטרפ/ה לטיול 🎉', null,
                         public._admin_ids(v_trip.id, v_member),
                         '#/t/' || v_trip.id || '/people');
  perform public._bump(v_trip.id);
  return jsonb_build_object('trip_id', v_trip.id, 'member_id', v_member);
end $$;

-- Links this device (auth user) to the member that owns the device code, replacing any
-- previous link of this user in that trip. If the previous member is left without devices
-- it is released (unclaimed) and its owner/admin role moves along with the user.
create or replace function public.link_device(p_device_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_secret public.member_secrets;
  v_old uuid;
  v_old_role text;
begin
  select * into v_secret from public.member_secrets where device_code = public._norm_code(p_device_code);
  if not found then
    raise exception 'invalid_code';
  end if;
  perform 1 from public.trips where id = v_secret.trip_id for update;

  select member_id into v_old from public.member_users
  where user_id = v_uid and trip_id = v_secret.trip_id;
  if v_old = v_secret.member_id then
    return jsonb_build_object('trip_id', v_secret.trip_id, 'member_id', v_secret.member_id);
  end if;

  if v_old is not null then
    delete from public.member_users where user_id = v_uid and trip_id = v_secret.trip_id;
    if not exists (select 1 from public.member_users where member_id = v_old) then
      select role into v_old_role from public.members where id = v_old;
      update public.members set role = 'member' where id = v_old;     -- powers move with me
      update public.members
         set role = case
               when v_old_role = 'owner' or role = 'owner' then 'owner'
               when v_old_role = 'admin' or role = 'admin' then 'admin'
               else 'member' end
       where id = v_secret.member_id;
      perform public._release_member(v_old);
    end if;
  end if;

  insert into public.member_users (user_id, trip_id, member_id)
  values (v_uid, v_secret.trip_id, v_secret.member_id);
  update public.members set claimed_at = coalesce(claimed_at, now()) where id = v_secret.member_id;
  perform public._bump(v_secret.trip_id);
  return jsonb_build_object('trip_id', v_secret.trip_id, 'member_id', v_secret.member_id);
end $$;

create or replace function public.get_device_code(p_member uuid) returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_trip uuid;
  v_code text;
begin
  select trip_id into v_trip from public.members where id = p_member;
  if not found then
    raise exception 'not_found';
  end if;
  if public._my_member(v_trip) is distinct from p_member then
    raise exception 'forbidden';
  end if;
  select device_code into v_code from public.member_secrets where member_id = p_member;
  if v_code is null then
    insert into public.member_secrets (member_id, trip_id, device_code)
    values (p_member, v_trip, public._new_device_code())
    on conflict (member_id) do nothing;
    select device_code into v_code from public.member_secrets where member_id = p_member;
  end if;
  return v_code;
end $$;

create or replace function public.get_trip_snapshot(p_trip uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_me uuid := public._my_member(p_trip);
  v_role text;
  v_admin boolean;
begin
  if v_me is null then
    raise exception 'forbidden';
  end if;
  select role into v_role from public.members where id = v_me;
  v_admin := v_role in ('owner', 'admin');

  return (
    select jsonb_build_object(
      'trip', jsonb_build_object(
        'id', t.id, 'name', t.name, 'emoji', t.emoji, 'location', t.location,
        'location_url', t.location_url, 'lat', t.lat, 'lon', t.lon,
        'starts_at', t.starts_at, 'ends_at', t.ends_at, 'info', t.info, 'settings', t.settings,
        'invite_code', t.invite_code, 'rev', t.rev, 'created_at', t.created_at),

      'me', jsonb_build_object('member_id', v_me, 'role', v_role, 'user_id', v_uid),

      'members', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', m.id, 'display_name', m.display_name, 'headcount', m.headcount,
                 'people', to_jsonb(m.people), 'emoji', m.emoji, 'color', m.color,
                 'role', m.role, 'phone', m.phone, 'prefs', m.prefs,
                 'inventory', to_jsonb(m.inventory), 'claimed', m.claimed_at is not null,
                 'created_at', m.created_at)
               order by m.created_at, m.id)
        from public.members m where m.trip_id = p_trip), '[]'::jsonb),

      'categories', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', c.id, 'name', c.name, 'emoji', c.emoji, 'sort', c.sort,
                 'default_buyer_id', c.default_buyer_id, 'note', c.note)
               order by c.sort, c.created_at, c.id)
        from public.categories c where c.trip_id = p_trip), '[]'::jsonb),

      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', i.id, 'category_id', i.category_id, 'title', i.title, 'note', i.note,
                 'type', i.type, 'qty', i.qty, 'unit', i.unit, 'per_person', i.per_person,
                 'needed', i.needed, 'status', i.status, 'done', i.done, 'done_at', i.done_at,
                 'reject_reason', i.reject_reason, 'created_by', i.created_by,
                 'approved_by', i.approved_by, 'sort', i.sort, 'created_at', i.created_at,
                 'updated_at', i.updated_at)
               order by i.sort, i.created_at, i.id)
        from public.items i
        where i.trip_id = p_trip
          and (i.status <> 'rejected' or v_admin or i.created_by = v_me)), '[]'::jsonb),

      'pledges', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', p.id, 'item_id', p.item_id, 'member_id', p.member_id, 'qty', p.qty,
                 'done', p.done, 'assigned_by', p.assigned_by, 'created_at', p.created_at)
               order by p.created_at, p.id)
        from public.pledges p
        join public.items i on i.id = p.item_id
        where p.trip_id = p_trip
          and (i.status <> 'rejected' or v_admin or i.created_by = v_me)), '[]'::jsonb),

      'expenses', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', x.id, 'title', x.title, 'amount', x.amount, 'paid_by', x.paid_by,
                 'category_id', x.category_id, 'note', x.note, 'split_mode', x.split_mode,
                 'created_by', x.created_by, 'spent_on', x.spent_on, 'created_at', x.created_at)
               order by x.spent_on, x.created_at, x.id)
        from public.expenses x where x.trip_id = p_trip), '[]'::jsonb),

      'expense_shares', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'expense_id', s.expense_id, 'member_id', s.member_id, 'weight', s.weight)
               order by s.expense_id, s.member_id)
        from public.expense_shares s where s.trip_id = p_trip), '[]'::jsonb),

      'payments', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', y.id, 'from_member', y.from_member, 'to_member', y.to_member,
                 'amount', y.amount, 'method', y.method, 'note', y.note, 'status', y.status,
                 'created_by', y.created_by, 'created_at', y.created_at,
                 'confirmed_at', y.confirmed_at)
               order by y.created_at, y.id)
        from public.payments y where y.trip_id = p_trip), '[]'::jsonb),

      'notifications', coalesce((
        select jsonb_agg(v.obj order by v.created_at desc, v.id)
        from (
          select n.id, n.created_at,
                 jsonb_build_object(
                   'id', n.id, 'kind', n.kind, 'title', n.title, 'body', n.body,
                   'audience', to_jsonb(n.audience), 'author_member', n.author_member,
                   'urgent', n.urgent, 'link', n.link, 'created_at', n.created_at) as obj
          from public.notifications n
          where n.trip_id = p_trip
            and public._notif_visible(n.audience, n.author_member, n.kind, v_me, v_admin)
          order by n.created_at desc, n.id
          limit 200) v), '[]'::jsonb),

      'reads', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'notification_id', r.notification_id, 'member_id', r.member_id,
                 'read_at', r.read_at)
               order by r.read_at, r.notification_id, r.member_id)
        from public.notification_reads r
        where r.trip_id = p_trip
          and (v_admin
               or r.member_id = v_me
               or exists (select 1 from public.notifications n
                          where n.id = r.notification_id and n.author_member = v_me))), '[]'::jsonb),

      'admin_votes', coalesce((
        select jsonb_agg(jsonb_build_object('voter_id', a.voter_id, 'candidate_id', a.candidate_id)
               order by a.created_at, a.voter_id, a.candidate_id)
        from public.admin_votes a where a.trip_id = p_trip), '[]'::jsonb),

      'polls', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', pl.id, 'question', pl.question, 'options', pl.options, 'multi', pl.multi,
                 'closed', pl.closed, 'created_by', pl.created_by, 'created_at', pl.created_at)
               order by pl.created_at, pl.id)
        from public.polls pl where pl.trip_id = p_trip), '[]'::jsonb),

      'poll_votes', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'poll_id', pv.poll_id, 'member_id', pv.member_id, 'option_id', pv.option_id)
               order by pv.poll_id, pv.member_id, pv.option_id)
        from public.poll_votes pv where pv.trip_id = p_trip), '[]'::jsonb),

      'personal_items', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', pi.id, 'title', pi.title, 'done', pi.done, 'sort', pi.sort,
                 'created_at', pi.created_at)
               order by pi.sort, pi.created_at, pi.id)
        from public.personal_items pi
        where pi.trip_id = p_trip and pi.member_id = v_me), '[]'::jsonb)
    )
    from public.trips t where t.id = p_trip);
end $$;

create or replace function public.update_trip(p_trip uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
begin
  if not public._is_admin(p_trip) then
    raise exception 'forbidden';
  end if;
  perform public._apply_trip_patch(p_trip, p_patch);
  perform public._bump(p_trip);
end $$;

create or replace function public.rotate_invite(p_trip uuid) returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_code text;
begin
  if not public._is_admin(p_trip) then
    raise exception 'forbidden';
  end if;
  update public.trips set invite_code = public._new_invite_code()
  where id = p_trip returning invite_code into v_code;
  perform public._bump(p_trip);
  return v_code;
end $$;


-- -------------------------------------------------------------------------------------
-- 5. RPCs — members & admins
-- -------------------------------------------------------------------------------------

create or replace function public.update_member(p_member uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_trip uuid;
begin
  select trip_id into v_trip from public.members where id = p_member;
  if not found then
    raise exception 'not_found';
  end if;
  if public._my_member(v_trip) is distinct from p_member and not public._is_admin(v_trip) then
    raise exception 'forbidden';
  end if;
  perform public._apply_member_patch(p_member, p_patch);
  perform public._bump(v_trip);
end $$;

-- Unclaimed placeholder profile (e.g. for a friend who hasn't opened the link yet).
create or replace function public.create_member(p_trip uuid, p_profile jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_member uuid;
begin
  if not public._is_admin(p_trip) then
    raise exception 'forbidden';
  end if;
  v_member := public._insert_member(p_trip, p_profile, 'member', false);
  perform public._bump(p_trip);
  return v_member;
end $$;

create or replace function public.set_role(p_member uuid, p_role text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_target public.members;
begin
  if p_role is null or p_role not in ('admin', 'member') then
    raise exception 'invalid_input';
  end if;
  select * into v_target from public.members where id = p_member;
  if not found then
    raise exception 'not_found';
  end if;
  if not public._is_admin(v_target.trip_id) then
    raise exception 'forbidden';
  end if;
  perform 1 from public.trips where id = v_target.trip_id for update;
  if v_target.role = 'owner' then
    raise exception 'owner_locked';
  end if;
  if v_target.role = p_role then
    return;
  end if;
  if p_role = 'member' and not exists (
    select 1 from public.members
    where trip_id = v_target.trip_id and role in ('owner', 'admin') and id <> p_member) then
    raise exception 'last_admin';
  end if;

  update public.members set role = p_role where id = p_member;
  if p_role = 'admin' then
    perform public._notify(v_target.trip_id, 'מונית למנהל/ת 👑',
                           'עכשיו אפשר לאשר הצעות, לשבץ ולשלוח הודעות לכולם.',
                           array[p_member], '#/t/' || v_target.trip_id || '/people');
  end if;
  perform public._bump(v_target.trip_id);
end $$;

create or replace function public.remove_member(p_member uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_target public.members;
begin
  select * into v_target from public.members where id = p_member;
  if not found then
    raise exception 'not_found';
  end if;
  if not public._is_admin(v_target.trip_id) then
    raise exception 'forbidden';
  end if;
  perform 1 from public.trips where id = v_target.trip_id for update;
  if v_target.role = 'owner' then
    raise exception 'owner_locked';
  end if;
  if v_target.role = 'admin' and not exists (
    select 1 from public.members
    where trip_id = v_target.trip_id and role in ('owner', 'admin') and id <> p_member) then
    raise exception 'last_admin';
  end if;
  if exists (select 1 from public.expenses where paid_by = p_member or created_by = p_member)
     or exists (select 1 from public.expense_shares where member_id = p_member)
     or exists (select 1 from public.payments
                where from_member = p_member or to_member = p_member or created_by = p_member) then
    raise exception 'has_money_records';
  end if;
  -- Cascades: device links, secrets, pledges, votes, reads, poll votes, personal items, push subs.
  delete from public.members where id = p_member;
  perform public._bump(v_target.trip_id);
end $$;

create or replace function public.leave_trip(p_trip uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_me uuid := public._my_member(p_trip);
  v_role text;
begin
  if v_me is null then
    raise exception 'forbidden';
  end if;
  perform 1 from public.trips where id = p_trip for update;
  select role into v_role from public.members where id = v_me;
  -- The last device of an owner/admin may leave only if another admin remains.
  if v_role in ('owner', 'admin')
     and not exists (select 1 from public.member_users where member_id = v_me and user_id <> v_uid)
     and not exists (select 1 from public.members
                     where trip_id = p_trip and role in ('owner', 'admin') and id <> v_me) then
    raise exception 'last_admin';
  end if;

  delete from public.member_users where user_id = v_uid and trip_id = p_trip;
  delete from public.push_subscriptions where user_id = v_uid and trip_id = p_trip;
  if not exists (select 1 from public.member_users where member_id = v_me) then
    perform public._release_member(v_me);        -- unclaimed, code revoked, powers handed over
  end if;
  perform public._bump(p_trip);
end $$;

create or replace function public.vote_admin(p_candidate uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_trip uuid;
  v_me uuid;
begin
  select trip_id into v_trip from public.members where id = p_candidate;
  if not found then
    raise exception 'not_found';
  end if;
  v_me := public._my_member(v_trip);
  if v_me is null then
    raise exception 'forbidden';
  end if;
  if p_on is null then
    raise exception 'invalid_input';
  end if;
  if p_on then
    insert into public.admin_votes (trip_id, voter_id, candidate_id)
    values (v_trip, v_me, p_candidate)
    on conflict (voter_id, candidate_id) do nothing;
  else
    delete from public.admin_votes where voter_id = v_me and candidate_id = p_candidate;
  end if;
  perform public._bump(v_trip);
end $$;


-- -------------------------------------------------------------------------------------
-- 6. RPCs — categories & items
-- -------------------------------------------------------------------------------------

create or replace function public.upsert_category(p_trip uuid, p_cat jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_id uuid;
  r public.categories;
begin
  if not public._is_admin(p_trip) then
    raise exception 'forbidden';
  end if;
  if p_cat is null or jsonb_typeof(p_cat) <> 'object' then
    raise exception 'invalid_input';
  end if;
  v_id := public._j_uuid(p_cat, 'id');
  if v_id is not null then
    select * into r from public.categories where id = v_id and trip_id = p_trip for update;
    if not found then
      raise exception 'not_found';
    end if;
  else
    if (select count(*) from public.categories where trip_id = p_trip) >= 100 then
      raise exception 'limit_reached';
    end if;
    r.emoji := '📦';
    r.sort := coalesce((select max(sort) from public.categories where trip_id = p_trip), 0) + 1;
  end if;

  if p_cat ? 'name' or v_id is null then
    r.name := public._req(public._j_text(p_cat, 'name', 40));
  end if;
  if p_cat ? 'emoji' then
    r.emoji := public._req(public._j_text(p_cat, 'emoji', 16));
  end if;
  if p_cat ? 'sort' then
    r.sort := coalesce(public._j_int(p_cat, 'sort'), 0);
  end if;
  if p_cat ? 'default_buyer_id' then
    r.default_buyer_id := public._j_uuid(p_cat, 'default_buyer_id');
    if r.default_buyer_id is not null then
      perform public._trip_member(p_trip, r.default_buyer_id);
    end if;
  end if;
  if p_cat ? 'note' then
    r.note := public._j_text(p_cat, 'note', 200);
  end if;

  if v_id is null then
    insert into public.categories (trip_id, name, emoji, sort, default_buyer_id, note)
    values (p_trip, r.name, r.emoji, r.sort, r.default_buyer_id, r.note)
    returning id into v_id;
  else
    update public.categories
       set name = r.name, emoji = r.emoji, sort = r.sort,
           default_buyer_id = r.default_buyer_id, note = r.note
     where id = v_id;
  end if;
  perform public._bump(p_trip);
  return v_id;
end $$;

create or replace function public.delete_category(p_category uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_trip uuid;
begin
  select trip_id into v_trip from public.categories where id = p_category;
  if not found then
    raise exception 'not_found';
  end if;
  if not public._is_admin(v_trip) then
    raise exception 'forbidden';
  end if;
  delete from public.categories where id = p_category;   -- items keep, category_id -> null
  perform public._bump(v_trip);
end $$;

create or replace function public.add_item(p_trip uuid, p_item jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_me uuid := public._my_member(p_trip);
  v_item public.items;
  v_id uuid;
begin
  if v_me is null then
    raise exception 'forbidden';
  end if;
  if p_item is null or jsonb_typeof(p_item) <> 'object' then
    raise exception 'invalid_input';
  end if;
  if (select count(*) from public.items where trip_id = p_trip) >= 600 then
    raise exception 'limit_reached';
  end if;
  v_id := public._insert_item(p_trip, v_me, public._is_admin(p_trip), p_item,
                              public._trip_category(p_trip, public._j_uuid(p_item, 'category_id')));
  select * into v_item from public.items where id = v_id;
  if v_item.status = 'proposed' then
    perform public._notify(p_trip, 'הצעה חדשה: ' || v_item.title,
                           (select display_name from public.members where id = v_me)
                             || ' הציע/ה להוסיף לרשימה — מחכה לאישור',
                           public._admin_ids(p_trip, v_me),
                           '#/t/' || p_trip || '/lists?item=' || v_id);
  end if;
  perform public._bump(p_trip);
  return v_id;
end $$;

-- Bulk import (e.g. a pasted WhatsApp list). Elements are add_item objects that may carry
-- category_name / category_emoji instead of category_id: admins create unknown categories,
-- other members get a match by name or no category. One summary notification for proposals.
create or replace function public.add_items_bulk(p_trip uuid, p_items jsonb) returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_me uuid := public._my_member(p_trip);
  v_admin boolean;
  v_count int;
  e jsonb;
  v_cat uuid;
  v_cat_name text;
  v_id uuid;
  v_status text;
  v_title text;
  v_proposed text[] := '{}';
  v_proposed_id uuid;
begin
  if v_me is null then
    raise exception 'forbidden';
  end if;
  v_admin := public._is_admin(p_trip);
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_input';
  end if;
  v_count := jsonb_array_length(p_items);
  if v_count = 0 then
    return 0;
  end if;
  if v_count > 150
     or (select count(*) from public.items where trip_id = p_trip) + v_count > 600 then
    raise exception 'limit_reached';
  end if;

  for e in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(e) <> 'object' then
      raise exception 'invalid_input';
    end if;
    v_cat := public._j_uuid(e, 'category_id');
    if v_cat is not null then
      perform public._trip_category(p_trip, v_cat);
    else
      v_cat_name := public._j_text(e, 'category_name', 40);
      if v_cat_name is not null then
        select id into v_cat from public.categories
        where trip_id = p_trip and lower(name) = lower(v_cat_name)
        order by sort, created_at limit 1;
        if v_cat is null and v_admin then
          if (select count(*) from public.categories where trip_id = p_trip) >= 100 then
            raise exception 'limit_reached';
          end if;
          insert into public.categories (trip_id, name, emoji, sort)
          values (p_trip, v_cat_name,
                  coalesce(public._j_text(e, 'category_emoji', 16), '📦'),
                  coalesce((select max(sort) from public.categories where trip_id = p_trip), 0) + 1)
          returning id into v_cat;
        end if;
      end if;
    end if;

    v_id := public._insert_item(p_trip, v_me, v_admin, e, v_cat);
    select status, title into v_status, v_title from public.items where id = v_id;
    if v_status = 'proposed' then
      v_proposed := v_proposed || v_title;
      v_proposed_id := v_id;
    end if;
  end loop;

  if cardinality(v_proposed) = 1 then
    perform public._notify(p_trip, 'הצעה חדשה: ' || v_proposed[1],
                           (select display_name from public.members where id = v_me)
                             || ' הציע/ה להוסיף לרשימה — מחכה לאישור',
                           public._admin_ids(p_trip, v_me),
                           '#/t/' || p_trip || '/lists?item=' || v_proposed_id);
  elsif cardinality(v_proposed) > 1 then
    perform public._notify(p_trip, cardinality(v_proposed) || ' הצעות חדשות מחכות לאישור',
                           array_to_string(v_proposed, ' · '),
                           public._admin_ids(p_trip, v_me),
                           '#/t/' || p_trip || '/lists');
  end if;
  perform public._bump(p_trip);
  return v_count;
end $$;

create or replace function public.update_item(p_item uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.items;
  v_me uuid;
begin
  select * into r from public.items where id = p_item for update;
  if not found then
    raise exception 'not_found';
  end if;
  v_me := public._my_member(r.trip_id);
  if v_me is null then
    raise exception 'forbidden';
  end if;
  if not (public._is_admin(r.trip_id) or (r.status = 'proposed' and r.created_by = v_me)) then
    raise exception 'forbidden';
  end if;
  if p_patch is null then
    return;
  end if;
  if jsonb_typeof(p_patch) <> 'object' then
    raise exception 'invalid_input';
  end if;

  if p_patch ? 'category_id' then
    r.category_id := public._trip_category(r.trip_id, public._j_uuid(p_patch, 'category_id'));
  end if;
  if p_patch ? 'title' then
    r.title := public._req(public._j_text(p_patch, 'title', 120));
  end if;
  if p_patch ? 'note' then
    r.note := public._j_text(p_patch, 'note', 500);
  end if;
  if p_patch ? 'type' then
    r.type := public._req(public._j_text(p_patch, 'type', 10));
    if r.type not in ('buy', 'bring', 'each', 'task') then
      raise exception 'invalid_input';
    end if;
  end if;
  if p_patch ? 'qty' then
    r.qty := public._qty(public._j_num(p_patch, 'qty'));
  end if;
  if p_patch ? 'unit' then
    r.unit := public._j_text(p_patch, 'unit', 20);
  end if;
  if p_patch ? 'per_person' then
    r.per_person := coalesce(public._j_bool(p_patch, 'per_person'), false);
  end if;
  if p_patch ? 'needed' then
    r.needed := public._req(public._j_int(p_patch, 'needed'));
    if r.needed not between 1 and 200 then
      raise exception 'invalid_input';
    end if;
  end if;
  if p_patch ? 'sort' then
    r.sort := coalesce(public._j_int(p_patch, 'sort'), 0);
  end if;

  update public.items
     set category_id = r.category_id, title = r.title, note = r.note, type = r.type,
         qty = r.qty, unit = r.unit, per_person = r.per_person, needed = r.needed,
         sort = r.sort, updated_at = now()
   where id = p_item;
  perform public._bump(r.trip_id);
end $$;

create or replace function public.review_item(
  p_item uuid, p_approve boolean, p_reason text default null
) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.items;
  v_me uuid;
  v_reason text;
begin
  select * into r from public.items where id = p_item for update;
  if not found then
    raise exception 'not_found';
  end if;
  if not public._is_admin(r.trip_id) then
    raise exception 'forbidden';
  end if;
  if p_approve is null then
    raise exception 'invalid_input';
  end if;
  if r.status <> 'proposed' then
    raise exception 'not_allowed_state';
  end if;
  v_me := public._my_member(r.trip_id);
  v_reason := public._clean(p_reason, 300);

  if p_approve then
    update public.items
       set status = 'active', approved_by = v_me, reject_reason = null, updated_at = now()
     where id = p_item;
  else
    update public.items
       set status = 'rejected', approved_by = null, reject_reason = v_reason, updated_at = now()
     where id = p_item;
  end if;

  if r.created_by is not null and r.created_by <> v_me then
    perform public._notify(
      r.trip_id,
      case when p_approve then 'ההצעה אושרה ✅: ' || r.title else 'ההצעה נדחתה: ' || r.title end,
      case when p_approve then null else v_reason end,
      array[r.created_by],
      '#/t/' || r.trip_id || '/lists?item=' || r.id);
  end if;
  perform public._bump(r.trip_id);
end $$;

create or replace function public.delete_item(p_item uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.items;
begin
  select * into r from public.items where id = p_item;
  if not found then
    raise exception 'not_found';
  end if;
  if not (public._is_admin(r.trip_id)
          or (r.status in ('proposed', 'rejected') and r.created_by = public._my_member(r.trip_id))) then
    raise exception 'forbidden';
  end if;
  delete from public.items where id = p_item;
  perform public._bump(r.trip_id);
end $$;

-- "I bring / buy / do this". qty <= 0 removes my pledge.
create or replace function public.pledge(p_item uuid, p_qty int default 1) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.items;
  v_me uuid;
  v_qty int := coalesce(p_qty, 1);
begin
  select * into r from public.items where id = p_item;
  if not found then
    raise exception 'not_found';
  end if;
  v_me := public._my_member(r.trip_id);
  if v_me is null then
    raise exception 'forbidden';
  end if;
  if r.type = 'each' or v_qty > 200 then
    raise exception 'invalid_input';
  end if;

  if v_qty <= 0 then
    delete from public.pledges where item_id = p_item and member_id = v_me;
  else
    if not (r.status = 'active' or (r.status = 'proposed' and r.created_by = v_me)) then
      raise exception 'not_allowed_state';
    end if;
    insert into public.pledges (trip_id, item_id, member_id, qty)
    values (r.trip_id, p_item, v_me, v_qty)
    on conflict (item_id, member_id) do update set qty = excluded.qty;
  end if;
  perform public._bump(r.trip_id);
end $$;

-- Admin assigns an item to a member. qty <= 0 removes that member's pledge.
create or replace function public.assign(p_item uuid, p_member uuid, p_qty int default 1) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.items;
  v_me uuid;
  v_qty int := coalesce(p_qty, 1);
begin
  select * into r from public.items where id = p_item;
  if not found then
    raise exception 'not_found';
  end if;
  if not public._is_admin(r.trip_id) then
    raise exception 'forbidden';
  end if;
  if not exists (select 1 from public.members where id = p_member and trip_id = r.trip_id) then
    raise exception 'not_found';
  end if;
  if r.type = 'each' or v_qty > 200 then
    raise exception 'invalid_input';
  end if;
  v_me := public._my_member(r.trip_id);

  if v_qty <= 0 then
    delete from public.pledges where item_id = p_item and member_id = p_member;
  else
    if r.status = 'rejected' then
      raise exception 'not_allowed_state';
    end if;
    insert into public.pledges (trip_id, item_id, member_id, qty, assigned_by)
    values (r.trip_id, p_item, p_member, v_qty, v_me)
    on conflict (item_id, member_id) do update
      set qty = excluded.qty, assigned_by = excluded.assigned_by;
    if p_member <> v_me then
      perform public._notify(r.trip_id, 'שובצת: ' || r.title, null, array[p_member],
                             '#/t/' || r.trip_id || '/lists?item=' || r.id);
    end if;
  end if;
  perform public._bump(r.trip_id);
end $$;

-- My pledge packed / bought. For "each" items the pledge row is created on first use.
create or replace function public.set_pledge_done(p_item uuid, p_done boolean) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.items;
  v_me uuid;
begin
  select * into r from public.items where id = p_item;
  if not found then
    raise exception 'not_found';
  end if;
  v_me := public._my_member(r.trip_id);
  if v_me is null then
    raise exception 'forbidden';
  end if;
  if p_done is null then
    raise exception 'invalid_input';
  end if;

  if r.type = 'each' then
    if r.status <> 'active' then
      raise exception 'not_allowed_state';
    end if;
    insert into public.pledges (trip_id, item_id, member_id, qty, done)
    values (r.trip_id, p_item, v_me, 1, p_done)
    on conflict (item_id, member_id) do update set done = excluded.done;
  else
    update public.pledges set done = p_done where item_id = p_item and member_id = v_me;
    if not found then
      raise exception 'not_found';
    end if;
  end if;
  perform public._bump(r.trip_id);
end $$;

-- Item bought (buy) / completed (task). Pledgers of the item or admins.
create or replace function public.set_item_done(p_item uuid, p_done boolean) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.items;
  v_me uuid;
begin
  select * into r from public.items where id = p_item for update;
  if not found then
    raise exception 'not_found';
  end if;
  v_me := public._my_member(r.trip_id);
  if v_me is null then
    raise exception 'forbidden';
  end if;
  if r.type not in ('buy', 'task') or p_done is null then
    raise exception 'invalid_input';
  end if;
  if not (public._is_admin(r.trip_id)
          or exists (select 1 from public.pledges where item_id = p_item and member_id = v_me)) then
    raise exception 'forbidden';
  end if;
  update public.items
     set done = p_done, done_at = case when p_done then now() end, updated_at = now()
   where id = p_item;
  perform public._bump(r.trip_id);
end $$;


-- -------------------------------------------------------------------------------------
-- 7. RPCs — personal packing list (private to the member)
-- -------------------------------------------------------------------------------------

create or replace function public.add_personal(p_trip uuid, p_title text) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_me uuid := public._my_member(p_trip);
  v_id uuid;
begin
  if v_me is null then
    raise exception 'forbidden';
  end if;
  if (select count(*) from public.personal_items where member_id = v_me) >= 100 then
    raise exception 'limit_reached';
  end if;
  insert into public.personal_items (trip_id, member_id, title, sort)
  values (p_trip, v_me, public._req(public._clean(p_title, 80)),
          coalesce((select max(sort) from public.personal_items where member_id = v_me), 0) + 1)
  returning id into v_id;
  perform public._bump(p_trip);
  return v_id;
end $$;

-- SPEC §6 personal gear template; titles I already have are skipped. Returns rows added.
create or replace function public.add_personal_template(p_trip uuid) returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_me uuid := public._my_member(p_trip);
  v_missing text[];
  v_sort int;
begin
  if v_me is null then
    raise exception 'forbidden';
  end if;
  select coalesce(array_agg(t.title order by t.ord), '{}') into v_missing
  from unnest(array[
    'אוהל', 'מזרן / מזרן מתנפח + משאבה', 'שק שינה / שמיכה', 'כרית', 'מגבת', 'בגד ים',
    'כפכפים', 'קרם הגנה', 'כובע', 'פנס ראש / פנס', 'סוללה ניידת + מטען',
    'בגדים חמים ללילה', 'ביגוד להחלפה', 'מברשת שיניים ומשחה', 'תרופות אישיות',
    'בקבוק מים אישי', 'תעודה מזהה / כרטיסי כניסה'
  ]) with ordinality as t(title, ord)
  where not exists (
    select 1 from public.personal_items pi where pi.member_id = v_me and pi.title = t.title);

  if cardinality(v_missing) = 0 then
    return 0;
  end if;
  if (select count(*) from public.personal_items where member_id = v_me)
     + cardinality(v_missing) > 100 then
    raise exception 'limit_reached';
  end if;
  v_sort := coalesce((select max(sort) from public.personal_items where member_id = v_me), 0);
  insert into public.personal_items (trip_id, member_id, title, sort)
  select p_trip, v_me, t.title, v_sort + t.ord
  from unnest(v_missing) with ordinality as t(title, ord);
  perform public._bump(p_trip);
  return cardinality(v_missing);
end $$;

create or replace function public.update_personal(p_id uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.personal_items;
begin
  select * into r from public.personal_items where id = p_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  if public._my_member(r.trip_id) is distinct from r.member_id then
    raise exception 'forbidden';
  end if;
  if p_patch is null then
    return;
  end if;
  if jsonb_typeof(p_patch) <> 'object' then
    raise exception 'invalid_input';
  end if;
  if p_patch ? 'title' then
    r.title := public._req(public._j_text(p_patch, 'title', 80));
  end if;
  if p_patch ? 'done' then
    r.done := public._req(public._j_bool(p_patch, 'done'));
  end if;
  if p_patch ? 'sort' then
    r.sort := coalesce(public._j_int(p_patch, 'sort'), 0);
  end if;
  update public.personal_items set title = r.title, done = r.done, sort = r.sort where id = p_id;
  perform public._bump(r.trip_id);
end $$;

create or replace function public.delete_personal(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.personal_items;
begin
  select * into r from public.personal_items where id = p_id;
  if not found then
    raise exception 'not_found';
  end if;
  if public._my_member(r.trip_id) is distinct from r.member_id then
    raise exception 'forbidden';
  end if;
  delete from public.personal_items where id = p_id;
  perform public._bump(r.trip_id);
end $$;


-- -------------------------------------------------------------------------------------
-- 8. RPCs — money
-- -------------------------------------------------------------------------------------

create or replace function public.add_expense(p_trip uuid, p_exp jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_me uuid := public._my_member(p_trip);
  v_paid_by uuid;
  v_mode text;
  v_id uuid;
begin
  if v_me is null then
    raise exception 'forbidden';
  end if;
  if p_exp is null or jsonb_typeof(p_exp) <> 'object' then
    raise exception 'invalid_input';
  end if;
  if (select count(*) from public.expenses where trip_id = p_trip) >= 300 then
    raise exception 'limit_reached';
  end if;
  v_paid_by := coalesce(public._j_uuid(p_exp, 'paid_by'), v_me);
  if v_paid_by <> v_me and not public._is_admin(p_trip) then
    raise exception 'forbidden';
  end if;
  perform public._trip_member(p_trip, v_paid_by);
  v_mode := coalesce(public._j_text(p_exp, 'split_mode', 10), 'all');
  if v_mode not in ('all', 'members') then
    raise exception 'invalid_input';
  end if;

  insert into public.expenses (trip_id, title, amount, paid_by, category_id, note, split_mode,
                               created_by, spent_on)
  values (p_trip,
          public._req(public._j_text(p_exp, 'title', 80)),
          public._money(public._j_num(p_exp, 'amount')),
          v_paid_by,
          public._trip_category(p_trip, public._j_uuid(p_exp, 'category_id')),
          public._j_text(p_exp, 'note', 500),
          v_mode, v_me,
          coalesce(public._j_date(p_exp, 'spent_on'), public._il_today()))
  returning id into v_id;

  if v_mode = 'members' then
    perform public._set_expense_shares(v_id, p_trip, p_exp -> 'members');
  end if;
  perform public._bump(p_trip);
  return v_id;
end $$;

create or replace function public.update_expense(p_expense uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.expenses;
  v_old_paid_by uuid;
  v_me uuid;
  v_admin boolean;
begin
  select * into r from public.expenses where id = p_expense for update;
  if not found then
    raise exception 'not_found';
  end if;
  v_me := public._my_member(r.trip_id);
  if v_me is null then
    raise exception 'forbidden';
  end if;
  v_admin := public._is_admin(r.trip_id);
  if not (v_admin or r.created_by = v_me or r.paid_by = v_me) then
    raise exception 'forbidden';
  end if;
  if p_patch is null then
    return;
  end if;
  if jsonb_typeof(p_patch) <> 'object' then
    raise exception 'invalid_input';
  end if;
  v_old_paid_by := r.paid_by;

  if p_patch ? 'title' then
    r.title := public._req(public._j_text(p_patch, 'title', 80));
  end if;
  if p_patch ? 'amount' then
    r.amount := public._money(public._j_num(p_patch, 'amount'));
  end if;
  if p_patch ? 'paid_by' then
    r.paid_by := public._trip_member(r.trip_id, public._req(public._j_uuid(p_patch, 'paid_by')));
    if r.paid_by <> v_me and r.paid_by <> v_old_paid_by and not v_admin then
      raise exception 'forbidden';
    end if;
  end if;
  if p_patch ? 'category_id' then
    r.category_id := public._trip_category(r.trip_id, public._j_uuid(p_patch, 'category_id'));
  end if;
  if p_patch ? 'note' then
    r.note := public._j_text(p_patch, 'note', 500);
  end if;
  if p_patch ? 'spent_on' then
    r.spent_on := coalesce(public._j_date(p_patch, 'spent_on'), public._il_today());
  end if;
  if p_patch ? 'split_mode' then
    r.split_mode := public._req(public._j_text(p_patch, 'split_mode', 10));
    if r.split_mode not in ('all', 'members') then
      raise exception 'invalid_input';
    end if;
  end if;

  update public.expenses
     set title = r.title, amount = r.amount, paid_by = r.paid_by, category_id = r.category_id,
         note = r.note, spent_on = r.spent_on, split_mode = r.split_mode
   where id = p_expense;

  if r.split_mode = 'all' then
    delete from public.expense_shares where expense_id = p_expense;
  elsif p_patch ? 'members' then
    perform public._set_expense_shares(p_expense, r.trip_id, p_patch -> 'members');
  elsif not exists (select 1 from public.expense_shares where expense_id = p_expense) then
    raise exception 'invalid_input';
  end if;
  perform public._bump(r.trip_id);
end $$;

create or replace function public.delete_expense(p_expense uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.expenses;
  v_me uuid;
begin
  select * into r from public.expenses where id = p_expense;
  if not found then
    raise exception 'not_found';
  end if;
  v_me := public._my_member(r.trip_id);
  if v_me is null
     or not (public._is_admin(r.trip_id) or r.created_by = v_me or r.paid_by = v_me) then
    raise exception 'forbidden';
  end if;
  delete from public.expenses where id = p_expense;
  perform public._bump(r.trip_id);
end $$;

-- Records a transfer between members. The payer records it ("sent"); the recipient may
-- record it too (then it is "confirmed"); admins may record any transfer.
create or replace function public.add_payment(p_trip uuid, p_pay jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_me uuid := public._my_member(p_trip);
  v_from uuid;
  v_to uuid;
  v_amount numeric;
  v_method text;
  v_confirmed boolean;
  v_id uuid;
begin
  if v_me is null then
    raise exception 'forbidden';
  end if;
  if p_pay is null or jsonb_typeof(p_pay) <> 'object' then
    raise exception 'invalid_input';
  end if;
  v_from := coalesce(public._j_uuid(p_pay, 'from_member'), v_me);
  v_to := public._req(public._j_uuid(p_pay, 'to_member'));
  if v_from = v_to then
    raise exception 'invalid_input';
  end if;
  perform public._trip_member(p_trip, v_from);
  perform public._trip_member(p_trip, v_to);
  if v_from <> v_me and v_to <> v_me and not public._is_admin(p_trip) then
    raise exception 'forbidden';
  end if;
  v_amount := public._money(public._j_num(p_pay, 'amount'));
  v_method := coalesce(public._j_text(p_pay, 'method', 10), 'bit');
  if v_method not in ('bit', 'paybox', 'cash', 'transfer', 'other') then
    raise exception 'invalid_input';
  end if;
  v_confirmed := v_to = v_me;

  insert into public.payments (trip_id, from_member, to_member, amount, method, note, status,
                               created_by, confirmed_at)
  values (p_trip, v_from, v_to, v_amount, v_method, public._j_text(p_pay, 'note', 200),
          case when v_confirmed then 'confirmed' else 'sent' end, v_me,
          case when v_confirmed then now() end)
  returning id into v_id;

  if v_confirmed then
    perform public._notify(p_trip,
      (select display_name from public.members where id = v_to)
        || ' אישר/ה שקיבל/ה ' || public._fmt_money(v_amount) || ' ✅',
      null, array[v_from], '#/t/' || p_trip || '/money');
  else
    perform public._notify(p_trip,
      (select display_name from public.members where id = v_from)
        || ' סימן/ה שהעביר/ה לך ' || public._fmt_money(v_amount),
      null, array[v_to], '#/t/' || p_trip || '/money');
  end if;
  perform public._bump(p_trip);
  return v_id;
end $$;

create or replace function public.confirm_payment(p_payment uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.payments;
  v_me uuid;
begin
  select * into r from public.payments where id = p_payment for update;
  if not found then
    raise exception 'not_found';
  end if;
  v_me := public._my_member(r.trip_id);
  if v_me is null or not (r.to_member = v_me or public._is_admin(r.trip_id)) then
    raise exception 'forbidden';
  end if;
  if r.status = 'confirmed' then
    return;                                 -- idempotent (double taps)
  end if;
  update public.payments set status = 'confirmed', confirmed_at = now() where id = p_payment;
  if r.from_member <> v_me then
    perform public._notify(r.trip_id,
      (select display_name from public.members where id = r.to_member)
        || ' אישר/ה שקיבל/ה ' || public._fmt_money(r.amount) || ' ✅',
      null, array[r.from_member], '#/t/' || r.trip_id || '/money');
  end if;
  perform public._bump(r.trip_id);
end $$;

create or replace function public.delete_payment(p_payment uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.payments;
  v_me uuid;
begin
  select * into r from public.payments where id = p_payment;
  if not found then
    raise exception 'not_found';
  end if;
  v_me := public._my_member(r.trip_id);
  if v_me is null then
    raise exception 'forbidden';
  end if;
  if not public._is_admin(r.trip_id) then
    if r.created_by is distinct from v_me then
      raise exception 'forbidden';
    end if;
    if r.status = 'confirmed' then
      raise exception 'not_allowed_state';
    end if;
  end if;
  delete from public.payments where id = p_payment;
  perform public._bump(r.trip_id);
end $$;


-- -------------------------------------------------------------------------------------
-- 9. RPCs — announcements, reads, polls, push
-- -------------------------------------------------------------------------------------

create or replace function public.send_announcement(
  p_trip uuid, p_title text, p_body text, p_audience uuid[] default null,
  p_urgent boolean default false
) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_audience uuid[];
  v_id uuid;
begin
  if not public._is_admin(p_trip) then
    raise exception 'forbidden';
  end if;
  if p_audience is not null then
    select array_agg(distinct a) into v_audience from unnest(p_audience) a where a is not null;
    if v_audience is null or exists (
      select 1 from unnest(v_audience) a
      where not exists (select 1 from public.members m where m.id = a and m.trip_id = p_trip)) then
      raise exception 'invalid_input';
    end if;
  end if;
  insert into public.notifications (trip_id, kind, title, body, audience, author_member, urgent)
  values (p_trip, 'announcement', public._req(public._clean(p_title, 80)),
          public._clean(p_body, 2000), v_audience, public._my_member(p_trip),
          coalesce(p_urgent, false))
  returning id into v_id;
  perform public._bump(p_trip);
  return v_id;
end $$;

create or replace function public.delete_notification(p_notification uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.notifications;
  v_me uuid;
begin
  select * into r from public.notifications where id = p_notification;
  if not found then
    raise exception 'not_found';
  end if;
  v_me := public._my_member(r.trip_id);
  if v_me is null or not (public._is_admin(r.trip_id) or r.author_member = v_me) then
    raise exception 'forbidden';
  end if;
  delete from public.notifications where id = p_notification;
  perform public._bump(r.trip_id);
end $$;

create or replace function public.mark_read(p_trip uuid, p_ids uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_me uuid := public._my_member(p_trip);
  v_admin boolean;
  v_added int;
begin
  if v_me is null then
    raise exception 'forbidden';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    return;
  end if;
  v_admin := public._is_admin(p_trip);
  insert into public.notification_reads (notification_id, trip_id, member_id)
  select n.id, n.trip_id, v_me
  from public.notifications n
  where n.id = any (p_ids) and n.trip_id = p_trip
    and public._notif_visible(n.audience, n.author_member, n.kind, v_me, v_admin)
  on conflict (notification_id, member_id) do nothing;
  get diagnostics v_added = row_count;
  if v_added > 0 then
    perform public._bump(p_trip);
  end if;
end $$;

create or replace function public.create_poll(
  p_trip uuid, p_question text, p_options text[], p_multi boolean default false
) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_me uuid := public._my_member(p_trip);
  v_labels text[];
  v_id uuid;
begin
  if v_me is null then
    raise exception 'forbidden';
  end if;
  select coalesce(array_agg(l.label order by l.ord), '{}') into v_labels
  from (select public._clean(o, 80) as label, ord
        from unnest(coalesce(p_options, '{}')) with ordinality as u(o, ord)) l
  where l.label is not null;
  if cardinality(v_labels) not between 2 and 8 then
    raise exception 'invalid_input';
  end if;
  insert into public.polls (trip_id, question, options, multi, created_by)
  values (p_trip, public._req(public._clean(p_question, 140)),
          (select jsonb_agg(jsonb_build_object('id', 'o' || ord, 'label', label) order by ord)
           from unnest(v_labels) with ordinality as u(label, ord)),
          coalesce(p_multi, false), v_me)
  returning id into v_id;
  perform public._bump(p_trip);
  return v_id;
end $$;

-- Replaces my votes in a poll; an empty list clears them.
create or replace function public.vote_poll(p_poll uuid, p_option_ids text[]) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.polls;
  v_me uuid;
  v_ids text[];
begin
  select * into r from public.polls where id = p_poll;
  if not found then
    raise exception 'not_found';
  end if;
  v_me := public._my_member(r.trip_id);
  if v_me is null then
    raise exception 'forbidden';
  end if;
  if r.closed then
    raise exception 'not_allowed_state';
  end if;
  select coalesce(array_agg(distinct o), '{}') into v_ids
  from unnest(coalesce(p_option_ids, '{}')) o where o is not null;
  if (not r.multi and cardinality(v_ids) > 1)
     or exists (select 1 from unnest(v_ids) o
                where not exists (select 1 from jsonb_array_elements(r.options) x
                                  where x ->> 'id' = o)) then
    raise exception 'invalid_input';
  end if;
  delete from public.poll_votes where poll_id = p_poll and member_id = v_me;
  insert into public.poll_votes (poll_id, trip_id, member_id, option_id)
  select p_poll, r.trip_id, v_me, o from unnest(v_ids) o;
  perform public._bump(r.trip_id);
end $$;

create or replace function public.close_poll(p_poll uuid, p_closed boolean) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.polls;
  v_me uuid;
begin
  select * into r from public.polls where id = p_poll;
  if not found then
    raise exception 'not_found';
  end if;
  v_me := public._my_member(r.trip_id);
  if v_me is null or not (public._is_admin(r.trip_id) or r.created_by = v_me) then
    raise exception 'forbidden';
  end if;
  if p_closed is null then
    raise exception 'invalid_input';
  end if;
  update public.polls set closed = p_closed where id = p_poll;
  perform public._bump(r.trip_id);
end $$;

create or replace function public.delete_poll(p_poll uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  r public.polls;
  v_me uuid;
begin
  select * into r from public.polls where id = p_poll;
  if not found then
    raise exception 'not_found';
  end if;
  v_me := public._my_member(r.trip_id);
  if v_me is null or not (public._is_admin(r.trip_id) or r.created_by = v_me) then
    raise exception 'forbidden';
  end if;
  delete from public.polls where id = p_poll;
  perform public._bump(r.trip_id);
end $$;

-- Upsert by endpoint (a browser has one endpoint; the latest trip/member wins).
create or replace function public.save_push_subscription(p_trip uuid, p_sub jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
  v_me uuid := public._my_member(p_trip);
  v_endpoint text;
begin
  if v_me is null then
    raise exception 'forbidden';
  end if;
  if p_sub is null or jsonb_typeof(p_sub) <> 'object'
     or jsonb_typeof(p_sub -> 'keys') is distinct from 'object' then
    raise exception 'invalid_input';
  end if;
  v_endpoint := public._req(public._j_text(p_sub, 'endpoint', 1000));
  if v_endpoint !~* '^https://' then
    raise exception 'invalid_input';
  end if;
  insert into public.push_subscriptions (trip_id, member_id, user_id, endpoint, p256dh, auth)
  values (p_trip, v_me, v_uid, v_endpoint,
          public._req(public._j_text(p_sub -> 'keys', 'p256dh', 200)),
          public._req(public._j_text(p_sub -> 'keys', 'auth', 100)))
  on conflict (endpoint) do update
    set trip_id = excluded.trip_id, member_id = excluded.member_id, user_id = excluded.user_id,
        p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
end $$;

create or replace function public.delete_push_subscription(p_endpoint text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public._uid();
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = v_uid;
end $$;


-- -------------------------------------------------------------------------------------
-- 10. Privileges
-- -------------------------------------------------------------------------------------

-- The project was created with "automatically expose new tables" off, so nothing is granted
-- by default: signed-in clients need USAGE on the schema to reach the tables and RPCs below.
grant usage on schema public to authenticated;

-- Tables: clients may only read (through RLS); nothing at all for anon.
revoke all on table
  public.trips, public.members, public.member_secrets, public.member_users, public.categories,
  public.items, public.pledges, public.expenses, public.expense_shares, public.payments,
  public.notifications, public.notification_reads, public.admin_votes, public.polls,
  public.poll_votes, public.personal_items, public.push_subscriptions
from public, anon, authenticated;

grant select on table
  public.trips, public.members, public.member_users, public.categories, public.items,
  public.pledges, public.expenses, public.expense_shares, public.payments, public.notifications,
  public.notification_reads, public.admin_votes, public.polls, public.poll_votes,
  public.personal_items
to authenticated;

-- Functions: nothing by default, then the RPC list (+ the RLS helpers) to authenticated only.
revoke all on all functions in schema public from public, anon, authenticated;

grant execute on function
  public._my_member(uuid), public._is_member(uuid), public._is_admin(uuid),
  public.my_trips(),
  public.create_trip(jsonb, jsonb),
  public.preview_invite(text),
  public.join_trip(text, uuid, jsonb),
  public.link_device(text),
  public.get_device_code(uuid),
  public.get_trip_snapshot(uuid),
  public.update_trip(uuid, jsonb),
  public.rotate_invite(uuid),
  public.update_member(uuid, jsonb),
  public.create_member(uuid, jsonb),
  public.set_role(uuid, text),
  public.remove_member(uuid),
  public.leave_trip(uuid),
  public.vote_admin(uuid, boolean),
  public.upsert_category(uuid, jsonb),
  public.delete_category(uuid),
  public.add_item(uuid, jsonb),
  public.add_items_bulk(uuid, jsonb),
  public.update_item(uuid, jsonb),
  public.review_item(uuid, boolean, text),
  public.delete_item(uuid),
  public.pledge(uuid, int),
  public.assign(uuid, uuid, int),
  public.set_pledge_done(uuid, boolean),
  public.set_item_done(uuid, boolean),
  public.add_personal(uuid, text),
  public.add_personal_template(uuid),
  public.update_personal(uuid, jsonb),
  public.delete_personal(uuid),
  public.add_expense(uuid, jsonb),
  public.update_expense(uuid, jsonb),
  public.delete_expense(uuid),
  public.add_payment(uuid, jsonb),
  public.confirm_payment(uuid),
  public.delete_payment(uuid),
  public.send_announcement(uuid, text, text, uuid[], boolean),
  public.delete_notification(uuid),
  public.mark_read(uuid, uuid[]),
  public.create_poll(uuid, text, text[], boolean),
  public.vote_poll(uuid, text[]),
  public.close_poll(uuid, boolean),
  public.delete_poll(uuid),
  public.save_push_subscription(uuid, jsonb),
  public.delete_push_subscription(text)
to authenticated;


-- -------------------------------------------------------------------------------------
-- 11. Realtime: only the trips row (clients refetch the snapshot when rev changes)
-- -------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime for table public.trips;
  elsif not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'trips') then
    alter publication supabase_realtime add table public.trips;
  end if;
end $$;
