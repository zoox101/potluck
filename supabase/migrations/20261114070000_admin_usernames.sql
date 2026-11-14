-- The admin picks each member's username when approving their email; members no longer choose.
-- On first sign-in the shell calls claim_username(), which takes the reserved name.

alter table app.allowed_emails add column username text unique;

-- Why a username can't be used, or null if it can. `except_email` skips that email's own reservation.
create function app.username_problem(name text, except_email text default null) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when name is null or name !~ '^[a-z][a-z0-9_]{1,30}$' then 'use 2-31 lowercase letters, digits or _, starting with a letter'
    when name ~ '^(pg_|supabase)' or name in ('app', 'public', 'auth', 'storage', 'realtime', 'extensions',
         'graphql', 'graphql_public', 'vault', 'net', 'cron') then 'it is reserved'
    when exists (select 1 from pg_namespace where nspname = name) then 'it is taken'
    when exists (select 1 from app.allowed_emails a where a.username = name
                 and a.email is distinct from lower(except_email)) then 'it is set aside for another email'
  end
$$;
revoke execute on function app.username_problem from public, anon, authenticated;

-- Approve an email with the username its owner will get. Re-approving a member keeps their username.
drop function public.allow_email(text);
create function public.allow_email(email text, username text default null) returns text
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare e text := lower(btrim(email)); member text; problem text;
begin
  select u.username into member from app.users u join auth.users a on a.id = u.id where lower(a.email) = e;
  if member is not null then
    if username is not null and username <> member then
      raise exception '% is already a member as %; usernames can''t change once claimed', e, member;
    end if;
    insert into app.allowed_emails (email, username) values (e, member)
      on conflict (email) do update set username = excluded.username;
    return format('%s (%s)', e, member);
  end if;
  if username is null then raise exception 'Give a username for %, e.g. allow_email(email, ''alice'')', e; end if;
  problem := app.username_problem(username, e);
  if problem is not null then raise exception 'Username "%" can''t be used: %', username, problem; end if;
  insert into app.allowed_emails (email, username) values (e, username)
    on conflict (email) do update set username = excluded.username;
  return format('%s (%s)', e, username);
end $$;
revoke execute on function public.allow_email from public, anon, authenticated;
grant execute on function public.allow_email to service_role;

-- Join: take the username the admin reserved for this email.
drop function public.claim_username(text);
create function public.claim_username() returns text language plpgsql security definer set search_path = '' as $$
declare e text; name text; problem text;
begin
  if auth.uid() is null then raise exception 'Sign in to the site to join'; end if;
  if not app.approved(auth.uid()) then raise exception 'This email has not been approved'; end if;
  if app.me() is not null then return app.me(); end if;
  select lower(u.email) into e from auth.users u where u.id = auth.uid();
  select a.username into name from app.allowed_emails a where a.email = e;
  if name is null then raise exception 'No username has been set for %. Ask the group admin to approve it with one.', e; end if;
  problem := app.username_problem(name, e);
  if problem is not null then raise exception 'Your username "%" can''t be used (%). Ask the group admin to pick another.', name, problem; end if;
  insert into app.users (id, username) values (auth.uid(), name);
  execute format('create schema %I', name);
  execute format('grant usage on schema %I to anon, authenticated', name);
  return name;
end $$;
revoke execute on function public.claim_username from public, anon;
grant execute on function public.claim_username to authenticated;

-- Approved emails with their usernames and whether they have joined.
drop function public.list_allowed_emails();
create function public.list_allowed_emails() returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('email', a.email, 'username', coalesce(u.username, a.username),
                                               'joined', u.id is not null) order by a.email), '[]')
  from app.allowed_emails a
  left join auth.users au on lower(au.email) = a.email
  left join app.users u on u.id = au.id
$$;
revoke execute on function public.list_allowed_emails from public, anon, authenticated;
grant execute on function public.list_allowed_emails to service_role;

-- Existing members keep their usernames on the list.
update app.allowed_emails a set username = u.username
  from auth.users au join app.users u on u.id = au.id
  where lower(au.email) = a.email;
