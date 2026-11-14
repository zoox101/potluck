// Admin commands for the linked project (needs `npx supabase login`):
//   npm run admin allow friend@example.com alice   approve an email for sign-up, with the username it gets
//   npm run admin disallow friend@example.com      withdraw approval
//   npm run admin remove friend@example.com        delete a user and everything they created
//   npm run admin list                             show approved emails, usernames and who has joined
import { admin } from './api.mjs';

const [command, email, username] = process.argv.slice(2);
const fns = { disallow: 'disallow_email', remove: 'remove_user' };

if (command === 'list') {
  const rows = await admin('list_allowed_emails');
  console.log(rows.map((r) => `${r.email}  ${r.username ?? '(no username)'}  ${r.joined ? 'joined' : 'not joined yet'}`).join('\n')
    || 'No approved emails.');
} else if (command === 'allow' && email) {
  console.log(`allow: ${await admin('allow_email', { email, username: username ?? null })}`);
} else if (fns[command] && email) {
  console.log(`${command}: ${await admin(fns[command], { email })}`);
} else {
  console.log('Usage: npm run admin allow <email> <username> | disallow <email> | remove <email> | list');
  process.exit(1);
}
