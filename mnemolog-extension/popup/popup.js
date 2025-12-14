// Mnemolog Chrome Extension - Popup Logic

class MnemologPopup {
  constructor() {
    this.conversationData = null;
    this.piiResults = null;
    this.currentState = 'empty';
    this.auth = null;
    this.settings = {
      runPiiScan: true,
      alwaysRedact: false,
      defaultVisibility: 'public',
      defaultShowAuthor: true,
      analyticsEnabled: false
    };
    
    this.elements = {
      // States
      stateEmpty: document.getElementById('stateEmpty'),
      stateDetected: document.getElementById('stateDetected'),
      statePiiReview: document.getElementById('statePiiReview'),
      stateArchiving: document.getElementById('stateArchiving'),
      stateSuccess: document.getElementById('stateSuccess'),
      stateError: document.getElementById('stateError'),
      
      // Status
      statusIndicator: document.getElementById('statusIndicator'),
      statusText: document.querySelector('.status-text'),
      
      // Detection card
      platformIcon: document.getElementById('platformIcon'),
      platformName: document.getElementById('platformName'),
      modelBadge: document.getElementById('modelBadge'),
      modelName: document.getElementById('modelName'),
      conversationTitle: document.getElementById('conversationTitle'),
      messageCount: document.getElementById('messageCount'),
      conversationDate: document.getElementById('conversationDate'),
      attributionSource: document.getElementById('attributionSource'),
      modelId: document.getElementById('modelId'),
      timestamp: document.getElementById('timestamp'),
      tagInput: document.getElementById('tagInput'),
      addTagBtn: document.getElementById('addTagBtn'),
      tagList: document.getElementById('tagList'),
      
      // Buttons
      archiveBtn: document.getElementById('archiveBtn'),
      previewBtn: document.getElementById('previewBtn'),
      retryBtn: document.getElementById('retryBtn'),
      redactAndArchiveBtn: document.getElementById('redactAndArchiveBtn'),
      archiveAnywayBtn: document.getElementById('archiveAnywayBtn'),
      editOnSiteBtn: document.getElementById('editOnSiteBtn'),
      signInBtn: document.getElementById('signInBtn'),
      
      // PII elements
      piiSummary: document.getElementById('piiSummary'),
      piiCritical: document.getElementById('piiCritical'),
      piiHigh: document.getElementById('piiHigh'),
      piiMedium: document.getElementById('piiMedium'),
      piiFindings: document.getElementById('piiFindings'),
      
      // Links
      viewLink: document.getElementById('viewLink'),
      errorMessage: document.getElementById('errorMessage'),

      // Settings
      settingsLink: document.getElementById('settingsLink'),
      settingsPanel: document.getElementById('settingsPanel'),
      closeSettingsBtn: document.getElementById('closeSettingsBtn'),
      saveSettingsBtn: document.getElementById('saveSettingsBtn'),
      settingsSignInBtn: document.getElementById('settingsSignInBtn'),
      accountStatus: document.getElementById('accountStatus'),
      settingRunPii: document.getElementById('settingRunPii'),
      settingAlwaysRedact: document.getElementById('settingAlwaysRedact'),
      settingVisibility: document.getElementById('settingVisibility'),
      settingShowAuthor: document.getElementById('settingShowAuthor'),
      settingAnalytics: document.getElementById('settingAnalytics')
    };
    
    this.init();
  }
  
  async init() {
    this.bindEvents();
    chrome.runtime.onMessage.addListener((request) => {
      if (request.action === 'sessionUpdate' && request.session) {
        // New session from site: store and refresh UI
        this.auth = request.session;
        this.elements.signInBtn?.classList.add('hidden');
        this.updateAccountStatus();
      }
    });
    await this.loadSettings();
    await this.loadAuth();
    await this.detectConversation();
  }
  
