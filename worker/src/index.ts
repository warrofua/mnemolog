import { Router, IRequest } from 'itty-router';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Types
interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  DEEPSEEK_API_KEY?: string;
}

interface Message {
  role: 'human' | 'assistant';
  content: string;
}

interface ChatRequestBody {
  content: string;
}

interface CreateConversationBody {
  title: string;
  description?: string;
  platform: 'claude' | 'chatgpt' | 'gemini' | 'grok' | 'other';
  messages: Message[];
  tags?: string[];
  is_public?: boolean;
  show_author?: boolean;
  model_id?: string | null;
  model_display_name?: string | null;
  platform_conversation_id?: string | null;
  attribution_confidence?: 'verified' | 'inferred' | 'claimed' | null;
  attribution_source?: 'network_intercept' | 'page_state' | 'dom_scrape' | 'user_reported' | null;
  pii_scanned?: boolean;
  pii_redacted?: boolean;
  source?: string | null;
}

interface ArchivePayload {
  conversation?: Partial<CreateConversationBody> & {
    model?: string;
    timestamp?: string;
    conversationId?: string;
    attribution?: any;
  };
  source?: string;
  version?: string;
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Helper to create JSON response
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

// Helper to get user from auth header
async function getUser(request: IRequest, supabase: SupabaseClient) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);
  
  if (error || !user) {
    return null;
  }
  
  return user;
}

function buildConversationUrl(id: string) {
  // Primary domain for shared conversations
  return `https://mnemolog.com/c/${id}`;
}

// Helper: get table messages (ordered) and map to UI shape
async function fetchTableMessages(supabase: SupabaseClient, conversationId: string) {
  const { data: msgRows, error: msgErr } = await supabase
    .from('messages')
    .select('role, content, order_index')
    .eq('conversation_id', conversationId)
    .order('order_index', { ascending: true });
  if (msgErr || !msgRows) return [];
  return msgRows.map((m: any) => ({
    role: m.role === 'assistant' ? 'assistant' : 'human',
    content: m.content?.text ?? m.content ?? '',
  }));
}

// Helper: build DeepSeek messages from tail + new user input
function buildDeepseekChatMessages(tail: any[], userContent: string) {
  const system = 'You are nemo, derived from mnemo and living at https://mnemolog.com. Your role is to faithfully continue and bridge conversations between humans and AIs so future humans or AIs can pick up the thread with attribution and provenance.';
  return [
    { role: 'system', content: system },
    ...tail.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' })),
    { role: 'user', content: userContent },
  ];
}

async function callDeepseek(apiKey: string, messages: any[]) {
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      temperature: 0.7,
      max_tokens: 800,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`DeepSeek error: ${errText}`);
  }
  const json: any = await resp.json();
  return json.choices?.[0]?.message?.content || json.output || '';
}

// Create router
const router = Router();

// Health check
router.get('/api/health', () => json({ status: 'ok', timestamp: new Date().toISOString() }));

// Get current user
router.get('/api/auth/user', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      // Only forward the header when present to avoid sending "Authorization: null"
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  
  if (!user) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // Get profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  return json({ user, profile });
});

// Create conversation
router.post('/api/conversations', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  
  if (!user) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body: CreateConversationBody;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  // Validate required fields
  if (!body.title || !body.platform || !body.messages?.length) {
    return json({ error: 'Missing required fields: title, platform, messages' }, 400);
  }

  // Validate platform
  const validPlatforms = ['claude', 'chatgpt', 'gemini', 'grok', 'other'];
  if (!validPlatforms.includes(body.platform)) {
    return json({ error: 'Invalid platform' }, 400);
  }

  // Insert conversation
  const { data, error } = await supabase
    .from('conversations')
    .insert({
      user_id: user.id,
      title: body.title,
      description: body.description || null,
      platform: body.platform,
      messages: body.messages,
      tags: body.tags || [],
      is_public: body.is_public ?? true,
      show_author: body.show_author ?? true,
      model_id: body.model_id || null,
      model_display_name: body.model_display_name || null,
      platform_conversation_id: body.platform_conversation_id || null,
      attribution_confidence: body.attribution_confidence || null,
      attribution_source: body.attribution_source || null,
      pii_scanned: body.pii_scanned ?? false,
      pii_redacted: body.pii_redacted ?? false,
      source: body.source || 'web',
    })
    .select()
    .single();

  if (error) {
    console.error('Insert error:', error);
    return json({ error: 'Failed to create conversation' }, 500);
  }

  return json({ conversation: data }, 201);
});

