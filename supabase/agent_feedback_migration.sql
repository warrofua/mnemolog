-- Agent feedback board migration
-- Apply in Supabase SQL editor or via CLI.

create table if not exists public.agent_feedback_items (
    id uuid primary key default gen_random_uuid(),
    type text not null check (type in ('question', 'feature', 'poll')),
    title text not null,
    body text,
    tags text[] not null default '{}',
    status text not null default 'open' check (status in ('open', 'closed', 'archived')),
    allow_upvotes boolean not null default true,
    upvote_count integer not null default 0,
    posting_starts_at timestamptz,
    posting_ends_at timestamptz,
    voting_starts_at timestamptz,
    voting_ends_at timestamptz,
    created_by_user_id uuid references public.profiles(id) on delete set null,
    created_by_agent_token_id uuid references public.agent_tokens(id) on delete set null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.agent_feedback_items
    add column if not exists fts tsvector
    generated always as (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(body, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(array_to_string(tags, ' '), '')), 'C')
    ) stored;

create index if not exists agent_feedback_items_type_idx
    on public.agent_feedback_items (type);
create index if not exists agent_feedback_items_status_idx
    on public.agent_feedback_items (status);
create index if not exists agent_feedback_items_upvote_idx
    on public.agent_feedback_items (upvote_count desc);
create index if not exists agent_feedback_items_voting_end_idx
    on public.agent_feedback_items (voting_ends_at);
create index if not exists agent_feedback_items_tags_idx
    on public.agent_feedback_items using gin(tags);
create index if not exists agent_feedback_items_fts_idx
    on public.agent_feedback_items using gin(fts);

create table if not exists public.agent_feedback_votes (
    id uuid primary key default gen_random_uuid(),
    item_id uuid not null references public.agent_feedback_items(id) on delete cascade,
    voter_hash text not null,
    voter_type text not null check (voter_type in ('agent', 'user', 'anon')),
    voter_user_id uuid references public.profiles(id) on delete set null,
    voter_agent_token_id uuid references public.agent_tokens(id) on delete set null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create unique index if not exists agent_feedback_votes_unique_idx
    on public.agent_feedback_votes (item_id, voter_hash);
create index if not exists agent_feedback_votes_item_idx
    on public.agent_feedback_votes (item_id);

create table if not exists public.agent_feedback_links (
    id uuid primary key default gen_random_uuid(),
    source_item_id uuid not null references public.agent_feedback_items(id) on delete cascade,
    target_item_id uuid not null references public.agent_feedback_items(id) on delete cascade,
    relation_type text not null check (relation_type in ('duplicate_of', 'related_to', 'depends_on')),
    created_by_user_id uuid references public.profiles(id) on delete set null,
    created_by_agent_token_id uuid references public.agent_tokens(id) on delete set null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create unique index if not exists agent_feedback_links_unique_idx
    on public.agent_feedback_links (source_item_id, target_item_id, relation_type);
create index if not exists agent_feedback_links_source_idx
    on public.agent_feedback_links (source_item_id);
create index if not exists agent_feedback_links_target_idx
    on public.agent_feedback_links (target_item_id);

create table if not exists public.agent_feedback_events (
    id uuid primary key default gen_random_uuid(),
    item_id uuid not null references public.agent_feedback_items(id) on delete cascade,
    event_type text not null,
    payload jsonb not null default '{}'::jsonb,
    actor_user_id uuid references public.profiles(id) on delete set null,
    actor_agent_token_id uuid references public.agent_tokens(id) on delete set null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists agent_feedback_events_item_idx
    on public.agent_feedback_events (item_id, created_at desc);

alter table public.agent_feedback_items enable row level security;
alter table public.agent_feedback_votes enable row level security;
alter table public.agent_feedback_links enable row level security;
alter table public.agent_feedback_events enable row level security;

create policy if not exists "Agent feedback items readable by service role"
    on public.agent_feedback_items for select
    using (auth.role() = 'service_role');

create policy if not exists "Agent feedback items writable by service role"
    on public.agent_feedback_items for all
    using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

create policy if not exists "Agent feedback votes writable by service role"
    on public.agent_feedback_votes for all
    using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

create policy if not exists "Agent feedback links writable by service role"
    on public.agent_feedback_links for all
    using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

create policy if not exists "Agent feedback events writable by service role"
    on public.agent_feedback_events for all
    using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

drop trigger if exists update_agent_feedback_items_updated_at on public.agent_feedback_items;
create trigger update_agent_feedback_items_updated_at
    before update on public.agent_feedback_items
    for each row execute procedure public.update_updated_at_column();

create or replace function public.increment_feedback_upvote_count(feedback_item_id uuid)
returns void
language plpgsql
security definer
as $$
begin
    update public.agent_feedback_items
    set upvote_count = upvote_count + 1
    where id = feedback_item_id;
end;
$$;
