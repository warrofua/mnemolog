import { Router, IRequest } from 'itty-router';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// Types
interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  RATE_LIMITER: DurableObjectNamespace;
  DEEPSEEK_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_SOLO?: string;
  STRIPE_PRICE_TEAM?: string;
  STRIPE_PRICE_ENTERPRISE?: string;
  STRIPE_PRICE_MAP?: string;
  APP_URL?: string;
  POLL_SALT?: string;
  FEEDBACK_POSTING_START?: string;
  FEEDBACK_POSTING_END?: string;
  FEEDBACK_DEFAULT_VOTING_DAYS?: string;
  FEEDBACK_MAX_VOTING_DAYS?: string;
  TELEMETRY_SUCCESS_SAMPLE_RATE?: string;
  TELEMETRY_MAX_USAGE_ROWS?: string;
  AGENT_STORAGE_MAX_ITEMS?: string;
  AGENT_STORAGE_MAX_TOTAL_BYTES?: string;
  AGENT_STORAGE_MAX_ITEM_BYTES?: string;
  BILLING_TRIAL_ENABLED?: string;
  BILLING_TRIAL_DAYS?: string;
  BILLING_TRIAL_MAX_SIGNUPS?: string;
  BILLING_TRIAL_ELIGIBLE_PLANS?: string;
  RATE_LIMIT_PUBLIC_READ_RPM?: string;
  RATE_LIMIT_PUBLIC_WRITE_RPM?: string;
  RATE_LIMIT_PUBLIC_VOTE_RPM?: string;
  RATE_LIMIT_AUTHED_RPM?: string;
}

type FeatureState = 'available' | 'degraded' | 'unavailable';

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

interface AgentTokenClaims {
  id: string;
  user_id: string;
  name: string;
  scopes: string[];
  status: string;
  expires_at: string | null;
  revoked_at: string | null;
  token_source: 'agent_token' | 'oauth_client_credentials';
  agent_token_id: string | null;
  oauth_client_id: string | null;
}

interface AgentConversationStoragePolicy {
  maxItems: number;
  maxTotalBytes: number;
  maxItemBytes: number;
}

interface BillingTrialConfig {
  enabled: boolean;
  days: number;
  maxSignups: number | null;
  eligiblePlans: Set<string>;
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

function jsonWithExtraHeaders(data: any, status: number, extraHeaders: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

async function parseJson<T>(request: IRequest): Promise<T | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getStripe(env: Env) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('Stripe secret key missing');
  }
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

type StripeMode = 'live' | 'test' | 'unknown';

function stripeModeFromSecret(secret?: string | null): StripeMode {
  if (typeof secret !== 'string') return 'unknown';
  const normalized = secret.trim();
  if (!normalized) return 'unknown';
  if (normalized.startsWith('sk_live_')) return 'live';
  if (normalized.startsWith('sk_test_')) return 'test';
  return 'unknown';
}

function getBaseUrl(env: Env) {
  return env.APP_URL || 'https://mnemolog.com';
}

function resolvePlanFromPrice(env: Env, priceId?: string | null) {
  if (!priceId) return null;
  const map = getStripePriceMap(env);
  const entry = Object.entries(map).find(([, id]) => id === priceId);
  return entry ? entry[0] : null;
}

function getStripePriceMap(env: Env) {
  if (env.STRIPE_PRICE_MAP) {
    try {
      const parsed = JSON.parse(env.STRIPE_PRICE_MAP) as Record<string, string>;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // ignore invalid JSON and fall back to explicit env vars
    }
  }
  return {
    solo: env.STRIPE_PRICE_SOLO || '',
    team: env.STRIPE_PRICE_TEAM || '',
    enterprise: env.STRIPE_PRICE_ENTERPRISE || '',
  };
}

function requireStripePrice(env: Env, plan: string) {
  const mapping = getStripePriceMap(env);
  const priceId = mapping[plan];
  if (!priceId) {
    throw new Error(`Stripe price missing for plan: ${plan}`);
  }
  return priceId;
}

function getServiceSupabase(env: Env) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY missing');
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

function sanitizeRedirectUrl(input: string | undefined, baseUrl: string) {
  if (!input) return null;
  try {
    const base = new URL(baseUrl);
    const url = new URL(input, base);
    if (url.host !== base.host) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function hashString(message: string) {
  const data = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

type RateLimitCheck = {
  key: string;
  limit: number;
  window_seconds: number;
};

async function rateLimitOrRespond(
  request: IRequest,
  env: Env,
  checks: RateLimitCheck[],
  message = 'Rate limited',
) {
  // Fail open if the binding isn't available (misconfigured env).
  if (!(env as any).RATE_LIMITER) return null as Response | null;

  try {
    // Shard by a stable hash of the first key to avoid a single hot DO.
    const shardSeed = checks[0]?.key || 'default';
    const shard = (await hashString(`rl:${shardSeed}`)).slice(0, 2);
    const id = env.RATE_LIMITER.idFromName(`rl:${shard}`);
    const stub = env.RATE_LIMITER.get(id);

    const resp = await stub.fetch('https://rate-limiter/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checks }),
    });
    const out: any = await resp.json().catch(() => null);
    if (out && out.allowed === false) {
      const retryAfter = Number(out.retry_after_seconds || 0);
      return jsonWithExtraHeaders(
        { error: message, retry_after_seconds: retryAfter || null },
        429,
        retryAfter > 0 ? { 'Retry-After': String(retryAfter) } : {},
      );
    }
  } catch (err) {
    console.error('Rate limiter failure (fail-open)', err);
  }

  return null as Response | null;
}

function getBearerToken(request: IRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.replace('Bearer ', '').trim();
  return token || null;
}

function generateAgentToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `mna_${hex}`;
}

function generateOauthClientId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `mnc_${hex}`;
}

function generateOauthClientSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `mns_${hex}`;
}

function normalizeAgentScopes(raw: unknown) {
  if (!Array.isArray(raw) || !raw.length) {
    return { scopes: ['status:read', 'capabilities:read'], invalid: [] as string[] };
  }

  const clean = raw
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  const unique = Array.from(new Set(clean));
  const invalid = unique.filter((scope) => !allowedAgentScopes.has(scope));
  const scopes = unique.filter((scope) => allowedAgentScopes.has(scope));
  return { scopes: scopes.length ? scopes : ['status:read', 'capabilities:read'], invalid };
}

function validateAgentScopes(raw: unknown) {
  if (!Array.isArray(raw) || !raw.length) {
    return { scopes: [] as string[], invalid: [] as string[] };
  }
  const clean = raw
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  const unique = Array.from(new Set(clean));
  const invalid = unique.filter((scope) => !allowedAgentScopes.has(scope));
  const scopes = unique.filter((scope) => allowedAgentScopes.has(scope));
  return { scopes, invalid };
}

function parseScopeString(raw?: string | null) {
  if (!raw) return [] as string[];
  return raw
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function expandAllowedScopes(raw: unknown) {
  const { scopes } = validateAgentScopes(Array.isArray(raw) ? raw : []);
  if (scopes.includes('*')) {
    return Array.from(allowedAgentScopes.values()).filter((scope) => scope !== '*');
  }
  return scopes;
}

function getBasicAuthCredentials(request: IRequest) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Basic ')) return null;
  const encoded = authHeader.slice('Basic '.length).trim();
  if (!encoded) return null;
  try {
    const decoded = atob(encoded);
    const sep = decoded.indexOf(':');
    if (sep <= 0) return null;
    const clientId = decoded.slice(0, sep).trim();
    const clientSecret = decoded.slice(sep + 1).trim();
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  } catch {
    return null;
  }
}

async function parseFormOrJson(request: IRequest) {
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    return (await parseJson<Record<string, any>>(request)) || {};
  }
  const text = await request.text();
  const params = new URLSearchParams(text);
  return Object.fromEntries(params.entries());
}

function oauthError(error: string, errorDescription: string, status = 400) {
  return json({ error, error_description: errorDescription }, status);
}

function hasScope(scopes: string[] | null | undefined, requiredScope?: string) {
  if (!requiredScope) return true;
  if (!Array.isArray(scopes)) return false;
  return scopes.includes('*') || scopes.includes(requiredScope);
}

function formatIsoInDays(days: number) {
  const now = Date.now();
  return new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
}

function parseIsoDate(value?: string | null) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parsePositiveInt(value: string | undefined, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function buildRateLimitConfig(env: Env) {
  return {
    publicReadRpm: parsePositiveInt(env.RATE_LIMIT_PUBLIC_READ_RPM, 120, 10, 6000),
    publicWriteRpm: parsePositiveInt(env.RATE_LIMIT_PUBLIC_WRITE_RPM, 30, 1, 600),
    publicVoteRpm: parsePositiveInt(env.RATE_LIMIT_PUBLIC_VOTE_RPM, 6, 1, 120),
    authedRpm: parsePositiveInt(env.RATE_LIMIT_AUTHED_RPM, 240, 10, 6000),
  };
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function unixSecondsToIso(value: number | null | undefined) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null;
  return new Date(Number(value) * 1000).toISOString();
}

function withinWindow(nowMs: number, startIso?: string | null, endIso?: string | null) {
  if (startIso) {
    const startMs = new Date(startIso).getTime();
    if (Number.isFinite(startMs) && nowMs < startMs) return false;
  }
  if (endIso) {
    const endMs = new Date(endIso).getTime();
    if (Number.isFinite(endMs) && nowMs > endMs) return false;
  }
  return true;
}

function buildFeedbackConfig(env: Env) {
  const postingStart = parseIsoDate(env.FEEDBACK_POSTING_START);
  const postingEnd = parseIsoDate(env.FEEDBACK_POSTING_END);
  const defaultVotingDays = parsePositiveInt(env.FEEDBACK_DEFAULT_VOTING_DAYS, 14, 1, 90);
  const maxVotingDays = parsePositiveInt(env.FEEDBACK_MAX_VOTING_DAYS, 90, 1, 365);
  return {
    postingStart,
    postingEnd,
    defaultVotingDays,
    maxVotingDays,
  };
}

function buildBillingTrialConfig(env: Env): BillingTrialConfig {
  const enabled = parseBoolean(env.BILLING_TRIAL_ENABLED, true);
  const days = parsePositiveInt(env.BILLING_TRIAL_DAYS, 30, 1, 365);
  const maxSignupsRaw = (env.BILLING_TRIAL_MAX_SIGNUPS || '').trim();
  const maxSignups = maxSignupsRaw
    ? parsePositiveInt(maxSignupsRaw, 100, 1, 1000000)
    : null;
  const plans = (env.BILLING_TRIAL_ELIGIBLE_PLANS || 'solo')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return {
    enabled,
    days,
    maxSignups,
    eligiblePlans: new Set(plans.length ? plans : ['solo']),
  };
}

function estimateConversationPayloadBytes(input: Partial<CreateConversationBody>) {
  const payload = {
    title: input.title || '',
    description: input.description || '',
    platform: input.platform || 'other',
    messages: Array.isArray(input.messages) ? input.messages : [],
    tags: Array.isArray(input.tags) ? input.tags : [],
    model_id: input.model_id || null,
    model_display_name: input.model_display_name || null,
    platform_conversation_id: input.platform_conversation_id || null,
    attribution_confidence: input.attribution_confidence || null,
    attribution_source: input.attribution_source || null,
    pii_scanned: input.pii_scanned ?? false,
    pii_redacted: input.pii_redacted ?? false,
    source: input.source || null,
  };
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

function buildAgentConversationStoragePolicy(env: Env): AgentConversationStoragePolicy {
  const maxItems = parsePositiveInt(env.AGENT_STORAGE_MAX_ITEMS, 200, 10, 10000);
  const maxTotalBytes = parsePositiveInt(env.AGENT_STORAGE_MAX_TOTAL_BYTES, 20 * 1024 * 1024, 256 * 1024, 1024 * 1024 * 1024);
  const maxItemBytes = parsePositiveInt(env.AGENT_STORAGE_MAX_ITEM_BYTES, 256 * 1024, 1024, maxTotalBytes);
  return {
    maxItems,
    maxTotalBytes,
    maxItemBytes: Math.min(maxItemBytes, maxTotalBytes),
  };
}

async function fetchAgentConversationStorageUsage(
  supabase: SupabaseClient,
  ownerUserId: string,
  maxRows: number,
) {
  const { data, error, count } = await supabase
    .from('conversations')
    .select('agent_payload_bytes', { count: 'exact' })
    .eq('user_id', ownerUserId)
    .eq('created_via_agent_auth', true)
    .limit(maxRows);

  if (error) throw error;

  const totalBytes = (data || []).reduce((sum, row: any) => {
    const n = typeof row.agent_payload_bytes === 'number' ? row.agent_payload_bytes : 0;
    return sum + Math.max(0, n);
  }, 0);

  return {
    itemCount: typeof count === 'number' ? count : (data || []).length,
    totalBytes,
  };
}

function buildAgentStorageLimitPayload(
  code: string,
  message: string,
  policy: AgentConversationStoragePolicy,
  usage: { itemCount: number; totalBytes: number },
  incomingBytes: number,
) {
  return {
    error: message,
    code,
    limits: {
      max_items: policy.maxItems,
      max_total_bytes: policy.maxTotalBytes,
      max_item_bytes: policy.maxItemBytes,
    },
    usage: {
      item_count: usage.itemCount,
      total_bytes: usage.totalBytes,
      incoming_bytes: incomingBytes,
    },
  };
}

function parseTags(raw: unknown) {
  if (!Array.isArray(raw)) return [] as string[];
  const clean = raw
    .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
    .filter(Boolean)
    .slice(0, 12);
  return Array.from(new Set(clean));
}

function hasPrivateTag(raw: unknown) {
  if (!Array.isArray(raw)) return false;
  return raw.some((tag) => typeof tag === 'string' && tag.trim().toLowerCase() === 'private');
}

function parseSampleRate(value: string | undefined, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeTelemetryPath(pathname: string) {
  return pathname
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

function telemetryAuthMode(request: IRequest) {
  const bearer = getBearerToken(request);
  if (!bearer) {
    return getClientIp(request) ? 'anonymous' : 'none';
  }
  if (bearer.startsWith('mna_')) return 'agent_token';
  return 'user_jwt';
}

function telemetryFeatureArea(pathname: string) {
  if (pathname.startsWith('/api/agents/feedback')) return 'feedback';
  if (pathname.startsWith('/api/agents/tokens') || pathname === '/api/agents/auth/me') return 'agent_tokens';
  if (pathname.startsWith('/api/agents/secure/poll') || pathname.startsWith('/api/agents/poll')) return 'poll';
  if (pathname.startsWith('/api/agents/telemetry')) return 'telemetry';
  if (pathname === '/api/agents/status' || pathname === '/api/agents/capabilities') return 'discovery';
  if (pathname.startsWith('/api/conversations') || pathname === '/api/archive') return 'conversations';
  if (pathname.startsWith('/api/billing')) return 'billing';
  if (pathname.startsWith('/api/agents')) return 'agents';
  return 'other';
}

function shouldLogTelemetry(pathname: string, method: string) {
  if (method.toUpperCase() === 'OPTIONS') return false;
  if (pathname.startsWith('/api/agents')) return true;
  if (pathname.startsWith('/api/billing')) return true;
  if (pathname === '/api/auth/user') return true;
  if (pathname === '/api/archive') return true;
  if (pathname.startsWith('/api/conversations') && ['POST', 'PUT'].includes(method.toUpperCase())) return true;
  return false;
}

function percentile95(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[idx];
}

async function logAgentTelemetry(request: IRequest, response: Response, env: Env, durationMs: number) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (!shouldLogTelemetry(path, method)) return;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;

  const status = Number(response.status || 500);
  if (path === '/api/billing/webhook') {
    // Avoid polluting telemetry with unauthenticated probes against the webhook endpoint.
    const hasStripeSig = !!request.headers.get('Stripe-Signature');
    if (!hasStripeSig && status < 500) return;
  }
  const statusClass = `${Math.floor(status / 100)}xx`;
  const success = status < 400;
  const successSampleRate = parseSampleRate(env.TELEMETRY_SUCCESS_SAMPLE_RATE, 0.25);
  if (success && Math.random() > successSampleRate) return;

  const authMode = telemetryAuthMode(request);
  const bearer = getBearerToken(request);
  let identityHash: string | null = null;
  if (bearer) {
    identityHash = (await hashString(`identity:${bearer}`)).slice(0, 40);
  } else {
    const ip = getClientIp(request);
    if (ip) identityHash = (await hashString(`identity:ip:${ip}`)).slice(0, 40);
  }

  const supabase = getServiceSupabase(env);
  const telemetryRow = {
    endpoint: normalizeTelemetryPath(path),
    method,
    feature_area: telemetryFeatureArea(path),
    auth_mode: authMode,
    status_code: status,
    status_class: statusClass,
    duration_ms: Math.max(0, Math.round(durationMs)),
    success,
    request_path: path,
    identity_hash: identityHash,
    request_id: request.headers.get('CF-Ray') || request.headers.get('X-Request-Id') || null,
    metadata: {
      query: url.search ? true : false,
      is_success: success,
      sampled_rate: successSampleRate,
    },
  };

  const { error } = await supabase
    .from('agent_telemetry_events')
    .insert(telemetryRow);
  if (error) {
    console.error('Telemetry log insert error', error);
  }
}

async function resolveFeedbackActor(request: IRequest, env: Env, requiredAgentScope: string, allowAnonymous = false) {
  const bearer = getBearerToken(request);
  if (bearer?.startsWith('mna_')) {
    const agentAuth = await requireAgentTokenScope(request, env, requiredAgentScope);
    if (agentAuth.response) return { response: agentAuth.response } as const;
    return {
      response: null as Response | null,
      mode: 'agent' as const,
      userId: agentAuth.claims!.user_id,
      agentTokenId: agentAuth.claims!.agent_token_id,
      identityType: 'agent' as const,
      identityValue: agentAuth.claims!.oauth_client_id || agentAuth.claims!.id,
    };
  }

  if (bearer) {
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      return { response: json({ error: 'Auth unavailable' }, 503) } as const;
    }
    const authHeader = request.headers.get('Authorization') || undefined;
    const userSupabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: {
        headers: authHeader ? { Authorization: authHeader } : {},
      },
    });
    const user = await getUser(request, userSupabase);
    if (!user) {
      return { response: json({ error: 'Unauthorized' }, 401) } as const;
    }
    return {
      response: null as Response | null,
      mode: 'user' as const,
      userId: user.id,
      agentTokenId: null as string | null,
      identityType: 'user' as const,
      identityValue: user.id,
    };
  }

  if (!allowAnonymous) {
    return { response: json({ error: 'Auth required' }, 401) } as const;
  }
  const ip = getClientIp(request);
  if (!ip) {
    return { response: json({ error: 'Unable to identify voter' }, 400) } as const;
  }
  return {
    response: null as Response | null,
    mode: 'anonymous' as const,
    userId: null as string | null,
    agentTokenId: null as string | null,
    identityType: 'anon' as const,
    identityValue: ip,
  };
}

