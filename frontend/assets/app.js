// Mnemolog Frontend JS

// Theme handling (apply stored preference early)
const THEME_KEY = 'mnemolog-theme';

function applyTheme(mode, persist = false) {
  const root = document.documentElement;
  const enableDark = mode === 'dark';
  if (enableDark) {
    root.setAttribute('data-theme', 'dark');
    document.body?.classList.add('dark-mode');
  } else {
    root.removeAttribute('data-theme');
    document.body?.classList.remove('dark-mode');
  }
  if (persist) {
    localStorage.setItem(THEME_KEY, enableDark ? 'dark' : 'light');
  }
}

(function initStoredTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark') {
      applyTheme('dark', false);
    }
  } catch (e) {
    console.warn('Theme init failed', e);
  }
})();

// Initialize Supabase client
let supabaseClient;

async function initSupabase() {
  if (supabaseClient) return supabaseClient;
  
  // Dynamically load Supabase if not already loaded
  if (!window.supabase) {
    await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
  }
  
  supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  return supabaseClient;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// Auth state
let currentUser = null;
let currentSession = null;

// Check auth status on page load
async function checkAuth() {
  const sb = await initSupabase();
  const { data: { session } } = await sb.auth.getSession();
  
  if (session) {
    currentSession = session;
    currentUser = session.user;
    
    // Get profile
    try {
      const { data: profile } = await sb
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .single();
      if (profile) {
        currentUser.profile = profile;
      }
    } catch (err) {
      console.warn('Profile fetch failed', err);
    }
  }
  
  updateAuthUI();
  return currentUser;
}

// Update UI based on auth state
function updateAuthUI() {
  const authButtons = document.querySelectorAll('.auth-buttons');
  const authToggles = document.querySelectorAll('[data-auth-toggle]');
  const userMenus = document.querySelectorAll('.user-menu');
  const isMobile = window.matchMedia('(max-width: 600px)').matches;
  
  authButtons.forEach(el => {
    // Default desktop: visible; mobile: collapsed when logged out
    if (currentUser) {
      el.classList.remove('collapsed');
      el.style.setProperty('display', 'none', 'important');
    } else if (isMobile) {
      el.classList.add('collapsed');
      el.style.removeProperty('display');
    } else {
      el.classList.remove('collapsed');
      el.style.removeProperty('display');
    }
  });
  
  authToggles.forEach(btn => {
    if (currentUser || !isMobile) {
      btn.style.display = 'none';
      btn.onclick = null;
      return;
    }
    btn.style.display = '';
    btn.onclick = () => {
      document.querySelectorAll('.auth-buttons').forEach(el => el.classList.toggle('collapsed'));
    };
  });
  
  userMenus.forEach(el => {
    el.style.display = currentUser ? 'flex' : 'none';
    if (currentUser) {
      const avatar = el.querySelector('.user-avatar');
      const name = el.querySelector('.user-name');
      if (avatar && currentUser.profile?.avatar_url) {
        avatar.src = currentUser.profile.avatar_url;
      }
      if (name) {
        name.textContent = currentUser.profile?.display_name || currentUser.email;
      }
    }
  });
}

// Sign in with provider
async function signInWith(provider) {
  const sb = await initSupabase();

  const { error } = await sb.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: window.location.origin + '/auth/callback',
    },
  });
  
  if (error) {
    console.error('Sign in error:', error);
    alert('Failed to sign in. Please try again.');
  }
}

// Sign out
async function signOut() {
  const sb = await initSupabase();
  await sb.auth.signOut();
  currentUser = null;
  currentSession = null;
  updateAuthUI();
  window.location.href = '/';
}

// API helpers
async function apiRequest(endpoint, options = {}) {
  const url = CONFIG.API_URL + endpoint;
  
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  
  // Add auth header if logged in
  if (currentSession?.access_token) {
    headers['Authorization'] = `Bearer ${currentSession.access_token}`;
  }
  
  const response = await fetch(url, {
    ...options,
    headers,
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.error || 'API request failed');
  }
  
  return data;
}

