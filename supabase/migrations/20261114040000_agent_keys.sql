-- Agent keys. A signed-in user creates keys for their agents; a request carrying the header
-- `x-potluck-key: <key>` acts as that user through the same functions and row rules.
-- Such requests arrive as the `anon` role, so every check below uses app.uid(), not the role.

create table app.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users on delete cascade,
  name text not null,
  key_hash text unique not null,
  created_at timestamptz not null default now()
);

-- The caller: the signed-in user, or the owner of the request's agent key.
create function app.uid() returns uuid language plpgsql stable security definer set search_path = '' as $$
declare k text := nullif(current_setting('request.headers', true), '')::json->>'x-potluck-key';
begin
  if auth.uid() is not null or k is null then return auth.uid(); end if;
  return (select user_id from app.api_keys where key_hash = encode(extensions.digest(k, 'sha256'), 'hex'));
end $$;

create function app.approved(uid uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.users u join app.allowed_emails a on a.email = lower(u.email) where u.id = uid)
$$;

create or replace function app.me() returns text language sql stable security definer set search_path = '' as $$
  select username from app.users where id = app.uid()
$$;

create function app.is_member() returns boolean language sql stable security definer set search_path = '' as $$
  select app.me() is not null and app.approved(app.uid())
$$;

create or replace function app.require_user() returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_member() then
    raise exception 'Sign in (or use an agent key) with an approved email and claim a username first';
  end if;
  return app.me();
end $$;

create or replace function public.describe() returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_member() then return jsonb_build_object('me', null); end if;
  return public.describe_all();
end $$;

-- Row rules for a user table, keyed on app.uid() so agent keys get the same rights as their owner.
create function app.secure_table(fq text) returns void language plpgsql security definer set search_path = '' as $$
begin
  execute format('alter table %s alter column created_by set default app.uid()', fq);
  execute format('alter table %s enable row level security', fq);
  execute format('drop policy if exists read on %1$s; drop policy if exists add on %1$s; drop policy if exists edit on %1$s; drop policy if exists remove on %1$s', fq);
  execute format('create policy read on %s for select to anon, authenticated using ((select app.is_member()))', fq);
  execute format('create policy add on %s for insert to anon, authenticated with check (created_by = (select app.uid()) and (select app.is_member()))', fq);
  execute format('create policy edit on %s for update to anon, authenticated using (created_by = (select app.uid())) with check (created_by = (select app.uid()))', fq);
  execute format('create policy remove on %s for delete to anon, authenticated using (created_by = (select app.uid()))', fq);
  execute format('grant select, insert, update, delete on %s to anon, authenticated', fq);
end $$;

create or replace function public.create_table(name text, columns jsonb default '[]') returns text language plpgsql security definer set search_path = '' as $$
declare owner text := app.require_user(); fq text; cols text := ''; spec jsonb;
begin
  if name !~ '^[a-z][a-z0-9_]{0,62}$' then raise exception 'Invalid table name "%"', name; end if;
  fq := format('%I.%I', owner, name);
  if to_regclass(fq) is not null then raise exception 'Table %.% already exists', owner, name; end if;
  for spec in select * from jsonb_array_elements(columns) loop
    cols := cols || ', ' || app.column_sql(spec);
  end loop;
  execute format('create table %s (
      id bigint generated always as identity primary key,
      created_by uuid not null references app.users,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()%s)', fq, cols);
  perform app.secure_table(fq);
  execute format('create trigger touch before update on %s for each row execute function app.touch()', fq);
  execute format('alter publication supabase_realtime add table %s', fq);
  return owner || '.' || name;
end $$;

create or replace function public.claim_username(name text) returns text language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in to the site to claim a username'; end if;
  if not app.approved(auth.uid()) then raise exception 'This email has not been approved'; end if;
  if app.me() is not null then raise exception 'You are already %', app.me(); end if;
  if name !~ '^[a-z][a-z0-9_]{1,30}$' or name ~ '^(pg_|supabase)'
     or name in ('app', 'public', 'auth', 'storage', 'realtime', 'extensions', 'graphql', 'graphql_public', 'vault', 'net', 'cron')
     or exists (select 1 from pg_namespace where nspname = name) then
    raise exception 'Username "%" is not available (lowercase letters, digits and _, 2-31 chars)', name;
  end if;
  insert into app.users (id, username) values (auth.uid(), name);
  execute format('create schema %I', name);
  execute format('grant usage on schema %I to anon, authenticated', name);
  return name;
end $$;