async function resolveAgentTokenClaims(request: IRequest, env: Env): Promise<AgentTokenClaims | null> {
  const token = getBearerToken(request);
  if (!token || !token.startsWith('mna_')) return null;
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_URL) return null;

  const supabase = getServiceSupabase(env);
  const tokenHash = await hashString(token);
  const { data, error } = await supabase
    .from('agent_tokens')
    .select('id, user_id, name, scopes, status, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .single();

  if (!error && data) {
    if (data.status !== 'active') return null;
    if (data.revoked_at) return null;
    if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) return null;

    // best effort usage telemetry
    await supabase
      .from('agent_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id)
      .eq('status', 'active');

    return {
      ...(data as any),
      token_source: 'agent_token',
      agent_token_id: data.id,
      oauth_client_id: null,
    } as AgentTokenClaims;
  }

  const { data: oauthToken, error: oauthTokenErr } = await supabase
    .from('agent_oauth_access_tokens')
    .select('id, client_ref, scopes, status, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .single();

  if (oauthTokenErr || !oauthToken) return null;
  if (oauthToken.status !== 'active') return null;
  if (oauthToken.revoked_at) return null;
  if (oauthToken.expires_at && new Date(oauthToken.expires_at).getTime() <= Date.now()) return null;

  const { data: oauthClient, error: oauthClientErr } = await supabase
    .from('agent_oauth_clients')
    .select('id, owner_user_id, name, status, revoked_at')
    .eq('id', oauthToken.client_ref)
    .single();
  if (oauthClientErr || !oauthClient) return null;
  if (oauthClient.status !== 'active') return null;
  if (oauthClient.revoked_at) return null;

  const nowIso = new Date().toISOString();
  await Promise.all([
    supabase
      .from('agent_oauth_access_tokens')
      .update({ last_used_at: nowIso })
      .eq('id', oauthToken.id)
      .eq('status', 'active'),
    supabase
      .from('agent_oauth_clients')
      .update({ last_used_at: nowIso })
      .eq('id', oauthClient.id)
      .eq('status', 'active'),
  ]);

  return {
    id: oauthToken.id,
    user_id: oauthClient.owner_user_id,
    name: `oauth:${oauthClient.name}`,
    scopes: Array.isArray(oauthToken.scopes) ? oauthToken.scopes : [],
    status: oauthToken.status,
    expires_at: oauthToken.expires_at,
    revoked_at: oauthToken.revoked_at,
    token_source: 'oauth_client_credentials',
    agent_token_id: null,
    oauth_client_id: oauthClient.id,
  } as AgentTokenClaims;
}

async function requireAgentTokenScope(request: IRequest, env: Env, scope?: string) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      claims: null as AgentTokenClaims | null,
      response: json({ error: 'Agent token auth unavailable: missing SUPABASE_SERVICE_ROLE_KEY' }, 503),
    };
  }

  const token = getBearerToken(request);
  if (!token || !token.startsWith('mna_')) {
    return {
      claims: null as AgentTokenClaims | null,
      response: json({ error: 'Agent token required' }, 401),
    };
  }

  const claims = await resolveAgentTokenClaims(request, env);
  if (!claims) {
    return {
      claims: null as AgentTokenClaims | null,
      response: json({ error: 'Invalid or expired agent token' }, 401),
    };
  }

  if (!hasScope(claims.scopes, scope)) {
    return {
      claims: null as AgentTokenClaims | null,
      response: json({ error: `Missing required scope: ${scope}` }, 403),
    };
  }

  return { claims, response: null as Response | null };
}

function getClientIp(request: IRequest) {
  const raw = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
  return raw.split(',')[0].trim();
}

const pollQuestion = {
  id: 'agents-feature-next',
  question: 'What features should be next?',
  options: [
    { id: 'mcp-governance', label: 'MCP governance + policy gates' },
    { id: 'devtools-live', label: 'Live DevTools streams (DOM/network/console)' },
    { id: 'playwright-proof', label: 'Playwright proof bundles' },
    { id: 'knowledge-vault', label: 'Agent knowledge vault & provenance' },
  ],
};

const feedbackTypes = new Set(['question', 'feature', 'poll']);
const feedbackStatuses = new Set(['open', 'closed', 'archived']);
const feedbackRelationTypes = new Set(['duplicate_of', 'related_to', 'depends_on']);

const allowedAgentScopes = new Set([
  '*',
  'status:read',
  'capabilities:read',
  'poll:read',
  'poll:vote',
  'feedback:read',
  'feedback:write',
  'feedback:vote',
  'feedback:link',
  'telemetry:read',
  'conversations:read',
  'conversations:write',
  'billing:read',
  'billing:write',
]);

function hasEnvValue(value?: string | null) {
  return typeof value === 'string' && value.trim().length > 0;
}

function missingEnvNames(checks: Array<[string, boolean]>) {
  return checks.filter(([, ok]) => !ok).map(([name]) => name);
}

function featureStatusFromMissing(missing: string[]): FeatureState {
  return missing.length ? 'unavailable' : 'available';
}

function summarizeReason(missing: string[]) {
  return missing.length ? `Missing env: ${missing.join(', ')}` : 'Ready';
}

