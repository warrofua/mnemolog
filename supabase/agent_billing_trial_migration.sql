-- Agent billing trial profile migration
-- Apply in Supabase SQL editor or via CLI.

alter table public.profiles
    add column if not exists billing_trial_started_at timestamptz,
    add column if not exists billing_trial_ends_at timestamptz,
    add column if not exists billing_trial_consumed_at timestamptz,
    add column if not exists billing_trial_reminder_sent_at timestamptz;

create index if not exists profiles_billing_trial_started_idx
    on public.profiles (billing_trial_started_at);
