// Mnemolog Platform Extractor - Grok

window.MnemologPlatform = {
  platform: 'grok',
  
  async extract() {
    const data = {
      platform: 'grok',
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
    // Grok model indicators
    const modelSelectors = [
      '[data-testid="model-selector"]',
      '[class*="model"]',
      'button[aria-label*="model"]'
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
    
    // Infer from date and subscription tier (heuristic)
    // After July 2025, X Premium+ defaults to Grok 4
    const now = new Date();
    if (now >= new Date('2025-07-09')) {
      return {
        displayName: 'Grok 4',
        id: 'grok-4',
        source: 'date_inferred'
      };
    }
    
    return {
      displayName: 'Grok',
      id: 'grok-3',
      source: 'default'
    };
  },
  
  isModelName(text) {
    if (!text) return false;
    return /grok|fun|accurate/i.test(text);
  },
  
  modelDisplayToId(displayName) {
    const mappings = {
      'grok 4': 'grok-4',
      'grok 4 heavy': 'grok-4-heavy',
      'grok 3': 'grok-3',
      'grok 3 mini': 'grok-3-mini',
      'grok 2': 'grok-2',
      'fun mode': 'grok-fun',
      'accurate mode': 'grok-accurate'
    };
    
    const normalized = displayName.toLowerCase().trim();
    
    for (const [key, id] of Object.entries(mappings)) {
      if (normalized.includes(key)) return id;
    }
    
    return 'grok-4';
  },
  
  extractTitle() {
    // Grok conversation title
    const titleSelectors = [
      '[data-testid="conversation-title"]',
      'h1',
      '[class*="title"]'
    ];
    
    for (const selector of titleSelectors) {
      const el = document.querySelector(selector);
      const text = el?.textContent?.trim();
      if (text && text.length > 0 && text.length < 200 && !text.includes('Grok')) {
        return text;
      }
    }
    
    // Extract from first message
    const firstMessage = document.querySelector('[class*="user-message"], [data-testid="user-message"]');
    if (firstMessage) {
      const text = firstMessage.textContent?.trim().slice(0, 100);
      if (text) return text + (text.length >= 100 ? '...' : '');
    }
    
    return 'Untitled Conversation';
  },
  
  extractMessages() {
    const messages = [];
    
    // Ordered blocks in the DOM
    const blocks = document.querySelectorAll('[data-testid="message"], [data-testid*="chat-message"], [class*="message"], [class*="Message"]');

    blocks.forEach((node, idx) => {
      const attrRole = node.getAttribute('data-message-author-role');
      const classString = node.className || '';
      const isUser = attrRole === 'user' ||
        /user|self|author/i.test(classString) ||
        node.closest('[data-testid="user-message"]') ||
        node.closest('[class*="user"]');

      const content = node.textContent?.trim();
      if (content) {
        messages.push({
          role: isUser ? 'human' : 'assistant',
          content,
          index: idx
        });
      }
    });

    // Fallback: look for conversation turns
    if (messages.length === 0) {
      const container = document.querySelector('[class*="conversation"], [class*="chat"]');
      if (container) {
        const children = Array.from(container.children);
        children.forEach((child, index) => {
          const content = child.textContent?.trim();
          if (content && content.length > 0) {
            messages.push({
              role: index % 2 === 0 ? 'human' : 'assistant',
              content,
              index: index
            });
          }
        });
      }
    }

    // If all messages fell into one role, alternate to preserve turns
    if (messages.length > 1 && (messages.every(m => m.role === 'assistant') || messages.every(m => m.role === 'human'))) {
      messages.forEach((m, i) => { if (i % 2 === 1) m.role = messages[0].role === 'human' ? 'assistant' : 'human'; });
    }

    return messages.filter(m => m.content);
  },
  
  extractTimestamp() {
    // Look for timestamps in X's format
    const timeEls = document.querySelectorAll('time[datetime]');
    
    for (const el of timeEls) {
      const datetime = el.getAttribute('datetime');
      if (datetime) return datetime;
    }
    
    return new Date().toISOString();
  },
  
  extractConversationId() {
    // X/Grok URL patterns
    // https://x.com/i/grok/share/xR76uzbzZmBoZuNh6gbjle3Om
    const urlMatch = window.location.pathname.match(/\/share\/([a-zA-Z0-9]+)/);
    if (urlMatch) return urlMatch[1];
    
    // Alternate patterns
    const altMatch = window.location.pathname.match(/\/grok\/([a-zA-Z0-9-]+)/);
    if (altMatch) return altMatch[1];
    
    return null;
  }
};
