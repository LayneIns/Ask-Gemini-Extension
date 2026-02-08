(function () {
  "use strict";

  var DEFAULT_CITATION_FORMAT =
    "Regarding the following selected content:\n" +
    "------\n" +
    "[SELECTED]\n" +
    "------\n";

  var formatInput = document.getElementById("format-input");
  var saveBtn = document.getElementById("save-btn");
  var resetBtn = document.getElementById("reset-btn");
  var statusEl = document.getElementById("status");

  // ── Helpers ───────────────────────────────────────────────────

  /**
   * Convert the internal format string (with real newlines) into the
   * display representation the user sees in the textarea (literal \n).
   */
  function toDisplay(str) {
    return str.replace(/\n/g, "\\n");
  }

  /**
   * Convert the display representation back to the internal format
   * string (replace literal \n with real newlines).
   */
  function fromDisplay(str) {
    return str.replace(/\\n/g, "\n");
  }

  function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = "status " + type;
    setTimeout(function () {
      statusEl.textContent = "";
      statusEl.className = "status";
    }, 2000);
  }

  // ── Load saved format ─────────────────────────────────────────

  chrome.storage.sync.get(
    { citationFormat: DEFAULT_CITATION_FORMAT },
    function (items) {
      formatInput.value = toDisplay(items.citationFormat);
    }
  );

  // ── Save ──────────────────────────────────────────────────────

  saveBtn.addEventListener("click", function () {
    var raw = fromDisplay(formatInput.value);

    if (raw.indexOf("[SELECTED]") === -1) {
      showStatus(
        "Format must contain the [SELECTED] placeholder.",
        "error"
      );
      return;
    }

    chrome.storage.sync.set({ citationFormat: raw }, function () {
      showStatus("Saved!", "success");
    });
  });

  // ── Reset ─────────────────────────────────────────────────────

  resetBtn.addEventListener("click", function () {
    formatInput.value = toDisplay(DEFAULT_CITATION_FORMAT);
    chrome.storage.sync.set(
      { citationFormat: DEFAULT_CITATION_FORMAT },
      function () {
        showStatus("Reset to default.", "success");
      }
    );
  });
})();
