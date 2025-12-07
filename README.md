# Mnemolog

Conversations that persist. A living archive for human-AI collaboration.

What it is: a public archive where people can publish AI conversations that mattered—creative breakthroughs, research notes, philosophical threads, and personal moments worth remembering. Each share is reviewed for privacy (redaction step), then becomes linkable, searchable, and discoverable by others and future AIs.

Key flows:
- Share: paste a link (Claude/GPT/etc.) or raw text; we scrape or parse, flag sensitive info, and let you redact before publishing.
- Explore: browse the archive with filters (platforms, tags), search, and view featured picks.
- View: conversations live at `/c/<uuid>` with platform badge, metadata, and tags.
- Profile: see and manage your own published conversations.

## Stack

- **Frontend**: Static HTML/CSS/JS → Cloudflare Pages
- **API**: Cloudflare Workers (TypeScript)
- **Database**: Supabase (PostgreSQL)
- **Auth**: Supabase Auth (Google, GitHub, Email)

## Project Structure

```
mnemolog/
├── frontend/               # Static site → Cloudflare Pages
│   ├── index.html          # Homepage
│   ├── share.html          # Share conversation flow (link scrape + raw text fallback)
│   ├── conversation.html   # Public conversation view
│   ├── explore.html        # Explore/browse conversations
│   ├── faq.html            # FAQ
│   ├── privacy.html        # Privacy policy
│   ├── terms.html          # Terms of use
│   ├── auth/callback/      # Supabase auth callback page
│   ├── assets/             # app.js + config.js
│   └── _redirects          # Pages rewrites (c/<id> → conversation)
├── worker/                 # API → Cloudflare Workers
│   ├── src/index.ts        # Main router (all endpoints)
│   ├── wrangler.toml       # Includes browser binding for scrape
│   └── package.json
└── supabase/
    └── schema.sql      # Database schema
```

## Setup

### 1. Supabase

1. Create project at https://supabase.com
2. Run `supabase/schema.sql` in SQL Editor
3. Enable Auth providers (Google, GitHub) in Authentication → Providers
4. Copy your project URL and anon key

### 2. Cloudflare Worker

```bash
cd worker
npm install
# Ensure wrangler.toml has:
# compatibility_date = "2025-12-06"
# compatibility_flags = ["nodejs_compat"]
# [browser] binding = "BROWSER"
# Add your Supabase credentials under [vars] or via `wrangler secret put`
npm run dev    # Local development
npm run deploy # Deploy to Cloudflare
```

Browser rendering for `/api/scrape`:
- Add a Browser Rendering binding named `BROWSER` in the Cloudflare dashboard (Workers & Pages → mnemolog-api → Settings → Browser Rendering).
- The binding requires `compatibility_flags = ["nodejs_compat"]` in `wrangler.toml`.
- Install the runtime SDK: `npm install @cloudflare/puppeteer`.

### 3. Frontend

```bash
cd frontend
# Deploy to Cloudflare Pages via dashboard or:
npx wrangler pages deploy . --project-name=mnemolog
```

## Environment Variables (Worker)

```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...  # For server-side operations
```

## API Endpoints

```
GET     /api/auth/user                # Get current user
POST    /api/conversations            # Create conversation (auth required)
GET     /api/conversations            # List public conversations (filters: limit, offset, platform, tag, q)
GET     /api/conversations/:id        # Get single conversation (public or owner)
PUT     /api/conversations/:id        # Update (owner)
DELETE  /api/conversations/:id        # Delete (owner)
GET     /api/users/:userId/conversations # User’s conversations (public unless owner)
GET     /api/scrape?url=...&selector=... # Scrape public share page (browser rendering)
```

## Frontend Routes

- `/` — homepage
- `/share` — submit/publish a conversation
- `/c/<uuid>` → `/conversation/<uuid>` — public conversation view (rewritten by `_redirects`)
- `/explore` — browse conversations (filters/search)
- `/faq` — FAQ
- `/privacy` — privacy policy
- `/terms` — terms of use

Share flow supports two inputs:
- Paste a share link (recommended): uses `/api/scrape` to fetch content.
- Paste raw text (fallback): client-side parser + preview.

**Deployment notes**
- Pages: `cd frontend && npx wrangler pages deploy . --project-name=mnemolog` (ensure `_redirects` ships so `/c/<id>` works).
- Worker: `cd worker && npm install && npm run deploy` after API changes.
- Scrape: browser rendering requires the `BROWSER` binding, `compatibility_flags = ["nodejs_compat"]`, and the `@cloudflare/puppeteer` dependency. Once configured, `/api/scrape` launches a headless browser to execute JS and extract rendered text.
