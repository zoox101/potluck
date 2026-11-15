-- Rows have an owner instead of a creator. `created_by` becomes `owned_by` on every table:
--   * only a row's owner edits or deletes it; any member adds rows (owned by themselves),
--   * the table's owner (owner of its schema) can reassign rows with set_row_owner, and edits them
--     only after assigning them to themselves.
-- owned_by stays a system column: insert/update can't set it, so nobody can forge it.

-- System column names (reserved for column_spec, refused in row data, undroppable).
create or replace function app.column_sql(spec jsonb) returns text language plpgsql immutable set search_path = '' as $$
declare n text := spec->>'name'; t text := lower(coalesce(spec->>'type', 'text'));
begin
  if n is null or n !~ '^[a-z][a-z0-9_]*$' or n in ('id', 'owned_by', 'created_at', 'updated_at') then
    raise exception 'Invalid column name "%"', n;
  end if;
  if t not in ('text', 'integer', 'bigint', 'numeric', 'boolean', 'date', 'timestamptz', 'jsonb', 'uuid') then
    raise exception 'Unsupported type "%" (use text, integer, bigint, numeric, boolean, date, timestamptz, jsonb or uuid)', t;
  end if;
  return format('%I %s%s', n, t, case when (spec->>'required')::boolean then ' not null' else '' end);
end $$;

create or replace function app.data_columns(data jsonb) returns text language plpgsql immutable set search_path = '' as $$
declare cols text;
begin
  if jsonb_typeof(data) is distinct from 'object' or data = '{}' then raise exception 'data must be a non-empty object'; end if;
  if data ?| array['id', 'owned_by', 'created_at', 'updated_at'] then
    raise exception 'id, owned_by, created_at and updated_at are set automatically (a table''s owner reassigns rows with set_row_owner)';
  end if;
  select string_agg(format('%I', k), ', ') into cols from jsonb_object_keys(data) k;
  return cols;
end $$;

create or replace function public.drop_column(table_name text, column_name text, force boolean default false) returns text language plpgsql security definer set search_path = '' as $$
begin
  if column_name in ('id', 'owned_by', 'created_at', 'updated_at') then raise exception 'Cannot drop %', column_name; end if;
  execute format('alter table %s drop column %I', app.guard(table_name, force), column_name);
  return table_name;
end $$;

-- Row rules keyed on owned_by (app.uid() covers agent keys).
create or replace function app.secure_table(fq text) returns void language plpgsql security definer set search_path = '' as $$
begin
  execute format('alter table %s alter column owned_by set default app.uid()', fq);
  execute format('alter table %s enable row level security', fq);
  execute format('drop policy if exists read on %1$s; drop policy if exists add on %1$s; drop policy if exists edit on %1$s; drop policy if exists remove on %1$s', fq);
  execute format('create policy read on %s for select to anon, authenticated using ((select app.is_member()))', fq);
  execute format('create policy add on %s for insert to anon, authenticated with check (owned_by = (select app.uid()) and (select app.is_member()))', fq);
  execute format('create policy edit on %s for update to anon, authenticated using (owned_by = (select app.uid())) with check (owned_by = (select app.uid()))', fq);
  execute format('create policy remove on %s for delete to anon, authenticated using (owned_by = (select app.uid()))', fq);
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
      owned_by uuid not null references app.users,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()%s)', fq, cols);
  perform app.secure_table(fq);
  execute format('create trigger touch before update on %s for each row execute function app.touch()', fq);
  execute format('alter publication supabase_realtime add table %s', fq);
  return owner || '.' || name;
end $$;

-- Existing tables: rename the column (keeps values, the foreign key and the default) and rebuild the rules.
do $$
declare t record;
begin
  for t in select c.table_schema, c.table_name from information_schema.columns c
           where c.table_schema in (select username from app.users) and c.column_name = 'created_by' loop
    execute format('alter table %I.%I rename column created_by to owned_by', t.table_schema, t.table_name);
    perform app.secure_table(format('%I.%I', t.table_schema, t.table_name));
  end loop;
end $$;

-- Removing a user deletes the rows they own in other people's tables.
create or replace function public.remove_user(email text) returns text language plpgsql security definer set search_path = '' as $$
declare uid uuid; u text; t record;
begin
  select id into uid from auth.users where auth.users.email = lower(remove_user.email);
  if uid is null then raise exception 'No user with email %', email; end if;
  select username into u from app.users where id = uid;
  for t in select table_schema, table_name from information_schema.tables
           where table_schema in (select username from app.users) and table_schema is distinct from u loop
    execute format('delete from %I.%I where owned_by = $1', t.table_schema, t.table_name) using uid;
  end loop;
  if u is not null then execute format('drop schema %I cascade', u); end if;
  delete from app.guis where owner = uid;
  delete from app.users where id = uid;
  delete from auth.users where id = uid;
  return coalesce(u, email);
end $$;

-- Only the table's owner (signed in or with their agent key) reassigns rows, to any member.
create function public.set_row_owner(table_name text, ids bigint[], username text) returns int
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare fq text := app.resolve(table_name); me text := app.require_user(); target uuid; n int;
begin
  if split_part(table_name, '.', 1) <> me then
    raise exception 'Only % can reassign rows of %', split_part(table_name, '.', 1), table_name;
  end if;
  select u.id into target from app.users u where u.username = username;
  if target is null then raise exception 'No member named "%"', username; end if;
  execute format('update %s set owned_by = $1 where id = any($2)', fq) using target, coalesce(ids, '{}');
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.set_row_owner from public;
grant execute on function public.set_row_owner to anon, authenticated;
