#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const EXT_DIR = path.join(__dirname, '..', 'mos-tools-extension');
const DIST_DIR = path.join(__dirname, '..', 'dist');
const ZIP_PATH = path.join(DIST_DIR, 'mos-tools-extension.zip');

const CWS_CLIENT_ID = process.env.CWS_CLIENT_ID;
const CWS_CLIENT_SECRET = process.env.CWS_CLIENT_SECRET;
const CWS_REFRESH_TOKEN = process.env.CWS_REFRESH_TOKEN;
const CWS_ITEM_ID = process.env.CWS_ITEM_ID;

const PUBLISH_TARGET = process.argv.includes('--public') ? 'default' : 'trustedTesters';

async function getAccessToken() {
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

    const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
    console.log(`Packaging extension v${manifest.version}...`);

    const output = fs.createWriteStream(ZIP_PATH);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      const sizeKB = (archive.pointer() / 1024).toFixed(1);
      console.log(`Created ${ZIP_PATH} (${sizeKB} KB)`);
      resolve(manifest.version);
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
    console.error('Upload failed:', JSON.stringify(data.itemError || data, null, 2));
    process.exit(1);
  }

  console.log(`Upload status: ${data.uploadState}`);
  return data;
}

async function publishItem(accessToken) {
  const targetLabel = PUBLISH_TARGET === 'trustedTesters' ? 'trusted testers' : 'public';
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
      body: JSON.stringify({ target: PUBLISH_TARGET }),
    }
  );

  const data = await res.json();

  if (data.status && data.status[0] !== 'OK' && data.status[0] !== 'PUBLISHED_WITH_FRICTION_WARNING') {
    console.error('Publish failed:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(`Publish status: ${data.status?.[0] || 'OK'}`);
  if (data.statusDetail) {
    console.log(`Details: ${data.statusDetail.join(', ')}`);
  }
  return data;
}

async function main() {
  const mode = process.argv[2];

  if (mode === 'zip') {
    await buildZip();
    console.log('\nZip built. Upload manually at https://chrome.google.com/webstore/devconsole');
    return;
  }

  if (!CWS_CLIENT_ID || !CWS_CLIENT_SECRET || !CWS_REFRESH_TOKEN || !CWS_ITEM_ID) {
    console.error('Missing Chrome Web Store credentials. Required secrets:');
    console.error('  CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_ITEM_ID');
    console.error('\nTo build a zip only: node scripts/publish-extension.js zip');
    process.exit(1);
  }

  const version = await buildZip();

  console.log(`\nAuthenticating with Chrome Web Store...`);
  const accessToken = await getAccessToken();

  await uploadToCWS(accessToken);
  await publishItem(accessToken);

  const targetLabel = PUBLISH_TARGET === 'trustedTesters' ? 'trusted testers' : 'the public';
  console.log(`\nv${version} published to ${targetLabel}!`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
