-- =====================================================================
--  Scodato's Treasury — Supabase setup
--  Paste this whole file into Supabase → SQL Editor → New query → Run.
--  BEFORE running: change the password on the LAST LINE of this file.
--  Safe to run again later (it won't delete your data).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- tables ----------
create table if not exists public.trove_items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  rarity      text not null default 'legendary',
  qty         int  not null default 0 check (qty >= 0),
  icon        text,
  updated_at  timestamptz not null default now()
);

create table if not exists public.trove_requests (
  id           uuid primary key default gen_random_uuid(),
  player       text not null,
  building     text not null,
  invested     numeric not null default 0,
  note         text,
  status       text not null default 'pending',   -- pending | approved | denied | done | closed
  allocations  jsonb not null default '[]'::jsonb,
  admin_note   text,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  done_at      timestamptz
);

create table if not exists public.trove_settings (
  key   text primary key,
  value jsonb not null
);

-- private tables: no public access at all
create table if not exists public.trove_request_tokens (
  request_id uuid primary key references public.trove_requests(id) on delete cascade,
  token_hash text not null
);
create table if not exists public.trove_admin_secret (
  id int primary key default 1 check (id = 1),
  pw_hash text not null
);

alter table public.trove_items          enable row level security;
alter table public.trove_requests       enable row level security;
alter table public.trove_settings       enable row level security;
alter table public.trove_request_tokens enable row level security;
alter table public.trove_admin_secret   enable row level security;

-- everyone can READ the board; nobody can write directly (only through the functions below)
drop policy if exists "read trove_items" on public.trove_items;
create policy "read trove_items" on public.trove_items for select using (true);
drop policy if exists "read trove_requests" on public.trove_requests;
create policy "read trove_requests" on public.trove_requests for select using (true);
drop policy if exists "read trove_settings" on public.trove_settings;
create policy "read trove_settings" on public.trove_settings for select using (true);

-- default building list (Scodato can edit it in the app)
insert into public.trove_settings(key, value) values ('buildings', '[
  "Town Hall","Temple","Tavern","Emerald Inn","Academy","Training Hall","Master Lodge",
  "Summoner''s Tent","Wizard Tower","Laboratory","Apothecary","Ether Well","Mausoleum",
  "Garden","Military Camp","Iron Mine","Lumberyard","Wood Workshop","Jewel Workshop","Tailor Workshop",
  "Tannery","Smithy","Weaver Mill","Ironwood Sawmill","Oil Press","Smelter","Jewel Storehouse"
]'::jsonb) on conflict (key) do nothing;

insert into public.trove_settings(key, value) values ('max_per_approval', '1'::jsonb) on conflict (key) do nothing;
insert into public.trove_settings(key, value) values ('cooldown_hours', '24'::jsonb) on conflict (key) do nothing;

insert into public.trove_settings(key, value) values ('known_names', '[
  "Worldshaper Hood","Aura Reactor","Darkmatter Cortex","Voyager Neovisor",
  "Microcosmos Infusion","Slipstream Assistant","Paradox Entity","Dimensional Anchor"
]'::jsonb) on conflict (key) do nothing;

