# Local AGENTS Runbook (Not Public Web Content)

This file is for local repo operators and coding agents. It is not served by the website.

## Deploy Across Stack

Repository root: `/Users/joshuafarrow/Projects/mnemolog`

### Preflight

1. Confirm branch and status:
   - `git branch --show-current`
   - `git status --short`
2. Validate worker TypeScript:
   - `cd worker && npx tsc --noEmit`
3. Ensure Cloudflare auth works:
   - `npx wrangler whoami`

### Optional DB Migration Step (Supabase)

Apply SQL migrations when schema changed:

- `supabase/agent_tokens_migration.sql`
- `supabase/agent_feedback_migration.sql`
- `supabase/agent_telemetry_migration.sql`
- `supabase/agent_oauth_m2m_migration.sql`

If Supabase CLI is configured, run your normal migration/push flow. Otherwise apply SQL in Supabase SQL Editor before app deploys that depend on new tables/functions.

### Deploy Order

1. Deploy API worker:
   - `cd worker && npx wrangler deploy`
2. Deploy static + Pages worker:
   - `cd frontend && npx wrangler pages deploy . --project-name mnemolog`

### Smoke Checks

Run a fast endpoint verification:

- `curl -s https://mnemolog.com/api/health`
- `curl -s https://mnemolog.com/api/agents/status`
- `curl -s https://mnemolog.com/api/agents/capabilities`
- `curl -s https://mnemolog.com/.well-known/agent.json`
- `curl -s https://mnemolog.com/agents/progress.md`

### One-Command Deploy

Use:

- `./scripts/deploy_stack.sh`

Options:

- `./scripts/deploy_stack.sh --skip-checks`
- `./scripts/deploy_stack.sh --skip-worker`
- `./scripts/deploy_stack.sh --skip-pages`

### Notes

- `wrangler pages deploy` warns on dirty git state. That warning is expected during active work.
- Keep `frontend/agents/agents.md` public-facing and protocol-focused.
- Keep this file local/operator-focused.