// Archive conversation (extension-friendly)
router.post('/api/archive', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  if (!user) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let payload: ArchivePayload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const conv = payload.conversation || {};
  const platform = (conv.platform as CreateConversationBody['platform']) || 'other';
  const title = conv.title?.trim() || 'Untitled conversation';
  const messages = conv.messages || [];
  if (!messages.length) {
    return json({ error: 'Missing messages' }, 400);
  }

  const validPlatforms = ['claude', 'chatgpt', 'gemini', 'grok', 'other'];
  if (!validPlatforms.includes(platform)) {
    return json({ error: 'Invalid platform' }, 400);
  }

  const { data, error } = await supabase
    .from('conversations')
    .insert({
      user_id: user.id,
      title,
      description: conv.description || null,
      platform,
      messages,
      tags: conv.tags || [],
      is_public: conv.is_public ?? true,
      show_author: conv.show_author ?? true,
      model_id: conv.model_id || null,
      model_display_name: conv.model_display_name || null,
      platform_conversation_id: conv.platform_conversation_id || null,
      attribution_confidence: conv.attribution_confidence || null,
      attribution_source: conv.attribution_source || null,
      pii_scanned: conv.pii_scanned ?? true,
      pii_redacted: conv.pii_redacted ?? false,
      source: payload.source || 'extension',
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('Archive insert error:', error);
    return json({ error: 'Failed to archive conversation' }, 500);
  }

  return json({
    success: true,
    id: data.id,
    url: buildConversationUrl(data.id),
  }, 201);
});

// Update conversation (owner only)
router.put('/api/conversations/:id', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const { id } = request.params;
  let body: Partial<CreateConversationBody> & { is_public?: boolean; show_author?: boolean; messages?: any[] };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  // Verify ownership
  const { data: existing, error: fetchErr } = await supabase
    .from('conversations')
    .select('id, user_id')
    .eq('id', id)
    .single();
  if (fetchErr || !existing) return json({ error: 'Conversation not found' }, 404);
  if (existing.user_id !== user.id) return json({ error: 'Forbidden' }, 403);

  const updates: any = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.platform !== undefined) updates.platform = body.platform;
  if (body.tags !== undefined) updates.tags = body.tags;
  if (body.show_author !== undefined) updates.show_author = body.show_author;
  if (body.is_public !== undefined) updates.is_public = body.is_public;
  if (body.messages !== undefined) updates.messages = body.messages;
   updates.model_id = body.model_id ?? updates.model_id;
   updates.model_display_name = body.model_display_name ?? updates.model_display_name;
   updates.platform_conversation_id = body.platform_conversation_id ?? updates.platform_conversation_id;
   updates.attribution_confidence = body.attribution_confidence ?? updates.attribution_confidence;
   updates.attribution_source = body.attribution_source ?? updates.attribution_source;
   if (body.pii_scanned !== undefined) updates.pii_scanned = body.pii_scanned;
   if (body.pii_redacted !== undefined) updates.pii_redacted = body.pii_redacted;
   if (body.source !== undefined) updates.source = body.source;

  const { data, error } = await supabase
    .from('conversations')
    .update(updates)
    .eq('id', id)
    .select(
      `
      id,
      title,
      description,
      messages,
      platform,
      tags,
      created_at,
      view_count,
      show_author,
      is_public,
      messages,
      user_id,
      profiles (
        id,
        display_name,
        avatar_url
      )
    `
    )
    .single();

  if (error) {
    console.error('Update error:', error);
    return json({ error: 'Failed to update conversation' }, 500);
  }

  return json({ conversation: data });
});

