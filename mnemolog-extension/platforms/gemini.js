// Mnemolog Platform Extractor - Gemini

window.MnemologPlatform = {
  platform: 'gemini',
  
  async extract() {
    const data = {
      platform: 'gemini',
      model: await this.extractModel(),
      title: this.extractTitle(),
      messages: this.extractMessages(),
      timestamp: this.extractTimestamp(),
      conversationId: this.extractConversationId(),
      attribution: {
        confidence: 'inferred',
        source: 'dom_scrape'
      }
    };
    
    return data;
  },
  
  async extractModel() {
    // Gemini model indicators
    const modelSelectors = [
      '[data-model-id]',
      '[class*="model-selector"]',
      'button[aria-label*="model"]'
    ];
    
    for (const selector of modelSelectors) {
      const el = document.querySelector(selector);
      const modelId = el?.getAttribute('data-model-id');
      const text = el?.textContent?.trim();
      
      if (modelId) {
        return {
          displayName: text || modelId,
          id: modelId,
          source: 'data_attribute'
        };
      }
      
      if (this.isModelName(text)) {
        return {
          displayName: text,
          id: this.modelDisplayToId(text),
          source: 'dom_scrape'
        };
      }
    }
    
    // Check URL for model hints
    if (window.location.href.includes('advanced')) {
      return {
        displayName: 'Gemini Advanced',
        id: 'gemini-1.5-pro',
        source: 'url_inferred'
      };
    }
    
    return {
      displayName: 'Gemini',
      id: 'gemini-1.5-flash',
      source: 'default'
    };
  },
  
  isModelName(text) {
    if (!text) return false;
    return /gemini|ultra|pro|flash|advanced/i.test(text);
  },
  
  modelDisplayToId(displayName) {
    const mappings = {
      'gemini advanced': 'gemini-1.5-pro',
      'gemini ultra': 'gemini-ultra',
      'gemini pro': 'gemini-1.5-pro',
      'gemini flash': 'gemini-1.5-flash',
      'gemini 2.0': 'gemini-2.0-flash'
    };
    
    const normalized = displayName.toLowerCase().trim();
    
    for (const [key, id] of Object.entries(mappings)) {
      if (normalized.includes(key)) return id;
    }
    
    return 'gemini-1.5-flash';
  },
  
  extractTitle() {
    // Gemini conversation title
    const titleSelectors = [
      '[data-conversation-title]',
      'h1',
      '[class*="title"]'
    ];
    
    for (const selector of titleSelectors) {
      const el = document.querySelector(selector);
      const text = el?.textContent?.trim();
      if (text && text.length > 0 && text.length < 200 && !text.includes('Gemini')) {
        return text;
      }
    }
    
    return 'Untitled Conversation';
  },
  
  extractMessages() {
    const messages = [];

    // Assistant responses: message-content nodes with markdown
    const assistantBlocks = document.querySelectorAll('message-content.model-response-text, message-content .markdown');
    assistantBlocks.forEach((node, idx) => {
      const content = node.textContent?.trim();
      if (content) messages.push({ role: 'assistant', content, index: idx + 1000 });
    });

    // User prompts: prompt chips or textarea value
    const userBlocks = Array.from(document.querySelectorAll('[data-test-id="prompt-text"], [data-test-id="chip-text"]'));
    const textareas = Array.from(document.querySelectorAll('textarea[aria-label]'));
    userBlocks.concat(textareas).forEach((node, idx) => {
      const content = node.textContent?.trim() || node.value?.trim();
      if (content) messages.push({ role: 'human', content, index: idx });
    });

    messages.sort((a, b) => a.index - b.index);

    if (messages.length > 1 && messages.every(m => m.role === 'assistant')) {
      messages.forEach((m, i) => { if (i % 2 === 0) m.role = 'human'; });
    }

    return messages.filter(m => m.content);
  },
  
  extractTimestamp() {
    return new Date().toISOString();
  },
  
  extractConversationId() {
    // Gemini URL patterns
    const urlMatch = window.location.href.match(/\/c\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) return urlMatch[1];
    
    return null;
  }
};
