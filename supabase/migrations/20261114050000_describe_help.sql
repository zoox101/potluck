-- describe() always points callers at the agent instructions.
create or replace function public.describe() returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare help constant jsonb := jsonb_build_object('help', 'https://zoox101.github.io/potluck/llms.txt');
begin
  if not app.is_member() then return jsonb_build_object('me', null) || help; end if;
  return public.describe_all() || help;
end $$;
