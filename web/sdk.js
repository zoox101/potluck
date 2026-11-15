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
  // Files are private: show one with a short-lived signed link. fileUrl batches requests made in the
  // same moment and reuses a link until it's within an hour of expiring (links last a day).
  const links = new Map(); let queue = null;
  const fileUrl = (path) => {
    const hit = links.get(path);
    if (hit && hit.until > Date.now()) return hit.url;
    if (!queue) {
      queue = new Map();
      setTimeout(() => {
        const batch = queue; queue = null;
        call('file_urls', { paths: [...batch.keys()] }).then((urls) => {
          for (const [p, waiters] of batch) {
            const url = urls[p];
            if (url) links.set(p, { url: Promise.resolve(url), until: Date.now() + 23 * 3600e3 });
            waiters.forEach(([ok, fail]) => (url ? ok(url) : fail(new Error('File not found: ' + p))));
          }
        }, (err) => batch.forEach((waiters) => waiters.forEach(([, fail]) => fail(err))));
      }, 10);
    }
    const url = new Promise((ok, fail) => { if (!queue.has(path)) queue.set(path, []); queue.get(path).push([ok, fail]); });
    links.set(path, { url, until: Date.now() + 60e3 });
    return url;
  };
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
    upload: (path, file, contentType) => call('file_upload', { path, file, contentType }),
    fileUrl,
    listFiles: (folder = '') => call('file_list', { folder }),
    removeFile: (path) => call('file_remove', { path }),
  };
})();
<\/script>`;

// Methods a GUI may call. GUI management stays in the shell.
export const ALLOWED = new Set(['query', 'insert_row', 'update_row', 'delete_row', 'create_table', 'add_column', 'describe']);
