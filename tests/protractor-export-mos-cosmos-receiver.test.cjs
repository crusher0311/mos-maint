const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const { createReceiver, createServer } = require('../scripts/protractor-export-synthetic/mos-cosmos-receiver.cjs');
const secret = 'fixture-only-signing-secret-not-a-real-credential';
const clock = 1800000000000;
function envelope(extra = {}) {
  return { schemaVersion: 'mos.protractor.snapshots.v1', deliveryId: randomUUID(),
    enterpriseId: 'fixture-enterprise', shopId: 298, provider: 'protractor', kind: 'snapshots',
    window: { date: '2027-01-15' }, coverage: { completeProviderHistory: false },
    records: [{ shopId: 298, entityType: 'invoice', providerId: 'invoice/1?#',
      observedAt: '2027-01-15T08:00:00Z', source: 'fixture', payload: { nested: { deferred: true }, id: 'raw-id' } }],
    ...extra };
}
function signed(body, timestamp = String(clock / 1000)) {
  const raw = Buffer.from(JSON.stringify(body)), id = body.deliveryId;
  return [raw, { 'x-mos-delivery-id': id, 'x-mos-timestamp': timestamp,
    'x-mos-signature': 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${id}.`).update(raw).digest('hex') }];
}
function fakeContainer() {
  const docs = new Map();
  let failType = '', lostType = '';
  return { docs,
    fail(type) { failType = type; }, loseResponse(type) { lostType = type; },
    items: { async create(doc) {
      if (doc.type === failType) throw Object.assign(Error('storage failure'), { code: 429 });
      const key = doc.mosScope + ':' + doc.id;
      if (docs.has(key)) throw Object.assign(Error('duplicate'), { code: 409 });
      docs.set(key, structuredClone(doc));
      if (doc.type === lostType) { lostType = ''; throw Error('response lost after commit'); }
    } },
    item(id, pk) { return { async read() { return { resource: docs.get(pk + ':' + id) }; } }; }
  };
}
function receiver(container, overrides = {}) {
  return createReceiver({ container, secret, enterpriseId: 'fixture-enterprise',
    shopIds: [298, 299], allowReal: true, now: () => clock, ...overrides });
}
test('requires credentials, validates exact bytes and rejects expired/future/malformed signatures before writes', async () => {
  const db = fakeContainer(), run = receiver(db);
  assert.throws(() => receiver(db, { secret: '' }));
  const body = envelope(), [raw, headers] = signed(body);
  for (const [bytes, h] of [
    [Buffer.concat([raw, Buffer.from(' ')]), headers],
    [raw, { ...headers, 'x-mos-signature': 'v1=bad' }],
    [raw, { ...headers, 'x-mos-delivery-id': randomUUID() }],
    signed(body, String(clock / 1000 - 301)),
    signed(body, String(clock / 1000 + 301)),
    [raw, {}]
  ]) await assert.rejects(run(bytes, h), { status: 401 });
  assert.equal(db.docs.size, 0);
});
test('validates scope, whole batch, envelope ID, real-data gate and bounded payload', async () => {
  const db = fakeContainer(), run = receiver(db);
  for (const body of [
    envelope({ enterpriseId: 'other' }), envelope({ shopId: 300 }),
    envelope({ synthetic: true }), envelope({ records: Array(26).fill({}) }),
    envelope({ records: [envelope().records[0], { invalid: true }] }),
    envelope({ records: [{ ...envelope().records[0], shopId: 299 }] })
  ]) await assert.rejects(run(...signed(body)), e => [403, 422].includes(e.status));
  const body = envelope();
  const [raw, headers] = signed(body);
  const mismatch = { ...headers, 'x-mos-delivery-id': randomUUID() };
  mismatch['x-mos-signature'] = 'v1=' + createHmac('sha256', secret)
    .update(`${mismatch['x-mos-timestamp']}.${mismatch['x-mos-delivery-id']}.`).update(raw).digest('hex');
  await assert.rejects(run(raw, mismatch), { status: 422 });
  await assert.rejects(receiver(db, { allowReal: false })(...signed(body)), { status: 403 });
  await assert.rejects(run(Buffer.alloc(512 * 1024 + 1), {}), { status: 413 });
  assert.equal(db.docs.size, 0);
  await receiver(db, { allowReal: false })(...signed(envelope({ synthetic: true, records: [] })));
  assert.equal(db.docs.size, 2);
});
test('preserves raw records, scoped identity and exact-byte retry receipts across receiver restarts', async () => {
  const db = fakeContainer(), body = envelope(), args = signed(body);
  await receiver(db)(...args);
  await receiver(db)(...args);
  assert.equal(db.docs.size, 3);
  const snapshot = [...db.docs.values()].find(d => d.type === 'mos_snapshot');
  assert.deepEqual(snapshot.record, body.records[0]);
  assert.match(snapshot.logicalId, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.id.includes('/'), false);
  await assert.rejects(receiver(db)(...signed({ ...body, changed: true })), { status: 409 });
  const other = envelope({ shopId: 299 });
  other.records[0].shopId = 299;
  await receiver(db)(...signed(other));
  const otherSnapshot = [...db.docs.values()].filter(d => d.type === 'mos_snapshot')[1];
  assert.notEqual(otherSnapshot.logicalId, snapshot.logicalId);
  assert.notEqual(otherSnapshot.mosScope, snapshot.mosScope);
});
test('partial storage and lost commit responses never acknowledge early; retry converges', async () => {
  for (const failureType of ['mos_snapshot', 'mos_delivery_receipt']) {
    const db = fakeContainer(), args = signed(envelope());
    db.fail(failureType);
    await assert.rejects(receiver(db)(...args));
    assert.equal([...db.docs.values()].some(d => d.complete), false);
    db.fail('');
    await receiver(db)(...args);
    assert.equal(db.docs.size, 3);
  }
  for (const lostType of ['mos_delivery_claim', 'mos_snapshot', 'mos_delivery_receipt']) {
    const db = fakeContainer(), args = signed(envelope());
    db.loseResponse(lostType);
    await assert.rejects(receiver(db)(...args));
    await receiver(db)(...args);
    assert.equal(db.docs.size, 3);
  }
});
test('concurrent duplicates converge; conflicting payload cannot replace a claim', async () => {
  const db = fakeContainer(), body = envelope();
  await Promise.all(Array.from({ length: 5 }, () => receiver(db)(...signed(body))));
  assert.equal(db.docs.size, 3);
  const next = envelope(), conflicting = { ...next, changed: true };
  const results = await Promise.allSettled([receiver(db)(...signed(next)), receiver(db)(...signed(conflicting))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
});
test('HTTP acknowledgment appears only after persistence; no public history or storage-error leakage', async () => {
  const db = fakeContainer(), server = createServer(receiver(db));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = envelope(), [raw, headers] = signed(body);
    const post = () => fetch(url + '/webhook', { method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' }, body: raw });
    db.fail('mos_delivery_receipt');
    let response = await post();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-mos-acknowledgment'), null);
    assert.deepEqual(await response.json(), { error: 'Storage unavailable; retry later' });
    db.fail('');
    response = await post();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-mos-acknowledgment'), body.deliveryId);
    assert.equal((await response.json()).records, 1);
    assert.equal((await fetch(url + '/')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
