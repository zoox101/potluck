-- Only approved emails may sign up. Only the project admin (service_role, i.e. whoever
-- holds the project's secret key) manages the list and removes users.

create table app.allowed_emails (
  email text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);

create function app.allowed(email text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.allowed_emails a where a.email = lower(allowed.email))
$$;

-- Auth hook: runs before Supabase creates any user.
create function app.before_user_created(event jsonb) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if app.allowed(event->'user'->>'email') then return '{}'; end if;
  return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'This email has not been approved. Ask the group admin to add it.'));
end $$;
grant usage on schema app to supabase_auth_admin;
grant execute on function app.before_user_created to supabase_auth_admin;
revoke execute on function app.before_user_created from public, anon, authenticated;

-- Membership also requires an approved email, in case an account predates the hook.
create or replace function app.require_user() returns text language plpgsql stable security definer set search_path = '' as $$
declare u text := app.me();
begin
  if u is null or not app.allowed(auth.jwt()->>'email') then
    raise exception 'Sign in with an approved email and claim a username first (claim_username)';
  end if;
  return u;
end $$;

create or replace function public.claim_username(name text) returns text language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not app.allowed(auth.jwt()->>'email') then raise exception 'This email has not been approved'; end if;
  if app.me() is not null then raise exception 'You are already %', app.me(); end if;
  if name !~ '^[a-z][a-z0-9_]{1,30}$' or name ~ '^(pg_|supabase)'
     or name in ('app', 'public', 'auth', 'storage', 'realtime', 'extensions', 'graphql', 'graphql_public', 'vault', 'net', 'cron')
     or exists (select 1 from pg_namespace where nspname = name) then
    raise exception 'Username "%" is not available (lowercase letters, digits and _, 2-31 chars)', name;
  end if;
  insert into app.users (id, username) values (auth.uid(), name);
  execute format('create schema %I', name);
  execute format('grant usage on schema %I to authenticated', name);
  return name;
end $$;

-- Reads now require membership too.
create or replace function public.query(sql text) returns jsonb language plpgsql stable set search_path = '' set statement_timeout = '5s' as $$
declare r jsonb;
begin
  perform app.require_user();
  execute format('select coalesce(jsonb_agg(q), ''[]''::jsonb) from (%s) q', rtrim(btrim(sql), '; ')) into r;
  return r;
end $$;

alter function public.describe() rename to describe_all;
revoke execute on function public.describe_all from public, anon, authenticated;
create function public.describe() returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if app.me() is null or not app.allowed(auth.jwt()->>'email') then return jsonb_build_object('me', null); end if;
  return public.describe_all();
end $$;

-- ---------- admin (service_role only) ----------

create function public.allow_email(email text) returns text language sql security definer set search_path = '' as $$
  insert into app.allowed_emails (email) values (lower(allow_email.email)) on conflict do nothing;
  select lower(allow_email.email);
$$;

create function public.disallow_email(email text) returns text language sql security definer set search_path = '' as $$
  delete from app.allowed_emails a where a.email = lower(disallow_email.email);
  select lower(disallow_email.email);
$$;

-- Delete a user with their schema, tables and GUIs. Others' rows they added are removed too.
create function public.remove_user(email text) returns text language plpgsql security definer set search_path = '' as $$
declare uid uuid; u text; t record;
begin
  select id into uid from auth.users where auth.users.email = lower(remove_user.email);
  if uid is null then raise exception 'No user with email %', email; end if;
  select username into u from app.users where id = uid;
  for t in select table_schema, table_name from information_schema.tables
           where table_schema in (select username from app.users) and table_schema is distinct from u loop
    execute format('delete from %I.%I where created_by = $1', t.table_schema, t.table_name) using uid;
  end loop;
  if u is not null then execute format('drop schema %I cascade', u); end if;
  delete from app.guis where owner = uid;
  delete from app.users where id = uid;
  delete from auth.users where id = uid;
  return coalesce(u, email);
end $$;

revoke execute on function public.allow_email, public.disallow_email, public.remove_user from public, anon, authenticated;
grant execute on function public.allow_email, public.disallow_email, public.remove_user, public.describe_all to service_role;
grant execute on function public.describe to authenticated;

create function public.list_allowed_emails() returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(email order by email), '{}') from app.allowed_emails
$$;
revoke execute on function public.list_allowed_emails from public, anon, authenticated;
grant execute on function public.list_allowed_emails to service_role;

-- Row writes require membership too (row-level security still decides whose rows).
create or replace function public.insert_row(table_name text, data jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare fq text := app.resolve(table_name); cols text := app.data_columns(data); r jsonb;
begin
  perform app.require_user();
  execute format('insert into %1$s as t (%2$s) select %2$s from jsonb_populate_record(null::%1$s, $1) returning to_jsonb(t)', fq, cols)
    using data into r;
  return r;
end $$;

create or replace function public.update_row(table_name text, id bigint, data jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare fq text := app.resolve(table_name); cols text := app.data_columns(data); r jsonb;
begin
  perform app.require_user();
  execute format('update %1$s as t set (%2$s) = (select %2$s from jsonb_populate_record(null::%1$s, $1)) where t.id = $2 returning to_jsonb(t)', fq, cols)
    using data, id into r;
  if r is null then raise exception 'Row % of % not found, or not yours', id, table_name; end if;
  return r;
end $$;

create or replace function public.delete_row(table_name text, id bigint) returns jsonb language plpgsql set search_path = '' as $$
declare r jsonb;
begin
  perform app.require_user();
  execute format('delete from %s as t where t.id = $1 returning to_jsonb(t)', app.resolve(table_name)) using id into r;
  if r is null then raise exception 'Row % of % not found, or not yours', id, table_name; end if;
  return r;
end $$;
