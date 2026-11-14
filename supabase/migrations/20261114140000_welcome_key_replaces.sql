-- Resending the getting-started email replaces the member's earlier welcome key instead of piling up keys.
create or replace function public.admin_add_member(email text, key_name text default 'Welcome key') returns jsonb
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare uid uuid; name text; k text := 'pk_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  select u.id into uid from auth.users u where lower(u.email) = lower(btrim(email));
  if uid is null then raise exception 'No account for %; create it first', email; end if;
  if not app.approved(uid) then raise exception '% has not been approved', email; end if;
  name := app.join(uid, email);
  delete from app.api_keys a where a.user_id = uid and a.name = key_name;
  insert into app.api_keys (user_id, name, key_hash) values (uid, key_name, encode(extensions.digest(k, 'sha256'), 'hex'));
  return jsonb_build_object('username', name, 'key', k);
end $$;

-- Admin only: how many agent keys each member has, by name (to check welcome keys were replaced).
create function public.admin_list_keys(email text) returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', k.name, 'created_at', k.created_at) order by k.created_at), '[]')
  from app.api_keys k join auth.users u on u.id = k.user_id where lower(u.email) = lower(btrim(admin_list_keys.email))
$$;
revoke execute on function public.admin_list_keys from public, anon, authenticated;
grant execute on function public.admin_list_keys to service_role;
