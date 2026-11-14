import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js?v=dev';
import { SDK, ALLOWED } from './sdk.js?v=dev';

// Sign-in links come back as ?login=<email>, plus #error_code=... when the link had expired or was
// already used. Note both before Supabase reads the URL, then tidy the address bar.
const arrival = (() => {
  const login = new URLSearchParams(location.search).get('login') || '';
  const failed = /(^|&)error(_code)?=/.test(location.hash.slice(1));
  if (login || failed) history.replaceState(null, '', location.pathname + (failed ? '#/view' : location.hash));
  return { login, expired: failed };
})();
const loginRedirect = (email) => `${location.origin}${location.pathname}?login=${encodeURIComponent(email)}`;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const main = document.getElementById('main');
const topBar = document.getElementById('top');
const drawer = document.getElementById('drawer');
let cleanup = () => {};
let info = null; // latest describe() result while signed in; feeds the drawer

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

// ---------- icons (Lucide, https://lucide.dev/icons) ----------

const ICONS = 'https://cdn.jsdelivr.net/npm/lucide-static@0.460.0/icons/';
const ICON_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const icon = (name) => `<span class="ico" style="--icon:url(${ICONS}${name}.svg)" aria-hidden="true"></span>`;

// Apps without a color get a stable one picked from their name.
const PALETTE = ['#2f6fd6', '#d65a31', '#2e9d6a', '#8a4fd6', '#d6a531', '#d63f7a', '#2c9ab0', '#6b7a2e'];
const colorFor = (g) => g.color || PALETTE[[...g.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];

// An app's tile shows its initial until its icon is confirmed to exist (unknown names 404).
const known = new Map(); // icon name -> Promise<boolean>
const iconExists = (name) => {
  if (!known.has(name)) known.set(name, fetch(`${ICONS}${name}.svg`).then((r) => r.ok, () => false));
  return known.get(name);
};
function tile(g, size = '') {
  const initial = esc([...(g.name || '?').trim()][0]?.toUpperCase() ?? '?');
  const name = ICON_RE.test(g.icon ?? '') ? g.icon : '';
  return `<span class="tile ${size}" style="--c:${colorFor(g)}" data-icon="${name}">${initial}</span>`;
}
function hydrateTiles(root) {
  root.querySelectorAll('.tile[data-icon]:not([data-icon=""])').forEach(async (el) => {
    const name = el.dataset.icon;
    el.removeAttribute('data-icon');
    if (await iconExists(name)) el.innerHTML = icon(name);
  });
}

// ---------- routing ----------

async function render() {
  cleanup(); cleanup = () => {};
  closeDrawer();
  main.className = '';
  const [, route, id] = location.hash.split('/');
  if (route === 'edit') { info = null; renderSignedOutTop(); return renderEditGuide(); }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    info = null;
    renderSignedOutTop();
    if (arrival.expired) {
      arrival.expired = false;
      return renderLogin(arrival.login, 'That sign-in link has expired or was already used. Tap the button for a new one.');
    }
    return route === 'view' ? renderLogin() : renderStart();
  }
  let described = await rpc('describe');
  if (!described.me) {
    // First sign-in: take the username the admin set when approving this email.
    try {
      await rpc('claim_username');
      described = await rpc('describe');
    } catch (err) {
      info = null;
      topBar.className = '';
      topBar.innerHTML = `<a href="#/" class="brand"><img src="icons/icon-192.png" class="brand-mark" alt="">Potluck</a><span><span class="muted">${esc(session.user.email)}</span> <button id="out">Sign out</button></span>`;
      topBar.querySelector('#out').onclick = act(signOut);
      return renderJoinProblem(err);
    }
  }
  info = { ...described, email: session.user.email };
  if (route === 'gui' && id) return renderGui(id);
  if (route === 'settings') return renderSettings();
  renderDashboard();
}

async function signOut() {
  await sb.auth.signOut();
  location.hash = '#/';
  render();
}

function renderSignedOutTop() {
  topBar.className = '';
  topBar.innerHTML = '<a href="#/" class="brand"><img src="icons/icon-192.png" class="brand-mark" alt="">Potluck</a>';
}

// The one bar for signed-in pages: menu button and the current page's title.
function renderTop(title, g = null) {
  topBar.className = 'signed-in';
  topBar.innerHTML = `
    <button class="icon-button" id="menu" aria-label="Open menu" aria-controls="drawer">${icon('menu')}</button>
    <a href="#/" class="top-title">${g ? tile(g, 'sm') : '<img src="icons/icon-192.png" class="brand-mark" alt="">'}<span>${esc(title)}</span></a>`;
  topBar.querySelector('#menu').onclick = openDrawer;
  hydrateTiles(topBar);
}

