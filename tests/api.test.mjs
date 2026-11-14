// API rules, run against the linked (or local) Supabase project: npm test
// Creates throwaway users t?_<tag>@example.com and removes them afterwards.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { admin, client, createUser, keyClient, newUser, requestCode, signIn } from '../scripts/api.mjs';

const tag = Math.random().toString(36).slice(2, 8);
const emails = [];
const user = (name) => { emails.push(`${name}@example.com`); return newUser(name); };
after(async () => {
  for (const email of emails) {
    await admin('remove_user', { email }).catch(() => {});
    await admin('disallow_email', { email });
  }
});

const a = await user(`ta_${tag}`);
const b = await user(`tb_${tag}`);
const T = `ta_${tag}.items`;
const rejects = (p, re) => assert.rejects(p, re);

test('anonymous callers are refused', async () => {
  const anon = client();
  assert.deepEqual(await anon('describe'), { me: null, help: 'https://zoox101.github.io/potluck/llms.txt' });
  await rejects(anon('query', { sql: 'select 1' }), /claim a username/);
  await rejects(anon('create_table', { name: 'x' }), /claim a username/);
  await rejects(anon('allow_email', { email: 'x@example.com' }), /permission denied/);
  await rejects(anon('create_api_key', { name: 'x' }), /permission denied/);
  await rejects(keyClient('pk_wrong')('query', { sql: 'select 1' }), /claim a username/);
});

test('agent keys act as their owner, cannot make keys, and can be revoked', async () => {
  const key = await a('create_api_key', { name: 'test agent' });
  const agent = keyClient(key);
  assert.equal((await agent('describe')).me, `ta_${tag}`);
  assert.equal(await agent('create_table', { name: 'agent_made', columns: [{ name: 'note', type: 'text' }] }), `ta_${tag}.agent_made`);
  assert.equal(await agent('insert_rows', { table_name: `ta_${tag}.agent_made`, rows: [{ note: 'x' }, { note: 'y' }] }), 2);
  const [row] = await b('query', { sql: `select id, created_by from ta_${tag}.agent_made limit 1` });
  await rejects(b('delete_row', { table_name: `ta_${tag}.agent_made`, id: row.id }), /not yours/);
  await agent('delete_row', { table_name: `ta_${tag}.agent_made`, id: row.id });
  await rejects(agent('create_api_key', { name: 'nested' }), /permission denied/);
  await rejects(b('add_column', { table_name: `ta_${tag}.agent_made`, column_spec: { name: 'z' } }), /Only ta_/);
  const [listed] = await a('list_api_keys');
  assert.equal(listed.name, 'test agent');
  await a('revoke_api_key', { id: listed.id });
  await rejects(agent('query', { sql: 'select 1' }), /claim a username/);
  await a('drop_table', { table_name: `ta_${tag}.agent_made` });
});

test('only approved emails can sign up', async () => {
  await rejects(requestCode(`stranger_${tag}@example.com`), /not been approved/);
});

test('members can not use admin functions', () => rejects(a('allow_email', { email: 'x@example.com' }), /permission denied/));

test('the admin sets usernames when approving; members join with theirs', async () => {
  const email = `tc_${tag}@example.com`;
  emails.push(email);
  await rejects(admin('allow_email', { email }), /Give a username/);
  await rejects(admin('allow_email', { email, username: 'public' }), /reserved/);
  await rejects(admin('allow_email', { email, username: 'Bad Name' }), /lowercase/);
  await rejects(admin('allow_email', { email, username: `ta_${tag}` }), /taken/);
  await admin('allow_email', { email, username: `tz_${tag}` });
  await rejects(admin('allow_email', { email: `other_${tag}@example.com`, username: `tz_${tag}` }), /another email/);
  await admin('allow_email', { email, username: `tc_${tag}` }); // can change until they join
  await createUser(email);
  const c = client(await signIn(email));
  assert.deepEqual(await c('describe'), { me: null, help: 'https://zoox101.github.io/potluck/llms.txt' });
  await rejects(c('query', { sql: 'select 1' }), /claim a username/);
  await rejects(c('create_table', { name: 'x' }), /claim a username/);
  assert.equal(await c('claim_username'), `tc_${tag}`);
  assert.equal(await c('claim_username'), `tc_${tag}`); // joining twice is harmless
  assert.equal((await c('describe')).me, `tc_${tag}`);
  await rejects(admin('allow_email', { email, username: 'someone_else' }), /already a member/);
  const listed = (await admin('list_allowed_emails')).find((r) => r.email === email);
  assert.deepEqual(listed, { email, username: `tc_${tag}`, joined: true, signed_in: true });
});

