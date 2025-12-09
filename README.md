# Mnemolog

Conversations that persist. A living archive for human-AI collaboration.

What it is: a public archive where people can publish AI conversations that mattered—creative breakthroughs, research notes, philosophical threads, and personal moments worth remembering. Each share is reviewed for privacy (redaction step), then becomes linkable, searchable, and discoverable by others and future AIs.

Key flows:
- Share: paste raw text; we parse, flag sensitive info, and let you redact before publishing. Owners can later edit/re-parse.
- Explore: browse the archive with filters (platforms, tags), search, and view featured picks.
- View: conversations live at `/c/<uuid>` with platform badge, metadata, and tags.
- Profile: see and manage your own published conversations.

## Stack

- **Frontend**: Static HTML/CSS/JS → Cloudflare Pages
- **API**: Cloudflare Workers (TypeScript)
- **Database**: Supabase (PostgreSQL)
- **Auth**: Supabase Auth (Google, GitHub)
- **Link previews**: Pages `_worker.js` injects dynamic OpenGraph tags for `/c/<uuid>` by fetching metadata from the API worker.
- **Theme**: User-selectable light/dark mode (persists via local storage) exposed in the site header.
- **Extension archive API**: `/api/archive` accepts structured JSON from the browser extension (includes attribution, model IDs, and PII flags).
- **Attribution fields**: Conversations store `model_id`, `model_display_name`, `platform_conversation_id`, `attribution_confidence` (verified/inferred/claimed), `attribution_source` (network_intercept/page_state/dom_scrape/user_reported), PII flags, and `source` (extension/web/api) to display provenance badges.

## Project Structure

```
mnemolog/
├── frontend/               # Static site → Cloudflare Pages
│   ├── index.html          # Homepage
│   ├── share.html          # Share conversation flow (raw text parsing + redaction)
│   ├── conversation.html   # Public conversation view
│   ├── explore.html        # Explore/browse conversations
│   ├── faq.html            # FAQ
│   ├── privacy.html        # Privacy policy
│   ├── terms.html          # Terms of use
│   ├── _worker.js          # Pages worker for dynamic OG tags on /c/<id>
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
# Add your Supabase credentials under [vars] or via `wrangler secret put`
npm run dev    # Local development
npm run deploy # Deploy to Cloudflare
```

Note: The browser rendering binding was removed; the API worker now runs with standard `nodejs_compat` only. If you reintroduce scraping that needs a headless browser, add the binding and dependency explicitly.

### 3. Frontend

```bash
cd frontend
# Deploy to Cloudflare Pages via dashboard or:
npx wrangler pages deploy . --project-name mnemolog --branch main --commit-dirty=true
```

## Environment Variables

```
# Pages (_worker.js for OG tags does not require secrets, but the API URL is in config.js)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...

# Worker (API)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...  # For server-side operations
```

## API Endpoints

```
GET     /api/auth/user                # Get current user
POST    /api/conversations            # Create conversation (auth required)
POST    /api/archive                  # Archive from extension (auth required; structured payload)
GET     /api/conversations            # List public conversations (filters: limit, offset, platform, tag, q, sort=newest|oldest|views)
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

Share flow:
- Paste raw text: client-side parser + preview/redaction.
- First-speaker toggle and merge/split tools to fix roles.
- Owners can re-parse/edit existing conversations via the “Edit / Re-parse” button on their conversation page.

**Deployment notes**
- Pages: `cd frontend && npx wrangler pages deploy . --project-name=mnemolog` (ensure `_redirects` ships so `/c/<id>` works).
- Worker: `cd worker && npm install && npm run deploy` after API changes.
- Link previews: `_worker.js` injects OG/Twitter tags on `/c/<id>` by fetching conversation metadata from the API worker.
- Icons: favicons/logos live in `frontend/assets/mnemolog-fav-icon.svg`, `mnemolog-logo-light.svg`, `mnemolog-logo-dark.svg`; OG previews use the dark logo.
- Profiles: users can set an avatar image URL on `profile.html`; any publicly hosted image URL works (e.g., an image you host under `/assets/`).
- Theme: users can toggle light/dark in the header; preference is stored in `localStorage` and applied across pages.
- Attribution/PII fields: conversations store model_id, model_display_name, platform_conversation_id, attribution_confidence/source, pii_scanned, pii_redacted, and source for provenance tracking (extension/web/api).
- Browse UI: Explore/profile/conversation pages now display model and attribution badges pulled from the database, and cards respect dark mode.
- Browser extension: parsers upgraded for Claude, Gemini, Grok, and ChatGPT DOM structures to capture ordered turns with correct roles; archive calls post to `/api/archive` with attribution metadata.

## License

MIT License — see `LICENSE`