// List public conversations
router.get('/api/conversations', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    return json({ error: 'Service misconfigured' }, 500);
  }
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const url = new URL(request.url);
  
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const sortParam = url.searchParams.get('sort');
  const sort = sortParam === 'oldest' ? 'oldest' : sortParam === 'views' ? 'views' : 'newest';
  const platformParam = url.searchParams.get('platform');
  const tagParam = url.searchParams.get('tag');
  const search = url.searchParams.get('q');
  const user = await getUser(request, supabase);

  const platforms = platformParam
    ? platformParam.split(',').map(p => p.trim()).filter(Boolean)
    : [];
  const tags = tagParam
    ? tagParam.split(',').map(t => t.trim()).filter(Boolean)
    : [];

  let query = supabase
    .from('conversations')
    .select(
      `
      id,
      root_conversation_id,
      parent_conversation_id,
      title,
      description,
      messages,
      platform,
      tags,
      created_at,
      view_count,
      show_author,
      model_id,
      model_display_name,
      intent_type,
      user_goal,
      platform_conversation_id,
      attribution_confidence,
      attribution_source,
      pii_scanned,
      pii_redacted,
      source
    `,
      { count: 'exact' }
    );

  // Public list only for this endpoint
  query = query.eq('is_public', true);

  if (sort === 'oldest') {
    query = query.order('created_at', { ascending: true });
  } else if (sort === 'views') {
    query = query.order('view_count', { ascending: false }).order('created_at', { ascending: false });
  } else {
    query = query.order('created_at', { ascending: false });
  }

  query = query.range(offset, offset + limit - 1);

  if (platforms.length) {
    query = query.in('platform', platforms);
  }
  if (tags.length) {
    query = query.overlaps('tags', tags);
  }
  if (search) {
    const terms = search
      .trim()
      .split(/\s+/)
      .map(t => t.replace(/[^a-zA-Z0-9]/g, '').toLowerCase())
      .filter(Boolean);
    const lexeme = terms.join('&');
    const tagList = terms.join(',');
    if (lexeme || tagList) {
      const filters = [];
      if (lexeme) filters.push(`fts.wfts.${lexeme}`);
      if (tagList) filters.push(`tags.cs.{${tagList}}`);
      query = query.or(filters.join(','));
    } else {
      query = query.textSearch('fts', search, { type: 'websearch', config: 'english' });
    }
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('Query error:', error);
    return json({ error: `Failed to fetch conversations: ${error.message || 'unknown error'}` }, 500);
  }

  // Attach first message from messages table (if exists) to help build excerpts in list views
  let firstMessageMap: Record<string, { role: string; content: any }> = {};
  try {
    const ids = (data || []).map((c: any) => c.id).filter(Boolean);
    if (ids.length) {
      const { data: msgRows, error: msgErr } = await supabase
        .from('messages')
        .select('conversation_id, role, content, order_index')
        .in('conversation_id', ids)
        .order('order_index', { ascending: true });
      if (!msgErr && msgRows) {
        for (const row of msgRows) {
          if (firstMessageMap[row.conversation_id]) continue; // keep earliest
          firstMessageMap[row.conversation_id] = {
            role: row.role === 'assistant' ? 'assistant' : 'human',
            content: row.content?.text ?? row.content ?? '',
          };
        }
      }
    }
  } catch (err) {
    console.error('List messages fetch error:', err);
  }

  const conversations = data?.map(c => {
    const mergedMessages = Array.isArray(c.messages) ? c.messages : (c.messages ? c.messages : []);
    const firstTableMsg = firstMessageMap[c.id];
    const messages = firstTableMsg ? [firstTableMsg, ...mergedMessages] : mergedMessages;
    return {
      ...c,
      messages,
      profiles: undefined, // profiles omitted in list view
    };
  });

  return json({ conversations, count });
});