// ---------- drawer ----------

function openDrawer() {
  if (!info) return;
  const [, route, id] = location.hash.split('/');
  const current = route === 'gui' ? id : route === 'settings' ? 'settings' : 'home';
  drawer.innerHTML = `
    <button class="scrim" aria-label="Close menu" tabindex="-1"></button>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="Menu">
      <div class="drawer-head">
        <a href="#/" class="brand"><img src="icons/icon-192.png" class="brand-mark" alt="">Potluck</a>
        <button class="icon-button" id="close" aria-label="Close menu">${icon('x')}</button>
      </div>
      <label class="drawer-search">${icon('search')}<span hidden>Search apps</span>
        <input type="search" placeholder="Search apps" autocomplete="off" spellcheck="false"></label>
      <nav></nav>
      <div class="drawer-foot">
        <a href="#/settings" class="nav-item ${current === 'settings' ? 'active' : ''}">${icon('settings')}<span>Settings</span></a>
      </div>
    </aside>`;
  const input = drawer.querySelector('input');
  const nav = drawer.querySelector('nav');
  let hl = 0;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const apps = listedApps().filter((g) => !q || `${g.name} ${g.description} ${g.owner}`.toLowerCase().includes(q));
    hl = Math.min(hl, Math.max(apps.length - 1, 0));
    nav.innerHTML = `
      ${q ? '' : `<a href="#/" class="nav-item ${current === 'home' ? 'active' : ''}">${icon('layout-grid')}<span class="name">All apps</span></a>`}
      <div class="nav-label">Apps</div>
      ${apps.map((g, i) => `
        <a href="#/gui/${g.id}" class="nav-item app ${g.visibility === 'hidden' ? 'is-hidden' : ''} ${g.id === current ? 'active' : ''} ${q && i === hl ? 'hl' : ''}"
           ${g.visibility === 'hidden' ? 'title="Hidden: only you see it in the list"' : ''}>${tile(g)}<span class="name">${esc(g.name)}</span>${badge(g)}</a>`).join('')
        || `<p class="nav-empty">${q ? 'No apps match that search.' : 'No apps yet.'}</p>`}`;
    hydrateTiles(nav);
    nav.querySelector('.hl')?.scrollIntoView({ block: 'nearest' });
  };
  input.oninput = () => { hl = 0; draw(); };
  input.onkeydown = (e) => {
    const items = nav.querySelectorAll('.nav-item.app');
    if (e.key === 'ArrowDown') { e.preventDefault(); hl = Math.min(hl + 1, items.length - 1); draw(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(hl - 1, 0); draw(); }
    if (e.key === 'Enter') {
      const pick = input.value.trim() ? items[hl] : null;
      if (pick) { e.preventDefault(); closeDrawer(); location.hash = pick.getAttribute('href'); }
    }
  };
  // Links close the drawer; following the current page's link re-renders nothing, so close explicitly.
  drawer.onclick = (e) => { if (e.target.closest('a, .scrim, #close')) closeDrawer(); };
  draw();
  drawer.hidden = false;
  document.body.style.overflow = 'hidden';
  // Phones get the search box at the bottom; focusing it would pop the keyboard over the list.
  if (matchMedia('(min-width: 768px)').matches) input.focus();
}

function closeDrawer() {
  if (drawer.hidden) return;
  drawer.hidden = true;
  drawer.innerHTML = '';
  document.body.style.overflow = '';
  topBar.querySelector('#menu')?.focus();
}

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && info) {
    e.preventDefault();
    drawer.hidden ? openDrawer() : closeDrawer();
  }
});

// ---------- signed-out pages ----------

// Two ways in: people view the dashboard by signing in; editing goes through the API.
function renderStart() {
  main.innerHTML = `
    <h2>Potluck</h2>
    <p>A dashboard of apps that a group of friends builds together. There are two ways to use it:</p>
    <div class="grid">
      <div class="card">
        <strong>View dashboard</strong>
        <span>Open and use the apps. Sign in with an approved email; no password needed.</span>
        <div class="row"><a href="#/view"><button>View dashboard</button></a></div>
      </div>
      <div class="card">
        <strong>Edit dashboard</strong>
        <span>Add or change apps and their data. Done through the Potluck API with an agent key; no sign-in needed.</span>
        <div class="row"><a href="#/edit"><button>Edit dashboard</button></a></div>
      </div>
    </div>`;
}

