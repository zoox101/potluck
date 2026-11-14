-- Group App Builder: everything users and agents call is a function in `public`.
-- Each user gets a schema named after their username; app metadata lives in `app`.

create schema app;
grant usage on schema app to authenticated;

create table app.users (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null,
  created_at timestamptz not null default now()
);

create table app.guis (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references app.users,
  name text not null,
  description text not null default '',
  reads text[] not null default '{}',  -- tables this GUI reads, e.g. {will.places}
  forked_from uuid references app.guis on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.gui_versions (
  gui_id uuid references app.guis on delete cascade,
  version int not null,
  code text not null,
  created_at timestamptz not null default now(),
  primary key (gui_id, version)
);

-- Metadata is readable by everyone (e.g. through query()); writes only go through functions.
grant select on all tables in schema app to authenticated;

-- ---------- helpers ----------

create function app.me() returns text language sql stable security definer set search_path = '' as $$
  select username from app.users where id = auth.uid()
$$;

create function app.require_user() returns text language plpgsql stable security definer set search_path = '' as $$
declare u text := app.me();
begin
  if u is null then raise exception 'Sign in and claim a username first (claim_username)'; end if;
  return u;
end $$;

-- 'owner.table' -> quoted identifier, or an error if it is not a user table.
create function app.resolve(table_name text) returns text language plpgsql stable security definer set search_path = '' as $$
declare s text := split_part(table_name, '.', 1); n text := split_part(table_name, '.', 2);
begin
  if table_name !~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
     or not exists (select 1 from app.users where username = s)
     or to_regclass(format('%I.%I', s, n)) is null then
    raise exception 'Unknown table "%" (expected owner.table)', table_name;
  end if;
  return format('%I.%I', s, n);
end $$;

-- Only the owner may change a table's schema; unless forced, refuse when GUIs read it.
create function app.guard(table_name text, force boolean) returns text language plpgsql stable security definer set search_path = '' as $$
declare fq text := app.resolve(table_name); readers text;
begin
  if split_part(table_name, '.', 1) <> app.require_user() then
    raise exception 'Only % can change the schema of %', split_part(table_name, '.', 1), table_name;
  end if;
  select string_agg(format('"%s" (%s)', g.name, u.username), ', ') into readers
    from app.guis g join app.users u on u.id = g.owner where table_name = any(g.reads);
  if readers is not null and not force then
    raise exception 'These GUIs read %: %. Pass force=true to change it anyway.', table_name, readers;
  end if;
  return fq;
end $$;

create function app.column_sql(spec jsonb) returns text language plpgsql immutable set search_path = '' as $$
declare n text := spec->>'name'; t text := lower(coalesce(spec->>'type', 'text'));
begin
  if n is null or n !~ '^[a-z][a-z0-9_]*$' or n in ('id', 'created_by', 'created_at', 'updated_at') then
    raise exception 'Invalid column name "%"', n;
  end if;
  if t not in ('text', 'integer', 'bigint', 'numeric', 'boolean', 'date', 'timestamptz', 'jsonb', 'uuid') then
    raise exception 'Unsupported type "%" (use text, integer, bigint, numeric, boolean, date, timestamptz, jsonb or uuid)', t;
  end if;
  return format('%I %s%s', n, t, case when (spec->>'required')::boolean then ' not null' else '' end);
end $$;

-- Quoted column list from a row object's keys, rejecting system columns.
create function app.data_columns(data jsonb) returns text language plpgsql immutable set search_path = '' as $$
declare cols text;
begin
  if jsonb_typeof(data) is distinct from 'object' or data = '{}' then raise exception 'data must be a non-empty object'; end if;
  if data ?| array['id', 'created_by', 'created_at', 'updated_at'] then
    raise exception 'id, created_by, created_at and updated_at are set automatically';
  end if;
  select string_agg(format('%I', k), ', ') into cols from jsonb_object_keys(data) k;
  return cols;
end $$;

create function app.touch() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.created_at := old.created_at;
  return new;
end $$;

-- ---------- users ----------

create function public.claim_username(name text) returns text language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
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

-- ---------- schema (owner only) ----------

create function public.create_table(name text, columns jsonb default '[]') returns text language plpgsql security definer set search_path = '' as $$
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
      created_by uuid not null default auth.uid() references app.users,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()%s)', fq, cols);
  -- Anyone reads and adds rows; only a row's creator edits or deletes it.
  execute format('alter table %s enable row level security', fq);
  execute format('create policy read on %s for select to authenticated using (true)', fq);
  execute format('create policy add on %s for insert to authenticated with check (created_by = auth.uid())', fq);
  execute format('create policy edit on %s for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid())', fq);
  execute format('create policy remove on %s for delete to authenticated using (created_by = auth.uid())', fq);
  execute format('grant select, insert, update, delete on %s to authenticated', fq);
  execute format('create trigger touch before update on %s for each row execute function app.touch()', fq);
  execute format('alter publication supabase_realtime add table %s', fq);
  return owner || '.' || name;
end $$;

create function public.add_column(table_name text, column_spec jsonb) returns text language plpgsql security definer set search_path = '' as $$
begin
  execute format('alter table %s add column %s', app.guard(table_name, true), app.column_sql(column_spec));
  return table_name;
end $$;

create function public.drop_column(table_name text, column_name text, force boolean default false) returns text language plpgsql security definer set search_path = '' as $$
begin
  if column_name in ('id', 'created_by', 'created_at', 'updated_at') then raise exception 'Cannot drop %', column_name; end if;
  execute format('alter table %s drop column %I', app.guard(table_name, force), column_name);
  return table_name;
