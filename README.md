# Ask Gemini — Chrome Extension

Select any text from a Gemini response and instantly ask a follow-up question
about it, just like ChatGPT's "Ask ChatGPT" feature.

## Features

| Feature | Description |
|---|---|
| **Selection Bubble** | A floating "Ask Gemini" button appears when you highlight text in a Gemini response. |
| **One-Click Citation** | Clicking the bubble injects the selected text into the input box with a configurable citation format. The cursor lands on a new line, ready for your follow-up. |
| **Configurable Format** | Click the extension icon in the Chrome toolbar to customise how cited text is wrapped. Uses `[SELECTED]` as the placeholder. |
| **Math Equations** | LaTeX source is preserved when selecting rendered KaTeX / MathJax / MathML formulas. Inline math becomes `$...$`, display math `$$...$$`. |
| **Tables** | Selected HTML tables are converted to Markdown table syntax. |
| **Dark Mode** | Adapts to both light and dark themes (`prefers-color-scheme` and Gemini's own dark-mode classes). |
| **Accessibility** | Keyboard support (Enter/Space to activate, Escape to dismiss) and proper ARIA roles. |
| **Debug Mode** | Set `DEBUG = true` in `content.js` for detailed console logging. |

## Quick Start

1. Open `chrome://extensions/` and enable **Developer Mode**.
2. Click **Load unpacked** and select this folder.
3. Go to [gemini.google.com](https://gemini.google.com).
4. Select any text in a Gemini response — the ✨ **Ask Gemini** bubble appears.
5. Click it. The selected text is injected into the input box:

```
Regarding the following selected content:
------
<your selected text>
------
<cursor is here — type your follow-up>
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
ask_gemini/
├── manifest.json        # Extension manifest (Manifest V3)
├── content.js           # Content script — selection detection, text
│                        #   extraction (math, tables), injection, bubble UI
├── styles.css           # Floating bubble styles (light + dark mode)
├── popup.html           # Settings popup markup
├── popup.js             # Settings popup logic (load / save / reset)
├── popup.css            # Settings popup styles
├── generate_icons.py    # Generates PNG icons (stdlib only, no PIL)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## How It Works

### Content Script (`content.js`)

The script is organised into these sections:

1. **Configuration** — DOM selectors for response / input / exclude areas,
   default citation format, debug flag.
2. **Debug Logger** — Conditional `console.log` / `console.warn` helpers.
3. **DOM Helpers** — Selector matching, selection validation, input element
   lookup, HTML escaping.
4. **Content Extraction** — `extractTextWithMath()` walks the selected DOM
   fragment; `replaceMathElements()` swaps rendered math for LaTeX source;
   `tableToMarkdown()` converts `<table>` to Markdown; `getTextFromFragment()`
   builds clean text with proper block-element newlines.
5. **Text Injection** — Multi-strategy injection into Gemini's input
   (contenteditable → rich-textarea → textarea), with `placeCursorAtEnd()`.
6. **Bubble UI** — Creates, positions, shows, and hides the floating button.
7. **Event Handlers** — `mouseup` (selection detection), `mousedown` /
   `scroll` / `keydown` (dismiss bubble).
8. **Settings** — Loads and live-updates the citation format from
   `chrome.storage.sync`.
9. **Initialisation** — Registers listeners once the page is ready.

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
| Text not injected | Gemini may have changed its DOM. Inspect the input element and update `INPUT_SELECTORS` in `content.js`. |
| Math shows as visual text instead of LaTeX | The math renderer may use a format not yet handled. File an issue with the HTML of the math element. |
| Table formatting looks wrong | Very complex tables (merged cells, nested tables) may not convert perfectly. |

### Updating Selectors

If Google updates Gemini's page structure:

1. Open DevTools and inspect the **response container** — note its class names.
2. Inspect the **input box** — find the `contenteditable` element.
3. Update `RESPONSE_SELECTORS` / `INPUT_SELECTORS` / `EXCLUDE_SELECTORS` in
   `content.js` and reload the extension.

## License

MIT