function buildAgentsStatus(env: Env) {
  const hasSupabaseUrl = hasEnvValue(env.SUPABASE_URL);
  const hasSupabaseAnon = hasEnvValue(env.SUPABASE_ANON_KEY);
  const hasSupabaseServiceRole = hasEnvValue(env.SUPABASE_SERVICE_ROLE_KEY);
  const hasPollSalt = hasEnvValue(env.POLL_SALT);
  const hasStripeSecret = hasEnvValue(env.STRIPE_SECRET_KEY);
  const hasStripeWebhookSecret = hasEnvValue(env.STRIPE_WEBHOOK_SECRET);
  const stripeMode = stripeModeFromSecret(env.STRIPE_SECRET_KEY);
  const feedbackCfg = buildFeedbackConfig(env);
  const storagePolicy = buildAgentConversationStoragePolicy(env);
  const billingTrialCfg = buildBillingTrialConfig(env);

  const stripePrices = getStripePriceMap(env);
  const hasAnyStripePrice = Object.values(stripePrices).some((value) => hasEnvValue(value));
  const hasServiceRole = hasSupabaseServiceRole;

  const coreMissing = missingEnvNames([
    ['SUPABASE_URL', hasSupabaseUrl],
    ['SUPABASE_ANON_KEY', hasSupabaseAnon],
  ]);
  const pollMissing = missingEnvNames([
    ['SUPABASE_URL', hasSupabaseUrl],
    ['SUPABASE_SERVICE_ROLE_KEY', hasSupabaseServiceRole],
    ['POLL_SALT', hasPollSalt],
  ]);
  const billingCoreMissing = missingEnvNames([
    ['SUPABASE_URL', hasSupabaseUrl],
    ['SUPABASE_ANON_KEY', hasSupabaseAnon],
    ['STRIPE_SECRET_KEY', hasStripeSecret],
    ['STRIPE_PRICE_MAP or STRIPE_PRICE_*', hasAnyStripePrice],
  ]);
  const billingWebhookMissing = missingEnvNames([
    ['STRIPE_WEBHOOK_SECRET', hasStripeWebhookSecret],
  ]);
  const tokenCoreMissing = missingEnvNames([
    ['SUPABASE_URL', hasSupabaseUrl],
    ['SUPABASE_ANON_KEY', hasSupabaseAnon],
  ]);
  const tokenAuthMissing = missingEnvNames([
    ['SUPABASE_SERVICE_ROLE_KEY', hasServiceRole],
  ]);
  const feedbackMissing = missingEnvNames([
    ['SUPABASE_URL', hasSupabaseUrl],
    ['SUPABASE_SERVICE_ROLE_KEY', hasServiceRole],
  ]);
  const oauthM2MMissing = missingEnvNames([
    ['SUPABASE_URL', hasSupabaseUrl],
    ['SUPABASE_ANON_KEY', hasSupabaseAnon],
    ['SUPABASE_SERVICE_ROLE_KEY', hasServiceRole],
  ]);
  const telemetryMissing = missingEnvNames([
    ['SUPABASE_URL', hasSupabaseUrl],
    ['SUPABASE_SERVICE_ROLE_KEY', hasServiceRole],
  ]);
  const tokenState: FeatureState = tokenCoreMissing.length
    ? 'unavailable'
    : tokenAuthMissing.length
    ? 'degraded'
    : 'available';
  const tokenReason = tokenCoreMissing.length
    ? summarizeReason(tokenCoreMissing)
    : tokenAuthMissing.length
    ? `Management endpoints ready; bearer-token introspection unavailable (${tokenAuthMissing.join(', ')})`
    : 'Ready';

  const billingState: FeatureState = billingCoreMissing.length
    ? 'unavailable'
    : billingWebhookMissing.length
    ? 'degraded'
    : 'available';
  const billingReason = billingCoreMissing.length
    ? summarizeReason(billingCoreMissing)
    : billingWebhookMissing.length
    ? `Checkout/portal ready; webhook processing unavailable (${summarizeReason(billingWebhookMissing)})`
    : 'Ready';

  const features = {
    core_api: {
      state: featureStatusFromMissing(coreMissing),
      reason: summarizeReason(coreMissing),
      paths: ['/api/health', '/api/conversations', '/api/conversations/:id'],
      agent_storage_limits: {
        max_items: storagePolicy.maxItems,
        max_total_bytes: storagePolicy.maxTotalBytes,
        max_item_bytes: storagePolicy.maxItemBytes,
      },
    },
    auth: {
      state: featureStatusFromMissing(coreMissing),
      reason: summarizeReason(coreMissing),
      paths: ['/api/auth/user'],
    },
    poll: {
      state: featureStatusFromMissing(pollMissing),
      reason: summarizeReason(pollMissing),
      paths: ['/api/agents/poll', '/api/agents/poll/vote'],
    },
    billing: {
      state: billingState,
      reason: billingReason,
      paths: ['/api/billing/status', '/api/billing/checkout', '/api/billing/portal', '/api/billing/webhook'],
      stripe_mode: stripeMode,
      trial: {
        enabled: billingTrialCfg.enabled,
        days: billingTrialCfg.days,
        max_signups: billingTrialCfg.maxSignups,
        eligible_plans: Array.from(billingTrialCfg.eligiblePlans.values()),
      },
    },
    continuation: {
      state: hasSupabaseUrl ? 'available' : 'unavailable',
      reason: hasSupabaseUrl ? 'Ready' : 'Missing env: SUPABASE_URL',
      paths: ['/api/conversations/:id/messages', '/api/conversations/:id/continue-stream'],
    },
    agent_tokens: {
      state: tokenState,
      reason: tokenReason,
      paths: ['/api/agents/tokens', '/api/agents/tokens/:id/revoke', '/api/agents/tokens/:id/rotate', '/api/agents/auth/me'],
    },
    secure_poll: {
      state: featureStatusFromMissing(pollMissing),
      reason: summarizeReason(pollMissing),
      paths: ['/api/agents/secure/poll', '/api/agents/secure/poll/vote'],
    },
    feedback_board: {
      state: featureStatusFromMissing(feedbackMissing),
      reason: summarizeReason(feedbackMissing),
      paths: [
        '/api/agents/feedback',
        '/api/agents/feedback/:id',
        '/api/agents/feedback/:id/vote',
        '/api/agents/feedback/:id/link',
        '/api/agents/feedback/trending',
      ],
      posting_window: {
        start: feedbackCfg.postingStart,
        end: feedbackCfg.postingEnd,
      },
    },
    telemetry: {
      state: featureStatusFromMissing(telemetryMissing),
      reason: summarizeReason(telemetryMissing),
      paths: ['/api/agents/telemetry/health', '/api/agents/telemetry/recent', '/api/agents/telemetry/usage'],
      sample_success_rate: parseSampleRate(env.TELEMETRY_SUCCESS_SAMPLE_RATE, 0.25),
    },
    oauth_m2m: {
      state: featureStatusFromMissing(oauthM2MMissing),
      reason: summarizeReason(oauthM2MMissing),
      paths: [
        '/.well-known/oauth-authorization-server',
        '/api/agents/oauth/token',
        '/api/agents/oauth/clients',
        '/api/agents/oauth/clients/:id/rotate-secret',
        '/api/agents/oauth/clients/:id/revoke',
      ],
    },
  } as const;

  const states = Object.values(features).map((feature) => feature.state);
  const unavailableCount = states.filter((state) => state === 'unavailable').length;
  const degradedCount = states.filter((state) => state === 'degraded').length;
  const overall: FeatureState =
    unavailableCount === states.length
      ? 'unavailable'
      : unavailableCount > 0 || degradedCount > 0
      ? 'degraded'
      : 'available';

  return {
    overall,
    checked_at: new Date().toISOString(),
    features,
  };
}

function buildAgentsCapabilities(env: Env) {
  const status = buildAgentsStatus(env);
  return {
    name: 'Mnemolog Agents API',
    version: 'v0',
    docs: {
      agents_markdown: 'https://mnemolog.com/agents/agents.md',
      status_endpoint: '/api/agents/status',
      capabilities_endpoint: '/api/agents/capabilities',
      oauth_metadata_endpoint: '/.well-known/oauth-authorization-server',
    },
    auth: {
      primary: 'Bearer token',
      header: 'Authorization: Bearer <token>',
      note: 'Supports bearer user JWT, scoped bearer agent token (mna_*), and OAuth client_credentials token issuance for autonomous agents.',
    },
    supported_scopes: Array.from(allowedAgentScopes.values()),
    capabilities: [
      {
        id: 'agents.status.read',
        method: 'GET',
        path: '/api/agents/status',
        auth: 'none',
        state: 'available',
      },
      {
        id: 'agents.capabilities.read',
        method: 'GET',
        path: '/api/agents/capabilities',
        auth: 'none',
        state: 'available',
      },
      {
        id: 'agents.poll.read',
        method: 'GET',
        path: '/api/agents/poll',
        auth: 'none',
        state: status.features.poll.state,
      },
      {
        id: 'agents.poll.vote',
        method: 'POST',
        path: '/api/agents/poll/vote',
        auth: 'none',
        state: status.features.poll.state,
        body: { option_id: 'mcp-governance' },
      },
      {
        id: 'agents.secure.poll.read',
        method: 'GET',
        path: '/api/agents/secure/poll',
        auth: 'bearer_agent',
        state: status.features.secure_poll.state,
      },
      {
        id: 'agents.secure.poll.vote',
        method: 'POST',
        path: '/api/agents/secure/poll/vote',
        auth: 'bearer_agent',
        state: status.features.secure_poll.state,
        required_scope: 'poll:vote',
        body: { option_id: 'mcp-governance' },
      },
      {
        id: 'agents.tokens.list',
        method: 'GET',
        path: '/api/agents/tokens',
        auth: 'bearer_user',
        state: status.features.agent_tokens.state,
      },
      {
        id: 'agents.tokens.issue',
        method: 'POST',
        path: '/api/agents/tokens',
        auth: 'bearer_user',
        state: status.features.agent_tokens.state,
        body: { name: 'codex-cli', scopes: ['poll:read', 'poll:vote'], expires_in_days: 90 },
      },
      {
        id: 'agents.tokens.revoke',
        method: 'POST',
        path: '/api/agents/tokens/:id/revoke',
        auth: 'bearer_user',
        state: status.features.agent_tokens.state,
      },
      {
        id: 'agents.tokens.rotate',
        method: 'POST',
        path: '/api/agents/tokens/:id/rotate',
        auth: 'bearer_user',
        state: status.features.agent_tokens.state,
      },
      {
        id: 'agents.auth.me',
        method: 'GET',
        path: '/api/agents/auth/me',
        auth: 'bearer_agent',
        state: status.features.agent_tokens.state,
      },
      {
        id: 'agents.oauth.metadata',
        method: 'GET',
        path: '/.well-known/oauth-authorization-server',
        auth: 'none',
        state: status.features.oauth_m2m.state,
      },
      {
        id: 'agents.oauth.token',
        method: 'POST',
        path: '/api/agents/oauth/token',
        auth: 'oauth_client_auth',
        state: status.features.oauth_m2m.state,
        body: { grant_type: 'client_credentials', scope: 'status:read capabilities:read' },
      },
      {
        id: 'agents.oauth.clients.list',
        method: 'GET',
        path: '/api/agents/oauth/clients',
        auth: 'bearer_user',
        state: status.features.oauth_m2m.state,
      },
      {
        id: 'agents.oauth.clients.create',
        method: 'POST',
        path: '/api/agents/oauth/clients',
        auth: 'bearer_user',
        state: status.features.oauth_m2m.state,
      },
      {
        id: 'agents.oauth.clients.rotate_secret',
        method: 'POST',
        path: '/api/agents/oauth/clients/:id/rotate-secret',
        auth: 'bearer_user',
        state: status.features.oauth_m2m.state,
      },
      {
        id: 'agents.oauth.clients.revoke',
        method: 'POST',
        path: '/api/agents/oauth/clients/:id/revoke',
        auth: 'bearer_user',
        state: status.features.oauth_m2m.state,
      },
      {
        id: 'agents.feedback.create',
        method: 'POST',
        path: '/api/agents/feedback',
        auth: 'bearer_user_or_agent',
        state: status.features.feedback_board.state,
        required_scope: 'feedback:write',
      },
      {
        id: 'agents.feedback.list',
        method: 'GET',
        path: '/api/agents/feedback?q=&type=&status=&sort=active',
        auth: 'none',
        state: status.features.feedback_board.state,
      },
      {
        id: 'agents.feedback.vote',
        method: 'POST',
        path: '/api/agents/feedback/:id/vote',
        auth: 'optional_bearer',
        state: status.features.feedback_board.state,
        required_scope: 'feedback:vote',
      },
      {
        id: 'agents.feedback.link',
        method: 'POST',
        path: '/api/agents/feedback/:id/link',
        auth: 'bearer_user_or_agent',
        state: status.features.feedback_board.state,
        required_scope: 'feedback:link',
      },
      {
        id: 'agents.telemetry.health',
        method: 'GET',
        path: '/api/agents/telemetry/health?hours=24',
        auth: 'bearer_user_or_agent',
        state: status.features.telemetry.state,
        required_scope: 'telemetry:read',
      },
      {
        id: 'agents.telemetry.recent',
        method: 'GET',
        path: '/api/agents/telemetry/recent?minutes=30&limit=80',
        auth: 'bearer_user_or_agent',
        state: status.features.telemetry.state,
        required_scope: 'telemetry:read',
      },
      {
        id: 'agents.telemetry.usage',
        method: 'GET',
        path: '/api/agents/telemetry/usage?hours=72',
        auth: 'bearer_user_or_agent',
        state: status.features.telemetry.state,
        required_scope: 'telemetry:read',
      },
      {
        id: 'billing.status.read',
        method: 'GET',
        path: '/api/billing/status',
        auth: 'bearer',
        state: status.features.billing.state,
      },
      {
        id: 'billing.checkout.create',
        method: 'POST',
        path: '/api/billing/checkout',
        auth: 'bearer',
        state: status.features.billing.state,
        body: { plan: 'solo', trial_opt_in: true },
      },
      {
        id: 'billing.portal.create',
        method: 'POST',
        path: '/api/billing/portal',
        auth: 'bearer',
        state: status.features.billing.state,
      },
      {
        id: 'conversation.list',
        method: 'GET',
        path: '/api/conversations?limit=20&sort=newest&origin=agent',
        auth: 'optional',
        state: status.features.core_api.state,
      },
      {
        id: 'conversation.create',
        method: 'POST',
        path: '/api/conversations',
        auth: 'bearer_user_or_agent',
        required_scope: 'conversations:write',
        state: status.features.core_api.state,
      },
      {
        id: 'conversation.archive',
        method: 'POST',
        path: '/api/archive',
        auth: 'bearer_user_or_agent',
        required_scope: 'conversations:write',
        state: status.features.core_api.state,
      },
    ],
    status,
  };
}

async function getPollResults(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('agent_poll_votes')
    .select('option_id')
    .eq('poll_id', pollQuestion.id);
  if (error) {
    throw error;
  }
  const counts: Record<string, number> = {};
  for (const row of data || []) {
    counts[row.option_id] = (counts[row.option_id] || 0) + 1;
  }
  return pollQuestion.options.map((option) => ({
    ...option,
    votes: counts[option.id] || 0,
  }));
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

async function requireUserSession(request: IRequest, env: Env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return {
      response: json({ error: 'Auth unavailable' }, 503),
      supabase: null as SupabaseClient | null,
      user: null as any,
    };
  }

  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  if (!user) {
    return {
      response: json({ error: 'Unauthorized' }, 401),
      supabase: null as SupabaseClient | null,
      user: null as any,
    };
  }

  return { response: null as Response | null, supabase, user };
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

router.get('/api/agents/status', async (_request: IRequest, env: Env) => {
  return json(buildAgentsStatus(env));
});

router.get('/api/agents/capabilities', async (_request: IRequest, env: Env) => {
  return json(buildAgentsCapabilities(env));
});

router.get('/.well-known/oauth-authorization-server', async (_request: IRequest, env: Env) => {
  const issuer = getBaseUrl(env);
  return json({
    issuer,
    token_endpoint: `${issuer}/api/agents/oauth/token`,
    grant_types_supported: ['client_credentials'],
    response_types_supported: [],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    scopes_supported: Array.from(allowedAgentScopes.values()).filter((scope) => scope !== '*'),
    service_documentation: `${issuer}/agents/agents.md`,
  });
});

router.get('/api/agents/oauth/clients', async (request: IRequest, env: Env) => {
  const auth = await requireUserSession(request, env);
  if (auth.response) return auth.response;

  const { data, error } = await auth.supabase!
    .from('agent_oauth_clients')
    .select('id,name,client_id,allowed_scopes,status,last_used_at,revoked_at,created_at,updated_at')
    .eq('owner_user_id', auth.user.id)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('OAuth client list error', error);
    return json({ error: 'Failed to list OAuth clients' }, 500);
  }

  return json({ clients: data || [] });
});

