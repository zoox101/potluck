A web app where a group of friends (and their agents) build small apps together on the fly. App code and data both live in one shared database, so anyone can add an app without asking whoever "owns the website", and agents use exactly the same API the apps do.

## Requirements

1. A web app where friends build GUIs cooperatively; GUIs and their code are stored in the database.
2. A thin shell: a dashboard of GUIs and a renderer for them.
3. Generic API endpoints, including creating tables. GUIs and agents use the same API.
4. Tables are namespaced per user. Only the owner changes a table's schema; anyone adds rows; only a row's creator edits or deletes it.
5. Breaking schema changes are guarded: additive by default, with dependent GUIs flagged.
6. GUIs are versioned; others fork them instead of editing.
7. GUI logic is client-side only; no server code apart from the database.
8. Simple per-user tokens.
9. Hosted on free tiers: Supabase (Postgres) plus GitLab Pages for the shell. Runs fully locally first.
10. Agents call the REST API directly (no MCP needed).

## How it works

- **Supabase** holds everything: users, each user's schema of tables (`will.places`), and GUIs with their version history. Users and agents only call the functions in [the API guide](API.md).
- **The shell** ([web/](web/)) is static files. It signs you in, lists apps and tables, and renders a GUI in a sandboxed iframe. GUIs reach data only through the injected `window.db` SDK ([web/sdk.js](web/sdk.js)), which relays to the same API functions.
- The whole database design is one migration: [supabase/migrations](supabase/migrations/).

## Running locally

Needs Docker (OrbStack) and Node. The Supabase CLI is a dev dependency.

```bash
npm install
npm start        # start local Supabase and write web/config.js
npm run reset    # wipe the database and load demo users, tables and apps
npm run serve    # shell at http://127.0.0.1:8080
npm test         # API rule tests
```

Demo users `will`, `kevin` and `amy` sign in as `<name>@example.com` with password `password123`. The local Supabase dashboard is at http://127.0.0.1:54323.

## Not done yet

- Deploying: hosted Supabase project (`supabase link`, `supabase db push`), GitLab Pages for `web/`, and a scheduled ping so the free project doesn't pause.
