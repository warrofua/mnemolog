// Content script on mnemolog.com to expose Supabase session to the extension

function extractSupabaseSession() {
  try {
    const keys = Object.keys(localStorage).filter(k => /^sb-.*-auth-token$/.test(k));
    if (!keys.length) return null;
    const raw = localStorage.getItem(keys[0]);
    if (!raw) return null;
    const session = JSON.parse(raw);

    // Modern Supabase structure
    if (session.access_token && session.refresh_token) {
      return {
        token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at || (session.expires_in ? Math.floor(Date.now() / 1000) + session.expires_in : null)
      };
    }

    // Fallback for older structure
    if (session.currentSession?.access_token) {
      const cs = session.currentSession;
      return {
        token: cs.access_token,
        refresh_token: cs.refresh_token,
        expires_at: cs.expires_at
      };
    }

    return null;
  } catch (e) {
    console.warn('[Mnemolog] Failed to extract Supabase session', e);
    return null;
  }
}

// Respond to explicit requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getSupabaseSession') {
    const session = extractSupabaseSession();
    sendResponse(session ? { session } : { error: 'no-session' });
    return true; // async channel stays open
  }
});

// On load, proactively send session if available
const session = extractSupabaseSession();
if (session) {
  chrome.runtime.sendMessage({ action: 'sessionUpdate', session });
}