router.post('/api/agents/oauth/clients', async (request: IRequest, env: Env) => {
  const auth = await requireUserSession(request, env);
  if (auth.response) return auth.response;

  const body = await parseJson<{ name?: string; allowed_scopes?: string[] }>(request);
  const name = (body?.name || 'agent-oauth-client').trim();
  if (name.length < 2 || name.length > 80) {
    return json({ error: 'name must be between 2 and 80 characters' }, 400);
  }

  const { scopes, invalid } = normalizeAgentScopes(body?.allowed_scopes);
  if (invalid.length) {
    return json({ error: `Invalid scopes: ${invalid.join(', ')}` }, 400);
  }

  const clientId = generateOauthClientId();
  const clientSecret = generateOauthClientSecret();
  const clientSecretHash = await hashString(clientSecret);

  const { data, error } = await auth.supabase!
    .from('agent_oauth_clients')
    .insert({
      owner_user_id: auth.user.id,
      name,
      client_id: clientId,
      client_secret_hash: clientSecretHash,
      allowed_scopes: scopes,
      status: 'active',
    })
    .select('id,name,client_id,allowed_scopes,status,last_used_at,revoked_at,created_at,updated_at')
    .single();
  if (error || !data) {
    console.error('OAuth client create error', error);
    return json({ error: 'Failed to create OAuth client' }, 500);
  }

  return json({
    client: data,
    client_secret: clientSecret,
  }, 201);
});

router.post('/api/agents/oauth/clients/:id/rotate-secret', async (request: IRequest, env: Env) => {
  const auth = await requireUserSession(request, env);
  if (auth.response) return auth.response;

  const { id } = request.params;
  const { data: existing, error: existingErr } = await auth.supabase!
    .from('agent_oauth_clients')
    .select('id,client_id,status')
    .eq('id', id)
    .eq('owner_user_id', auth.user.id)
    .single();
  if (existingErr || !existing) {
    return json({ error: 'OAuth client not found' }, 404);
  }
  if (existing.status !== 'active') {
    return json({ error: 'Only active OAuth clients can rotate secrets' }, 400);
  }

  const nowIso = new Date().toISOString();
  const clientSecret = generateOauthClientSecret();
  const clientSecretHash = await hashString(clientSecret);

  const { error: updateErr } = await auth.supabase!
    .from('agent_oauth_clients')
    .update({
      client_secret_hash: clientSecretHash,
      updated_at: nowIso,
    })
    .eq('id', id)
    .eq('owner_user_id', auth.user.id)
    .eq('status', 'active');
  if (updateErr) {
    console.error('OAuth client rotate error', updateErr);
    return json({ error: 'Failed to rotate OAuth client secret' }, 500);
  }

  await auth.supabase!
    .from('agent_oauth_access_tokens')
    .update({
      status: 'revoked',
      revoked_at: nowIso,
    })
    .eq('client_ref', id)
    .eq('status', 'active');

  return json({
    client_id: existing.client_id,
    client_secret: clientSecret,
    rotated: true,
  });
});

router.post('/api/agents/oauth/clients/:id/revoke', async (request: IRequest, env: Env) => {
  const auth = await requireUserSession(request, env);
  if (auth.response) return auth.response;

  const { id } = request.params;
  const nowIso = new Date().toISOString();
  const { data, error } = await auth.supabase!
    .from('agent_oauth_clients')
    .update({
      status: 'revoked',
      revoked_at: nowIso,
      updated_at: nowIso,
    })
    .eq('id', id)
    .eq('owner_user_id', auth.user.id)
    .eq('status', 'active')
    .select('id,name,client_id,allowed_scopes,status,last_used_at,revoked_at,created_at,updated_at')
    .single();
  if (error || !data) {
    return json({ error: 'OAuth client not found or already revoked' }, 404);
  }

  await auth.supabase!
    .from('agent_oauth_access_tokens')
    .update({
      status: 'revoked',
      revoked_at: nowIso,
    })
    .eq('client_ref', id)
    .eq('status', 'active');

  return json({ client: data });
});

router.post('/api/agents/oauth/token', async (request: IRequest, env: Env) => {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return oauthError('server_error', 'OAuth token service unavailable', 503);
  }

  const rlCfg = buildRateLimitConfig(env);
  const ip = getClientIp(request) || 'unknown';
  const ipHash = (await hashString(`ip:${ip}`)).slice(0, 24);
  const rl = await rateLimitOrRespond(
    request,
    env,
    [{ key: `oauth_token:ip:${ipHash}`, limit: rlCfg.publicWriteRpm, window_seconds: 60 }],
    'Too many token requests',
  );
  if (rl) return rl;

  const basic = getBasicAuthCredentials(request);
  const body = await parseFormOrJson(request);
  const grantType = (typeof body.grant_type === 'string' ? body.grant_type : '').trim();
  if (!grantType) {
    return oauthError('invalid_request', 'grant_type is required');
  }
  if (grantType !== 'client_credentials') {
    return oauthError('unsupported_grant_type', 'Only client_credentials grant is supported');
  }

  const clientId = (basic?.clientId || (typeof body.client_id === 'string' ? body.client_id : '')).trim();
  const clientSecret = (basic?.clientSecret || (typeof body.client_secret === 'string' ? body.client_secret : '')).trim();
  if (!clientId || !clientSecret) {
    return oauthError('invalid_client', 'client authentication failed', 401);
  }

  const supabase = getServiceSupabase(env);
  const { data: oauthClient, error: clientErr } = await supabase
    .from('agent_oauth_clients')
    .select('id,owner_user_id,name,client_secret_hash,allowed_scopes,status,revoked_at')
    .eq('client_id', clientId)
    .single();
  if (clientErr || !oauthClient) {
    return oauthError('invalid_client', 'client authentication failed', 401);
  }
  if (oauthClient.status !== 'active' || oauthClient.revoked_at) {
    return oauthError('invalid_client', 'client is inactive', 401);
  }

  const suppliedSecretHash = await hashString(clientSecret);
  if (suppliedSecretHash !== oauthClient.client_secret_hash) {
    return oauthError('invalid_client', 'client authentication failed', 401);
  }

  const allowedScopes = expandAllowedScopes(oauthClient.allowed_scopes);
  const requestedScopesRaw = parseScopeString(typeof body.scope === 'string' ? body.scope : '');
  const { scopes: requestedScopes, invalid } = validateAgentScopes(requestedScopesRaw);
  if (invalid.length) {
    return oauthError('invalid_scope', `invalid scopes requested: ${invalid.join(', ')}`);
  }

  let grantedScopes: string[] = [];
  if (requestedScopes.length) {
    const denied = requestedScopes.filter((scope) => !allowedScopes.includes(scope));
    if (denied.length) {
      return oauthError('invalid_scope', `scope not allowed for client: ${denied.join(', ')}`);
    }
    grantedScopes = requestedScopes;
  } else {
    grantedScopes = allowedScopes.length ? allowedScopes : ['status:read', 'capabilities:read'];
  }

  const expiresIn = parsePositiveInt(typeof body.expires_in === 'string' ? body.expires_in : undefined, 3600, 60, 86400);
  const accessToken = generateAgentToken();
  const tokenHash = await hashString(accessToken);
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  const { error: tokenErr } = await supabase
    .from('agent_oauth_access_tokens')
    .insert({
      client_ref: oauthClient.id,
      token_hash: tokenHash,
      scopes: grantedScopes,
      status: 'active',
      expires_at: expiresAt,
    });
  if (tokenErr) {
    console.error('OAuth access token issue error', tokenErr);
    return oauthError('server_error', 'failed to issue access token', 500);
  }

  await supabase
    .from('agent_oauth_clients')
    .update({ last_used_at: nowIso })
    .eq('id', oauthClient.id)
    .eq('status', 'active');

  return json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: grantedScopes.join(' '),
    mnemolog_token_source: 'oauth_client_credentials',
  });
});

router.get('/api/agents/telemetry/health', async (request: IRequest, env: Env) => {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Telemetry unavailable' }, 503);
  }

  const bearer = getBearerToken(request);
  if (!bearer) return json({ error: 'Unauthorized' }, 401);

  if (bearer.startsWith('mna_')) {
    const auth = await requireAgentTokenScope(request, env, 'telemetry:read');
    if (auth.response) return auth.response;
  } else {
    if (!env.SUPABASE_ANON_KEY) {
      return json({ error: 'Telemetry health requires SUPABASE_ANON_KEY' }, 503);
    }
    const authHeader = request.headers.get('Authorization') || undefined;
    const userSupabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: {
        headers: authHeader ? { Authorization: authHeader } : {},
      },
    });
    const user = await getUser(request, userSupabase);
    if (!user) return json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const hours = parsePositiveInt(url.searchParams.get('hours') || undefined, 24, 1, 24 * 30);
  const maxRows = parsePositiveInt(env.TELEMETRY_MAX_USAGE_ROWS, 5000, 500, 20000);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const supabase = getServiceSupabase(env);
  const { data, error } = await supabase
    .from('agent_telemetry_events')
    .select('endpoint,feature_area,status_code,duration_ms,success,created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(maxRows);

  if (error) {
    console.error('Telemetry health read error', error);
    return json({ error: 'Failed to fetch telemetry health' }, 500);
  }

  const rows = data || [];
  const total = rows.length;
  const serverErrors = rows.filter((row: any) => Number(row.status_code) >= 500).length;
  const clientErrors = rows.filter((row: any) => Number(row.status_code) >= 400 && Number(row.status_code) < 500).length;
  const successes = rows.filter((row: any) => row.success === true).length;
  const p95LatencyMs = percentile95(rows.map((row: any) => Number(row.duration_ms) || 0));

  const endpointAgg: Record<string, { requests: number; server_errors: number }> = {};
  rows.forEach((row: any) => {
    const endpoint = row.endpoint || 'unknown';
    const statusCode = Number(row.status_code || 0);
    if (!endpointAgg[endpoint]) {
      endpointAgg[endpoint] = { requests: 0, server_errors: 0 };
    }
    endpointAgg[endpoint].requests += 1;
    if (statusCode >= 500) endpointAgg[endpoint].server_errors += 1;
  });
  const topFailingEndpoints = Object.entries(endpointAgg)
    .map(([endpoint, stats]) => ({
      endpoint,
      total_requests: stats.requests,
      server_errors: stats.server_errors,
      error_rate: stats.requests ? Number((stats.server_errors / stats.requests).toFixed(4)) : 0,
    }))
    .filter((row) => row.server_errors > 0)
    .sort((a, b) => b.error_rate - a.error_rate || b.server_errors - a.server_errors)
    .slice(0, 5);

  return json({
    window_hours: hours,
    generated_at: new Date().toISOString(),
    sample_success_rate: parseSampleRate(env.TELEMETRY_SUCCESS_SAMPLE_RATE, 0.25),
    row_limit: maxRows,
    truncated: total >= maxRows,
    totals: {
      requests: total,
      successes,
      client_errors: clientErrors,
      server_errors: serverErrors,
    },
    rates: {
      success: total ? Number((successes / total).toFixed(4)) : 0,
      client_error: total ? Number((clientErrors / total).toFixed(4)) : 0,
      server_error: total ? Number((serverErrors / total).toFixed(4)) : 0,
    },
    latency_ms: {
      p95: p95LatencyMs,
    },
    top_failing_endpoints: topFailingEndpoints,
  });
});

// Recent telemetry feed (sanitized): requires auth, server-role sourced.
router.get('/api/agents/telemetry/recent', async (request: IRequest, env: Env) => {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Telemetry unavailable' }, 503);
  }

  const bearer = getBearerToken(request);
  if (!bearer) return json({ error: 'Unauthorized' }, 401);

  if (bearer.startsWith('mna_')) {
    const auth = await requireAgentTokenScope(request, env, 'telemetry:read');
    if (auth.response) return auth.response;
  } else {
    if (!env.SUPABASE_ANON_KEY) {
      return json({ error: 'Telemetry recent requires SUPABASE_ANON_KEY' }, 503);
    }
    const authHeader = request.headers.get('Authorization') || undefined;
    const userSupabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: {
        headers: authHeader ? { Authorization: authHeader } : {},
      },
    });
    const user = await getUser(request, userSupabase);
    if (!user) return json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const minutes = parsePositiveInt(url.searchParams.get('minutes') || undefined, 30, 1, 24 * 60);
  const limit = parsePositiveInt(url.searchParams.get('limit') || undefined, 80, 1, 200);
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  const supabase = getServiceSupabase(env);
  const { data, error } = await supabase
    .from('agent_telemetry_events')
    .select('endpoint,method,feature_area,auth_mode,status_code,duration_ms,success,created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Telemetry recent read error', error);
    return json({ error: 'Failed to fetch recent telemetry' }, 500);
  }

  const rows = (data || []).map((row: any) => ({
    endpoint: row.endpoint || 'unknown',
    method: row.method || 'GET',
    feature_area: row.feature_area || 'unknown',
    auth_mode: row.auth_mode || 'none',
    status_code: Number(row.status_code || 0),
    duration_ms: Number(row.duration_ms || 0),
    success: row.success === true,
    created_at: row.created_at,
  }));

  const byFeatureArea: Record<string, number> = {};
  const byEndpoint: Record<string, number> = {};
  let serverErrors = 0;
  let clientErrors = 0;
  rows.forEach((row) => {
    byFeatureArea[row.feature_area] = (byFeatureArea[row.feature_area] || 0) + 1;
    byEndpoint[row.endpoint] = (byEndpoint[row.endpoint] || 0) + 1;
    if (row.status_code >= 500) serverErrors += 1;
    if (row.status_code >= 400 && row.status_code < 500) clientErrors += 1;
  });

  const topEndpoints = Object.entries(byEndpoint)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([endpoint, count]) => ({ endpoint, count }));

  return json({
    window_minutes: minutes,
    generated_at: new Date().toISOString(),
    totals: {
      requests: rows.length,
      client_errors: clientErrors,
      server_errors: serverErrors,
    },
    by_feature_area: byFeatureArea,
    top_endpoints: topEndpoints,
    events: rows,
  });
});

