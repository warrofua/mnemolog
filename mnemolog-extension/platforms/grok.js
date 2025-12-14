// Mnemolog Platform Extractor - Grok

window.MnemologPlatform = {
  platform: 'grok',
  
  async extract() {
    const isXGrok = window.location.hostname.includes('x.com');

    const data = {
      platform: 'grok',
      model: await this.extractModel(),
      title: this.extractTitle(),
      messages: this.extractMessages(isXGrok),
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
      'button[aria-label*="model"]',
      'button[aria-label^="Grok"]' // x.com/i/grok model button
    ];
    
    for (const selector of modelSelectors) {
      const el = document.querySelector(selector);
      let text = el?.textContent?.trim();
      
      if (this.isModelName(text)) {
        // Normalize common formatting (e.g., "Grok 4.1Beta" -> "Grok 4.1 (Beta)")
        text = text
          .replace(/4\.1\s*Beta/i, '4.1 (Beta)')
          .replace(/\s*\(Beta\)/i, ' (Beta)')
          .replace(/\s+Beta$/i, ' (Beta)');
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
      'grok 4.1': 'grok-4-1',
      'grok 4.1 (beta)': 'grok-4-1-beta',
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
    // 0) Use <title>... - Grok</title> if present
    const docTitle = (document.title || '').replace(/\s*-\s*Grok\s*$/i, '').trim();
    if (docTitle && docTitle.length < 200) return docTitle;

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
  
  extractMessages(isXGrok = false) {
    const messages = [];
    let explicitRoleFound = false;

    if (isXGrok) {
      // x.com/i/grok: build from text lines, stripping headers, grouping blocks
      const container = document.querySelector('main') || document.body;
      const rawText = container?.innerText || '';
      let lines = rawText.split(/\n+/).map(l => l.trim()).filter(Boolean);
      const headerRe = /^(grok[\s\d\.]*(beta)?|thinking|see new posts)$/i;

      // Strip header lines anywhere near the top (first few lines)
      lines = lines.filter((l, idx) => {
        if (idx < 5 && headerRe.test(l)) return false;
        return true;
      });

      const blocks = [];
      let current = [];
      for (let idxLine = 0; idxLine < lines.length; idxLine++) {
        const line = lines[idxLine];
        if (!line) continue;
        if (headerRe.test(line)) continue;
        if (current.length && line.length < 3 && /^(–|-)$/.test(line)) {
          blocks.push(current.join(' '));
          current = [];
          continue;
        }
        current.push(line);
      }
      if (current.length) blocks.push(current.join(' '));

      // Clean leading header tokens from the first block
      if (blocks.length) {
        const cleanHeader = (txt) => txt
          .replace(/^grok[\s\d\.]*\s*beta\s*/i, '')
          .replace(/^grok[\s\d\.]*\s*/i, '')
          .replace(/^thinking\s*/i, '')
          .replace(/^see new posts\s*/i, '')
          .trim();
        blocks[0] = cleanHeader(blocks[0]);
        // Drop empty first block after cleaning
        if (!blocks[0]) blocks.shift();
      }

      // Assign roles by alternating, but bias first short block to human
      let role = 'human';
      blocks.forEach((b, i) => {
        const trimmed = b.trim();
        if (!trimmed) return;
        // Heuristic: if very short/question-like, treat as human prompt
        const isPrompt = trimmed.length < 120 || /[?]$/.test(trimmed);
        const assigned = (i === 0 || isPrompt) ? 'human' : role;
        messages.push({ role: assigned, content: trimmed, index: i });
        role = assigned === 'human' ? 'assistant' : 'human';
      });

    } else {
      // Ordered blocks in the DOM
      const blocks = document.querySelectorAll('[data-testid="message"], [data-testid*="chat-message"], [class*="message"], [class*="Message"], article p[dir="auto"], main p[dir="auto"], p.break-words');

      blocks.forEach((node, idx) => {
        const attrRole = node.getAttribute('data-message-author-role');
        const classString = node.className || '';
        const isUser = attrRole === 'user' ||
          /user|self|author/i.test(classString) ||
          node.closest('[data-testid="user-message"]') ||
          node.closest('[class*="user"]');
        if (isUser || attrRole) explicitRoleFound = true;

        // Prefer textContent but respect inline markup (Markdown)
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
    }

    const normText = (t) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();

    // If on x.com/i/grok, strip leading header lines from each message
    if (isXGrok && messages.length) {
      const headerRe = /^(grok[\s\d\.]*(beta)?|thinking|see new posts)$/i;
      const cleanedMsgs = [];
      messages.forEach(m => {
        const lines = (m.content || '').split(/\n+/).map(l => l.trim());
        while (lines.length && headerRe.test(lines[0])) {
          lines.shift();
        }
        const joined = lines.join('\n').trim();
        if (joined) cleanedMsgs.push({ ...m, content: joined });
      });
      messages.length = 0;
      cleanedMsgs.forEach(m => messages.push(m));
    }

    // Step 1: dedupe exact consecutive duplicates regardless of role
    if (messages.length > 1) {
      const dedup = [];
      messages.forEach(m => {
        const norm = normText(m.content);
        const last = dedup[dedup.length - 1];
        if (last && last._norm === norm) return;
        dedup.push({ ...m, _norm: norm });
      });
      messages.length = 0;
      dedup.forEach(({ _norm, ...rest }) => messages.push(rest));
    }

    // If we never saw an explicit role, force alternation starting with human
    if (!explicitRoleFound && messages.length > 0) {
      messages.forEach((m, i) => {
        m.role = i % 2 === 0 ? 'human' : 'assistant';
      });
    }

    // Step 2: prune contained echoes regardless of role (drop if fully contained in previous kept turn; replace if it contains previous)
    if (messages.length > 1) {
      const cleaned = [];
      for (let i = 0; i < messages.length; i++) {
        const m = { ...messages[i], _norm: normText(messages[i].content) };
        const last = cleaned[cleaned.length - 1];
        if (last) {
          const lastNorm = last._norm || '';
          if (lastNorm && m._norm) {
            if (lastNorm.includes(m._norm) && m._norm.length <= lastNorm.length * 0.95) {
              // current fully contained in last -> skip
              continue;
            }
            if (m._norm.includes(lastNorm) && m._norm.length >= lastNorm.length * 1.05) {
              // current contains last and is longer -> replace last
              cleaned.pop();
            }
          }
        }
        cleaned.push(m);
      }
      messages.length = 0;
      cleaned.forEach(({ _norm, ...rest }) => messages.push(rest));
    }

    // If all messages fell into one role, alternate to preserve turns
    if (messages.length > 1 && (messages.every(m => m.role === 'assistant') || messages.every(m => m.role === 'human'))) {
      messages.forEach((m, i) => { if (i % 2 === 1) m.role = messages[0].role === 'human' ? 'assistant' : 'human'; });
    }

    // Fallback: if nothing found, use plain text paragraphs from body/main with trimming
    if (messages.length === 0) {
      const container = document.querySelector('main') || document.body;
      const text = container?.innerText || '';
      // Split on blank lines first
      let parts = text.split(/\n{2,}/).map(t => t.trim()).filter(Boolean);
      if (parts.length === 0) {
        // Then try single newlines
        parts = text.split(/\n+/).map(t => t.trim()).filter(Boolean);
      }
      parts.forEach((p, idx) => {
        messages.push({
          role: idx % 2 === 0 ? 'human' : 'assistant',
          content: p,
          index: idx
        });
      });
    }

    // If on x.com/i/grok, drop leading header noise like "Grok 4.1 Thinking Beta See new posts"
    if (isXGrok && messages.length) {
      // If the first few messages look like header noise, drop them
      const headerRe = /^(grok[\s\d\.]*(beta)?|thinking|see new posts)$/i;
      let drops = 0;
      while (messages.length && drops < 3) {
        const c = (messages[0].content || '').trim().replace(/\s+/g, ' ');
        if (c && c.length < 120 && headerRe.test(c)) {
          messages.shift();
          drops++;
          continue;
        }
        break;
      }
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
    // grok.com/c/<id>
    const cMatch = window.location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
    if (cMatch) return cMatch[1];
    
    // Alternate patterns
    const altMatch = window.location.pathname.match(/\/grok\/([a-zA-Z0-9-]+)/);
    if (altMatch) return altMatch[1];
    
    return null;
  }
};
