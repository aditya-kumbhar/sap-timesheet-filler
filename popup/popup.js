// SAP Timesheet Filler — Popup Logic

(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────────────────────────

  let state = {
    projects: [],
    attendanceDefaults: {
      workPlace: 'Mobile working',
      period1Start: '08:30',
      period1End: '12:30',
      period2Start: '13:00',
      period2End: '17:00'
    },
    // weekHistory: keyed by week's Monday ISO date, stored in chrome.storage.local
    // Each value: { "YYYY-MM-DD": { enabled, projectEntries, attendance } }
    weekHistory: {},
    weekOffset: 0,       // 0 = current week, -1 = last week, -2 = two weeks ago, etc.
    currentWeek: []      // [{date, dayName, enabled, projectEntries, attendance}]
  };

  const MAX_WEEKS_BACK = 12; // How far back we allow navigation
  let pollInterval = null;
  let submittedPayload = null;

  // ─── Init ──────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async () => {
    await loadStorage();
    setupTabs();
    applyWeekOffset(0);    // Renders current week
    renderSettingsTab();
    bindActions();
  });

  async function loadStorage() {
    // Load sync storage (projects, settings)
    await new Promise(resolve => {
      chrome.storage.sync.get(['projects', 'attendanceDefaults'], (data) => {
        state.projects = data.projects || [];
        if (data.attendanceDefaults) {
          state.attendanceDefaults = data.attendanceDefaults;
        }
        resolve();
      });
    });

    // Load local storage (week history — larger, no sync needed)
    await new Promise(resolve => {
      chrome.storage.local.get(['weekHistory'], (data) => {
        state.weekHistory = data.weekHistory || {};
        resolve();
      });
    });
  }

  // ─── Tab Switching ─────────────────────────────────────────────────────────

  function setupTabs() {
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
        btn.classList.add('active');
        document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
      });
    });
  }

  // ─── Week Offset & Date Utils ───────────────────────────────────────────────

  /** ISO date string from a Date object */
  function toIso(date) {
    return date.toISOString().split('T')[0];
  }

  /** Get the Monday of the current real week */
  function getCurrentMonday() {
    const today = new Date();
    const day = today.getDay(); // 0=Sun
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(today);
    monday.setDate(today.getDate() + diff);
    monday.setHours(0, 0, 0, 0);
    return monday;
  }

  /** Get the Monday for a given offset (0=current, -1=last week, etc.) */
  function getMondayForOffset(offset) {
    const monday = getCurrentMonday();
    monday.setDate(monday.getDate() + offset * 7);
    return monday;
  }

  /** Get all 7 dates (Mon-Sun) for a given week offset */
  function getWeekDatesForOffset(offset) {
    const monday = getMondayForOffset(offset);
    const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return {
        iso: toIso(d),
        dayName: DAY_NAMES[i],
        defaultEnabled: i < 5
      };
    });
  }

  function formatDisplayDate(isoDate) {
    const d = new Date(isoDate + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ─── Week Navigation ────────────────────────────────────────────────────────

  /** Apply a new week offset: update dates, rebuild week state, re-render */
  function applyWeekOffset(newOffset) {
    state.weekOffset = newOffset;
    const weekDates = getWeekDatesForOffset(newOffset);

    // Update week label
    document.getElementById('week-label').textContent =
      `${formatDisplayDate(weekDates[0].iso)} – ${formatDisplayDate(weekDates[6].iso)}`;

    // Show/hide "current" badge
    const badge = document.getElementById('week-badge');
    badge.classList.toggle('hidden', newOffset !== 0);

    // Disable next-week button when at current week; disable prev at limit
    document.getElementById('btn-next-week').disabled = newOffset >= 0;
    document.getElementById('btn-prev-week').disabled = newOffset <= -MAX_WEEKS_BACK;

    // Build currentWeek state — restore from saved draft if available, else blank
    state.currentWeek = weekDates.map(({ iso, dayName, defaultEnabled }) => ({
      date: iso,
      dayName,
      enabled: defaultEnabled,
      projectEntries: [],
      attendance: { ...state.attendanceDefaults }
    }));

    const mondayIso = toIso(getMondayForOffset(newOffset));
    const savedDraft = state.weekHistory[mondayIso];
    if (savedDraft) {
      applyHistoryToCurrentWeek(savedDraft);
    }

    renderDaysContainer();
    hideError();

    // Update "Load saved" button label (mondayIso already declared above)
    const hasHistory = !!state.weekHistory[mondayIso];
    const loadBtn = document.getElementById('btn-load-week-data');
    loadBtn.textContent = hasHistory ? 'Load saved ✓' : 'Load saved';
    loadBtn.title = hasHistory
      ? `Saved data found for week of ${formatDisplayDate(mondayIso)} — click to load`
      : 'No saved data for this week yet';
  }

  // ─── Render Days ────────────────────────────────────────────────────────────

  let autoSaveTimer = null;
  function scheduleDraftSave() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(saveDraft, 800);
  }

  function renderDaysContainer() {
    const container = document.getElementById('days-container');
    container.innerHTML = '';
    state.currentWeek.forEach((day, idx) => {
      container.appendChild(buildDayCard(day, idx));
    });

    // Auto-save on any input/change inside the days container (event delegation)
    container.addEventListener('input', scheduleDraftSave);
    container.addEventListener('change', scheduleDraftSave);
  }

  function buildDayCard(day, idx) {
    const card = document.createElement('div');
    card.className = `day-card${day.enabled ? '' : ' disabled'}`;

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = day.enabled;
    checkbox.addEventListener('change', (e) => {
      day.enabled = e.target.checked;
      card.classList.toggle('disabled', !day.enabled);
      body.classList.toggle('hidden', !day.enabled);
    });

    const nameEl = document.createElement('span');
    nameEl.className = 'day-name';
    nameEl.textContent = day.dayName;

    const dateEl = document.createElement('span');
    dateEl.className = 'day-date';
    dateEl.textContent = formatDisplayDate(day.date);

    header.appendChild(checkbox);
    header.appendChild(nameEl);
    header.appendChild(dateEl);
    header.addEventListener('click', (e) => {
      if (e.target === checkbox) return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    });

    // Body
    const body = document.createElement('div');
    body.className = `day-body${day.enabled ? '' : ' hidden'}`;

    // Project entries list
    const projectEntries = document.createElement('div');
    projectEntries.className = 'project-entries';
    day.projectEntries.forEach((entry, entryIdx) => {
      projectEntries.appendChild(buildProjectRow(day, entry, entryIdx));
    });
    body.appendChild(projectEntries);

    // Add project row button
    const addProjectBtn = document.createElement('button');
    addProjectBtn.className = 'btn-add-project-row';
    addProjectBtn.textContent = '+ Add project';
    addProjectBtn.addEventListener('click', () => {
      const newEntry = { templateName: '', hours: 8, description: '' };
      day.projectEntries.push(newEntry);
      projectEntries.appendChild(buildProjectRow(day, newEntry, day.projectEntries.length - 1));
    });
    body.appendChild(addProjectBtn);

    // Attendance row
    body.appendChild(buildAttendanceRow(day));

    card.appendChild(header);
    card.appendChild(body);
    return card;
  }

  function buildProjectRow(day, entry, entryIdx) {
    const row = document.createElement('div');
    row.className = 'project-row';

    const layout = document.createElement('div');
    layout.className = 'project-row-layout';

    const topRow = document.createElement('div');
    topRow.className = 'project-top-row';

    // Template dropdown (known templates + custom option)
    const projectSelect = document.createElement('select');
    projectSelect.innerHTML = '<option value="">-- Select template --</option>';
    state.projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.templateName;
      opt.textContent = p.displayName;
      if (p.templateName === entry.templateName) opt.selected = true;
      projectSelect.appendChild(opt);
    });
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom template name…';
    projectSelect.appendChild(customOpt);

    // Custom text input (shown when not in registry)
    const customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.placeholder = 'SAP template name';
    customInput.value = entry.templateName;

    const isKnown = state.projects.some(p => p.templateName === entry.templateName);
    const showCustom = entry.templateName && !isKnown;
    projectSelect.value = showCustom ? '__custom__' : (entry.templateName || '');
    customInput.style.display = showCustom ? 'block' : 'none';

    projectSelect.addEventListener('change', () => {
      if (projectSelect.value === '__custom__') {
        customInput.style.display = 'block';
        entry.templateName = customInput.value;
      } else {
        customInput.style.display = 'none';
        entry.templateName = projectSelect.value;
      }
    });
    customInput.addEventListener('input', () => { entry.templateName = customInput.value; });

    // Hours + "h" label wrapper
    const hoursWrapper = document.createElement('div');
    hoursWrapper.className = 'hours-wrapper';

    const hoursInput = document.createElement('input');
    hoursInput.type = 'number';
    hoursInput.min = 0; hoursInput.max = 24; hoursInput.step = 0.5;
    hoursInput.value = entry.hours || 8;
    hoursInput.title = 'Hours worked';
    hoursInput.addEventListener('input', () => {
      entry.hours = parseFloat(hoursInput.value) || 0;
    });

    const hoursLabel = document.createElement('span');
    hoursLabel.className = 'hours-unit';
    hoursLabel.textContent = 'hrs';

    hoursWrapper.appendChild(hoursInput);
    hoursWrapper.appendChild(hoursLabel);

    topRow.appendChild(projectSelect);
    topRow.appendChild(customInput);
    topRow.appendChild(hoursWrapper);
    layout.appendChild(topRow);

    // Description
    const descInput = document.createElement('textarea');
    descInput.className = 'project-description';
    descInput.placeholder = 'Description of work done…';
    descInput.rows = 2;
    descInput.maxLength = 500;
    descInput.value = entry.description || '';
    descInput.addEventListener('input', () => { entry.description = descInput.value; });
    layout.appendChild(descInput);

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove-project';
    removeBtn.title = 'Remove this entry';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      day.projectEntries.splice(entryIdx, 1);
      row.remove();
    });

    row.appendChild(layout);
    row.appendChild(removeBtn);
    return row;
  }

  function buildAttendanceRow(day) {
    const wrapper = document.createElement('div');
    const att = day.attendance;

    // Collapsed summary
    const summary = document.createElement('div');
    summary.className = 'attendance-summary';

    const summaryText = document.createElement('span');
    summaryText.className = 'attendance-summary-text';
    const updateSummaryText = () => {
      let text = `${att.period1Start || '?'}–${att.period1End || '?'}`;
      if (att.period2Start && att.period2End) text += `, ${att.period2Start}–${att.period2End}`;
      text += ` | ${att.workPlace || 'Work place?'}`;
      summaryText.textContent = text;
    };
    updateSummaryText();

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn-toggle-attendance';
    toggleBtn.textContent = 'edit ▾';
    summary.appendChild(summaryText);
    summary.appendChild(toggleBtn);

    // Expanded detail
    const detail = document.createElement('div');
    detail.className = 'attendance-detail hidden';

    const makeTimeRow = (labelText, startKey, endKey) => {
      const row = document.createElement('div');
      row.className = 'attendance-form-row';
      const label = document.createElement('label');
      label.textContent = labelText;
      const startInput = document.createElement('input');
      startInput.type = 'time';
      startInput.value = att[startKey] || '';
      startInput.addEventListener('change', () => { att[startKey] = startInput.value; updateSummaryText(); });
      const dash = document.createElement('span');
      dash.textContent = '–';
      const endInput = document.createElement('input');
      endInput.type = 'time';
      endInput.value = att[endKey] || '';
      endInput.addEventListener('change', () => { att[endKey] = endInput.value; updateSummaryText(); });
      row.append(label, startInput, dash, endInput);
      return row;
    };

    detail.appendChild(makeTimeRow('Period 1', 'period1Start', 'period1End'));
    detail.appendChild(makeTimeRow('Period 2', 'period2Start', 'period2End'));

    // Work place segmented buttons
    const wpRow = document.createElement('div');
    wpRow.className = 'attendance-form-row';
    const wpLabel = document.createElement('label');
    wpLabel.textContent = 'Work place';
    const wpBtns = document.createElement('div');
    wpBtns.className = 'workplace-btns';
    ['Mobile working', 'In office', 'Customer visit'].forEach(place => {
      const btn = document.createElement('button');
      btn.className = `workplace-btn${att.workPlace === place ? ' active' : ''}`;
      btn.textContent = place;
      btn.addEventListener('click', () => {
        att.workPlace = place;
        wpBtns.querySelectorAll('.workplace-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateSummaryText();
      });
      wpBtns.appendChild(btn);
    });
    wpRow.append(wpLabel, wpBtns);
    detail.appendChild(wpRow);

    let expanded = false;
    const toggle = () => {
      expanded = !expanded;
      detail.classList.toggle('hidden', !expanded);
      toggleBtn.textContent = expanded ? 'done ▴' : 'edit ▾';
    };
    toggleBtn.addEventListener('click', toggle);
    summary.addEventListener('click', (e) => { if (e.target !== toggleBtn) toggle(); });

    wrapper.appendChild(summary);
    wrapper.appendChild(detail);
    return wrapper;
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  function bindActions() {
    document.getElementById('btn-prev-week').addEventListener('click', () => {
      if (state.weekOffset > -MAX_WEEKS_BACK) applyWeekOffset(state.weekOffset - 1);
    });

    document.getElementById('btn-next-week').addEventListener('click', () => {
      if (state.weekOffset < 0) applyWeekOffset(state.weekOffset + 1);
    });

    document.getElementById('btn-load-week-data').addEventListener('click', loadWeekData);
    document.getElementById('btn-fill-sap').addEventListener('click', fillSAP);
    document.getElementById('btn-add-project').addEventListener('click', addProject);
    document.getElementById('btn-import-templates').addEventListener('click', importTemplatesFromSAP);
    document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  }

  // ─── Load Saved Week Data ──────────────────────────────────────────────────

  function loadWeekData() {
    const mondayIso = toIso(getMondayForOffset(state.weekOffset));
    const saved = state.weekHistory[mondayIso];

    if (!saved) {
      // No exact match — if viewing current week, try loading the previous week's data
      // (same behavior as "Load Last Week" was: carry forward from the week before)
      if (state.weekOffset === 0) {
        const prevMondayIso = toIso(getMondayForOffset(-1));
        const prevSaved = state.weekHistory[prevMondayIso];
        if (prevSaved) {
          applyHistoryToCurrentWeek(prevSaved);
          showError(`No data for this week. Loaded previous week's entries as a starting point.`);
          return;
        }
      }
      showError(`No saved data found for the week of ${formatDisplayDate(mondayIso)}.`);
      return;
    }

    applyHistoryToCurrentWeek(saved);
    hideError();
  }

  /**
   * Apply a saved week's day entries onto the current week form.
   * The saved data is an object keyed by ISO date; we map by day-of-week index
   * so that Mon data goes to Mon, Tue to Tue, etc. regardless of actual dates.
   */
  function applyHistoryToCurrentWeek(savedWeek) {
    // Match by actual date (day.date → savedWeek[day.date]), not by index.
    // This ensures each day's data goes to the correct day regardless of gaps.
    state.currentWeek.forEach(day => {
      const savedDay = savedWeek[day.date];
      if (!savedDay) return;

      day.enabled = savedDay.enabled !== undefined ? savedDay.enabled : day.enabled;
      day.projectEntries = (savedDay.projectEntries || []).map(e => ({ ...e }));
      day.attendance = savedDay.attendance
        ? { ...savedDay.attendance }
        : { ...state.attendanceDefaults };
    });

    renderDaysContainer();
  }

  // ─── Save Draft ────────────────────────────────────────────────────────────

  async function saveDraft() {
    const mondayIso = toIso(getMondayForOffset(state.weekOffset));

    const weekEntry = {};
    state.currentWeek.forEach(day => {
      weekEntry[day.date] = {
        enabled: day.enabled,
        projectEntries: day.projectEntries.map(e => ({ ...e })),
        attendance: { ...day.attendance }
      };
    });

    state.weekHistory[mondayIso] = weekEntry;
    await chrome.storage.local.set({ weekHistory: state.weekHistory });

    // Update "Load saved" button
    document.getElementById('btn-load-week-data').textContent = 'Load saved ✓';

  }

  // ─── Fill SAP ──────────────────────────────────────────────────────────────

  async function fillSAP() {
    hideError();

    const enabledDays = state.currentWeek.filter(d => d.enabled && d.projectEntries.length > 0);
    if (!enabledDays.length) {
      showError('No enabled days with project entries. Add at least one project to a day.');
      return;
    }

    for (const day of enabledDays) {
      for (const entry of day.projectEntries) {
        if (!entry.templateName) {
          showError(`Missing template name for ${day.dayName}.`);
          return;
        }
      }
    }

    // Include the target week's Monday so the content script can navigate SAP to it
    const targetWeekMonday = toIso(getMondayForOffset(state.weekOffset));

    const payload = {
      type: 'FILL_SAP',
      targetWeekMonday,
      days: enabledDays.map(day => ({
        date: day.date,
        projectEntries: day.projectEntries.map(e => ({
          templateName: e.templateName,
          hours: String(e.hours),
          description: e.description || ''
        })),
        attendance: day.attendance || null
      }))
    };

    submittedPayload = enabledDays;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { showError('No active tab found.'); return; }

    let pingResponse;
    try {
      pingResponse = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    } catch {
      showError('Extension not active on this page. Navigate to the SAP Time Recording page first.');
      return;
    }

    if (!pingResponse?.ready) {
      showError('Content script not ready. Refresh the SAP page and try again.');
      return;
    }

    await chrome.storage.local.set({ progress: [], automationDone: false });
    showProgressArea();
    document.getElementById('btn-fill-sap').disabled = true;

    try {
      await chrome.tabs.sendMessage(tab.id, payload);
    } catch (err) {
      showError(`Failed to send to page: ${err.message}`);
      document.getElementById('btn-fill-sap').disabled = false;
      return;
    }

    pollInterval = setInterval(async () => {
      const data = await new Promise(r =>
        chrome.storage.local.get(['progress', 'automationDone', 'automationResult'], r)
      );
      renderProgressLog(data.progress || []);

      if (data.automationDone) {
        clearInterval(pollInterval);
        pollInterval = null;
        document.getElementById('btn-fill-sap').disabled = false;

        if (data.automationResult) {
          await persistWeekData(targetWeekMonday);
          // Refresh load button state
          applyWeekOffset(state.weekOffset);
        }
      }
    }, 500);
  }

  function renderProgressLog(entries) {
    const log = document.getElementById('progress-log');
    log.innerHTML = '';
    entries.forEach(({ msg }) => {
      const line = document.createElement('div');
      line.className = msg.startsWith('✓') ? 'log-success'
        : msg.startsWith('✗') ? 'log-error' : 'log-info';
      line.textContent = msg;
      log.appendChild(line);
    });
    log.scrollTop = log.scrollHeight;
  }

  function showProgressArea() {
    document.getElementById('progress-area').classList.remove('hidden');
    document.getElementById('progress-log').innerHTML = '';
  }

  // ─── Persist Week Data ─────────────────────────────────────────────────────

  async function persistWeekData(mondayIso) {
    if (!submittedPayload) return;

    const weekEntry = {};
    submittedPayload.forEach(day => {
      weekEntry[day.date] = {
        enabled: day.enabled,
        projectEntries: day.projectEntries.map(e => ({
          projectId: state.projects.find(p => p.templateName === e.templateName)?.id || null,
          templateName: e.templateName,
          hours: e.hours,
          description: e.description
        })),
        attendance: day.attendance
      };
    });

    state.weekHistory[mondayIso] = weekEntry;

    // Prune history older than MAX_WEEKS_BACK + a few extra to avoid creep
    const cutoffDate = toIso(getMondayForOffset(-(MAX_WEEKS_BACK + 4)));
    Object.keys(state.weekHistory).forEach(k => {
      if (k < cutoffDate) delete state.weekHistory[k];
    });

    await chrome.storage.local.set({ weekHistory: state.weekHistory });
  }

  // ─── Settings Tab ──────────────────────────────────────────────────────────

  function renderSettingsTab() {
    renderProjectsList();
    renderAttendanceDefaults();
  }

  async function importTemplatesFromSAP() {
    const btn = document.getElementById('btn-import-templates');
    const status = document.getElementById('import-status');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    status.classList.add('hidden');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('No active tab found');

      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TEMPLATES' });
      if (!response || response.error) {
        throw new Error(response?.error || 'No response from SAP page');
      }

      const templates = response.templates || [];
      if (!templates.length) throw new Error('No templates found');

      // Add templates that don't already exist
      let added = 0;
      for (const name of templates) {
        const exists = state.projects.some(p => p.templateName === name);
        if (!exists) {
          state.projects.push({ id: generateId(), displayName: name, templateName: name });
          added++;
        }
      }

      await chrome.storage.sync.set({ projects: state.projects });
      renderProjectsList();

      status.textContent = added > 0
        ? `Imported ${added} new template(s). ${templates.length - added} already existed.`
        : `All ${templates.length} templates already imported.`;
      status.classList.remove('hidden');
    } catch (err) {
      status.textContent = `Import failed: ${err.message}. Make sure you're on the SAP Time Recording page.`;
      status.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import templates from SAP';
    }
  }

  function renderProjectsList() {
    const list = document.getElementById('projects-list');
    list.innerHTML = '';

    if (!state.projects.length) {
      list.innerHTML = '<div class="empty-state">No projects yet. Add one below.</div>';
      return;
    }

    state.projects.forEach((project, idx) => {
      const item = document.createElement('div');
      item.className = 'project-list-item';

      const name = document.createElement('span');
      name.className = 'project-list-name';
      name.textContent = project.displayName;

      const search = document.createElement('span');
      search.className = 'project-list-search';
      search.textContent = project.templateName;

      const del = document.createElement('button');
      del.className = 'btn-delete-project';
      del.title = 'Delete';
      del.textContent = '×';
      del.addEventListener('click', () => deleteProject(idx));

      item.append(name, search, del);
      list.appendChild(item);
    });
  }

  function renderAttendanceDefaults() {
    const d = state.attendanceDefaults;
    document.getElementById('default-period1-start').value = d.period1Start || '';
    document.getElementById('default-period1-end').value   = d.period1End   || '';
    document.getElementById('default-period2-start').value = d.period2Start || '';
    document.getElementById('default-period2-end').value   = d.period2End   || '';
    document.getElementById('default-work-place').value    = d.workPlace    || 'Mobile working';
  }

  function addProject() {
    const nameInput   = document.getElementById('new-project-name');
    const searchInput = document.getElementById('new-project-search');
    const displayName = nameInput.value.trim();
    const templateName = searchInput.value.trim();

    if (!displayName || !templateName) {
      alert('Please enter both a display name and a SAP template name.');
      return;
    }

    state.projects.push({ id: generateId(), displayName, templateName });
    chrome.storage.sync.set({ projects: state.projects });
    nameInput.value = '';
    searchInput.value = '';
    renderProjectsList();
  }

  function deleteProject(idx) {
    state.projects.splice(idx, 1);
    chrome.storage.sync.set({ projects: state.projects });
    renderProjectsList();
  }

  function saveSettings() {
    const d = state.attendanceDefaults;
    d.period1Start = document.getElementById('default-period1-start').value;
    d.period1End   = document.getElementById('default-period1-end').value;
    d.period2Start = document.getElementById('default-period2-start').value;
    d.period2End   = document.getElementById('default-period2-end').value;
    d.workPlace    = document.getElementById('default-work-place').value;
    chrome.storage.sync.set({ attendanceDefaults: d });

    const msg = document.getElementById('settings-saved-msg');
    msg.classList.remove('hidden');
    setTimeout(() => msg.classList.add('hidden'), 2000);
  }

  // ─── Error Display ─────────────────────────────────────────────────────────

  function showError(msg) {
    const banner = document.getElementById('error-banner');
    banner.textContent = msg;
    banner.classList.remove('hidden');
  }

  function hideError() {
    document.getElementById('error-banner').classList.add('hidden');
  }

  // ─── Utils ─────────────────────────────────────────────────────────────────

  function generateId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

})();