  bindEvents() {
    this.elements.archiveBtn?.addEventListener('click', () => this.handleArchiveClick());
    this.elements.previewBtn?.addEventListener('click', () => this.openPreview());
    this.elements.retryBtn?.addEventListener('click', () => this.detectConversation());
    this.elements.redactAndArchiveBtn?.addEventListener('click', () => this.redactAndArchive());
    this.elements.archiveAnywayBtn?.addEventListener('click', () => this.archiveConversation(false));
    this.elements.editOnSiteBtn?.addEventListener('click', () => this.openPreview());
    this.elements.signInBtn?.addEventListener('click', () => this.openLogin());
    this.elements.settingsLink?.addEventListener('click', (e) => { e.preventDefault(); this.showSettings(); });
    this.elements.closeSettingsBtn?.addEventListener('click', () => this.hideSettings());
    this.elements.saveSettingsBtn?.addEventListener('click', () => this.saveSettings());
    this.elements.settingsSignInBtn?.addEventListener('click', () => this.openLogin());

    // Tagging
    if (this.elements.tagInput && this.elements.addTagBtn && this.elements.tagList) {
      const addTag = () => {
        const val = (this.elements.tagInput.value || '').trim();
        if (!val) return;
        if (!this.conversationData) this.conversationData = {};
        if (!Array.isArray(this.conversationData.tags)) this.conversationData.tags = [];
        if (!this.conversationData.tags.includes(val)) {
          this.conversationData.tags.push(val);
          this.renderTags();
        }
        this.elements.tagInput.value = '';
        this.elements.tagInput.focus();
      };
      this.elements.addTagBtn.addEventListener('click', addTag);
      this.elements.tagInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addTag();
        }
      });
    }
  }

  async loadAuth() {
    try {
      const stored = await chrome.runtime.sendMessage({ action: 'getAuthToken' });
      if (stored?.token) {
        this.auth = stored;
        this.elements.signInBtn?.classList.add('hidden');
        this.updateAccountStatus();
        return;
      }
      // Try to refresh from an open mnemolog.com tab
      const refreshed = await chrome.runtime.sendMessage({ action: 'refreshAuthFromSite' });
      if (refreshed?.session?.token) {
        this.auth = refreshed.session;
        this.elements.signInBtn?.classList.add('hidden');
        this.updateAccountStatus();
      } else {
        this.elements.signInBtn?.classList.remove('hidden');
        this.updateAccountStatus();
      }
    } catch (e) {
      console.warn('Auth load failed', e);
      this.elements.signInBtn?.classList.remove('hidden');
      this.updateAccountStatus();
    }
  }

  async loadSettings() {
    const defaults = {
      runPiiScan: true,
      alwaysRedact: false,
      defaultVisibility: 'public',
      defaultShowAuthor: true,
      analyticsEnabled: false
    };
    await new Promise((resolve) => {
      chrome.storage.sync.get(['mnemologSettings'], (result) => {
        this.settings = { ...defaults, ...(result.mnemologSettings || {}) };
        this.applySettingsToUI();
        resolve();
      });
    });
  }

  applySettingsToUI() {
    if (this.elements.settingRunPii) this.elements.settingRunPii.checked = !!this.settings.runPiiScan;
    if (this.elements.settingAlwaysRedact) this.elements.settingAlwaysRedact.checked = !!this.settings.alwaysRedact;
    if (this.elements.settingVisibility) this.elements.settingVisibility.value = this.settings.defaultVisibility || 'public';
    if (this.elements.settingShowAuthor) this.elements.settingShowAuthor.checked = !!this.settings.defaultShowAuthor;
    if (this.elements.settingAnalytics) this.elements.settingAnalytics.checked = !!this.settings.analyticsEnabled;
    this.renderTags();
    this.updateAccountStatus();
  }

  saveSettings() {
    this.settings.runPiiScan = !!this.elements.settingRunPii?.checked;
    this.settings.alwaysRedact = !!this.elements.settingAlwaysRedact?.checked;
    this.settings.defaultVisibility = this.elements.settingVisibility?.value || 'public';
    this.settings.defaultShowAuthor = !!this.elements.settingShowAuthor?.checked;
    this.settings.analyticsEnabled = !!this.elements.settingAnalytics?.checked;

    chrome.storage.sync.set({ mnemologSettings: this.settings }, () => {
      this.hideSettings();
    });
  }

  showSettings() {
    this.applySettingsToUI();
    this.elements.settingsPanel?.classList.remove('hidden');
    document.querySelector('.main')?.classList.add('hidden');
    document.querySelector('.footer')?.classList.add('hidden');
  }

  hideSettings() {
    this.elements.settingsPanel?.classList.add('hidden');
    document.querySelector('.main')?.classList.remove('hidden');
    document.querySelector('.footer')?.classList.remove('hidden');
  }

  updateAccountStatus() {
    if (!this.elements.accountStatus) return;
    if (this.auth?.token) {
      this.elements.accountStatus.textContent = 'Signed in';
      this.elements.settingsSignInBtn?.classList.add('hidden');
    } else {
      this.elements.accountStatus.textContent = 'Not signed in';
      this.elements.settingsSignInBtn?.classList.remove('hidden');
    }
  }

  openLogin() {
    // Open login page and try to capture session immediately after
    chrome.tabs.create({ url: 'https://mnemolog.com/login?source=extension' });
    this.updateStatus('signin');
    this.pollForAuth();
  }

  async pollForAuth() {
    // Try to refresh auth a few times after opening login
    for (let i = 0; i < 8; i++) {
      await new Promise(res => setTimeout(res, 2000));
      try {
        const refreshed = await chrome.runtime.sendMessage({ action: 'refreshAuthFromSite' });
        if (refreshed?.session?.token) {
          this.auth = refreshed.session;
          this.elements.signInBtn?.classList.add('hidden');
          this.updateStatus('active');
          return;
        }
      } catch {
        // ignore and retry
      }
    }
  }
  
  async detectConversation() {
    this.setState('empty');
    this.updateStatus('detecting');
    
    try {
      // Get active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab?.id) {
        this.updateStatus('error');
        return;
      }
      
      // Check if we're on a supported platform
      const platform = this.detectPlatform(tab.url);
      
      if (!platform) {
        this.updateStatus('inactive');
        return;
      }
      
      // Request conversation data from content script (inject if missing)
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { action: 'getConversationData' });
      } catch (err) {
        await this.injectPlatformScripts(tab.id, platform);
        try {
          response = await chrome.tabs.sendMessage(tab.id, { action: 'getConversationData' });
        } catch {
          response = null;
        }
      }
      
      if (response?.success && response.data) {
        this.conversationData = response.data;
        if (Array.isArray(this.conversationData.messages)) {
          this.conversationData.messages = this.collapseSameRole(this.conversationData.messages);
        }
        if (!Array.isArray(this.conversationData.tags)) this.conversationData.tags = [];
        this.displayConversation(response.data);
        this.renderTags();
        this.setState('detected');
        this.updateStatus('active');
      } else {
        this.updateStatus('inactive');
      }
      
    } catch (error) {
      console.error('Detection error:', error);
      this.updateStatus('error');
    }
  }

  collapseSameRole(messages = []) {
    const out = [];
    for (const msg of messages) {
      const last = out[out.length - 1];
      if (last && last.role === msg.role) {
        last.content = `${last.content}\n\n${msg.content || ''}`.trim();
      } else {
        out.push({ ...msg });
      }
    }
    return out;
  }

  async injectPlatformScripts(tabId, platform) {
    const platformScripts = {
      claude: ['platforms/claude.js', 'content/content.js'],
      chatgpt: ['platforms/chatgpt.js', 'content/content.js'],
      gemini: ['platforms/gemini.js', 'content/content.js'],
      grok: ['platforms/grok.js', 'content/content.js']
    };
    const files = platformScripts[platform];
    if (!files) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files
      });
    } catch (e) {
      console.warn('Script injection failed', e);
    }
  }
  
  detectPlatform(url) {
    if (!url) return null;
    
    const platforms = {
      'claude.ai': 'claude',
      'chat.openai.com': 'chatgpt',
      'chatgpt.com': 'chatgpt',
      'gemini.google.com': 'gemini',
      'x.com/i/grok': 'grok',
      'grok.x.ai': 'grok',
      'grok.com': 'grok'
    };
    
    for (const [domain, platform] of Object.entries(platforms)) {
      if (url.includes(domain)) return platform;
    }
    
    return null;
  }
  
  displayConversation(data) {
    const { platform, model = {}, title, messages = [], timestamp, attribution = {} } = data;
    
    // Platform info
    const platformInfo = this.elements.platformIcon.parentElement;
    platformInfo.className = `platform-info ${platform}`;
    this.elements.platformName.textContent = this.formatPlatformName(platform);
    
    // Model info
    this.elements.modelName.textContent = model.displayName || 'Unknown Model';
    this.elements.modelId.textContent = model.id || 'Not detected';
    
    // Update verification indicator based on confidence
    const verificationIcon = this.elements.modelBadge.querySelector('.verification-icon');
    if (attribution.confidence === 'verified') {
      verificationIcon.textContent = '✓';
      verificationIcon.title = 'Verified from page data';
    } else if (attribution.confidence === 'inferred') {
      verificationIcon.textContent = '~';
      verificationIcon.title = 'Inferred from context';
    } else {
      verificationIcon.textContent = '?';
      verificationIcon.title = 'User reported';
    }
    
    // Conversation info
    this.elements.conversationTitle.textContent = title || 'Untitled Conversation';
    this.elements.messageCount.textContent = `${messages.length} messages`;
    this.elements.conversationDate.textContent = this.formatDate(timestamp);
    this.elements.timestamp.textContent = timestamp || 'Unknown';
    
    // Attribution
    this.elements.attributionSource.innerHTML = this.formatConfidence(attribution);
    this.renderTags();
  }
  
  formatPlatformName(platform) {
    const names = {
      claude: 'Claude',
      chatgpt: 'ChatGPT',
      gemini: 'Gemini',
      grok: 'Grok'
    };
    return names[platform] || platform;
  }
  
  formatDate(isoString) {
    if (!isoString) return 'Unknown';
    
    try {
      const date = new Date(isoString);
      const now = new Date();
      const diff = now - date;
      
      // Today
      if (diff < 86400000 && date.getDate() === now.getDate()) {
        return 'Today';
      }
      
      // Yesterday
      if (diff < 172800000) {
        return 'Yesterday';
      }
      
      // Within a week
      if (diff < 604800000) {
        return date.toLocaleDateString('en-US', { weekday: 'long' });
      }
      
      // Older
      return date.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
      });
    } catch {
      return 'Unknown';
    }
  }
  
  formatConfidence(attribution) {
    const { confidence, source } = attribution;
    
    const classes = {
      verified: 'confidence-high',
      inferred: 'confidence-medium',
      claimed: 'confidence-low'
    };
    
    const labels = {
      verified: 'Verified',
      inferred: 'Inferred',
      claimed: 'User Reported'
    };
    
    const sources = {
      network_intercept: 'from API response',
      page_state: 'from page state',
      dom_scrape: 'from page element',
      user_reported: 'by user'
    };
    
    return `<span class="${classes[confidence]}">${labels[confidence]}</span>
            <span style="color: var(--text-muted); font-size: 11px;"> ${sources[source] || ''}</span>`;
  }

  renderTags() {
    const list = this.elements.tagList;
    if (!list) return;
    const tags = (this.conversationData && Array.isArray(this.conversationData.tags)) ? this.conversationData.tags : [];
    list.innerHTML = '';
    if (!tags.length) {
      const empty = document.createElement('span');
      empty.className = 'tag-empty';
      empty.textContent = 'No tags yet';
      list.appendChild(empty);
      return;
    }
    tags.forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      const label = document.createElement('span');
      label.textContent = tag;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '×';
      btn.addEventListener('click', () => {
        if (!this.conversationData?.tags) return;
        this.conversationData.tags = this.conversationData.tags.filter(t => t !== tag);
        this.renderTags();
      });
      chip.appendChild(label);
      chip.appendChild(btn);
      list.appendChild(chip);
    });
  }
  
  handleArchiveClick() {
    if (!this.conversationData) return;
    const runPii = this.settings?.runPiiScan !== false;

    if (runPii && window.PIIDetector) {
      this.piiResults = PIIDetector.scanConversation(this.conversationData.messages);
    } else {
      this.piiResults = { totalFindings: 0, byMessage: [] };
    }
    
    if (this.piiResults.totalFindings > 0) {
      if (this.settings?.alwaysRedact) {
        this.redactAndArchive();
        return;
      }
      this.displayPiiWarnings();
      this.setState('pii-review');
    } else {
      // No PII found or scan disabled, proceed directly
      this.archiveConversation(false);
    }
  }
  
  displayPiiWarnings() {
    const { criticalCount, highCount, mediumCount, byMessage } = this.piiResults;
    
    // Update summary counts
    this.elements.piiCritical.querySelector('.stat-count').textContent = criticalCount;
    this.elements.piiHigh.querySelector('.stat-count').textContent = highCount;
    this.elements.piiMedium.querySelector('.stat-count').textContent = mediumCount;
    
    // Show/hide stats based on counts
    this.elements.piiCritical.style.display = criticalCount > 0 ? 'block' : 'none';
    this.elements.piiHigh.style.display = highCount > 0 ? 'block' : 'none';
    this.elements.piiMedium.style.display = mediumCount > 0 ? 'block' : 'none';
    
    // Update header icon based on severity
    const iconContainer = document.querySelector('.pii-icon');
    if (criticalCount > 0) {
      iconContainer.classList.remove('warning');
      iconContainer.classList.add('critical');
    }
    
    // Build findings list
    const findingsHtml = byMessage
      .filter(m => m.findings.length > 0)
      .flatMap(m => m.findings.map(f => `
        <div class="pii-finding">
          <span class="pii-finding-severity ${f.severity}"></span>
          <span class="pii-finding-label">${f.label}</span>
          <span class="pii-finding-value">${f.value}</span>
          <span class="pii-finding-role">${m.role}</span>
        </div>
      `))
      .join('');
    
    this.elements.piiFindings.innerHTML = findingsHtml;
  }
  
  redactAndArchive() {
    if (!this.conversationData || !this.piiResults) return;
    
    // Apply redactions to messages
    this.piiResults.byMessage.forEach(({ messageIndex, findings }) => {
      if (findings.length > 0 && this.conversationData.messages[messageIndex]) {
        const originalContent = this.conversationData.messages[messageIndex].content;
        this.conversationData.messages[messageIndex].content = PIIDetector.redact(originalContent, findings);
        this.conversationData.messages[messageIndex].redacted = true;
      }
    });
    
    this.archiveConversation(true);
  }

  async archiveConversation(wasRedacted = false) {
    if (!this.conversationData) return;
    if (!this.auth?.token) {
      this.updateStatus('signin');
      this.setState('error');
      this.elements.errorMessage.textContent = 'Please sign in at mnemolog.com and try again.';
      return;
    }
    
    this.setState('archiving');
    
    try {
      // Add redaction metadata
      const modelId = this.conversationData.model?.id || this.conversationData.model_id;
      const modelDisplay = this.conversationData.model?.displayName || this.conversationData.model_display_name;
      const platformConversationId = this.conversationData.conversationId || this.conversationData.platform_conversation_id;
      const attribConf = this.conversationData.attribution?.confidence || this.conversationData.attribution_confidence;
      const attribSource = this.conversationData.attribution?.source || this.conversationData.attribution_source;

      const isPublic = this.settings?.defaultVisibility !== 'private';
      const showAuthor = this.settings?.defaultShowAuthor !== false;

      const payload = {
        conversation: {
          ...this.conversationData,
          is_public: this.conversationData.is_public ?? isPublic,
          show_author: this.conversationData.show_author ?? showAuthor,
          model_id: modelId || null,
          model_display_name: modelDisplay || null,
          platform_conversation_id: platformConversationId || null,
          attribution_confidence: attribConf || null,
          attribution_source: attribSource || null,
          pii_redacted: wasRedacted,
          pii_scanned: true
        },
        source: 'extension',
        version: chrome.runtime.getManifest().version
      };
      
      // Send to Mnemolog API
      const response = await fetch('https://mnemolog.com/api/archive', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.auth?.token && { 'Authorization': `Bearer ${this.auth.token}` })
        },
        body: JSON.stringify(payload)
      });

      let result = null;
      try {
        result = await response.json();
      } catch {
        // ignore JSON parse
      }

      if (!response.ok) {
        const statusText = response.statusText || '';
        const errMsg = result?.error || `Archive request failed (${response.status} ${statusText})`;
        console.error('Archive error detail', { status: response.status, statusText, body: result });
        throw new Error(errMsg);
      }

      if (result?.success && result?.url) {
        this.elements.viewLink.href = result.url;
        this.setState('success');
      } else {
        console.error('Archive unexpected response', result);
        throw new Error(result?.error || 'Unknown error');
      }
      
    } catch (error) {
      console.error('Archive error:', error);
      this.elements.errorMessage.textContent = error.message || 'Could not archive conversation.';
      this.setState('error');
    }
  }
  
  openPreview() {
    if (!this.conversationData) return;

    const payload = JSON.stringify(this.conversationData);
    // Persist payload so the share page content script can pick it up
    chrome.storage?.local.set({ mnemolog_preview: payload }, () => {
      chrome.tabs.create({
        url: `https://mnemolog.com/share?source=extension&preview=true`
      });
    });
  }
  
  setState(state) {
    this.currentState = state;
    
    // Hide all states
    const states = ['stateEmpty', 'stateDetected', 'statePiiReview', 'stateArchiving', 'stateSuccess', 'stateError'];
    states.forEach(s => {
      if (this.elements[s]) {
        this.elements[s].classList.add('hidden');
      }
    });
    
    // Show target state
    const stateMap = {
      'empty': this.elements.stateEmpty,
      'detected': this.elements.stateDetected,
      'pii-review': this.elements.statePiiReview,
      'archiving': this.elements.stateArchiving,
      'success': this.elements.stateSuccess,
      'error': this.elements.stateError
    };
    
    stateMap[state]?.classList.remove('hidden');
  }
  
  updateStatus(status) {
    const indicator = this.elements.statusIndicator;
    const text = this.elements.statusText;
    
    indicator.classList.remove('active', 'error');
    
    switch (status) {
      case 'detecting':
        text.textContent = 'Detecting...';
        break;
      case 'active':
        indicator.classList.add('active');
        text.textContent = 'Ready';
        break;
      case 'signin':
        text.textContent = 'Sign in required';
        break;
      case 'inactive':
        text.textContent = 'No conversation';
        break;
      case 'error':
        indicator.classList.add('error');
        text.textContent = 'Error';
        break;
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new MnemologPopup();
});
