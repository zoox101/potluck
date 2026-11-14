-- The admin creates a member's account and a first agent key when approving them, so the
-- getting-started email can include the key. Joining is shared by claim_username (first sign-in)
-- and admin_add_member.

-- Make user `uid` (email `e`) a member under the username reserved for that email. Idempotent.
create function app.join(uid uuid, e text) returns text language plpgsql security definer set search_path = '' as $$
declare name text; problem text; current text;
begin
  select username into current from app.users where id = uid;
  if current is not null then return current; end if;
  select a.username into name from app.allowed_emails a where a.email = lower(e);
  if name is null then raise exception 'No username has been set for %. Ask the group admin to approve it with one.', e; end if;
  problem := app.username_problem(name, e);
  if problem is not null then raise exception 'The username "%" can''t be used (%). Ask the group admin to pick another.', name, problem; end if;
  insert into app.users (id, username) values (uid, name);
  execute format('create schema %I', name);
  execute format('grant usage on schema %I to anon, authenticated', name);
  return name;
end $$;
revoke execute on function app.join from public, anon, authenticated;

create or replace function public.claim_username() returns text language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in to the site to join'; end if;
  if not app.approved(auth.uid()) then raise exception 'This email has not been approved'; end if;
  return app.join(auth.uid(), (select u.email from auth.users u where u.id = auth.uid()));
end $$;

-- Admin only: make an existing, approved account a member and give it a new agent key.
create function public.admin_add_member(email text, key_name text default 'Welcome key') returns jsonb
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare uid uuid; name text; k text := 'pk_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  select u.id into uid from auth.users u where lower(u.email) = lower(btrim(email));
  if uid is null then raise exception 'No account for %; create it first', email; end if;
  if not app.approved(uid) then raise exception '% has not been approved', email; end if;
  name := app.join(uid, email);
  insert into app.api_keys (user_id, name, key_hash) values (uid, key_name, encode(extensions.digest(k, 'sha256'), 'hex'));
  return jsonb_build_object('username', name, 'key', k);
end $$;
revoke execute on function public.admin_add_member from public, anon, authenticated;
grant execute on function public.admin_add_member to service_role;

-- The list now also says whether each person has ever signed in.
create or replace function public.list_allowed_emails() returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('email', a.email, 'username', coalesce(u.username, a.username),
                                               'joined', u.id is not null,
                                               'signed_in', au.last_sign_in_at is not null) order by a.email), '[]')
  from app.allowed_emails a
  left join auth.users au on lower(au.email) = a.email
  left join app.users u on u.id = au.id
$$;
