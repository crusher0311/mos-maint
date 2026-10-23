'use strict';
// Standalone Node 20+ receiver: no packages or database required.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const MAX_BYTES = 512 * 1024;
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function authenticate(raw, headers, secret, now) {
  const id = headers['x-mos-delivery-id'], timestamp = headers['x-mos-timestamp'];
  const signature = headers['x-mos-signature'];
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) ||
      typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) ||
      Math.abs(now / 1000 - Number(timestamp)) > 300 ||
      typeof signature !== 'string' || !/^v1=[a-f0-9]{64}$/.test(signature))
    fail(401, 'Invalid or expired signature');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${id}.`).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex')))
    fail(401, 'Invalid or expired signature');
  return id;
}

function validate(body, id, config) {
  if (!object(body) || body.schemaVersion !== 'mos.protractor.snapshots.v1' ||
      body.deliveryId !== id || body.provider !== 'protractor' || body.kind !== 'snapshots' ||
      !Array.isArray(body.records) || body.records.length > 25 ||
      !object(body.window) || !object(body.coverage))
    fail(422, 'Invalid MOS snapshot envelope');
  if (body.enterpriseId !== config.enterpriseId || !config.shopIds.includes(body.shopId))
    fail(403, 'Unapproved export scope');
  if (body.synthetic !== undefined && typeof body.synthetic !== 'boolean')
    fail(422, 'Invalid synthetic marker');
  if (body.synthetic === true && body.records.length !== 0)
    fail(422, 'Synthetic connectivity tests must be empty');
  if (body.synthetic !== true && !config.allowReal)
    fail(403, 'Record-bearing exports disabled at receiver');
  for (const record of body.records) {
    if (!object(record) || record.shopId !== body.shopId ||
        !['work_order', 'invoice'].includes(record.entityType) ||
        typeof record.providerId !== 'string' || !record.providerId.trim() ||
        record.providerId.length > 2048 || typeof record.source !== 'string' || !record.source ||
        typeof record.observedAt !== 'string' || !Number.isFinite(Date.parse(record.observedAt)) ||
        !object(record.payload)) fail(422, 'Invalid snapshot record');
  }
}

async function syncDirectory(directory, io) {
  // Windows doesn't support opening directories for fsync through Node.
  // Files are still flushed; don't promise power-loss-proof directory entries there.
  if (process.platform === 'win32') return;
  const handle = await io.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function saveExact(directory, id, raw, io = fs) {
  const target = path.join(directory, `${id.toLowerCase()}.json`);
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await io.open(temporary, 'wx', 0o600);
    await handle.writeFile(raw);
    await handle.sync();
    await handle.close(); handle = undefined;
    try {
      // Atomic no-replace publication, unlike rename which can overwrite an existing ID.
      // Requires hard-link support (NTFS on Windows); fail closed on unsupported storage.
      await io.link(temporary, target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await io.readFile(target)).equals(raw))
        fail(409, 'Delivery ID already contains different data');
    }
    // Also flush an existing identical file: it may be from a previous ambiguous attempt.
    handle = await io.open(target, 'r+');
    await handle.sync();
    await handle.close(); handle = undefined;
    await syncDirectory(directory, io);
    return path.basename(target);
  } finally {
    if (handle) await handle.close();
    await io.unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function createReceiver({ secret, enterpriseId, shopIds, directory,
  allowReal = false, now = Date.now, io = fs }) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 ||
      typeof enterpriseId !== 'string' || !enterpriseId || !Array.isArray(shopIds) ||
      !shopIds.length || shopIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      typeof directory !== 'string' || !directory)
    throw new Error('Signing secret, approved scope and storage folder required');
  directory = path.resolve(directory);
  await io.mkdir(directory, { recursive: true, mode: 0o700 });
  const config = { enterpriseId, shopIds, allowReal };
  return async (raw, headers) => {
    if (raw.length > MAX_BYTES) fail(413, 'Payload too large');
    const id = authenticate(raw, headers, secret, now());
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'Invalid JSON'); }
    validate(body, id, config);
    const file = await saveExact(directory, id, raw, io);
    return { deliveryId: id, records: body.records.length, file };
  };
}

function createServer(receive) {
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/webhook') return reply(404, { error: 'Not found' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '') ||
        req.headers['content-encoding']) return reply(415, { error: 'Uncompressed JSON required' });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) { reply(413, { error: 'Payload too large' }); return; }
        chunks.push(chunk);
      }
      const result = await receive(Buffer.concat(chunks), req.headers);
      res.setHeader('X-MOS-Acknowledgment', result.deliveryId);
      reply(200, { accepted: true, ...result });
    } catch (error) {
      reply(error.status || 503, { error: error.status ? error.message : 'Local save failed; retry later' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
async function main() {
  const env = process.env;
  const receive = await createReceiver({
    secret: env.MOS_WEBHOOK_SECRET, enterpriseId: env.MOS_ENTERPRISE_ID,
    shopIds: (env.MOS_SHOP_IDS || '').split(',').map(Number),
    directory: env.MOS_RECEIVED_DIR || path.join(__dirname, 'received-mos'),
    allowReal: env.MOS_ALLOW_REAL_EXPORTS === '1'
  });
  createServer(receive).listen(Number(env.PORT || 3000), '127.0.0.1', () =>
    console.log('Signed MOS receiver ready on localhost. POST /webhook; JSON files in the configured private folder.'));
}
if (require.main === module) main().catch(() => {
  console.error('Receiver could not start. Check signing/scope configuration and local folder permissions.');
  process.exitCode = 1;
});
module.exports = { createReceiver, createServer, saveExact };
