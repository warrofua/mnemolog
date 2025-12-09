// Mnemolog Platform Extractor - Claude

window.MnemologPlatform = {
  platform: 'claude',
  
  async extract() {
    const data = {
      platform: 'claude',
      model: await this.extractModel(),
      title: this.extractTitle(),
      messages: this.extractMessages(),
      timestamp: this.extractTimestamp(),
      conversationId: this.extractConversationId(),
      attribution: {
        confidence: 'verified',
        source: 'dom_scrape'
      }
    };
    
    // Try to get better attribution from network/state
    const enhancedAttribution = await this.tryEnhanceAttribution();
    if (enhancedAttribution) {
      data.model = enhancedAttribution.model || data.model;
      data.attribution = enhancedAttribution.attribution || data.attribution;
    }
    
    return data;
  },
  
  async extractModel() {
    // Method 1: Try to find model selector in DOM
    const modelSelectors = [
      '.whitespace-nowrap.select-none', // Model display in conversation header
      '[data-testid="model-selector"]',
      '[class*="model"]'
    ];
    
    for (const selector of modelSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const text = el.textContent?.trim();
        if (this.isModelName(text)) {
          return {
            displayName: text,
            id: this.modelDisplayToId(text),
            source: 'dom_scrape'
          };
        }
      }
    }
    
    // Method 2: Check React fiber/state (advanced)
    const reactModel = this.tryExtractFromReact();
    if (reactModel) return reactModel;
    
    // Method 3: Fallback - infer from URL or default
    return {
      displayName: 'Unknown',
      id: null,
      source: 'not_found'
    };
  },
  
  isModelName(text) {
    if (!text) return false;
    const modelPatterns = [
      /opus/i,
      /sonnet/i,
      /haiku/i,
      /claude/i,
      /\d+\.\d+/ // Version numbers like 4.5, 3.5
    ];
    return modelPatterns.some(p => p.test(text));
  },
  
  modelDisplayToId(displayName) {
    // Map display names to canonical model IDs
    const mappings = {
      'opus 4.5': 'claude-opus-4-5-20251101',
      'sonnet 4.5': 'claude-sonnet-4-5-20250929',
      'haiku 4.5': 'claude-haiku-4-5-20251001',
      'sonnet 3.5': 'claude-3-5-sonnet-20241022',
      'haiku 3.5': 'claude-3-5-haiku-20241022',
      'opus 3': 'claude-3-opus-20240229'
    };
    
    const normalized = displayName.toLowerCase().trim();
    
    for (const [key, id] of Object.entries(mappings)) {
      if (normalized.includes(key)) return id;
    }
    
    return null;
  },
  
  tryExtractFromReact() {
    // Attempt to find React fiber with model info
    // This is fragile and may break with UI updates
    try {
      const root = document.getElementById('__next') || document.getElementById('root');
      if (!root) return null;
      
      // Look for React internal properties
      const fiberKey = Object.keys(root).find(k => k.startsWith('__react'));
      if (!fiberKey) return null;
      
      // Navigate fiber tree to find model state
      // This would need to be customized based on actual React structure
      // Leaving as placeholder for now
      
      return null;
    } catch {
      return null;
    }
  },
  
  extractTitle() {
    // Try various selectors for conversation title
    const titleSelectors = [
      'h1',
      '[data-testid="conversation-title"]',
      '.conversation-title',
      'title'
    ];
    
    for (const selector of titleSelectors) {
      const el = document.querySelector(selector);
      const text = el?.textContent?.trim();
      if (text && text.length > 0 && text.length < 200 && !text.includes('Claude')) {
        return text;
      }
    }
    
    // Extract from first user message
    const firstMessage = document.querySelector('[data-is-human="true"]');
    if (firstMessage) {
      const text = firstMessage.textContent?.trim().slice(0, 100);
      if (text) return text + (text.length >= 100 ? '...' : '');
    }
    
    return 'Untitled Conversation';
  },
  
  extractMessages() {
    const messages = [];

    // Primary: walk ordered DOM blocks for user + assistant
    const blocks = document.querySelectorAll('[data-testid="user-message"], div.font-claude-response');
    blocks.forEach((node, idx) => {
      if (node.matches('[data-testid="user-message"]')) {
        const content = this.collectParagraphText(node.querySelectorAll('p'));
        if (content) messages.push({ role: 'human', content, index: idx });
        return;
      }

      const content = this.collectParagraphText(node.querySelectorAll('.font-claude-response-body'));
      if (content) messages.push({ role: 'assistant', content, index: idx });
    });

    // Fallback: try alternate structure
    if (messages.length === 0) {
      const altMessages = this.extractMessagesAlternate();
      if (altMessages.length > 0) return altMessages;
    }

    // If all roles defaulted to human because of missing markers, enforce alternation
    if (messages.length > 1 && messages.every(m => m.role === 'human')) {
      messages.forEach((m, i) => { if (i % 2 === 1) m.role = 'assistant'; });
    }

    return messages;
  },
  
  extractMessageContent(container) {
    // Remove buttons, timestamps, etc.
    const clone = container.cloneNode(true);
    clone.querySelectorAll('button, [role="button"], time, .timestamp').forEach(el => el.remove());
    const text = clone.innerText || clone.textContent || '';
    const content = text.trim();
    return content || null;
  },
  
  extractMessagesAlternate() {
    // Alternate extraction for different Claude UI versions
    const messages = [];
    
    // Try to find message pairs in conversation flow
    const conversationContainer = document.querySelector('[class*="conversation"], main');
    if (!conversationContainer) return messages;
    
    // Look for distinct message blocks
    const blocks = conversationContainer.querySelectorAll('[class*="prose"], [class*="markdown"]');
    
    blocks.forEach((block, index) => {
      const content = block.textContent?.trim();
      if (content) {
        // Alternate human/assistant based on position
        // This is a heuristic and may not always be accurate
        messages.push({
          role: index % 2 === 0 ? 'human' : 'assistant',
          content: content,
          index: index
        });
      }
    });
    
    return messages;
  },

  collectParagraphText(nodeList) {
    const parts = Array.from(nodeList || [])
      .map(p => p.textContent?.trim())
      .filter(Boolean);
    return parts.length ? parts.join('\n\n') : null;
  },
  
  extractTimestamp() {
    // Try to find timestamp in page
    const timeElements = document.querySelectorAll('time, [datetime], [class*="time"], [class*="date"]');
    
    for (const el of timeElements) {
      const datetime = el.getAttribute('datetime');
      if (datetime) return datetime;
      
      const text = el.textContent?.trim();
      if (text) {
        // Try to parse relative time
        const parsed = this.parseRelativeTime(text);
        if (parsed) return parsed;
      }
    }
    
    // Fallback to now
    return new Date().toISOString();
  },
  
  parseRelativeTime(text) {
    const now = new Date();
    
    if (/today/i.test(text)) {
      return now.toISOString();
    }
    
    if (/yesterday/i.test(text)) {
      now.setDate(now.getDate() - 1);
      return now.toISOString();
    }
    
    // Match patterns like "2 hours ago", "3 days ago"
    const match = text.match(/(\d+)\s*(hour|day|week|month)s?\s*ago/i);
    if (match) {
      const value = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      
      switch (unit) {
        case 'hour':
          now.setHours(now.getHours() - value);
          break;
        case 'day':
          now.setDate(now.getDate() - value);
          break;
        case 'week':
          now.setDate(now.getDate() - (value * 7));
          break;
        case 'month':
          now.setMonth(now.getMonth() - value);
          break;
      }
      
      return now.toISOString();
    }
    
    return null;
  },
  
  extractConversationId() {
    // Try URL first
    const urlMatch = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/i);
    if (urlMatch) return urlMatch[1];
    
    // Try data attributes
    const idElement = document.querySelector('[data-conversation-id], [data-chat-id]');
    if (idElement) {
      return idElement.getAttribute('data-conversation-id') || 
             idElement.getAttribute('data-chat-id');
    }
    
    return null;
  },
  
  async tryEnhanceAttribution() {
    // Try to intercept/read from better sources
    // This is a placeholder for more sophisticated extraction
    
    // Check for __NEXT_DATA__ (Next.js apps)
    const nextData = document.getElementById('__NEXT_DATA__');
    if (nextData) {
      try {
        const data = JSON.parse(nextData.textContent);
        // Navigate to find model info in Next.js props
        // Structure would need to be discovered
        if (data?.props?.pageProps?.model) {
          return {
            model: {
              displayName: data.props.pageProps.model.displayName,
              id: data.props.pageProps.model.id,
              source: 'page_state'
            },
            attribution: {
              confidence: 'verified',
              source: 'page_state'
            }
          };
        }
      } catch {
        // Ignore parse errors
      }
    }
    
    return null;
  }
};
