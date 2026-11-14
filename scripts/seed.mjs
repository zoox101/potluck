// Demo users, tables and apps: npm run seed (re-running replaces them).
// Users demo_alex, demo_sam and demo_jo (<name>@example.com). Sign-in is by emailed code, so they are API-only demo users.
import { readFile } from 'node:fs/promises';
import { admin, newUser } from './api.mjs';

const names = ['demo_alex', 'demo_sam', 'demo_jo'];
for (const name of names) await admin('remove_user', { email: `${name}@example.com` }).catch(() => {});
const [alex, sam, jo] = await Promise.all(names.map((name) => newUser(name)));

// alex owns the places; everyone can add to it.
await alex('create_table', { name: 'places', columns: [
  { name: 'name', type: 'text', required: true }, { name: 'city', type: 'text' }, { name: 'notes', type: 'text' },
] });
const market = await alex('insert_row', { table_name: 'demo_alex.places', data: { name: 'Raohe Night Market', city: 'Taipei' } });
const tower = await sam('insert_row', { table_name: 'demo_alex.places', data: { name: 'Taipei 101', city: 'Taipei' } });
await jo('insert_row', { table_name: 'demo_alex.places', data: { name: 'Sun Moon Lake', city: 'Nantou', notes: 'Rent bikes' } });

// sam extends alex's table with a votes table of their own instead of altering it.
await sam('create_table', { name: 'votes', columns: [
  { name: 'place_id', type: 'bigint', required: true }, { name: 'vote', type: 'integer', required: true },
] });
for (const [rpc, place] of [[sam, market], [jo, market], [alex, tower]]) {
  await rpc('insert_row', { table_name: 'demo_sam.votes', data: { place_id: place.id, vote: 1 } });
}

const code = await readFile(new URL('../examples/trip-places.html', import.meta.url), 'utf8');
const gui = await alex('create_gui', {
  name: 'Trip Places', code, description: 'Places to visit, with votes from everyone.', reads: ['demo_alex.places', 'demo_sam.votes'],
});
await jo('fork_gui', { id: gui.id, name: 'Trip Places (Jo)' });

console.log(`Seeded ${names.join(', ')}, 2 tables and 2 apps.`);
