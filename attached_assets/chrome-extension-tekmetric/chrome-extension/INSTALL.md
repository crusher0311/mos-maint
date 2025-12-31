# Quick Installation Guide

**Current Version: 1.5.1** - See [CHANGELOG.md](CHANGELOG.md) for version history

## Install the Chrome Extension

1. **Open Chrome Extensions**
   - Navigate to `chrome://extensions/`
   - Enable **Developer mode** (toggle in top right)

2. **Load the Extension**
   - Click **Load unpacked**
   - Select the `chrome-extension` folder from this project

3. **Verify Installation**
   - You should see "Tekmetric Job Importer" in your extensions list
   - Pin the extension to your toolbar for easy access

## How to Use

### Step 1: Search for a Job
1. Open your repair search tool
2. Search for a vehicle and repair type (e.g., "2005 Honda CR-V" + "front struts")
3. Click on a search result to view details

### Step 2: Send to Tekmetric
1. In the job detail panel, click **"Send to Tekmetric"**
2. You'll see a confirmation: "Sent to Tekmetric Extension"

### Step 3: Auto-Fill in Tekmetric
1. Navigate to Tekmetric (https://shop.tekmetric.com)
2. Open or create an estimate
3. The extension will automatically:
   - Detect the estimate page
   - Fill in labor items (description, hours, rate)
   - Fill in parts (name, part number, brand, quantity, cost, retail)
4. You'll see a success notification when complete

## Check Extension Status

Click the extension icon in Chrome to see:
- Current pending job (ready to import)
- Last imported job details
- Import timestamp

## Troubleshooting

### Extension Not Auto-Filling?
1. Make sure you're on a Tekmetric estimate page
2. Try refreshing the Tekmetric page
3. Check the extension popup to verify data was received
4. Open DevTools (F12) and check the Console for error messages

### Data Not Sending?
1. Verify the extension is installed and enabled
2. Reload the repair search tool page
3. Try searching for a job again

## Updating the Extension

When a new version is released:

1. **Check Current Version**
   - Click the extension icon
   - Look at the top-right corner of the popup (e.g., "v1.1.0")

2. **Update to Latest Version**
   - Go to `chrome://extensions/`
   - Find "Tekmetric Job Importer"
   - Click the **reload icon** (↻) to reload the extension
   - The version number in the popup will update

3. **Download New Version** (if needed)
   - Pull latest changes from git repository
   - Follow installation steps above
   - No need to uninstall - just reload!

## Version History

See [CHANGELOG.md](CHANGELOG.md) for full version history and release notes.

## Notes

- The extension stores the last imported job in Chrome storage for reference
- Icon files can be customized (see create-icons.md)
- All data is processed locally - nothing is sent to external servers
- Version number is displayed in the extension popup (top-right corner)

For detailed documentation, see README.md
