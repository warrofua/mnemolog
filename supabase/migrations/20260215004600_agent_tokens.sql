-- Agent token schema migration
-- Apply in Supabase SQL editor or via CLI.

create table if not exists public.agent_tokens (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    name text not null,
    token_hash text not null unique,
    scopes text[] not null default '{}',
    status text not null default 'active' check (status in ('active', 'revoked')),
    expires_at timestamptz,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists agent_tokens_user_id_idx
    on public.agent_tokens (user_id);

create index if not exists agent_tokens_status_idx
    on public.agent_tokens (status);

alter table public.agent_tokens enable row level security;

drop policy if exists "Users can view own agent tokens" on public.agent_tokens;
create policy "Users can view own agent tokens"
    on public.agent_tokens for select
    using (auth.uid() = user_id);

drop policy if exists "Users can insert own agent tokens" on public.agent_tokens;
create policy "Users can insert own agent tokens"
    on public.agent_tokens for insert
    with check (auth.uid() = user_id);

drop policy if exists "Users can update own agent tokens" on public.agent_tokens;
create policy "Users can update own agent tokens"
    on public.agent_tokens for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

drop trigger if exists update_agent_tokens_updated_at on public.agent_tokens;
create trigger update_agent_tokens_updated_at
    before update on public.agent_tokens
    for each row execute procedure public.update_updated_at_column();
