// SAP Timesheet Filler — Content Script
// Injected into SAP Fiori pages. Passive until it receives a FILL_SAP message.
// Depends on ui5-helpers.js being loaded first.

(function () {
  'use strict';

  if (window.__sapFillerActive) return; // Prevent double-injection
  window.__sapFillerActive = true;

  // ─── Frame Guard ───────────────────────────────────────────────────────────
  // SAP Fiori Launchpad embeds each app inside an iframe. The content script
  // is injected into all frames (all_frames: true in manifest), but we only
  // want to respond from the SAP app iframe — not the top-level shell frame.
  // The app iframe is a child frame (self !== top) and has SAPUI5 loaded.
  function isInSAPAppFrame() {
    if (window.self === window.top) return false;
    // On SAP BTP Cloud Foundry, the timesheet app runs inside a dedicated
    // iframe that loads ui5appruntime.html. Other child iframes (analytics,
    // etc.) won't have this path. This prevents multiple iframes from all
    // running runAutomation simultaneously and interfering with each other.
    if (window.location.href.includes('ui5appruntime')) return true;
    // Fallback for other SAP deployments: check for SAP Fiori page elements
    return document.querySelector('.sapMPage, .sapMShell') !== null;
  }

  // ─── Message Router ────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'PING') {
      // Respond from any frame — the popup just needs to know the content
      // script is loaded. FILL_SAP is guarded separately to only run in
      // the SAP app iframe.
      sendResponse({ ready: true, url: window.location.href });
      return false;
    }

    if (message.type === 'GET_TEMPLATES') {
      if (!isInSAPAppFrame()) return false;
      getTemplateNames().then(names => {
        sendResponse({ templates: names });
      }).catch(err => {
        sendResponse({ templates: [], error: err.message });
      });
      return true; // Keep message channel open for async response
    }

    if (message.type === 'FILL_SAP') {
      if (!isInSAPAppFrame()) return false; // Only run in the SAP app frame
      if (window.__sapFillerRunning) {
        sendResponse({ started: false, error: 'Automation already running' });
        return false;
      }
      window.__sapFillerRunning = true;
      runAutomation(message.days, message.targetWeekMonday).finally(() => {
        window.__sapFillerRunning = false;
      });
      sendResponse({ started: true });
      return false;
    }
  });

  // ─── Main Automation ───────────────────────────────────────────────────────

  async function runAutomation(days, targetWeekMonday) {
    await chrome.storage.local.set({
      progress: [],
      automationDone: false,
      automationResult: null
    });

    // Navigate SAP to the correct week before filling entries
    if (targetWeekMonday) {
      try {
        await navigateToWeek(targetWeekMonday);
      } catch (err) {
        await sendProgress(`⚠ Week navigation: ${err.message}. Proceeding — verify SAP is on the right week.`);
      }
    }

    let completed = 0;
    const errors = [];

    for (const day of days) {
      // Project entries
      for (const entry of day.projectEntries) {
        try {
          await processProjectEntry(day.date, entry);
          completed++;
          await sendProgress(`✓ ${formatDate(day.date)} / ${entry.templateName} / ${entry.hours}h`);
        } catch (err) {
          const msg = `✗ ${formatDate(day.date)} / ${entry.templateName}: ${err.message}`;
          errors.push(msg);
          await sendProgress(msg);
          await recoverFromError();
        }
      }

      // Attendance entry
      if (day.attendance) {
        try {
          await processAttendanceEntry(day.date, day.attendance);
          completed++;
          await sendProgress(`✓ ${formatDate(day.date)} / Attendance`);
        } catch (err) {
          const msg = `✗ ${formatDate(day.date)} / Attendance: ${err.message}`;
          errors.push(msg);
          await sendProgress(msg);
          await recoverFromError();
        }
      }
    }

    const summary = errors.length === 0
      ? `Done — ${completed} entries saved.`
      : `Done — ${completed} saved, ${errors.length} failed.`;

    await sendProgress(summary);
    await chrome.storage.local.set({
      automationDone: true,
      automationResult: { success: errors.length === 0, completed, errors }
    });
  }

  // ─── Project Entry (via Template) ───────────────────────────────────────────

  async function processProjectEntry(date, entry) {
    // 1. Click "Select Template" dropdown on the calendar page
    await clickSelectTemplate();

    // 2. Click the matching template name from the menu
    await clickTemplateName(entry.templateName);

    // 3. Wait for the new entry form to load — wait for Duration field specifically
    await waitForCondition(() => {
      return findInputByLabel('Duration') ||
        document.querySelector('input[id*="durationInputField"]');
    }, 12000).catch(() => { throw new Error('Entry form did not load after 12s'); });
    await sleep(500); // Let the form fully render

    // 4. Set date
    await setDateField(date);

    // 5. Set Duration via page-world bridge (more reliable for overwriting template values)
    const durationInput = findInputByLabel('Duration') ||
      document.querySelector('input[id*="durationInputField"]');
    if (!durationInput) throw new Error('Duration field not found');
    document.dispatchEvent(new CustomEvent('__sapFiller_setValue', {
      detail: { id: durationInput.id, value: String(entry.hours) }
    }));
    await sleep(300);

    // 6. Set Description via page-world bridge (template pre-fills this, must overwrite)
    const descInput = findDescriptionField();
    if (!descInput) throw new Error('Description field not found');
    document.dispatchEvent(new CustomEvent('__sapFiller_setValue', {
      detail: { id: descInput.id, value: entry.description }
    }));
    await sleep(300);

    // 7. Save
    await clickSave();

    // 8. Wait for return to week view
    await waitForWeekView();
    await sleep(2500); // Give SAP's router time to fully settle before next entry
  }

  async function getTemplateNames() {
    // Click "Select Template" to open the menu, read template names, then close it
    await clickSelectTemplate();

    // Read template names from the menu
    const names = await waitForCondition(() => {
      const candidates = document.querySelectorAll(
        '.sapMPopover li, .sapMMenu li, .sapMLIB, ' +
        '[role="menuitem"], [role="listitem"], .sapMSLI, .sapUiMnuItm'
      );
      const found = [];
      for (const el of candidates) {
        const text = el.textContent.trim();
        // Skip "Add", "Delete", empty, and generic menu items
        if (text && text !== 'Add' && text !== 'Delete' && text !== 'Select Template') {
          // Template items may contain submenu text; get only the direct text
          // by checking for items that have a meaningful name
          if (!found.includes(text)) found.push(text);
        }
      }
      return found.length > 0 ? found : null;
    }, 6000).catch(() => { throw new Error('No templates found in menu'); });

    // Close the menu by pressing Escape
    pressEscape();
    await sleep(500);

    return names;
  }

  async function clickSelectTemplate() {
    // "Select Template" is a button on the week view footer toolbar.
    // Wait for it to appear — after a save, SAP takes time to return to the week view
    // and re-render the footer toolbar.
    const templateBtn = await waitForCondition(() => {
      return findButtonByText('Select Template') ||
        document.querySelector('button[id*="template" i], button[id*="Template"]');
    }, 12000).catch(() => { throw new Error('"Select Template" button not found after 12s'); });

    await sleep(500); // Extra settle time before clicking
    fireUI5Press(templateBtn.id);
    await sleep(800); // Wait for menu/popover to appear
  }

  async function clickTemplateName(templateName) {
    // After clicking "Select Template", a menu appears with template names.
    // Each template has a submenu with "Add" and "Delete" options.
    // Step 1: Click/hover the template name to open the submenu.
    const menuItem = await waitForCondition(() => {
      const candidates = document.querySelectorAll(
        '.sapMPopover li, .sapMActionSheet button, .sapMMenu li, ' +
        '.sapMLIB, [role="menuitem"], [role="listitem"], ' +
        '.sapMSLI, .sapMActionSheetButton, .sapUiMnuItm'
      );
      for (const el of candidates) {
        const text = el.textContent.trim();
        if (text === templateName) return el;
      }
      // Partial match: template name may have extra text around it
      for (const el of candidates) {
        if (el.textContent.trim().includes(templateName)) return el;
      }
      return null;
    }, 6000).catch(() => { throw new Error(`Template "${templateName}" not found in menu after 6s`); });

    // Click the template to open its submenu (Add / Delete)
    if (menuItem.id) {
      fireUI5Press(menuItem.id);
    } else {
      menuItem.click();
    }
    await sleep(800);

    // Step 2: Click "Add" in the submenu
    const addItem = await waitForCondition(() => {
      const candidates = document.querySelectorAll(
        '[role="menuitem"], .sapMPopover li, .sapMLIB, ' +
        '.sapMSLI, .sapUiMnuItm, .sapMActionSheetButton'
      );
      for (const el of candidates) {
        const text = el.textContent.trim();
        if (text === 'Add') return el;
      }
      return null;
    }, 6000).catch(() => { throw new Error('Submenu "Add" button not found after 6s'); });

    if (addItem.id) {
      fireUI5Press(addItem.id);
    } else {
      addItem.click();
    }
    await sleep(800);
  }

  // ─── Attendance Entry ──────────────────────────────────────────────────────

  async function processAttendanceEntry(date, attendance) {
    // 1. Click "Add"
    await clickAdd();

    // 2. Wait for the new entry form
    await waitForNewEntryForm();

    // 3. Switch to Attendance tab via the SegmentedButton
    const attTab = await waitForCondition(() => {
      const btns = document.querySelectorAll('.sapMSegBBtn');
      for (const btn of btns) {
        if (btn.textContent.trim().includes('Attendance')) return btn;
      }
      return null;
    }, 6000).catch(() => { throw new Error('Attendance tab not found after 6s'); });

    // Use a dedicated event to select the tab by clicking the UI5 item
    document.dispatchEvent(new CustomEvent('__sapFiller_selectSegBtnItem', {
      detail: { id: attTab.id }
    }));
    await sleep(1000);

    // Verify the tab switched — time fields should now be visible
    await waitForCondition(() => {
      return document.querySelector('input[id*="startInputField-inner"]');
    }, 6000).catch(() => { throw new Error('Attendance fields did not appear after tab switch'); });

    // 4. Set date
    const dateInput = document.querySelector('input[id*="picker"][id$="-inner"]');
    if (dateInput) {
      const targetDate = new Date(date + 'T00:00:00');
      const targetFormatted = targetDate.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      });
      if (dateInput.value !== targetFormatted) {
        document.dispatchEvent(new CustomEvent('__sapFiller_setValue', {
          detail: { id: dateInput.id, value: targetFormatted }
        }));
        await sleep(300);
      }
    }

    // 5. Set Period 1 Start/End times (by exact IDs)
    const start1 = document.querySelector('input[id*="startInputField-inner"]');
    const end1 = document.querySelector('input[id*="endInputField-inner"]');
    if (!start1 || !end1) throw new Error('Period 1 Start/End time fields not found');

    document.dispatchEvent(new CustomEvent('__sapFiller_setValue', {
      detail: { id: start1.id, value: attendance.period1Start }
    }));
    await sleep(300);
    document.dispatchEvent(new CustomEvent('__sapFiller_setValue', {
      detail: { id: end1.id, value: attendance.period1End }
    }));
    await sleep(300);

    // 6. Set Period 2 Start/End times (optional)
    if (attendance.period2Start && attendance.period2End) {
      const start2 = document.querySelector('input[id*="startTimeSec-inner"]');
      const end2 = document.querySelector('input[id*="endTimeSec-inner"]');
      if (start2 && end2) {
        document.dispatchEvent(new CustomEvent('__sapFiller_setValue', {
          detail: { id: start2.id, value: attendance.period2Start }
        }));
        await sleep(300);
        document.dispatchEvent(new CustomEvent('__sapFiller_setValue', {
          detail: { id: end2.id, value: attendance.period2End }
        }));
        await sleep(300);
      }
    }

    // 7. Set Work place
    await setWorkPlace(attendance.workPlace);

    // 8. Save
    await clickSave();

    // 9. Wait for return to week view
    await waitForWeekView();
    await sleep(2500); // Give SAP time to fully settle before next entry
  }

  // ─── Week Navigation ───────────────────────────────────────────────────────

  /**
   * Navigate the SAP week view to the week containing targetMondayIso.
   * Reads the currently displayed week from the SAP calendar header,
   * then clicks the prev (‹) or next (›) week button as many times as needed.
   */
  async function navigateToWeek(targetMondayIso) {
    const targetMonday = new Date(targetMondayIso + 'T00:00:00');

    for (let attempt = 0; attempt < 15; attempt++) {
      const currentMonday = getSAPCurrentWeekMonday();
      if (!currentMonday) {
        // Can't read the current week — fall back silently
        return;
      }

      const diffDays = Math.round((targetMonday - currentMonday) / (24 * 60 * 60 * 1000));
      const diffWeeks = Math.round(diffDays / 7);

      if (diffWeeks === 0) return; // Already on the correct week

      const goBack = diffWeeks < 0;
      const navBtn = goBack ? findSAPPrevWeekButton() : findSAPNextWeekButton();
      if (!navBtn) throw new Error('Week navigation buttons not found in SAP');

      // Click up to 4 times per attempt to move faster
      const clicks = Math.min(Math.abs(diffWeeks), 4);
      for (let i = 0; i < clicks; i++) {
        navBtn.click();
        await sleep(350);
      }
    }

    throw new Error('Could not navigate to target week after 15 attempts');
  }

  /**
   * Read the Monday date of the currently displayed SAP week.
   * SAP shows the month/year as a heading and day numbers in column headers.
   * Returns a Date object set to midnight, or null if unreadable.
   */
  function getSAPCurrentWeekMonday() {
    // Strategy 1: find the month/year text + the first date number in the week header row.
    // SAP renders something like: "March 2026" + columns "16  17  18  19  20  21  22"
    const monthYearEl = findSAPMonthYearLabel();
    if (!monthYearEl) return null;

    const { month, year } = parseMonthYear(monthYearEl.textContent.trim());
    if (month === null || year === null) return null;

    // The first date column header contains the Monday day number
    const dayNumEls = document.querySelectorAll(
      '[class*="CalDayNum"], [class*="dayNum"], [class*="DayNumber"], ' +
      'th .sapMTitle, th span[class*="num"], .sapUiCalHead td span'
    );

    // Fallback: look for td or th elements containing short day numbers (1-31) in the week view
    const candidates = dayNumEls.length > 0
      ? Array.from(dayNumEls)
      : Array.from(document.querySelectorAll('th, td')).filter(el => {
          const n = parseInt(el.textContent.trim(), 10);
          return n >= 1 && n <= 31 && el.textContent.trim().length <= 2;
        });

    if (!candidates.length) return null;

    const mondayDay = parseInt(candidates[0].textContent.trim(), 10);
    if (isNaN(mondayDay)) return null;

    // Handle month boundary: if mondayDay > 20 and we're reading "April", Monday might be in March
    const d = new Date(year, month, mondayDay, 0, 0, 0);
    return d;
  }

  function findSAPPrevWeekButton() {
    // SAP prev-week button: typically an arrow button to the left of the month/year label
    return (
      document.querySelector('button[aria-label*="Previous"], button[title*="Previous"]') ||
      document.querySelector('button[aria-label*="Back"], button[title*="Back"]') ||
      // Generic: first button that contains only "‹" or "<" near the calendar header
      findCalendarNavButton('prev')
    );
  }

  function findSAPNextWeekButton() {
    return (
      document.querySelector('button[aria-label*="Next"], button[title*="Next"]') ||
      findCalendarNavButton('next')
    );
  }

  function findCalendarNavButton(direction) {
    // Look for small icon-only buttons near the month/year label
    const monthEl = findSAPMonthYearLabel();
    if (!monthEl) return null;

    // Walk up to find a container that has sibling buttons
    let container = monthEl.parentElement;
    for (let i = 0; i < 4 && container; i++) {
      const buttons = container.querySelectorAll('button');
      if (buttons.length >= 2) {
        // First button = prev, last button = next (common SAP calendar layout)
        return direction === 'prev' ? buttons[0] : buttons[buttons.length - 1];
      }
      container = container.parentElement;
    }
    return null;
  }

  function findSAPMonthYearLabel() {
    // SAP shows "March 2026" in the calendar header area
    const candidates = document.querySelectorAll(
      '.sapUiCalHeadB, [class*="CalTitle"], [class*="calTitle"], ' +
      '[class*="MonthYear"], [class*="monthYear"], h2, .sapMTitle'
    );
    for (const el of candidates) {
      if (/^[A-Z][a-z]+ \d{4}$/.test(el.textContent.trim())) return el;
    }
    return null;
  }

  function parseMonthYear(text) {
    // Parse "March 2026" → { month: 2, year: 2026 }  (month is 0-indexed)
    const MONTHS = {
      January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
      July: 6, August: 7, September: 8, October: 9, November: 10, December: 11
    };
    const parts = text.trim().split(/\s+/);
    if (parts.length !== 2) return { month: null, year: null };
    const month = MONTHS[parts[0]];
    const year = parseInt(parts[1], 10);
    if (month === undefined || isNaN(year)) return { month: null, year: null };
    return { month, year };
  }

  // ─── UI Interaction Helpers ────────────────────────────────────────────────

  async function clickAdd() {
    // The "Add" button is in the footer toolbar of the week view.
    // SAP renders button text inside a <bdi> tag within .sapMBtnContent.
    const addBtn = await waitForCondition(() => {
      // 1. Standard text match via findButtonByText (strips non-ASCII icon glyphs)
      const byText = findButtonByText('Add');
      if (byText) return byText;
      // 2. Direct bdi text match — most explicit, works regardless of icon prefix
      for (const bdi of document.querySelectorAll('button bdi')) {
        if (bdi.textContent.trim() === 'Add') return bdi.closest('button');
      }
      // 3. SAP accesskey attribute (data-ui5-accesskey="a" is set on the Add button)
      const byAccessKey = document.querySelector('button[data-ui5-accesskey="a"]');
      if (byAccessKey) return byAccessKey;
      return null;
    }, 8000).catch(() => { throw new Error('"Add" button not found after 8s'); });

    // Content scripts run in an isolated JS world — window.sap is not accessible.
    // Inject a <script> tag into the page to fire the press in the page's context.
    const controlId = addBtn.id;
    fireUI5Press(controlId);
    await sleep(800); // Give SAP time to begin navigation before polling
  }

  async function waitForNewEntryForm() {
    // Wait for the new entry form to appear. SAP Fiori navigates in-place (SPA).
    // The "Save" button only exists in the new entry form, never on the week view.
    // Retry clicking Add once if the form doesn't appear — SAP's router sometimes
    // needs a moment to settle after returning from a previous save.
    for (let attempt = 0; attempt < 2; attempt++) {
      const found = await waitForCondition(() => findButtonByText('Save'), 8000)
        .catch(() => null);
      if (found) break;
      if (attempt === 1) throw new Error('New entry form did not appear after retrying');
      // Form didn't appear — re-click Add and try again
      await sendProgress('⚠ Form did not load, retrying Add click...');
      await clickAdd();
    }

    await sleep(300); // Let the form fully render
  }

  async function ensureTab(tabName) {
    // The Project/Attendance switcher is a SAP SegmentedButton.
    // Each segment renders as a <button> containing a .sapMSegBBtnInner div.
    const tabs = document.querySelectorAll('.sapMSegBBtn, .sapMITBItem, [role="tab"]');
    for (const tab of tabs) {
      if (tab.textContent.trim().includes(tabName)) {
        const isSelected =
          tab.getAttribute('aria-pressed') === 'true' ||
          tab.getAttribute('aria-selected') === 'true' ||
          tab.classList.contains('sapMSegBBtnFocused') ||
          tab.classList.contains('sapMITBSelected') ||
          tab.classList.contains('sapMITBItemSelected');
        if (!isSelected) {
          tab.click();
          await sleep(400);
        }
        return;
      }
    }
    // Tab not found — may already be correct or tab names differ; proceed cautiously
  }

  async function setDateField(isoDate) {
    const dateInput = findInputByLabel('Date') ||
      document.querySelector('input[id*="picker"][id$="-inner"]');
    if (!dateInput) return; // Pre-populated; not always present as editable

    const currentVal = dateInput.value;
    // SAP shows dates like "Apr 5, 2026"
    const targetDate = new Date(isoDate + 'T00:00:00');
    const targetFormatted = targetDate.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });

    if (currentVal === targetFormatted) return; // Already correct

    // Use page-world bridge to set via UI5 API (more reliable than native setter)
    if (dateInput.id) {
      document.dispatchEvent(new CustomEvent('__sapFiller_setValue', {
        detail: { id: dateInput.id, value: targetFormatted }
      }));
    } else {
      setUI5InputValue(dateInput, targetFormatted);
    }
    await sleep(300);
  }

  // selectProject, findProjectInput, findValueHelpButton removed — replaced by template-based flow

  function findDescriptionField() {
    // Description is a textarea or multi-line input
    let el = document.querySelector('textarea');
    if (el) return el;

    el = findInputByLabel('Description');
    return el;
  }

  function getTimeInputPairs() {
    // Attendance tab has two pairs of time inputs (Period 1 and Period 2).
    // SAP TimePicker renders as type="text" inputs — NOT type="time".
    // Find them by label association first, then fall back to DOM order.

    // Try label-based discovery
    const startInputs = findAllInputsByLabel('Start');
    const endInputs   = findAllInputsByLabel('End');

    if (startInputs.length >= 1 && endInputs.length >= 1) {
      return {
        period1: { start: startInputs[0], end: endInputs[0] },
        period2: startInputs.length >= 2
          ? { start: startInputs[1], end: endInputs[1] }
          : null
      };
    }

    // Fallback: find all inputs that have a clock-icon sibling (TimePicker pattern)
    const allInputs = Array.from(document.querySelectorAll('input')).filter(inp => {
      // SAP TimePicker inputs sit in a container alongside a clock button
      const container = inp.closest('[class*="InputBase"], [class*="TimePicker"]');
      if (!container) return false;
      const hasClockBtn = container.querySelector('button [class*="clock"], button [data-sap-icon*="time"]');
      return !!hasClockBtn;
    });

    if (allInputs.length >= 2) {
      return {
        period1: { start: allInputs[0], end: allInputs[1] },
        period2: allInputs.length >= 4 ? { start: allInputs[2], end: allInputs[3] } : null
      };
    }

    return { period1: null, period2: null };
  }

  // Find ALL inputs associated with a given label text (for repeated labels like "Start"/"End")
  function findAllInputsByLabel(labelText) {
    const results = [];
    const labels = document.querySelectorAll('label');
    for (const label of labels) {
      const text = label.textContent.trim().replace(/\s*\*\s*$/, '').trim();
      if (text === labelText) {
        const forId = label.getAttribute('for');
        if (forId) {
          const el = document.getElementById(forId);
          if (el) results.push(el);
        }
      }
    }
    return results;
  }

  async function setWorkPlace(workPlace) {
    // Work place is a SegmentedButton with <li role="option"> items.
    // Use jQuery tap via the page-world bridge (same approach as tab switching).
    const items = document.querySelectorAll('.sapMSegBBtn[role="option"]');
    for (const item of items) {
      if (item.textContent.trim() === workPlace) {
        const isSelected = item.getAttribute('aria-selected') === 'true' ||
          item.classList.contains('sapMSegBBtnSel');
        if (!isSelected) {
          document.dispatchEvent(new CustomEvent('__sapFiller_selectSegBtnItem', {
            detail: { id: item.id }
          }));
          await sleep(300);
        }
        return;
      }
    }
    // Work place button not found — this is non-fatal, it may already be set
  }

  async function clickSave() {
    const saveBtn = await waitForCondition(() => findButtonByText('Save'), 5000)
      .catch(() => { throw new Error('"Save" button not found after 5s'); });
    fireUI5Press(saveBtn.id);
    await sleep(300);
  }

  async function waitForWeekView() {
    // After saving, SAP navigates back to the week view
    // Wait for the "Add" button to reappear (indicates week view is active)
    await waitForCondition(() => {
      return findButtonByText('Add') || findButtonByText('Release Week');
    }, 10000);
  }

  async function recoverFromError() {
    // Try pressing Escape up to 3 times to dismiss any open dialogs/forms
    for (let i = 0; i < 3; i++) {
      pressEscape();
      await sleep(600);

      // Check if we're back at the week view
      const addBtn = findButtonByText('Add') || findButtonByText('Release Week');
      if (addBtn) return;
    }

    // Last resort: click the back button if visible
    const backBtn = document.querySelector('button[aria-label="Back"], button[title="Back"]');
    if (backBtn) {
      backBtn.click();
      await sleep(1000);
    }
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  async function sendProgress(msg) {
    // Guard against "Extension context invalidated" if the extension is reloaded
    // mid-run. Silently swallow the error so automation can continue logging
    // what it can rather than crashing entirely.
    try {
      await new Promise((resolve, reject) => {
        chrome.storage.local.get('progress', ({ progress = [] }) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          chrome.storage.local.set(
            { progress: [...progress, { ts: Date.now(), msg }] },
            resolve
          );
        });
      });
    } catch {
      // Extension context was invalidated (e.g. extension reloaded mid-run).
      // Nothing we can do — just continue silently.
    }
  }

  function formatDate(isoDate) {
    const d = new Date(isoDate + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // Inject page-world.js once — it runs in the page's JS context where sap is accessible.
  // Content scripts are isolated and cannot access sap.ui.getCore() directly.
  (function injectPageWorld() {
    const existing = document.getElementById('__sapFillerPageWorld');
    if (existing) return;
    const script = document.createElement('script');
    script.id = '__sapFillerPageWorld';
    script.src = chrome.runtime.getURL('content/page-world.js');
    document.head.appendChild(script);
  })();

  /**
   * Fire a UI5 button press via the page-world bridge (CustomEvent).
   */
  function fireUI5Press(controlId) {
    document.dispatchEvent(new CustomEvent('__sapFiller_firePress', {
      detail: { id: controlId }
    }));
  }

})();
