> **Agents:** to add a page or data to the site, you don't need this repo. Pages live in the database; follow https://zoox101.github.io/potluck/llms.txt and don't clone, edit or deploy anything here. See [AGENTS.md](AGENTS.md).

Potluck: a web app where a group of friends (and their agents) build small apps together on the fly. App code and data both live in one shared database, so anyone can add an app without asking whoever "owns the website", and agents use exactly the same API the apps do.

## Requirements

1. A web app where friends build GUIs cooperatively; GUIs and their code are stored in the database.
2. A thin shell: a dashboard of GUIs and a renderer for them.
3. Generic API endpoints, including creating tables. GUIs and agents use the same API.
4. Tables are namespaced per user. Only the owner changes a table's schema; anyone adds rows; only a row's owner (`owned_by`) edits or deletes it, and a table's owner can reassign rows (`set_row_owner`).
5. Breaking schema changes are guarded: additive by default, with dependent GUIs flagged.
6. Any member can edit any GUI. Code and metadata change separately: `update_gui_code` saves a new version (recording who saved it), `update_gui_metadata` changes name, icon, visibility (starred / default / hidden) and so on without one. Only the creator deletes a GUI; anyone can fork.
7. GUI logic is client-side only; no server code apart from the database.
8. Simple per-user tokens: agent keys a member creates on the site for their agents.
9. Hosted on free tiers: Supabase (Postgres) plus GitHub Pages for the shell.
10. Agents call the REST API directly (no MCP needed).
11. Only approved emails can sign up, and only the admin (Will) approves them, choosing each member's username at the same time.
12. Agents (mine included) change the site only through the API with their own agent key; no admin shortcuts around it.

## How it works

- **Supabase** (project `potluck`) holds everything: users, each user's schema of tables (`will.places`), and GUIs with their version history. Users and agents only call the functions in the agent guide, [web/llms.txt](web/llms.txt) (served at https://zoox101.github.io/potluck/llms.txt).
- **Sign-up** is limited to an approved-email list, enforced by a Supabase "before user created" hook and again in every API function. Sign-ups confirm their email. The admin sets each email's username when approving it; on first sign-in the shell calls `claim_username()`, which takes that name. Usernames are permanent once claimed because they name the member's schema.
- **Agents** call the API with an agent key (`x-potluck-key` header). A key acts as its owner through the same functions and row rules, cannot create keys, and can be revoked on the site.
- **The shell** ([web/](web/)) is static files. It signs you in, lists apps (with their Lucide icons) in a slide-out menu and on the apps page, holds agent keys under Settings, and renders a GUI in a sandboxed iframe. GUIs reach data only through the injected `window.db` SDK ([web/sdk.js](web/sdk.js)), which relays to the same API functions.
- The database design lives in [supabase/migrations](supabase/migrations/); [supabase/config.toml](supabase/config.toml) holds the project settings, including the hook.

## Apps

- **Taiwan Trip** (will): map of the Taiwan Together trip with everyone's votes. Source: [examples/taiwan-trip.html](examples/taiwan-trip.html). Data in `will.taiwan_places` and `will.taiwan_votes` (each vote is a new row; a traveler's latest row per place counts), imported through the API with an agent key from Full Auto's trip snapshot by [scripts/import-taiwan-trip.mjs](scripts/import-taiwan-trip.mjs).
- **Trip Places** (example, not deployed): small example of joining two users' tables. Source: [examples/trip-places.html](examples/trip-places.html); `npm run seed` loads it with demo users.

## Working on it

Needs Node. The Supabase CLI is a dev dependency; sign it in once with `npx supabase login`.

```bash
npm install
npm run serve                          # local copy of the shell at http://127.0.0.1:8080
npm test                               # API rule tests (creates and removes throwaway users)
npm run seed                           # (re)create the demo users, tables and apps
npm run admin allow friend@email.com alice   # approve a friend as alice: creates the account and emails a getting-started note with an agent key
npm run admin welcome friend@email.com       # resend that note to a member; its new agent key replaces their earlier welcome key; also: disallow, remove, list
npx supabase db push --remote          # apply new migration files
npx supabase config push               # apply config.toml changes (check `npx supabase config diff` first); needs the SMTP env vars below
```

`npm run seed` creates demo users `demo_alex`, `demo_sam` and `demo_jo` (`<name>@example.com`; they can't receive sign-in emails, so they only exist for the API and tests); remove them with `npm run admin remove <email>`. None exist right now. Admin commands use the project's secret key through the CLI and never print it.

## Deployment

- **Live at https://zoox101.github.io/potluck/.** Every push to `main` that touches `web/` republishes it ([pages.yml](.github/workflows/pages.yml)).
- A scheduled GitHub Action pings the database every 3 days so the free Supabase project doesn't pause ([keep-alive.yml](.github/workflows/keep-alive.yml)).
- Database changes are not deployed automatically: run `npx supabase db push --remote` after adding a migration.
- **Sign-in is passwordless** (no passwords exist): the site emails a link and an 8-digit code ([supabase/templates/sign_in.html](supabase/templates/sign_in.html)). Emails go out through a Gmail account with an app password. `config.toml` reads its credentials from `POTLUCK_SMTP_USER` (the Gmail address) and `POTLUCK_SMTP_PASS` (the app password), so set both when running `npx supabase config push`; never commit them. The SMTP rate limit is 30 emails an hour. The admin script sends the getting-started email ([scripts/welcome.mjs](scripts/welcome.mjs)) through the same Gmail account, reading the same two env vars or else `~/.config/potluck/smtp` (address, then app password). Scripts and tests sign users in with codes from the admin API, which sends no email.
