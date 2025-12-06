import { Router, IRequest } from 'itty-router';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Types
interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_KEY: string;
}

interface Message {
  role: 'human' | 'assistant';
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
    })
    .select()
    .single();

  if (error) {
    console.error('Insert error:', error);
    return json({ error: 'Failed to create conversation' }, 500);
  }

  return json({ conversation: data }, 201);
});

// List public conversations
router.get('/api/conversations', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const url = new URL(request.url);
  
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const platform = url.searchParams.get('platform');
  const tag = url.searchParams.get('tag');
  const search = url.searchParams.get('q');

  let query = supabase
    .from('conversations')
    .select(
      `
      id,
      title,
      description,
      platform,
      tags,
      created_at,
      view_count,
      show_author,
      profiles!inner (
        id,
        display_name,
        avatar_url
      )
    `,
      { count: 'exact' }
    )
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // Filters
  if (platform) {
    query = query.eq('platform', platform);
  }
  if (tag) {
    query = query.contains('tags', [tag]);
  }
  if (search) {
    query = query.textSearch('fts', search);
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('Query error:', error);
    return json({ error: 'Failed to fetch conversations' }, 500);
  }

  // Hide author info where show_author is false
  const conversations = data?.map(c => ({
    ...c,
    profiles: c.show_author ? c.profiles : null,
  }));

  return json({ conversations, count });
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

  // Increment view count (fire and forget)
  supabase.rpc('increment_view_count', { conversation_id: id });

  // Hide author if requested
  const conversation = {
    ...data,
    profiles: data.show_author ? data.profiles : null,
  };

  return json({ conversation });
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

// Update conversation
router.put('/api/conversations/:id', async (request: IRequest, env: Env) => {
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
  let body: Partial<CreateConversationBody>;
  
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  // Only allow updating certain fields
  const updates: any = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.tags !== undefined) updates.tags = body.tags;
  if (body.is_public !== undefined) updates.is_public = body.is_public;
  if (body.show_author !== undefined) updates.show_author = body.show_author;

  const { data, error } = await supabase
    .from('conversations')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id) // Ensure ownership
    .select()
    .single();

  if (error || !data) {
    return json({ error: 'Conversation not found or not owned by you' }, 404);
  }

  return json({ conversation: data });
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
