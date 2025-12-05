-- Mnemolog Database Schema
-- Run this in Supabase SQL Editor

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Users table (extends Supabase auth.users)
create table public.profiles (
    id uuid references auth.users on delete cascade primary key,
    display_name text,
    avatar_url text,
    bio text,
    website text,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

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

-- Full-text search index
alter table public.conversations add column fts tsvector 
    generated always as (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(description, '')), 'B')
    ) stored;

create index conversations_fts_idx on public.conversations using gin(fts);

-- Row Level Security
alter table public.profiles enable row level security;
alter table public.conversations enable row level security;

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