test('the admin can create a member with a first agent key before they sign in', async () => {
  const email = `td_${tag}@example.com`;
  emails.push(email);
  await admin('allow_email', { email, username: `td_${tag}` });
  await createUser(email);
  const { username, key } = await admin('admin_add_member', { email });
  assert.equal(username, `td_${tag}`);
  assert.equal((await keyClient(key)('describe')).me, `td_${tag}`);
  const listed = (await admin('list_allowed_emails')).find((r) => r.email === email);
  assert.deepEqual([listed.joined, listed.signed_in], [true, false]);
  assert.equal(await client(await signIn(email))('claim_username'), `td_${tag}`); // first sign-in keeps the account
  const again = await admin('admin_add_member', { email }); // resending replaces the welcome key
  assert.equal((await keyClient(again.key)('describe')).me, `td_${tag}`);
  await rejects(keyClient(key)('query', { sql: 'select 1' }), /claim a username/);
  assert.equal((await admin('admin_list_keys', { email })).filter((k) => k.name === 'Welcome key').length, 1);
  await rejects(admin('admin_add_member', { email: `nobody_${tag}@example.com` }), /No account/);
  await rejects(a('admin_add_member', { email }), /permission denied/);
});

test('owner creates a table; schema changes are owner-only', async () => {
  assert.equal(await a('create_table', { name: 'items', columns: [{ name: 'label', type: 'text', required: true }] }), T);
  await rejects(a('create_table', { name: 'items' }), /already exists/);
  await rejects(a('create_table', { name: 'bad', columns: [{ name: 'x', type: 'money' }] }), /Unsupported type/);
  await rejects(b('add_column', { table_name: T, column_spec: { name: 'x' } }), /Only ta_/);
  await rejects(b('drop_table', { table_name: T }), /Only ta_/);
  await a('add_column', { table_name: T, column_spec: { name: 'qty', type: 'integer' } });
});

test('anyone adds rows; only the creator edits or deletes them', async () => {
  const mine = await a('insert_row', { table_name: T, data: { label: 'a1' } });
  const theirs = await b('insert_row', { table_name: T, data: { label: 'b1', qty: 2 } });
  assert.equal(theirs.qty, 2);
  await rejects(b('insert_row', { table_name: T, data: { label: 'x', created_by: mine.created_by } }), /set automatically/);
  await rejects(a('update_row', { table_name: T, id: theirs.id, data: { label: 'hacked' } }), /not yours/);
  await rejects(a('delete_row', { table_name: T, id: theirs.id }), /not yours/);
  assert.equal((await b('update_row', { table_name: T, id: theirs.id, data: { label: 'b2' } })).label, 'b2');
  assert.equal((await b('delete_row', { table_name: T, id: theirs.id })).id, theirs.id);
  await rejects(a('insert_row', { table_name: 'nobody.items', data: { label: 'x' } }), /Unknown table/);
});

test('query is read-only and can join across users', async () => {
  await b('create_table', { name: 'notes', columns: [{ name: 'item_id', type: 'bigint' }, { name: 'note', type: 'text' }] });
  const [item] = await a('query', { sql: `select id from ${T} where label = 'a1'` });
  await b('insert_row', { table_name: `tb_${tag}.notes`, data: { item_id: item.id, note: 'nice' } });
  const rows = await b('query', { sql: `select i.label, n.note from ${T} i join tb_${tag}.notes n on n.item_id = i.id;` });
  assert.deepEqual(rows, [{ label: 'a1', note: 'nice' }]);
  await rejects(a('query', { sql: `delete from ${T}` }), /syntax error|not allowed/);
  await rejects(a('query', { sql: `select 1) q; drop table ${T}; select (1` }), /not allowed|cannot|syntax/);
  await rejects(a('query', { sql: 'select * from auth.users' }), /permission denied/);
  await rejects(a('query', { sql: 'select * from app.allowed_emails' }), /permission denied/);
  assert.equal((await a('query', { sql: `select count(*)::int as n from ${T}` }))[0].n, 1);
});

