-- Agent conversation visibility + storage governance migration
-- Apply in Supabase SQL editor or via CLI.

alter table public.conversations
    add column if not exists created_via_agent_auth boolean not null default false,
    add column if not exists created_by_agent_token_id uuid,
    add column if not exists created_by_oauth_client_id uuid,
    add column if not exists agent_payload_bytes integer not null default 0;

alter table public.conversations
    drop constraint if exists conversations_agent_payload_bytes_check;

alter table public.conversations
    add constraint conversations_agent_payload_bytes_check
    check (agent_payload_bytes >= 0);

create index if not exists conversations_agent_origin_idx
    on public.conversations(created_via_agent_auth, created_at desc);

create index if not exists conversations_agent_owner_idx
    on public.conversations(user_id, created_via_agent_auth, created_at desc);

do $$
begin
    if to_regclass('public.agent_tokens') is not null
       and not exists (
        select 1
        from pg_constraint
        where conname = 'conversations_created_by_agent_token_fk'
    ) then
        alter table public.conversations
            add constraint conversations_created_by_agent_token_fk
            foreign key (created_by_agent_token_id)
            references public.agent_tokens(id)
            on delete set null;
    end if;
end
$$;

do $$
begin
    if to_regclass('public.agent_oauth_clients') is not null
       and not exists (
        select 1
        from pg_constraint
        where conname = 'conversations_created_by_oauth_client_fk'
    ) then
        alter table public.conversations
            add constraint conversations_created_by_oauth_client_fk
            foreign key (created_by_oauth_client_id)
            references public.agent_oauth_clients(id)
            on delete set null;
    end if;
end
$$;
