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
  const ask = `Add a page to ${SITE} that lists our favorite restaurants.`;
  const text = `Welcome to Potluck, ${username}!

Sign in: ${link}

Next time, sign in at ${SITE} with ${email}.

YOUR AGENT KEY
${key}
${cmds.map(([os, cmd]) => `\n${os}:\n  ${cmd}`).join('\n')}

Then ask your agent: "${ask}"

Keep the key private.
`;
  const code = 'background:#f2f1ed;padding:8px;border-radius:6px;white-space:pre-wrap;word-break:break-all;font-size:12px';
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1d1d1b;line-height:1.5">
  <h2 style="margin:0 0 16px">Welcome to Potluck, ${esc(username)}!</h2>
  <p style="margin:0 0 12px"><a href="${esc(link)}" style="display:inline-block;background:#2f6fd6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">Sign in to Potluck</a></p>
  <p style="margin:0 0 28px;color:#6b6b66;font-size:13px">Next time, sign in at <a href="${SITE}">${SITE}</a> with ${esc(email)}.</p>
  <h3 style="margin:0 0 8px;font-size:16px">Your agent key</h3>
  <pre style="margin:0 0 12px;${code};font-size:13px">${esc(key)}</pre>
  ${cmds.map(([os, cmd]) => `<p style="margin:0 0 2px;color:#6b6b66;font-size:13px">${esc(os)}</p>
  <pre style="margin:0 0 10px;${code}">${esc(cmd)}</pre>`).join('\n  ')}
  <p style="margin:16px 0 0">Then ask your agent: <i>"${esc(ask)}"</i></p>
  <p style="margin:16px 0 0;color:#6b6b66;font-size:13px">Keep the key private.</p>
</div>`;
  return { subject: 'Welcome to Potluck', text, html };
}

export async function sendWelcome({ email, username, key, link }) {
  const { user, pass } = smtpCredentials();
  const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, secure: false, auth: { user, pass } });
  const { subject, text, html } = welcomeEmail({ email, username, key, link });
  await transport.sendMail({ from: { name: 'Potluck', address: user }, to: email, subject, text, html });
}
