-- Any member can edit any GUI (each save is a new version, so nothing is lost).
-- Versions record who saved them. Only the owner (the creator) can delete a GUI.

alter table app.gui_versions add column saved_by uuid references app.users on delete set null;
update app.gui_versions v set saved_by = g.owner from app.guis g where g.id = v.gui_id;
alter table app.gui_versions alter column saved_by set default app.uid();

create or replace function public.save_gui(name text, code text, description text default null, reads text[] default null,
                                           id uuid default null, icon text default null, color text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare gid uuid := id; v int; t text;
begin
  perform app.require_user();
  foreach t in array coalesce(reads, '{}') loop perform app.resolve(t); end loop;
  if gid is null then
    insert into app.guis (owner, name, description, reads, icon, color)
      values (app.uid(), name, coalesce(description, ''), coalesce(reads, '{}'), nullif(icon, ''), nullif(color, ''))
      returning app.guis.id into gid;
  else
    update app.guis g set name = save_gui.name, description = coalesce(save_gui.description, g.description),
      reads = coalesce(save_gui.reads, g.reads),
      icon = case when save_gui.icon is null then g.icon else nullif(save_gui.icon, '') end,
      color = case when save_gui.color is null then g.color else nullif(save_gui.color, '') end,
      updated_at = now()
      where g.id = gid;
    if not found then raise exception 'GUI % not found', gid; end if;
  end if;
  select coalesce(max(gv.version), 0) + 1 into v from app.gui_versions gv where gv.gui_id = gid;
  insert into app.gui_versions (gui_id, version, code, saved_by) values (gid, v, code, app.uid());
  return jsonb_build_object('id', gid, 'version', v);
end $$;

create or replace function public.get_gui(id uuid, version int default null) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', g.id, 'name', g.name, 'description', g.description, 'owner', u.username,
                            'icon', g.icon, 'color', g.color,
                            'reads', g.reads, 'forked_from', g.forked_from, 'version', v.version, 'code', v.code,
                            'saved_by', s.username, 'saved_at', v.created_at,
                            'versions', (select count(*) from app.gui_versions x where x.gui_id = g.id))
  from app.guis g join app.users u on u.id = g.owner
  join app.gui_versions v on v.gui_id = g.id
  left join app.users s on s.id = v.saved_by
  where app.is_member() and g.id = get_gui.id and (get_gui.version is null or v.version = get_gui.version)
  order by v.version desc limit 1
$$;

-- fork_gui records the forker as the saver of version 1.
create or replace function public.fork_gui(id uuid, name text default null) returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare src jsonb := public.get_gui(id); gid uuid;
begin
  perform app.require_user();
  if src is null then raise exception 'GUI % not found', id; end if;
  insert into app.guis (owner, name, description, reads, forked_from, icon, color)
    values (app.uid(), coalesce(name, src->>'name'), src->>'description',
            array(select jsonb_array_elements_text(src->'reads')), id, src->>'icon', src->>'color')
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
      select jsonb_agg(jsonb_build_object(
          'id', g.id, 'name', g.name, 'description', g.description, 'owner', u.username,
          'icon', g.icon, 'color', g.color,
          'reads', g.reads, 'forked_from', g.forked_from, 'updated_at', g.updated_at,
          'version', lv.version, 'updated_by', s.username)
        order by g.updated_at desc)
      from app.guis g join app.users u on u.id = g.owner
      left join lateral (select v.version, v.saved_by from app.gui_versions v where v.gui_id = g.id
                         order by v.version desc limit 1) lv on true
      left join app.users s on s.id = lv.saved_by), '[]'))
$$;
