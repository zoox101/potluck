-- App icons: each GUI can name a Lucide icon (https://lucide.dev/icons) and an accent color,
-- shown on the apps page and in the navigation drawer.
alter table app.guis
  add column icon text check (icon ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(icon) <= 64),
  add column color text check (color ~ '^#[0-9a-fA-F]{6}$');

-- save_gui gains icon and color. Omitted (null) keeps the current value; '' clears it.
drop function public.save_gui(text, text, text, text[], uuid);
create function public.save_gui(name text, code text, description text default null, reads text[] default null,
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
      where g.id = gid and g.owner = app.uid();
    if not found then raise exception 'GUI % not found or not yours; fork it instead (fork_gui)', gid; end if;
  end if;
  select coalesce(max(gv.version), 0) + 1 into v from app.gui_versions gv where gv.gui_id = gid;
  insert into app.gui_versions (gui_id, version, code) values (gid, v, code);
  return jsonb_build_object('id', gid, 'version', v);
end $$;
revoke execute on function public.save_gui from public;
grant execute on function public.save_gui to anon, authenticated;

create or replace function public.get_gui(id uuid, version int default null) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', g.id, 'name', g.name, 'description', g.description, 'owner', u.username,
                            'icon', g.icon, 'color', g.color,
                            'reads', g.reads, 'forked_from', g.forked_from, 'version', v.version, 'code', v.code,
                            'versions', (select count(*) from app.gui_versions x where x.gui_id = g.id))
  from app.guis g join app.users u on u.id = g.owner
  join app.gui_versions v on v.gui_id = g.id
  where app.is_member() and g.id = get_gui.id and (get_gui.version is null or v.version = get_gui.version)
  order by v.version desc limit 1
$$;

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
  insert into app.gui_versions (gui_id, version, code) values (gid, 1, src->>'code');
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
          'version', (select max(v.version) from app.gui_versions v where v.gui_id = g.id))
        order by g.updated_at desc)
      from app.guis g join app.users u on u.id = g.owner), '[]'))
$$;
