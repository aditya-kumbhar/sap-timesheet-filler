# SAP Timesheet Filler

A Chrome extension that automates SAP timesheet entry using pre-configured templates.

## Features

- Fill project time entries using SAP templates (Select Template > Add)
- Fill attendance entries with configurable time periods and work place
- Support for multiple project entries per day
- Week navigation — fill current or past weeks
- Auto-save drafts per week
- Import templates directly from SAP

## Prerequisites

- Google Chrome browser
- Access to SAP Time and Performance Recording (on `*.hana.ondemand.com`)
- SAP templates must already be created in your SAP account (Select Template menu)

Note that the project work description and work hours for the SAP templates will be overridden with what you specify in the extension. 
You only need to setup a template for each project that you need to book time against and you can customize the work hours in the extension.

<!-- Screenshot: SAP week view showing the "Select Template" dropdown with templates listed -->
<img width="603" height="185" alt="image" src="https://github.com/user-attachments/assets/54c76955-9ef1-4059-b3c9-afdd47354506" />

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the `sap-timesheet-filler` folder
5. The extension icon should appear in your Chrome toolbar

<!-- Screenshot: chrome://extensions page with Developer mode enabled and Load unpacked button -->

## Setup

### 1. Import Templates

1. Navigate to your SAP Time Recording page with the weekly calendar view (it's recommended to refresh the page once).
2. Click the extension icon to open the popup
3. Go to the **Settings** tab
4. Click **Import templates from SAP** — this reads your existing SAP templates automatically

<!-- Screenshot: Settings tab showing the Import button and imported templates -->
<img width="460" height="466" alt="image" src="https://github.com/user-attachments/assets/85709006-92eb-48ca-8b20-567736abbb51" />

Alternatively, add templates manually:
- **Display name**: A friendly name shown in the extension dropdown
- **SAP template name**: Must match *exactly* what appears in SAP's "Select Template" menu

### 2. Configure Attendance Defaults

In the Settings tab, set your default attendance times:
- **Period 1**: Start and end time (e.g., 08:30 – 12:30)
- **Period 2**: Start and end time (e.g., 13:00 – 17:00)
- **Work place**: Mobile working / In office / Customer visit

Click **Save Settings** when done.

<!-- Screenshot: Attendance defaults section in Settings -->
<img width="460" height="466" alt="image" src="https://github.com/user-attachments/assets/6c1d705c-5539-491e-a70b-5608f08cf1c6" />


## Usage

### Filling a Week

1. Navigate to the SAP Time Recording page in Chrome
2. Click the extension icon
3. On the **This Week** tab, check the days you want to fill
4. For each day, click **+ Add project** and:
   - Select a template from the dropdown
   - Set the hours
   - Enter a description
5. Adjust attendance settings per day if needed (click **edit**)
6. Click **Fill SAP**

<!-- Screenshot: This Week tab with project entries filled in for a day -->
<img width="459" height="605" alt="image" src="https://github.com/user-attachments/assets/5c6c48d1-6a78-4f27-a8fe-a99112b6474c" />

Click on the small button below to configure `Time Periods` and `Work Place` for a specific day; the defaults from the settings tab are auto-populated.
<img width="458" height="460" alt="image" src="https://github.com/user-attachments/assets/1f7a7919-1d78-4a75-89b7-91e646181dbc" />


The extension will:
- Click "Select Template" for each project entry
- Select the template and click "Add"
- Override the date, duration, and description
- Save the entry
- Repeat for attendance entries (click Add > Attendance tab > fill times)

### Progress Tracking

A progress log appears at the bottom showing each entry's status:
- `✓` — Entry saved successfully
- `✗` — Entry failed (with error message)

<!-- Screenshot: Progress log showing successful and failed entries -->
<img width="461" height="601" alt="image" src="https://github.com/user-attachments/assets/f003255e-8de3-4d97-8146-a74597597c12" />

### Past Weeks

Use the `‹` / `›` arrows next to the week label to navigate to past weeks. The extension supports filling up to 12 weeks back.

### Saving & Loading

- Drafts auto-save as you edit
- Click **Load saved** to restore a previously saved week's configuration

## Troubleshooting

### "Extension not active on this page"

- Make sure you're on the SAP Time Recording page with the weekly view (does not have to be current week). (`*.hana.ondemand.com`)
- Refresh the SAP page (Cmd+R / Ctrl+R)
- Reload the extension at `chrome://extensions`

### Template not found in menu

- Ensure the template name in the extension matches the SAP template name exactly
- Use the **Import templates from SAP** button to auto-detect template names

### Entries failing with timeouts

- SAP can be slow — the extension waits up to 12 seconds for pages to load
- If entries fail consistently, try with fewer days at a time
- Refresh the SAP page and try again

### Extension context invalidated

- This happens if you reload the extension while automation is running
- Refresh the SAP page and try again

## Project Structure

```
auto-sap/
├── manifest.json          # Chrome extension manifest (MV3)
├── background/
│   └── service-worker.js  # Sets up default storage on install
├── content/
│   ├── ui5-helpers.js     # DOM utilities for SAP UI5 elements
│   ├── content.js         # Main automation logic (content script)
│   └── page-world.js      # Bridge script for SAP UI5 API access
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.css          # Popup styles
│   └── popup.js           # Popup logic and state management
└── icons/                 # Extension icons
```

## How It Works

SAP Fiori Launchpad embeds apps in iframes with strict Content Security Policy. The extension uses three layers to interact with SAP:

1. **Content script** (`content.js` + `ui5-helpers.js`) — injected into all frames, finds DOM elements and orchestrates the automation flow
2. **Page-world bridge** (`page-world.js`) — injected as a `<script src>` tag to run in the page's JS context where `sap.ui.getCore()` is accessible. Communicates with the content script via `CustomEvent`
3. **Popup** (`popup.js`) — the user interface for configuring entries and triggering automation
