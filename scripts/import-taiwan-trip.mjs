// One-off import of the Taiwan Together trip (as returned by Full Auto's will.taiwan-trip/getTrip)
// into will.taiwan_places / will.taiwan_votes, plus the Taiwan Trip GUI, all owned by OWNER_EMAIL.
// Prints SQL; run it with: npx supabase db query --remote --file <out.sql>
import { readFileSync } from 'node:fs';

const [tripFile, ownerEmail = 'william@thebookers.net'] = process.argv.slice(2);
const { places } = JSON.parse(readFileSync(tripFile, 'utf8')).result;
const gui = readFileSync(new URL('../examples/taiwan-trip.html', import.meta.url), 'utf8');

const rows = places.map((p) => ({
  slug: p.id, name: p.name, chinese: p.chinese ?? null, city: p.city, area: p.area ?? null, category: p.category,
  description: p.description, duration_hours: p.duration_hours ?? null, cost: p.cost ?? null,
  lat: p.coordinates?.lat ?? null, lng: p.coordinates?.lng ?? null, google_maps_url: p.google_maps_url ?? null,
  photos: p.photos, recommendation: p.recommendation, world_map: p.worldMap, scheduled: p.scheduled,
}));
const votes = places.flatMap((p) => p.interest.votes.map((v) => ({ slug: p.id, traveler: v.name, vote: v.label })));

const quote = (s, tag) => { if (s.includes(`$${tag}$`)) throw new Error(`data contains $${tag}$`); return `$${tag}$${s}$${tag}$`; };
const columns = (spec) => JSON.stringify(spec.map(([name, type, required]) => ({ name, type, required: !!required })));

console.log(`begin;
-- Act as the owner so create_table/save_gui namespace and attribute everything to them.
select set_config('request.jwt.claims', json_build_object('sub', id, 'email', email, 'role', 'authenticated')::text, true)
  from auth.users where email = '${ownerEmail}';

select public.create_table('taiwan_places', '${columns([
  ['slug', 'text', 1], ['name', 'text', 1], ['chinese', 'text'], ['city', 'text'], ['area', 'text'], ['category', 'text'],
  ['description', 'text'], ['duration_hours', 'numeric'], ['cost', 'text'], ['lat', 'numeric'], ['lng', 'numeric'],
  ['google_maps_url', 'text'], ['photos', 'jsonb'], ['recommendation', 'text'], ['world_map', 'jsonb'], ['scheduled', 'jsonb'],
])}');
select public.create_table('taiwan_votes', '${columns([['place_id', 'bigint', 1], ['traveler', 'text', 1], ['vote', 'text', 1]])}');

insert into will.taiwan_places (slug, name, chinese, city, area, category, description, duration_hours, cost, lat, lng,
                                google_maps_url, photos, recommendation, world_map, scheduled)
select slug, name, chinese, city, area, category, description, duration_hours, cost, lat, lng,
       google_maps_url, photos, recommendation, world_map, scheduled
from jsonb_to_recordset(${quote(JSON.stringify(rows), 'rows')}::jsonb) as x(
  slug text, name text, chinese text, city text, area text, category text, description text, duration_hours numeric,
  cost text, lat numeric, lng numeric, google_maps_url text, photos jsonb, recommendation text, world_map jsonb, scheduled jsonb);

insert into will.taiwan_votes (place_id, traveler, vote)
select p.id, x.traveler, x.vote
from jsonb_to_recordset(${quote(JSON.stringify(votes), 'votes')}::jsonb) as x(slug text, traveler text, vote text)
join will.taiwan_places p on p.slug = x.slug;

select public.save_gui('Taiwan Trip', ${quote(gui, 'gui')},
  'Map of the Taiwan Together trip (Dec 16-26, 2026): every place colored by your vote, with photos, everyone''s votes and Claude''s take.',
  array['will.taiwan_places', 'will.taiwan_votes']);

select (select count(*) from will.taiwan_places) as places, (select count(*) from will.taiwan_votes) as votes;
commit;`);
