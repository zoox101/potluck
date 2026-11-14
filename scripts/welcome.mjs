// The getting-started email a new member gets: how to sign in, plus an agent key.
// Sent from the site's Gmail account (the same one Supabase uses for sign-in emails). Credentials come
// from POTLUCK_SMTP_USER / POTLUCK_SMTP_PASS, else ~/.config/potluck/smtp (address, then app password).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';

const SITE = 'https://zoox101.github.io/potluck/';

function smtpCredentials() {
  if (process.env.POTLUCK_SMTP_USER && process.env.POTLUCK_SMTP_PASS) {
    return { user: process.env.POTLUCK_SMTP_USER.trim(), pass: process.env.POTLUCK_SMTP_PASS.replace(/\s/g, '') };
  }
  try {
    const [user, pass] = readFileSync(join(homedir(), '.config', 'potluck', 'smtp'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    if (user && pass) return { user, pass: pass.replace(/\s/g, '') };
  } catch {}
  throw new Error('No email credentials: set POTLUCK_SMTP_USER and POTLUCK_SMTP_PASS, or save the Gmail address and app password (one per line) to ~/.config/potluck/smtp');
}

// One-line commands that save the key where agents look for it (see web/llms.txt).
const saveCommands = (key) => [
  ['Mac or Linux (Terminal)', `mkdir -p ~/.config/potluck && printf '%s' '${key}' > ~/.config/potluck/agent.key && chmod 600 ~/.config/potluck/agent.key`],
  ['Windows (PowerShell)', `New-Item -ItemType Directory -Force "$HOME\\.config\\potluck" | Out-Null; Set-Content -NoNewline "$HOME\\.config\\potluck\\agent.key" '${key}'`],
];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function welcomeEmail({ email, username, key, link }) {
  const cmds = saveCommands(key);
  const text = `Welcome to Potluck, ${username}!

Potluck is a site where our group builds and shares small web apps: ${SITE}

SIGN IN WITH ONE CLICK
${link}
(This link works once and expires 24 hours after this email was sent. If it has expired, it opens the sign-in page with your email filled in: tap the button there for a new link.)

SIGNING IN LATER
1. Open ${SITE} and tap "View dashboard".
2. Enter this email address (${email}). There's no password.
3. We'll email you a sign-in link and code. Tap the link, or type the code on the page.
You stay signed in on that device until you sign out.

YOUR AGENT KEY
Your AI agent (Claude Code, Codex, ...) can add and change apps for you with this key:

  ${key}

Save it on your computer with the command for your system:
${cmds.map(([os, cmd]) => `\n${os}:\n  ${cmd}`).join('\n')}

Then ask your agent something like: "Add a page to ${SITE} that lists our favorite restaurants."
Agents find the instructions at ${SITE}llms.txt.

The key acts as you, so keep it private. If it ever leaks, revoke it under Settings (the gear at the
bottom of the menu) and create a new one there.
`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1d1d1b;line-height:1.5">
  <h2 style="margin:0 0 8px">Welcome to Potluck, ${esc(username)}!</h2>
  <p style="margin:0 0 20px">Potluck is a site where our group builds and shares small web apps: <a href="${SITE}">${SITE}</a></p>
  <p style="margin:0 0 6px"><a href="${esc(link)}" style="display:inline-block;background:#2f6fd6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">Sign in to Potluck</a></p>
  <p style="margin:0 0 20px;color:#6b6b66;font-size:13px">One click, no password. The button works once and expires 24 hours after this email was sent. If it has expired, it opens the sign-in page with your email filled in: tap the button there for a new link.</p>
  <h3 style="margin:0 0 6px;font-size:16px">Signing in later</h3>
  <ol style="margin:0 0 20px;padding-left:20px">
    <li>Open <a href="${SITE}">Potluck</a> and tap <b>View dashboard</b>.</li>
    <li>Enter this email address (${esc(email)}). There's no password.</li>
    <li>We'll email you a sign-in link and code. Tap the link, or type the code on the page.</li>
  </ol>
  <h3 style="margin:0 0 6px;font-size:16px">Your agent key</h3>
  <p style="margin:0 0 8px">Your AI agent (Claude Code, Codex, ...) can add and change apps for you with this key:</p>
  <p style="margin:0 0 12px"><code style="background:#f2f1ed;padding:6px 8px;border-radius:6px;word-break:break-all">${esc(key)}</code></p>
  <p style="margin:0 0 6px">Save it on your computer with the command for your system:</p>
  ${cmds.map(([os, cmd]) => `<p style="margin:0 0 2px;color:#6b6b66;font-size:13px">${esc(os)}</p>
  <pre style="margin:0 0 10px;background:#f2f1ed;padding:8px;border-radius:6px;white-space:pre-wrap;word-break:break-all;font-size:12px">${esc(cmd)}</pre>`).join('\n  ')}
  <p style="margin:12px 0">Then ask your agent something like: <i>"Add a page to ${SITE} that lists our favorite restaurants."</i>
    Agents find the instructions at <a href="${SITE}llms.txt">${SITE}llms.txt</a>.</p>
  <p style="margin:0;color:#6b6b66;font-size:13px">The key acts as you, so keep it private. If it ever leaks, revoke it under Settings
    (the gear at the bottom of the menu) and create a new one there.</p>
</div>`;
  return { subject: 'Welcome to Potluck', text, html };
}

export async function sendWelcome({ email, username, key, link }) {
  const { user, pass } = smtpCredentials();
  const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, secure: false, auth: { user, pass } });
  const { subject, text, html } = welcomeEmail({ email, username, key, link });
  await transport.sendMail({ from: { name: 'Potluck', address: user }, to: email, subject, text, html });
}
