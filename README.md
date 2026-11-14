Potluck: a web app where a group of friends (and their agents) build small apps together on the fly. App code and data both live in one shared database, so anyone can add an app without asking whoever "owns the website", and agents use exactly the same API the apps do.

## Requirements

1. A web app where friends build GUIs cooperatively; GUIs and their code are stored in the database.
2. A thin shell: a dashboard of GUIs and a renderer for them.
3. Generic API endpoints, including creating tables. GUIs and agents use the same API.
4. Tables are namespaced per user. Only the owner changes a table's schema; anyone adds rows; only a row's creator edits or deletes it.
5. Breaking schema changes are guarded: additive by default, with dependent GUIs flagged.
6. GUIs are versioned; others fork them instead of editing.
7. GUI logic is client-side only; no server code apart from the database.
8. Simple per-user tokens.
9. Hosted on free tiers: Supabase (Postgres) plus GitHub Pages for the shell.
10. Agents call the REST API directly (no MCP needed).
11. Only approved emails can sign up, and only the admin (Will) approves them.

## How it works

- **Supabase** (project `potluck`) holds everything: users, each user's schema of tables (`will.places`), and GUIs with their version history. Users and agents only call the functions in [the API guide](API.md).
- **Sign-up** is limited to an approved-email list, enforced by a Supabase "before user created" hook and again in every API function. Sign-ups confirm their email.
- **The shell** ([web/](web/)) is static files. It signs you in, lists apps and tables, and renders a GUI in a sandboxed iframe. GUIs reach data only through the injected `window.db` SDK ([web/sdk.js](web/sdk.js)), which relays to the same API functions.
- The database design lives in [supabase/migrations](supabase/migrations/); [supabase/config.toml](supabase/config.toml) holds the project settings, including the hook.

## Working on it

Needs Node. The Supabase CLI is a dev dependency; sign it in once with `npx supabase login`.

```bash
npm install
npm run serve                          # local copy of the shell at http://127.0.0.1:8080
npm test                               # API rule tests (creates and removes throwaway users)
npm run seed                           # (re)create the demo users, tables and apps
npm run admin allow friend@email.com   # approve a friend; also: disallow, remove, list
npx supabase db push --remote          # apply new migration files
npx supabase config push               # apply config.toml changes (check `npx supabase config diff` first)
```

Demo users `demo_alex`, `demo_sam` and `demo_jo` sign in as `<name>@example.com` with password `password123`; remove them with `npm run admin remove <email>`. Admin commands use the project's secret key through the CLI and never print it.

## Deployment

- **Live at https://zoox101.github.io/potluck/.** Every push to `main` that touches `web/` republishes it ([pages.yml](.github/workflows/pages.yml)).
- A scheduled GitHub Action pings the database every 3 days so the free Supabase project doesn't pause ([keep-alive.yml](.github/workflows/keep-alive.yml)).
- Database changes are not deployed automatically: run `npx supabase db push --remote` after adding a migration.