-- ---------- helpers ----------
create or replace function public.trove_check_pw(p_pw text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare h text;
begin
  select pw_hash into h from trove_admin_secret where id = 1;
  if h is null or p_pw is null or crypt(p_pw, h) <> h then
    perform pg_sleep(0.6);
    raise exception 'Wrong password';
  end if;
end $$;

create or replace function public.trove_clean(t text, maxlen int) returns text
language sql immutable as $$ select nullif(left(btrim(coalesce(t,'')), maxlen), '') $$;

-- ---------- player functions ----------
create or replace function public.trove_submit_request(p_player text, p_building text, p_invested numeric, p_note text, p_token text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare new_id uuid; n int;
begin
  p_player := trove_clean(p_player, 40);
  p_building := trove_clean(p_building, 60);
  if p_player is null then raise exception 'Please enter your in-game name'; end if;
  if p_building is null then raise exception 'Please pick a building'; end if;
  if p_invested is null or p_invested < 0 then raise exception 'Investment amount must be 0 or more'; end if;
  if p_token is null or length(p_token) < 16 then raise exception 'Bad token'; end if;
  select count(*) into n from trove_requests where lower(player) = lower(p_player) and status in ('pending','approved');
  if n >= 1 then raise exception 'You already have a request open — finish that one first'; end if;
  select count(*) into n from trove_requests where status = 'pending';
  if n >= 300 then raise exception 'The board is full right now, try again later'; end if;
  insert into trove_requests(player, building, invested, note)
    values (p_player, p_building, p_invested, trove_clean(p_note, 200)) returning id into new_id;
  insert into trove_request_tokens(request_id, token_hash) values (new_id, encode(digest(p_token, 'sha256'), 'hex'));
  return new_id;
end $$;

-- anyone can mark an approved request as done (the board is open on purpose)
create or replace function public.trove_mark_done(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update trove_requests set status = 'done', done_at = now() where id = p_id and status = 'approved';
  if not found then raise exception 'That request is not waiting to be finished'; end if;
end $$;

-- the person who made the request (same device) can cancel / dismiss it
create or replace function public.trove_player_cancel(p_id uuid, p_token text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare r trove_requests; a jsonb;
begin
  if not exists (select 1 from trove_request_tokens where request_id = p_id
                 and token_hash = encode(digest(coalesce(p_token,''), 'sha256'), 'hex')) then
    raise exception 'Only the device that made this request can cancel it';
  end if;
  select * into r from trove_requests where id = p_id for update;
  if r.status = 'approved' then
    for a in select * from jsonb_array_elements(r.allocations) loop
      update trove_items set qty = qty + (a->>'qty')::int, updated_at = now() where id = (a->>'item_id')::uuid;
    end loop;
  end if;
  if r.status in ('pending','approved','denied') then
    update trove_requests set status = 'closed', done_at = now() where id = p_id;
  end if;
end $$;

create or replace function public.trove_public_stats() returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'items_donated', coalesce((select sum((a->>'qty')::int) from trove_requests r, jsonb_array_elements(r.allocations) a where r.status = 'done'), 0),
    'requests_done', (select count(*) from trove_requests where status = 'done')
  ) $$;

-- ---------- Scodato (admin) functions ----------
create or replace function public.trove_admin_login(p_pw text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin perform trove_check_pw(p_pw); return true; end $$;

create or replace function public.trove_admin_change_password(p_pw text, p_new text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform trove_check_pw(p_pw);
  if p_new is null or length(p_new) < 6 then raise exception 'New password must be at least 6 characters'; end if;
  update trove_admin_secret set pw_hash = crypt(p_new, gen_salt('bf', 10)) where id = 1;
end $$;

-- upsert a list of trove_items: [{id?, name, rarity, qty, icon?}]
create or replace function public.trove_admin_save_items(p_pw text, p_items jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare it jsonb;
begin
  perform trove_check_pw(p_pw);
  for it in select * from jsonb_array_elements(p_items) loop
    if coalesce(it->>'id','') <> '' then
      update trove_items set
        name   = coalesce(trove_clean(it->>'name', 80), name),
        rarity = coalesce(trove_clean(it->>'rarity', 20), rarity),
        qty    = greatest(0, coalesce((it->>'qty')::int, qty)),
        icon   = case when it ? 'icon' and it->>'icon' is not null then left(it->>'icon', 60000) else icon end,
        updated_at = now()
      where id = (it->>'id')::uuid;
    else
      insert into trove_items(name, rarity, qty, icon) values (
        coalesce(trove_clean(it->>'name', 80), 'Unknown item'),
        coalesce(trove_clean(it->>'rarity', 20), 'legendary'),
        greatest(0, coalesce((it->>'qty')::int, 0)),
        left(it->>'icon', 60000));
    end if;
  end loop;
end $$;

create or replace function public.trove_admin_delete_item(p_pw text, p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin perform trove_check_pw(p_pw); delete from trove_items where id = p_id; end $$;

-- approve (with allocations [{item_id, qty}]) or deny
create or replace function public.trove_admin_decide(p_pw text, p_id uuid, p_approve boolean, p_alloc jsonb, p_note text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare r trove_requests; a jsonb; it trove_items; snap jsonb := '[]'::jsonb; q int; total int := 0; cap int;
begin
  perform trove_check_pw(p_pw);
  select * into r from trove_requests where id = p_id for update;
  if r.id is null or r.status <> 'pending' then raise exception 'That request is no longer pending'; end if;
  if not p_approve then
    update trove_requests set status = 'denied', admin_note = trove_clean(p_note, 200), decided_at = now() where id = p_id;
    return;
  end if;
  if p_alloc is null or jsonb_array_length(p_alloc) = 0 then raise exception 'Pick at least one item'; end if;
  for a in select * from jsonb_array_elements(p_alloc) loop
    q := (a->>'qty')::int;
    if q is null or q <= 0 then continue; end if;
    select * into it from trove_items where id = (a->>'item_id')::uuid for update;
    if it.id is null then raise exception 'An item is missing from the treasury'; end if;
    if it.qty < q then raise exception 'Only % × % left', it.qty, it.name; end if;
    update trove_items set qty = qty - q, updated_at = now() where id = it.id;
    snap := snap || jsonb_build_object('item_id', it.id, 'name', it.name, 'rarity', it.rarity, 'qty', q, 'icon', it.icon);
  end loop;
  if jsonb_array_length(snap) = 0 then raise exception 'Pick at least one item'; end if;
  select coalesce((select (value #>> '{}')::int from trove_settings where key = 'max_per_approval'), 0) into cap;
  select coalesce(sum((x->>'qty')::int), 0) into total from jsonb_array_elements(snap) x;
  if cap > 0 and total > cap then raise exception 'Max % item(s) per approval — change the limit in Settings', cap; end if;
  update trove_requests set status = 'approved', allocations = snap, admin_note = trove_clean(p_note, 200), decided_at = now() where id = p_id;
end $$;

-- undo an approval or a denial: puts trove_items back and returns the request to pending
create or replace function public.trove_admin_reopen(p_pw text, p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare r trove_requests; a jsonb;
begin
  perform trove_check_pw(p_pw);
  select * into r from trove_requests where id = p_id for update;
  if r.status = 'approved' then
    for a in select * from jsonb_array_elements(r.allocations) loop
      update trove_items set qty = qty + (a->>'qty')::int, updated_at = now() where id = (a->>'item_id')::uuid;
    end loop;
  end if;
  if r.status in ('approved','denied') then
    update trove_requests set status = 'pending', allocations = '[]'::jsonb, admin_note = null, decided_at = null where id = p_id;
  end if;
end $$;

create or replace function public.trove_admin_remove_request(p_pw text, p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform trove_check_pw(p_pw);
  perform trove_admin_reopen(p_pw, p_id);
  update trove_requests set status = 'closed', done_at = now() where id = p_id;
end $$;

create or replace function public.trove_admin_save_setting(p_pw text, p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform trove_check_pw(p_pw);
  if p_key not in ('buildings','known_names','max_per_approval','cooldown_hours') then raise exception 'Unknown setting'; end if;
  insert into trove_settings(key, value) values (p_key, p_value) on conflict (key) do update set value = excluded.value;
end $$;

-- lock everything down, then open only what the app needs
revoke all on function public.trove_check_pw(text) from public, anon, authenticated;
revoke all on public.trove_request_tokens, public.trove_admin_secret from anon, authenticated;
revoke insert, update, delete on public.trove_items, public.trove_requests, public.trove_settings from anon, authenticated;
grant select on public.trove_items, public.trove_requests, public.trove_settings to anon, authenticated;
grant execute on function public.trove_submit_request(text,text,numeric,text,text), public.trove_mark_done(uuid),
  public.trove_player_cancel(uuid,text), public.trove_public_stats(), public.trove_admin_login(text),
  public.trove_admin_change_password(text,text), public.trove_admin_save_items(text,jsonb),
  public.trove_admin_delete_item(text,uuid), public.trove_admin_decide(text,uuid,boolean,jsonb,text),
  public.trove_admin_reopen(text,uuid), public.trove_admin_remove_request(text,uuid),
  public.trove_admin_save_setting(text,text,jsonb) to anon, authenticated;

-- ===== Scodato's password: change 'change-me-please' below, then Run =====
-- (Running this file again later will NOT reset it. To reset, run just the line below with a new password,
--  replacing "on conflict do nothing" with "on conflict (id) do update set pw_hash = excluded.pw_hash".)
insert into public.trove_admin_secret(id, pw_hash) values (1, extensions.crypt('change-me-please', extensions.gen_salt('bf', 10))) on conflict do nothing;
