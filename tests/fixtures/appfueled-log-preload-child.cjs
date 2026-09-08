'use strict';

const { fork } = require('node:child_process');

const token = 'subprocess-appfueled-credential-43-chars-value';
const route = `/api/webhooks/appfueled/${token}?source=regression`;

if (process.env.APPFUELED_PRELOAD_FORK_CHILD === '1') {
  process.stdout.write('POST /api/webhooks/app');
  process.stdout.write(`fueled/${token}/unexpected?copy=${token} 503\n`);
  console.error(
    'POST /API/WebHooks/AppFueled/MixedCaseCredential' +
      '?copied=MixedCaseCredential 401',
  );
  process.stdout.write('POST /api/webhooks/appfueled/');
  process.stdout.write('A'.repeat(9 * 1024));
  process.stdout.write('OVERFLOW_TAIL_CREDENTIAL?copy=OVERFLOW_TAIL_CREDENTIAL');
  process.stdout.write(' 413\n');

  const uint8Log =
    'POST /api/webhooks/appfueled/UINT8_CREDENTIAL?copy=UINT8_CREDENTIAL 418\n';
  process.stdout.write(new Uint8Array(Buffer.from(uint8Log)));

  const offsetLog =
    'POST /api/webhooks/appfueled/OFFSET_CREDENTIAL?copy=OFFSET_CREDENTIAL 419\n';
  const offsetBacking = Buffer.concat([
    Buffer.from('ignored-prefix'),
    Buffer.from(offsetLog),
    Buffer.from('ignored-suffix'),
  ]);
  process.stderr.write(
    new Uint8Array(
      offsetBacking.buffer,
      offsetBacking.byteOffset + Buffer.byteLength('ignored-prefix'),
      Buffer.byteLength(offsetLog),
    ),
  );

  process.stdout.write('POST /api/webhooks/');
  process.stdout.write(Buffer.from('appfueled/MIXED_CHUNK_CREDENTIAL'));
  process.stdout.write(
    new Uint8Array(Buffer.from('?copy=MIXED_CHUNK_CREDENTIAL 420\n')),
  );

  const hexLog =
    'POST /api/webhooks/appfueled/HEX_CREDENTIAL?copy=HEX_CREDENTIAL 421\n';
  process.stdout.write(Buffer.from(hexLog).toString('hex'), 'hex');

  const base64Log =
    'POST /api/webhooks/appfueled/BASE64_CREDENTIAL?copy=BASE64_CREDENTIAL 422\n';
  process.stderr.write(Buffer.from(base64Log).toString('base64'), 'base64');

  const utf16Log =
    'POST /api/webhooks/appfueled/UTF16_CREDENTIAL?copy=UTF16_CREDENTIAL 423\n';
  process.stdout.write(utf16Log, 'utf16le');

  const latin1Log =
    'POST /api/webhooks/appfueled/LATIN1_CREDENTIAL?copy=LATIN1_CREDENTIAL 424\n';
  process.stderr.write(latin1Log, 'latin1');
} else {
  console.log(`POST ${route} 503`);
  const child = fork(__filename, [], {
    env: { ...process.env, APPFUELED_PRELOAD_FORK_CHILD: '1' },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    process.exitCode = code || 0;
  });
}