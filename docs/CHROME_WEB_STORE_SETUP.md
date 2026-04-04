# Chrome Web Store Publishing Setup

## Prerequisites
- Chrome Web Store developer account (one-time $5 registration)
- Extension already published (first upload must be manual)
- Google Cloud project with Chrome Web Store API enabled

## Required Secrets

Add these 4 secrets to the Replit project:

### 1. CWS_ITEM_ID
Your extension's ID from the Chrome Web Store developer dashboard.
- Go to https://chrome.google.com/webstore/devconsole
- Click on your extension
- The ID is the long string in the URL (e.g., `abcdefghijklmnopqrstuvwxyz`)

### 2. CWS_CLIENT_ID
From Google Cloud Console:
1. Go to https://console.cloud.google.com
2. Select your project (or create one)
3. Navigate to **APIs & Services > Credentials**
4. Click **Create Credentials > OAuth 2.0 Client ID**
5. Application type: **Desktop app** (or Web application)
6. Copy the **Client ID**

### 3. CWS_CLIENT_SECRET
The secret shown alongside the Client ID created above.

### 4. CWS_REFRESH_TOKEN
Generated once using the Client ID and Secret:

**Step 1:** Open this URL in your browser (replace `YOUR_CLIENT_ID`):
```
https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=YOUR_CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob
```

**Step 2:** Authorize and copy the authorization code.

**Step 3:** Exchange the code for a refresh token:
```bash
curl -s "https://oauth2.googleapis.com/token" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_SECRET" \
  -d "code=THE_CODE" \
  -d "grant_type=authorization_code" \
  -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob"
```

**Step 4:** Copy the `refresh_token` from the JSON response.

## Enable the Chrome Web Store API
1. Go to https://console.cloud.google.com/apis/library
2. Search for **Chrome Web Store API**
3. Click **Enable**

## Usage

Once secrets are configured:

| Command | What it does |
|---------|-------------|
| `npm run ext:zip` | Build a .zip file only (for manual upload) |
| `npm run ext:publish:test` | Upload + publish to **trusted testers** only |
| `npm run ext:publish` | Upload + publish to **all users** |

### Recommended workflow
1. Make changes to `mos-tools-extension/`
2. Bump version in `manifest.json`
3. Run `npm run ext:publish:test` to push to testers
4. Test on your browser
5. When confident, run `npm run ext:publish` to go public

## Files
- `scripts/publish-extension.js` — The publish script
- `mos-tools-extension/` — Extension source code
- `dist/mos-tools-extension.zip` — Built zip (generated)
