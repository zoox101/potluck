// Minimal REST client, used by the scripts and tests (and a model for agents).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SUPABASE_URL, SUPABASE_KEY } from '../web/config.js';

const root = new URL('..', import.meta.url);

async function request(path, key, token, body, headers = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${token ?? key}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message ?? data?.msg ?? res.statusText);
  return data;
}

// Returns rpc(fn, args) calling /rest/v1/rpc/<fn> as the token's user (or anonymously).
export const client = (token) => (fn, args = {}) => request(`/rest/v1/rpc/${fn}`, SUPABASE_KEY, token, args);

// The same, authenticated with an agent key (how agents call the API).
export const keyClient = (agentKey = findAgentKey()) => (fn, args = {}) =>
  request(`/rest/v1/rpc/${fn}`, SUPABASE_KEY, null, args, { 'x-potluck-key': agentKey });

// The standard key location from llms.txt: $POTLUCK_KEY, else <home>/.config/potluck/agent.key.
export function findAgentKey() {
  if (process.env.POTLUCK_KEY) return process.env.POTLUCK_KEY.trim();
  try { return readFileSync(join(homedir(), '.config', 'potluck', 'agent.key'), 'utf8').trim(); } catch {
    throw new Error('No agent key: set POTLUCK_KEY or save one to ~/.config/potluck/agent.key (create it on the site under "Agent keys")');
  }
}

// Sign-in is passwordless. Scripts sign a user in with a one-time code the admin API generates
// (no email is sent) and return their access token.
// A one-click sign-in link for the site (works once, expires with the OTP; sends no email).
export async function signInLink(email, redirectTo = 'https://zoox101.github.io/potluck/') {
  return (await request('/auth/v1/admin/generate_link', secretKey(), null, { type: 'magiclink', email, redirect_to: redirectTo })).action_link;
}

export async function signIn(email) {
  const { email_otp: token } = await request('/auth/v1/admin/generate_link', secretKey(), null, { type: 'magiclink', email });
  return (await request('/auth/v1/verify', SUPABASE_KEY, null, { type: 'email', email, token })).access_token;
}

// Ask for a sign-in email, as the site does. Sends a real email to approved addresses.
export const requestCode = (email) => request('/auth/v1/otp', SUPABASE_KEY, null, { email, create_user: true });

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
export const createUser = (email) => request('/auth/v1/admin/users', secretKey(), null, { email, email_confirm: true });

// Approve an email with a username, create and sign in the user, then join. Returns rpc for that user.
export async function newUser(username, email = `${username}@example.com`) {
  await admin('allow_email', { email, username });
  await createUser(email);
  const rpc = client(await signIn(email));
  await rpc('claim_username');
  return rpc;
}
