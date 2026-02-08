# Ask Gemini — Chrome Extension

Select any text from a Gemini response, attach it as a **quote chip** above
the input box, type your follow-up question, and send — the extension
composes the full cited message for you automatically.

## Features

| Feature | Description |
|---|---|
| **Selection Bubble** | A floating "✨ Ask Gemini" button appears when you highlight text in a Gemini response. |
| **Quote Chip** | Clicking the bubble attaches the selected text as a compact chip above the input box, so you can see what you're referencing while you type. |
| **Composed Send** | When you press Enter or click Send, the extension intercepts, composes the full message (citation template + your input), injects it, and sends — all in one action. |
| **Configurable Format** | Click the extension icon in the Chrome toolbar to customise the citation template. Uses `[SELECTED]` as the placeholder. |
| **Math Equations** | LaTeX source is preserved when selecting rendered KaTeX equations. Gemini's `data-math` attributes, KaTeX annotations, and MathJax formats are all supported. Inline math → `$...$`, display math → `$$...$$`. |
| **Tables** | Selected HTML tables are converted to Markdown table syntax. |
| **Dark Mode** | Adapts to both light and dark themes (`prefers-color-scheme` and Gemini's own dark-mode classes). |
| **Accessibility** | Keyboard support (Enter/Space to activate, Escape to dismiss) and proper ARIA roles. |
| **Debug Mode** | Set `DEBUG = true` in `content.js` for detailed console logging. |

## Quick Start

1. Open `chrome://extensions/` and enable **Developer Mode**.
2. Click **Load unpacked** and select this folder.
3. Go to [gemini.google.com](https://gemini.google.com).
4. Select any text in a Gemini response — the ✨ **Ask Gemini** bubble appears.
5. Click the bubble — a **quote chip** appears above the input box showing the
   selected content.
6. Type your follow-up question and press **Enter**. The extension sends:

```
Regarding the following selected content:
------
<selected text, with LaTeX preserved>
------
<your follow-up question>
```

## Customising the Citation Format

1. Click the **Ask Gemini** icon in the Chrome toolbar.
2. Edit the format string in the popup. Use `[SELECTED]` where the selected
   text should appear, and `\n` for newlines.
3. Click **Save**. The new format takes effect immediately — no reload needed.

Examples:

| Format string | Result |
|---|---|
| `Regarding the following selected content:\n------\n[SELECTED]\n------\n` | *(default)* |
| `Explain this:\n[SELECTED]` | Simpler prompt |
| `Translate to Chinese:\n[SELECTED]` | Translation prompt |

## File Structure

```
Ask-Gemini-Extension/
├── manifest.json   Extension manifest (Manifest V3)
├── content.js      Content script — selection detection, math extraction,
│                     quote chip, send interception, bubble UI
├── styles.css      Bubble + quote chip styles (light + dark mode)
├── popup.html      Settings popup markup
├── popup.js        Settings popup logic (load / save / reset)
├── popup.css       Settings popup styles
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## How It Works

### Content Script (`content.js`)

The script is organised into these sections:

1. **Configuration** — DOM selectors for response / input / exclude / send
   areas, default citation format, debug flag, and quote-chip state.
2. **Debug Logger** — Conditional `console.log` / `console.warn` helpers.
3. **DOM Helpers** — Selector matching, selection validation, input element
   lookup, HTML escaping.
4. **Math Extraction** — `extractTextWithMath()` detects math in the original
   DOM via `data-math` attributes (Gemini-specific) and falls back to KaTeX
   annotations, MathJax, and MathML. `annotateMathFromOriginalDOM()` handles
   orphaned KaTeX spans that lose their parent when cloned.
   `replaceMathElements()` swaps rendered math elements for LaTeX source text.
   `tableToMarkdown()` converts `<table>` to Markdown.
   `getTextFromFragment()` builds clean text with proper block-element newlines.
5. **Text Injection** — Multi-strategy injection into Gemini's input
   (contenteditable → rich-textarea → textarea), with `placeCursorAtEnd()`.
   `injectFormattedText()` injects pre-composed text.
   `getUserInput()` reads the current user-typed text.
   `findSendButton()` locates Gemini's send button.
6. **Bubble UI** — Creates, positions, shows, and hides the floating
   "Ask Gemini" button that appears near selected text.
7. **Quote Chip UI** — Creates, positions, and manages a persistent chip
   above the input area showing the quoted content. Uses readable display
   text (not raw LaTeX) for the preview.
8. **Send Interception** — `composeAndSend()` builds the full message from
   the citation template + user input, injects it, and re-triggers send.
   Intercepts both Enter key and send-button clicks in the capture phase.
9. **Event Handlers** — `mouseup` (selection detection), `mousedown` /
   `scroll` / `keydown` (dismiss bubble), `resize` (reposition chip).
10. **Settings** — Loads and live-updates the citation format from
    `chrome.storage.sync`.
11. **Initialisation** — Registers listeners once the page is ready.

### Settings Popup (`popup.html` / `popup.js`)

A small panel shown when the user clicks the extension icon. It reads /
writes `citationFormat` to `chrome.storage.sync`. The content script
listens for `chrome.storage.onChanged` events and picks up new values
immediately.

## Debugging

1. Set `DEBUG = true` at the top of `content.js`.
2. Reload the extension (`chrome://extensions/` → refresh icon).
3. Open DevTools (F12) on the Gemini page and check the **Console** tab for
   messages prefixed with `[Ask Gemini]`.

## Troubleshooting

| Problem | Fix |
|---|---|
| Bubble doesn't appear | Verify you're on `https://gemini.google.com/*` and the extension is enabled. Enable debug mode and check the console. |
| Quote chip misaligned | Gemini may have changed its input area structure. Inspect the `<input-area-v2>` element and update `positionChip()` in `content.js`. |
| Text not injected on send | Gemini may have changed its DOM. Inspect the input element and update `INPUT_SELECTORS` / `SEND_BUTTON_SELECTORS` in `content.js`. |
| Math shows as visual text instead of LaTeX | The math renderer may use a format not yet handled. Enable debug mode and file an issue with the HTML of the math element. |
| Table formatting looks wrong | Very complex tables (merged cells, nested tables) may not convert perfectly. |

### Updating Selectors

If Google updates Gemini's page structure:

1. Open DevTools and inspect the **response container** — note its class names.
2. Inspect the **input box** — find the `contenteditable` element and the
   `<input-area-v2>` visual container.
3. Inspect the **send button** — note its `aria-label`.
4. Update `RESPONSE_SELECTORS` / `INPUT_SELECTORS` / `EXCLUDE_SELECTORS` /
   `SEND_BUTTON_SELECTORS` in `content.js` and reload the extension.

## License

MIT
