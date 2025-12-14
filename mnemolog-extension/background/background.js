// Mnemolog Chrome Extension - Background Service Worker

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'archiveConversation':
      handleArchive(request.data).then(sendResponse);
      return true;
      
    case 'getAuthToken':
      getAuthToken().then(sendResponse);
      return true;

    case 'refreshAuthFromSite':
      refreshAuthFromSite().then(sendResponse);
      return true;

    case 'sessionUpdate':
      if (request.session) {
        chrome.storage.sync.set({ mnemologAuth: request.session }, () => sendResponse({ success: true }));
        return true;
      }
      sendResponse({ success: false });
      return true;
    
    case 'getSupabaseSessionFromTab':
      // Try to query a specific tab for session
      if (sender?.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, { action: 'getSupabaseSession' })
          .then(resp => sendResponse(resp))
          .catch(() => sendResponse({ error: 'no-session' }));
        return true;
      }
      sendResponse({ error: 'no-tab' });
      return true;
      
    case 'openMnemolog':
      chrome.tabs.create({ url: request.url || 'https://mnemolog.com' });
      break;
  }
});

// Archive conversation to Mnemolog
async function handleArchive(data) {
  try {
    // Get auth token if user is logged in
    const auth = await getAuthToken();
    
    const response = await fetch('https://mnemolog.com/api/archive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth?.token && { 'Authorization': `Bearer ${auth.token}` })
      },
      body: JSON.stringify({
        conversation: data,
        source: 'extension',
        version: chrome.runtime.getManifest().version
      })
    });
    
    if (!response.ok) {
      throw new Error(`Archive failed: ${response.status}`);
    }
    
    const result = await response.json();
    
    // Track successful archive
    await trackEvent('archive_success', {
      platform: data.platform,
      messageCount: data.messages?.length || 0
    });
    
    return { success: true, ...result };
    
  } catch (error) {
    console.error('[Mnemolog] Archive error:', error);
    
    await trackEvent('archive_error', {
      error: error.message,
      platform: data?.platform
    });
    
    return { success: false, error: error.message };
  }
}

// Get stored auth token
async function getAuthToken() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['mnemologAuth'], (result) => {
      resolve(result.mnemologAuth || null);
    });
  });
}

// Try to fetch Supabase session from an open mnemolog.com tab
async function refreshAuthFromSite() {
  const tabs = await chrome.tabs.query({ url: ['*://mnemolog.com/*', '*://*.mnemolog.com/*', '*://mnemolog.pages.dev/*', '*://*.mnemolog.pages.dev/*'] });
  for (const tab of tabs) {
    try {
      let resp = await chrome.tabs.sendMessage(tab.id, { action: 'getSupabaseSession' });
      // If content script isn't present (e.g., tab opened before install), inject and retry once
      if (!resp || resp.error === 'no-listener') {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/auth.js']
          });
          resp = await chrome.tabs.sendMessage(tab.id, { action: 'getSupabaseSession' });
        } catch (e) {
          // ignore injection errors and continue
        }
      }
      if (resp?.session?.token) {
        await new Promise(res => chrome.storage.sync.set({ mnemologAuth: resp.session }, res));
        return { success: true, session: resp.session };
      }
    } catch {
      // Ignore per-tab errors
    }
  }
  return { success: false };
}

// Simple analytics (privacy-respecting)
async function trackEvent(eventName, properties = {}) {
  // Only track if user has opted in
  const settings = await getSettings();
  if (!settings.analyticsEnabled) return;
  
  // Send minimal, anonymous event
  try {
    await fetch('https://mnemolog.com/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: eventName,
        properties: {
          ...properties,
          extensionVersion: chrome.runtime.getManifest().version
        },
        timestamp: new Date().toISOString()
      })
    });
  } catch {
    // Silently fail - analytics should never break functionality
  }
}

// Get extension settings
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['mnemologSettings'], (result) => {
      resolve(result.mnemologSettings || {
        analyticsEnabled: false,
        autoDetect: true,
        showFloatingButton: true,
        runPiiScan: true,
        alwaysRedact: false,
        defaultVisibility: 'public',
        defaultShowAuthor: true
      });
    });
  });
}

// Handle extension install/update
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Open onboarding page
    chrome.tabs.create({ 
      url: 'https://mnemolog.com/extension/welcome' 
    });
    
    // Set default settings
    chrome.storage.sync.set({
      mnemologSettings: {
        analyticsEnabled: false,
        autoDetect: true,
        showFloatingButton: true,
        runPiiScan: true,
        alwaysRedact: false,
        defaultVisibility: 'public',
        defaultShowAuthor: true
      }
    });
  }
  
  if (details.reason === 'update') {
    console.log('[Mnemolog] Extension updated to', chrome.runtime.getManifest().version);
  }
});

// Handle action click (toolbar icon)
chrome.action.onClicked.addListener((tab) => {
  // Popup handles this, but fallback if popup fails
  if (tab.url.includes('claude.ai') || 
      tab.url.includes('chatgpt.com') || 
      tab.url.includes('chat.openai.com') ||
      tab.url.includes('gemini.google.com') ||
      tab.url.includes('x.com/i/grok') ||
      tab.url.includes('grok.x.ai') ||
      tab.url.includes('grok.com')) {
    // Inject content script if not already present
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content.js']
    }).catch(() => {
      // Already injected, ignore
    });
  }
});

console.log('[Mnemolog] Background service worker initialized');
