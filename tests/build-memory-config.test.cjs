const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../next.config.js');

test('build memory controls keep compiler phases sequential and page workers bounded', () => {
  assert.equal(config.experimental.webpackBuildWorker, true);
  assert.equal(config.experimental.webpackMemoryOptimizations, true);
  assert.equal(config.experimental.parallelServerCompiles, false);
  assert.equal(config.experimental.parallelServerBuildTraces, false);
  assert.equal(config.experimental.cpus, 1);
});

test('worker-compatible webpack hook preserves server externals and dev watching', async () => {
  for (const dev of [true, false]) {
    for (const isServer of [true, false]) {
      const original = { externals: [], ignoreWarnings: [] };
      const result = config.webpack(original, { dev, isServer });
      assert.equal(result, original);
      if (isServer) {
        const externalize = result.externals.at(-1);
        for (const request of ['mongodb', 'postgres', 'drizzle-orm', 'node:perf_hooks']) {
          externalize({ request }, (error, value) => {
            assert.ifError(error);
            assert.equal(value, `commonjs ${request}`);
          });
        }
        externalize({ request: 'not-a-server-external' }, (...args) => assert.equal(args.length, 0));
      } else assert.deepEqual(result.externals, []);
      assert.equal(Boolean(result.watchOptions), dev);
      assert.equal(result.ignoreWarnings.length, 3);
    }
  }
  assert.deepEqual(config.outputFileTracingIncludes, { '/': ['./lib/cron/*.cjs'] });
  assert.ok(config.serverExternalPackages.includes('mongodb'));
  assert.ok((await config.headers()).length > 0);
});