create or replace function public.save_gui(name text, code text, description text default null, reads text[] default null, id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare gid uuid := id; v int; t text;
begin
  perform app.require_user();
  foreach t in array coalesce(reads, '{}') loop perform app.resolve(t); end loop;
  if gid is null then
    insert into app.guis (owner, name, description, reads)
      values (app.uid(), name, coalesce(description, ''), coalesce(reads, '{}')) returning app.guis.id into gid;
  else
    update app.guis g set name = save_gui.name, description = coalesce(save_gui.description, g.description),
      reads = coalesce(save_gui.reads, g.reads), updated_at = now()
      where g.id = gid and g.owner = app.uid();
    if not found then raise exception 'GUI % not found or not yours; fork it instead (fork_gui)', gid; end if;
  end if;
  select coalesce(max(gv.version), 0) + 1 into v from app.gui_versions gv where gv.gui_id = gid;
  insert into app.gui_versions (gui_id, version, code) values (gid, v, code);
  return jsonb_build_object('id', gid, 'version', v);
end $$;

create or replace function public.fork_gui(id uuid, name text default null) returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare src jsonb := public.get_gui(id); gid uuid;
begin
  perform app.require_user();
  if src is null then raise exception 'GUI % not found', id; end if;
  insert into app.guis (owner, name, description, reads, forked_from)
    values (app.uid(), coalesce(name, src->>'name'), src->>'description',
            array(select jsonb_array_elements_text(src->'reads')), id)
    returning app.guis.id into gid;
  insert into app.gui_versions (gui_id, version, code) values (gid, 1, src->>'code');
  return jsonb_build_object('id', gid, 'version', 1);
end $$;

create or replace function public.delete_gui(id uuid) returns uuid language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
begin
  perform app.require_user();
  delete from app.guis g where g.id = id and g.owner = app.uid();
  if not found then raise exception 'GUI % not found or not yours', id; end if;
  return id;
end $$;

create or replace function public.get_gui(id uuid, version int default null) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', g.id, 'name', g.name, 'description', g.description, 'owner', u.username,
                            'reads', g.reads, 'forked_from', g.forked_from, 'version', v.version, 'code', v.code,
                            'versions', (select count(*) from app.gui_versions x where x.gui_id = g.id))
  from app.guis g join app.users u on u.id = g.owner
  join app.gui_versions v on v.gui_id = g.id
  where app.is_member() and g.id = get_gui.id and (get_gui.version is null or v.version = get_gui.version)
  order by v.version desc limit 1
$$;

-- Bulk insert: one call for many rows, each checked like insert_row.
create function public.insert_rows(table_name text, rows jsonb) returns int language plpgsql set search_path = '' as $$
declare r jsonb; n int := 0;
begin
  if jsonb_typeof(rows) is distinct from 'array' then raise exception 'rows must be an array of objects'; end if;
  for r in select * from jsonb_array_elements(rows) loop
    perform public.insert_row(table_name, r);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- key management (signed-in session only; a key cannot create keys) ----------

create function public.create_api_key(name text) returns text language plpgsql security definer set search_path = '' as $$
declare k text := 'pk_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  if auth.uid() is null or not app.is_member() then raise exception 'Sign in to the site to create agent keys'; end if;
  insert into app.api_keys (user_id, name, key_hash) values (auth.uid(), name, encode(extensions.digest(k, 'sha256'), 'hex'));
  return k;
end $$;

create function public.list_api_keys() returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'created_at', created_at) order by created_at), '[]')
  from app.api_keys where user_id = auth.uid()
$$;

create function public.revoke_api_key(id uuid) returns uuid language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
begin
  delete from app.api_keys k where k.id = id and k.user_id = auth.uid();
  if not found then raise exception 'Key % not found', id; end if;
  return id;
end $$;

-- ---------- grants ----------

grant usage on schema app to anon;
grant select on app.users, app.guis, app.gui_versions to anon;
do $$
declare t record;
begin
  for t in select username from app.users loop
    execute format('grant usage on schema %I to anon', t.username);
  end loop;
  for t in select table_schema, table_name from information_schema.tables
           where table_schema in (select username from app.users) loop
    perform app.secure_table(format('%I.%I', t.table_schema, t.table_name));
  end loop;
end $$;

revoke execute on function public.insert_rows, public.create_api_key, public.list_api_keys, public.revoke_api_key from public, anon;
grant execute on function public.insert_rows, public.create_api_key, public.list_api_keys, public.revoke_api_key to authenticated;
-- Member functions are also callable with an agent key (anon role); each checks membership itself.
grant execute on function public.describe, public.query, public.create_table, public.add_column, public.drop_column,
  public.drop_table, public.insert_row, public.insert_rows, public.update_row, public.delete_row,
  public.save_gui, public.get_gui, public.fork_gui, public.delete_gui to anon;
