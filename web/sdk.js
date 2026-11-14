// Injected into every GUI. GUIs run in a sandboxed iframe and reach the database
// only through `window.db`, which forwards calls to the shell over postMessage.
export const SDK = `<script>
(() => {
  let n = 0; const pending = {}; const subs = {};
  addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const m = e.data || {};
    if (m.type === 'reply' && pending[m.id]) {
      const p = pending[m.id]; delete pending[m.id];
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.data);
    }
    if (m.type === 'change' && subs[m.sub]) subs[m.sub](m.payload);
  });
  const call = (method, args = {}) => new Promise((resolve, reject) => {
    const id = ++n; pending[id] = { resolve, reject };
    parent.postMessage({ type: 'call', id, method, args }, '*');
  });
  window.db = {
    call,
    query: (sql) => call('query', { sql }),
    insert: (table_name, data) => call('insert_row', { table_name, data }),
    update: (table_name, id, data) => call('update_row', { table_name, id, data }),
    remove: (table_name, id) => call('delete_row', { table_name, id }),
    createTable: (name, columns) => call('create_table', { name, columns }),
    addColumn: (table_name, column_spec) => call('add_column', { table_name, column_spec }),
    describe: () => call('describe'),
    me: () => call('describe').then((d) => d.me),
    subscribe: (table, fn) => { const sub = ++n; subs[sub] = fn; parent.postMessage({ type: 'subscribe', sub, table }, '*'); },
  };
})();
<\/script>`;

// Methods a GUI may call. GUI management stays in the shell.
export const ALLOWED = new Set(['query', 'insert_row', 'update_row', 'delete_row', 'create_table', 'add_column', 'describe']);
