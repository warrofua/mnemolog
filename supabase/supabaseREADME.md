## Mnemolog — Database README

### Summary
- Postgres schema and Row-Level Security (RLS) rules for Mnemolog.
- Core objects: `public.profiles`, `public.conversations`, `public.messages`, `public.bookmarks`, plus triggers and helper functions.
- Designed for Supabase: integrates with `auth.users` and relies on JWT auth (`auth.uid()`) for RLS.

### Quick overview of tables

#### public.profiles
- **Purpose:** user profiles extending Supabase `auth.users`.
- **Columns:** `id` (uuid, PK, references `auth.users`), `display_name`, `avatar_url`, `bio`, `website`, `created_at`, `updated_at`.
- **RLS:** enabled.  
  - SELECT: public (everyone can read profiles).  
  - UPDATE: users can update their own profile (`auth.uid() = id`).
- **Notes:**  
  - Trigger auto-creates a profile row after insert on `auth.users`.  
  - `updated_at` maintained by a BEFORE UPDATE trigger.

#### public.conversations
- **Purpose:** store user conversations (message history normalized into `public.messages`; legacy `messages` jsonb retained).
- **Columns:** `id` (uuid PK), `user_id` (references `public.profiles`), `title`, `description`, `platform` (enum-like check), `messages` (jsonb array, legacy), `tags` (text[]), `is_public`, `show_author`, `model_id`/`model_display_name`, `platform_conversation_id`, `attribution_confidence`, `attribution_source`, `pii_scanned`/`pii_redacted`, `source`, `view_count`, `created_at`, `updated_at`, `fts` (tsvector generated),
  lineage fields `root_conversation_id`, `parent_conversation_id`, provider/model/intent (`provider` default `mnemolog_native` now “Nemo”, `model` default `deepseek-v3.2`, `intent_type`, `user_goal`).
- **Indexes:**  
  - `conversations_user_id_idx` (user_id)  
  - `conversations_created_at_idx` (created_at DESC)  
  - `conversations_platform_idx` (platform)  
  - `conversations_tags_idx` (GIN on tags)  
  - `conversations_is_public_idx` (partial index WHERE is_public = true)  
  - `conversations_fts_idx` (GIN on generated `fts` column)
- **RLS:** enabled.  
  - SELECT: public conversations (`is_public = true`).  
  - SELECT: users can view their own (`auth.uid() = user_id`).  
  - INSERT/UPDATE/DELETE: only for own rows (`auth.uid() = user_id`).  
- **Notes:**  
  - `fts` is a generated stored tsvector combining title, description, and messages for full-text search.  
  - `view_count` increment helper is provided (security definer function).
  - Lineage (root/parent) enables continuations and threading; `provider/model` capture which backend model (Nemo/DeepSeek) was used; `intent_type/user_goal` capture continuation mode/goal.

#### public.messages
- **Purpose:** normalized message storage for conversations (preferred over legacy jsonb).
- **Columns:** `id` (uuid PK), `conversation_id` (FK → conversations ON DELETE CASCADE), `role` (text), `content` (jsonb), `order_index` (int), `created_at`.
- **Index:** `messages_conversation_order_idx` on (conversation_id, order_index).
- **RLS:** enabled.  
  - SELECT: messages of public conversations OR messages of conversations owned by the caller.  
  - INSERT/UPDATE/DELETE: only for messages in conversations owned by the caller.  
- **Notes:** legacy `conversations.messages` remains for backward compatibility; new writes/read paths should use `public.messages`.

#### public.bookmarks
- **Purpose:** allow authenticated users to bookmark conversations.
- **Columns:** `id` (uuid PK), `user_id` (references `public.profiles`), `conversation_id` (references `public.conversations`), `created_at`.
- **Indexes:** `idx_bookmarks_user_id`, `idx_bookmarks_conversation_id`.
- **Constraints:** UNIQUE(user_id, conversation_id); FKs use ON DELETE CASCADE to remove bookmarks when a profile or conversation is deleted.
- **RLS:** enabled (to `authenticated`).  
  - SELECT: users can view their own (`auth.uid() = user_id`).  
  - INSERT: only for conversations that are public or owned (EXISTS subquery on `public.conversations`).  
  - UPDATE/DELETE: own rows only.
- **Notes:** Because insert policy queries `public.conversations`, we grant SELECT on that table to `authenticated` so the EXISTS check can run in policy context.

### Triggers and helper functions

- **public.handle_new_user()**  
  AFTER INSERT on `auth.users` (trigger `on_auth_user_created`). Inserts a profile row from the new user data. SECURITY DEFINER. Consider `INSERT ... ON CONFLICT DO NOTHING` for idempotency.

- **public.update_updated_at_column()**  
  BEFORE UPDATE trigger for profiles and conversations. Sets `new.updated_at = now()` (UTC).

- **public.increment_view_count(conversation_id uuid)**  
  SECURITY DEFINER helper to bump `view_count` when a conversation is viewed.

### Extensions required
- `uuid-ossp` (uuid_generate_v4) — used for UUID defaults.
- Others you might enable: `pg_trgm`, `unaccent`, `pgcrypto`, `pg_stat_statements`, etc.

### RLS and auth notes (important)
- All RLS policies rely on `auth.uid()` (user id from Supabase JWT). Calls must include a valid user JWT for RLS to apply.
- `service_role` bypasses RLS — use only in trusted server-side contexts.
- Optional: wrap `auth.uid()` as `(SELECT auth.uid())` in policy expressions for plan stability.

### Security and operational recommendations
- Make `handle_new_user` idempotent (`ON CONFLICT DO NOTHING`).
- Revoke EXECUTE on SECURITY DEFINER functions from public roles unless required:  
  `REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;`  
  `REVOKE EXECUTE ON FUNCTION public.increment_view_count(uuid) FROM anon, authenticated;`
- If high view traffic is expected, consider batching view counts asynchronously instead of per-request updates.
- If you prefer data retention over cascading deletes, change FK `ON DELETE CASCADE` to `ON DELETE RESTRICT` and handle cleanup in application logic.

### Common example queries (dev quick-start)
- List public conversations with profile:  
  `SELECT c.*, p.display_name FROM public.conversations c JOIN public.profiles p ON p.id = c.user_id WHERE c.is_public = true ORDER BY c.created_at DESC LIMIT 20;`
- Insert a conversation (client must be authenticated; user_id must equal `auth.uid()`):  
  `INSERT INTO public.conversations (user_id, title, platform, messages) VALUES (<user_id>, 'Title', 'chatgpt', '[]'::jsonb);`
- Bookmark a public conversation (client must be authenticated):  
  `INSERT INTO public.bookmarks (user_id, conversation_id) VALUES (<user_id>, <conversation_id>);`

### Migration / dev notes
- SQL is compatible with modern Postgres versions used by Supabase. If exporting to migration tooling, keep functions/triggers idempotent (CREATE OR REPLACE FUNCTION, CREATE TABLE IF NOT EXISTS, etc.).
- Nemo (DeepSeek-backed) continuation/chat uses Supabase Edge Function `functions/continue` (streaming capable); ensure env `DEEPSEEK_API_KEY` is set.
