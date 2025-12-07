// Mnemolog Frontend JS

// Initialize Supabase client
let supabase;

async function initSupabase() {
  if (supabase) return supabase;
  
  // Dynamically load Supabase if not already loaded
  if (!window.supabase) {
    await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
  }
  
  supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  return supabase;
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
    const { data: profile } = await sb
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .single();
    
    if (profile) {
      currentUser.profile = profile;
    }
  }
  
  updateAuthUI();
  return currentUser;
}

// Update UI based on auth state
function updateAuthUI() {
  const authButtons = document.querySelectorAll('.auth-buttons');
  const userMenus = document.querySelectorAll('.user-menu');
  
  authButtons.forEach(el => {
    el.style.display = currentUser ? 'none' : 'flex';
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

// Get single conversation
async function getConversation(id) {
  return apiRequest(`/api/conversations/${id}`);
}

// Delete conversation
async function deleteConversation(id) {
  return apiRequest(`/api/conversations/${id}`, {
    method: 'DELETE',
  });
}

// Parse conversation text into messages
function parseConversation(text, platform) {
  const lines = text.split('\n');
  const messages = [];
  let currentMessage = null;

  // Platform-specific patterns
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
      
      // Remove the prefix
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

  // Trim content
  messages.forEach(m => {
    m.content = m.content.trim();
  });

  // Filter empty messages
  return messages.filter(m => m.content.length > 0);
}

// Detect sensitive information
function detectSensitiveInfo(text) {
  const patterns = [
    { pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, type: 'phone number' },
    { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, type: 'email' },
    { pattern: /\b\d{3}[-]?\d{2}[-]?\d{4}\b/g, type: 'possible SSN' },
    { pattern: /\b\d{1,5}\s+\w+\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|boulevard|blvd)\b/gi, type: 'address' },
    { pattern: /\b\d{16}\b/g, type: 'possible card number' },
    { pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, type: 'possible card number' },
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
  getConversation,
  deleteConversation,
  parseConversation,
  detectSensitiveInfo,
  formatDate,
  platformNames,
  get currentUser() { return currentUser; },
  get isLoggedIn() { return !!currentUser; },
};

// Build header HTML (single source of truth for all pages)
function buildHeaderHTML() {
  const isSharePage = window.location.pathname.startsWith('/share');
  const shareCta = isSharePage ? '' : `
    <a href="/share" class="btn btn-primary share-cta">Share <span class="desktop-only">a Conversation</span><span class="mobile-only"> Now</span></a>
  `;
  return `
    <nav>
      <div class="nav-left">
        <a href="/" class="logo">mnemo<span>log</span></a>
      </div>
      <div class="nav-center">
        ${shareCta}
      </div>
      <div class="nav-right">
        <div class="nav-dropdown">
          <div class="nav-links">
            <a href="/explore">Explore</a>
            <a href="/#about">About</a>
            <a href="/faq">FAQ</a>
            <a href="/profile">Profile</a>
          </div>
          <div class="nav-actions">
            <div class="auth-buttons">
              <button class="auth-button" onclick="mnemolog.signInWith('google')">Google</button>
              <button class="auth-button" onclick="mnemolog.signInWith('github')">GitHub</button>
              <button class="auth-button" onclick="mnemolog.signInWith('email')">Email</button>
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
    button.addEventListener('click', () => {
      dropdown.classList.toggle('active');
    });
  });
}

// Initialize header + auth when DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  injectHeader();
  setupMobileMenus();
  await checkAuth();
});