router.get('/api/agents/telemetry/usage', async (request: IRequest, env: Env) => {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Telemetry unavailable' }, 503);
  }

  const bearer = getBearerToken(request);
  if (!bearer) return json({ error: 'Unauthorized' }, 401);

  if (bearer.startsWith('mna_')) {
    const auth = await requireAgentTokenScope(request, env, 'telemetry:read');
    if (auth.response) return auth.response;
  } else {
    if (!env.SUPABASE_ANON_KEY) {
      return json({ error: 'Telemetry usage requires SUPABASE_ANON_KEY' }, 503);
    }
    const authHeader = request.headers.get('Authorization') || undefined;
    const userSupabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: {
        headers: authHeader ? { Authorization: authHeader } : {},
      },
    });
    const user = await getUser(request, userSupabase);
    if (!user) return json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const hours = parsePositiveInt(url.searchParams.get('hours') || undefined, 72, 1, 24 * 30);
  const maxRows = parsePositiveInt(env.TELEMETRY_MAX_USAGE_ROWS, 5000, 500, 20000);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const supabase = getServiceSupabase(env);
  const { data, error } = await supabase
    .from('agent_telemetry_events')
    .select('endpoint,feature_area,auth_mode,status_code,duration_ms,success,created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(maxRows);

  if (error) {
    console.error('Telemetry usage read error', error);
    return json({ error: 'Failed to fetch telemetry usage' }, 500);
  }

  const rows = data || [];
  const byAuthMode: Record<string, number> = {};
  const byFeatureArea: Record<string, number> = {};
  const endpointStats: Record<string, { requests: number; server_errors: number; client_errors: number; durations: number[] }> = {};

  rows.forEach((row: any) => {
    const endpoint = row.endpoint || 'unknown';
    const featureArea = row.feature_area || 'unknown';
    const authMode = row.auth_mode || 'none';
    const statusCode = Number(row.status_code || 0);
    const duration = Number(row.duration_ms || 0);

    byAuthMode[authMode] = (byAuthMode[authMode] || 0) + 1;
    byFeatureArea[featureArea] = (byFeatureArea[featureArea] || 0) + 1;

    if (!endpointStats[endpoint]) {
      endpointStats[endpoint] = { requests: 0, server_errors: 0, client_errors: 0, durations: [] };
    }
    endpointStats[endpoint].requests += 1;
    if (statusCode >= 500) endpointStats[endpoint].server_errors += 1;
    if (statusCode >= 400 && statusCode < 500) endpointStats[endpoint].client_errors += 1;
    endpointStats[endpoint].durations.push(duration);
  });

  const endpoints = Object.entries(endpointStats)
    .map(([endpoint, stats]) => ({
      endpoint,
      requests: stats.requests,
      server_errors: stats.server_errors,
      client_errors: stats.client_errors,
      p95_latency_ms: percentile95(stats.durations),
    }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 25);

  return json({
    window_hours: hours,
    generated_at: new Date().toISOString(),
    row_limit: maxRows,
    truncated: rows.length >= maxRows,
    totals: {
      requests: rows.length,
      endpoints: Object.keys(endpointStats).length,
    },
    by_auth_mode: byAuthMode,
    by_feature_area: byFeatureArea,
    endpoints,
  });
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

const activeBillingStatuses = new Set([
  'trialing',
  'trial_will_end',
  'active',
  'past_due',
  'unpaid',
  'incomplete',
]);

async function isTrialCapacityAvailable(
  supabase: SupabaseClient,
  maxSignups: number | null,
  trialAlreadyStarted: boolean,
) {
  if (!maxSignups || maxSignups <= 0) {
    return { available: true, activeSignups: null as number | null };
  }
  if (trialAlreadyStarted) {
    return { available: true, activeSignups: null as number | null };
  }
  const { count, error } = await supabase
    .from('profile_private')
    .select('profile_id', { count: 'exact', head: true })
    .not('billing_trial_started_at', 'is', null);
  if (error) {
    throw error;
  }
  const activeSignups = typeof count === 'number' ? count : 0;
  return {
    available: activeSignups < maxSignups,
    activeSignups,
  };
}

function isBillingTrialEligibleForProfile(
  profile: {
    billing_status?: string | null;
    billing_trial_started_at?: string | null;
    billing_trial_consumed_at?: string | null;
  } | null,
) {
  const billingStatus = (profile?.billing_status || '').toLowerCase();
  const trialConsumed = !!profile?.billing_trial_consumed_at;
  const trialStarted = !!profile?.billing_trial_started_at;
  const activeBilling = activeBillingStatuses.has(billingStatus);
  return {
    eligible: !trialConsumed && !trialStarted && !activeBilling,
    trialStarted,
    trialConsumed,
    activeBilling,
  };
}

// Billing status for signed-in users
router.get('/api/billing/status', async (request: IRequest, env: Env) => {
  const auth = await requireUserSession(request, env);
  if (auth.response) return auth.response;

  const trialCfg = buildBillingTrialConfig(env);
  const { data: profile, error } = await auth.supabase!
    .from('profile_private')
    .select(
      `
      stripe_customer_id,
      billing_plan,
      billing_status,
      billing_updated_at,
      billing_trial_started_at,
      billing_trial_ends_at,
      billing_trial_consumed_at,
      billing_trial_reminder_sent_at
    `,
    )
    .eq('profile_id', auth.user.id)
    .maybeSingle();
  if (error) {
    console.error('Billing status read error', error);
    return json({ error: 'Failed to read billing status' }, 500);
  }

  const trialEligibility = isBillingTrialEligibleForProfile(profile as any);
  const nowMs = Date.now();
  const trialEndsMs = profile?.billing_trial_ends_at ? new Date(profile.billing_trial_ends_at).getTime() : NaN;
  const trialActive = Number.isFinite(trialEndsMs)
    ? trialEndsMs > nowMs
    : (profile?.billing_status || '').toLowerCase() === 'trialing';
  const trialDaysRemaining = Number.isFinite(trialEndsMs)
    ? Math.max(0, Math.ceil((trialEndsMs - nowMs) / (24 * 60 * 60 * 1000)))
    : null;

  let trialCapacity: { available: boolean; activeSignups: number | null } = {
    available: true,
    activeSignups: null,
  };
  try {
    // Capacity is evaluated with service role to avoid leaking or breaking under owner-only RLS.
    const service = getServiceSupabase(env);
    trialCapacity = await isTrialCapacityAvailable(
      service,
      trialCfg.maxSignups,
      trialEligibility.trialStarted,
    );
  } catch (capError) {
    console.error('Billing trial capacity check failed', capError);
  }

  return json({
    billing: {
      stripe_customer_id: profile?.stripe_customer_id || null,
      plan: profile?.billing_plan || null,
      status: profile?.billing_status || null,
      updated_at: profile?.billing_updated_at || null,
    },
    trial: {
      enabled: trialCfg.enabled,
      days: trialCfg.days,
      max_signups: trialCfg.maxSignups,
      active_signups: trialCapacity.activeSignups,
      capacity_available: trialCapacity.available,
      eligible_plans: Array.from(trialCfg.eligiblePlans.values()),
      eligible: trialCfg.enabled && trialEligibility.eligible && trialCapacity.available,
      active: trialActive,
      days_remaining: trialDaysRemaining,
      started_at: profile?.billing_trial_started_at || null,
      ends_at: profile?.billing_trial_ends_at || null,
      consumed_at: profile?.billing_trial_consumed_at || null,
      reminder_sent_at: profile?.billing_trial_reminder_sent_at || null,
    },
  });
});

// Create Stripe checkout session
router.post('/api/billing/checkout', async (request: IRequest, env: Env) => {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'Billing unavailable' }, 503);
  }
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  if (!user?.email) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const body = await parseJson<{
    plan?: string;
    success_url?: string;
    cancel_url?: string;
    trial_opt_in?: boolean;
  }>(request);
  if (!body?.plan) {
    return json({ error: 'Plan is required' }, 400);
  }

  const normalizedPlan = body.plan.trim().toLowerCase();
  const priceId = requireStripePrice(env, normalizedPlan);
  const baseUrl = getBaseUrl(env);
  const stripe = getStripe(env);
  const trialCfg = buildBillingTrialConfig(env);
  const safeSuccessUrl = sanitizeRedirectUrl(body.success_url, baseUrl);
  const safeCancelUrl = sanitizeRedirectUrl(body.cancel_url, baseUrl);
  const trialOptIn = body.trial_opt_in !== false;

  let stripeCustomerId: string | null = null;
  let profile: any = null;
  try {
    const { data } = await supabase
      .from('profile_private')
      .select(
        `
        stripe_customer_id,
        billing_status,
        billing_trial_started_at,
        billing_trial_consumed_at
      `,
      )
      .eq('profile_id', user.id)
      .maybeSingle();
    profile = data || null;
    stripeCustomerId = data?.stripe_customer_id ?? null;
  } catch {
    profile = null;
    stripeCustomerId = null;
  }

  const trialEligibility = isBillingTrialEligibleForProfile(profile);
  let trialCapacity: { available: boolean; activeSignups: number | null } = {
    available: true,
    activeSignups: null,
  };
  if (trialCfg.enabled && trialOptIn && trialEligibility.eligible && trialCfg.eligiblePlans.has(normalizedPlan)) {
    try {
      const service = getServiceSupabase(env);
      trialCapacity = await isTrialCapacityAvailable(service, trialCfg.maxSignups, trialEligibility.trialStarted);
    } catch (trialCapacityErr) {
      console.error('Billing trial capacity check failed', trialCapacityErr);
      return json({ error: 'Unable to evaluate trial capacity' }, 500);
    }
  }

  const trialApplied = trialCfg.enabled
    && trialOptIn
    && trialCfg.eligiblePlans.has(normalizedPlan)
    && trialEligibility.eligible
    && trialCapacity.available;

  const trialReason = !trialCfg.enabled
    ? 'trial_disabled'
    : !trialOptIn
    ? 'trial_opt_out'
    : !trialCfg.eligiblePlans.has(normalizedPlan)
    ? 'plan_not_eligible'
    : !trialEligibility.eligible
    ? 'already_used_or_active_subscription'
    : !trialCapacity.available
    ? 'trial_capacity_reached'
    : 'trial_applied';

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    payment_method_collection: 'always',
    ...(stripeCustomerId ? { customer: stripeCustomerId } : { customer_email: user.email }),
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: safeSuccessUrl || `${baseUrl}/agents/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: safeCancelUrl || `${baseUrl}/agents/`,
    subscription_data: {
      metadata: {
        user_id: user.id,
        plan: normalizedPlan,
        trial_opt_in: String(trialOptIn),
        trial_applied: String(trialApplied),
      },
      ...(trialApplied ? { trial_period_days: trialCfg.days } : {}),
    },
    metadata: {
      user_id: user.id,
      plan: normalizedPlan,
      trial_opt_in: String(trialOptIn),
      trial_applied: String(trialApplied),
    },
  });

  return json({
    id: session.id,
    url: session.url,
    trial: {
      opt_in: trialOptIn,
      applied: trialApplied,
      days: trialApplied ? trialCfg.days : 0,
      reason: trialReason,
      max_signups: trialCfg.maxSignups,
      active_signups: trialCapacity.activeSignups,
    },
  });
});

// Create Stripe customer portal session
router.post('/api/billing/portal', async (request: IRequest, env: Env) => {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'Billing unavailable' }, 503);
  }
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  if (!user?.email) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const stripe = getStripe(env);
  let customerId: string | null = null;
  try {
    const { data: profile } = await supabase
      .from('profile_private')
      .select('stripe_customer_id')
      .eq('profile_id', user.id)
      .maybeSingle();
    customerId = profile?.stripe_customer_id ?? null;
  } catch {
    customerId = null;
  }

  if (!customerId) {
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    customerId = customers.data[0]?.id ?? null;
  }

  if (!customerId) {
    return json({ error: 'No customer record found' }, 404);
  }

  const baseUrl = getBaseUrl(env);
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/agents/`,
  });

  return json({ url: portal.url });
});

