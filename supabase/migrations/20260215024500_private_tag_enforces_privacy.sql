-- If a conversation is tagged "private", it must not be publicly visible.
-- This is enforced at the RLS policy layer and by normalizing existing rows.

begin;

-- Update the public select policy to exclude private-tagged conversations.
drop policy if exists "Public conversations are viewable by everyone" on public.conversations;
create policy "Public conversations are viewable by everyone"
    on public.conversations for select
    using (
        is_public = true
        and not (coalesce(tags, '{}'::text[]) @> array['private'])
    );

-- Normalize existing data: a private tag always forces is_public = false.
update public.conversations
set is_public = false
where is_public = true
  and (coalesce(tags, '{}'::text[]) @> array['private']);

commit;

