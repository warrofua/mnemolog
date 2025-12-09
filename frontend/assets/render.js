(function () {
  const mathSymbols = /[∑Σ∞πℵ√±×÷·∏∂µ∀∃→←⇒≤≥≠≈≡⊂⊃⊆⊇∈∉∪∩⊕⊗∇=+\-/*^]/;
  const stopwords = new Set(['and','or','but','of','the','a','an','in','on','for','to','with','at','by','from']);

  function applyHeadingStyle(html) {
    const stripTags = (s) => s.replace(/<[^>]+>/g, '').trim();

    const looksLikeHeading = (text) => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      if (trimmed.length > 160) return false;

      const prefMatch = trimmed.match(/^(\s*(?:[IVXLCDM]+\.?|[A-Za-z0-9]+\.?)\s+)?(.*)$/);
      const body = (prefMatch && prefMatch[2]) ? prefMatch[2] : trimmed;

      const words = body.split(/\s+/);
      let capCount = 0;
      let total = 0;
      for (const w of words) {
        const clean = w.replace(/[^A-Za-z]/g, '');
        if (!clean) continue;
        const lower = clean.toLowerCase();
        if (stopwords.has(lower)) continue;
        total++;
        if (/^[A-Z][a-z]/.test(clean)) capCount++;
      }
      return capCount >= 1 && capCount >= Math.max(1, total - 1);
    };

    return html
      .split('\n')
      .map(line => {
        const bare = stripTags(line);
        // Markdown headings (#, ##, ###) take precedence, but only if heading-ish
        const mdMatch = bare.match(/^(#{1,3})\s+(.*)$/);
        if (mdMatch && mdMatch[2]) {
          const level = mdMatch[1].length;
          const content = mdMatch[2].trim();
          if (looksLikeHeading(content)) {
            const cls = level === 1 ? 'heading-1' : level === 2 ? 'heading-2' : 'heading-3';
            return `<span class="heading-line ${cls}">${escapeHtml(content)}</span>`;
          }
        }
        if (bare && !mathSymbols.test(bare) && looksLikeHeading(bare)) {
          return `<span class="heading-line heading-4">${escapeHtml(bare)}</span>`;
        }
        return line;
      })
      .join('\n');
  }

  // Simple escape to protect markdown replacements
  function escapeHtml(text) {
    if (!text) return '';
    const div = typeof document !== 'undefined' ? document.createElement('div') : null;
    if (div) {
      div.textContent = text;
      return div.innerHTML;
    }
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  window.mnemologRender = {
    applyHeadingStyle,
  };
})();
