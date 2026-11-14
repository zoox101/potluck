import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { SDK, ALLOWED } from './sdk.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const main = document.getElementById('main');
const who = document.getElementById('who');
let cleanup = () => {};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

// Run an async action, showing any error in the page instead of failing silently.
const act = (fn) => async (e) => {
  e?.preventDefault?.();
  try { await fn(e); } catch (err) { showError(err); }
};
function showError(err) {
  let box = document.getElementById('error');
  if (!box) { box = document.createElement('p'); box.id = 'error'; box.className = 'error'; main.prepend(box); }
  box.textContent = err.message;
}

async function render() {
  cleanup(); cleanup = () => {};
  main.className = '';
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { who.innerHTML = ''; return renderLogin(); }
  const info = await rpc('describe');
  who.innerHTML = `<span class="muted">${esc(info.me ?? session.user.email)}</span> <button id="out">Sign out</button>`;
  document.getElementById('out').onclick = act(async () => { await sb.auth.signOut(); location.hash = '#/'; render(); });
  if (!info.me) return renderClaim();
  const [, route, id] = location.hash.split('/');
  if (route === 'gui' && id) return renderGui(id, info.me);
  renderDashboard(info);
}

function renderLogin() {
  main.innerHTML = `
    <form class="login">
      <h2>Sign in</h2>
      <input name="email" type="email" placeholder="Email" required autocomplete="username">
      <input name="password" type="password" placeholder="Password" required autocomplete="current-password">
      <div class="row"><button class="primary" value="in">Sign in</button><button value="up">Create account</button></div>
    </form>`;
  const form = main.querySelector('form');
  form.onsubmit = act(async (e) => {
    const creds = { email: form.email.value, password: form.password.value };
    if (e.submitter?.value === 'up') {
      // Send the confirmation link back to this page (not just the domain root).
      const { data, error } = await sb.auth.signUp({ ...creds, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (!data.session) throw new Error('Check your email for a confirmation link, then sign in.');
    } else {
      const { error } = await sb.auth.signInWithPassword(creds);
      if (error) throw error;
    }
    render();
  });
}

function renderClaim() {
  main.innerHTML = `
    <form class="login">
      <h2>Pick a username</h2>
      <p class="muted">Your tables live under it, e.g. <code>will.places</code>. It can't be changed later.</p>
      <input name="username" placeholder="username" autocapitalize="none" required>
      <span class="muted">Lowercase letters, digits and _, starting with a letter.</span>
      <button class="primary">Claim</button>
    </form>`;
  const form = main.querySelector('form');
  form.onsubmit = act(async () => {
    await rpc('claim_username', { name: form.elements.username.value.trim().toLowerCase() });
    render();
  });
}

function renderDashboard({ me, guis, tables }) {
  const names = Object.fromEntries(guis.map((g) => [g.id, g.name]));
  main.innerHTML = `
    <div class="row"><h2 style="margin-right:auto">Apps</h2><button id="new" class="primary">New app</button></div>
    <div class="grid">${guis.map((g) => `
      <div class="card">
        <strong>${esc(g.name)}</strong>
        <span class="muted">by ${esc(g.owner)} · v${g.version}${g.forked_from ? ` · forked from ${esc(names[g.forked_from] ?? 'a deleted app')}` : ''}</span>
        ${g.description ? `<span>${esc(g.description)}</span>` : ''}
        <div class="row">
          <a href="#/gui/${g.id}"><button>Open</button></a>
          ${g.owner === me ? `<button data-delete="${g.id}">Delete</button>` : `<button data-fork="${g.id}">Fork</button>`}
        </div>
      </div>`).join('') || '<p class="muted">No apps yet.</p>'}
    </div>
    <h2>Tables</h2>
    <div class="grid">${tables.map((t) => `
      <div class="card">
        <strong><code>${esc(t.table)}</code></strong>
        <span class="muted">${t.columns.map((c) => esc(c.name)).join(', ')}</span>
        ${t.read_by.length ? `<span class="muted">Read by ${t.read_by.map((id) => esc(names[id])).join(', ')}</span>` : ''}
      </div>`).join('') || '<p class="muted">No tables yet.</p>'}
    </div>`;
  main.querySelector('#new').onclick = act(async () => {
    const name = prompt('App name');
    if (!name) return;
    const { id } = await rpc('save_gui', { name, code: STARTER });
    location.hash = `#/gui/${id}`;
  });
  main.querySelectorAll('[data-fork]').forEach((b) => (b.onclick = act(async () => {
    const { id } = await rpc('fork_gui', { id: b.dataset.fork });
    location.hash = `#/gui/${id}`;
  })));
  main.querySelectorAll('[data-delete]').forEach((b) => (b.onclick = act(async () => {
    if (!confirm('Delete this app and all its versions?')) return;
    await rpc('delete_gui', { id: b.dataset.delete });
    render();
  })));
}

async function renderGui(id, me) {
  const gui = await rpc('get_gui', { id });
  if (!gui) throw new Error('App not found');
  const mine = gui.owner === me;
  main.className = 'full';
  main.innerHTML = `
    <div class="bar">
      <a href="#/"><button>&larr; Apps</button></a>
      <span class="title">${esc(gui.name)}</span>
      <span class="muted">by ${esc(gui.owner)} · v${gui.version} of ${gui.versions}</span>
      <button id="source">Source</button>
      ${mine ? '' : '<button id="fork">Fork</button>'}
    </div>
    <iframe sandbox="allow-scripts allow-forms allow-modals allow-popups" title="${esc(gui.name)}"></iframe>`;
  const frame = main.querySelector('iframe');
  cleanup = bridge(frame);
  frame.srcdoc = withSdk(gui.code);

  main.querySelector('#fork')?.addEventListener('click', act(async () => {
    const { id: forked } = await rpc('fork_gui', { id });
    location.hash = `#/gui/${forked}`;
  }));
  main.querySelector('#source').onclick = () => {
    if (main.querySelector('.source')) return render();
    frame.remove();
    main.insertAdjacentHTML('beforeend', `
      <div class="source">
        <span class="muted">${mine ? 'Saving creates a new version.' : 'Read-only. Fork this app to change it.'}</span>
        <textarea ${mine ? '' : 'readonly'}>${esc(gui.code)}</textarea>
        ${mine ? '<div class="row"><button class="primary" id="save">Save new version</button></div>' : ''}
      </div>`);
    main.querySelector('#save')?.addEventListener('click', act(async () => {
      await rpc('save_gui', { id, name: gui.name, code: main.querySelector('textarea').value });
      render();
    }));
  };
}

// Put the SDK first in <head> so GUI scripts can use `db` right away.
function withSdk(code) {
  return /<head[^>]*>/i.test(code) ? code.replace(/<head[^>]*>/i, (m) => m + SDK) : SDK + code;
}

// Relay a GUI's db calls and subscriptions through the signed-in session.
function bridge(frame) {
  const channels = [];
  const send = (msg) => frame.contentWindow?.postMessage(msg, '*');
  const onMessage = async (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data || {};
    if (m.type === 'call') {
      try {
        if (!ALLOWED.has(m.method)) throw new Error(`Unknown method ${m.method}`);
        send({ type: 'reply', id: m.id, data: await rpc(m.method, m.args) });
      } catch (err) {
        send({ type: 'reply', id: m.id, error: err.message });
      }
    }
    if (m.type === 'subscribe') {
      const [schema, table] = String(m.table).split('.');
      channels.push(sb.channel(`gui-${crypto.randomUUID()}`)
        .on('postgres_changes', { event: '*', schema, table }, (p) =>
          send({ type: 'change', sub: m.sub, payload: { event: p.eventType, new: p.new, old: p.old } }))
        .subscribe());
    }
  };
  addEventListener('message', onMessage);
  return () => { removeEventListener('message', onMessage); channels.forEach((c) => sb.removeChannel(c)); };
}

const STARTER = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>New app</title></head>
<body style="font-family: system-ui; padding: 16px">
  <h1>Hello!</h1>
  <p id="me"></p>
  <script>db.me().then((me) => (document.getElementById('me').textContent = 'Signed in as ' + me));</script>
</body>
</html>
`;

addEventListener('hashchange', act(render));
sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') setTimeout(act(render)); });
act(render)();
