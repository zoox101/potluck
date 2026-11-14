// Minimal REST client, used by the seed script and the tests (and a model for agents).
import { SUPABASE_URL, SUPABASE_KEY } from '../web/config.js';

export async function signUp(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.msg ?? body.message ?? res.statusText);
  return body.access_token;
}

// Returns rpc(fn, args) calling /rest/v1/rpc/<fn> as the token's user (or anonymously).
export function client(token) {
  return async (fn, args = {}) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token ?? SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(body?.message ?? res.statusText);
    return body;
  };
}

// Sign up a fresh user and claim a username in one step.
export async function newUser(username, password = 'password123') {
  const rpc = client(await signUp(`${username}@example.com`, password));
  await rpc('claim_username', { name: username });
  return rpc;
}
