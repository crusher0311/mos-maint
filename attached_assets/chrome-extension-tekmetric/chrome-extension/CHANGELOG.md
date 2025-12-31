# Tekmetric Job Importer - Changelog

All notable changes to this extension will be documented in this file.

## [3.26.0] - 2025-12-29

### 🎨 UI IMPROVEMENT: Icon-Only Tab Navigation
- **Changed**: Replaced text+icon tabs with circular icon-only buttons
- **Benefits**:
  - All 6 tabs now fit without horizontal overflow
  - Cleaner, more modern appearance matching header button style
  - No more horizontal scrolling on narrow sidebar widths
- **Tooltips**: Hover over any tab icon to see the full name (e.g., "Incoming Caller", "Search Jobs")
- **Styling**: 
  - Inactive tabs: Light gray circular buttons with colored icon on hover
  - Active tab: HEART Red filled circle with white icon and subtle shadow

### Technical Details
- Tab buttons are now 38px circular buttons with centered 16px icons
- Removed text labels, added `title` attributes for accessibility tooltips
- Tab navigation uses `justify-content: space-evenly` to span full width
- Active state includes box-shadow for visual depth

## [3.25.0] - 2025-12-29

### 🚀 Production URL Auto-Fill
- **Added**: Chrome Web Store installs now auto-configure production URL
- **URL**: `https://heart-helper.onrender.com` is set by default for new users
- **Benefit**: Users no longer need to manually configure the app URL in settings

### Technical Details
- Added `PRODUCTION_URL` constant in sidepanel.js
- `loadSettings()` now defaults to production URL if no URL is configured
- "Open App" button uses production URL as fallback

## [3.24.0] - 2025-12-29

### 📚 Training Playbook Integration
- **Added**: HEART training scripts integrated into AI prompts
- **Categories**: Price shoppers, appointment setting, price presentation, objection handling
- **Impact**: AI-generated scripts and concern intake now use official HEART training methodology

## [3.20.0] - 2025-12-10

### ✨ NEW FEATURE: Job-Based Labor Rates
- **Added**: New "Job-Based Labor Rates" section in the Rates tab
- **Purpose**: Display fixed labor charges for specific job types (e.g., Cabin Filter = $100)
- **Syncing**: Job rates are synced from server on login alongside make-based rates
- **Display**: Shows job name, keywords for matching, and effective rate
- **Shop-specific rates**: Displays ★ indicator when shop has a custom override
- **Storage**: Job rates cached in chrome.storage.local for future job creation use

### Technical Details
- New `loadJobLaborRates()` function fetches from `/api/job-labor-rates`
- New `syncJobLaborRates()` function syncs on auth check, login, and registration
- Updated HTML with job rates list container in Rates tab
- Rates display with keyword-based fuzzy matching info

## [2.3.0] - 2025-11-25

### 🎯 MAJOR IMPROVEMENT: Only Inject Hearts in Concern Sections
- **Problem**: Hearts appearing EVERYWHERE (jobs, labor, parts, tires, etc.) - way too many!
- **Root Cause**: Detection was too broad - found ANY row with button + text
- **Solution**: Only inject hearts in actual "Customer Concerns" or "Technician Concerns" sections
  - Finds section headers containing "concern", "finding", or "complaint"
  - Only scans for rows within those specific sections
  - Prevents hearts from appearing on jobs, labor items, parts, etc.

### 🎨 UX IMPROVEMENT: Use ❤️ Emoji Instead of SVG
- **Changed**: Replaced custom SVG heart with circle border with simple ❤️ emoji
- **Benefits**: 
  - Cleaner, more familiar icon
  - No border needed
  - Smaller file size
  - Simpler code
- **Styling**: 18px emoji, slight opacity (0.7), scales to 1.2x on hover

### Technical Details
- Searches for headers (h1-h6, div, span) with "concern"/"finding"/"complaint" text
- Fallback: looks for containers with concern-related classes/IDs
- Only injects hearts for rows within these identified sections
- Much more selective = fewer, more relevant hearts

## [2.2.1] - 2025-11-25

### 🔧 CRITICAL FIX: Inject Icons Next to 3-Dot Menus (Not Textareas)
- **Problem**: Tekmetric concern fields have NO textareas or contenteditable elements
- **Discovery**: Extension was searching for textareas that don't exist (found 0 every time)
- **Root Cause**: Concerns are displayed as read-only list items with text + 3-dot menu
- **Solution**: Complete rewrite to inject HEART icons next to existing 3-dot menus
  - Finds all rows containing text + button (likely 3-dot menu)
  - Injects HEART icon inline, right before the 3-dot button
  - Extracts concern text from the row when user clicks icon
  - Opens HEART Helper with that specific concern pre-filled

