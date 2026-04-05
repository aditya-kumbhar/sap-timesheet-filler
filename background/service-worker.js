// SAP Timesheet Filler — Service Worker
// Minimal: only sets up default storage on install.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install') return;

  chrome.storage.sync.set({
    projects: [],
    attendanceDefaults: {
      workPlace: 'Mobile working',
      period1Start: '08:30',
      period1End: '12:30',
      period2Start: '13:00',
      period2End: '17:00'
    },
    lastWeek: {}
  });

  chrome.storage.local.set({
    progress: [],
    automationDone: true,
    automationResult: null,
    weekHistory: {}
  });
});
