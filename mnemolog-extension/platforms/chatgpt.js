// Mnemolog Platform Extractor - ChatGPT

window.MnemologPlatform = {
  platform: 'chatgpt',
  
  async extract() {
    const data = {
      platform: 'chatgpt',
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
    // ChatGPT model selectors
    const modelSelectors = [
      '[data-testid="model-switcher"]',
      'button[class*="model"]',
      '[class*="ModelSelector"]'
    ];
    
    for (const selector of modelSelectors) {
      const el = document.querySelector(selector);
      const text = el?.textContent?.trim();
      if (this.isModelName(text)) {
        return {
          displayName: text,
          id: this.modelDisplayToId(text),
          source: 'dom_scrape'
        };
      }
    }
    
    // Check localStorage for model preference
    try {
      const stored = localStorage.getItem('oai/selectedModel');
      if (stored) {
        const parsed = JSON.parse(stored);
        return {
          displayName: parsed.title || parsed.slug,
          id: parsed.slug,
          source: 'local_storage'
        };
      }
    } catch {
      // Ignore
    }
    
    return {
      displayName: 'GPT-4',
      id: 'gpt-4',
      source: 'default'
    };
  },
  
  isModelName(text) {
    if (!text) return false;
    return /gpt|o1|4o|turbo/i.test(text);
  },
  
  modelDisplayToId(displayName) {
    const mappings = {
      'gpt-4o': 'gpt-4o',
      'gpt-4': 'gpt-4',
      'gpt-4 turbo': 'gpt-4-turbo',
      'o1': 'o1-preview',
      'o1-mini': 'o1-mini'
    };
    
    const normalized = displayName.toLowerCase().trim();
    return mappings[normalized] || normalized;
  },
  
  extractTitle() {
    // ChatGPT conversation title
    const titleSelectors = [
      '[data-testid="conversation-title"]',
      'h1',
      '.conversation-title',
      'nav a.active'
    ];
    
    for (const selector of titleSelectors) {
      const el = document.querySelector(selector);
      const text = el?.textContent?.trim();
      if (text && text.length > 0 && text.length < 200) {
        return text;
      }
    }
    
    return 'Untitled Conversation';
  },
  
  extractMessages() {
    const messages = [];
    
    // Primary: ordered message blocks with explicit roles
    const messageGroups = document.querySelectorAll('[data-message-author-role]');
    messageGroups.forEach((group, index) => {
      const roleAttr = group.getAttribute('data-message-author-role');
      const role = roleAttr === 'user' ? 'human' : 'assistant';
      const content = this.collectParagraphText(group.querySelectorAll('[class*="markdown"] p, [class*="prose"] p')) ||
        group.textContent?.trim();
      if (content) messages.push({ role, content: content.trim(), index });
    });

    // Fallback for older UI
    if (messages.length === 0) {
      const altMessages = document.querySelectorAll('[class*="ConversationItem"]');
      altMessages.forEach((msg, index) => {
        const isUser = msg.querySelector('[class*="user"]') !== null;
        const content = this.collectParagraphText(msg.querySelectorAll('[class*="prose"] p')) ||
          msg.textContent?.trim();
        if (content) messages.push({ role: isUser ? 'human' : 'assistant', content: content.trim(), index });
      });
    }

    // If we somehow got all one role, alternate to preserve turns
    if (messages.length > 1 && (messages.every(m => m.role === 'assistant') || messages.every(m => m.role === 'human'))) {
      messages.forEach((m, i) => { if (i % 2 === 1) m.role = messages[0].role === 'human' ? 'assistant' : 'human'; });
    }

    return messages.filter(m => m.content);
  },

  collectParagraphText(nodeList) {
    const parts = Array.from(nodeList || [])
      .map(p => p.textContent?.trim())
      .filter(Boolean);
    return parts.length ? parts.join('\n\n') : null;
  },
  
  extractTimestamp() {
    // ChatGPT doesn't show timestamps prominently
    // Use current time as fallback
    return new Date().toISOString();
  },
  
  extractConversationId() {
    // Extract from URL
    const urlMatch = window.location.pathname.match(/\/c\/([a-f0-9-]+)/i);
    if (urlMatch) return urlMatch[1];
    
    // Try alternate URL patterns
    const altMatch = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/i);
    if (altMatch) return altMatch[1];
    
    return null;
  }
};
