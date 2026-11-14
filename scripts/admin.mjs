// Admin commands for the linked project (needs `npx supabase login`):
//   npm run admin allow friend@example.com      approve an email for sign-up
//   npm run admin disallow friend@example.com   withdraw approval
//   npm run admin remove friend@example.com     delete a user and everything they created
//   npm run admin list                          show approved emails
import { admin } from './api.mjs';

const [command, email] = process.argv.slice(2);
const fns = { allow: 'allow_email', disallow: 'disallow_email', remove: 'remove_user' };

if (command === 'list') {
  console.log((await admin('list_allowed_emails')).join('\n') || 'No approved emails.');
} else if (fns[command] && email) {
  console.log(`${command}: ${await admin(fns[command], { email })}`);
} else {
  console.log('Usage: npm run admin allow|disallow|remove <email>, or npm run admin list');
  process.exit(1);
}
