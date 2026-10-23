// Webhook receiver that checks incoming raw data against Azure Cosmos DB (NoSQL API) document rules.
// Zero dependencies. Optional: `npm install @azure/cosmos` + COSMOS_* env vars to actually upsert docs.
// MOS adapter below accepts EMPTY SYNTHETIC TESTS ONLY, never customer exports.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const PARTITION_KEY = (process.env.PARTITION_KEY || '/id').split(',').map(s => s.trim()).filter(Boolean);
const SECRET = process.env.WEBHOOK_SECRET || '';          // if set, require HMAC-SHA256 signature
const SIG_HEADER = (process.env.SIGNATURE_HEADER || 'x-signature').toLowerCase();
const STRICT = process.env.STRICT === '1';                 // return 422 when any doc is invalid
const SAVE_DIR = path.join(__dirname, 'received');
const MAX_BODY = 50 * 1024 * 1024;

// Cosmos DB limits (https://learn.microsoft.com/azure/cosmos-db/concepts-limits)
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const MAX_ID_LENGTH = 1023;            // hard limit; 255 recommended
const MAX_PK_VALUE_BYTES = 2048;
const MAX_DEPTH = 128;
const ILLEGAL_ID_CHARS = /[\/\\?#]/;
const SYSTEM_PROPS = ['_rid', '_self', '_etag', '_attachments', '_ts'];

const history = [];
fs.mkdirSync(SAVE_DIR, { recursive: true });

let cosmosContainer = null;
async function initCosmos() {
  const { COSMOS_ENDPOINT, COSMOS_KEY, COSMOS_DATABASE, COSMOS_CONTAINER } = process.env;
  if (!COSMOS_ENDPOINT) return;
  if (COSMOS_ENDPOINT.includes('localhost')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // emulator self-signed cert
  const { CosmosClient } = require('@azure/cosmos');
  const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
  const { database } = await client.databases.createIfNotExists({ id: COSMOS_DATABASE || 'webhooktest' });
  const pk = PARTITION_KEY.length > 1
    ? { paths: PARTITION_KEY, kind: 'MultiHash', version: 2 }
    : { paths: PARTITION_KEY };
  ({ container: cosmosContainer } = await database.containers.createIfNotExists({ id: COSMOS_CONTAINER || 'raw', partitionKey: pk }));
  console.log(`Cosmos: upserting into ${database.id}/${cosmosContainer.id} (pk ${PARTITION_KEY.join(', ')})`);
}

// Accepts a single JSON object, a JSON array, an envelope ({ data|items|records|documents: [...] }), or NDJSON.
function parseBody(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return { format: 'json-array', docs: parsed };
    if (parsed && typeof parsed === 'object') {
      for (const key of ['data', 'items', 'records', 'documents', 'value']) {
        if (Array.isArray(parsed[key]) && Object.keys(parsed).length <= 3) {
          return { format: `envelope.${key}`, docs: parsed[key] };
        }
      }
    }
    return { format: 'json-object', docs: [parsed] };
  } catch (err) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length > 1) {
      const docs = [];
      for (const [i, line] of lines.entries()) {
        try { docs.push(JSON.parse(line)); }
        catch (e) { throw new Error(`NDJSON line ${i + 1}: ${e.message}`); }
      }
      return { format: 'ndjson', docs };
    }
    throw new Error(`Invalid JSON: ${err.message}`);
  }
}

function getPath(obj, p) {
  return p.split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function walk(value, depth, issues, where) {
  if (depth > MAX_DEPTH) { issues.errors.push(`nesting deeper than ${MAX_DEPTH} levels at ${where}`); return false; }
  if (typeof value === 'number') {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      issues.warnings.push(`${where}: integer ${value} exceeds 2^53 and will lose precision (store as string)`);
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (walk(v, depth + 1, issues, `${where}.${k}`) === false) return false;
    }
  }
  return true;
}

