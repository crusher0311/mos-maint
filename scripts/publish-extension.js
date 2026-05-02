#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const EXT_DIR = path.join(__dirname, '..', 'mos-tools-extension');
const DIST_DIR = path.join(__dirname, '..', 'dist');
const ZIP_PATH = path.join(DIST_DIR, 'mos-tools-extension.zip');
const MANIFEST_PATH = path.join(EXT_DIR, 'manifest.json');

function getEnvSecrets() {
  return {
    CWS_CLIENT_ID: process.env.CWS_CLIENT_ID,
    CWS_CLIENT_SECRET: process.env.CWS_CLIENT_SECRET,
    CWS_REFRESH_TOKEN: process.env.CWS_REFRESH_TOKEN,
    CWS_ITEM_ID: process.env.CWS_ITEM_ID,
  };
}

function hasAllSecrets() {
  const s = getEnvSecrets();
  return Boolean(s.CWS_CLIENT_ID && s.CWS_CLIENT_SECRET && s.CWS_REFRESH_TOKEN && s.CWS_ITEM_ID);
}

function readManifestVersion() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  return manifest.version;
}

async function getAccessToken() {
  const { CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN } = getEnvSecrets();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CWS_CLIENT_ID,
      client_secret: CWS_CLIENT_SECRET,
      refresh_token: CWS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

function buildZip() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DIST_DIR)) {
      fs.mkdirSync(DIST_DIR, { recursive: true });
    }

    if (fs.existsSync(ZIP_PATH)) {
      fs.unlinkSync(ZIP_PATH);
    }

    const version = readManifestVersion();
    console.log(`Packaging extension v${version}...`);

    const output = fs.createWriteStream(ZIP_PATH);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      const sizeKB = (archive.pointer() / 1024).toFixed(1);
      console.log(`Created ${ZIP_PATH} (${sizeKB} KB)`);
      resolve(version);
    });

    archive.on('error', reject);
    archive.pipe(output);

    archive.glob('**/*', {
      cwd: EXT_DIR,
      ignore: ['.DS_Store', '.git/**', 'node_modules/**', '*.md'],
      dot: false,
    });

    archive.finalize();
  });
}

async function uploadToCWS(accessToken) {
  const { CWS_ITEM_ID } = getEnvSecrets();
  console.log(`Uploading to Chrome Web Store (item: ${CWS_ITEM_ID})...`);

  const zipData = fs.readFileSync(ZIP_PATH);

  const res = await fetch(
    `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${CWS_ITEM_ID}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-goog-api-version': '2',
      },
      body: zipData,
    }
  );

  const data = await res.json();

  if (data.uploadState === 'FAILURE') {
    const err = new Error(`Upload failed: ${JSON.stringify(data.itemError || data)}`);
    err.cwsResponse = data;
    throw err;
  }

  console.log(`Upload status: ${data.uploadState}`);
  return data;
}

async function publishItem(accessToken, target = 'default') {
  const { CWS_ITEM_ID } = getEnvSecrets();
  const targetLabel = target === 'trustedTesters' ? 'trusted testers' : 'public';
  console.log(`Publishing to ${targetLabel}...`);

  const res = await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${CWS_ITEM_ID}/publish`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-goog-api-version': '2',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ target }),
    }
  );

  const data = await res.json();

  if (data.status && data.status[0] !== 'OK' && data.status[0] !== 'PUBLISHED_WITH_FRICTION_WARNING') {
    const err = new Error(`Publish failed: ${JSON.stringify(data)}`);
    err.cwsResponse = data;
    throw err;
  }

  console.log(`Publish status: ${data.status?.[0] || 'OK'}`);
  if (data.statusDetail) {
    console.log(`Details: ${data.statusDetail.join(', ')}`);
  }
  return data;
}