// Stripe webhooks
router.post('/api/billing/webhook', async (request: IRequest, env: Env) => {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: 'Billing unavailable' }, 503);
  }

  const signature = request.headers.get('Stripe-Signature');
  if (!signature) {
    return json({ error: 'Missing signature' }, 400);
  }

  const payload = await request.text();
  const stripe = getStripe(env);

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    console.error('Stripe webhook signature verification failed', err?.message || err);
    return json({ error: `Webhook signature verification failed: ${err?.message || 'unknown error'}` }, 400);
  }

  try {
    console.log('Stripe webhook received', { id: event.id, type: event.type });
    const supabase = getServiceSupabase(env);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
      const userId = session.metadata?.user_id || null;
      let plan = session.metadata?.plan || null;
      const nowIso = new Date().toISOString();
      let billingStatus = 'active';
      let trialStartIso: string | null = null;
      let trialEndIso: string | null = null;

      if (session.subscription) {
        const subscriptionId = typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription.id;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        billingStatus = subscription.status || billingStatus;
        if (!plan) {
          plan = resolvePlanFromPrice(env, subscription.items.data[0]?.price?.id || null);
        }
        trialStartIso = unixSecondsToIso(subscription.trial_start as number | null | undefined);
        trialEndIso = unixSecondsToIso(subscription.trial_end as number | null | undefined);
      }

      if (customerId && userId) {
        const updates: Record<string, any> = {
          stripe_customer_id: customerId,
          billing_plan: plan,
          billing_status: billingStatus,
          billing_updated_at: nowIso,
        };
        if (trialStartIso) {
          updates.billing_trial_started_at = trialStartIso;
          updates.billing_trial_consumed_at = trialStartIso;
        }
        if (trialEndIso) {
          updates.billing_trial_ends_at = trialEndIso;
        }

        await supabase
          .from('profile_private')
          .update(updates)
          .eq('profile_id', userId);
      }
    }

    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      const subscriptionId = typeof invoice.subscription === 'string'
        ? invoice.subscription
        : invoice.subscription?.id;
      const nowIso = new Date().toISOString();

      // Derive plan/status from the subscription when possible (authoritative for subscription billing).
      let plan = resolvePlanFromPrice(env, invoice.lines?.data?.[0]?.price?.id || null);
      let billingStatus = event.type === 'invoice.paid' ? 'active' : 'past_due';
      let trialStartIso: string | null = null;
      let trialEndIso: string | null = null;

      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        billingStatus = subscription.status || billingStatus;
        plan = plan || resolvePlanFromPrice(env, subscription.items.data[0]?.price?.id || null);
        trialStartIso = unixSecondsToIso(subscription.trial_start as number | null | undefined);
        trialEndIso = unixSecondsToIso(subscription.trial_end as number | null | undefined);
      }

      if (customerId) {
        const updates: Record<string, any> = {
          billing_plan: plan,
          billing_status: billingStatus,
          billing_updated_at: nowIso,
        };
        if (trialStartIso) {
          updates.billing_trial_started_at = trialStartIso;
          updates.billing_trial_consumed_at = trialStartIso;
        }
        if (trialEndIso) {
          updates.billing_trial_ends_at = trialEndIso;
        }
        await supabase
          .from('profile_private')
          .update(updates)
          .eq('stripe_customer_id', customerId);
      }
    }

    if (event.type.startsWith('customer.subscription.')) {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
      const status = subscription.status;
      const plan = resolvePlanFromPrice(env, subscription.items.data[0]?.price?.id || null);
      const trialStartIso = unixSecondsToIso(subscription.trial_start as number | null | undefined);
      const trialEndIso = unixSecondsToIso(subscription.trial_end as number | null | undefined);
      if (customerId) {
        const updates: Record<string, any> = {
          billing_plan: plan,
          billing_status: status,
          billing_updated_at: new Date().toISOString(),
        };
        if (trialStartIso) {
          updates.billing_trial_started_at = trialStartIso;
          updates.billing_trial_consumed_at = trialStartIso;
        }
        if (trialEndIso) {
          updates.billing_trial_ends_at = trialEndIso;
        }
        if (event.type === 'customer.subscription.trial_will_end') {
          updates.billing_trial_reminder_sent_at = new Date().toISOString();
          updates.billing_status = 'trial_will_end';
        }

        await supabase
          .from('profile_private')
          .update(updates)
          .eq('stripe_customer_id', customerId);
      }
    }
  } catch (err) {
    console.error('Stripe webhook handling error', err);
    return json({ error: 'Webhook handling failed' }, 500);
  }

  return json({ received: true });
});

// Agents poll
router.get('/api/agents/poll', async (request: IRequest, env: Env) => {
  if (!env.POLL_SALT || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Poll unavailable' }, 503);
  }
  const rlCfg = buildRateLimitConfig(env);
  const ip = getClientIp(request) || 'unknown';
  const ipHash = (await hashString(`ip:${ip}`)).slice(0, 24);
  const rl = await rateLimitOrRespond(
    request,
    env,
    [{ key: `poll_read:ip:${ipHash}`, limit: rlCfg.publicReadRpm, window_seconds: 60 }],
  );
  if (rl) return rl;

  const supabase = getServiceSupabase(env);
  try {
    const results = await getPollResults(supabase);
    return json({ poll: pollQuestion, results });
  } catch (error) {
    console.error('Poll fetch error', error);
    return json({ error: 'Failed to fetch poll' }, 500);
  }
});

router.post('/api/agents/poll/vote', async (request: IRequest, env: Env) => {
  if (!env.POLL_SALT || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Poll unavailable' }, 503);
  }
  const body = await parseJson<{ option_id?: string }>(request);
  if (!body?.option_id) {
    return json({ error: 'option_id is required' }, 400);
  }
  const option = pollQuestion.options.find((entry) => entry.id === body.option_id);
  if (!option) {
    return json({ error: 'Invalid option' }, 400);
  }

  const ip = getClientIp(request);
  if (!ip) {
    return json({ error: 'Unable to verify voter' }, 400);
  }

  const rlCfg = buildRateLimitConfig(env);
  const ipHash = (await hashString(`ip:${ip}`)).slice(0, 24);
  const rl = await rateLimitOrRespond(
    request,
    env,
    [
      { key: `poll_vote:${pollQuestion.id}:ip:${ipHash}`, limit: rlCfg.publicVoteRpm, window_seconds: 60 },
      { key: `poll_vote:${pollQuestion.id}:ip:${ipHash}:h`, limit: rlCfg.publicVoteRpm * 20, window_seconds: 3600 },
    ],
  );
  if (rl) return rl;

  const fingerprint = await hashString(`${env.POLL_SALT}:${ip}:${pollQuestion.id}`);
  const supabase = getServiceSupabase(env);

  try {
    const { error } = await supabase
      .from('agent_poll_votes')
      .insert({
        poll_id: pollQuestion.id,
        option_id: option.id,
        voter_hash: fingerprint,
      });

    if (error) {
      if (error.code === '23505') {
        return json({ error: 'Already voted' }, 409);
      }
      console.error('Poll vote error', error);
      return json({ error: 'Failed to record vote' }, 500);
    }

    const results = await getPollResults(supabase);
    return json({ poll: pollQuestion, results });
  } catch (error) {
    console.error('Poll vote error', error);
    return json({ error: 'Failed to record vote' }, 500);
  }
});

router.get('/api/agents/tokens', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const { data, error } = await supabase
    .from('agent_tokens')
    .select('id, name, scopes, status, expires_at, last_used_at, revoked_at, created_at, updated_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Agent token list error', error);
    return json({ error: 'Failed to list agent tokens' }, 500);
  }

  return json({ tokens: data || [] });
});

router.post('/api/agents/tokens', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const body = await parseJson<{
    name?: string;
    scopes?: string[];
    expires_in_days?: number;
  }>(request);

  const name = (body?.name || 'agent-token').trim();
  if (name.length < 2 || name.length > 80) {
    return json({ error: 'name must be between 2 and 80 characters' }, 400);
  }

  const { scopes, invalid } = normalizeAgentScopes(body?.scopes);
  if (invalid.length) {
    return json({ error: `Invalid scopes: ${invalid.join(', ')}` }, 400);
  }

  const expiresInDaysRaw = Number(body?.expires_in_days ?? 90);
  if (!Number.isFinite(expiresInDaysRaw) || expiresInDaysRaw < 1 || expiresInDaysRaw > 3650) {
    return json({ error: 'expires_in_days must be between 1 and 3650' }, 400);
  }

  const token = generateAgentToken();
  const tokenHash = await hashString(token);
  const expiresAt = formatIsoInDays(Math.floor(expiresInDaysRaw));

  const { data, error } = await supabase
    .from('agent_tokens')
    .insert({
      user_id: user.id,
      name,
      token_hash: tokenHash,
      scopes,
      status: 'active',
      expires_at: expiresAt,
    })
    .select('id, name, scopes, status, expires_at, last_used_at, revoked_at, created_at, updated_at')
    .single();

  if (error || !data) {
    console.error('Agent token issue error', error);
    return json({ error: 'Failed to issue agent token' }, 500);
  }

  return json({ token, token_record: data }, 201);
});

router.post('/api/agents/tokens/:id/revoke', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const { id } = request.params;
  const { data, error } = await supabase
    .from('agent_tokens')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('status', 'active')
    .select('id, name, scopes, status, expires_at, last_used_at, revoked_at, created_at, updated_at')
    .single();

  if (error || !data) {
    return json({ error: 'Token not found or already revoked' }, 404);
  }

  return json({ token_record: data });
});

router.post('/api/agents/tokens/:id/rotate', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
  const user = await getUser(request, supabase);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const { id } = request.params;
  const body = await parseJson<{
    name?: string;
    scopes?: string[];
    expires_in_days?: number;
  }>(request);

  const { data: existing, error: existingErr } = await supabase
    .from('agent_tokens')
    .select('id, name, scopes, status')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (existingErr || !existing) {
    return json({ error: 'Token not found' }, 404);
  }
  if (existing.status !== 'active') {
    return json({ error: 'Only active tokens can be rotated' }, 400);
  }

  const name = (body?.name || existing.name || 'agent-token').trim();
  if (name.length < 2 || name.length > 80) {
    return json({ error: 'name must be between 2 and 80 characters' }, 400);
  }

  const candidateScopes = body?.scopes ?? existing.scopes ?? [];
  const { scopes, invalid } = normalizeAgentScopes(candidateScopes);
  if (invalid.length) {
    return json({ error: `Invalid scopes: ${invalid.join(', ')}` }, 400);
  }

  const expiresInDaysRaw = Number(body?.expires_in_days ?? 90);
  if (!Number.isFinite(expiresInDaysRaw) || expiresInDaysRaw < 1 || expiresInDaysRaw > 3650) {
    return json({ error: 'expires_in_days must be between 1 and 3650' }, 400);
  }

  const token = generateAgentToken();
  const tokenHash = await hashString(token);
  const expiresAt = formatIsoInDays(Math.floor(expiresInDaysRaw));

  const { data: issued, error: issueErr } = await supabase
    .from('agent_tokens')
    .insert({
      user_id: user.id,
      name,
      token_hash: tokenHash,
      scopes,
      status: 'active',
      expires_at: expiresAt,
    })
    .select('id, name, scopes, status, expires_at, last_used_at, revoked_at, created_at, updated_at')
    .single();

  if (issueErr || !issued) {
    console.error('Agent token rotate issue error', issueErr);
    return json({ error: 'Failed to rotate token' }, 500);
  }

  await supabase
    .from('agent_tokens')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .eq('user_id', user.id)
    .eq('status', 'active');

  return json({
    token,
    rotated_from: existing.id,
    token_record: issued,
  }, 201);
});

router.get('/api/agents/auth/me', async (request: IRequest, env: Env) => {
  const { claims, response } = await requireAgentTokenScope(request, env);
  if (response) return response;
  return json({
    agent: {
      id: claims!.id,
      user_id: claims!.user_id,
      name: claims!.name,
      scopes: claims!.scopes,
      status: claims!.status,
      expires_at: claims!.expires_at,
      revoked_at: claims!.revoked_at,
      token_source: claims!.token_source,
      agent_token_id: claims!.agent_token_id,
      oauth_client_id: claims!.oauth_client_id,
    },
  });
});

router.get('/api/agents/secure/poll', async (request: IRequest, env: Env) => {
  if (!env.POLL_SALT || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Poll unavailable' }, 503);
  }
  const auth = await requireAgentTokenScope(request, env, 'poll:read');
  if (auth.response) return auth.response;

  const supabase = getServiceSupabase(env);
  try {
    const results = await getPollResults(supabase);
    return json({ poll: pollQuestion, results });
  } catch (error) {
    console.error('Secure poll fetch error', error);
    return json({ error: 'Failed to fetch poll' }, 500);
  }
});

router.post('/api/agents/secure/poll/vote', async (request: IRequest, env: Env) => {
  if (!env.POLL_SALT || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Poll unavailable' }, 503);
  }
  const auth = await requireAgentTokenScope(request, env, 'poll:vote');
  if (auth.response) return auth.response;

  const body = await parseJson<{ option_id?: string }>(request);
  if (!body?.option_id) {
    return json({ error: 'option_id is required' }, 400);
  }
  const option = pollQuestion.options.find((entry) => entry.id === body.option_id);
  if (!option) {
    return json({ error: 'Invalid option' }, 400);
  }

  const stableAgentIdentity = auth.claims!.oauth_client_id || auth.claims!.id;
  const fingerprint = await hashString(`${env.POLL_SALT}:agent-token:${stableAgentIdentity}:${pollQuestion.id}`);
  const supabase = getServiceSupabase(env);

  try {
    const { error } = await supabase
      .from('agent_poll_votes')
      .insert({
        poll_id: pollQuestion.id,
        option_id: option.id,
        voter_hash: fingerprint,
      });

    if (error) {
      if (error.code === '23505') {
        return json({ error: 'Already voted' }, 409);
      }
      console.error('Secure poll vote error', error);
      return json({ error: 'Failed to record vote' }, 500);
    }

    const results = await getPollResults(supabase);
    return json({ poll: pollQuestion, results });
  } catch (error) {
    console.error('Secure poll vote error', error);
    return json({ error: 'Failed to record vote' }, 500);
  }
});

