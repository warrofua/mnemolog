-- Agent OAuth M2M migration (MCP client-credentials)

create table if not exists public.agent_oauth_clients (
    id uuid primary key default gen_random_uuid(),
    owner_user_id uuid not null references public.profiles(id) on delete cascade,
    name text not null,
    client_id text not null unique,
    client_secret_hash text not null,
    allowed_scopes text[] not null default '{}',
    status text not null default 'active' check (status in ('active', 'revoked')),
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz default timezone('utc'::text, now()) not null,
    updated_at timestamptz default timezone('utc'::text, now()) not null
);

create index if not exists agent_oauth_clients_owner_idx
    on public.agent_oauth_clients (owner_user_id);
create index if not exists agent_oauth_clients_status_idx
    on public.agent_oauth_clients (status);
create index if not exists agent_oauth_clients_client_id_idx
    on public.agent_oauth_clients (client_id);

alter table public.agent_oauth_clients enable row level security;

drop policy if exists "Users can view own oauth clients" on public.agent_oauth_clients;
create policy "Users can view own oauth clients"
    on public.agent_oauth_clients for select
    using (auth.uid() = owner_user_id);

drop policy if exists "Users can insert own oauth clients" on public.agent_oauth_clients;
create policy "Users can insert own oauth clients"
    on public.agent_oauth_clients for insert
    with check (auth.uid() = owner_user_id);

drop policy if exists "Users can update own oauth clients" on public.agent_oauth_clients;
create policy "Users can update own oauth clients"
    on public.agent_oauth_clients for update
    using (auth.uid() = owner_user_id)
    with check (auth.uid() = owner_user_id);

create table if not exists public.agent_oauth_access_tokens (
    id uuid primary key default gen_random_uuid(),
    client_ref uuid not null references public.agent_oauth_clients(id) on delete cascade,
    token_hash text not null unique,
    scopes text[] not null default '{}',
    status text not null default 'active' check (status in ('active', 'revoked')),
    expires_at timestamptz not null,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz default timezone('utc'::text, now()) not null
);

create index if not exists agent_oauth_access_tokens_client_idx
    on public.agent_oauth_access_tokens (client_ref);
create index if not exists agent_oauth_access_tokens_status_idx
    on public.agent_oauth_access_tokens (status);
create index if not exists agent_oauth_access_tokens_expires_idx
    on public.agent_oauth_access_tokens (expires_at);

alter table public.agent_oauth_access_tokens enable row level security;

drop policy if exists "OAuth access tokens writable by service role" on public.agent_oauth_access_tokens;
create policy "OAuth access tokens writable by service role"
    on public.agent_oauth_access_tokens for all
    using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

drop trigger if exists update_agent_oauth_clients_updated_at on public.agent_oauth_clients;
create trigger update_agent_oauth_clients_updated_at
    before update on public.agent_oauth_clients
    for each row execute procedure public.update_updated_at_column();