test('GUIs: anyone saves code versions, only the owner deletes, schema changes are guarded', async () => {
  await rejects(a('save_gui', { name: 'Old', code: 'x' }), /save_gui|function/);
  const gui = await a('create_gui', { name: 'Items', code: '<p>v1</p>', reads: [T] });
  assert.equal(gui.version, 1);
  assert.equal((await b('update_gui_code', { id: gui.id, code: '<p>b edit</p>' })).version, 2);
  const latest = await a('get_gui', { id: gui.id });
  assert.deepEqual([latest.owner, latest.saved_by, latest.code], [`ta_${tag}`, `tb_${tag}`, '<p>b edit</p>']);
  assert.equal((await a('describe')).guis.find((g) => g.id === gui.id).updated_by, `tb_${tag}`);
  assert.equal((await a('get_gui', { id: gui.id, version: 1 })).saved_by, `ta_${tag}`);
  assert.equal((await a('update_gui_code', { id: gui.id, code: '<p>v2</p>' })).version, 3);
  await rejects(b('update_gui_code', { id: '00000000-0000-0000-0000-000000000000', code: 'x' }), /not found/);
  await rejects(a('create_gui', { name: 'No code' }), /code is required|Could not find the function/);
  await rejects(a('update_gui_code', { id: gui.id, code: 'x', reads: ['nobody.nothing'] }), /Unknown table/);
  await rejects(b('delete_gui', { id: gui.id }), /not yours/);
  const fork = await b('fork_gui', { id: gui.id });
  const forked = await b('get_gui', { id: fork.id });
  assert.equal(forked.forked_from, gui.id);
  assert.equal(forked.code, '<p>v2</p>');
  assert.equal((await a('get_gui', { id: gui.id, version: 1 })).code, '<p>v1</p>');

  await rejects(a('drop_column', { table_name: T, column_name: 'qty' }), /These GUIs read/);
  await a('drop_column', { table_name: T, column_name: 'qty', force: true });
  const info = await a('describe');
  assert.equal(info.me, `ta_${tag}`);
  assert.ok(info.tables.find((t) => t.table === T).read_by.includes(gui.id));
});

test('GUI metadata changes without new versions; omitted fields are kept; forks copy icons', async () => {
  const gui = await a('create_gui', { name: 'Icons', code: 'x', icon: 'map-pin', color: '#2f6fd6' });
  let g = await a('get_gui', { id: gui.id });
  assert.deepEqual([g.icon, g.color, g.visibility, g.updated_by], ['map-pin', '#2f6fd6', 'default', `ta_${tag}`]);
  await a('update_gui_code', { id: gui.id, code: 'y' });
  g = (await a('describe')).guis.find((x) => x.id === gui.id);
  assert.deepEqual([g.icon, g.color, g.version], ['map-pin', '#2f6fd6', 2]);

  g = await b('update_gui_metadata', { id: gui.id, name: 'Renamed', visibility: 'starred' });
  assert.deepEqual([g.name, g.icon, g.visibility, g.version, g.updated_by], ['Renamed', 'map-pin', 'starred', 2, `tb_${tag}`]);
  assert.equal((await a('get_gui', { id: gui.id })).versions, 2);
  await b('update_gui_metadata', { id: gui.id, visibility: 'hidden' });
  assert.equal((await a('describe')).guis.find((x) => x.id === gui.id).visibility, 'hidden');

  const fork = await b('fork_gui', { id: gui.id });
  const forked = await b('get_gui', { id: fork.id });
  assert.deepEqual([forked.icon, forked.visibility, forked.owner], ['map-pin', 'default', `tb_${tag}`]);

  await rejects(a('update_gui_metadata', { id: gui.id, icon: 'Not An Icon' }), /check constraint/);
  await rejects(a('update_gui_metadata', { id: gui.id, color: 'blue' }), /check constraint/);
  await rejects(a('update_gui_metadata', { id: gui.id, visibility: 'secret' }), /check constraint/);
  await rejects(a('update_gui_metadata', { id: gui.id, name: '  ' }), /can't be empty/);
  g = await a('update_gui_metadata', { id: gui.id, icon: '', color: '' });
  assert.deepEqual([g.icon, g.color, g.name], [null, null, 'Renamed']);
});

test('withdrawing approval locks a member out', async () => {
  await admin('disallow_email', { email: `tb_${tag}@example.com` });
  await rejects(b('insert_row', { table_name: T, data: { label: 'x' } }), /approved email/);
  await rejects(b('query', { sql: 'select 1' }), /approved email/);
  await admin('allow_email', { email: `tb_${tag}@example.com` });
});
