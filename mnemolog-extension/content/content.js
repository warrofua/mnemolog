// Mnemolog Chrome Extension - Content Script

class MnemologExtractor {
  constructor() {
    this.platform = null;
    this.platformExtractor = null;
    this.cachedData = null;
    
    this.init();
  }
  
  init() {
    // Determine platform and set up extractor
    this.platform = this.detectPlatform();
    
    if (this.platform && window.MnemologPlatform) {
      this.platformExtractor = window.MnemologPlatform;
    }
    
    // Listen for messages from popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'getConversationData') {
        this.getConversationData().then(sendResponse);
        return true; // Keep channel open for async response
      }
    });
    
    // Watch for navigation/conversation changes
    this.observeChanges();
  }
  
  detectPlatform() {
    const url = window.location.href;
    
    if (url.includes('claude.ai')) return 'claude';
    if (url.includes('chat.openai.com') || url.includes('chatgpt.com')) return 'chatgpt';
    if (url.includes('gemini.google.com')) return 'gemini';
    if (url.includes('x.com/i/grok') || url.includes('grok.x.ai') || url.includes('grok.com')) return 'grok';
    
    return null;
  }
  
  async getConversationData() {
    if (!this.platformExtractor) {
      return { success: false, error: 'No extractor available' };
    }
    
    try {
      const data = await this.platformExtractor.extract();
      
      if (data) {
        this.cachedData = data;
        return { success: true, data };
      }
      
      return { success: false, error: 'No conversation found' };
      
    } catch (error) {
      console.error('Extraction error:', error);
      return { success: false, error: error.message };
    }
  }
  
  observeChanges() {
    // Clear cache when URL changes (new conversation)
    let lastUrl = window.location.href;
    
    const observer = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        this.cachedData = null;
      }
    });
    
    observer.observe(document.body, { 
      childList: true, 
      subtree: true 
    });
  }
  
}

// Initialize
new MnemologExtractor();