// Trending tags (last 24h)
router.get('/api/tags/trending', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const windows = [
    { label: '24h', ms: 24 * 60 * 60 * 1000 },
    { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
    { label: 'all', ms: null },
  ];
  let data: any[] | null = null;
  let error: any = null;
  let windowLabel = windows[0].label;
  for (const window of windows) {
    let query = supabase
      .from('conversations')
      .select('tags')
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(500);
    if (window.ms) {
      const since = new Date(Date.now() - window.ms).toISOString();
      query = query.gte('created_at', since);
    }
    const result = await query;
    data = result.data || [];
    error = result.error;
    if (error) break;
    if (data.length) {
      windowLabel = window.label;
      break;
    }
  }

  if (error) {
    console.error('Trending tags error:', error);
    return json({ error: 'Failed to fetch tags' }, 500);
  }

  const counts: Record<string, number> = {};
  (data || []).forEach((row: any) => {
    (row.tags || []).forEach((tag: string) => {
      const key = (tag || '').trim();
      if (!key) return;
      counts[key] = (counts[key] || 0) + 1;
    });
  });

  const tags = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag, count]) => ({ tag, count }));

  return json({ tags, window: windowLabel });
});

// Get single conversation
router.get('/api/conversations/:id', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const { id } = request.params;

  const { data, error } = await supabase
    .from('conversations')
    .select(`
      *,
      profiles (
        id,
        display_name,
        avatar_url
      )
    `)
    .eq('id', id)
    .single();

  if (error || !data) {
    return json({ error: 'Conversation not found' }, 404);
  }

  // Check if public or owned by user
  const user = await getUser(request, supabase);
  if (!data.is_public && data.user_id !== user?.id) {
    return json({ error: 'Conversation not found' }, 404);
  }

  // Messages: for root conversations, keep original JSON only.
  // For continuations, merge JSON + table rows.
  const isRoot = !data.parent_conversation_id;
  let messages: any[] = Array.isArray(data.messages) ? data.messages : [];
  if (!isRoot) {
    try {
      const { data: msgRows, error: msgErr } = await supabase
        .from('messages')
        .select('role, content, order_index')
        .eq('conversation_id', id)
        .order('order_index', { ascending: true });
      if (!msgErr && msgRows && msgRows.length) {
        const tableMsgs = msgRows.map((m: any) => ({
          role: m.role === 'assistant' ? 'assistant' : 'human',
          content: m.content?.text ?? m.content ?? '',
        }));
        messages = messages.length ? [...messages, ...tableMsgs] : tableMsgs;
      }
    } catch (err) {
      console.error('Failed to load table messages', err);
    }
  }

  // Increment view count (best-effort)
  try {
    const { error: viewErr } = await supabase.rpc('increment_view_count', { conversation_id: id });
    if (viewErr) {
      console.error('increment_view_count failed', viewErr);
    }
  } catch (err) {
    console.error('increment_view_count exception', err);
  }

  // Hide author if requested
  const conversation = {
    ...data,
    messages: messages.length ? messages : (data.messages || []),
    profiles: data.show_author ? data.profiles : null,
    children: [] as any[],
  };

  // Fetch continuations (direct children)
  try {
    const { data: childrenRows, error: childErr } = await supabase
      .from('conversations')
      .select('id, title, created_at, intent_type, user_goal, view_count, root_conversation_id')
      .eq('parent_conversation_id', id)
      .order('created_at', { ascending: true });
    if (!childErr && childrenRows) {
      conversation.children = childrenRows;
    }
  } catch (err) {
    console.error('Failed to load child continuations', err);
  }

  return json({ conversation });
});

