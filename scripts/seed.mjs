// Demo data for a freshly reset local database (npm run reset).
// Users will, kevin and amy all have the password "password123".
import { readFile } from 'node:fs/promises';
import { newUser } from './api.mjs';

const will = await newUser('will');
const kevin = await newUser('kevin');
const amy = await newUser('amy');

// will owns the places; everyone can add to it.
await will('create_table', { name: 'places', columns: [
  { name: 'name', type: 'text', required: true }, { name: 'city', type: 'text' }, { name: 'notes', type: 'text' },
] });
const night = await will('insert_row', { table_name: 'will.places', data: { name: 'Raohe Night Market', city: 'Taipei' } });
const tower = await kevin('insert_row', { table_name: 'will.places', data: { name: 'Taipei 101', city: 'Taipei' } });
await amy('insert_row', { table_name: 'will.places', data: { name: 'Sun Moon Lake', city: 'Nantou', notes: 'Rent bikes' } });

// kevin extends will's table with his own votes table instead of altering it.
await kevin('create_table', { name: 'votes', columns: [
  { name: 'place_id', type: 'bigint', required: true }, { name: 'vote', type: 'integer', required: true },
] });
for (const [rpc, place] of [[kevin, night], [amy, night], [will, tower]]) {
  await rpc('insert_row', { table_name: 'kevin.votes', data: { place_id: place.id, vote: 1 } });
}

const code = await readFile(new URL('../examples/trip-places.html', import.meta.url), 'utf8');
const gui = await will('save_gui', {
  name: 'Trip Places', code, description: 'Places to visit, with votes from everyone.', reads: ['will.places', 'kevin.votes'],
});
await amy('fork_gui', { id: gui.id, name: 'Trip Places (Amy)' });

console.log('Seeded users will, kevin, amy (password: password123), 2 tables and 2 apps.');
