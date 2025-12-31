# Tekmetric Job Importer Chrome Extension

A Chrome extension that integrates your Repair Order Search Tool with Tekmetric, allowing you to automatically import job details (labor items and parts) into Tekmetric estimates.

## Features

- 🔍 **One-Click Import**: Search for similar jobs and send them directly to Tekmetric
- ⚡ **Auto-Fill Estimates**: Automatically populates labor items and parts in Tekmetric estimate forms
- 📋 **Job History**: View the last imported job in the extension popup
- 🎯 **Smart Detection**: Automatically detects when you're on a Tekmetric estimate page

## Installation

### Step 1: Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top right corner)
3. Click **Load unpacked**
4. Select the `chrome-extension` folder from your project directory

### Step 2: Verify Installation

You should see "Tekmetric Job Importer" in your extensions list with a blue icon.

## Usage

### Workflow

1. **Search for a Job**
   - Open your Repair Order Search Tool
   - Search for a vehicle and repair type (e.g., "2005 Honda CR-V" + "front struts")
   - Review the job details in the detail panel

2. **Send to Tekmetric**
   - Click the **"Send to Tekmetric"** button in the job detail panel
   - You'll see a confirmation toast: "Sent to Tekmetric Extension"

3. **Auto-Fill in Tekmetric**
   - Navigate to Tekmetric (https://shop.tekmetric.com)
   - Open or create an estimate
   - The extension will automatically detect the page and fill in:
     - Labor items (description, hours, rate)
     - Parts (name, part number, brand, quantity, cost, retail)
   - You'll see a success notification when the import completes

### Checking Extension Status

Click the extension icon in Chrome's toolbar to see:
- Current pending job (if any)
- Last imported job details
- Import timestamp

## Supported Tekmetric Pages

The extension activates on these Tekmetric pages:
- `/estimates/*` - Creating or editing estimates
- `/repair-orders/*` - Working with repair orders

## Permissions Required

- **storage**: Save the last imported job for reference
- **activeTab**: Access the current Tekmetric tab
- **scripting**: Inject auto-fill functionality
- **host_permissions**: 
  - `https://shop.tekmetric.com/*` - Tekmetric website
  - `http://localhost:5000/*` - Local development
  - `*.replit.dev/*` - Replit deployment

## Troubleshooting

### Extension Not Auto-Filling

1. **Check you're on the right page**: Make sure you're on a Tekmetric estimate page
2. **Reload the page**: Try refreshing the Tekmetric page after sending data
3. **Check the extension popup**: Verify the job data was received
4. **Console logs**: Open DevTools (F12) and check the Console tab for messages

### Data Not Sending from Search Tool

1. **Verify extension is installed**: Check `chrome://extensions/`
2. **Check permissions**: Ensure the extension has access to your search tool domain
3. **Reload the search tool**: Try refreshing the page and searching again

### Manual Fallback

If auto-fill doesn't work, you can always use the **"Copy Details"** button to manually copy and paste job information.

## Development

### File Structure

```
chrome-extension/
├── manifest.json       # Extension configuration
├── background.js       # Service worker (message handling)
├── inject.js          # Inject script for search tool
├── content.js         # Content script for Tekmetric
├── popup.html         # Extension popup UI
├── popup.css          # Popup styling
├── popup.js           # Popup logic
└── README.md          # This file
```

### How It Works

1. **Search Tool → Extension**:
   - User clicks "Send to Tekmetric" button
   - Web app sends message via `window.postMessage()`
   - Inject script (`inject.js`) forwards to background service worker
   - Background worker stores job data in memory and Chrome storage

2. **Extension → Tekmetric**:
   - Content script (`content.js`) runs on Tekmetric pages
   - Detects estimate pages and checks for pending job data
   - Auto-fills form fields with labor and parts information
   - Shows success/error notifications
   - Clears pending job after successful import

### Debugging

Enable verbose logging:
1. Open DevTools (F12) on any page
2. Look for console messages prefixed with:
   - `Tekmetric Job Importer: Inject script loaded` (on search tool)
   - `Tekmetric Job Importer: Content script loaded` (on Tekmetric)
   - `Background: Received job data` (in extension service worker)

To view service worker logs:
1. Go to `chrome://extensions/`
2. Find "Tekmetric Job Importer"
3. Click "service worker" link
4. View console logs in the DevTools window

## Future Enhancements

- [ ] Support for additional Tekmetric form fields
- [ ] Batch import multiple jobs
- [ ] Custom field mapping
- [ ] Import history and analytics
- [ ] Support for other shop management systems

## Support

If you encounter issues:
1. Check the Troubleshooting section above
2. Review console logs for errors
3. Verify extension permissions
4. Try reloading both the search tool and Tekmetric

## Version History

### v1.0.0 (Initial Release)
- Send job details from search tool to Tekmetric
- Auto-fill labor items and parts in estimates
- Extension popup showing job status
- Success/error notifications
