// Import the Taiwan Together trip (as returned by Full Auto's will.taiwan-trip/getTrip) through the
// normal API with an agent key: creates <owner>.taiwan_places / <owner>.taiwan_votes and the Taiwan Trip GUI.
//   POTLUCK_KEY_FILE=~/.config/potluck/agent.key node scripts/import-taiwan-trip.mjs trip.json [--replace]
// --replace first drops those tables and the owner's existing "Taiwan Trip" GUI.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { keyClient } from './api.mjs';

const [tripFile, flag] = process.argv.slice(2);
const keyFile = (process.env.POTLUCK_KEY_FILE ?? '~/.config/potluck/agent.key').replace(/^~/, homedir());
const rpc = keyClient(readFileSync(keyFile, 'utf8').trim());
const { places } = JSON.parse(readFileSync(tripFile, 'utf8')).result;
const code = readFileSync(new URL('../examples/taiwan-trip.html', import.meta.url), 'utf8');

const { me, guis } = await rpc('describe');
if (!me) throw new Error('The agent key is not valid for an approved member');
const PLACES = `${me}.taiwan_places`, VOTES = `${me}.taiwan_votes`;

if (flag === '--replace') {
  for (const gui of guis.filter((g) => g.owner === me && g.name === 'Taiwan Trip')) await rpc('delete_gui', { id: gui.id });
  for (const table of [VOTES, PLACES]) await rpc('drop_table', { table_name: table, force: true }).catch(() => {});
}

const col = (name, type, required = false) => ({ name, type, required });
const insertAll = async (table_name, rows) => {
  for (let i = 0; i < rows.length; i += 200) await rpc('insert_rows', { table_name, rows: rows.slice(i, i + 200) });
};
await rpc('create_table', { name: 'taiwan_places', columns: [
  col('slug', 'text', true), col('name', 'text', true), col('chinese', 'text'), col('city', 'text'), col('area', 'text'),
  col('category', 'text'), col('description', 'text'), col('duration_hours', 'numeric'), col('cost', 'text'),
  col('lat', 'numeric'), col('lng', 'numeric'), col('google_maps_url', 'text'), col('photos', 'jsonb'),
  col('recommendation', 'text'), col('world_map', 'jsonb'), col('scheduled', 'jsonb'),
] });
await rpc('create_table', { name: 'taiwan_votes', columns: [col('place_id', 'bigint', true), col('traveler', 'text', true), col('vote', 'text', true)] });

await insertAll(PLACES, places.map((p) => ({
  slug: p.id, name: p.name, chinese: p.chinese ?? null, city: p.city, area: p.area ?? null, category: p.category,
  description: p.description, duration_hours: p.duration_hours ?? null, cost: p.cost ?? null,
  lat: p.coordinates?.lat ?? null, lng: p.coordinates?.lng ?? null, google_maps_url: p.google_maps_url ?? null,
  photos: p.photos, recommendation: p.recommendation, world_map: p.worldMap, scheduled: p.scheduled,
})));

const ids = Object.fromEntries((await rpc('query', { sql: `select slug, id from ${PLACES}` })).map((r) => [r.slug, r.id]));
const votes = places.flatMap((p) => p.interest.votes.map((v) => ({ place_id: ids[p.id], traveler: v.name, vote: v.label })));
await insertAll(VOTES, votes);

const gui = await rpc('save_gui', {
  name: 'Taiwan Trip', code, reads: [PLACES, VOTES],
  description: "Map of the Taiwan Together trip (Dec 16-26, 2026): every place colored by your vote, with photos, everyone's votes and Claude's take.",
});
console.log(`Imported ${places.length} places and ${votes.length} votes as ${me}; GUI ${gui.id} v${gui.version}.`);
