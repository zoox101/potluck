-- Split the GUI API along the existing tables: app.guis holds metadata, app.gui_versions holds code.
--   create_gui           name + code (+ metadata) -> new GUI at version 1
--   update_gui_code      new code version (optionally new reads)
--   update_gui_metadata  name, description, reads, icon, color, visibility; no new version
-- save_gui is removed. Adds visibility (starred | default | hidden) and updated_by.

alter table app.guis
  add column visibility text not null default 'default' check (visibility in ('starred', 'default', 'hidden')),
  add column updated_by uuid references app.users on delete set null;
update app.guis g set updated_by = coalesce(
  (select v.saved_by from app.gui_versions v where v.gui_id = g.id order by v.version desc limit 1), g.owner);

drop function public.save_gui(text, text, text, text[], uuid, text, text);

create function app.check_reads(reads text[]) returns void language plpgsql stable security definer set search_path = '' as $$
declare t text;
begin
  foreach t in array coalesce(reads, '{}') loop perform app.resolve(t); end loop;
end $$;
revoke execute on function app.check_reads from public, anon, authenticated;

create function public.create_gui(name text, code text, description text default null, reads text[] default null,
                                  icon text default null, color text default null, visibility text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare gid uuid;
begin
  perform app.require_user();
  if nullif(btrim(name), '') is null then raise exception 'name is required'; end if;
  if code is null then raise exception 'code is required'; end if;
  perform app.check_reads(reads);
  insert into app.guis (owner, name, description, reads, icon, color, visibility, updated_by)
    values (app.uid(), name, coalesce(description, ''), coalesce(reads, '{}'), nullif(icon, ''), nullif(color, ''),
            coalesce(visibility, 'default'), app.uid())
    returning app.guis.id into gid;
  insert into app.gui_versions (gui_id, version, code, saved_by) values (gid, 1, code, app.uid());
  return jsonb_build_object('id', gid, 'version', 1);
end $$;

create function public.update_gui_code(id uuid, code text, reads text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare v int;
begin
  perform app.require_user();
  if code is null then raise exception 'code is required'; end if;
  perform app.check_reads(reads);
  update app.guis g set reads = coalesce(reads, g.reads), updated_at = now(), updated_by = app.uid() where g.id = id;
  if not found then raise exception 'GUI % not found', id; end if;
  select coalesce(max(gv.version), 0) + 1 into v from app.gui_versions gv where gv.gui_id = id;
  insert into app.gui_versions (gui_id, version, code, saved_by) values (id, v, code, app.uid());
  return jsonb_build_object('id', id, 'version', v);
end $$;

-- Omitted (null) fields keep their value; '' clears icon and color.
create function public.update_gui_metadata(id uuid, name text default null, description text default null,
                                           reads text[] default null, icon text default null, color text default null,
                                           visibility text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
begin
  perform app.require_user();
  if name is not null and btrim(name) = '' then raise exception 'name can''t be empty'; end if;
  perform app.check_reads(reads);
  update app.guis g set
    name = coalesce(name, g.name),
    description = coalesce(description, g.description),
    reads = coalesce(reads, g.reads),
    icon = case when icon is null then g.icon else nullif(icon, '') end,
    color = case when color is null then g.color else nullif(color, '') end,
    visibility = coalesce(visibility, g.visibility),
    updated_at = now(), updated_by = app.uid()
    where g.id = id;
  if not found then raise exception 'GUI % not found', id; end if;
  return public.describe_gui(id);
end $$;

-- One GUI's metadata (what describe lists), without code.
create function public.describe_gui(id uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', g.id, 'name', g.name, 'description', g.description, 'owner', u.username,
    'icon', g.icon, 'color', g.color, 'visibility', g.visibility,
    'reads', g.reads, 'forked_from', g.forked_from, 'updated_at', g.updated_at, 'updated_by', ub.username,
    'version', (select max(v.version) from app.gui_versions v where v.gui_id = g.id))
  from app.guis g join app.users u on u.id = g.owner left join app.users ub on ub.id = g.updated_by
  where app.is_member() and g.id = describe_gui.id
$$;
revoke execute on function public.describe_gui from public;

create or replace function public.get_gui(id uuid, version int default null) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', g.id, 'name', g.name, 'description', g.description, 'owner', u.username,
                            'icon', g.icon, 'color', g.color, 'visibility', g.visibility,
                            'reads', g.reads, 'forked_from', g.forked_from, 'version', v.version, 'code', v.code,
                            'saved_by', s.username, 'saved_at', v.created_at,
                            'updated_at', g.updated_at, 'updated_by', ub.username,
                            'versions', (select count(*) from app.gui_versions x where x.gui_id = g.id))
  from app.guis g join app.users u on u.id = g.owner
  join app.gui_versions v on v.gui_id = g.id
  left join app.users s on s.id = v.saved_by
  left join app.users ub on ub.id = g.updated_by
  where app.is_member() and g.id = get_gui.id and (get_gui.version is null or v.version = get_gui.version)
  order by v.version desc limit 1
$$;

-- A fork starts at default visibility, owned and last updated by the forker.
create or replace function public.fork_gui(id uuid, name text default null) returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare src jsonb := public.get_gui(id); gid uuid;
begin
  perform app.require_user();
  if src is null then raise exception 'GUI % not found', id; end if;
  insert into app.guis (owner, name, description, reads, forked_from, icon, color, updated_by)
    values (app.uid(), coalesce(name, src->>'name'), src->>'description',
            array(select jsonb_array_elements_text(src->'reads')), id, src->>'icon', src->>'color', app.uid())
    returning app.guis.id into gid;
  insert into app.gui_versions (gui_id, version, code, saved_by) values (gid, 1, src->>'code', app.uid());
  return jsonb_build_object('id', gid, 'version', 1);
end $$;

create or replace function public.describe_all() returns jsonb language sql stable security definer set search_path = '' as $$
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
      select jsonb_agg(public.describe_gui(g.id) order by g.updated_at desc) from app.guis g), '[]'))
$$;

revoke execute on function public.create_gui, public.update_gui_code, public.update_gui_metadata from public;
grant execute on function public.create_gui, public.update_gui_code, public.update_gui_metadata, public.describe_gui
  to anon, authenticated;
