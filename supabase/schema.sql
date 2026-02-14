-- Mnemolog Database Schema
-- Run this in Supabase SQL Editor

create extension if not exists "uuid-ossp";

-- Users table (extends Supabase auth.users)
create table public.profiles (
    id uuid references auth.users on delete cascade primary key,
    display_name text,
    avatar_url text,
    bio text,
    website text,
    stripe_customer_id text,
    billing_plan text,
    billing_status text,
    billing_updated_at timestamp with time zone,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create unique index if not exists profiles_stripe_customer_id_idx
    on public.profiles (stripe_customer_id);

-- Conversations table
create table public.conversations (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,
    
    -- Core content
    title text not null,
    description text,
    platform text not null check (platform in ('claude', 'chatgpt', 'gemini', 'grok', 'other')),
    
    -- Conversation data stored as JSONB array of {role: string, content: string}
    messages jsonb not null default '[]'::jsonb,
    
    -- Metadata
    tags text[] default '{}',
    is_public boolean default true,
    show_author boolean default true,
    model_id text,
    model_display_name text,
    platform_conversation_id text,
    attribution_confidence text check (attribution_confidence in ('verified', 'inferred', 'claimed')),
    attribution_source text check (attribution_source in ('network_intercept', 'page_state', 'dom_scrape', 'user_reported')),
    pii_scanned boolean default false,
    pii_redacted boolean default false,
    source text check (source in ('extension', 'web', 'api')),
    
    -- Continuations / provider lineage
    root_conversation_id uuid,
    parent_conversation_id uuid,
    provider text,
    model text,
    intent_type text,
    user_goal text,
    
    -- Stats (denormalized for performance)
    view_count integer default 0,
    
    -- Timestamps
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Indexes for common queries
create index conversations_user_id_idx on public.conversations(user_id);
create index conversations_created_at_idx on public.conversations(created_at desc);
create index conversations_platform_idx on public.conversations(platform);
create index conversations_tags_idx on public.conversations using gin(tags);
create index conversations_is_public_idx on public.conversations(is_public) where is_public = true;
create index if not exists conversations_root_idx on public.conversations(root_conversation_id);
create index if not exists conversations_parent_idx on public.conversations(parent_conversation_id);

-- Full-text search index
alter table public.conversations add column fts tsvector 
    generated always as (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
        to_tsvector('english', coalesce(messages::text, ''))
    ) stored;

create index conversations_fts_idx on public.conversations using gin(fts);

-- Messages table (normalized storage for convo turns)
create table if not exists public.messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references public.conversations(id) on delete cascade,
    role text not null,            -- 'human' | 'assistant' | 'system' | 'meta'
    content jsonb not null,        -- e.g., { "text": "..." }
    order_index integer not null,
    created_at timestamptz default now()
);

create index if not exists messages_conversation_order_idx
    on public.messages (conversation_id, order_index);

-- Row Level Security for messages
alter table public.messages enable row level security;

-- Allow select when conversation is public or owned by viewer
create policy if not exists "Messages visible if convo public or owned"
    on public.messages for select
    using (
        exists (
            select 1 from public.conversations c
            where c.id = conversation_id
              and (c.is_public = true or c.user_id = auth.uid())
        )
    );

-- Allow insert/update/delete only if viewer owns the conversation
create policy if not exists "Insert messages for owned convo"
    on public.messages for insert
    with check (
        exists (
            select 1 from public.conversations c
            where c.id = conversation_id
              and c.user_id = auth.uid()
        )
    );

create policy if not exists "Update messages for owned convo"
    on public.messages for update
    using (
        exists (
            select 1 from public.conversations c
            where c.id = conversation_id
              and c.user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1 from public.conversations c
            where c.id = conversation_id
              and c.user_id = auth.uid()
        )
    );

create policy if not exists "Delete messages for owned convo"
    on public.messages for delete
    using (
        exists (
            select 1 from public.conversations c
            where c.id = conversation_id
              and c.user_id = auth.uid()
        )
    );

-- Agents poll storage
create table if not exists public.agent_poll_votes (
    id uuid primary key default gen_random_uuid(),
    poll_id text not null,
    option_id text not null,
    voter_hash text not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create unique index if not exists agent_poll_votes_unique_idx
    on public.agent_poll_votes (poll_id, voter_hash);

create index if not exists agent_poll_votes_poll_idx
    on public.agent_poll_votes (poll_id);

alter table public.agent_poll_votes enable row level security;

create policy if not exists "Agent poll votes viewable by service role"
    on public.agent_poll_votes for select
    using (auth.role() = 'service_role');

create policy if not exists "Agent poll votes insertable by service role"
    on public.agent_poll_votes for insert
    with check (auth.role() = 'service_role');

-- Agent API tokens (hashed-at-rest)
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

create policy if not exists "Users can view own agent tokens"
    on public.agent_tokens for select
    using (auth.uid() = user_id);

create policy if not exists "Users can insert own agent tokens"
    on public.agent_tokens for insert
    with check (auth.uid() = user_id);

create policy if not exists "Users can update own agent tokens"
    on public.agent_tokens for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- Agent feedback items (questions/features/polls)
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

-- Agent feedback votes (one vote per identity per item)
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

-- Links between feedback items
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

-- Feedback event log (audit trail)
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

-- Agent telemetry events (request/latency/error observability)
create table if not exists public.agent_telemetry_events (
    id uuid primary key default gen_random_uuid(),
    endpoint text not null,
    method text not null,
    feature_area text not null,
    auth_mode text not null check (auth_mode in ('none', 'anonymous', 'user_jwt', 'agent_token')),
    status_code integer not null,
    status_class text not null check (status_class in ('1xx', '2xx', '3xx', '4xx', '5xx')),
    duration_ms integer not null check (duration_ms >= 0),
    success boolean not null,
    request_path text,
    identity_hash text,
    request_id text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists agent_telemetry_events_created_idx
    on public.agent_telemetry_events (created_at desc);
create index if not exists agent_telemetry_events_endpoint_idx
    on public.agent_telemetry_events (endpoint, created_at desc);
create index if not exists agent_telemetry_events_feature_idx
    on public.agent_telemetry_events (feature_area, created_at desc);
create index if not exists agent_telemetry_events_auth_idx
    on public.agent_telemetry_events (auth_mode, created_at desc);
create index if not exists agent_telemetry_events_status_idx
    on public.agent_telemetry_events (status_class, created_at desc);

alter table public.agent_telemetry_events enable row level security;

create policy if not exists "Agent telemetry readable by service role"
    on public.agent_telemetry_events for select
    using (auth.role() = 'service_role');

create policy if not exists "Agent telemetry writable by service role"
    on public.agent_telemetry_events for all
    using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

-- Bookmarks table
create table public.bookmarks (
    id uuid primary key default uuid_generate_v4(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    conversation_id uuid not null references public.conversations(id) on delete cascade,
    created_at timestamptz not null default now(),
    unique (user_id, conversation_id)
);

create index idx_bookmarks_user_id on public.bookmarks(user_id);
create index idx_bookmarks_conversation_id on public.bookmarks(conversation_id);

-- Row Level Security
alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.bookmarks enable row level security;

-- Profiles policies
create policy "Public profiles are viewable by everyone"
    on public.profiles for select
    using (true);

create policy "Users can update own profile"
    on public.profiles for update
    using (auth.uid() = id);

-- Conversations policies
create policy "Public conversations are viewable by everyone"
    on public.conversations for select
    using (is_public = true);

create policy "Users can view own conversations"
    on public.conversations for select
    using (auth.uid() = user_id);

create policy "Users can create conversations"
    on public.conversations for insert
    with check (auth.uid() = user_id);

create policy "Users can update own conversations"
    on public.conversations for update
    using (auth.uid() = user_id);

create policy "Users can delete own conversations"
    on public.conversations for delete
    using (auth.uid() = user_id);

-- Bookmarks policies (authenticated users only)
create policy "Users can view own bookmarks"
    on public.bookmarks for select
    to authenticated
    using (auth.uid() = user_id);

create policy "Users can insert own bookmarks for public or owned conversations"
    on public.bookmarks for insert
    to authenticated
    with check (
        auth.uid() = user_id
        and exists (
            select 1 from public.conversations c
            where c.id = conversation_id
              and (c.is_public = true or c.user_id = auth.uid())
        )
    );

create policy "Users can update own bookmarks"
    on public.bookmarks for update
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create policy "Users can delete own bookmarks"
    on public.bookmarks for delete
    to authenticated
    using (auth.uid() = user_id);

-- Allow policy subqueries to see conversations
grant select on public.conversations to authenticated;

-- Function to auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
    insert into public.profiles (id, display_name, avatar_url)
    values (
        new.id,
        coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
        new.raw_user_meta_data->>'avatar_url'
    );
    return new;
end;
$$;

-- Trigger for new user signup
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();

-- Function to update updated_at timestamp
create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = timezone('utc'::text, now());
    return new;
end;
$$;

-- Triggers for updated_at
create trigger update_profiles_updated_at
    before update on public.profiles
    for each row execute procedure public.update_updated_at_column();

create trigger update_conversations_updated_at
    before update on public.conversations
    for each row execute procedure public.update_updated_at_column();

create trigger update_agent_tokens_updated_at
    before update on public.agent_tokens
    for each row execute procedure public.update_updated_at_column();

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

-- Function to increment view count
create or replace function public.increment_view_count(conversation_id uuid)
returns void
language plpgsql
security definer
as $$
begin
    update public.conversations
    set view_count = view_count + 1
    where id = conversation_id;
end;
$$;
