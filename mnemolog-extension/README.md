# Mnemolog Chrome Extension

Archive your AI conversations with verified provenance. Your ideas deserve attribution.

## Features

- **One-Click Archiving**: Save conversations from Claude, ChatGPT, Gemini, and Grok directly to Mnemolog
- **Verified Attribution**: Automatically extracts model information, timestamps, and conversation metadata
- **Privacy-First**: Review and redact sensitive information before publishing
- **Provenance Tracking**: Know exactly which model generated each response

## Supported Platforms

| Platform | Model Detection | Status |
|----------|----------------|--------|
| Claude | ✅ DOM + State | Ready |
| ChatGPT | ✅ DOM | Ready |
| Gemini | ✅ DOM | Ready |
| Grok | ✅ DOM | Ready |

## Installation

### From Chrome Web Store (Coming Soon)
1. Visit the Chrome Web Store
2. Search for "Mnemolog"
3. Click "Add to Chrome"

### Manual Installation (Developer Mode)
1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the `mnemolog-extension` folder

## Usage

1. Navigate to a conversation on any supported platform
2. Click the Mnemolog icon in your toolbar
3. Review the detected conversation details
4. Click "Archive to Mnemolog"
5. (Optional) Preview and edit before publishing

## How Attribution Works

The extension attempts to extract model information in order of reliability:

1. **Network Intercept** (highest confidence): Captures API responses containing model IDs
2. **Page State**: Reads from React/framework internal state
3. **DOM Scrape**: Extracts from visible page elements
4. **User Reported** (fallback): Manual selection when auto-detection fails

Each archived conversation includes:
- Model ID and display name
- Attribution confidence level
- Extraction source
- Original timestamp
- Conversation ID

## Privacy

- **No tracking by default**: Analytics are opt-in only
- **Local processing**: All extraction happens in your browser
- **You control what's shared**: Review every conversation before it's archived
- **No API keys stored**: Authentication handled securely through mnemolog.com

## Development

### Project Structure

```
mnemolog-extension/
├── manifest.json        # Extension configuration
├── popup/
│   ├── popup.html      # Popup UI
│   ├── popup.css       # Styles
│   └── popup.js        # Popup logic
├── content/
│   ├── content.js      # Main content script
│   └── content.css     # Injected styles
├── platforms/
│   ├── claude.js       # Claude extractor
│   ├── chatgpt.js      # ChatGPT extractor
│   ├── gemini.js       # Gemini extractor
│   └── grok.js         # Grok extractor
├── background/
│   └── background.js   # Service worker
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

### PII-detection Diagram

User clicks "Archive to Mnemolog"
         ↓
PIIDetector.scanConversation(messages)
         ↓
    ┌────┴────┐
    │         │
No PII     PII Found
    │         │
    ↓         ↓
Archive    Show Review Screen
directly   ├─ Critical: 2
           ├─ High: 3
           ├─ Medium: 1
           │
           ├─ [Redact & Archive] → auto-redacts, then archives
           ├─ [Archive Without Changes] → user accepts risk
           └─ [Edit on Mnemolog →] → opens site for manual review

### Adding New Platforms

1. Create a new extractor in `platforms/newplatform.js`
2. Implement the `MnemologPlatform` interface:
   - `extract()`: Returns conversation data
   - `extractModel()`: Gets model information
   - `extractMessages()`: Parses message content
   - `extractTimestamp()`: Gets conversation time
3. Add the platform to `manifest.json` content_scripts
4. Test thoroughly with various conversation states

### Building for Production

```bash
# Install dependencies (if any)
npm install

# Build (if using bundler)
npm run build

# Package for Chrome Web Store
zip -r mnemolog-extension.zip mnemolog-extension/ -x "*.git*" -x "*.DS_Store"
```

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## License

MIT License - see LICENSE file

## Links

- [Mnemolog](https://mnemolog.com)
- [GitHub](https://github.com/warrofua/mnemolog)
- [Report Issues](https://github.com/warrofua/mnemolog/issues)

---

*Building continuity, together.*
