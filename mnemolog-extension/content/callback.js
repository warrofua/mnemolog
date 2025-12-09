// Callback handler for mnemolog.com auth pages when source=extension
// Reads Supabase session from localStorage and posts it to the extension.

function extractSupabaseSession() {
  try {
    const keys = Object.keys(localStorage).filter(k => /^sb-.*-auth-token$/.test(k));
    if (!keys.length) return null;
    const raw = localStorage.getItem(keys[0]);
    if (!raw) return null;
    const session = JSON.parse(raw);

    if (session.access_token && session.refresh_token) {
      return {
        token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at || (session.expires_in ? Math.floor(Date.now() / 1000) + session.expires_in : null)
      };
    }

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
    console.warn('[Mnemolog] Callback: failed to extract session', e);
    return null;
  }
}

function sendSessionIfNeeded() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('source') !== 'extension') return;

  const session = extractSupabaseSession();
  if (session) {
    chrome.runtime.sendMessage({ action: 'sessionUpdate', session });
  }
}

sendSessionIfNeeded();