### Implementation
- Searches for `div, li, [role="listitem"]` with buttons and text content
- Validates rows have 5-200 chars of text (filters out headers/footers)
- Injects 28px circular HEART icon with same hover effects
- Places icon using `insertBefore(threeDotsButton)` for perfect positioning
- Fallback: appends to end of row if 3-dot menu not found

### Why This Works
- Each concern already has a 3-dot menu (⋮)
- Just adding a HEART icon next to it
- No need to find textareas that don't exist!

## [2.2.0] - 2025-11-25

### 🎯 MAJOR UX CHANGE: Carvis-Style Individual HEART Icons
- **Removed**: Top bar "Check History" button
- **Added**: Individual HEART icons next to each concern/complaint textarea
- **User Experience**: Just like Carvis - click the HEART icon next to any concern to search for that specific issue
- **Benefits**:
  - Search each concern individually instead of all at once
  - More intuitive - icon appears right where you're typing
  - Visual HEART branding on every concern field
  - Click icon → instant search with that concern's text

### Implementation
- HEART icon (red heart SVG, HSL 357° 85% 52%) appears in top-right of concern fields
- Hover effect: Icon fills with HEART Red, scales up slightly
- Automatically detects concern/complaint/customer textareas
- Extracts vehicle data from page + specific concern text
- Opens HEART Helper in new tab with pre-filled search

### Technical Details
- Injects icons for all textareas with "concern", "complaint", or "customer" in class/placeholder
- Fallback: Searches for labels with these keywords and finds nearby textareas
- Re-scans every 2 seconds to catch dynamically added fields
- Prevents duplicate icons with tracked Set

## [1.7.1] - 2024-11-24

### ⏰ CRITICAL TIMING FIX: Wait for Job Card to Appear Before Adding Labor/Parts
- **THE PROBLEM**: User reported "the red line click here only appears after the timeout"
  - Script clicked Save → waited 1.5s → tried to find labor button
  - But job card with "click here" links takes several seconds to render
  - Error: "Could not find labor description field"
- **THE ROOT CAUSE**: Timing issue in the automation flow:
  1. ✅ Job name filled
  2. ✅ Save button clicked → modal closes
  3. ❌ Only waited 1.5s, job card not rendered yet!
  4. ❌ Tried to find "click here" links that don't exist yet
- **THE FIX**: Explicitly wait for job card to appear with "click here" links
  - Polls every 200ms checking for "click here to add labor/parts" text
  - Up to 10 second timeout
  - Only proceeds to add labor/parts AFTER links are visible
- **Result**: Automation waits for the right moment to click labor/parts buttons ✅

### Technical Details
After clicking Save, the DOM changes:
1. Modal closes (animation takes ~500ms)
2. Job card renders on estimate page (~2-5 seconds)
3. **THEN** "No labor added, click here to add labor" appears
4. **NOW** we can click it and fill labor fields

## [1.7.0] - 2024-11-24

### 🎯 MAJOR FIX: Find "click here" Links Instead of ADD LABOR/PART Buttons
- **THE PROBLEM**: After creating job, automation failed with "Could not find ADD LABOR button"
  - Screenshot showed job created successfully with name "REAR STRUT ASSEMBLIES" ✅
  - But labor/parts not added - "No labor added, click here to add labor" ❌
  - Script searched for `<button>` elements with "ADD LABOR" text
  - Tekmetric actually uses clickable links: "No labor added, **click here** to add labor"
- **THE FIX**: Search for ANY clickable element (button, link, span) with "click" + "labor/part"
  - Now finds: `<a>`, `<span>`, `<div>`, `[role="button"]`, not just `<button>`
  - Matches text patterns: "click here to add labor", "add labor", etc.
  - Successfully clicks the red "click here" links shown in screenshot
- **Result**: Complete automation from job name → labor items → parts ✅

### Implementation
```javascript
// OLD: Only searched <button> elements
const allButtons = document.querySelectorAll('button');
const btn = allButtons.find(b => b.textContent.includes('ADD LABOR'));

// NEW: Search ALL clickable elements for "click here" pattern
const allClickables = document.querySelectorAll('button, a, span[class*="link"], [role="button"]');
const btn = allClickables.find(e => {
  const text = e.textContent.toLowerCase();
  return (text.includes('click') && text.includes('labor')) || text.includes('add labor');
});
```

## [1.6.9] - 2024-11-24

