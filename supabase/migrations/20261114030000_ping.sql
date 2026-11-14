-- Anonymous keep-alive used by the scheduled GitHub Action; reveals nothing.
create function public.ping() returns timestamptz language sql stable set search_path = '' as $$ select now() $$;
grant execute on function public.ping to anon, authenticated;