// Lineage: return root + all descendants for a conversation
router.get('/api/conversations/:id/lineage', async (request: IRequest, env: Env) => {
  const { id } = request.params;
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });

  // Get the conversation to identify root
  const { data: convo, error: convoErr } = await supabase
    .from('conversations')
    .select('id, root_conversation_id, parent_conversation_id')
    .eq('id', id)
    .single();

  if (convoErr || !convo) return json({ error: 'Conversation not found' }, 404);

  const rootId = convo.root_conversation_id || convo.id;

  // Fetch all in the lineage (root + descendants)
  let query = supabase
    .from('conversations')
    .select(`
      id,
      parent_conversation_id,
      root_conversation_id,
      title,
      intent_type,
      user_goal,
      model_display_name,
      created_at,
      view_count
    `)
    .eq('root_conversation_id', rootId)
    .order('created_at', { ascending: true });
  const { data, error } = await query;

  if (error) {
    console.error('Lineage fetch error:', error);
    return json({ error: 'Failed to fetch lineage' }, 500);
  }

  // Ensure root is included
  const nodes = data || [];
  const hasRoot = nodes.some(n => n.id === rootId);
  if (!hasRoot) {
    let rootQuery = supabase
      .from('conversations')
      .select(`
        id,
        parent_conversation_id,
        root_conversation_id,
        title,
        intent_type,
        user_goal,
        model_display_name,
        created_at,
        view_count
      `)
      .eq('id', rootId);
    const { data: rootRow } = await rootQuery.single();
    if (rootRow) nodes.unshift(rootRow);
  }

  return json({ root_id: rootId, nodes });
});

// Bookmarks - list for current user
router.get('/api/bookmarks', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // Get bookmark ids
  const { data: rows, error: bErr } = await supabase
    .from('bookmarks')
    .select('conversation_id')
    .eq('user_id', user.id);

  if (bErr) {
    console.error('Bookmarks fetch error', bErr);
    return json({ error: 'Failed to fetch bookmarks' }, 500);
  }

  const ids = (rows || []).map(r => r.conversation_id).filter(Boolean);
  if (!ids.length) return json({ conversations: [] });

  const { data, error } = await supabase
    .from('conversations')
    .select(`
      *,
      profiles (
        id,
        display_name,
        avatar_url
      )
    `)
    .in('id', ids)
    .or(`is_public.eq.true,user_id.eq.${user.id}`);

  if (error) {
    console.error('Bookmarks conversation fetch error', error);
    return json({ error: 'Failed to fetch bookmarks' }, 500);
  }

  const conversations = (data || []).map(c => ({
    ...c,
    profiles: c.show_author ? c.profiles : null,
  }));

  return json({ conversations });
});

// Add bookmark
router.post('/api/bookmarks', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  let body: { conversation_id?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const conversationId = body.conversation_id;
  if (!conversationId) return json({ error: 'conversation_id required' }, 400);

  // Check conversation visibility
  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .select('id, user_id, is_public')
    .eq('id', conversationId)
    .single();
  if (convErr || !conv) return json({ error: 'Conversation not found' }, 404);
  if (!conv.is_public && conv.user_id !== user.id) {
    return json({ error: 'Conversation is private' }, 403);
  }

  const { error: insErr } = await supabase
    .from('bookmarks')
    .upsert({ user_id: user.id, conversation_id: conversationId }, { onConflict: 'user_id,conversation_id' });

  if (insErr) {
    console.error('Bookmark insert error', insErr);
    return json({ error: 'Failed to add bookmark' }, 500);
  }

  return json({ success: true });
});

// Remove bookmark
router.delete('/api/bookmarks/:id', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const { id } = request.params;
  const { error } = await supabase
    .from('bookmarks')
    .delete()
    .eq('user_id', user.id)
    .eq('conversation_id', id);

  if (error) {
    console.error('Bookmark delete error', error);
    return json({ error: 'Failed to remove bookmark' }, 500);
  }

  return json({ success: true });
});

