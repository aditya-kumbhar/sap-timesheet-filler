// SAP Timesheet Filler — UI5 DOM Helpers
// Loaded before content.js. All functions are window-scoped.

/**
 * Wait for a CSS selector to appear in the DOM.
 * @param {string} selector
 * @param {number} timeoutMs
 * @param {Document|Element} root
 * @returns {Promise<Element>}
 */
function waitForElement(selector, timeoutMs = 5000, root = document) {
  return new Promise((resolve, reject) => {
    const existing = root.querySelector(selector);
    if (existing) return resolve(existing);

    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      const el = root.querySelector(selector);
      if (el) {
        clearInterval(interval);
        resolve(el);
      } else if (Date.now() > deadline) {
        clearInterval(interval);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for: ${selector}`));
      }
    }, 100);
  });
}

/**
 * Wait for a CSS selector to disappear from the DOM.
 * @param {string} selector
 * @param {number} timeoutMs
 * @param {Document|Element} root
 * @returns {Promise<void>}
 */
function waitForElementGone(selector, timeoutMs = 5000, root = document) {
  return new Promise((resolve, reject) => {
    if (!root.querySelector(selector)) return resolve();

    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      if (!root.querySelector(selector)) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(interval);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for element to disappear: ${selector}`));
      }
    }, 100);
  });
}

/**
 * Wait for a condition function to return truthy.
 * @param {Function} conditionFn
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
function waitForCondition(conditionFn, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const result = conditionFn();
    if (result) return resolve(result);

    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      const r = conditionFn();
      if (r) {
        clearInterval(interval);
        resolve(r);
      } else if (Date.now() > deadline) {
        clearInterval(interval);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for condition`));
      }
    }, 100);
  });
}

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Set the value of a UI5 input element and fire the necessary events.
 * UI5 controls ignore plain `.value =` so we use the native setter + events.
 * Falls back to the UI5 Core API if native events don't register.
 * @param {HTMLInputElement|HTMLTextAreaElement} el
 * @param {string} value
 */
function setUI5InputValue(el, value) {
  if (!el) throw new Error('setUI5InputValue: element is null');

  el.focus();

  // Use native setter to bypass UI5's property descriptor override
  const proto = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  nativeSetter.call(el, value);

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();

  // Verify the value was accepted; if not, try UI5 Core API
  if (el.value !== value) {
    setUI5ValueViaCore(el, value);
  }
}

/**
 * Fallback: set value via UI5 Core control API.
 * @param {HTMLElement} el
 * @param {string} value
 * @returns {boolean} true if successful
 */
function setUI5ValueViaCore(el, value) {
  // Content scripts run in an isolated JS world — window.sap is not accessible.
  // Dispatch a CustomEvent handled by page-world.js which runs in the page context.
  const controlId = el.id;
  if (!controlId) return false;
  document.dispatchEvent(new CustomEvent('__sapFiller_setValue', {
    detail: { id: controlId, value }
  }));
  return true;
}

/**
 * Find an input element by its associated label text within a root element.
 * Handles UI5 label patterns (label[for], aria-labelledby).
 * @param {string} labelText - exact label text (asterisk stripped)
 * @param {Document|Element} root
 * @returns {HTMLElement|null}
 */
function findInputByLabel(labelText, root = document) {
  const labels = root.querySelectorAll('label');
  for (const label of labels) {
    const text = label.textContent.trim().replace(/\s*\*\s*$/, '').trim();
    if (text === labelText) {
      const forId = label.getAttribute('for');
      if (forId) {
        const el = document.getElementById(forId);
        if (el) return el;
      }
    }
  }

  // Fallback: aria-label on inputs
  const inputs = root.querySelectorAll('input, textarea');
  for (const input of inputs) {
    const aria = (input.getAttribute('aria-label') || '').replace(/\s*\*\s*$/, '').trim();
    if (aria === labelText) return input;
  }

  return null;
}

/**
 * Get the topmost open SAP dialog (highest in DOM order = most recently opened).
 * @returns {Element|null}
 */
function getTopmostDialog() {
  const dialogs = document.querySelectorAll('.sapMDialog');
  if (!dialogs.length) return null;
  // The last dialog in DOM is typically the topmost
  return dialogs[dialogs.length - 1];
}

/**
 * Find a button by its visible text within a root element.
 * @param {string} text
 * @param {Document|Element} root
 * @returns {HTMLElement|null}
 */
function findButtonByText(text, root = document) {
  // Strip non-ASCII characters (SAP icon font glyphs) before comparing,
  // since buttons like "Add" often have a leading icon codepoint in textContent.
  const normalize = str => str.replace(/[^\x20-\x7E]/g, '').trim();
  const buttons = root.querySelectorAll('button, [role="button"]');
  for (const btn of buttons) {
    // Prefer the inner content span (more precise), fall back to full textContent.
    // SAP may wrap text in a <bdi> tag inside the content span.
    const contentSpan = btn.querySelector('.sapMBtnContent, [class*="BtnContent"]');
    const bdi = btn.querySelector('bdi');
    const raw = (bdi || contentSpan || btn).textContent;
    if (normalize(raw) === text) return btn;
  }
  return null;
}

/**
 * Simulate pressing the Escape key on the document.
 */
function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    bubbles: true,
    cancelable: true
  }));
  document.dispatchEvent(new KeyboardEvent('keyup', {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    bubbles: true
  }));
}
