import { Router, IRequest } from 'itty-router';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import puppeteer from '@cloudflare/puppeteer';

// Types
interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_KEY: string;
  BROWSER: any;
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

// Scrape with browser rendering (handles pages that block bots)
router.get('/api/scrape', async (request: IRequest, env: Env) => {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  let selector = url.searchParams.get('selector') || 'body';

  if (!target) {
    return json({ error: 'Missing url parameter' }, 400);
  }

  let targetUrl: string;
  try {
    targetUrl = new URL(target).toString();
  } catch {
    return json({ error: 'Invalid url parameter' }, 400);
  }

  if (!env.BROWSER) {
    return json({ error: 'Browser binding not configured' }, 500);
  }

  const allowedHosts = ['claude.ai', 'chat.openai.com', 'gemini.google.com', 'poe.com', 'perplexity.ai'];
  const host = new URL(targetUrl).hostname;
  if (!allowedHosts.some(d => host.includes(d))) {
    return json({ error: 'Domain not allowed' }, 403);
  }

  let browser: any;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      Referer: 'https://claude.ai/',
    });
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 45000 });

    // Wait for Claude/other UIs to render messages; don't fail hard if missing
    if (host.includes('claude.ai')) {
      await page
        .waitForSelector('div[class*="Message"], .font-claude-message, [data-message-author-role], .prose, div[p=""]', { timeout: 20000 })
        .catch(() => {});
      // Use broader selector for Claude shares
      selector = 'div[class*=\"Message\"], div[p=\"\"], .prose, [data-message-author-role], .font-claude-message';
    }

    const content = await page.evaluate((sel) => {
      const elements = document.querySelectorAll(sel);
      const texts = Array.from(elements)
        .map(el => el.textContent?.trim())
        .filter(Boolean);
      if (texts.length > 0) {
        return texts.join('\n\n');
      }
      return document.body.innerText || '';
    }, selector);

    await browser.close();

    const cleaned = (content || '').replace(/\s+/g, ' ').trim();

    // Detect common interstitials/challenges and surface a clearer error
    const lower = cleaned.toLowerCase();
    if (lower.includes('verify you are human') || lower.includes('performance & security by cloudflare')) {
      return json({ error: 'Blocked by site challenge (Cloudflare). Try again later or with a different network.' }, 403);
    }

    if (!cleaned) {
      return json({ error: 'No content extracted' }, 404);
    }

    return json({
      url: targetUrl,
      selector,
      result: cleaned,
      length: cleaned.length,
      method: 'browser-rendering-puppeteer',
    });
  } catch (err: any) {
    if (browser) {
      await browser.close().catch(() => {});
    }
    console.error('Browser scrape error:', err);
    return json({ error: 'Scraping failed: ' + (err?.message || 'unknown') }, 500);
  }
});

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

  const { data, error } = await supabase
    .from('conversations')
    .update(updates)
    .eq('id', id)
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
    .eq('is_public', true);

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
    return json({ error: 'Failed to fetch conversations' }, 500);
  }

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
