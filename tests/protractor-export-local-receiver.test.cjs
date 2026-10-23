const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHmac, randomUUID } = require('node:crypto');
const { createReceiver, createServer } = require('../scripts/protractor-export-synthetic/mos-local-receiver.cjs');
const secret = 'fictional-offline-fixture-secret-not-a-credential';
const now = 1800000000000;
function body(extra = {}) {
  return { schemaVersion: 'mos.protractor.snapshots.v1', deliveryId: randomUUID(),
    provider: 'protractor', kind: 'snapshots', enterpriseId: 'fixture', shopId: 298,
    window: {}, coverage: {}, synthetic: true, records: [], ...extra };
}
function sign(value, time = now / 1000) {
  const raw = Buffer.from(JSON.stringify(value)), id = value.deliveryId, timestamp = String(time);
  return [raw, { 'x-mos-delivery-id': id, 'x-mos-timestamp': timestamp,
    'x-mos-signature': 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${id}.`).update(raw).digest('hex') }];
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-local-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = { directory, secret, enterpriseId: 'fixture', shopIds: [298], now: () => now };
  return { directory, config, receive: await createReceiver(config) };
}
test('writes exact bytes, survives restart, preserves raw records and does not overwrite conflicts', async t => {
  const { directory, config, receive } = await fixture(t);
  const value = body(), args = sign(value);
  const result = await receive(...args);
  assert.deepEqual(await fs.readFile(path.join(directory, result.file)), args[0]);
  assert.equal((await (await createReceiver(config))(...args)).deliveryId, value.deliveryId);
  await assert.rejects(receive(...sign({ ...value, changed: true })), { status: 409 });
  assert.deepEqual(await fs.readFile(path.join(directory, result.file)), args[0]);
  const record = { shopId: 298, entityType: 'invoice', providerId: 'raw/1',
    observedAt: '2027-01-15T00:00:00Z', source: 'fictional-fixture',
    payload: { nested: { deferred: true } } };
  const recorded = sign(body({ synthetic: false, records: [record] }));
  await assert.rejects(receive(...recorded), { status: 403 });
  const saved = await (await createReceiver({ ...config, allowReal: true }))(...recorded);
  assert.deepEqual(await fs.readFile(path.join(directory, saved.file)), recorded[0]);
});
test('invalid signatures, stale/future timestamps, wrong scope and malformed records save nothing', async t => {
  const { directory, config, receive } = await fixture(t);
  const value = body(), [raw, headers] = sign(value);
  for (const args of [
    [raw, {}], [Buffer.concat([raw, Buffer.from(' ')]), headers],
    sign(value, now / 1000 - 301), sign(value, now / 1000 + 301)
  ]) await assert.rejects(receive(...args), { status: 401 });
  for (const value of [body({ shopId: 299 }), body({ enterpriseId: 'other' }),
    body({ records: [{}] }), body({ deliveryId: '../escape' })])
    await assert.rejects(receive(...sign(value)));
  await assert.rejects(receive(Buffer.alloc(512 * 1024 + 1), {}), { status: 413 });
  await assert.rejects(createReceiver({ ...config, secret: '' }));
  assert.deepEqual(await fs.readdir(directory), []);
});
test('concurrent identical deliveries converge, conflicting bodies have one winner', async t => {
  const { receive, directory } = await fixture(t);
  const value = body();
  await Promise.all(Array.from({ length: 8 }, () => receive(...sign(value))));
  assert.equal((await fs.readdir(directory)).length, 1);
  const next = body();
  const results = await Promise.allSettled([receive(...sign(next)), receive(...sign({ ...next, different: true }))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal((await fs.readdir(directory)).length, 2);
});
test('partial writes and unsupported hard links fail without publishing; retry recovers', async t => {
  const { config, directory, receive } = await fixture(t);
  const brokenWrite = { ...fs, async open(...args) {
    const handle = await fs.open(...args);
    if (args[1] === 'wx') return {
      writeFile: async raw => { await handle.writeFile(raw.subarray(0, 5)); throw Error('disk full'); },
      sync: () => handle.sync(), close: () => handle.close()
    };
    return handle;
  } };
  const value = body();
  await assert.rejects((await createReceiver({ ...config, io: brokenWrite }))(...sign(value)));
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects((await createReceiver({ ...config, io: {
    ...fs, link: async () => { throw Error('unsupported filesystem'); }
  } }))(...sign(value)));
  assert.deepEqual(await fs.readdir(directory), []);
  await receive(...sign(value));
});
test('post-publication flush failure has no success; restart accepts only identical bytes', async t => {
  const { config, directory, receive } = await fixture(t);
  const io = { ...fs, async open(...args) {
    const handle = await fs.open(...args);
    if (args[1] === 'r+') return {
      sync: async () => { throw Error('flush failed'); }, close: () => handle.close()
    };
    return handle;
  } };
  const value = body();
  await assert.rejects((await createReceiver({ ...config, io }))(...sign(value)));
  assert.equal((await fs.readdir(directory)).length, 1);
  await assert.rejects(receive(...sign({ ...value, changed: true })), { status: 409 });
  await receive(...sign(value));
});
test('HTTP only acknowledges saved files, rejects public browsing, hides storage errors', async t => {
  const { receive, directory } = await fixture(t);
  let broken = false;
  const server = createServer((...args) => {
    if (broken) throw Error('private path and credential details');
    return receive(...args);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const value = body(), [raw, headers] = sign(value);
  const post = () => fetch(url + '/webhook', { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' }, body: raw });
  broken = true;
  let response = await post();
  assert.equal(response.status, 503); assert.equal(response.headers.get('x-mos-acknowledgment'), null);
  assert.deepEqual(await response.json(), { error: 'Local save failed; retry later' });
  broken = false;
  response = await post();
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-mos-acknowledgment'), value.deliveryId);
  const result = await response.json();
  assert.deepEqual(await fs.readFile(path.join(directory, result.file)), raw);
  assert.equal((await fetch(url + '/')).status, 404);
  assert.equal((await fetch(url + '/' + result.file)).status, 404);
});