// The editing guide (llms.txt), shown in the page so the edit route is self-explanatory.
async function renderEditGuide() {
  main.innerHTML = `
    <div class="row"><a href="#/"><button>&larr; Back</button></a><h2 style="margin:0">Edit dashboard</h2></div>
    <p>Apps and data are added and changed through the Potluck API with an agent key, as described below.
    The same guide is at <a href="llms.txt">https://zoox101.github.io/potluck/llms.txt</a>.</p>
    <pre id="guide" class="card" style="white-space:pre-wrap;margin:0">Loading the guide...</pre>`;
  main.querySelector('#guide').textContent = await fetch('llms.txt').then((r) => r.text());
}

// Passwordless sign-in: email a link plus a code; either one signs you in.
function renderLogin(email = '', notice = '') {
  main.innerHTML = `
    <form class="login">
      <a href="#/" class="muted">&larr; Back</a>
      <h2>Sign in to view the dashboard</h2>
      ${notice ? `<p class="notice">${esc(notice)}</p>` : ''}
      <p class="muted" style="margin:0">No password needed: we'll email you a sign-in link and code. Your email has to be approved by the group admin.</p>
      <input name="email" type="email" placeholder="Email" required autocomplete="email" value="${esc(email)}">
      <button class="primary">Email me a sign-in link</button>
    </form>`;
  const form = main.querySelector('form');
  form.onsubmit = act(async () => {
    const to = form.email.value.trim();
    form.querySelector('button').disabled = true;
    try {
      const { error } = await sb.auth.signInWithOtp({ email: to, options: { emailRedirectTo: loginRedirect(to) } });
      if (error) throw error;
    } finally { form.querySelector('button').disabled = false; }
    renderCode(to);
  });
}

function renderCode(email) {
  main.innerHTML = `
    <form class="login">
      <h2>Check your email</h2>
      <p style="margin:0">We sent a sign-in link and code to <strong>${esc(email)}</strong>. Tap the link, or type the code here:</p>
      <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="Code" required pattern="[0-9 ]{6,10}">
      <button class="primary">Sign in</button>
      <div class="row muted"><a href="#/view" id="other">Use a different email</a> · <a href="#/view" id="again">Send a new code</a></div>
    </form>`;
  const form = main.querySelector('form');
  form.code.focus();
  form.onsubmit = act(async () => {
    const { error } = await sb.auth.verifyOtp({ email, token: form.code.value.replace(/\s/g, ''), type: 'email' });
    if (error) throw error;
    location.hash = '#/';
    render();
  });
  main.querySelector('#other').onclick = act(() => renderLogin(email));
  main.querySelector('#again').onclick = act(async () => {
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: loginRedirect(email) } });
    if (error) throw error;
    showError(new Error('Sent a new code. Use the newest email.'));
  });
}

// Signed in, but joining failed (e.g. the admin hasn't set a username for this email yet).
function renderJoinProblem(err) {
  main.innerHTML = `
    <div class="login">
      <h2>Almost there</h2>
      <p class="error"></p>
      <div class="row"><button id="retry">Try again</button></div>
    </div>`;
  main.querySelector('.error').textContent = err.message;
  main.querySelector('#retry').onclick = act(render);
}

// ---------- signed-in pages ----------

function renderDashboard() {
  renderTop('Potluck');
  main.innerHTML = `
    <h1>Apps</h1>
    <div class="apps">${listedApps().map((g) => `
      <a class="app-card ${g.visibility === 'hidden' ? 'is-hidden' : ''}" href="#/gui/${g.id}">
        <span class="card-top">${tile(g, 'lg')}${badge(g, true)}</span>
        <strong>${esc(g.name)}</strong>
        ${g.description ? `<span class="desc">${esc(g.description)}</span>` : ''}
        <span class="by">by ${esc(g.owner)}</span>
      </a>`).join('') || '<p class="muted">No apps yet. Ask your agent to add one.</p>'}
    </div>`;
  hydrateTiles(main);
}