### ⚡ FASTER MODAL DETECTION: Look for Input Fields Instead of ADD LABOR Button
- **THE PROBLEM**: `waitForModal()` waited for "ADD LABOR" button, but modal was already open with input fields ready
  - User reported: "when the timeout flag appeared, the modal was already open and ready to accept typing"
  - Unnecessary 15-second wait even though job name field was visible
- **THE FIX**: Detect modal by finding input/textarea fields instead of specific button
  - Looks for `[role="dialog"]`, `.modal`, or high z-index containers with inputs
  - Detects modal as soon as job name field appears (typically <1 second)
  - Falls back to document.body if timeout (no error thrown)
- **Result**: Modal detected in <1 second instead of waiting for timeout

### Implementation
```javascript
// OLD: Waited for ADD LABOR button (could take 10-15 seconds)
const addLaborBtn = document.querySelectorAll('button').find(btn => 
  btn.textContent.trim() === 'ADD LABOR'
);

// NEW: Detect modal by input fields (instant)
const dialogs = document.querySelectorAll('[role="dialog"], .modal');
const inputs = dialog.querySelectorAll('input, textarea');
```

## [1.6.8] - 2024-11-24

### ⚡ INSTANT AUTOMATION: Storage Change Listener
- **THE PROBLEM**: Content script only checked ONCE (2 seconds after page load), then stopped
  - User reported 8-10 second delay after switching to Tekmetric tab
  - No continuous polling - if data wasn't there at that exact moment, it missed it
  - Eventually found data when MutationObserver triggered on URL changes
- **THE FIX**: Added `chrome.storage.onChanged` listener
  - Triggers **instantly** when inject.js writes job data to storage
  - No more waiting for polling intervals or URL changes
  - Automation starts within **milliseconds** of clicking "Send to Extension"
- **Result**: Sub-second automation start (only Tekmetric modal loading time remains)

### Implementation
```javascript
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.lastJobData && changes.lastJobData.newValue) {
    fillTekmetricEstimate(changes.lastJobData.newValue);
  }
});
```

## [1.6.7] - 2024-11-24

### 🚀 Direct Storage Write: Bypass Sleeping Service Worker
- **THE PROBLEM**: Even with v1.6.6, service worker takes 30+ seconds to wake up and process messages
- **Evidence from logs**: 17 polling attempts (34+ seconds) before background script received job data
  ```
  background.js:41 Background: Retrieved from storage: No job (17 times)
  background.js:5 Background: Received job data from web app (after 34s!)
  ```
- **Root Cause**: Chrome service workers sleep aggressively, take 30s+ to wake and process messages
- **THE FIX**: `inject.js` now writes **directly** to `chrome.storage.local` as backup
  - Bypasses sleeping service worker completely
  - Data available in 2-3 seconds regardless of service worker state
  - Background script still processes normally (dual approach)
- **Result**: Automation starts in 2-3 seconds instead of 30+ seconds

### Technical Implementation
```javascript
// inject.js now does BOTH:
// 1. Direct write (immediate, bypasses service worker)
chrome.storage.local.set({ lastJobData: ... });

// 2. Forward to background (normal path, may be delayed)
chrome.runtime.sendMessage(event.data);
```

## [1.6.6] - 2024-11-24

### 🔧 Fixed STORE_PENDING_JOB Handler (Incomplete Fix)
- **THE BUG**: `STORE_PENDING_JOB` stored job data in memory, but service workers sleep and lose memory!
- **Evidence**: User waited 3-4 minutes before automation started
  - Content script kept checking storage: `⚠️ No pending job data found`
  - Job data was in service worker memory but NOT in chrome.storage.local
  - Service worker went to sleep → memory wiped → data lost
  - Eventually something triggered service worker to store data properly
- **Root Cause Analysis**:
  ```javascript
  // WRONG (line 20-24):
  if (message.action === "STORE_PENDING_JOB") {
    pendingJobData = message.jobData;  // Memory only!
    sendResponse({ success: true });
  }
  
  // But GET_PENDING_JOB reads from storage (line 30):
  chrome.storage.local.get(['lastJobData'], ...)  // Empty!
  ```
- **The Fix**: Make `STORE_PENDING_JOB` write to `chrome.storage.local` (persistent) instead of just memory
  - Now matches behavior of `SEND_TO_TEKMETRIC` handler
  - Service worker can sleep/wake without losing data
  - Content script finds job data immediately (within 2-3 seconds)

### Technical Details
Chrome Manifest V3 service workers:
- Sleep after ~30 seconds of inactivity to save resources
- All memory is cleared when sleeping
- Only chrome.storage.local persists across sleep/wake cycles
- Must use storage for any data that needs to survive service worker lifecycle

