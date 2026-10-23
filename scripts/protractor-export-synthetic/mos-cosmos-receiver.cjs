'use strict';
// Standalone MOS-only receiver. The older empty-test receiver is intentionally unchanged.
const http = require('node:http');
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const MAX_BYTES = 512 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }

function verify(raw, headers, secret, now) {
  const id = headers['x-mos-delivery-id'], timestamp = headers['x-mos-timestamp'];
  const signature = headers['x-mos-signature'];
  if (typeof id !== 'string' || !uuid.test(id) ||
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
  if (body.enterpriseId !== config.enterpriseId ||
      !config.shopIds.includes(body.shopId)) fail(403, 'Unapproved export scope');
  if (body.synthetic !== undefined && typeof body.synthetic !== 'boolean')
    fail(422, 'Invalid synthetic marker');
  if (body.synthetic === true && body.records.length !== 0)
    fail(422, 'Synthetic tests must contain no records');
  if (body.synthetic !== true && !config.allowReal)
    fail(403, 'Real exports disabled at receiver');
  for (const record of body.records) {
    if (!object(record) || record.shopId !== body.shopId ||
        !['work_order', 'invoice'].includes(record.entityType) ||
        typeof record.providerId !== 'string' || !record.providerId.trim() ||
        record.providerId.length > 2048 || typeof record.source !== 'string' ||
        !record.source || typeof record.observedAt !== 'string' ||
        !Number.isFinite(Date.parse(record.observedAt)) || !object(record.payload))
      fail(422, 'Invalid snapshot record');
  }
}

// Immutable create/read, never upsert: delayed deliveries cannot overwrite newer observations.
// Consumers must join records to a completed receipt; partial batches are not published.
async function createExact(container, doc) {
  try { await container.items.create(doc); }
  catch (error) {
    if (Number(error.code) !== 409) throw error;
    const { resource } = await container.item(doc.id, doc.mosScope).read();
    if (!resource || resource.contentHash !== doc.contentHash)
      fail(409, 'Delivery ID conflicts with previously stored content');
  }
}
function seal(doc) { return { ...doc, contentHash: hash(JSON.stringify(doc)) }; }

function createReceiver({ container, secret, enterpriseId, shopIds, allowReal = false, now = Date.now }) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 ||
      typeof enterpriseId !== 'string' || !enterpriseId ||
      !Array.isArray(shopIds) || !shopIds.length ||
      shopIds.some(id => !Number.isSafeInteger(id) || id <= 0) || !container)
    throw new Error('Explicit signing secret, scope and Cosmos container required');
  const config = { enterpriseId, shopIds, allowReal };
  return async function receive(raw, headers) {
    if (raw.length > MAX_BYTES) fail(413, 'Payload too large');
    const id = verify(raw, headers, secret, now());
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'Invalid JSON'); }
    validate(body, id, config);
    const mosScope = hash(JSON.stringify([enterpriseId, body.shopId]));
    const base = { mosScope, deliveryId: id, enterpriseId, shopId: body.shopId,
      requestHash: hash(raw) };
    // Reserve the ID before any record writes. Concurrent conflicting payloads lose here.
    await createExact(container, seal({ ...base, id: `claim-${id}`, type: 'mos_delivery_claim' }));
    for (const [index, record] of body.records.entries()) {
      await createExact(container, seal({ ...base, id: `snapshot-${id}-${index}`,
        type: 'mos_snapshot', index,
        logicalId: hash(JSON.stringify([enterpriseId, body.shopId, record.entityType, record.providerId])),
        record }));
    }
    const { records, ...envelope } = body;
    // Commit marker last. A retry verifies all immutable records before acknowledging.
    await createExact(container, seal({ ...base, id: `receipt-${id}`,
      type: 'mos_delivery_receipt', complete: true, recordCount: records.length, envelope }));
    return { deliveryId: id, records: records.length };
  };
}

function createServer(receive) {
  return http.createServer(async (req, res) => {
    function reply(status, body) {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    }
    if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/webhook') return reply(404, { error: 'Not found' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '') ||
        req.headers['content-encoding']) return reply(415, { error: 'JSON without content encoding required' });
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) { reply(413, { error: 'Payload too large' }); return; }
        chunks.push(chunk);
      }
      const result = await receive(Buffer.concat(chunks), req.headers);
      res.setHeader('X-MOS-Acknowledgment', result.deliveryId);
      reply(200, { accepted: true, ...result });
    } catch (error) {
      // No raw bodies, credentials, Cosmos errors or customer details in responses/logs.
      reply(error.status || 503, { error: error.status ? error.message : 'Storage unavailable; retry later' });
    }
  });
}

async function main() {
  const env = process.env;
  for (const key of ['MOS_WEBHOOK_SECRET', 'MOS_ENTERPRISE_ID', 'MOS_SHOP_IDS',
    'COSMOS_ENDPOINT', 'COSMOS_KEY', 'COSMOS_DATABASE', 'COSMOS_CONTAINER'])
    if (!env[key]) throw new Error(`Missing configuration: ${key}`);
  const { CosmosClient } = require('@azure/cosmos');
  const client = new CosmosClient({ endpoint: env.COSMOS_ENDPOINT, key: env.COSMOS_KEY,
    connectionPolicy: { requestTimeout: 5000, retryOptions: { maxRetryAttemptCount: 0 } } });
  const container = client.database(env.COSMOS_DATABASE).container(env.COSMOS_CONTAINER);
  const { resource } = await container.read();
  if (JSON.stringify(resource?.partitionKey?.paths) !== JSON.stringify(['/mosScope']) ||
      resource.defaultTtl !== undefined || resource.uniqueKeyPolicy?.uniqueKeys?.length)
    throw new Error('Use a dedicated /mosScope partitioned container without TTL or unique-key constraints');
  const receive = createReceiver({ container, secret: env.MOS_WEBHOOK_SECRET,
    enterpriseId: env.MOS_ENTERPRISE_ID, shopIds: env.MOS_SHOP_IDS.split(',').map(Number),
    allowReal: env.MOS_ALLOW_REAL_EXPORTS === '1' });
  const server = createServer(receive);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(Number(env.PORT || 3000), '127.0.0.1', () => console.log('MOS receiver ready on loopback; no public history endpoint'));
}
if (require.main === module) main().catch(() => {
  console.error('Receiver startup failed. Check configuration, SDK installation and Cosmos container permissions.');
  process.exitCode = 1;
});
module.exports = { createReceiver, createServer };