// Apps as listed: starred, then default, then hidden (hidden ones only for their owner); A-Z within each.
const RANK = { starred: 0, default: 1, hidden: 2 };
function listedApps() {
  return info.guis
    .filter((g) => g.visibility !== 'hidden' || g.owner === info.me)
    .sort((a, b) => (RANK[a.visibility] ?? 1) - (RANK[b.visibility] ?? 1)
      || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// A filled star for starred apps; an eye-off mark (with a label on cards) for hidden ones.
const STAR = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>';
function badge(g, labeled = false) {
  if (g.visibility === 'starred') return `<span class="badge star" title="Starred">${STAR}<span class="sr-only">Starred</span></span>`;
  if (g.visibility === 'hidden') return `<span class="badge hidden-mark" title="Hidden: only you see it in the list">${icon('eye-off')}${labeled ? '<span>Hidden</span>' : ''}</span>`;
  return '';
}

function renderSettings() {
  renderTop('Settings');
  main.innerHTML = `
    <div class="settings">
      <h1>Settings</h1>
      <section>
        <h2>Account</h2>
        <div class="card account">
          <div><strong>${esc(info.me)}</strong><div class="muted">${esc(info.email)}</div></div>
          <button id="out">${icon('log-out')} Sign out</button>
        </div>
      </section>
      <section>
        <div class="row"><h2 style="margin-right:auto">Agent keys</h2><button id="newkey">New key</button></div>
        <p class="muted" style="margin:0">A key lets your agent change the site as you, following <a href="llms.txt">the agent instructions</a>. Keys can't create other keys.</p>
        <div id="newkeybox"></div>
        <div id="keys" class="grid"></div>
      </section>
    </div>`;
  main.querySelector('#out').onclick = act(signOut);
  renderKeys();
  main.querySelector('#newkey').onclick = act(async () => {
    const name = prompt('What is this key for? (e.g. "Claude Code on laptop")');
    if (!name) return;
    const key = await rpc('create_api_key', { name });
    await renderKeys();
    main.querySelector('#newkeybox').innerHTML = `
      <div class="card">
        <strong>New key for ${esc(name)}</strong>
        <span class="muted">It won't be shown again. Copy it, then run the command for your computer to save it where agents look for it.</span>
        <div class="row"><code style="word-break:break-all">${esc(key)}</code><button id="copykey">Copy</button></div>
        ${Object.entries(SAVE_KEY).map(([os, cmd]) => `<span class="muted">${os}</span><code style="word-break:break-all">${esc(cmd)}</code>`).join('')}
        <span class="muted">Then ask your agent for what you want, e.g. "add a new page to https://zoox101.github.io/potluck/".</span>
      </div>`;
    main.querySelector('#copykey').onclick = act(async () => {
      await navigator.clipboard.writeText(key);
      main.querySelector('#copykey').textContent = 'Copied';
    });
  });
}

async function renderKeys() {
  const box = main.querySelector('#keys');
  const keys = await rpc('list_api_keys');
  box.innerHTML = keys.map((k) => `
    <div class="card">
      <strong>${esc(k.name)}</strong>
      <span class="muted">Created ${new Date(k.created_at).toLocaleDateString()}</span>
      <div class="row"><button data-revoke="${k.id}">Revoke</button></div>
    </div>`).join('') || '<p class="muted">No agent keys yet.</p>';
  box.querySelectorAll('[data-revoke]').forEach((b) => (b.onclick = act(async () => {
    if (!confirm('Revoke this key? Agents using it will stop working.')) return;
    await rpc('revoke_api_key', { id: b.dataset.revoke });
    renderKeys();
  })));
}

async function renderGui(id) {
  const listed = info.guis.find((g) => g.id === id);
  renderTop(listed?.name ?? 'Loading…', listed);
  const gui = await rpc('get_gui', { id });
  if (!gui) throw new Error('App not found');
  renderTop(gui.name, gui);
  document.title = `${gui.name} · Potluck`;
  main.className = 'full';
  main.innerHTML = `<iframe sandbox="allow-scripts allow-forms allow-modals allow-popups" title="${esc(gui.name)}"></iframe>`;
  const frame = main.querySelector('iframe');
  const unbridge = bridge(frame);
  cleanup = () => { unbridge(); document.title = 'Potluck'; };
  frame.srcdoc = withSdk(gui.code);
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

// Saves the copied key to <home>/.config/potluck/agent.key, where llms.txt tells agents to look.
const SAVE_KEY = {
  macOS: 'mkdir -p ~/.config/potluck && pbpaste > ~/.config/potluck/agent.key && chmod 600 ~/.config/potluck/agent.key',
  'Windows (PowerShell)': 'New-Item -ItemType Directory -Force "$HOME\\.config\\potluck" | Out-Null; Get-Clipboard | Set-Content -NoNewline "$HOME\\.config\\potluck\\agent.key"',
  Linux: 'mkdir -p ~/.config/potluck && xclip -o -selection clipboard > ~/.config/potluck/agent.key && chmod 600 ~/.config/potluck/agent.key',
};

addEventListener('hashchange', act(render));
sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') setTimeout(act(render)); });
act(render)();
