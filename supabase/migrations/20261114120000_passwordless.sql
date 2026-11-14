-- Sign-in is passwordless (an emailed link or code). Clear any passwords set before the switch.
update auth.users set encrypted_password = '' where coalesce(encrypted_password, '') <> '';

-- Leftover from an abandoned admin command; nothing uses it.
drop function if exists public.remove_password(text);
