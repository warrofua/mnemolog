# Changelog

## 2025-12-13
- Extension “Preview & Edit” now persists data via `chrome.storage` and loads reliably on the share page; attribution/provenance fields (model_id/display/platform_conversation_id, PII flags, source='extension') are preserved when publishing.
- Grok extraction: added grok.com support, x.com header stripping (“Grok … / Thinking / Beta”), model detection (Grok 4.1 (Beta)), and stronger echo-pruning/role alternation to reduce duplicate AI/human turns.
- Share page: added per-message Delete in review/redaction; deleting reflows auto-assigned roles for unlabeled convos.
- System prompt/provenance: Nemo prompt carries model/user/date metadata into continuations; continue/chat flows use the streaming Supabase function with richer fallbacks.

## 2025-12-12
- Rebranded “Continue with AI” to “Continue with nemo” (new system prompt, tooltip, title font, lowercase styling) and updated modal copy.
- Improved continuation flow: auto-scroll on new continuations, live streaming placeholders/spinner, inline meta blocks showing continuation prompts, and hiding composer while streaming.
- Added mobile tweaks: hero CTA text shortens to “Explore Archive”, footer links centered in a grid, Continue button centered/narrower on mobile, and reduced empty-state CTA size (arrow removed).
- System prompt now frames Nemo as a continuity bridge with attribution/provenance; removed “avoid hallucinations”.
- Surfaced Chrome extension links on FAQ and Share page; README mentions extension.

## 2025-12-11
- Added Originals / Continuations / Bookmarked tabs on the profile with per-tab search; restored dark-mode toggle on profile.
- Continuation UX: header “Visit original” link, single continuations panel, continuation badges/metadata, and inline prompt excerpts for continuations across explore/profile cards.
- Trending tags (last 24h) surfaced on Explore via new `/api/tags/trending` endpoint.
- View counters now use eye icons on cards (Explore/Profile) and are consistent with continuation excerpts (prompt for continuations).
- README refreshed (continuations/chat, bookmarks, trending tags, endpoints/envs).
- AI integration: Supabase `continue` function (DeepSeek, streaming) documented; conversation page supports “Continue with AI” and streaming chat follow-ups via `/api/conversations/:id/messages` proxy.

## 2025-12-10
- Added bookmarks so users can save/flag important conversations.
- Bookmarks persist server-side and surface in the "Bookmarked" tab on Your Archive (/api/bookmarks).
- Upgraded display logic for newly ingested conversations so they can be highlighted on the main index page in near real time.
- Refined homepage curation with rotating conversation showcases and updated imagery.
- Dynamic OG/Twitter previews for `/c/<id>` fixed/updated (correct titles, descriptions, and OG images for shares).

## 2025-12-09
- Integrated the Chrome extension with mnemolog for one-click conversation capture.
- Added support for private conversations and adjusted UI logic to respect visibility settings.
- Updated README and site copy to document the new capture flow and privacy model.

## 2025-12-08
- Implemented dark mode and icon set for a cleaner, more modern UI.
- Added conversation previews and improved parser/merge logic for stitching multi-part chats.
- Updated profile and explore pages to align with the new visual language and core product flow.

## 2025-12-07 through 2025-12-05
- Setup frontend structure and database (Supabase).
- Added `.gitignore`, `robots.txt`, and `config.js`.
- Implemented basic auth, FAQ, conversation views, explore, and profile pages to form the initial MVP skeleton.
- Conceptualized, researched the non-existence of such a thing as Mnemolog, and decided to execute
