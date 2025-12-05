# Mnemolog

Conversations that persist. A living archive for human-AI collaboration.

## Stack

- **Frontend**: Static HTML/CSS/JS → Cloudflare Pages
- **API**: Cloudflare Workers (TypeScript)
- **Database**: Supabase (PostgreSQL)
- **Auth**: Supabase Auth (Google, GitHub, Email)

## Project Structure

```
mnemolog/
├── frontend/           # Static site → Cloudflare Pages
│   ├── index.html      # Homepage
│   ├── share.html      # Share conversation flow
│   └── assets/
├── worker/             # API → Cloudflare Workers
│   ├── src/
│   │   ├── index.ts    # Main router
│   │   ├── auth.ts     # Auth middleware
│   │   ├── conversations.ts
│   │   └── users.ts
│   ├── wrangler.toml
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
cp wrangler.toml.example wrangler.toml
# Add your Supabase credentials to wrangler.toml
npm run dev    # Local development
npm run deploy # Deploy to Cloudflare
```

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
POST   /api/auth/callback     # OAuth callback
GET    /api/auth/user         # Get current user
POST   /api/conversations     # Create conversation
GET    /api/conversations     # List conversations (public)
GET    /api/conversations/:id # Get single conversation
GET    /api/users/:id/conversations # User's conversations
DELETE /api/conversations/:id # Delete (owner only)
```
