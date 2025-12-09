// Shared conversation parser for platform-specific exports.
// Exposes window.mnemologParsers.parseConversation(rawText, platform, overrideFirstSpeaker?)
// Designed to be loaded before assets/app.js and used by share.html and other pages.
(function () {
  // Simplified math preservation: join likely math lines into single lines
  function preserveMathBlocks(text) {
    const lines = text.split('\n');
    const result = [];
    let mathBuffer = [];

    const isLikelyMath = (line) => {
      const t = line.trim();
      if (!t || t.length > 200) return false;
      const mathDensity = (t.match(/[±×÷√∏∑∂∫∞πµ∀∃≤≥≠≈≡⊂⊃⊆⊇∈∉⊕⊗∇^/*+\-]/g) || []).length;
      return mathDensity >= 2 || /^[\d\w\^√π∑∞∫∂]+\s*[=±×÷]\s*.+$/.test(t);
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (isLikelyMath(line) && trimmed !== '') {
        mathBuffer.push(trimmed);
      } else {
        if (mathBuffer.length) {
          result.push(mathBuffer.join(' '));
          mathBuffer = [];
        }
        result.push(line);
      }
    }
    if (mathBuffer.length) result.push(mathBuffer.join(' '));
    return result.join('\n');
  }

  // Legacy aliases — prefer preserveMathBlocks in new code
  function rejoinMathBlocks(text) {
    return preserveMathBlocks(text);
  }

  function normalizeEquations(text) {
    return preserveMathBlocks(text);
  }

  function stripCruft(text) {
    const CRUFT_PATTERNS = [
      /^Skip to content/i,
      /^Chat history/i,
      /^Thought for \d+s?/i,
      /^Searched \d+ web/i,
      /^Image of/i,
      /^Upgrade to/i,
      /^Copy$/i,
      /^Retry$/i,
      /^Edit$/i,
      /^\d+(\.\d+)?s?$/i,
      /^ChatGPT can make mistakes/i,
    ];
    return text
      .split('\n')
      .filter(line => {
        const t = line.trim();
        if (t.startsWith('```')) return true;
        if (CRUFT_PATTERNS.some(p => p.test(t))) return false;
        return true;
      })
      .join('\n')
      .trim();
  }

  // ===== ChatGPT =====
  function tryParseChatGPT(text) {
    if (!text.includes('You said:') && !text.includes('ChatGPT said:')) return null;

    text = stripCruft(text);
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
      messages: messages.map(m => ({ ...m, content: preserveMathBlocks(m.content) })),
      metadata: {
        detectedProvider: 'chatgpt',
        detectedFirstSpeaker: messages[0]?.role || 'human',
        userOverrodeFirstSpeaker: false,
        hasLabels: true,
        rawCharacterCount: text.length,
        messageCount: messages.length,
      }
    };
  }

  // ===== Gemini =====
  function tryParseGemini(text) {
    // Handle common Gemini export headers:
    // "Gemini" (logo line), "<conversation title>", "Conversation with Gemini"
    const lines = text.split('\n');
    const headerIdx = lines.findIndex(l => /conversation with gemini/i.test(l.trim()));
    if (headerIdx !== -1) {
      const trimmed = lines.slice(headerIdx + 1).join('\n').trim();
      if (trimmed) {
        // Defer to generic parsing after header removal
        return parseGeneric(trimmed, null, 'gemini');
      }
    }
    // If no explicit header, fallback to generic
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
      /^i'?m\s+(an?\s+)?(ai|assistant|claude|grok|chatgpt|gpt)/i,
      /how can i (help|assist)/i,
      /^(hi|hello|hey|greetings|welcome)/i,
      /created by (anthropic|openai|xai)/i,
      /^as an ai/i,
    ];
    return aiFirstPatterns.some(p => p.test(trimmed)) ? 'assistant' : 'human';
  }

  function parseGeneric(rawText, overrideFirstSpeaker, platformHint) {
    let text = stripCruft(rawText);
    text = preserveMathBlocks(text);

    const ROLE_LABEL = /^[\s-*•>]*\s*(You|Human|User|Me|H|Assistant|AI|Claude|ChatGPT|Grok|Bot|Model|A|System)[\s:–—-]+/i;
    const ROLE_MARKER_ONLY = /^[\s-*•>]*\s*(You|Human|User|Me|H|Assistant|AI|Claude|ChatGPT|Grok|Bot|Model|A|System)\s*$/i;
    const lines = text.split('\n');
    
    const segments = [];
    let current = { role: null, content: '' };
    let sawLabel = false;

    const push = () => {
      if (current.content.trim()) {
        segments.push({
          role: current.role,
          content: current.content.trim()
        });
      }
      current = { role: null, content: '' };
    };

    for (let line of lines) {
      const match = line.match(ROLE_LABEL);
      if (match) {
        sawLabel = true;
        push();
        const label = match[1].toLowerCase();
        current.role = /(you|human|user|me|h)/i.test(label) ? 'human' : 'assistant';
        current.content = line.replace(ROLE_LABEL, '').trim();
        continue;
      }

      const markerOnly = line.match(ROLE_MARKER_ONLY);
      if (markerOnly) {
        sawLabel = true;
        push();
        const label = markerOnly[1].toLowerCase();
        current.role = /(you|human|user|me|h)/i.test(label) ? 'human' : 'assistant';
        current.content = '';
        continue;
      }

      // Skip leading blank lines before first content
      if (!current.content && !line.trim()) continue;

      current.content += (current.content ? '\n' : '') + line;
    }
    push();

    // Fallback: if no labels, split on double newlines
    if (!sawLabel && segments.length === 1 && !segments[0].role) {
      const parts = text.split(/\n{2,}/).filter(p => p.trim());
      segments.length = 0;
      parts.forEach(p => segments.push({ role: null, content: p.trim() }));
    }

    // Assign roles with simple alternation, honoring explicit labels
    const firstLabeled = segments.find(s => s.role)?.role || null;
    let firstSpeaker = overrideFirstSpeaker || firstLabeled || detectFirstSpeaker(segments[0]?.content || '');

    let currentRole = firstSpeaker;
    const messages = [];

    segments.forEach((seg, idx) => {
      const content = (seg.content || '').trim();
      if (!content) return;

      if (seg.role) {
        currentRole = seg.role;
      } else if (idx === 0) {
        currentRole = firstSpeaker;
      } else {
        currentRole = currentRole === 'human' ? 'assistant' : 'human';
      }

      const last = messages[messages.length - 1];
      const isContinuation = (() => {
        const t = content.trim();
        if (/^[-*•]/.test(t)) return true;
        if (/^\d+\.\s/.test(t)) return true; // numbered list
        if (/^[a-z]/.test(t)) return true;
        if (/^(and|but|also|however|so|yes|no|additionally|moreover|furthermore|that said)/i.test(t)) return true;
        return false;
      })();

      if (last && last.role === currentRole && isContinuation) {
        last.content += '\n\n' + content;
      } else {
        messages.push({ role: currentRole, content });
      }
    });

    return {
      messages,
      metadata: {
        detectedProvider: platformHint || 'generic',
        detectedFirstSpeaker: firstSpeaker,
        userOverrodeFirstSpeaker: !!overrideFirstSpeaker,
        hasLabels: sawLabel,
        rawCharacterCount: text.length,
        messageCount: messages.length,
      }
    };
  }

  function parseConversation(rawText, platform, overrideFirstSpeaker) {
    let text = rawText.replace(/\r\n/g, '\n').trim();
    const selected = (platform || 'other').toLowerCase();

    if (selected === 'chatgpt') {
      const chatgptResult = tryParseChatGPT(text);
      if (chatgptResult) {
        return chatgptResult;
      }
    }

    // Gemini: strip common header if present
    if (selected === 'gemini') {
      const geminiResult = tryParseGemini(text);
      if (geminiResult) return geminiResult;
    }

    return parseGeneric(text, overrideFirstSpeaker, selected);
  }

  window.mnemologParsers = {
    parseConversation,
    normalizeEquations,
    rejoinMathBlocks: preserveMathBlocks,
    preserveMathBlocks,
  };
})();
