#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  getAccessToken,
  buildZip,
  fetchLivePublishedVersion,
} = require('./publish-extension.js');

const ITEM_ID = process.env.CWS_ITEM_ID;
const ZIP_PATH = path.join(__dirname, '..', 'dist', 'mos-tools-extension.zip');

async function main() {
  console.log('=== STEP 1: token ===');
  const token = await getAccessToken();
  console.log('token len:', token.length);

  console.log('\n=== STEP 2: live version (auth + public) ===');
  const live = await fetchLivePublishedVersion(token);
  console.log('live:', live);

  console.log('\n=== STEP 3: GET item draft + published metadata ===');
  for (const proj of ['DRAFT', 'PUBLISHED']) {
    const r = await fetch(
      `https://www.googleapis.com/chromewebstore/v1.1/items/${ITEM_ID}?projection=${proj}`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' } }
    );
    const body = await r.text();
    console.log(`[${proj}] status=${r.status}`);
    console.log(`[${proj}] body=${body}`);
  }

  if (!fs.existsSync(ZIP_PATH)) {
    console.log('\n=== STEP 4: building zip ===');
    await buildZip();
  } else {
    console.log('\n=== STEP 4: reusing existing zip ===');
  }
  const zip = fs.readFileSync(ZIP_PATH);
  console.log('zip bytes:', zip.length);

  console.log('\n=== STEP 5: upload PUT ===');
  const up = await fetch(
    `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${ITEM_ID}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' },
      body: zip,
    }
  );
  const upBody = await up.text();
  console.log(`upload http=${up.status}`);
  console.log(`upload body=${upBody}`);

  console.log('\n=== STEP 6: publish POST ===');
  const pub = await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${ITEM_ID}/publish`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-goog-api-version': '2',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ target: 'default' }),
    }
  );
  const pubBody = await pub.text();
  console.log(`publish http=${pub.status}`);
  console.log(`publish body=${pubBody}`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
