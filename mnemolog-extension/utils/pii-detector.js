// Mnemolog PII Detection Module

const PIIDetector = {
  patterns: {
    // Contact Info
    email: {
      regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      label: 'Email address',
      severity: 'high'
    },
    phone: {
      regex: /(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g,
      label: 'Phone number',
      severity: 'high'
    },
    
    // Financial
    creditCard: {
      regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
      label: 'Credit card number',
      severity: 'critical'
    },
    ssn: {
      regex: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
      label: 'Social Security Number',
      severity: 'critical'
    },
    bankAccount: {
      regex: /\b\d{8,17}\b/g,
      label: 'Possible bank account',
      severity: 'medium',
      contextRequired: ['account', 'routing', 'bank', 'iban']
    },
    
    // Location
    address: {
      regex: /\d{1,5}\s+[\w\s]{1,30}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl)\.?(?:\s+(?:apt|apartment|unit|suite|ste)\.?\s*#?\s*\w+)?/gi,
      label: 'Street address',
      severity: 'high'
    },
    zipCode: {
      regex: /\b\d{5}(?:-\d{4})?\b/g,
      label: 'ZIP code',
      severity: 'low',
      contextRequired: ['address', 'zip', 'postal', 'mail']
    },
    
    // Identity
    passport: {
      regex: /\b[A-Z]{1,2}\d{6,9}\b/g,
      label: 'Possible passport number',
      severity: 'high',
      contextRequired: ['passport']
    },
    driversLicense: {
      regex: /\b[A-Z]\d{7,8}\b/g,
      label: 'Possible driver\'s license',
      severity: 'high',
      contextRequired: ['license', 'driver', 'dmv', 'dl']
    },
    
    // Tech/API
    apiKey: {
      regex: /\b(?:sk|pk|api|key|token|secret|auth)[-_]?[a-zA-Z0-9]{20,}\b/gi,
      label: 'API key or token',
      severity: 'critical'
    },
    awsKey: {
      regex: /\b(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}\b/g,
      label: 'AWS access key',
      severity: 'critical'
    },
    privateKey: {
      regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
      label: 'Private key',
      severity: 'critical'
    },
    
    // Personal identifiers
    ipAddress: {
      regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
      label: 'IP address',
      severity: 'medium'
    },
    dateOfBirth: {
      regex: /\b(?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])[-/](?:19|20)\d{2}\b/g,
      label: 'Date of birth',
      severity: 'medium',
      contextRequired: ['birth', 'born', 'dob', 'birthday']
    }
  },

  /**
   * Scan text for PII
   * @param {string} text - Text to scan
   * @returns {Array} Array of detected PII items
   */
  scan(text) {
    const findings = [];
    
    for (const [type, config] of Object.entries(this.patterns)) {
      const matches = text.matchAll(config.regex);
      
      for (const match of matches) {
        // If context is required, check surrounding text
        if (config.contextRequired) {
          const surroundingText = this.getSurroundingText(text, match.index, 50).toLowerCase();
          const hasContext = config.contextRequired.some(keyword => 
            surroundingText.includes(keyword)
          );
          if (!hasContext) continue;
        }
        
        // Skip common false positives
        if (this.isFalsePositive(type, match[0], text, match.index)) continue;
        
        findings.push({
          type,
          label: config.label,
          severity: config.severity,
          value: this.maskValue(match[0]),
          rawValue: match[0],
          index: match.index,
          length: match[0].length
        });
      }
    }
    
    // Deduplicate overlapping matches
    return this.deduplicateFindings(findings);
  },

  /**
   * Scan all messages in a conversation
   * @param {Array} messages - Array of message objects with content
   * @returns {Object} Findings grouped by message index
   */
  scanConversation(messages) {
    const results = {
      totalFindings: 0,
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      byMessage: []
    };
    
    messages.forEach((message, index) => {
      const findings = this.scan(message.content || '');
      
      results.byMessage.push({
        messageIndex: index,
        role: message.role,
        findings
      });
      
      findings.forEach(f => {
        results.totalFindings++;
        switch (f.severity) {
          case 'critical': results.criticalCount++; break;
          case 'high': results.highCount++; break;
          case 'medium': results.mediumCount++; break;
          case 'low': results.lowCount++; break;
        }
      });
    });
    
    return results;
  },

  /**
   * Get text surrounding a match for context analysis
   */
  getSurroundingText(text, index, radius) {
    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + radius);
    return text.slice(start, end);
  },

  /**
   * Check for common false positives
   */
  isFalsePositive(type, value, text, index) {
    // ZIP codes that are likely years
    if (type === 'zipCode') {
      const num = parseInt(value);
      if (num >= 1900 && num <= 2100) return true;
    }
    
    // IP addresses that are version numbers
    if (type === 'ipAddress') {
      const surrounding = this.getSurroundingText(text, index, 20).toLowerCase();
      if (surrounding.includes('version') || surrounding.includes('v.')) return true;
    }
    
    // Phone numbers that are too short or look like IDs
    if (type === 'phone') {
      const digitsOnly = value.replace(/\D/g, '');
      if (digitsOnly.length < 10) return true;
    }
    
    // Bank account numbers that are too short
    if (type === 'bankAccount') {
      const digitsOnly = value.replace(/\D/g, '');
      if (digitsOnly.length < 10) return true;
    }
    
    return false;
  },

  /**
   * Mask sensitive value for display
   */
  maskValue(value) {
    if (value.length <= 4) return '****';
    if (value.length <= 8) return value.slice(0, 2) + '***' + value.slice(-2);
    return value.slice(0, 4) + '...' + value.slice(-4);
  },

  /**
   * Remove overlapping findings, keeping the most severe
   */
  deduplicateFindings(findings) {
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    
    // Sort by position, then by severity
    findings.sort((a, b) => {
      if (a.index !== b.index) return a.index - b.index;
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
    
    // Remove overlapping matches
    const filtered = [];
    let lastEnd = -1;
    
    for (const finding of findings) {
      if (finding.index >= lastEnd) {
        filtered.push(finding);
        lastEnd = finding.index + finding.length;
      }
    }
    
    return filtered;
  },

  /**
   * Redact PII from text
   */
  redact(text, findings) {
    let redacted = text;
    
    // Process in reverse order to maintain indices
    const sorted = [...findings].sort((a, b) => b.index - a.index);
    
    for (const finding of sorted) {
      const replacement = `[${finding.label.toUpperCase()} REDACTED]`;
      redacted = redacted.slice(0, finding.index) + replacement + redacted.slice(finding.index + finding.length);
    }
    
    return redacted;
  },

  /**
   * Get severity color for UI
   */
  getSeverityColor(severity) {
    const colors = {
      critical: '#DC2626', // red-600
      high: '#EA580C',     // orange-600
      medium: '#CA8A04',   // yellow-600
      low: '#6B7280'       // gray-500
    };
    return colors[severity] || colors.low;
  }
};

// Export for use in extension
if (typeof window !== 'undefined') {
  window.PIIDetector = PIIDetector;
}

if (typeof module !== 'undefined') {
  module.exports = PIIDetector;
}
