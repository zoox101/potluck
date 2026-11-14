// Minimal REST client, used by the scripts and tests (and a model for agents).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { SUPABASE_URL, SUPABASE_KEY } from '../web/config.js';

const root = new URL('..', import.meta.url);

async function request(path, key, token, body) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${token ?? key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message ?? data?.msg ?? res.statusText);
  return data;
}

// Returns rpc(fn, args) calling /rest/v1/rpc/<fn> as the token's user (or anonymously).
export const client = (token) => (fn, args = {}) => request(`/rest/v1/rpc/${fn}`, SUPABASE_KEY, token, args);

export async function signIn(email, password) {
  return (await request('/auth/v1/token?grant_type=password', SUPABASE_KEY, null, { email, password })).access_token;
}

export const signUp = (email, password) => request('/auth/v1/signup', SUPABASE_KEY, null, { email, password });

// The project's service_role key, read from the Supabase CLI when needed; never printed or saved.
let secret;
function secretKey() {
  if (secret) return secret;
  const run = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let ref = null;
  try { ref = readFileSync(new URL('supabase/.temp/project-ref', root), 'utf8').trim(); } catch {}
  secret = ref
    ? JSON.parse(run(`npx supabase projects api-keys --project-ref ${ref} -o json`)).find((k) => k.name === 'service_role').api_key
    : run('npx supabase status -o env').match(/SERVICE_ROLE_KEY="([^"]+)"/)[1];
  return secret;
}

// Admin calls: approve emails, create confirmed users, remove users.
export const admin = (fn, args = {}) => request(`/rest/v1/rpc/${fn}`, secretKey(), null, args);
export const createUser = (email, password) =>
  request('/auth/v1/admin/users', secretKey(), null, { email, password, email_confirm: true });

// Approve, create and sign in a user, then claim a username. Returns rpc for that user.
export async function newUser(username, password = 'password123', email = `${username}@example.com`) {
  await admin('allow_email', { email });
  await createUser(email, password);
  const rpc = client(await signIn(email, password));
  await rpc('claim_username', { name: username });
  return rpc;
}
