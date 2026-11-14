// Admin commands for the linked project (needs `npx supabase login`):
//   npm run admin allow friend@example.com alice   approve an email as username alice, create the account and
//                                                  email a getting-started note with an agent key
//   npm run admin welcome friend@example.com       email an existing member the note again; the new key replaces their old welcome key
//   npm run admin disallow friend@example.com      withdraw approval
//   npm run admin remove friend@example.com        delete a user and everything they created
//   npm run admin list                             show approved emails, usernames and who has signed in
// Emails go out through the site's Gmail account; see scripts/welcome.mjs for where its credentials live.
import { admin, createUser, signInLink } from './api.mjs';
import { sendWelcome } from './welcome.mjs';

const [command, email, username] = process.argv.slice(2);
const fns = { disallow: 'disallow_email', remove: 'remove_user' };
const entry = async (e) => (await admin('list_allowed_emails')).find((r) => r.email === e.trim().toLowerCase());

// Create (or reuse) the member's account, give it a new agent key, and email the getting-started note.
async function welcome(to) {
  const member = await admin('admin_add_member', { email: to });
  const link = await signInLink(to.trim().toLowerCase());
  await sendWelcome({ email: to.trim().toLowerCase(), username: member.username, key: member.key, link });
  console.log(`welcome: emailed ${to} (${member.username}) sign-in instructions and a new agent key`);
}

if (command === 'list') {
  const rows = await admin('list_allowed_emails');
  console.log(rows.map((r) => `${r.email}  ${r.username ?? '(no username)'}  ${r.signed_in ? 'signed in' : r.joined ? 'account created, not signed in yet' : 'not joined yet'}`).join('\n')
    || 'No approved emails.');
} else if (command === 'allow' && email) {
  const before = await entry(email);
  console.log(`allow: ${await admin('allow_email', { email, username: username ?? null })}`);
  if (before?.joined) {
    console.log(`${email} is already a member; run \`npm run admin welcome ${email}\` to send the getting-started email with a new key.`);
  } else {
    await createUser(email).catch((err) => { if (!/already/i.test(err.message)) throw err; });
    await welcome(email);
  }
} else if (command === 'welcome' && email) {
  if (!(await entry(email))?.joined) throw new Error(`${email} isn't a member yet; approve them with \`npm run admin allow ${email} <username>\``);
  await welcome(email);
} else if (fns[command] && email) {
  console.log(`${command}: ${await admin(fns[command], { email })}`);
} else {
  console.log('Usage: npm run admin allow <email> <username> | welcome <email> | disallow <email> | remove <email> | list');
  process.exit(1);
}
