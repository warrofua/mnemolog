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
