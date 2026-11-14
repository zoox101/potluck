How agents (and people with `curl`) use Potluck. GUIs use the same functions through `window.db`.

## Connecting

Every call needs the project's public key and your access token.

```bash
URL=http://127.0.0.1:54321      # local; the hosted project URL later
KEY=...                         # the anon key, as in web/config.js

# Get an access token (valid 1 hour) by signing in:
TOKEN=$(curl -s "$URL/auth/v1/token?grant_type=password" -H "apikey: $KEY" \
  -H 'Content-Type: application/json' -d '{"email":"will@example.com","password":"password123"}' | jq -r .access_token)

# Call a function: POST /rest/v1/rpc/<function> with JSON arguments.
curl -s "$URL/rest/v1/rpc/describe" -H "apikey: $KEY" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
```

**Start with `describe`.** It lists every table (with columns and which GUIs read it) and every GUI. Accounts need an email the admin has approved; a new account first calls `claim_username`.

## Rules

- Tables are named `owner.table`. You can only create tables under your own username, and only the owner changes a table's schema.
- Anyone can read every table and add rows. Only a row's creator can update or delete it.
- Every table gets `id`, `created_by`, `created_at` and `updated_at` automatically; don't set them.
- To add your own information to someone else's table, create your own table that references their `id` (e.g. `kevin.votes.place_id` → `will.places.id`) and join them in `query`.
- GUIs belong to their owner. To change someone else's GUI, fork it.

## Functions

| Function | Arguments | Returns |
|---|---|---|
| `claim_username` | `name` | the username; also creates your schema |
| `describe` | | `{me, tables, guis}` |
| `create_table` | `name`, `columns`: `[{name, type, required?}]` | `owner.table` |
| `add_column` | `table_name`, `column_spec`: `{name, type, required?}` | `owner.table` |
| `drop_column` | `table_name`, `column_name`, `force?` | `owner.table` |
| `drop_table` | `table_name`, `force?` | `owner.table` |
| `insert_row` | `table_name`, `data` | the new row |
| `update_row` | `table_name`, `id`, `data` | the updated row |
| `delete_row` | `table_name`, `id` | the deleted row |
| `query` | `sql` (one read-only `SELECT`; use `owner.table` names) | array of rows |
| `save_gui` | `name`, `code`, `description?`, `reads?`, `id?` (omit to create) | `{id, version}` |
| `get_gui` | `id`, `version?` (default latest) | the GUI with its `code` and version count |
| `fork_gui` | `id`, `name?` | `{id, version}` of your copy |
| `delete_gui` | `id` | `id` |

Column types: `text`, `integer`, `bigint`, `numeric`, `boolean`, `date`, `timestamptz`, `jsonb`, `uuid`.

`drop_column` and `drop_table` refuse while a GUI lists the table in its `reads`; the error names those GUIs. Pass `force: true` only after checking with their owners. To roll a GUI back, `get_gui` the old version and `save_gui` its code.

## Writing a GUI

A GUI is one HTML document. It runs in a sandboxed iframe with a `db` object already defined:

```js
await db.query('select * from will.places');        // read (joins allowed)
await db.insert('will.places', { name: 'Taipei 101' });
await db.update('will.places', 3, { notes: 'Go at sunset' });
await db.remove('will.places', 3);
await db.createTable('votes', [{ name: 'place_id', type: 'bigint' }]);
await db.addColumn('will.places', { name: 'rating', type: 'integer' });
await db.describe(); await db.me();
db.subscribe('will.places', ({ event, new: row, old }) => { /* live updates */ });
```

Save it with `save_gui`, listing the tables it reads in `reads` so owners get warned before breaking it. See [examples/trip-places.html](examples/trip-places.html).
