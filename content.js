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

  // Quote chip state
  let quotedText = "";
  let quotedDisplayText = "";
  let chipEl = null;
  let isBypassingSend = false;

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

  // Selectors for the send button
  const SEND_BUTTON_SELECTORS = [
    'button[aria-label="Send message"]',
    'button[aria-label="Send"]',
    '.send-button',
    'button[data-test-id="send-button"]',
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

      // ── Phase 0: Check if the selection is entirely inside a single
      //    math element in the ORIGINAL DOM.  When the user drags across
      //    a rendered equation, cloneContents() only copies the inner
      //    KaTeX spans and loses the parent [data-math] wrapper.  We
      //    detect this here and grab the LaTeX directly. ──
      var ancestor = range.commonAncestorContainer;
      if (ancestor.nodeType === Node.TEXT_NODE) {
        ancestor = ancestor.parentElement;
      }

      if (ancestor) {
        var mathParent = ancestor.closest
          ? (ancestor.closest("[data-math]") ||
             ancestor.closest(".math-block") ||
             ancestor.closest(".math-inline"))
          : null;

        if (mathParent && mathParent.getAttribute("data-math")) {
          var latex = mathParent.getAttribute("data-math");
          var isBlock = mathParent.classList.contains("math-block");
          log("Selection is inside a data-math element, using LaTeX directly.");
          return isBlock ? "$$" + latex + "$$" : "$" + latex + "$";
        }
      }

      // ── Phase 1: Clone and process the fragment ──
      const fragment = range.cloneContents();

      // Quick check: are there any math elements in the selection?
      const hasMath =
        fragment.querySelector(
          ".katex, .katex-display, .MathJax, mjx-container, " +
          "math, .math-inline, .math-block, [data-math]"
        ) !== null;

      if (!hasMath) {
        // No math elements — just return the plain text
        return selection.toString().trim();
      }

      log("Math elements detected in selection, extracting LaTeX.");

      // ── Phase 2: For orphaned KaTeX elements in the fragment (no
      //    data-math parent), try to find the corresponding math
      //    element in the ORIGINAL DOM and annotate the fragment. ──
      annotateMathFromOriginalDOM(fragment, range);

      // Replace math elements in the cloned fragment with LaTeX text
      replaceMathElements(fragment);

      // Build text from the processed fragment
      var raw = getTextFromFragment(fragment).trim();

      // Collapse excessive blank lines that remain after math replacement
      raw = raw.replace(/\n{3,}/g, "\n\n");

      return raw;
    } catch (e) {
      warn("Error extracting math from selection:", e);
      return selection.toString().trim();
    }
  }

  /**
   * Annotate orphaned KaTeX elements in a cloned fragment by finding
   * their corresponding [data-math] ancestors in the original DOM.
   *
   * When cloneContents() clips a range that starts or ends inside a
   * math element, the cloned fragment has .katex/.katex-display spans
   * without the parent [data-math] wrapper.  This function finds those
   * orphans and wraps them in a span with the data-math attribute so
   * replaceMathElements() can handle them.
   */
  function annotateMathFromOriginalDOM(fragment, range) {
    // Find katex elements in the fragment that have NO [data-math] ancestor
    var orphans = fragment.querySelectorAll(
      ".katex-display, .katex, .katex-html"
    );

    if (orphans.length === 0) return;

    // Gather all [data-math] elements from the original DOM that
    // intersect with the selection range.
    var container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) {
      container = container.parentElement;
    }

    // Walk up to find a broad-enough ancestor to search
    var searchRoot = container;
    for (var i = 0; i < 10 && searchRoot.parentElement; i++) {
      searchRoot = searchRoot.parentElement;
      if (searchRoot.classList &&
          (searchRoot.classList.contains("markdown") ||
           searchRoot.classList.contains("response-container") ||
           searchRoot.classList.contains("model-response-text"))) {
        break;
      }
    }

    var mathEls = searchRoot.querySelectorAll("[data-math]");
    mathEls.forEach(function (mathEl) {
      // Check if this math element intersects with the selection
      try {
        if (range.intersectsNode(mathEl)) {
          var latex = mathEl.getAttribute("data-math");
          var isBlock = mathEl.classList.contains("math-block");

          // Find the corresponding orphan in the fragment and wrap it
          // We'll add a data-math attribute to the first matching orphan
          orphans.forEach(function (orphan) {
            if (!orphan.parentNode) return;
            // Don't re-annotate if already inside a [data-math] wrapper
            if (orphan.closest && orphan.closest("[data-math]")) return;

            // Wrap in a span with data-math
            var wrapper = document.createElement(isBlock ? "div" : "span");
            wrapper.className = isBlock ? "math-block" : "math-inline";
            wrapper.setAttribute("data-math", latex);
            orphan.parentNode.insertBefore(wrapper, orphan);
            wrapper.appendChild(orphan);
          });
        }
      } catch (e) {
        // intersectsNode may throw in edge cases
      }
    });
  }

  /**
   * Replace math elements in a DOM fragment with text nodes containing
   * the original LaTeX source.
   *
   * Processing order matters: display-math wrappers (which contain
   * inline-math elements) must be handled first.
   */
  function replaceMathElements(root) {
    // ── Gemini-specific: data-math attribute on .math-block / .math-inline ──
    // These wrappers contain the full LaTeX in a data attribute and must be
    // processed FIRST because they wrap the KaTeX elements handled below.

    // 0a. Display math blocks (Gemini)
    root.querySelectorAll(".math-block[data-math]").forEach(function (el) {
      var latex = el.getAttribute("data-math");
      if (latex) {
        el.replaceWith(document.createTextNode("$$" + latex + "$$"));
      }
    });

    // 0b. Inline math (Gemini)
    root.querySelectorAll(".math-inline[data-math]").forEach(function (el) {
      var latex = el.getAttribute("data-math");
      if (latex) {
        el.replaceWith(document.createTextNode("$" + latex + "$"));
      }
    });

    // 1. KaTeX display math (.katex-display wraps a .katex)
    root.querySelectorAll(".katex-display").forEach(function (el) {
      // Skip if already handled by a data-math parent
      if (!el.parentNode) return;
      var annotation = el.querySelector(
        'annotation[encoding="application/x-tex"]'
      );
      var latex = annotation ? annotation.textContent
        : (el.closest("[data-math]") || {}).getAttribute
          ? (el.closest("[data-math]") || {}).getAttribute("data-math")
          : null;
      if (latex) {
        el.replaceWith(document.createTextNode("$$" + latex + "$$"));
      }
    });

    // 2. KaTeX inline math (remaining .katex not inside .katex-display)
    root.querySelectorAll(".katex").forEach(function (el) {
      if (!el.parentNode) return;
      var annotation = el.querySelector(
        'annotation[encoding="application/x-tex"]'
      );
      var latex = annotation ? annotation.textContent
        : (el.closest("[data-math]") || {}).getAttribute
          ? (el.closest("[data-math]") || {}).getAttribute("data-math")
          : null;
      if (latex) {
        el.replaceWith(document.createTextNode("$" + latex + "$"));
      }
    });

    // 3. MathJax 3.x (<mjx-container>)
    root.querySelectorAll("mjx-container").forEach(function (el) {
      var isDisplay = el.getAttribute("display") === "block";
      var script = el.querySelector('script[type="math/tex"]');
      var latex = script ? script.textContent : null;
      if (!latex) {
        latex = el.getAttribute("aria-label") || "";
      }
      if (latex) {
        var wrapped = isDisplay ? "$$" + latex + "$$" : "$" + latex + "$";
        el.replaceWith(document.createTextNode(wrapped));
      }
    });

    // 4. MathJax 2.x (.MathJax with a sibling <script type="math/tex">)
    root.querySelectorAll(".MathJax").forEach(function (el) {
      var nextScript =
        el.nextElementSibling &&
        el.nextElementSibling.tagName === "SCRIPT" &&
        (el.nextElementSibling.type || "").indexOf("math/tex") !== -1
          ? el.nextElementSibling
          : null;
      if (nextScript) {
        var isDisplay = (nextScript.type || "").indexOf("display") !== -1;
        var wrapped = isDisplay
          ? "$$" + nextScript.textContent + "$$"
          : "$" + nextScript.textContent + "$";
        el.replaceWith(document.createTextNode(wrapped));
        nextScript.remove();
      }
    });

    // 5. Generic <math> elements (MathML) with a TeX annotation
    root.querySelectorAll("math").forEach(function (el) {
      var annotation = el.querySelector(
        'annotation[encoding="application/x-tex"]'
      );
      if (annotation) {
        var isDisplay = el.getAttribute("display") === "block";
        var wrapped = isDisplay
          ? "$$" + annotation.textContent + "$$"
          : "$" + annotation.textContent + "$";
        el.replaceWith(document.createTextNode(wrapped));
      }
    });

    // 6. Clean up hidden / duplicate math elements that would add
    //    extra text content (e.g., KaTeX's hidden MathML copy)
    root
      .querySelectorAll(".katex-mathml, .MathJax_Preview, .katex-html")
      .forEach(function (el) {
        // Only remove if still in the tree (not already replaced above)
        if (el.parentNode) el.remove();
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

  /**
   * Inject pre-composed text into the Gemini input (no citation formatting).
   */
  function injectFormattedText(text) {
    const inputEl = findInputElement();
    if (!inputEl) {
      warn("Cannot inject text: input element not found.");
      return false;
    }

    if (
      inputEl.getAttribute("contenteditable") === "true" ||
      inputEl.isContentEditable
    ) {
      return injectIntoContentEditable(inputEl, text);
    }

    if (inputEl.tagName && inputEl.tagName.toLowerCase() === "rich-textarea") {
      return injectIntoRichTextarea(inputEl, text);
    }

    if (
      inputEl.tagName &&
      inputEl.tagName.toLowerCase() === "textarea"
    ) {
      return injectIntoTextarea(inputEl, text);
    }

    warn("Unknown input element type:", inputEl.tagName);
    return false;
  }

  /**
   * Read the current user-typed text from the Gemini input element.
   */
  function getUserInput() {
    const inputEl = findInputElement();
    if (!inputEl) return "";

    if (
      inputEl.isContentEditable ||
      inputEl.getAttribute("contenteditable") === "true"
    ) {
      return (inputEl.textContent || "").trim();
    }

    if (inputEl.tagName && inputEl.tagName.toLowerCase() === "rich-textarea") {
      const innerSelectors = [
        ".ql-editor",
        ".ProseMirror",
        '[contenteditable="true"]',
      ];
      for (let i = 0; i < innerSelectors.length; i++) {
        const inner = inputEl.querySelector(innerSelectors[i]);
        if (inner) return (inner.textContent || "").trim();
      }
      if (inputEl.shadowRoot) {
        for (let j = 0; j < innerSelectors.length; j++) {
          const shadowInner = inputEl.shadowRoot.querySelector(innerSelectors[j]);
          if (shadowInner) return (shadowInner.textContent || "").trim();
        }
      }
      return (inputEl.value || inputEl.textContent || "").trim();
    }

    if (inputEl.tagName && inputEl.tagName.toLowerCase() === "textarea") {
      return (inputEl.value || "").trim();
    }

    return "";
  }

  /**
   * Find the Gemini send button.
   */
  function findSendButton() {
    for (let i = 0; i < SEND_BUTTON_SELECTORS.length; i++) {
      try {
        const btn = document.querySelector(SEND_BUTTON_SELECTORS[i]);
        if (btn) return btn;
      } catch (e) {
        // skip
      }
    }

    // Heuristic: look for buttons near the input with send-related labels
    const inputEl = findInputElement();
    if (inputEl) {
      const ancestor =
        inputEl.closest(".input-area-container") ||
        inputEl.closest(".input-area") ||
        inputEl.closest("form");
      if (ancestor) {
        const buttons = ancestor.querySelectorAll("button");
        for (let k = 0; k < buttons.length; k++) {
          const label = (buttons[k].getAttribute("aria-label") || "").toLowerCase();
          if (label.indexOf("send") !== -1 || label.indexOf("submit") !== -1) {
            return buttons[k];
          }
        }
      }
    }

    return null;
  }

  // =====================================================================
  // Bubble UI
  // =====================================================================

  let bubbleEl = null;
  let currentSelectedText = "";
  let currentDisplayText = "";

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
   * Handle the bubble click: show quote chip and focus input.
   */
  function handleBubbleClick() {
    log("Bubble clicked. Selected text:", currentSelectedText);

    if (!currentSelectedText) {
      warn("No text selected.");
      hideBubble();
      return;
    }

    // Show the quote chip instead of injecting text directly
    showQuoteChip(currentSelectedText, currentDisplayText);

    // Clear selection and hide bubble
    window.getSelection().removeAllRanges();
    hideBubble();
    currentSelectedText = "";
    currentDisplayText = "";

    // Focus the input area AFTER clearing selection and hiding the bubble,
    // with a short delay so Gemini's framework doesn't steal focus back.
    setTimeout(function () {
      const inputEl = findInputElement();
      if (inputEl) {
        inputEl.focus();
        placeCursorAtEnd(inputEl);
        log("Input focused after bubble click.");
      }
    }, 100);
  }

  // =====================================================================
  // Quote Chip UI
  // =====================================================================

  /**
   * Create the quote chip element (once).
   */
  function createQuoteChip() {
    if (chipEl) return chipEl;

    chipEl = document.createElement("div");
    chipEl.id = "ask-gemini-quote-chip";

    const quoteIcon = document.createElement("span");
    quoteIcon.className = "ask-gemini-chip-quote-icon";
    quoteIcon.textContent = "\u275D"; // ❝

    const textContainer = document.createElement("span");
    textContainer.className = "ask-gemini-chip-text";

    const closeBtn = document.createElement("button");
    closeBtn.className = "ask-gemini-chip-close";
    closeBtn.innerHTML = "&#10005;"; // ✕
    closeBtn.setAttribute("aria-label", "Remove quote");
    closeBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      hideQuoteChip();
    });

    chipEl.appendChild(quoteIcon);
    chipEl.appendChild(textContainer);
    chipEl.appendChild(closeBtn);

    // Prevent mousedown from stealing focus from the input
    chipEl.addEventListener("mousedown", function (e) {
      e.preventDefault();
    });

    document.body.appendChild(chipEl);
    log("Quote chip element created.");
    return chipEl;
  }

  /**
   * Show the quote chip with the given selected text.
   * @param {string} text — the raw text (with LaTeX) for the message.
   * @param {string} [visibleText] — the human-readable display text (without LaTeX markup).
   */
  function showQuoteChip(text, visibleText) {
    quotedText = text;
    quotedDisplayText = visibleText || text;
    const chip = createQuoteChip();

    // Use the visual/readable text for the chip display
    var raw = quotedDisplayText;
    // Truncate long text for display
    var preview = raw.length > 120 ? raw.substring(0, 120) + "\u2026" : raw;
    // Replace newlines with spaces for single-line display
    preview = preview.replace(/\n/g, " ");
    chip.querySelector(".ask-gemini-chip-text").textContent = preview;

    // Position and show after a frame so dimensions are available
    requestAnimationFrame(function () {
      positionChip();
      chip.classList.add("ask-gemini-chip-visible");
    });
    log("Quote chip shown.");
  }

  /**
   * Hide and reset the quote chip.
   */
  function hideQuoteChip() {
    quotedText = "";
    quotedDisplayText = "";
    if (chipEl) {
      chipEl.classList.remove("ask-gemini-chip-visible");
      log("Quote chip hidden.");
    }
  }

  /**
   * Position the quote chip above the Gemini input area.
   */
  function positionChip() {
    if (!chipEl) return;

    const inputEl = findInputElement();
    if (!inputEl) return;

    // Walk up to find the visual input box container for positioning.
    // Use INPUT-AREA-V2 (the rounded visual container) or fall back
    // to .input-area-container / .text-input-field.
    const container =
      inputEl.closest("input-area-v2") ||
      inputEl.closest(".input-area-container") ||
      inputEl.closest(".text-input-field") ||
      inputEl.closest(".input-area") ||
      inputEl.closest("rich-textarea") ||
      inputEl;

    const rect = container.getBoundingClientRect();
    const chipHeight = chipEl.offsetHeight || 36;

    chipEl.style.top = (rect.top - chipHeight - 4) + "px";
    chipEl.style.left = rect.left + "px";
    chipEl.style.width = rect.width + "px";
  }

  // =====================================================================
  // Send Interception
  // =====================================================================

  /**
   * Compose the final message from the quote and user input, inject it,
   * and trigger Gemini's send action.
   */
  function composeAndSend() {
    if (!quotedText) return;

    // Read what the user typed
    const userInput = getUserInput();

    // Build the full message: citation template + user's additional input
    const citation = citationFormat.replace("[SELECTED]", quotedText);
    const fullMessage = userInput
      ? citation + "\n" + userInput
      : citation.trimEnd();

    log(
      "Composing message. Citation length:", citation.length,
      "User input:", userInput.substring(0, 50)
    );

    // Clear the quote chip first
    hideQuoteChip();

    // Inject the composed message into the input
    const success = injectFormattedText(fullMessage);
    if (!success) {
      warn("Failed to inject composed message.");
      return;
    }

    // Re-trigger send after the framework processes the injection
    isBypassingSend = true;
    setTimeout(function () {
      const sendBtn = findSendButton();
      if (sendBtn) {
        log("Re-triggering send via button click.");
        sendBtn.click();
      } else {
        // Fallback: dispatch Enter key on the input
        log("Send button not found, dispatching Enter key.");
        const inp = findInputElement();
        if (inp) {
          inp.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true,
            })
          );
        }
      }
      setTimeout(function () {
        isBypassingSend = false;
      }, 300);
    }, 200);
  }

  /**
   * Check if a click event target is (or is inside) a send button.
   */
  function isSendButtonClick(target) {
    if (!target || !(target instanceof Element)) return false;

    for (const selector of SEND_BUTTON_SELECTORS) {
      try {
        if (target.matches(selector) || target.closest(selector)) return true;
      } catch (e) {
        // skip
      }
    }

    // Heuristic: check for button with send-related aria-label
    const btn =
      target.tagName === "BUTTON" ? target : target.closest("button");
    if (btn) {
      const label = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (label.indexOf("send") !== -1 || label.indexOf("submit") !== -1) {
        return true;
      }
    }

    return false;
  }

  /**
   * Capture-phase handler for send-button clicks.
   */
  function handleSendClick(e) {
    if (!quotedText || isBypassingSend) return;
    if (!isSendButtonClick(e.target)) return;

    log("Intercepting send button click for quote composition.");
    e.preventDefault();
    e.stopPropagation();
    composeAndSend();
  }

  /**
   * Capture-phase handler for Enter key (send shortcut).
   */
  function handleEnterToSend(e) {
    if (!quotedText || isBypassingSend) return;
    if (e.key !== "Enter" || e.shiftKey) return;

    // Only intercept if the input area is focused
    const inputEl = findInputElement();
    if (!inputEl) return;

    const active = document.activeElement;
    if (inputEl !== active && !inputEl.contains(active)) {
      return;
    }

    log("Intercepting Enter key for quote composition.");
    e.preventDefault();
    e.stopPropagation();
    composeAndSend();
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
        currentDisplayText = "";
        return;
      }

      // Check if the selection is in a valid area (response, not input)
      if (!isValidSelectionArea(selection)) {
        log("Selection is not in a valid area.");
        hideBubble();
        currentSelectedText = "";
        currentDisplayText = "";
        return;
      }

      currentSelectedText = text;
      // Also capture the plain visual text (without LaTeX) for chip display
      currentDisplayText = selection ? selection.toString().trim() : text;
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
   * Handle keydown: hide the bubble and quote chip on Escape key.
   */
  function handleKeyDown(e) {
    if (e.key === "Escape") {
      hideBubble();
      hideQuoteChip();
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

    // Send interception (capture phase to fire before Gemini's handlers)
    document.addEventListener("click", handleSendClick, true);
    document.addEventListener("keydown", handleEnterToSend, true);

    // Hide bubble on scroll (the conversation panel may scroll independently)
    // Use capture phase to catch scroll events on any scrollable container
    document.addEventListener("scroll", handleScroll, true);

    // Reposition quote chip on window resize
    window.addEventListener("resize", function () {
      if (quotedText) positionChip();
    });

    // ── Clear quote chip when the user switches conversations ──
    // Gemini is a SPA — navigation may happen via pushState, replaceState,
    // or internal framework routing.  We use two complementary strategies:
    //
    //   1. Poll location.href every 500 ms to catch any URL change.
    //   2. Observe the main content area with a MutationObserver so we
    //      catch large-scale DOM swaps (e.g. the conversation container
    //      being replaced) even if the URL hasn't changed yet.

    var lastUrl = location.href;

    function onConversationChange() {
      log("Conversation change detected — clearing quote chip.");
      hideQuoteChip();
      hideBubble();
      currentSelectedText = "";
      currentDisplayText = "";
    }

    // Strategy 1 — URL polling
    setInterval(function () {
      var newUrl = location.href;
      if (newUrl !== lastUrl) {
        lastUrl = newUrl;
        onConversationChange();
      }
    }, 500);

    // Also catch browser back/forward
    window.addEventListener("popstate", function () {
      // Delay slightly so location.href is updated
      setTimeout(function () {
        var newUrl = location.href;
        if (newUrl !== lastUrl) {
          lastUrl = newUrl;
          onConversationChange();
        }
      }, 50);
    });

    // Strategy 2 — MutationObserver on the conversation container
    // Watch for childList changes on a high-level container that gets
    // replaced when the user picks a different conversation.
    var conversationObserver = new MutationObserver(function (mutations) {
      if (!quotedText) return; // nothing to clear

      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.removedNodes.length > 0) {
          // A large subtree was removed — likely a conversation switch
          for (var j = 0; j < m.removedNodes.length; j++) {
            var node = m.removedNodes[j];
            if (node.nodeType === Node.ELEMENT_NODE &&
                (node.querySelectorAll && node.querySelectorAll(".model-response-text, .message-content, [data-message-author-role]").length > 0)) {
              onConversationChange();
              return;
            }
          }
        }
      }
    });

    // Start observing once the <main> or app container is available
    function startConversationObserver() {
      var target =
        document.querySelector("main") ||
        document.querySelector("[role='main']") ||
        document.querySelector(".app-container") ||
        document.body;
      conversationObserver.observe(target, { childList: true, subtree: true });
      log("Conversation observer started on:", target.tagName || "body");
    }
    startConversationObserver();

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
