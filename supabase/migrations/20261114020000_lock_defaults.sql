-- New functions in public must be granted explicitly; nothing is callable anonymously.
revoke execute on function public.describe from public, anon;
alter default privileges in schema public revoke execute on functions from public, anon;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon;
