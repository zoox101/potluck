// API rules, run against the linked (or local) Supabase project: npm test
// Creates throwaway users t?_<tag>@example.com and removes them afterwards.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { admin, client, createUser, keyClient, newUser, signIn, signUp } from '../scripts/api.mjs';

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
  await rejects(signUp(`stranger_${tag}@example.com`, 'password123'), /not been approved/);
});

test('members can not use admin functions', () => rejects(a('allow_email', { email: 'x@example.com' }), /permission denied/));

test('usernames must be valid and free; non-members see nothing', async () => {
  const email = `tc_${tag}@example.com`;
  emails.push(email);
  await admin('allow_email', { email });
  await createUser(email, 'password123');
  const c = client(await signIn(email, 'password123'));
  assert.deepEqual(await c('describe'), { me: null, help: 'https://zoox101.github.io/potluck/llms.txt' });
  await rejects(c('query', { sql: 'select 1' }), /claim a username/);
  await rejects(c('claim_username', { name: 'public' }), /not available/);
  await rejects(c('claim_username', { name: `ta_${tag}` }), /not available/);
  await rejects(c('create_table', { name: 'x' }), /claim a username/);
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

test('GUIs: owner saves versions, others fork, schema changes are guarded', async () => {
  const gui = await a('save_gui', { name: 'Items', code: '<p>v1</p>', reads: [T] });
  assert.equal((await a('save_gui', { id: gui.id, name: 'Items', code: '<p>v2</p>' })).version, 2);
  await rejects(b('save_gui', { id: gui.id, name: 'Mine now', code: 'x' }), /fork it instead/);
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

test('withdrawing approval locks a member out', async () => {
  await admin('disallow_email', { email: `tb_${tag}@example.com` });
  await rejects(b('insert_row', { table_name: T, data: { label: 'x' } }), /approved email/);
  await rejects(b('query', { sql: 'select 1' }), /approved email/);
  await admin('allow_email', { email: `tb_${tag}@example.com` });
});
