-- Lock down SECURITY DEFINER functions so they are not callable via PostgREST RPC by anon/authenticated.
-- This is safe to run multiple times.

begin;

revoke execute on function public.increment_view_count(uuid) from public, anon, authenticated;
grant execute on function public.increment_view_count(uuid) to service_role;

revoke execute on function public.increment_feedback_upvote_count(uuid) from public, anon, authenticated;
grant execute on function public.increment_feedback_upvote_count(uuid) to service_role;

-- Trigger function only; revoke RPC-style execution.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

commit;

