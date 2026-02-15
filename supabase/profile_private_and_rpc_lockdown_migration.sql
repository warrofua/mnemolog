-- Move billing/stripe fields out of public.profiles into an owner-only table.
-- Also lock down SECURITY DEFINER RPC execution from anon/authenticated roles.
--
-- Apply in Supabase SQL Editor (recommended ASAP if production is live).

begin;

-- Ensure helper exists (idempotent).
create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

-- 1) Private billing table
create table if not exists public.profile_private (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  stripe_customer_id text,
  billing_plan text,
  billing_status text,
  billing_updated_at timestamptz,
  billing_trial_started_at timestamptz,
  billing_trial_ends_at timestamptz,
  billing_trial_consumed_at timestamptz,
  billing_trial_reminder_sent_at timestamptz,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create unique index if not exists profile_private_stripe_customer_id_idx
  on public.profile_private (stripe_customer_id);
create index if not exists profile_private_billing_trial_started_idx
  on public.profile_private (billing_trial_started_at);

alter table public.profile_private enable row level security;

drop policy if exists "Users can view own private profile" on public.profile_private;
create policy "Users can view own private profile"
  on public.profile_private for select
  using (auth.uid() = profile_id);

drop policy if exists "Users can insert own private profile" on public.profile_private;
create policy "Users can insert own private profile"
  on public.profile_private for insert
  with check (auth.uid() = profile_id);

drop policy if exists "Users can update own private profile" on public.profile_private;
create policy "Users can update own private profile"
  on public.profile_private for update
  using (auth.uid() = profile_id)
  with check (auth.uid() = profile_id);

-- Keep updated_at fresh
drop trigger if exists update_profile_private_updated_at on public.profile_private;
create trigger update_profile_private_updated_at
  before update on public.profile_private
  for each row execute procedure public.update_updated_at_column();

-- 2) Migrate existing billing fields from profiles -> profile_private
insert into public.profile_private (
  profile_id,
  stripe_customer_id,
  billing_plan,
  billing_status,
  billing_updated_at,
  billing_trial_started_at,
  billing_trial_ends_at,
  billing_trial_consumed_at,
  billing_trial_reminder_sent_at
)
select
  id,
  stripe_customer_id,
  billing_plan,
  billing_status,
  billing_updated_at,
  billing_trial_started_at,
  billing_trial_ends_at,
  billing_trial_consumed_at,
  billing_trial_reminder_sent_at
from public.profiles
on conflict (profile_id) do update set
  stripe_customer_id = excluded.stripe_customer_id,
  billing_plan = excluded.billing_plan,
  billing_status = excluded.billing_status,
  billing_updated_at = excluded.billing_updated_at,
  billing_trial_started_at = excluded.billing_trial_started_at,
  billing_trial_ends_at = excluded.billing_trial_ends_at,
  billing_trial_consumed_at = excluded.billing_trial_consumed_at,
  billing_trial_reminder_sent_at = excluded.billing_trial_reminder_sent_at;

-- Ensure every profile has a private row (nulls) so app code can maybeSingle()
insert into public.profile_private (profile_id)
select id from public.profiles
on conflict (profile_id) do nothing;

-- 3) Drop sensitive columns from public.profiles (prevents public leakage)
-- These are now stored in public.profile_private.
alter table public.profiles
  drop column if exists stripe_customer_id,
  drop column if exists billing_plan,
  drop column if exists billing_status,
  drop column if exists billing_updated_at,
  drop column if exists billing_trial_started_at,
  drop column if exists billing_trial_ends_at,
  drop column if exists billing_trial_consumed_at,
  drop column if exists billing_trial_reminder_sent_at;

drop index if exists profiles_stripe_customer_id_idx;
drop index if exists profiles_billing_trial_started_idx;

-- 4) Make handle_new_user() also create a profile_private row (idempotent)
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
  )
  on conflict (id) do nothing;

  insert into public.profile_private (profile_id)
  values (new.id)
  on conflict (profile_id) do nothing;

  return new;
end;
$$;

-- 5) Lock down SECURITY DEFINER RPC execution from anon/authenticated.
-- The worker uses service_role for view-count increments.
revoke execute on function public.increment_view_count(uuid) from public, anon, authenticated;
grant execute on function public.increment_view_count(uuid) to service_role;

revoke execute on function public.increment_feedback_upvote_count(uuid) from public, anon, authenticated;
grant execute on function public.increment_feedback_upvote_count(uuid) to service_role;

commit;

