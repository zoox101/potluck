-- Admin only: move an approved email (and its username reservation) to a new address and return the
-- account's id, so the admin script can then change the sign-in email through the Auth admin API.
create function public.admin_change_email(old_email text, new_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o text := lower(btrim(old_email)); n text := lower(btrim(new_email)); uid uuid;
begin
  if n !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Not an email address: %', new_email; end if;
  if not exists (select 1 from app.allowed_emails a where a.email = o) then raise exception '% is not approved', old_email; end if;
  if exists (select 1 from app.allowed_emails a where a.email = n) or exists (select 1 from auth.users u where lower(u.email) = n) then
    raise exception '% is already in use', new_email;
  end if;
  update app.allowed_emails set email = n where email = o;
  select u.id into uid from auth.users u where lower(u.email) = o;
  return jsonb_build_object('user_id', uid, 'email', n);
end $$;
revoke execute on function public.admin_change_email from public, anon, authenticated;
grant execute on function public.admin_change_email to service_role;
