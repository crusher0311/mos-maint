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

## Auto-publish on merge & deploy

In addition to the manual commands above, the extension is **automatically
published whenever the manifest version on `main` is ahead of the live store
version**. You almost never need to run `npm run ext:publish` by hand anymore —
just bump `mos-tools-extension/manifest.json`'s `version` and merge.

### When it runs
- **Post-merge.** `scripts/post-merge.sh` first compares the manifest version
  in the current commit to the previous commit. If unchanged, it skips the
  wrapper entirely (so non-extension merges never call CWS or risk failing on
  a transient lookup). If the version did change, it invokes
  `npx tsx scripts/auto-publish-extension.ts`.
- **Deploy.** A `postbuild` hook in `package.json` runs the same wrapper after
  `npm run build`, gated on a known deploy environment (`REPLIT_DEPLOYMENT=1`,
  `VERCEL=1`, or `RENDER=true`) so neither a developer's local
  `npm run build` nor a generic CI test run accidentally publishes. The wrapper exits non-zero on
  publish failures (after firing the alert email), which surfaces the failure
  in the deploy build log instead of silently swallowing it.

### How it decides whether to publish
1. Reads the manifest version from `mos-tools-extension/manifest.json`.
2. Asks the Chrome Web Store API for the currently-published `crxVersion`
   (`GET items/{id}?projection=PUBLISHED`).
3. If repo > store → builds the zip, uploads, and publishes to **public**.
4. If repo == store → logs `no-op (store already at v<x>)` and exits 0.
5. If repo < store → logs a clean no-op and exits 0 (no downgrade attempts).

The store version is the source of truth, so a single successful run will catch
the store all the way up to current main even if several previous publishes
were silently missed.

### Kill switch
Set `EXT_AUTOPUBLISH_DISABLED=1` in the environment to disable the
auto-publisher. The wrapper will exit 0 with a single log line and never call
the Chrome Web Store API. The manual `npm run ext:publish` commands are
unaffected by this flag.

If the four `CWS_*` secrets are missing entirely (e.g. on a fork), the wrapper
also logs a single warning and exits 0 — it never crashes unrelated merges.

### What the failure email looks like
On any failure (token refresh, upload `FAILURE`, publish status not OK, network
error, version-lookup error, etc.), the wrapper sends an email to every user
with `isPlatformAdmin: true` (the same inbox the sync-health alerts use), with:

- Subject: `[Detect Dog] Auto-publish failed at <stage> for v<version>`
- Body: manifest version, failure stage (`token`/`lookup`/`zip`/`upload`/`publish`/`fatal`),
  the error message, and the raw Chrome Web Store API response when available.

After sending the email the wrapper exits non-zero so the post-merge runner
records the failure as well. The repo's manifest version is **not** modified;
the next merge or a manual re-run will retry once the underlying problem is
fixed.

### Manually re-running after a failure
The original CLI commands still work exactly as before:

```bash
npm run ext:publish        # public
npm run ext:publish:test   # trusted testers
npm run ext:zip            # zip only
```

You can also re-trigger the auto-publisher itself without merging:

```bash
npm run ext:auto-publish
```

This is the same script the post-merge and deploy hooks call, so its behavior
matches production exactly (including the no-op when versions already agree).

## Files
- `scripts/publish-extension.js` — The publish script (CLI + reusable functions)
- `scripts/auto-publish-extension.ts` — The auto-publish wrapper used by
  post-merge and deploy (reuses `lib/email.ts` + `lib/super-admins.ts`)
- `scripts/post-merge.sh` — Post-merge hook that calls the wrapper
- `mos-tools-extension/` — Extension source code
- `dist/mos-tools-extension.zip` — Built zip (generated)
