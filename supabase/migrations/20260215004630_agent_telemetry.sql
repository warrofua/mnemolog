-- Agent telemetry migration

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
    created_at timestamptz default timezone('utc'::text, now()) not null
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

drop policy if exists "Agent telemetry readable by service role" on public.agent_telemetry_events;
create policy "Agent telemetry readable by service role"
    on public.agent_telemetry_events for select
    using (auth.role() = 'service_role');

drop policy if exists "Agent telemetry writable by service role" on public.agent_telemetry_events;
create policy "Agent telemetry writable by service role"
    on public.agent_telemetry_events for all
    using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
