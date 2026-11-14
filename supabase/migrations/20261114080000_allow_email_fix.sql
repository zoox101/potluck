-- allow_email: name the conflict constraint, since `email` inside the function means the parameter.
create or replace function public.allow_email(email text, username text default null) returns text
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare e text := lower(btrim(email)); member text; problem text;
begin
  select u.username into member from app.users u join auth.users a on a.id = u.id where lower(a.email) = e;
  if member is not null then
    if username is not null and username <> member then
      raise exception '% is already a member as %; usernames can''t change once claimed', e, member;
    end if;
    insert into app.allowed_emails as a (email, username) values (e, member)
      on conflict on constraint allowed_emails_pkey do update set username = excluded.username;
    return format('%s (%s)', e, member);
  end if;
  if username is null then raise exception 'Give a username for %, e.g. allow_email(email, ''alice'')', e; end if;
  problem := app.username_problem(username, e);
  if problem is not null then raise exception 'Username "%" can''t be used: %', username, problem; end if;
  insert into app.allowed_emails as a (email, username) values (e, username)
    on conflict on constraint allowed_emails_pkey do update set username = excluded.username;
  return format('%s (%s)', e, username);
end $$;