router.get('/api/agents/feedback', async (request: IRequest, env: Env) => {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Feedback unavailable' }, 503);
  }
  const rlCfg = buildRateLimitConfig(env);
  const ip = getClientIp(request) || 'unknown';
  const ipHash = (await hashString(`ip:${ip}`)).slice(0, 24);
  const rl = await rateLimitOrRespond(
    request,
    env,
    [{ key: `feedback_list:ip:${ipHash}`, limit: rlCfg.publicReadRpm, window_seconds: 60 }],
  );
  if (rl) return rl;

  const supabase = getServiceSupabase(env);
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const type = (url.searchParams.get('type') || '').trim().toLowerCase();
  const status = (url.searchParams.get('status') || '').trim().toLowerCase();
  const tag = (url.searchParams.get('tag') || '').trim().toLowerCase();
  const sort = (url.searchParams.get('sort') || 'active').trim().toLowerCase();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);

  let query = supabase
    .from('agent_feedback_items')
    .select(
      'id,type,title,body,tags,status,upvote_count,allow_upvotes,posting_starts_at,posting_ends_at,voting_starts_at,voting_ends_at,created_by_user_id,created_by_agent_token_id,created_at,updated_at',
      { count: 'exact' }
    );

  if (type && feedbackTypes.has(type)) query = query.eq('type', type);
  if (status && feedbackStatuses.has(status)) query = query.eq('status', status);
  if (tag) query = query.contains('tags', [tag]);
  if (q) query = query.textSearch('fts', q, { type: 'websearch', config: 'english' });

  if (sort === 'newest') {
    query = query.order('created_at', { ascending: false });
  } else if (sort === 'top') {
    query = query.order('upvote_count', { ascending: false }).order('created_at', { ascending: false });
  } else {
    query = query
      .order('status', { ascending: true })
      .order('voting_ends_at', { ascending: true })
      .order('upvote_count', { ascending: false });
  }
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) {
    console.error('Feedback list error', error);
    return json({ error: 'Failed to fetch feedback' }, 500);
  }

  const ids = (data || []).map((row: any) => row.id);
  const linkMap: Record<string, Array<{ related_item_id: string; relation_type: string }>> = {};
  if (ids.length) {
    const [{ data: srcLinks }, { data: tgtLinks }] = await Promise.all([
      supabase
        .from('agent_feedback_links')
        .select('source_item_id,target_item_id,relation_type')
        .in('source_item_id', ids),
      supabase
        .from('agent_feedback_links')
        .select('source_item_id,target_item_id,relation_type')
        .in('target_item_id', ids),
    ]);
    const merged = [...(srcLinks || []), ...(tgtLinks || [])];
    merged.forEach((link: any) => {
      const source = link.source_item_id;
      const target = link.target_item_id;
      if (!linkMap[source]) linkMap[source] = [];
      if (!linkMap[target]) linkMap[target] = [];
      linkMap[source].push({ related_item_id: target, relation_type: link.relation_type });
      linkMap[target].push({ related_item_id: source, relation_type: link.relation_type });
    });
  }

  const items = (data || []).map((row: any) => ({
    ...row,
    links: linkMap[row.id] || [],
  }));

  return json({ items, count: count || 0 });
});

router.get('/api/agents/feedback/trending', async (request: IRequest, env: Env) => {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Feedback unavailable' }, 503);
  }
  const rlCfg = buildRateLimitConfig(env);
  const ip = getClientIp(request) || 'unknown';
  const ipHash = (await hashString(`ip:${ip}`)).slice(0, 24);
  const rl = await rateLimitOrRespond(
    request,
    env,
    [{ key: `feedback_trending:ip:${ipHash}`, limit: rlCfg.publicReadRpm, window_seconds: 60 }],
  );
  if (rl) return rl;

  const supabase = getServiceSupabase(env);
  const url = new URL(request.url);
  const type = (url.searchParams.get('type') || '').trim().toLowerCase();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 30);
  const now = new Date().toISOString();

  let query = supabase
    .from('agent_feedback_items')
    .select('id,type,title,tags,status,upvote_count,voting_ends_at,created_at')
    .eq('status', 'open')
    .lte('voting_starts_at', now)
    .gte('voting_ends_at', now)
    .order('upvote_count', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (type && feedbackTypes.has(type)) query = query.eq('type', type);

  const { data, error } = await query;
  if (error) {
    console.error('Feedback trending error', error);
    return json({ error: 'Failed to fetch trending feedback' }, 500);
  }
  return json({ items: data || [] });
});

router.get('/api/agents/feedback/:id', async (request: IRequest, env: Env) => {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Feedback unavailable' }, 503);
  }
  const rlCfg = buildRateLimitConfig(env);
  const ip = getClientIp(request) || 'unknown';
  const ipHash = (await hashString(`ip:${ip}`)).slice(0, 24);
  const rl = await rateLimitOrRespond(
    request,
    env,
    [{ key: `feedback_get:ip:${ipHash}`, limit: rlCfg.publicReadRpm, window_seconds: 60 }],
  );
  if (rl) return rl;

  const supabase = getServiceSupabase(env);
  const { id } = request.params;

  const { data: item, error: itemError } = await supabase
    .from('agent_feedback_items')
    .select('*')
    .eq('id', id)
    .single();
  if (itemError || !item) {
    return json({ error: 'Feedback item not found' }, 404);
  }

  const [{ data: srcLinks }, { data: tgtLinks }] = await Promise.all([
    supabase
      .from('agent_feedback_links')
      .select('source_item_id,target_item_id,relation_type,created_at')
      .eq('source_item_id', id),
    supabase
      .from('agent_feedback_links')
      .select('source_item_id,target_item_id,relation_type,created_at')
      .eq('target_item_id', id),
  ]);
  const allLinks = [...(srcLinks || []), ...(tgtLinks || [])];
  const relatedIds = Array.from(new Set(allLinks.map((link: any) => (link.source_item_id === id ? link.target_item_id : link.source_item_id))));

  let related: any[] = [];
  if (relatedIds.length) {
    const { data: relatedRows } = await supabase
      .from('agent_feedback_items')
      .select('id,type,title,status,upvote_count,voting_ends_at')
      .in('id', relatedIds);
    related = relatedRows || [];
  }

  return json({
    item,
    links: allLinks.map((link: any) => ({
      relation_type: link.relation_type,
      related_item_id: link.source_item_id === id ? link.target_item_id : link.source_item_id,
      created_at: link.created_at,
    })),
    related,
  });
});

router.post('/api/agents/feedback', async (request: IRequest, env: Env) => {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Feedback unavailable' }, 503);
  }
  const actor = await resolveFeedbackActor(request, env, 'feedback:write', false);
  if (actor.response) return actor.response;

  const rlCfg = buildRateLimitConfig(env);
  const ip = getClientIp(request) || 'unknown';
  const ipHash = (await hashString(`ip:${ip}`)).slice(0, 24);
  const actorHash = (await hashString(`actor:${actor.identityType}:${actor.identityValue}`)).slice(0, 24);
  const rl = await rateLimitOrRespond(
    request,
    env,
    [
      // Authed endpoint; keep an IP-based limit but don't punish NATed agent fleets with the anonymous limit.
      { key: `feedback_create:ip:${ipHash}`, limit: rlCfg.authedRpm, window_seconds: 60 },
      { key: `feedback_create:actor:${actorHash}`, limit: rlCfg.authedRpm, window_seconds: 60 },
    ],
  );
  if (rl) return rl;

  const body = await parseJson<{
    type?: string;
    title?: string;
    body?: string;
    tags?: string[];
    voting_starts_at?: string;
    voting_ends_at?: string;
    allow_upvotes?: boolean;
  }>(request);

  const type = (body?.type || 'feature').trim().toLowerCase();
  if (!feedbackTypes.has(type)) {
    return json({ error: 'Invalid type; expected question, feature, or poll' }, 400);
  }
  const title = (body?.title || '').trim();
  if (title.length < 3 || title.length > 180) {
    return json({ error: 'title must be between 3 and 180 characters' }, 400);
  }
  const content = (body?.body || '').trim();
  if (content.length > 8000) {
    return json({ error: 'body exceeds maximum length (8000)' }, 400);
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cfg = buildFeedbackConfig(env);
  if (!withinWindow(nowMs, cfg.postingStart, cfg.postingEnd)) {
    return json({ error: 'Feedback posting window is closed' }, 403);
  }

  const votingStart = parseIsoDate(body?.voting_starts_at) || nowIso;
  const defaultVotingEnd = formatIsoInDays(cfg.defaultVotingDays);
  const votingEnd = parseIsoDate(body?.voting_ends_at) || defaultVotingEnd;
  const votingStartMs = new Date(votingStart).getTime();
  const votingEndMs = new Date(votingEnd).getTime();
  if (!Number.isFinite(votingStartMs) || !Number.isFinite(votingEndMs) || votingEndMs <= votingStartMs) {
    return json({ error: 'Invalid voting window' }, 400);
  }
  const maxWindowMs = cfg.maxVotingDays * 24 * 60 * 60 * 1000;
  if (votingEndMs - votingStartMs > maxWindowMs) {
    return json({ error: `Voting window exceeds max allowed duration (${cfg.maxVotingDays} days)` }, 400);
  }

  const supabase = getServiceSupabase(env);
  const { data, error } = await supabase
    .from('agent_feedback_items')
    .insert({
      type,
      title,
      body: content || null,
      tags: parseTags(body?.tags),
      status: 'open',
      allow_upvotes: body?.allow_upvotes !== false,
      upvote_count: 0,
      posting_starts_at: cfg.postingStart || nowIso,
      posting_ends_at: cfg.postingEnd || null,
      voting_starts_at: votingStart,
      voting_ends_at: votingEnd,
      created_by_user_id: actor.userId,
      created_by_agent_token_id: actor.agentTokenId,
    })
    .select('*')
    .single();

  if (error || !data) {
    console.error('Feedback create error', error);
    return json({ error: 'Failed to create feedback item' }, 500);
  }

  await supabase
    .from('agent_feedback_events')
    .insert({
      item_id: data.id,
      event_type: 'created',
      payload: { type: data.type },
      actor_user_id: actor.userId,
      actor_agent_token_id: actor.agentTokenId,
    });

  return json({ item: data }, 201);
});

router.post('/api/agents/feedback/:id/vote', async (request: IRequest, env: Env) => {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Feedback unavailable' }, 503);
  }
  const actor = await resolveFeedbackActor(request, env, 'feedback:vote', true);
  if (actor.response) return actor.response;
  const { id } = request.params;

  const rlCfg = buildRateLimitConfig(env);
  const ip = getClientIp(request) || 'unknown';
  const ipHash = (await hashString(`ip:${ip}`)).slice(0, 24);
  const actorHash = (await hashString(`actor:${actor.identityType}:${actor.identityValue}`)).slice(0, 24);
  const perMinute = actor.mode === 'anonymous' ? rlCfg.publicVoteRpm : rlCfg.authedRpm;
  const rl = await rateLimitOrRespond(
    request,
    env,
    [
      { key: `feedback_vote:ip:${ipHash}`, limit: perMinute, window_seconds: 60 },
      { key: `feedback_vote:actor:${actorHash}`, limit: perMinute, window_seconds: 60 },
    ],
  );
  if (rl) return rl;

  const supabase = getServiceSupabase(env);
  const { data: item, error: itemError } = await supabase
    .from('agent_feedback_items')
    .select('id,status,allow_upvotes,voting_starts_at,voting_ends_at')
    .eq('id', id)
    .single();
  if (itemError || !item) {
    return json({ error: 'Feedback item not found' }, 404);
  }
  if (item.status !== 'open' || item.allow_upvotes === false) {
    return json({ error: 'Voting closed for this item' }, 403);
  }
  if (!withinWindow(Date.now(), item.voting_starts_at, item.voting_ends_at)) {
    return json({ error: 'Voting window is closed for this item' }, 403);
  }

  const voterHash = await hashString(`${env.POLL_SALT || 'feedback'}:${actor.identityType}:${actor.identityValue}`);
  const { error } = await supabase
    .from('agent_feedback_votes')
    .insert({
      item_id: id,
      voter_hash: voterHash,
      voter_type: actor.identityType,
      voter_user_id: actor.mode === 'user' ? actor.userId : null,
      voter_agent_token_id: actor.mode === 'agent' ? actor.agentTokenId : null,
    });
  if (error) {
    if (error.code === '23505') {
      return json({ error: 'Already voted for this item' }, 409);
    }
    console.error('Feedback vote error', error);
    return json({ error: 'Failed to record vote' }, 500);
  }

  await supabase.rpc('increment_feedback_upvote_count', { feedback_item_id: id });
  const { data: updated } = await supabase
    .from('agent_feedback_items')
    .select('id,upvote_count,voting_ends_at')
    .eq('id', id)
    .single();

  await supabase
    .from('agent_feedback_events')
    .insert({
      item_id: id,
      event_type: 'upvoted',
      payload: { voter_type: actor.identityType },
      actor_user_id: actor.mode === 'user' ? actor.userId : null,
      actor_agent_token_id: actor.mode === 'agent' ? actor.agentTokenId : null,
    });

  return json({ item: updated || { id } });
});

router.post('/api/agents/feedback/:id/link', async (request: IRequest, env: Env) => {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Feedback unavailable' }, 503);
  }
  const actor = await resolveFeedbackActor(request, env, 'feedback:link', false);
  if (actor.response) return actor.response;

  const { id } = request.params;
  const body = await parseJson<{ target_item_id?: string; relation_type?: string }>(request);
  const targetItemId = (body?.target_item_id || '').trim();
  const relationType = (body?.relation_type || 'related_to').trim().toLowerCase();
  if (!targetItemId) return json({ error: 'target_item_id is required' }, 400);
  if (targetItemId === id) return json({ error: 'Cannot link an item to itself' }, 400);
  if (!feedbackRelationTypes.has(relationType)) {
    return json({ error: 'Invalid relation_type' }, 400);
  }

  const supabase = getServiceSupabase(env);
  const { data: items } = await supabase
    .from('agent_feedback_items')
    .select('id')
    .in('id', [id, targetItemId]);
  if (!items || items.length < 2) {
    return json({ error: 'One or both feedback items do not exist' }, 404);
  }

  const { data, error } = await supabase
    .from('agent_feedback_links')
    .insert({
      source_item_id: id,
      target_item_id: targetItemId,
      relation_type: relationType,
      created_by_user_id: actor.userId,
      created_by_agent_token_id: actor.agentTokenId,
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') return json({ error: 'Link already exists' }, 409);
    console.error('Feedback link error', error);
    return json({ error: 'Failed to link feedback items' }, 500);
  }

  await supabase
    .from('agent_feedback_events')
    .insert({
      item_id: id,
      event_type: 'linked',
      payload: { target_item_id: targetItemId, relation_type: relationType },
      actor_user_id: actor.userId,
      actor_agent_token_id: actor.agentTokenId,
    });

  return json({ link: data }, 201);
});