function validateDoc(doc, index) {
  const issues = { index, id: doc && doc.id, errors: [], warnings: [] };

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    issues.errors.push(`document must be a JSON object, got ${Array.isArray(doc) ? 'array' : typeof doc}`);
    return issues;
  }

  if (!('id' in doc)) issues.errors.push('missing required "id" property');
  else if (typeof doc.id !== 'string') issues.errors.push(`"id" must be a string, got ${typeof doc.id}`);
  else {
    if (doc.id.length === 0) issues.errors.push('"id" is empty');
    if (doc.id.length > MAX_ID_LENGTH) issues.errors.push(`"id" longer than ${MAX_ID_LENGTH} chars`);
    else if (doc.id.length > 255) issues.warnings.push('"id" longer than 255 chars (recommended max)');
    if (ILLEGAL_ID_CHARS.test(doc.id)) issues.errors.push('"id" contains an illegal character (/ \\ ? #)');
    if (/\s$/.test(doc.id) || /^\s/.test(doc.id)) issues.warnings.push('"id" has leading/trailing whitespace');
  }

  for (const pkPath of PARTITION_KEY) {
    const v = getPath(doc, pkPath);
    if (v === undefined) issues.warnings.push(`partition key ${pkPath} missing (doc lands in the "undefined" partition)`);
    else if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
      issues.errors.push(`partition key ${pkPath} must be string/number/boolean/null, got ${Array.isArray(v) ? 'array' : typeof v}`);
    } else if (typeof v === 'string' && Buffer.byteLength(v) > MAX_PK_VALUE_BYTES) {
      issues.errors.push(`partition key ${pkPath} value exceeds ${MAX_PK_VALUE_BYTES} bytes`);
    }
  }

  for (const p of SYSTEM_PROPS) {
    if (p in doc) issues.warnings.push(`system property "${p}" will be ignored/overwritten by Cosmos DB`);
  }

  const bytes = Buffer.byteLength(JSON.stringify(doc));
  issues.bytes = bytes;
  if (bytes > MAX_DOC_BYTES) issues.errors.push(`document is ${bytes} bytes, max is ${MAX_DOC_BYTES} (2 MB)`);

  walk(doc, 1, issues, '$');
  return issues;
}

