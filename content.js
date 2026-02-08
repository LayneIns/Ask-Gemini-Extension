(function () {
  "use strict";

  // =====================================================================
  // Configuration
  // =====================================================================

  // Set to true to enable debug logging in the browser console
  const DEBUG = false;

  // Default citation format.  The user can override this via the
  // extension popup (stored in chrome.storage.sync).
  const DEFAULT_CITATION_FORMAT =
    "Regarding the following selected content:\n" +
    "------\n" +
    "[SELECTED]\n" +
    "------\n";

  // Mutable — will be updated from chrome.storage when available.
  let citationFormat = DEFAULT_CITATION_FORMAT;

  // Selectors for Gemini's response containers (tried in order).
  // These identify the area where Gemini's model responses are rendered.
  // If the page DOM changes, update these selectors.
  const RESPONSE_SELECTORS = [
    // Common Gemini response container classes (may change with updates)
    ".model-response-text",
    ".response-container-content",
    ".response-container",
    ".message-content",
    ".markdown-main-panel",
    ".model-response",
    '[data-message-author-role="model"]',
    // Markdown rendered content often lives here
    ".markdown",
    ".markdown-body",
  ];

  // Selectors for the user input area. We use these to:
  //   1. Exclude selections made inside the input from triggering the bubble.
  //   2. Find the input element to inject the selected text into.
  const INPUT_SELECTORS = [
    // Gemini uses a custom <rich-textarea> element
    "rich-textarea .ql-editor",
    "rich-textarea .ProseMirror",
    "rich-textarea [contenteditable='true']",
    "rich-textarea [contenteditable]",
    ".text-input-field [contenteditable='true']",
    ".input-area [contenteditable='true']",
    // Fallback: look for the rich-textarea element itself
    "rich-textarea",
    // Last resort: any contenteditable with specific data attributes
    'div[contenteditable="true"][data-placeholder]',
    // Generic textarea fallback
    "textarea.text-input",
    '.input-area textarea',
    'textarea[aria-label]',
  ];

  // Selectors for areas that should NOT trigger the bubble
  // (i.e., the user's own input area and toolbars/buttons)
  const EXCLUDE_SELECTORS = [
    "rich-textarea",
    ".text-input-field",
    ".input-area-container",
    ".input-area",
    'button',
    '[role="button"]',
    '.toolbar',
    '.action-bar',
  ];

  // =====================================================================
  // Debug Logger
  // =====================================================================

  function log(...args) {
    if (DEBUG) {
      console.log(
        "%c[Ask Gemini]",
        "color: #4285f4; font-weight: bold;",
        ...args
      );
    }
  }

  function warn(...args) {
    if (DEBUG) {
      console.warn(
        "%c[Ask Gemini]",
        "color: #f4b400; font-weight: bold;",
        ...args
      );
    }
  }

  // =====================================================================
  // DOM Helpers & Utilities
  // =====================================================================

  /**
   * Escape HTML special characters in a string.
   */
  function escapeHTML(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Check if the given node (or any of its ancestors) matches any of the
   * provided CSS selectors.
   */
  function isInsideSelector(node, selectors) {
    let el = node;
    // If it's a text node, start from its parent element
    if (el.nodeType === Node.TEXT_NODE) {
      el = el.parentElement;
    }
    if (!el || !(el instanceof Element)) return false;

    for (const selector of selectors) {
      try {
        if (el.matches(selector) || el.closest(selector)) {
          return true;
        }
      } catch (e) {
        // Invalid selector, skip
      }
    }
    return false;
  }

  /**
   * Check if the selected text is within a Gemini response area
   * (and NOT within the user input area).
   */
  function isValidSelectionArea(selection) {
    if (!selection || selection.rangeCount === 0) return false;

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;

    // Exclude selections inside the input area
    if (isInsideSelector(container, EXCLUDE_SELECTORS)) {
      log("Selection is inside an excluded area (input/toolbar).");
      return false;
    }

    // Strategy 1: Check if selection is inside a known response container
    if (isInsideSelector(container, RESPONSE_SELECTORS)) {
      log("Selection is inside a known response container.");
      return true;
    }

    // Strategy 2 (fallback): Accept selection if it's NOT in the input area.
    // This is a broad fallback, but works well in practice since the main
    // non-response area is the input box (which we already excluded above).
    log(
      "Selection is not in a known response container, but also not in " +
      "an excluded area. Accepting as fallback."
    );
    return true;
  }

  /**
   * Find the Gemini input element where we can inject text.
   * Returns the DOM element, or null if not found.
   */
  function findInputElement() {
    for (const selector of INPUT_SELECTORS) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          log("Found input element with selector:", selector, el);
          return el;
        }
      } catch (e) {
        // Invalid selector, skip
      }
    }
    warn("Could not find the Gemini input element with any known selector.");
    return null;
  }

  // =====================================================================
  // Math Extraction
  // =====================================================================

  /**
   * Extract text from a selection, preserving math equations as LaTeX.
   *
   * Gemini renders math using KaTeX, MathJax, or similar libraries.
   * When a user selects rendered math, selection.toString() returns
   * the visual text (e.g., "x²+y²=z²") instead of the original LaTeX.
   * This function walks the selected DOM nodes and replaces math
   * elements with their LaTeX source wrapped in $ or $$.
   */
  function extractTextWithMath(selection) {
    if (!selection || selection.rangeCount === 0) {
      return "";
    }

    try {
      const range = selection.getRangeAt(0);
      const fragment = range.cloneContents();

      // Quick check: are there any math elements in the selection?
      const hasMath =
        fragment.querySelector(
          ".katex, .katex-display, .MathJax, mjx-container, " +
          "math, .math-inline, .math-block"
        ) !== null;

      if (!hasMath) {
        // No math elements — just return the plain text
        return selection.toString().trim();
      }

      log("Math elements detected in selection, extracting LaTeX.");

      // Replace math elements in the cloned fragment with LaTeX text
      replaceMathElements(fragment);

      // Build text from the processed fragment
      return getTextFromFragment(fragment).trim();
    } catch (e) {
      warn("Error extracting math from selection:", e);
      return selection.toString().trim();
    }
  }

  /**
   * Replace math elements in a DOM fragment with text nodes containing
   * the original LaTeX source.
   *
   * Processing order matters: display-math wrappers (which contain
   * inline-math elements) must be handled first.
   */
  function replaceMathElements(root) {
    // 1. KaTeX display math (.katex-display wraps a .katex)
    root.querySelectorAll(".katex-display").forEach(function (el) {
      const annotation = el.querySelector(
        'annotation[encoding="application/x-tex"]'
      );
      if (annotation) {
        el.replaceWith(
          document.createTextNode("$$" + annotation.textContent + "$$")
        );
      }
    });

    // 2. KaTeX inline math (remaining .katex not inside .katex-display)
    root.querySelectorAll(".katex").forEach(function (el) {
      const annotation = el.querySelector(
        'annotation[encoding="application/x-tex"]'
      );
      if (annotation) {
        el.replaceWith(
          document.createTextNode("$" + annotation.textContent + "$")
        );
      }
    });

    // 3. MathJax 3.x (<mjx-container>)
    root.querySelectorAll("mjx-container").forEach(function (el) {
      const isDisplay = el.getAttribute("display") === "block";
      // MathJax may store TeX in a child <script> or in aria-label
      const script = el.querySelector('script[type="math/tex"]');
      let latex = script ? script.textContent : null;
      if (!latex) {
        latex = el.getAttribute("aria-label") || "";
      }
      if (latex) {
        const wrapped = isDisplay ? "$$" + latex + "$$" : "$" + latex + "$";
        el.replaceWith(document.createTextNode(wrapped));
      }
    });

    // 4. MathJax 2.x (.MathJax with a sibling <script type="math/tex">)
    root.querySelectorAll(".MathJax").forEach(function (el) {
      const nextScript =
        el.nextElementSibling &&
        el.nextElementSibling.tagName === "SCRIPT" &&
        (el.nextElementSibling.type || "").indexOf("math/tex") !== -1
          ? el.nextElementSibling
          : null;
      if (nextScript) {
        const isDisplay = (nextScript.type || "").indexOf("display") !== -1;
        const wrapped = isDisplay
          ? "$$" + nextScript.textContent + "$$"
          : "$" + nextScript.textContent + "$";
        el.replaceWith(document.createTextNode(wrapped));
        nextScript.remove();
      }
    });

    // 5. Generic <math> elements (MathML) with a TeX annotation
    root.querySelectorAll("math").forEach(function (el) {
      const annotation = el.querySelector(
        'annotation[encoding="application/x-tex"]'
      );
      if (annotation) {
        const isDisplay = el.getAttribute("display") === "block";
        const wrapped = isDisplay
          ? "$$" + annotation.textContent + "$$"
          : "$" + annotation.textContent + "$";
        el.replaceWith(document.createTextNode(wrapped));
      }
    });

    // 6. Clean up hidden / duplicate math elements that would add
    //    extra text content (e.g., KaTeX's hidden MathML copy)
    root
      .querySelectorAll(".katex-mathml, .MathJax_Preview")
      .forEach(function (el) {
        el.remove();
      });
  }

  /**
   * Convert an HTML <table> element into a Markdown table string.
   */
  function tableToMarkdown(tableEl) {
    const rows = tableEl.querySelectorAll("tr");
    if (rows.length === 0) return "";

    const matrix = [];
    rows.forEach(function (tr) {
      const cells = tr.querySelectorAll("th, td");
      const row = [];
      cells.forEach(function (cell) {
        // Get the cell's text, trimming whitespace and collapsing
        // internal newlines to spaces so the table cell stays on one line.
        const cellText = getTextFromFragment(cell)
          .trim()
          .replace(/\n+/g, " ");
        row.push(cellText);
      });
      matrix.push(row);
    });

    if (matrix.length === 0) return "";

    // Determine column count (max across all rows)
    let colCount = 0;
    matrix.forEach(function (row) {
      if (row.length > colCount) colCount = row.length;
    });

    // Pad short rows
    matrix.forEach(function (row) {
      while (row.length < colCount) row.push("");
    });

    // Compute max width per column (at least 3 for the separator)
    const widths = [];
    for (let c = 0; c < colCount; c++) {
      let max = 3;
      matrix.forEach(function (row) {
        if (row[c].length > max) max = row[c].length;
      });
      widths.push(max);
    }

    // Helper: pad string to width
    function pad(s, w) {
      while (s.length < w) s += " ";
      return s;
    }

    // Build the header row (first row of the matrix)
    const header = matrix[0];
    const headerLine =
      "| " +
      header.map(function (cell, i) { return pad(cell, widths[i]); }).join(" | ") +
      " |";

    // Separator row
    const sepLine =
      "| " +
      widths.map(function (w) { return "-".repeat(w); }).join(" | ") +
      " |";

    // Data rows
    const dataLines = matrix.slice(1).map(function (row) {
      return (
        "| " +
        row.map(function (cell, i) { return pad(cell, widths[i]); }).join(" | ") +
        " |"
      );
    });

    return [headerLine, sepLine].concat(dataLines).join("\n");
  }

  /**
   * Build a text string from a DOM node / fragment, inserting newlines
   * at block-element boundaries so the output reads naturally.
   * Tables are converted to Markdown format.
   */
  function getTextFromFragment(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }

    if (
      node.nodeType !== Node.ELEMENT_NODE &&
      node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
    ) {
      return "";
    }

    const tag = node.tagName ? node.tagName.toLowerCase() : "";

    // <table> → Markdown table
    if (tag === "table") {
      return "\n" + tableToMarkdown(node) + "\n";
    }

    // <br> → newline
    if (tag === "br") {
      return "\n";
    }

    // Skip invisible elements
    if (tag === "style" || tag === "script") {
      return "";
    }

    let result = "";
    for (let i = 0; i < node.childNodes.length; i++) {
      result += getTextFromFragment(node.childNodes[i]);
    }

    // Append a newline after block-level elements if not already present
    const BLOCK_TAGS = [
      "p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
      "li", "blockquote", "pre", "hr",
      "section", "article",
    ];
    if (BLOCK_TAGS.indexOf(tag) !== -1 && result && !result.endsWith("\n")) {
      result += "\n";
    }

    return result;
  }

  // =====================================================================
  // Text Injection
  // =====================================================================

  /**
   * Inject the formatted text into the Gemini input box.
   *
   * The text is formatted according to citationFormat (loaded from
   * chrome.storage or the DEFAULT_CITATION_FORMAT fallback).  The
   * [SELECTED] placeholder is replaced with the user's selected text.
   * The cursor is placed on the trailing empty line so the user can
   * start typing immediately.
   *
   * We try multiple strategies to support different input implementations.
   */
  function injectTextToInput(text) {
    const inputEl = findInputElement();
    if (!inputEl) {
      warn("Cannot inject text: input element not found.");
      alert(
        "Ask Gemini: Could not find the input box. " +
        "The page structure may have changed. " +
        "Please copy the text manually."
      );
      return false;
    }

    const formattedText = citationFormat.replace("[SELECTED]", text);

    // Strategy 1: contenteditable element (Quill / ProseMirror / plain)
    if (
      inputEl.getAttribute("contenteditable") === "true" ||
      inputEl.isContentEditable
    ) {
      return injectIntoContentEditable(inputEl, formattedText);
    }

    // Strategy 2: <rich-textarea> custom element
    // Try to find the inner contenteditable or fall back to properties
    if (inputEl.tagName && inputEl.tagName.toLowerCase() === "rich-textarea") {
      return injectIntoRichTextarea(inputEl, formattedText);
    }

    // Strategy 3: Standard <textarea>
    if (
      inputEl.tagName &&
      inputEl.tagName.toLowerCase() === "textarea"
    ) {
      return injectIntoTextarea(inputEl, formattedText);
    }

    warn("Unknown input element type:", inputEl.tagName);
    return false;
  }

  /**
   * Inject text into a contenteditable element.
   *
   * We avoid execCommand("insertText") for multi-line content because
   * many contenteditable implementations (including Gemini's) silently
   * strip newlines and only keep the first line. Instead, we build
   * proper paragraph HTML and set it directly.
   */
  function injectIntoContentEditable(el, text) {
    log("Injecting into contenteditable element.");
    el.focus();

    // Build HTML from the text lines.
    // Each line becomes a <p> element so multi-paragraph content is
    // faithfully preserved.
    const lines = text.split("\n");
    const html = lines
      .map((line) => {
        if (line === "") return "<p><br></p>";
        return "<p>" + escapeHTML(line) + "</p>";
      })
      .join("");

    // Strategy 1: Use execCommand to clear + insert HTML.
    // execCommand dispatches the right internal events for most
    // frameworks (React, Angular, Lit, etc.).
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    const success = document.execCommand("insertHTML", false, html);

    if (!success) {
      // Strategy 2: Directly write innerHTML and manually fire an
      // input event so the framework detects the change.
      log("execCommand insertHTML failed, falling back to innerHTML");
      el.innerHTML = html;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Place cursor at the end
    placeCursorAtEnd(el);

    log("Text injected into contenteditable successfully.");
    return true;
  }

  /**
   * Inject text into a <rich-textarea> custom element.
   */
  function injectIntoRichTextarea(richTextarea, text) {
    log("Injecting into <rich-textarea> element.");

    // Try to find the inner editable element
    const innerSelectors = [
      ".ql-editor",
      ".ProseMirror",
      '[contenteditable="true"]',
      "[contenteditable]",
    ];

    for (const selector of innerSelectors) {
      const inner = richTextarea.querySelector(selector);
      if (inner) {
        log("Found inner editable element:", selector);
        return injectIntoContentEditable(inner, text);
      }
    }

    // Try shadow DOM
    if (richTextarea.shadowRoot) {
      for (const selector of innerSelectors) {
        const inner = richTextarea.shadowRoot.querySelector(selector);
        if (inner) {
          log("Found inner editable element in shadow DOM:", selector);
          return injectIntoContentEditable(inner, text);
        }
      }
    }

    // Last resort: try setting .value property (some custom elements use this)
    if ("value" in richTextarea) {
      log("Trying .value property on rich-textarea.");
      richTextarea.value = text;
      richTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      richTextarea.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    warn("Could not find editable surface inside <rich-textarea>.");
    return false;
  }

  /**
   * Inject text into a standard <textarea> element.
   */
  function injectIntoTextarea(textarea, text) {
    log("Injecting into <textarea> element.");
    textarea.focus();
    textarea.value = text;

    // Dispatch events so the framework detects the change
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));

    // Place cursor at the end
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;

    log("Text injected into textarea successfully.");
    return true;
  }

  /**
   * Place the cursor at the end of a contenteditable element.
   */
  function placeCursorAtEnd(el) {
    const range = document.createRange();
    const sel = window.getSelection();

    // Try to place the cursor inside the last child element (usually
    // the trailing empty <p><br></p>) so the user can start typing on
    // the new line after the citation block.
    const lastChild = el.lastElementChild || el.lastChild;
    if (lastChild) {
      range.selectNodeContents(lastChild);
      range.collapse(false);
    } else {
      range.selectNodeContents(el);
      range.collapse(false);
    }

    sel.removeAllRanges();
    sel.addRange(range);
    el.focus();
  }

  // =====================================================================
  // Bubble UI
  // =====================================================================

  let bubbleEl = null;
  let currentSelectedText = "";

  /**
   * Create the floating bubble element (once).
   */
  function createBubble() {
    if (bubbleEl) return bubbleEl;

    bubbleEl = document.createElement("div");
    bubbleEl.id = "ask-gemini-bubble";
    bubbleEl.setAttribute("role", "button");
    bubbleEl.setAttribute("tabindex", "0");

    // Icon (sparkle/diamond shape to match Gemini branding)
    const icon = document.createElement("span");
    icon.className = "ask-gemini-bubble-icon";
    icon.innerHTML = "&#10024;"; // sparkle emoji as icon

    // Label
    const label = document.createElement("span");
    label.className = "ask-gemini-bubble-label";
    label.textContent = "Ask Gemini";

    bubbleEl.appendChild(icon);
    bubbleEl.appendChild(label);

    // Click handler
    bubbleEl.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      handleBubbleClick();
    });

    // Keyboard accessibility
    bubbleEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleBubbleClick();
      }
    });

    // Prevent the bubble click from clearing the selection
    bubbleEl.addEventListener("mousedown", function (e) {
      e.preventDefault();
      e.stopPropagation();
    });

    document.body.appendChild(bubbleEl);
    log("Bubble element created.");

    return bubbleEl;
  }

  /**
   * Show the bubble near the given bounding rect of the selection.
   */
  function showBubble(rect) {
    const bubble = createBubble();

    // Position the bubble above the selection, centered horizontally
    const bubbleWidth = 130; // approximate width
    const bubbleHeight = 36; // approximate height
    const gap = 8; // gap between selection and bubble

    let top = rect.top - bubbleHeight - gap + window.scrollY;
    let left =
      rect.left + rect.width / 2 - bubbleWidth / 2 + window.scrollX;

    // Ensure the bubble stays within viewport bounds
    const viewportWidth = window.innerWidth;
    if (left < 8) left = 8;
    if (left + bubbleWidth > viewportWidth - 8) {
      left = viewportWidth - bubbleWidth - 8;
    }

    // If not enough room above, show below
    if (top < window.scrollY + 8) {
      top = rect.bottom + gap + window.scrollY;
    }

    bubble.style.top = top + "px";
    bubble.style.left = left + "px";
    bubble.classList.add("ask-gemini-bubble-visible");

    log("Bubble shown at", { top, left });
  }

  /**
   * Hide the bubble.
   */
  function hideBubble() {
    if (bubbleEl) {
      bubbleEl.classList.remove("ask-gemini-bubble-visible");
      log("Bubble hidden.");
    }
  }

  /**
   * Handle the bubble click: inject text into the input box.
   */
  function handleBubbleClick() {
    log("Bubble clicked. Selected text:", currentSelectedText);

    if (!currentSelectedText) {
      warn("No text selected.");
      hideBubble();
      return;
    }

    const success = injectTextToInput(currentSelectedText);

    if (success) {
      log("Text successfully injected into input.");
    } else {
      warn("Failed to inject text into input.");
    }

    // Clear selection and hide bubble
    window.getSelection().removeAllRanges();
    hideBubble();
    currentSelectedText = "";
  }

  // =====================================================================
  // Event Handlers
  // =====================================================================

  /**
   * Handle mouseup: check if there's a valid text selection and show the bubble.
   */
  function handleMouseUp(e) {
    // Ignore if the click is on the bubble itself
    if (bubbleEl && bubbleEl.contains(e.target)) {
      return;
    }

    // Small delay to let the browser finalize the selection
    setTimeout(function () {
      const selection = window.getSelection();
      const text = selection ? extractTextWithMath(selection) : "";

      if (!text) {
        hideBubble();
        currentSelectedText = "";
        return;
      }

      // Check if the selection is in a valid area (response, not input)
      if (!isValidSelectionArea(selection)) {
        log("Selection is not in a valid area.");
        hideBubble();
        currentSelectedText = "";
        return;
      }

      currentSelectedText = text;
      log("Valid text selected:", text.substring(0, 80) + "...");

      // Get the bounding rect of the selection
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      showBubble(rect);
    }, 10);
  }

  /**
   * Handle mousedown: hide the bubble if clicking outside of it.
   */
  function handleMouseDown(e) {
    if (bubbleEl && !bubbleEl.contains(e.target)) {
      hideBubble();
    }
  }

  /**
   * Handle scroll: hide the bubble to avoid mispositioned overlays.
   */
  function handleScroll() {
    hideBubble();
  }

  /**
   * Handle keydown: hide the bubble on Escape key.
   */
  function handleKeyDown(e) {
    if (e.key === "Escape") {
      hideBubble();
      window.getSelection().removeAllRanges();
      currentSelectedText = "";
    }
  }

  // =====================================================================
  // Settings (chrome.storage)
  // =====================================================================

  /**
   * Load the user's citation format from chrome.storage.sync.
   * Falls back to DEFAULT_CITATION_FORMAT if nothing is stored.
   */
  function loadCitationFormat() {
    if (typeof chrome === "undefined" || !chrome.storage) {
      log("chrome.storage not available; using default citation format.");
      return;
    }
    chrome.storage.sync.get({ citationFormat: DEFAULT_CITATION_FORMAT }, function (items) {
      citationFormat = items.citationFormat || DEFAULT_CITATION_FORMAT;
      log("Loaded citation format from storage:", citationFormat);
    });
  }

  // =====================================================================
  // Initialization
  // =====================================================================

  function init() {
    // Load citation format from chrome.storage.sync
    loadCitationFormat();

    // Listen for changes (e.g., user updates the format from the popup)
    if (typeof chrome !== "undefined" && chrome.storage) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === "sync" && changes.citationFormat) {
          citationFormat =
            changes.citationFormat.newValue || DEFAULT_CITATION_FORMAT;
          log("Citation format updated from storage:", citationFormat);
        }
      });
    }

    // Register event listeners
    document.addEventListener("mouseup", handleMouseUp, true);
    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("keydown", handleKeyDown, true);

    // Hide bubble on scroll (the conversation panel may scroll independently)
    // Use capture phase to catch scroll events on any scrollable container
    document.addEventListener("scroll", handleScroll, true);

    log("Ask Gemini extension initialized.");

    if (DEBUG) {
      // Debug helper: dump DOM info for the response and input areas
      console.groupCollapsed(
        "%c[Ask Gemini] DOM Debug Info",
        "color: #4285f4; font-weight: bold;"
      );

      console.log("Checking response selectors:");
      RESPONSE_SELECTORS.forEach(function (sel) {
        const el = document.querySelector(sel);
        console.log("  " + sel + ":", el ? "FOUND" : "not found");
      });

      console.log("Checking input selectors:");
      INPUT_SELECTORS.forEach(function (sel) {
        const el = document.querySelector(sel);
        console.log("  " + sel + ":", el ? "FOUND" : "not found");
      });

      console.groupEnd();
    }
  }

  // Wait for the page to finish loading, then initialize.
  // Gemini is a SPA, so the DOM may not be ready immediately.
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }
})();