end $$;

create function public.drop_table(table_name text, force boolean default false) returns text language plpgsql security definer set search_path = '' as $$
begin
  execute format('drop table %s', app.guard(table_name, force));
  return table_name;
end $$;

-- ---------- rows (run as the caller, so row-level security applies) ----------

create function public.insert_row(table_name text, data jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare fq text := app.resolve(table_name); cols text := app.data_columns(data); r jsonb;
begin
  execute format('insert into %1$s as t (%2$s) select %2$s from jsonb_populate_record(null::%1$s, $1) returning to_jsonb(t)', fq, cols)
    using data into r;
  return r;
end $$;

create function public.update_row(table_name text, id bigint, data jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare fq text := app.resolve(table_name); cols text := app.data_columns(data); r jsonb;
begin
  execute format('update %1$s as t set (%2$s) = (select %2$s from jsonb_populate_record(null::%1$s, $1)) where t.id = $2 returning to_jsonb(t)', fq, cols)
    using data, id into r;
  if r is null then raise exception 'Row % of % not found, or not yours', id, table_name; end if;
  return r;
end $$;

create function public.delete_row(table_name text, id bigint) returns jsonb language plpgsql set search_path = '' as $$
declare r jsonb;
begin
  execute format('delete from %s as t where t.id = $1 returning to_jsonb(t)', app.resolve(table_name)) using id into r;
  if r is null then raise exception 'Row % of % not found, or not yours', id, table_name; end if;
  return r;
end $$;

-- Read-only SQL. STABLE makes Postgres reject any write or DDL inside it.
create function public.query(sql text) returns jsonb language plpgsql stable set search_path = '' set statement_timeout = '5s' as $$
declare r jsonb;
begin
  execute format('select coalesce(jsonb_agg(q), ''[]''::jsonb) from (%s) q', rtrim(btrim(sql), '; ')) into r;
  return r;
end $$;

create function public.describe() returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'me', app.me(),
    'tables', coalesce((
      select jsonb_agg(jsonb_build_object(
          'table', c.tbl, 'owner', c.owner, 'columns', c.cols,
          'read_by', (select coalesce(jsonb_agg(g.id), '[]') from app.guis g where c.tbl = any(g.reads)))
        order by c.tbl)
      from (
        select table_schema as owner, table_schema || '.' || table_name as tbl,
               jsonb_agg(jsonb_build_object('name', column_name, 'type', data_type) order by ordinal_position) as cols
        from information_schema.columns
        where table_schema in (select username from app.users)
        group by table_schema, table_name) c), '[]'),
    'guis', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', g.id, 'name', g.name, 'description', g.description, 'owner', u.username,
          'reads', g.reads, 'forked_from', g.forked_from, 'updated_at', g.updated_at,
          'version', (select max(v.version) from app.gui_versions v where v.gui_id = g.id))
        order by g.updated_at desc)
      from app.guis g join app.users u on u.id = g.owner), '[]'))
$$;

-- ---------- GUIs (owner edits; everyone else forks) ----------

create function public.save_gui(name text, code text, description text default null, reads text[] default null, id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare gid uuid := id; v int; t text;
begin
  perform app.require_user();
  foreach t in array coalesce(reads, '{}') loop perform app.resolve(t); end loop;
  if gid is null then
    insert into app.guis (owner, name, description, reads)
      values (auth.uid(), name, coalesce(description, ''), coalesce(reads, '{}')) returning app.guis.id into gid;
  else
    update app.guis g set name = save_gui.name, description = coalesce(save_gui.description, g.description),
      reads = coalesce(save_gui.reads, g.reads), updated_at = now()
      where g.id = gid and g.owner = auth.uid();
    if not found then raise exception 'GUI % not found or not yours; fork it instead (fork_gui)', gid; end if;
  end if;
  select coalesce(max(gv.version), 0) + 1 into v from app.gui_versions gv where gv.gui_id = gid;
  insert into app.gui_versions (gui_id, version, code) values (gid, v, code);
  return jsonb_build_object('id', gid, 'version', v);
end $$;

create function public.get_gui(id uuid, version int default null) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', g.id, 'name', g.name, 'description', g.description, 'owner', u.username,
                            'reads', g.reads, 'forked_from', g.forked_from, 'version', v.version, 'code', v.code,
                            'versions', (select count(*) from app.gui_versions x where x.gui_id = g.id))
  from app.guis g join app.users u on u.id = g.owner
  join app.gui_versions v on v.gui_id = g.id
  where g.id = get_gui.id and (get_gui.version is null or v.version = get_gui.version)
  order by v.version desc limit 1
$$;

create function public.fork_gui(id uuid, name text default null) returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare src jsonb := public.get_gui(id); gid uuid;
begin
  perform app.require_user();
  if src is null then raise exception 'GUI % not found', id; end if;
  insert into app.guis (owner, name, description, reads, forked_from)
    values (auth.uid(), coalesce(name, src->>'name'), src->>'description',
            array(select jsonb_array_elements_text(src->'reads')), id)
    returning app.guis.id into gid;
  insert into app.gui_versions (gui_id, version, code) values (gid, 1, src->>'code');
  return jsonb_build_object('id', gid, 'version', 1);
end $$;

create function public.delete_gui(id uuid) returns uuid language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
begin
  delete from app.guis g where g.id = id and g.owner = auth.uid();
  if not found then raise exception 'GUI % not found or not yours', id; end if;
  return id;
end $$;

-- Only signed-in users may call anything.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