function verifySignature(req, raw) {
  if (!SECRET) return true;
  const header = String(req.headers[SIG_HEADER] || '').replace(/^sha256=/, '');
  const expected = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

async function handleWebhook(req, res, raw) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(SAVE_DIR, `${stamp}.raw`), raw);

  if (!verifySignature(req, raw)) return send(res, 401, { error: 'signature mismatch' });

  // Explicitly separate the MOS test envelope from generic Cosmos documents.
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); } catch { /* legacy parser below */ }
  if (envelope && envelope.schemaVersion === 'mos.protractor.snapshots.v1') {
    if (envelope.synthetic !== true || !Array.isArray(envelope.records) || envelope.records.length !== 0) {
      return send(res, 422, { error: 'This MOS adapter accepts empty fictional tests only. Real export signing and Cosmos mapping are not configured.' });
    }
    const deliveryId = req.headers['x-mos-delivery-id'];
    if (typeof deliveryId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(deliveryId) ||
        envelope.deliveryId !== deliveryId) {
      return send(res, 400, { error: 'Missing or mismatched MOS delivery ID' });
    }
    const receiptPath = path.join(SAVE_DIR, `mos-synthetic-${deliveryId}.json`);
    let fd;
    try {
      try {
        fd = fs.openSync(receiptPath, 'wx', 0o600);
        fs.writeFileSync(fd, raw);
      } catch (err) {
        if (fd !== undefined || err.code !== 'EEXIST') throw err;
        if (!fs.readFileSync(receiptPath).equals(raw)) {
          return send(res, 409, { error: 'Delivery ID already used for different bytes' });
        }
        fd = fs.openSync(receiptPath, 'r+');
      }
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    const report = {
      received: stamp, format: 'mos-empty-synthetic-test', synthetic: true,
      deliveryId, documents: 0, valid: 0, invalid: 0,
      partitionKey: PARTITION_KEY, results: [],
      signatureVerificationProven: false,
    };
    log(stamp, req, report);
    res.setHeader('X-MOS-Acknowledgment', deliveryId);
    return send(res, 200, report);
  }

  let parsed;
  try { parsed = parseBody(raw.toString('utf8')); }
  catch (err) { log(stamp, req, { error: err.message }); return send(res, 400, { error: err.message }); }

  const results = parsed.docs.map(validateDoc);

  const seen = new Map();
  for (const r of results) {
    if (typeof r.id !== 'string') continue;
    const key = JSON.stringify([r.id, ...PARTITION_KEY.map(p => getPath(parsed.docs[r.index], p))]);
    if (seen.has(key)) r.warnings.push(`duplicate id+partition key with doc #${seen.get(key)} (create = 409, upsert = overwrite)`);
    else seen.set(key, r.index);
  }

  const invalid = results.filter(r => r.errors.length);
  const report = {
    received: stamp,
    format: parsed.format,
    contentType: req.headers['content-type'] || null,
    documents: results.length,
    valid: results.length - invalid.length,
    invalid: invalid.length,
    partitionKey: PARTITION_KEY,
    results: results.filter(r => r.errors.length || r.warnings.length),
  };

  if (cosmosContainer) {
    report.cosmos = { upserted: 0, failed: [] };
    for (const [i, doc] of parsed.docs.entries()) {
      if (results[i].errors.length) continue;
      try { await cosmosContainer.items.upsert(doc); report.cosmos.upserted++; }
      catch (err) { report.cosmos.failed.push({ index: i, id: doc.id, code: err.code, message: err.message.split('\n')[0] }); }
    }
  }

  fs.writeFileSync(path.join(SAVE_DIR, `${stamp}.report.json`), JSON.stringify(report, null, 2));
  log(stamp, req, report);
  send(res, STRICT && invalid.length ? 422 : 200, report);
}

function log(stamp, req, report) {
  history.unshift({ ...report, received: stamp, path: req.url });
  history.length = Math.min(history.length, 50);
  if (report.error) return console.log(`[${stamp}] ${req.method} ${req.url} -> 400 ${report.error}`);
  console.log(`[${stamp}] ${req.method} ${req.url} ${report.format}: ${report.valid}/${report.documents} Cosmos-valid` +
    (report.cosmos ? `, upserted ${report.cosmos.upserted}` : ''));
  for (const r of report.results) {
    for (const e of r.errors) console.log(`   X #${r.index} (${r.id ?? 'no id'}): ${e}`);
    for (const w of r.warnings) console.log(`   ! #${r.index} (${r.id ?? 'no id'}): ${w}`);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    if (req.url === '/health') return send(res, 200, { ok: true });
    return send(res, 200, { partitionKey: PARTITION_KEY, cosmos: !!cosmosContainer, recent: history });
  }
  if (req.method !== 'POST' && req.method !== 'PUT') return send(res, 405, { error: 'use POST' });

  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) { send(res, 413, { error: 'payload too large' }); req.destroy(); }
    else chunks.push(c);
  });
  req.on('end', () => handleWebhook(req, res, Buffer.concat(chunks)).catch(err => {
    console.error(err);
    send(res, 500, { error: err.message });
  }));
});

initCosmos()
  .catch(err => { console.error('Cosmos init failed, running validate-only:', err.message); })
  .finally(() => server.listen(PORT, () => {
    console.log(`Webhook receiver on http://localhost:${PORT}  (POST any path, GET / for recent results)`);
    console.log(`Partition key: ${PARTITION_KEY.join(', ')}${SECRET ? `, HMAC required in ${SIG_HEADER}` : ''}`);
  }));