// Get user's conversations
router.get('/api/users/:userId/conversations', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const { userId } = request.params;
  const user = await getUser(request, supabase);
  const url = new URL(request.url);
  
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  // If viewing own profile, show all; otherwise only public
  const isOwner = user?.id === userId;

  let query = supabase
    .from('conversations')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (!isOwner) {
    query = query.eq('is_public', true);
  }

  const { data, error } = await query;

  if (error) {
    return json({ error: 'Failed to fetch conversations' }, 500);
  }

  return json({ conversations: data });
});

// Delete conversation
router.delete('/api/conversations/:id', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  
  if (!user) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const { id } = request.params;

  const { error } = await supabase
    .from('conversations')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id); // Ensure ownership

  if (error) {
    return json({ error: 'Failed to delete conversation' }, 500);
  }

  return json({ success: true });
});

// Chat: append user message and AI reply via Supabase Edge Function proxy
router.post('/api/conversations/:id/messages', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const { id } = request.params;

  // Proxy to Supabase Edge Function (chat/continue)
  if (!env.SUPABASE_URL) return json({ error: 'Service misconfigured' }, 500);
  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const content = body?.content?.trim();
  if (!content) return json({ error: 'Message content required' }, 400);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authHeader) headers['Authorization'] = authHeader;

  // Reuse the Supabase function "continue" but in chat mode (append and reply)
  const resp = await fetch(`${env.SUPABASE_URL}/functions/v1/continue`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ conversation_id: id, mode: 'continue', user_goal: content, chat: true }),
  });
  const respHeaders = new Headers(resp.headers);
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  respHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  return new Response(resp.body, {
    status: resp.status,
    headers: respHeaders,
  });
});

// Continue modal stream: create child, emit conversation_id first, then stream DeepSeek
router.post('/api/conversations/:id/continue-stream', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const { id } = request.params;

  if (!env.SUPABASE_URL) return json({ error: 'Service misconfigured' }, 500);
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const mode = body?.mode || 'continue';
  const user_goal = body?.user_goal;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authHeader) headers['Authorization'] = authHeader;

  const resp = await fetch(`${env.SUPABASE_URL}/functions/v1/continue`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ conversation_id: id, mode, user_goal, chat: false }),
  });
  const respHeaders = new Headers(resp.headers);
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  respHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: respHeaders,
  });
});

// Fork conversation up to a message index (no generation)
router.post('/api/conversations/:id/fork', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const { id } = request.params;

  if (!env.SUPABASE_URL) return json({ error: 'Service misconfigured' }, 500);
  let body: any;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const fork_message_index = typeof body?.fork_message_index === 'number' ? body.fork_message_index : undefined;
  const messages_snapshot = Array.isArray(body?.messages_snapshot) ? body.messages_snapshot : undefined;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authHeader) headers['Authorization'] = authHeader;

  const resp = await fetch(`${env.SUPABASE_URL}/functions/v1/continue`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      conversation_id: id,
      // mark as fork to keep context limited
      mode: 'fork',
      user_goal: body?.user_goal,
      fork_message_index,
      messages_snapshot,
      chat: false,
    }),
  });

  const respHeaders = new Headers(resp.headers);
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  respHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: respHeaders,
  });
});

// Generate assistant for an existing continuation (streaming)
router.post('/api/conversations/:id/generate', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const { id } = request.params;

  if (!env.SUPABASE_URL) return json({ error: 'Service misconfigured' }, 500);
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    // optional body
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authHeader) headers['Authorization'] = authHeader;

  const resp = await fetch(`${env.SUPABASE_URL}/functions/v1/continue`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      conversation_id: id,
      generate_only: true,
      mode: body?.mode,
      user_goal: body?.user_goal,
    }),
  });

  const respHeaders = new Headers(resp.headers);
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  respHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  return new Response(resp.body, {
    status: resp.status,
    headers: respHeaders,
  });
});

// Handle CORS preflight
router.options('*', () => new Response(null, { headers: corsHeaders }));

// 404 fallback
router.all('*', () => json({ error: 'Not found' }, 404));

// Main export
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return router.handle(request, env);
  },
};
