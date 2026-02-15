# Local AGENTS Runbook (Not Public Web Content)

This file is for local repo operators and coding agents. It is not served by the website.

## Project Identity (Supabase)

- Supabase project ref: `mztjbnjfgsaydbrqnvnb`
- Supabase URL: `https://mztjbnjfgsaydbrqnvnb.supabase.co`
- Supabase MCP endpoint:
  - `https://mcp.supabase.com/mcp?project_ref=mztjbnjfgsaydbrqnvnb`
  - Example config snippet:
    - `{"mcpServers":{"supabase":{"url":"https://mcp.supabase.com/mcp?project_ref=mztjbnjfgsaydbrqnvnb"}}}`

Notes:
- Do not put `SUPABASE_SERVICE_ROLE_KEY` anywhere client-exposed (frontend, extension, public docs).
- The frontend uses a publishable key (safe to ship) such as `sb_publishable_...` for `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`.

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
- `supabase/agent_conversation_storage_migration.sql`
- `supabase/agent_billing_trial_migration.sql`
- `supabase/profile_private_and_rpc_lockdown_migration.sql`

If Supabase CLI is configured, run your normal migration/push flow. Otherwise apply SQL in Supabase SQL Editor before app deploys that depend on new tables/functions.

### Remote Migrations (Supabase CLI)

This repo is linked (via `supabase/.temp/project-ref`). Helpful commands:
- List migration status (local vs remote): `supabase migration list --linked`
- Push pending migrations: `supabase db push --linked`

Important:
- `supabase db push --linked` may require a DB password (`--password`) depending on your org/project settings.
- If you applied a migration manually in Supabase SQL Editor, it will not appear in `supabase_migrations.schema_migrations` unless you also repair history. Optional:
  - `supabase migration repair <version> --status applied --linked`

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
