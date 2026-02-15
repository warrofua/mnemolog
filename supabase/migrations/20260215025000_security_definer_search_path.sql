-- Harden SECURITY DEFINER functions by pinning search_path.
-- This prevents search_path hijacking in definer context.

begin;

create or replace function public.increment_feedback_upvote_count(feedback_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    update public.agent_feedback_items
    set upvote_count = upvote_count + 1
    where id = feedback_item_id;
end;
$$;

create or replace function public.increment_view_count(conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    update public.conversations
    set view_count = view_count + 1
    where id = conversation_id;
end;
$$;

commit;