// Try the authenticated Chrome Web Store API to get the current live version.
// Returns the crxVersion string, or null if the API is unavailable / disabled
// for this Cloud project (the legacy upload+publish endpoints work without
// the chromewebstore.googleapis.com API being enabled, but the GET items/{id}
// endpoint does not — enabling it for the project that owns CWS_CLIENT_ID
// makes this path the source of truth).
async function fetchLivePublishedVersionAuth(accessToken) {
  const { CWS_ITEM_ID } = getEnvSecrets();
  // projection=PUBLISHED returns what users actually have installed, which is
  // the source of truth we want to compare against (DRAFT can be ahead if a
  // previous upload is still in review and has not gone live yet).
  const res = await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${CWS_ITEM_ID}?projection=PUBLISHED`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-goog-api-version': '2',
      },
    }
  );
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || res.status;
    console.warn(`[publish-extension] Auth version lookup unavailable (${reason})`);
    return null;
  }
  return data?.crxVersion || null;
}

// Fallback: scrape the public Chrome Web Store detail page. This lags the
// review queue (it reflects what end users see, not the latest submission),
// but it never requires API enablement. We use it only when the authenticated
// path returns null. Worst case: the comparison decides to re-upload a
// version that's already submitted, which the store accepts idempotently.
async function fetchLivePublishedVersionPublic() {
  const { CWS_ITEM_ID } = getEnvSecrets();
  const res = await fetch(`https://chromewebstore.google.com/detail/${CWS_ITEM_ID}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; mos-tools-auto-publish/1)' },
  });
  if (!res.ok) return null;
  const html = await res.text();

  // The detail page embeds the actual extension manifest JSON inside its
  // initial-data payload (escaped: `\"version\": \"1.26.5\"`). That field
  // is far more stable than the visible CSS-class-based version label, so
  // we anchor on it specifically rather than matching any dotted-numeric
  // string on the page (which could collide with library versions, etc).
  const manifestMatch = html.match(
    /\\"manifest_version\\":\s*3[\s\S]{0,2000}?\\"version\\":\s*\\"(\d+\.\d+(?:\.\d+){0,2})\\"/
  );
  if (manifestMatch) return manifestMatch[1];

  // Secondary anchor: look for the literal sequence `"version":"1.26.5"` in
  // an unescaped JSON blob (some response bodies aren't double-encoded).
  const jsonMatch = html.match(/"version"\s*:\s*"(\d+\.\d+(?:\.\d+){0,2})"/);
  if (jsonMatch) return jsonMatch[1];

  // No safe anchor found. Return null and let the wrapper alert+exit
  // rather than guessing — false positives here cause spurious publish
  // skips or blind republishes.
  return null;
}

// Combined lookup with graceful degradation. Returns { version, source }
// where source is 'auth' | 'public' | null. Never throws.
async function fetchLivePublishedVersion(accessToken) {
  if (accessToken) {
    try {
      const v = await fetchLivePublishedVersionAuth(accessToken);
      if (v) return { version: v, source: 'auth' };
    } catch (err) {
      console.warn(`[publish-extension] Auth version lookup threw: ${err && err.message}`);
    }
  }
  try {
    const v = await fetchLivePublishedVersionPublic();
    if (v) return { version: v, source: 'public' };
  } catch (err) {
    console.warn(`[publish-extension] Public version lookup threw: ${err && err.message}`);
  }
  return { version: null, source: null };
}

// Compares semver-ish versions like "1.26.7". Returns -1/0/1.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] || 0;
    const bi = pb[i] || 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

// Full publish flow shared by the CLI and the auto-publisher.
// Returns { version, uploadState, publishStatus }.
async function runFullPublish({ target = 'default' } = {}) {
  if (!hasAllSecrets()) {
    throw new Error(
      'Missing Chrome Web Store credentials. Required: CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_ITEM_ID'
    );
  }
  let stage = 'zip';
  try {
    const version = await buildZip();
    stage = 'token';
    const accessToken = await getAccessToken();
    stage = 'upload';
    const upload = await uploadToCWS(accessToken);
    stage = 'publish';
    const publish = await publishItem(accessToken, target);
    return {
      version,
      uploadState: upload.uploadState,
      publishStatus: publish.status?.[0] || 'OK',
    };
  } catch (err) {
    err.stage = err.stage || stage;
    throw err;
  }
}

async function main() {
  const mode = process.argv[2];
  const publishTarget = process.argv.includes('--public') ? 'default' : 'trustedTesters';

  if (mode === 'zip') {
    await buildZip();
    console.log('\nZip built. Upload manually at https://chrome.google.com/webstore/devconsole');
    return;
  }

  if (!hasAllSecrets()) {
    console.error('Missing Chrome Web Store credentials. Required secrets:');
    console.error('  CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_ITEM_ID');
    console.error('\nTo build a zip only: node scripts/publish-extension.js zip');
    process.exit(1);
  }

  const result = await runFullPublish({ target: publishTarget });

  const targetLabel = publishTarget === 'trustedTesters' ? 'trusted testers' : 'the public';
  console.log(`\nv${result.version} published to ${targetLabel}!`);
}

module.exports = {
  buildZip,
  getAccessToken,
  uploadToCWS,
  publishItem,
  fetchLivePublishedVersion,
  readManifestVersion,
  compareVersions,
  hasAllSecrets,
  runFullPublish,
  MANIFEST_PATH,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
