// Shared conversation parser for platform-specific exports.
// Exposes window.mnemologParsers.parseConversation(rawText, platform, overrideFirstSpeaker?)
// Designed to be loaded before assets/app.js and used by share.html and other pages.
(function () {
  const mathSymbols = /[∑Σ∞πℵ√±×÷·∏∂µ∀∃→←⇒≤≥≠≈≡⊂⊃⊆⊇∈∉∪∩⊕⊗∇=+\-/*^]/;

  const isMathLine = (line, maxLen = 80) => {
    const t = line.trim().replace(/[\u200b-\u200f]/g, '');
    if (!t) return false;
    if (t.length > maxLen) return false;
    if (/^[a-zA-Z0-9]$/.test(t)) return true;
    if (/^[+\-*/=^√π∑∞∫∂∀∃≤≥≠≈≡⊂⊃∈∉∪∩⊕⊗∇]$/.test(t)) return true;
    if (/^[a-zA-Z]+\^?\d*$/.test(t)) return true;
    if (/^[\d\.]+$/.test(t)) return true;
    if (/^e\^/.test(t)) return true;
    if (/^-\w+$/.test(t)) return true;
    const mathChars = t.match(/[+\-*/=^√π∑∞∫∂∀∃≤≥≠≈≡⊂⊃∈∉∪∩⊕⊗∇]/g) || [];
    return mathChars.length >= 1 && t.length <= 20;
  };

  const isMathishLine = (line, maxLen = 300) => {
    const t = line.trim().replace(/[\u200b-\u200f]/g, '');
    if (!t) return false;
    if (t.length > maxLen) return false;
    if (/^[\dIVXLCDM]+$/.test(t)) return true;
    if (mathSymbols.test(t)) return true;
    const nonWord = (t.match(/[^\w\s]/g) || []).length;
    return nonWord > 1 && (nonWord / Math.max(1, t.length)) > 0.2;
  };

  function rejoinMathBlocks(text) {
    const lines = text.split('\n');
    const result = [];
    let buffer = [];

    const flush = () => {
      if (buffer.length) {
        result.push(buffer.join('').replace(/\s+/g, ' ').trim());
        buffer = [];
      }
    };

    lines.forEach(line => {
      const trimmed = line.trim();
      if (isMathLine(line) || (buffer.length > 0 && trimmed === '')) {
        buffer.push(trimmed || ' ');
      } else {
        flush();
        result.push(line);
      }
    });
    flush();

    return result.join('\n');
  }

  function normalizeEquations(text) {
    const lines = text.split('\n').map(l => l.replace(/[\u200b-\u200f]/g, ''));
    const result = [];
    let buffer = [];

    const flush = () => {
      if (buffer.length) {
        result.push(buffer.join(' ').replace(/\s+/g, ' ').trim());
        buffer = [];
      }
    };

    lines.forEach(line => {
      if (isMathishLine(line, 120)) {
        buffer.push(line.trim());
      } else {
        flush();
        result.push(line);
      }
    });
    flush();
    return result.join('\n');
  }

  function stripCruft(text, platformHint) {
    const lines = text.split('\n');
    let inFence = false;
    const kept = [];
    const cruftPatterns = [
      /^Skip to content/i,
      /^Chat history/i,
      /^ChatGPT\s*$/i,
      /^Thought for \d+s?/i,
      /^Searched for /i,
      /^Image of\b/i,
      /^No file chosen/i,
      /^Upgrade to /i,
      /^Copy\s*$/i,
      /^Retry\s*$/i,
      /^Edit\s*$/i,
      /^\d+(\.\d+)?s\s*$/i,
      /^ChatGPT can make mistakes\. Check important info\./i,
    ];

    lines.forEach(line => {
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        kept.push(line);
        return;
      }
      if (inFence) {
        kept.push(line);
        return;
      }
      if (cruftPatterns.some(p => p.test(line))) return;
      if (platformHint === 'gemini' && line.trim().match(/^(AI's|Cloudflare|Supabase|Inverting|Poisson|From Randomness|Blake and Rumi|Reality, AI)/)) return;
      kept.push(line);
    });

    return kept.join('\n').trim();
  }

  // ===== ChatGPT =====
  function tryParseChatGPT(text) {
    if (!text.includes('You said:') && !text.includes('ChatGPT said:')) return null;

    text = stripCruft(text, 'chatgpt');
    const messages = [];
    const parts = text.split(/(?=^You said:$|^ChatGPT said:$)/m);

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('You said:')) {
        const content = trimmed.replace(/^You said:\s*/i, '').trim();
        if (content) messages.push({ role: 'human', content });
      }
      else if (trimmed.startsWith('ChatGPT said:')) {
        let content = trimmed.replace(/^ChatGPT said:\s*/i, '');
        content = content.replace(/^Thought for \d+s?\s*\n?/i, '').trim();
        if (content) messages.push({ role: 'assistant', content });
      }
    }

    if (messages.length < 2) return null;

    return {
      messages,
      metadata: {
        detectedProvider: 'chatgpt',
        detectedFirstSpeaker: messages[0]?.role || 'human',
        userOverrodeFirstSpeaker: false,
        rawCharacterCount: text.length,
        messageCount: messages.length,
      }
    };
  }

  // ===== Gemini =====
  function tryParseGemini(text) {
    return null;
  }

  // ===== Generic / Claude / Grok / Other =====
  function detectFirstSpeaker(firstSegment) {
    if (!firstSegment) return 'human';
    const trimmed = firstSegment.trim();
    if (trimmed.length < 220 && /[?]$/.test(trimmed)) return 'human';
    if (/Searched for /i.test(trimmed)) return 'assistant';
    if (/Thought for \d+s/i.test(trimmed)) return 'assistant';
    if (/Image of\b/i.test(trimmed)) return 'assistant';
    const aiFirstPatterns = [
      /^(hi|hello|hey)[,!]?\s+i'?m\s+(an?\s+)?(ai|assistant|claude|chatgpt|gpt)/i,
      /^i'?m\s+(an?\s+)?(ai|assistant|claude)/i,
      /how can i (help|assist) you/i,
      /^(welcome|greetings)[!,.]?\s/i,
      /created by (anthropic|openai)/i,
      /^as an ai/i,
      /i'?m here to help/i,
    ];
    return aiFirstPatterns.some(p => p.test(firstSegment)) ? 'assistant' : 'human';
  }

  function isContinuation(content, lastRole) {
    const trimmed = content.trim();
    if (!trimmed) return true;
    if (/^[-*•]/.test(trimmed)) return true;
    if (/^[a-z]/.test(trimmed)) return true;
    if (/^(and|but|or|so|then|also|yet|however|here's|meanwhile|plus|from|the|this feels|what)/i.test(trimmed)) return true;
    if (/takes a breath|exhales|sitting with|let me think|let me/i.test(trimmed)) return true;
    if (lastRole === 'assistant' && !/[?!]$/.test(trimmed)) return true;
    return false;
  }

  function parseGeneric(rawText, overrideFirstSpeaker, platformHint) {
    const text = stripCruft(rawText, platformHint);

    const labelRegex = /^[-*•]?\s*(\*\*|__)?(human|user|you|me|h|assistant|ai|claude|chatgpt|gpt|model|bot|a|system)\s*[:\-–—]\s*/i;
    const markerOnlyRegex = /^(human|user|you|me|h|assistant|ai|claude|chatgpt|gpt|model|bot|a|system)$/i;
    const roleFromLabel = (label) => ['human','user','you','me','h'].includes(label.toLowerCase()) ? 'human' : 'assistant';

    const lines = text.split(/\r?\n/);
    const segments = [];
    let current = { role: null, content: '' };
    let inFence = false;

    const push = () => {
      const trimmed = current.content.trim();
      if (trimmed.length > 1) segments.push({ ...current, content: trimmed });
      current = { role: null, content: '' };
    };

    lines.forEach(line => {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('```')) {
        inFence = !inFence;
        current.content += (current.content ? '\n' : '') + line;
        return;
      }

      if (!inFence) {
        const match = line.match(labelRegex);
        if (match) {
          push();
          const label = match[2] || '';
          current = { role: roleFromLabel(label), content: line.replace(labelRegex, '').trim() };
          return;
        }
        const markerOnly = trimmedLine.match(markerOnlyRegex);
        if (markerOnly) {
          push();
          current = { role: roleFromLabel(markerOnly[1]), content: '' };
          return;
        }
        if (trimmedLine === '') {
          push();
          return;
        }
      }

      current.content += (current.content ? '\n' : '') + line;
    });
    push();

    if (!segments.length) {
      rawText.split(/\n{2,}/).map(s => s.trim()).filter(Boolean)
        .forEach(content => segments.push({ role: null, content }));
    }

    const isConjunctionStart = (s) => /^(and|but|or|so|then|also|yet|however|here's|meanwhile|plus|from|the|this feels|what)/i.test(s.trim());
    const isListish = (s) => /^[-*•]/.test(s.trim()) || /^(\d+\.|[ivxlcdm]+\.)\s/i.test(s.trim());
    const isMetaBeat = (s) => /(takes a breath|exhales|sitting with|let me think|let me)/i.test(s.trim());
    const shortish = (s, n = 150) => s.trim().length < n;

    const shouldMerge = (text, lastRole) => {
      const trimmed = text.trim();
      if (!trimmed) return true;
      if (isListish(trimmed)) return true;
      if (/^(I|II|III|IV|V|VI|VII|VIII|IX|X)\.\s/.test(trimmed)) return true;
      if (/^(∫|∑|π|∂|∇|∀|∃|lim|log|sin|cos|tan)/i.test(trimmed)) return true;
      if (isConjunctionStart(trimmed)) return true;
      if (isMetaBeat(trimmed)) return true;
      // Claude: keep human paragraphs separate; avoid merging long assistant prose
      if (platformHint === 'claude') {
        if (lastRole === 'human') return false;
        if (lastRole === 'assistant' && trimmed.length > 180) return false;
      }
      if (shortish(trimmed, 150)) return true;
      // For non-chatgpt (e.g., Claude/Grok/other), avoid aggressive assistant merging
      if (platformHint !== 'chatgpt' && lastRole === 'assistant') return false;
      if (lastRole === 'assistant' && !/[?!]$/.test(trimmed)) return true;
      return false;
    };

    const mergedSegments = [];
    segments.forEach(seg => {
      const last = mergedSegments[mergedSegments.length - 1];
      if (last && (!seg.role || seg.role === last.role) && shouldMerge(seg.content, last.role)) {
        last.content += '\n\n' + seg.content;
      } else {
        mergedSegments.push({ ...seg });
      }
    });

    const firstLabeled = mergedSegments.find(p => p.role);
    const detected = firstLabeled?.role || detectFirstSpeaker(mergedSegments[0]?.content || '');
    const firstSpeaker = overrideFirstSpeaker || detected;

    const useLongAssistantBias = platformHint === 'chatgpt';
    let lastRole = firstSpeaker;
    let inLongAssistant = firstSpeaker === 'assistant';
    let assistantCharCount = 0;
    const messages = [];
    let claudeHumanBias = platformHint === 'claude' ? 2 : 0;
    let assistantSeen = firstSpeaker === 'assistant';
    let humanSeen = firstSpeaker === 'human';

    mergedSegments.forEach((seg, idx) => {
      const content = (seg.content || '').trim();
      if (!content) return;

      const looksHuman = content.length < 200 ||
        /\?/.test(content) ||
        /^(What|How|Why|Do you|Can you|Tell me|I think|I feel|That )/i.test(content);

      if (idx === 0) {
        const role = seg.role || firstSpeaker;
        messages.push({ role, content });
        lastRole = role;
        if (role === 'assistant') {
          inLongAssistant = true;
          assistantCharCount = content.length;
          assistantSeen = true;
        }
        return;
      }

      if (platformHint === 'claude' && !assistantSeen && lastRole === 'human' && claudeHumanBias > 0) {
        claudeHumanBias--;
        messages.push({ role: 'human', content });
        lastRole = 'human';
        return;
      }

      if (platformHint === 'claude' && lastRole === 'assistant' && !assistantSeen && humanSeen && looksHuman) {
        lastRole = 'human';
        humanSeen = true;
        inLongAssistant = false;
        assistantCharCount = 0;
        messages.push({ role: 'human', content });
        return;
      }

      if (useLongAssistantBias && lastRole === 'assistant') {
        const safeMerge = !looksHuman && content.length < 500;
        const inLongMode = inLongAssistant && assistantCharCount > 1000 && !looksHuman;
        if (safeMerge || inLongMode) {
          const last = messages[messages.length - 1];
          if (last) {
            last.content += '\n\n' + content;
            assistantCharCount += content.length;
          }
          return;
        }
      }

      const role = seg.role || (isContinuation(seg.content, lastRole) ? lastRole : (lastRole === 'human' ? 'assistant' : 'human'));
      lastRole = role;
      if (role === 'assistant') {
        inLongAssistant = true;
        assistantCharCount = content.length;
        assistantSeen = true;
      } else {
        inLongAssistant = false;
        assistantCharCount = 0;
      }
      messages.push({ role, content });
    });

    return {
      messages,
      metadata: {
        detectedProvider: platformHint || 'generic',
        detectedFirstSpeaker: detected,
        userOverrodeFirstSpeaker: Boolean(overrideFirstSpeaker),
        rawCharacterCount: rawText.length,
        messageCount: messages.length,
      },
    };
  }

  function parseConversation(rawText, platform, overrideFirstSpeaker) {
    let text = rawText.replace(/\r\n/g, '\n');
    text = rejoinMathBlocks(text);
    text = text.trim();
    const selected = (platform || 'other').toLowerCase();

    if (selected === 'chatgpt') {
      const chatgptResult = tryParseChatGPT(text);
      if (chatgptResult) {
        chatgptResult.messages = chatgptResult.messages.map(m => ({ ...m, content: normalizeEquations(m.content) }));
        return chatgptResult;
      }
    }

    const genericResult = parseGeneric(text, overrideFirstSpeaker, selected);
    genericResult.messages = genericResult.messages.map(m => ({ ...m, content: normalizeEquations(m.content) }));
    return genericResult;
  }

  window.mnemologParsers = {
    parseConversation,
    normalizeEquations,
    rejoinMathBlocks,
  };
})();