// Create conversation
async function createConversation(data) {
  return apiRequest('/api/conversations', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// Get conversations
async function getConversations(params = {}) {
  const query = new URLSearchParams(params).toString();
  return apiRequest(`/api/conversations${query ? '?' + query : ''}`);
}

// Get conversations for a specific user (owner)
async function getUserConversations(userId, params = {}) {
  if (!userId) throw new Error('userId is required');
  const query = new URLSearchParams(params).toString();
  return apiRequest(`/api/users/${userId}/conversations${query ? '?' + query : ''}`);
}

// Get single conversation
async function getConversation(id) {
  return apiRequest(`/api/conversations/${id}`);
}

// Chat: send a follow-up message and get AI reply
async function sendChatMessage(conversationId, content) {
  const res = await apiRequest(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
  return res;
}

// Continue a conversation via Supabase Edge Function
async function continueConversation(conversationId, { mode = 'continue', user_goal } = {}) {
  if (!CONFIG.SUPABASE_URL) throw new Error('Missing SUPABASE_URL in config');
  const headers = { 'Content-Type': 'application/json' };
  if (currentSession?.access_token) {
    headers['Authorization'] = `Bearer ${currentSession.access_token}`;
  }
  const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/continue`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ conversation_id: conversationId, mode, user_goal }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to continue conversation');
  }
  return data;
}

// Update conversation (title, description, tags, visibility, etc.)
async function updateConversation(id, updates) {
  return apiRequest(`/api/conversations/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

// Delete conversation
async function deleteConversation(id) {
  return apiRequest(`/api/conversations/${id}`, {
    method: 'DELETE',
  });
}

// Update profile (display_name, bio, website)
async function updateProfile(updates) {
  const sb = await initSupabase();
  const { data, error } = await sb
    .from('profiles')
    .update(updates)
    .eq('id', currentUser?.id)
    .select()
    .single();

  if (error) {
    throw error;
  }

  if (currentUser) {
    currentUser.profile = { ...currentUser.profile, ...data };
  }

  return data;
}

// Parse conversation text into messages (delegates to shared parser if present)
function parseConversation(text, platform, overrideFirstSpeaker) {
  if (window.mnemologParsers?.parseConversation) {
    const { messages } = window.mnemologParsers.parseConversation(text, platform, overrideFirstSpeaker);
    return messages;
  }

  // Fallback: simple label-based parser
  const lines = text.split('\n');
  const messages = [];
  let currentMessage = null;

  const patterns = {
    claude: {
      human: [/^(Human|H):\s*/i, /^You:\s*/i],
      assistant: [/^(Assistant|Claude|A):\s*/i],
    },
    chatgpt: {
      human: [/^(You|User|Human):\s*/i],
      assistant: [/^(ChatGPT|Assistant|GPT):\s*/i],
    },
    gemini: {
      human: [/^(You|User):\s*/i],
      assistant: [/^(Gemini|Model):\s*/i],
    },
    grok: {
      human: [/^(You|User):\s*/i],
      assistant: [/^(Grok):\s*/i],
    },
    other: {
      human: [/^(Human|User|You|Me|H):\s*/i],
      assistant: [/^(Assistant|AI|Bot|A):\s*/i],
    },
  };

  const { human: humanPatterns, assistant: assistantPatterns } = patterns[platform] || patterns.other;

  lines.forEach(line => {
    const isHuman = humanPatterns.some(p => p.test(line));
    const isAssistant = assistantPatterns.some(p => p.test(line));

    if (isHuman || isAssistant) {
      if (currentMessage) {
        messages.push(currentMessage);
      }
      
      let content = line;
      [...humanPatterns, ...assistantPatterns].forEach(p => {
        content = content.replace(p, '');
      });
      
      currentMessage = {
        role: isHuman ? 'human' : 'assistant',
        content: content.trim(),
      };
    } else if (currentMessage) {
      currentMessage.content += '\n' + line;
    }
  });

  if (currentMessage) {
    messages.push(currentMessage);
  }

  messages.forEach(m => {
    m.content = m.content.trim();
  });

  return messages.filter(m => m.content.length > 0);
}

// Detect sensitive information
function detectSensitiveInfo(text) {
  const patterns = [
    // Phone numbers: (123) 456-7890, 123-456-7890, 123.456.7890, 1234567890, 555-0123
    { pattern: /\b\+?\d{1,2}[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, type: 'phone number' },
    { pattern: /\b\d{3}[-.\s]?\d{4}\b/g, type: 'phone number' }, // 7-digit fallback
    { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, type: 'email' },
    { pattern: /\b\d{3}[-]?\d{2}[-]?\d{4}\b/g, type: 'possible SSN' },
    { pattern: /\b\d{1,5}\s+\w+\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|boulevard|blvd)\b/gi, type: 'address' },
    { pattern: /\b\d{16}\b/g, type: 'possible card number' },
    { pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, type: 'possible card number' },
    { pattern: /\b(?:card|visa|mastercard|amex|card number)\b/gi, type: 'card reference' },
    // API keys / secrets (common prefixes)
    { pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/g, type: 'possible API key' },
    { pattern: /\bsk_test_[A-Za-z0-9]{20,}\b/g, type: 'possible API key' },
    { pattern: /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g, type: 'possible API key' }, // Slack
    { pattern: /\bAIza[0-9A-Za-z\-_]{30,}\b/g, type: 'possible API key' }, // Google
    { pattern: /\bpk_live_[A-Za-z0-9]{20,}\b/g, type: 'possible API key' }, // Stripe publishable
    { pattern: /\bghp_[A-Za-z0-9]{20,}\b/g, type: 'possible API key' }, // GitHub
    // Credit card CVC (basic 3–4 digit near card keywords)
    { pattern: /\b(?:cvc|cvv|csc)\s*[:=]?\s*\d{3,4}\b/gi, type: 'possible CVC' },
    // Names/titles flagged explicitly
    { pattern: /\bName\b/gi, type: 'name' },
    { pattern: /\bFull\s+Name\b/gi, type: 'name' },
    { pattern: /\bAccount\s+Name\b/gi, type: 'name' },
  ];

  const flags = [];

  patterns.forEach(({ pattern, type }) => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      flags.push({
        text: match[0],
        type,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  });

  return flags;
}

// Format date
function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return 'Today';
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }
}

// Bookmarks (server-side)
let bookmarksCache = null;

async function ensureBookmarks() {
  if (!currentUser) {
    bookmarksCache = [];
    return bookmarksCache;
  }
  if (bookmarksCache === null) {
    try {
      const { conversations = [] } = await apiRequest('/api/bookmarks');
      bookmarksCache = conversations.map(c => c.id);
    } catch (e) {
      bookmarksCache = [];
    }
  }
  return bookmarksCache;
}

async function isBookmarked(id) {
  const list = await ensureBookmarks();
  return list.includes(id);
}

async function toggleBookmark(id) {
  if (!currentUser) {
    throw new Error('Please sign in to save bookmarks');
  }
  const list = await ensureBookmarks();
  if (list.includes(id)) {
    await apiRequest(`/api/bookmarks/${id}`, { method: 'DELETE' });
    bookmarksCache = list.filter(x => x !== id);
  } else {
    await apiRequest('/api/bookmarks', { method: 'POST', body: JSON.stringify({ conversation_id: id }) });
    bookmarksCache = [...list, id];
  }
  return bookmarksCache;
}

async function fetchBookmarkedConversations() {
  if (!currentUser) return [];
  try {
    const { conversations = [] } = await apiRequest('/api/bookmarks');
    bookmarksCache = conversations.map(c => c.id);
    return conversations;
  } catch (e) {
    return [];
  }
}


// Platform display names
const platformNames = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  grok: 'Grok',
  other: 'Other',
};

// Export for use in HTML
window.mnemolog = {
  CONFIG,
  checkAuth,
  signInWith,
  signOut,
  createConversation,
  getConversations,
  getUserConversations,
  getConversation,
  sendChatMessage,
  continueConversation,
  updateConversation,
  deleteConversation,
  parseConversation,
  detectSensitiveInfo,
  formatDate,
  platformNames,
  isContinuation: (conv) => !!(conv?.parent_conversation_id || (conv?.root_conversation_id && conv.root_conversation_id !== conv.id)),
  setTheme: (mode) => applyTheme(mode, true),
  getTheme: () => (localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'),
  updateProfile,
  get currentUser() { return currentUser; },
  get currentSession() { return currentSession; },
  get isLoggedIn() { return !!currentUser; },
  // Bookmarks helpers
  ensureBookmarks,
  toggleBookmark,
  isBookmarked,
  fetchBookmarkedConversations,
};

// Build header HTML (single source of truth for all pages)
function buildHeaderHTML() {
  const isSharePage = window.location.pathname.startsWith('/share');
  const shareCta = isSharePage ? '' : `
    <a href="/share" class="btn btn-primary share-cta">Share <span class="desktop-only">a Conversation</span><span class="mobile-only"> Now</span></a>
  `;
  const currentTheme = (localStorage.getItem('mnemolog-theme') === 'dark') ? 'dark' : 'light';
  return `
    <nav>
      <div class="nav-left">
        <a href="/" class="logo">
          <img src="/assets/mnemolog-fav-icon.svg" alt="Mnemolog" class="brand-mark" width="26" height="26" style="width:26px;height:26px;border-radius:50%;object-fit:contain;">
          nemo<span>log</span>
        </a>
      </div>
      <div class="nav-center">
        ${shareCta}
        <label class="theme-toggle desktop-only" style="margin-left:0;">
          <input type="checkbox" id="global-theme-toggle" ${currentTheme === 'dark' ? 'checked' : ''}>
          <span style="font-size:0.85rem;color:var(--text-secondary);">Dark mode</span>
        </label>
      </div>
      <div class="nav-right">
        <div class="nav-dropdown">
          <div class="nav-links">
            <a href="/profile">Your Archive</a>
            <a href="/explore">Explore</a>
            <a href="/api">API</a>
            <a href="/#about">About</a>
            <a href="/faq">FAQ</a>
          </div>
          <div class="nav-actions">
            <button class="auth-toggle" data-auth-toggle type="button">Sign in</button>
            <div class="auth-buttons collapsed">
              <span class="auth-label desktop-only">Sign in with:</span>
              <div class="auth-provider-buttons">
                <button class="auth-button" onclick="mnemolog.signInWith('google')">Google</button>
                <button class="auth-button" onclick="mnemolog.signInWith('github')">GitHub</button>
              </div>
            </div>
            <div class="user-menu">
              <details>
              <summary>
                <img class="user-avatar" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='22' r='14' fill='%23E5DFD5'/%3E%3Ccircle cx='32' cy='48' r='20' fill='%23E5DFD5'/%3E%3C/svg%3E" alt="User avatar">
                <span class="user-name">Signed in</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </summary>
              <div class="user-dropdown">
                <button type="button" onclick="mnemolog.signOut()">Sign out</button>
              </div>
            </details>
          </div>
          <label class="theme-toggle mobile-only">
            <input type="checkbox" id="global-theme-toggle-mobile" style="transform: translateY(-1px);" ${currentTheme === 'dark' ? 'checked' : ''}>
            <span style="font-size:0.9rem;color:var(--text-secondary);">Dark mode</span>
          </label>
        </div>
        </div>
        <button class="mobile-menu-button" aria-label="Toggle menu">
          <span></span><span></span><span></span>
        </button>
      </div>
    </nav>
  `;
}

// Inject header into placeholder if present
function injectHeader() {
  const target = document.getElementById('site-header');
  if (!target) return;
  target.innerHTML = buildHeaderHTML();
}

// Wire up mobile menu toggle
function setupMobileMenus() {
  document.querySelectorAll('.mobile-menu-button').forEach(button => {
    const nav = button.closest('nav');
    const dropdown = nav?.querySelector('.nav-dropdown');
    if (!dropdown) return;
    const toggleMenu = (event) => {
      if (event) event.preventDefault();
      dropdown.classList.toggle('active');
      button.classList.toggle('active');
    };
    button.addEventListener('click', toggleMenu);
    button.addEventListener('touchstart', toggleMenu, { passive: false });
  });
}

// Wire up global theme toggle in header if present
function setupThemeToggle() {
  const toggle = document.getElementById('global-theme-toggle');
  if (!toggle) return;
  toggle.onchange = (e) => {
    const mode = e.target.checked ? 'dark' : 'light';
    if (window.mnemolog?.setTheme) {
      window.mnemolog.setTheme(mode);
    } else {
      applyTheme(mode, true);
    }
  };
  const mobileToggle = document.getElementById('global-theme-toggle-mobile');
  if (mobileToggle) {
    mobileToggle.onchange = (e) => {
      const mode = e.target.checked ? 'dark' : 'light';
      if (window.mnemolog?.setTheme) {
        window.mnemolog.setTheme(mode);
      } else {
        applyTheme(mode, true);
      }
      // keep both toggles in sync
      if (toggle && toggle.checked !== mobileToggle.checked) {
        toggle.checked = mobileToggle.checked;
      }
    };
  }
}

// Initialize header + auth when DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  injectHeader();
  setupMobileMenus();
  setupThemeToggle();
  await checkAuth();
});