// Create conversation
router.post('/api/conversations', async (request: IRequest, env: Env) => {
  const authHeader = request.headers.get('Authorization') || undefined;
  const bearer = getBearerToken(request);
  const isAgentBearer = !!bearer && bearer.startsWith('mna_');

  let supabase: SupabaseClient;
  let userId: string;
  let agentClaims: AgentTokenClaims | null = null;
  if (isAgentBearer) {
    const agentAuth = await requireAgentTokenScope(request, env, 'conversations:write');
    if (agentAuth.response) return agentAuth.response;
    supabase = getServiceSupabase(env);
    userId = agentAuth.claims!.user_id;
    agentClaims = agentAuth.claims!;
  } else {
    supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: {
        headers: authHeader ? { Authorization: authHeader } : {},
      },
    });
    const user = await getUser(request, supabase);
    if (!user) return json({ error: 'Unauthorized' }, 401);
    userId = user.id;
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

  const normalizedTags = parseTags(body.tags);
  const hasPrivateTag = normalizedTags.includes('private');
  const desiredPublic = body.is_public ?? true;
  const isPublic = hasPrivateTag ? false : desiredPublic;

  const isAgentWrite = !!agentClaims;
  const agentPayloadBytes = isAgentWrite ? estimateConversationPayloadBytes(body) : 0;
  if (isAgentWrite) {
    const policy = buildAgentConversationStoragePolicy(env);
    const usageBase = { itemCount: 0, totalBytes: 0 };
    if (agentPayloadBytes > policy.maxItemBytes) {
      return json(
        buildAgentStorageLimitPayload(
          'agent_storage_item_limit_exceeded',
          'Agent storage limit reached: single item is too large.',
          policy,
          usageBase,
          agentPayloadBytes,
        ),
        413,
      );
    }
    let usage: { itemCount: number; totalBytes: number };
    try {
      usage = await fetchAgentConversationStorageUsage(supabase, userId, policy.maxItems + 1);
    } catch (err) {
      console.error('Agent storage usage query failed', err);
      return json({ error: 'Failed to evaluate agent storage limits' }, 500);
    }
    if (usage.itemCount >= policy.maxItems) {
      return json(
        buildAgentStorageLimitPayload(
          'agent_storage_item_limit_exceeded',
          'Agent storage limit reached: maximum number of stored items exceeded.',
          policy,
          usage,
          agentPayloadBytes,
        ),
        413,
      );
    }
    if (usage.totalBytes + agentPayloadBytes > policy.maxTotalBytes) {
      return json(
        buildAgentStorageLimitPayload(
          'agent_storage_total_limit_exceeded',
          'Agent storage limit reached: total storage bytes exceeded.',
          policy,
          usage,
          agentPayloadBytes,
        ),
        413,
      );
    }
  }

  // Insert conversation
  const { data, error } = await supabase
    .from('conversations')
    .insert({
      user_id: userId,
      title: body.title,
      description: body.description || null,
      platform: body.platform,
      messages: body.messages,
      tags: normalizedTags,
      is_public: isPublic,
      show_author: body.show_author ?? true,
      model_id: body.model_id || null,
      model_display_name: body.model_display_name || null,
      platform_conversation_id: body.platform_conversation_id || null,
      attribution_confidence: body.attribution_confidence || null,
      attribution_source: body.attribution_source || null,
      pii_scanned: body.pii_scanned ?? false,
      pii_redacted: body.pii_redacted ?? false,
      source: isAgentWrite ? 'api' : (body.source || 'web'),
      created_via_agent_auth: isAgentWrite,
      created_by_agent_token_id: agentClaims?.agent_token_id || null,
      created_by_oauth_client_id: agentClaims?.oauth_client_id || null,
      agent_payload_bytes: agentPayloadBytes,
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
  const bearer = getBearerToken(request);
  const isAgentBearer = !!bearer && bearer.startsWith('mna_');

  let supabase: SupabaseClient;
  let userId: string;
  let agentClaims: AgentTokenClaims | null = null;
  if (isAgentBearer) {
    const agentAuth = await requireAgentTokenScope(request, env, 'conversations:write');
    if (agentAuth.response) return agentAuth.response;
    supabase = getServiceSupabase(env);
    userId = agentAuth.claims!.user_id;
    agentClaims = agentAuth.claims!;
  } else {
    supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: {
        headers: authHeader ? { Authorization: authHeader } : {},
      },
    });
    const user = await getUser(request, supabase);
    if (!user) return json({ error: 'Unauthorized' }, 401);
    userId = user.id;
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
  const normalizedTags = parseTags(conv.tags);
  const hasPrivateTag = normalizedTags.includes('private');
  const desiredPublic = conv.is_public ?? true;
  const isPublic = hasPrivateTag ? false : desiredPublic;
  if (!messages.length) {
    return json({ error: 'Missing messages' }, 400);
  }

  const validPlatforms = ['claude', 'chatgpt', 'gemini', 'grok', 'other'];
  if (!validPlatforms.includes(platform)) {
    return json({ error: 'Invalid platform' }, 400);
  }

  const isAgentWrite = !!agentClaims;
  const archiveBody: Partial<CreateConversationBody> = {
    title,
    description: conv.description,
    platform,
    messages,
    tags: normalizedTags,
    model_id: conv.model_id || null,
    model_display_name: conv.model_display_name || null,
    platform_conversation_id: conv.platform_conversation_id || null,
    attribution_confidence: conv.attribution_confidence || null,
    attribution_source: conv.attribution_source || null,
    pii_scanned: conv.pii_scanned ?? true,
    pii_redacted: conv.pii_redacted ?? false,
    source: isAgentWrite ? 'api' : (payload.source || 'extension'),
  };
  const agentPayloadBytes = isAgentWrite ? estimateConversationPayloadBytes(archiveBody) : 0;
  if (isAgentWrite) {
    const policy = buildAgentConversationStoragePolicy(env);
    const usageBase = { itemCount: 0, totalBytes: 0 };
    if (agentPayloadBytes > policy.maxItemBytes) {
      return json(
        buildAgentStorageLimitPayload(
          'agent_storage_item_limit_exceeded',
          'Agent storage limit reached: single item is too large.',
          policy,
          usageBase,
          agentPayloadBytes,
        ),
        413,
      );
    }
    let usage: { itemCount: number; totalBytes: number };
    try {
      usage = await fetchAgentConversationStorageUsage(supabase, userId, policy.maxItems + 1);
    } catch (err) {
      console.error('Agent storage usage query failed', err);
      return json({ error: 'Failed to evaluate agent storage limits' }, 500);
    }
    if (usage.itemCount >= policy.maxItems) {
      return json(
        buildAgentStorageLimitPayload(
          'agent_storage_item_limit_exceeded',
          'Agent storage limit reached: maximum number of stored items exceeded.',
          policy,
          usage,
          agentPayloadBytes,
        ),
        413,
      );
    }
    if (usage.totalBytes + agentPayloadBytes > policy.maxTotalBytes) {
      return json(
        buildAgentStorageLimitPayload(
          'agent_storage_total_limit_exceeded',
          'Agent storage limit reached: total storage bytes exceeded.',
          policy,
          usage,
          agentPayloadBytes,
        ),
        413,
      );
    }
  }

  const { data, error } = await supabase
    .from('conversations')
    .insert({
      user_id: userId,
      title,
      description: conv.description || null,
      platform,
      messages,
      tags: normalizedTags,
      is_public: isPublic,
      show_author: conv.show_author ?? true,
      model_id: conv.model_id || null,
      model_display_name: conv.model_display_name || null,
      platform_conversation_id: conv.platform_conversation_id || null,
      attribution_confidence: conv.attribution_confidence || null,
      attribution_source: conv.attribution_source || null,
      pii_scanned: conv.pii_scanned ?? true,
      pii_redacted: conv.pii_redacted ?? false,
      source: isAgentWrite ? 'api' : (payload.source || 'extension'),
      created_via_agent_auth: isAgentWrite,
      created_by_agent_token_id: agentClaims?.agent_token_id || null,
      created_by_oauth_client_id: agentClaims?.oauth_client_id || null,
      agent_payload_bytes: agentPayloadBytes,
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
    .select('id, user_id, tags')
    .eq('id', id)
    .single();
  if (fetchErr || !existing) return json({ error: 'Conversation not found' }, 404);
  if (existing.user_id !== user.id) return json({ error: 'Forbidden' }, 403);

  const updates: any = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.platform !== undefined) updates.platform = body.platform;
  const existingTags = parseTags((existing as any).tags);
  const nextTags = body.tags !== undefined ? parseTags(body.tags) : existingTags;
  if (body.tags !== undefined) updates.tags = nextTags;
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

  if (hasPrivateTag(nextTags)) {
    // "private" tag always forces non-public visibility.
    updates.is_public = false;
  }

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
  const originParam = (url.searchParams.get('origin') || '').trim().toLowerCase();
  const origin = originParam === 'agent' || originParam === 'human' ? originParam : '';

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
      source,
      created_via_agent_auth
    `,
      { count: 'exact' }
    );

  // Public list only for this endpoint
  query = query.eq('is_public', true);
  // Defense-in-depth: a "private" tag should never be publicly visible even if is_public=true.
  query = query.or('tags.is.null,tags.not.cs.{private}');
  if (origin === 'agent') {
    query = query.eq('created_via_agent_auth', true);
  } else if (origin === 'human') {
    query = query.eq('created_via_agent_auth', false);
  }

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
    const conversationOrigin = c.created_via_agent_auth ? 'agent' : 'human';
    return {
      ...c,
      origin: conversationOrigin,
      messages,
      created_via_agent_auth: undefined,
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
      .or('tags.is.null,tags.not.cs.{private}')
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

  const privateTagged = hasPrivateTag(data.tags);

  // Check if public (and not private-tagged) or owned by user
  const user = await getUser(request, supabase);
  if ((!data.is_public || privateTagged) && data.user_id !== user?.id) {
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
    if (env.SUPABASE_SERVICE_ROLE_KEY) {
      const service = getServiceSupabase(env);
      const { error: viewErr } = await service.rpc('increment_view_count', { conversation_id: id });
      if (viewErr) {
        console.error('increment_view_count failed', viewErr);
      }
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
    let childQuery = supabase
      .from('conversations')
      .select('id, title, created_at, intent_type, user_goal, view_count, root_conversation_id')
      .eq('parent_conversation_id', id)
      .order('created_at', { ascending: true });

    if (data.user_id !== user?.id) {
      childQuery = childQuery.eq('is_public', true).or('tags.is.null,tags.not.cs.{private}');
    }

    const { data: childrenRows, error: childErr } = await childQuery;
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
    .select('id, root_conversation_id, parent_conversation_id, user_id, is_public, tags')
    .eq('id', id)
    .single();

  if (convoErr || !convo) return json({ error: 'Conversation not found' }, 404);

  const viewer = await getUser(request, supabase);
  const isOwner = viewer?.id === convo.user_id;
  const privateTagged = hasPrivateTag((convo as any).tags);
  if (!isOwner && (!convo.is_public || privateTagged)) {
    return json({ error: 'Conversation not found' }, 404);
  }

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
  if (!isOwner) {
    query = query.eq('is_public', true).or('tags.is.null,tags.not.cs.{private}');
  }
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
    if (!isOwner) {
      rootQuery = rootQuery.eq('is_public', true).or('tags.is.null,tags.not.cs.{private}');
    }
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
  const originParam = (url.searchParams.get('origin') || '').trim().toLowerCase();
  const origin = originParam === 'agent' || originParam === 'human' ? originParam : '';

  // If viewing own profile, show all; otherwise only public
  const isOwner = user?.id === userId;

  let query = supabase
    .from('conversations')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (!isOwner) {
    query = query.eq('is_public', true).or('tags.is.null,tags.not.cs.{private}');
  }
  if (origin === 'agent') {
    query = query.eq('created_via_agent_auth', true);
  } else if (origin === 'human') {
    query = query.eq('created_via_agent_auth', false);
  }

  const { data, error } = await query;

  if (error) {
    return json({ error: 'Failed to fetch conversations' }, 500);
  }

  const conversations = (data || []).map((row: any) => ({
    ...row,
    origin: row.created_via_agent_auth ? 'agent' : 'human',
  }));

  return json({ conversations });
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

export class RateLimiter {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method.toUpperCase() !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    let payload: any = null;
    try {
      payload = await request.json();
    } catch {
      payload = null;
    }
    const checks: RateLimitCheck[] = Array.isArray(payload?.checks) ? payload.checks : [];
    if (!checks.length) {
      return new Response(JSON.stringify({ allowed: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const now = Math.floor(Date.now() / 1000);
    let allowed = true;
    let retryAfterSeconds = 0;

    await this.state.blockConcurrencyWhile(async () => {
      for (const check of checks) {
        const key = typeof check?.key === 'string' ? check.key : '';
        const limit = Number(check?.limit || 0);
        const windowSeconds = Number(check?.window_seconds || 0);
        if (!key || !Number.isFinite(limit) || !Number.isFinite(windowSeconds) || limit <= 0 || windowSeconds <= 0) {
          continue;
        }

        const bucket = Math.floor(now / windowSeconds);
        const storageKey = `rl:${key}:${bucket}`;
        const existingCount = await this.state.storage.get<number>(storageKey);
        const nextCount = (typeof existingCount === 'number' ? existingCount : 0) + 1;
        await this.state.storage.put(storageKey, nextCount);

        // Best-effort cleanup of older buckets for this key (keeps storage bounded per key).
        if (bucket > 2) {
          void this.state.storage.delete(`rl:${key}:${bucket - 2}`);
        }

        if (nextCount > limit) {
          allowed = false;
          const bucketEnd = (bucket + 1) * windowSeconds;
          retryAfterSeconds = Math.max(retryAfterSeconds, Math.max(0, bucketEnd - now));
        }
      }
    });

    return new Response(JSON.stringify({ allowed, retry_after_seconds: retryAfterSeconds || null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Main export
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await router.handle(request, env);
    } catch (error) {
      console.error('Unhandled worker error', error);
      response = json({ error: 'Internal server error' }, 500);
    }

    try {
      await logAgentTelemetry(request as IRequest, response, env, Date.now() - startedAt);
    } catch (telemetryError) {
      console.error('Telemetry logging failure', telemetryError);
    }

    return response;
  },
};
