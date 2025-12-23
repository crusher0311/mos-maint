# MOS AutoVitals Chrome Extension

This Chrome extension syncs Digital Vehicle Inspection (DVI) data from AutoVitals to your MOS Maintenance system.

## Installation (Development)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" in the top right corner
3. Click "Load unpacked" and select this `chrome-extension` folder
4. The extension icon should appear in your toolbar

## Setup

1. Click the MOS AutoVitals extension icon in your Chrome toolbar
2. Enter your MOS server URL (e.g., `https://your-app.replit.app`)
3. Enter your API key (generated from MOS Settings > Integrations > AutoVitals)
4. Click "Connect"

## Usage

Once connected, the extension will automatically detect when you're viewing a vehicle inspection on AutoVitals and sync the DVI data to MOS.

- Navigate to AutoVitals and log in
- View any vehicle inspection
- The extension will automatically extract and sync the inspection data

## Creating Icons

The extension requires icon files. You can create simple placeholder icons or use your own:

- `icons/icon16.png` - 16x16 pixels
- `icons/icon48.png` - 48x48 pixels  
- `icons/icon128.png` - 128x128 pixels

## Security Note

The API key is stored in Chrome's local storage. This is isolated per-extension but consider using a dedicated API key with limited permissions for production use.

## Publishing to Chrome Web Store

1. Create a ZIP file of this folder (excluding README and development files)
2. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/)
3. Create a new item and upload the ZIP
4. Fill in the required information and submit for review