## [1.6.5] - 2024-11-24

### 🔧 Removed Unnecessary setTimeout (Was Being Throttled)
- **Root Cause Found**: Chrome throttles setTimeout in background/inactive tabs
- **Evidence**: User waited 2.5+ minutes, setTimeout(callback, 2000) never fired
  - Logs showed "Timeout set with ID: 32" but callback never executed
  - After page refresh → same code works immediately
- **Why it happens**: When tab is in background, Chrome suspends/throttles timers to save resources
  - Even after switching to tab, Chrome may keep it throttled for a period
  - setTimeout can be delayed by minutes or never fire at all
- **Solution**: Removed the 2-second artificial delay entirely
  - Page is already loaded when user switches to tab
  - No need to wait - can start automation immediately
  - Automation now starts within 2-3 seconds of clicking "Send to Extension"
- **Impact**: No more page refresh required! Automation starts immediately.

### Technical Details
Chrome's tab throttling is documented behavior:
- Background tabs get timer budgets (1 wake per minute max)
- Switching to tab doesn't immediately restore full timer privileges
- Can take 30+ seconds for tab to become "unthrottled"
- Workarounds: Use chrome.alarms API, requestAnimationFrame, or eliminate timers

## [1.6.4] - 2024-11-24

### 🎯 Wait for ADD LABOR Button (Modal Takes 10-12 Seconds to Render)
- **Critical Discovery**: User reports modal takes 10-12 seconds to fully load!
- **Problem**: v1.6.3 looked for canned jobs search (instant), but that's in the toolbar, not the modal
- **Evidence from logs (lines 415-425)**:
  - Found canned jobs input immediately
  - Toolbar has 1 input, page has 922 inputs
  - No container with 5-100 inputs exists - infinite loop!
  - Extension waited 10s then timed out (causing refresh issue)
