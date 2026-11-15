-- Private file storage. One bucket, `files`; every path starts with its owner's username
-- (`will/taiwan/101.jpg`). Members read every file (through short-lived signed links); a member writes,
-- replaces and deletes only files under their own folder. Not public: nothing is reachable without a
-- member's session or agent key. Agent keys go through the `files` Edge Function, which checks the key
-- and applies the same rules.
insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create policy "members read files" on storage.objects for select to authenticated
  using (bucket_id = 'files' and (select app.is_member()));

create policy "members add own files" on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and (select app.is_member()) and (storage.foldername(name))[1] = (select app.me()));

create policy "members replace own files" on storage.objects for update to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = (select app.me()))
  with check (bucket_id = 'files' and (select app.is_member()) and (storage.foldername(name))[1] = (select app.me()));

create policy "members delete own files" on storage.objects for delete to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = (select app.me()));
