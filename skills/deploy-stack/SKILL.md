# Deploy Stack Skill (Local)

Use this skill when asked to deploy Mnemolog across the stack.

## Goal
Deploy API worker + Pages frontend with minimal mistakes and verify core agent endpoints.

## Command

From repo root:

```bash
./scripts/deploy_stack.sh
```

Optional flags:

- `--skip-checks`
- `--skip-worker`
- `--skip-pages`

## Expected Output

- Worker deployment URL/version output from Wrangler.
- Pages deployment URL output from Wrangler.
- Smoke checks confirming:
  - `/api/health`
  - `/api/agents/status`
  - `/api/agents/capabilities`
  - `/.well-known/agent.json`
  - `/agents/progress.md`

## Caveats

- If schema changed, apply Supabase SQL migrations first (including `agent_oauth_m2m_migration.sql` when OAuth M2M changes are present).
- If Cloudflare auth expired, run `npx wrangler whoami` and re-authenticate.