- **Root cause**: Canned jobs search appears instantly (it's in toolbar), but actual modal with job fields takes 10-12 seconds to render
- **Solution**: Wait for ADD LABOR button (only appears when modal fully loaded)
  - Increased timeout to 15 seconds (10-12s render + buffer)
  - Look for ADD LABOR button instead of canned jobs search
  - Walk up from button to find modal container
  - Progress logging every 2 seconds so user knows it's working
- **Why it works**: ADD LABOR button is inside the modal form, not the toolbar
  - Only appears after modal fully renders
  - Guarantees we're querying the RIGHT container

### Technical Details
The "canned jobs" search is part of Tekmetric's sticky toolbar (z-900), not the Job modal. The modal is a heavy React component that takes 10-12s to mount and render all form fields.

## [1.6.3] - 2024-11-24

### 🔧 ATTEMPTED: Find Container with 5-100 Inputs (NO SUCH CONTAINER)
- **Problem**: v1.6.2 waited 10 seconds then timed out because NO element had z-index > 1000
- **Evidence from logs**:
  - Logs show infinite loop: "Found canned jobs search input" repeating every 100ms
  - Every element checked: either z-auto or z-900, never z-1000+
  - User needed to refresh page because extension timed out after 10s
  - Screenshot shows modal IS open, but extension couldn't detect it
- **Root cause**: Tekmetric doesn't use z-index > 1000 for modals - they use different approach
- **Solution**: Removed z-index requirement completely
  - Find canned jobs input ✓
  - Walk up DOM tree looking for first container with 5-100 inputs
  - Stop when hitting 200+ inputs (entire page)
  - Use the closest container to canned jobs input
- **Why it works**: Real modal has ~15-50 inputs, page has 919 inputs
  - Extension will find the modal before hitting the page container

### Algorithm
1. Find `input[placeholder*="canned"]` (canned jobs search)
2. Walk up parents counting inputs in each
3. Take FIRST match with 5-100 inputs (closest to input)
4. Stop at 200+ inputs (entire page)

## [1.6.2] - 2024-11-24

### 🔧 ATTEMPTED: Require z-index > 1000 (TEKMETRIC DOESN'T USE IT)
- **Problem**: v1.6.1 walked up to `<body>` which has 916 inputs, not the actual modal
- **Evidence from logs**:
  - Line 300: `Found modal container with z-index auto and 916 input fields`
  - Line 303: `Found 916 inputs` (entire page, not modal!)
  - Line 307: `text-rewriter-0` found - the search bar, not job title field
  - Line 431: `ADD LABOR button not found` - because we're querying wrong container
- **Root cause**: Fallback logic accepted ANY element with 5+ inputs, including `<body>`
- **Solution**: Much stricter modal criteria:
  1. **MUST NOT** be `<body>` tag
  2. **MUST** have z-index > 1000 (not "auto")
  3. **MUST** have 5-200 inputs (not 1, not 900+)
  4. Added debug logging to see each element checked
- **Why it works**: 
  - Real modal: z-index 1300, ~15 inputs ✓
  - Body container: z-index auto, 916 inputs ✗
  - Sticky toolbar: z-index 900, 1 input ✗

### Technical Details
This prevents the "walk up forever until you hit body" bug by requiring BOTH high z-index AND reasonable input count.

## [1.6.1] - 2024-11-24

### 🔧 ATTEMPTED: Wait for Modal to Actually Render (WALKED TOO FAR)
- **Root Cause (identified by architect)**: Fixed 3-second timeout doesn't guarantee modal is rendered
  - Evidence: "Found 1 inputs" logs show we query DOM before modal appears
  - Result: We find pre-existing sticky toolbar (z-900) instead of actual modal
  - Impact: Job title goes into search bar, parts go into labor section
- **Solution**: Created `waitForModal()` function using MutationObserver pattern
  - Polls DOM every 100ms until canned jobs input appears
  - Walks up from input to find container with z-index > 1000 OR 5+ input fields
  - Only proceeds after modal is CONFIRMED rendered
  - 10-second timeout prevents infinite waiting
- **Benefits**:
  - No more race conditions between click and DOM query
  - Guaranteed to find correct modal, not sticky toolbars
  - Works regardless of page load speed
  - Reuses proven `waitForElement` pattern from codebase

### Architecture
Replaced `await sleep(3000)` with explicit DOM observation. This is best practice for Chrome extensions automating dynamic pages.

## [1.6.0] - 2024-11-24

### 🔧 ATTEMPTED: Walk Higher Up the DOM Tree (TIMING BUG REMAINED)
- **Problem**: v1.5.9 stopped at sticky toolbar (z-index 900) containing ONLY the search bar
- **Evidence**: `Found 1 inputs` - only the canned jobs search field, not the job title field
- **Root cause**: Walked up DOM until z-index > 100, but stopped at FIRST match (toolbar, not modal)
- **Solution**: Two-tier approach:
  1. **Primary**: Walk up until z-index > 1000 (true modal dialogs)
  2. **Fallback**: If no z-index > 1000, walk up and find container with 5+ input fields (entire form)
- **Why it works**: Real modal contains job title field, labor fields, parts fields = many inputs
- **Toolbar only has**: 1 input (the canned jobs search bar we're using as anchor)

### Technical Details
Sticky toolbars (z-900) vs Modal dialogs (z-1000+). Input counting ensures we find the COMPLETE form, not just a search bar.

## [1.5.9] - 2024-11-24

### 🔧 ATTEMPTED: Find Correct Modal by Content (STOPPED TOO EARLY)
- **Problem**: v1.5.8 found WRONG modal (Handle.com chat widget with z-index 2147483647)
- **Evidence**: `className: 'detect-auto-handle visible'` had 0 inputs inside it
- **Root cause**: Highest z-index approach finds ANY overlay (chat widgets, tooltips, etc.)
- **Solution**: Find modal that contains **Job-specific content**:
  1. Look for `input[placeholder*="canned"]` (canned jobs search field)
  2. Walk up DOM from that input to find modal container with z-index > 100
  3. This guarantees we find the ACTUAL Job modal, not random overlays
- **Fallback**: Still tries standard modal selectors if canned jobs input not found

### Impact
Z-index alone is unreliable on complex pages with multiple overlays. Content-based detection ensures we find the correct modal.

## [1.5.8] - 2024-11-24

### 🔧 ATTEMPTED: Enhanced Modal Detection (FOUND WRONG MODAL)
- **Problem**: v1.5.7 couldn't find modal - standard selectors failed
- **Evidence**: "❌ Could not find Job dialog/modal" error
- **Root cause**: Modal doesn't use `role="dialog"` or standard `.modal` class
- **Solution**: Try 10+ different modal selector patterns:
  - `[role="dialog"]`, `[role="alertdialog"]`
  - `.modal`, `*Modal*`, `*modal*`
  - `*dialog*`, `*Dialog*`
  - `*overlay*`, `*Overlay*`
  - `*popup*`, `*Popup*`
  - **Fallback**: Find div with highest z-index (modals are always on top)
- **Enhanced logging**: Shows total divs and divs with high z-index

### Impact
Standard modal selectors don't work on Tekmetric. The z-index fallback should find it since modals are always rendered on top.

## [1.5.7] - 2024-11-24

### 🎯 ATTEMPTED: Search Inside Modal Only (MODAL NOT FOUND)
- **Problem**: v1.5.6 found 896 inputs on ENTIRE page, couldn't identify which was job title field
- **Discovery**: Job title field is inside a modal/dialog that opens when clicking "Job" button
- **Evidence**: Console truncated array at input ~16, but 896 total inputs exist (including ALL page inputs)
- **Root cause**: Searching entire DOM instead of just the modal that opened
- **Solution**: 
  1. Find the modal (`[role="dialog"]`, `.modal`, etc.)
  2. Search for inputs ONLY inside that modal
  3. Added 4 fallback strategies specific to modal inputs
- **Improved logging**: Shows modal details and all inputs INSIDE modal (much shorter list)

### Impact
Searching 896 inputs across the entire page was impossible. Now we search ~5-10 inputs inside the modal only.

## [1.5.6] - 2024-11-24

### 🔍 ATTEMPTED: Search ALL Input Types (FOUND 896!)
- **Problem**: v1.5.5 only found `<input type="text">`, but job title field has different type
- **Discovery**: User's screenshot proves cursor IS in job title field after clicking "Job"
- **Evidence**: v1.5.5 logs show "Found 1 text inputs" (global search only), "0 textareas", "0 contenteditable"
- **Root cause**: Job title field is probably `<input>` with no type attribute, or `<input type="">`
- **Solution**: Search for ALL `<input>` elements (any type), ALL contenteditable (any value)
- Enhanced logging shows type, value, placeholder for EVERY input found
- Excludes only hidden, checkbox, and radio inputs

### Impact
v1.5.5 missed the job title field because it only searched `input[type="text"]`. This version searches ALL inputs.

## [1.5.5] - 2024-11-24

### 🔍 ATTEMPTED: Search All Field Types (INCOMPLETE)
- **Problem**: v1.5.4's `document.activeElement` returned a BUTTON, not the job title field
- **Discovery**: Job title field is NOT auto-focused after clicking Job button
- **Root cause**: Field might be textarea, contenteditable div, or late-rendering input
- **Solution**: Search for ALL field types (input, textarea, contenteditable)
- Added 3 fallback strategies:
  1. Empty textarea (most likely for job names)
  2. Empty contenteditable div
  3. Empty text input (excluding search boxes)
- Increased wait time from 2.5s to 3s for dialog to fully render
- Enhanced logging shows counts and details of all found fields

### Impact
v1.5.4 tried to type into a submit button. This version properly searches for the actual input field regardless of its type.

## [1.5.4] - 2024-11-24

### 🎯 ATTEMPTED: Use Active Element (FAILED)
- **User insight**: Cursor is already in job title field after clicking Job button
- **Root cause**: Job title input is NOT a regular input field - it's either:
  - A contenteditable div
  - An input masked by React
  - A field that doesn't show up in querySelectorAll('input')
- **Solution**: Use `document.activeElement` to get the currently focused element
- Added support for:
  - contenteditable elements (using textContent)
  - Regular inputs (using .value)
  - Fallback: document.execCommand('insertText') for typing simulation
- Now logs the active element's tagName, type, id, className, and contentEditable status

### Impact
Previous version searched through 884 inputs but couldn't find the job title field because it's not a standard input. This approach leverages Tekmetric's UX where the title field is auto-focused after clicking Job.

## [1.5.3] - 2024-11-24

### 🐛 FIX: Job Name Input Detection
- **Fixed**: Couldn't find job name input field after clicking Job button
- **Root cause**: Job title input wasn't in first 10 visible inputs and had NO placeholder text
- **Solution 1**: Increased wait time after clicking Job button from 1.5s to 2.5s
- **Solution 2**: Now shows first 20 inputs (instead of 10) for better debugging
- **Solution 3**: Added fallback strategy to find text inputs with EMPTY placeholder
- Added className and id checks to exclude search boxes

### Impact
Previous version would click Job button, create blank job, then fail silently because it couldn't find the title input. This created hundreds of blank "New Job" entries in Tekmetric.

## [1.5.2] - 2024-11-24

### 🐛 CRITICAL FIX: Infinite Loop Prevention
- **Fixed**: Extension kept trying to fill job repeatedly, never stopping
- **Root cause**: Job data was cleared on success but NOT on error
- **Solution**: Now clears job data from storage in BOTH success and error paths
- Added callback logging to confirm job data clearing

### Impact
Previous version would get stuck in infinite loop if automation hit any error.
Job data stayed in chrome.storage.local and extension kept retrying every 2 seconds.
Page refresh didn't help because storage persists across refreshes.

## [1.5.1] - 2024-11-22

### 🐛 CRITICAL FIX: Job Name Field Detection
- **Fixed**: Was filling global search box instead of job title input
- **Root cause**: Code was finding first visible text input (the search bar)
- **Solution**: Now specifically looks for input with placeholder containing "title" or "job"
- **Solution**: Excludes inputs with "search" in placeholder
- Shows first 10 inputs instead of 5 for better debugging

### Impact
Previous version filled the search box at top of page, causing "Name is required" error.
Labor items were being added to nameless jobs.

## [1.5.0] - 2024-11-22

### 🎉 MAJOR MILESTONE: Labor Items Working!
The automation now successfully:
- ✅ Retrieves job data from background storage
- ✅ Fills job name in dialog
- ✅ Clicks Save to create job
- ✅ Finds and clicks ADD LABOR button
- ✅ Fills labor description
- ✅ Fills labor hours
- ✅ Saves labor item

### Added
- **ADD PART button detection**: Same flexible matching as ADD LABOR
  - Searches for "ADD PART", "ADD_PART", or just "PART"
  - Case-insensitive search
  - Better error logging shows buttons containing "PART" or "ADD"

### Progress
This is the final piece! After this, the complete automation flow works end-to-end.

## [1.4.2] - 2024-11-22

### Fixed
- **Job name input detection**: Better logging and field detection
  - Now shows first 5 visible inputs to debug field selection
  - Added blur event after filling (helps trigger React/validation)
  - Clear field before setting value (fixes some form validation)
  - Shows confirmation of filled value
  - Better error messages showing all visible inputs

### Changed
- Added step number (3️⃣) to job name filling logs
- More detailed logging of input field properties

## [1.4.1] - 2024-11-22

### 🐛 CRITICAL FIX: Service Worker Persistence
- **Fixed**: Content script getting `{jobData: null}` despite background receiving data
- **Root cause**: Chrome unloads service workers after ~30 seconds, resetting in-memory variables
- **Solution**: GET_PENDING_JOB now reads from chrome.storage.local instead of memory
- **Solution**: CLEAR_PENDING_JOB now removes from chrome.storage.local
- Both actions now return `true` for async responses

### Impact
This was preventing the automation from ever starting on the Tekmetric page!
Background would receive and store job data, but content script would always get null.

## [1.4.0] - 2024-11-22

### 🎉 MILESTONE: Job Creation Working!
The automation successfully:
- ✅ Receives job data from search tool
- ✅ Clicks Job button
- ✅ Fills job name
- ✅ Clicks Save to create the job

### Fixed
- **ADD LABOR button search**: More flexible matching
  - Now searches for "ADD LABOR", "ADD_LABOR", or just "LABOR"
  - Case-insensitive search
  - Better error logging shows buttons containing "LABOR" or "ADD"
  - Shows first 50 button texts to help identify the right button

### Changed
- Enhanced button search logging
- Filters out long button texts (>50 chars) for cleaner logs
- Shows button count before searching

## [1.3.3] - 2024-11-22

### Fixed
- **Timeout hanging bug**: Added detailed logging around setTimeout
  - Logs when timeout is SET
  - Logs timeout ID
  - Logs when timeout COMPLETES  
  - Added try/catch around wait
  - Will show if setTimeout is being called but never completing

### Debug
Previous version showed automation starts, waits 2 seconds, then STOPS.
Never reached "2️⃣ Wait complete" log.
This version will show if setTimeout fires at all.

## [1.3.2] - 2024-11-22

### Added
- **Ultra-verbose debugging**: Step-by-step logging with emoji markers
  - Shows current URL when checking Tekmetric page
  - Logs each stage: URL check → wait → button search → input search
  - Numbered steps (1️⃣ 2️⃣ 3️⃣) to track execution flow
  - Will identify exactly where automation stops

### Purpose
Data IS flowing to Tekmetric tab, automation STARTS, but then stops silently.
These logs will show exactly which line is failing.

Expected console output:
```
🚀 Starting to fill Tekmetric estimate with job data...
1️⃣ Checking if on Tekmetric page...
Current URL: https://shop.tekmetric.com/admin/shop/469/repair-orders/...
✅ On Tekmetric page, waiting 2 seconds...
2️⃣ Wait complete, now looking for Job button...
```

## [1.3.1] - 2024-11-22

### Fixed
- **Background script message handling bug**: Fixed async/sync response mismatch
  - `SEND_TO_TEKMETRIC` now properly waits for storage.set() before responding
  - Removed `return true` from synchronous handlers to prevent channel closure errors
  - Added `STORE_PENDING_JOB` handler for content script storage requests
  - No more "message channel closed" errors

### Changed
- Background script now logs when job data is stored successfully
- Only returns `true` for truly async operations (storage.get/set with callbacks)

## [1.3.0] - 2024-11-22

### Fixed
- **CRITICAL BUG**: Added missing window message listener!
  - Extension was checking for pending jobs but never received them
  - Search tool sends via `window.postMessage()` but extension wasn't listening
  - Added `window.addEventListener('message')` to receive job data

### Added
- Origin validation for security (only accepts messages from same origin)
- Logs when receiving messages from search tool
- Confirmation when job data is stored in extension storage

### How It Works Now
1. User clicks "Send to Extension" in search tool
2. Search tool sends job data via `window.postMessage()`
3. **Extension NOW listens and receives the message** ← This was missing!
4. Extension stores job data via `chrome.runtime.sendMessage()`
5. User switches to Tekmetric tab
6. Extension auto-fills the job

Expected console output in search tool:
```
📬 Received window message: {action: "SEND_TO_TEKMETRIC", payload: {...}}
✅ Received job data from search tool!
📦 Job data stored in extension storage
```

## [1.2.2] - 2024-11-22

### Added
- **Critical Debugging**: Logs every step of pending job detection
- Shows when content script initializes
- Shows when checking for pending jobs (even if none found)
- Shows GET_PENDING_JOB message response
- Logs whether job data exists or not

### Purpose
Diagnose why automation isn't starting - logs will show:
1. If content script loads properly
2. If it's checking for pending jobs
3. What the background script returns
4. Why fillTekmetricEstimate isn't being called

Expected console output:
```
📋 Tekmetric Job Importer initialized
📄 Document already loaded - checking for pending jobs in 2s...
🔍 Checking for pending job data...
📬 GET_PENDING_JOB response: {jobData: {...}}
✅ Found pending job data, auto-filling...
```

## [1.2.1] - 2024-11-22

### Added
- **Enhanced Debugging**: Shows all available inputs after clicking Job button
- Detailed error stack traces and error details in console
- Logs what inputs are found (type, placeholder, disabled status, visibility)
- Better error messages showing exactly what elements are available

### Changed
- Increased timeout after Job button click to 1.5s (from 1.2s)
- Errors now re-thrown to ensure they appear in console
- More descriptive success message (✅ instead of ✓)

### Purpose
This debugging release helps identify why automation gets stuck after clicking Job button. Console will show exactly what inputs are found and why job name input isn't being detected.

## [1.2.0] - 2024-11-22

### Fixed
- **Critical**: Added missing Save/Create button click after filling job name
- **Critical**: Added Save button clicks after each labor item and part to ensure data persists
- Fixed "ADD LABOR button not found" error by properly saving the job first

### Added
- Comprehensive debugging output showing available buttons when elements can't be found
- Better console logging with ✓ success and ⚠️ warning indicators
- Shows all available buttons in console when Save/ADD LABOR/ADD PART buttons not found

### Changed
- Increased timeout after clicking job save button to 1.5s for reliability
- Added 1s delays after saving each labor item and part
- Better error messages showing exactly which buttons are available

### Notes
- This should fix the issue where changes weren't visible without refreshing Tekmetric
- The extension now properly saves at each step: Job → Labor Items → Parts

## [1.1.0] - 2024-11-22

### Fixed
- **Critical**: Fixed automation creating multiple empty jobs instead of filling data
- **Critical**: Fixed silent failures when form fields couldn't be found
- Added concurrency lock to prevent duplicate executions
- Increased timeouts for more reliable Tekmetric UI interaction (2s initial delay, 1.2s modal wait)
- Extension now stops immediately with clear error message if critical elements missing

### Added
- Detailed console logging with ✓ checkmarks for successful field fills
- Debug output showing available inputs when description field not found
- Better error messages showing exactly which element couldn't be found

### Changed
- Longer delays between automation steps for reliability
- Changed silent `continue` to hard stops with error messages
- Improved field detection with more detailed logging

## [1.0.0] - 2024-11-21

### Added
- Initial release
- "Check History" button injection on Tekmetric RO pages
- Vehicle data extraction (make, model, year, engine, VIN)
- Customer concern/complaint extraction for auto-fill search
- Auto-fill labor items and parts into Tekmetric via UI automation
- Click "Job" button → fill job name → add labor → add parts → save
- Popup UI showing pending job status
- Success/error notifications
- Secure message passing with origin validation

### Workflow
1. Extract vehicle data and concerns from Tekmetric RO
2. Open search tool with pre-filled data
3. User selects matching job
4. Extension automates Tekmetric UI to import job
