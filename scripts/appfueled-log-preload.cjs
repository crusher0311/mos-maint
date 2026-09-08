'use strict';

const path = require('node:path');
const {
  redactAppFueledHookLogText,
  REDACTED_HOOK_PATH,
} = require('../lib/appfueled-hook-log-redaction-core.cjs');

const PREFIX = '/api/webhooks/appfueled/';
const MAX_PENDING_CHARS = 8 * 1024;
const INSTALLED = Symbol.for('mos.appFueledOutputRedactionInstalled');

function longestPrefixSuffix(value) {
  const lowerValue = value.toLowerCase();
  const max = Math.min(value.length, PREFIX.length - 1);
  for (let length = max; length > 0; length--) {
    if (lowerValue.endsWith(PREFIX.slice(0, length))) return length;
  }
  return 0;
}

function installStreamRedaction(stream) {
  if (!stream || typeof stream.write !== 'function') return;
  const originalWrite = stream.write.bind(stream);
  let pending = '';
  let discardUntilBoundary = false;

  stream.write = function appFueledRedactedWrite(chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }

    let emittedBytes;
    if (typeof chunk === 'string') {
      // Inspect the bytes Node will actually emit. In particular, a hex/base64
      // string is not its plaintext representation until the stream applies
      // the requested encoding.
      emittedBytes = Buffer.from(chunk, encoding || 'utf8');
    } else if (chunk instanceof Uint8Array) {
      // Buffer.from(Uint8Array) can ignore a view's byte offset depending on
      // overload selection; use its exact backing range explicitly.
      emittedBytes = Buffer.from(
        chunk.buffer,
        chunk.byteOffset,
        chunk.byteLength,
      );
    } else {
      // Preserve Node's native error behavior for unsupported write values.
      return originalWrite(chunk, encoding, callback);
    }
    const emittedText = emittedBytes.toString('utf8');
    // Text encodings such as utf16le emit non-UTF-8 bytes, but the caller's
    // source string still exposes the credential. Prefer that semantic text
    // whenever it contains (or ends with part of) the protected prefix;
    // encoded representations such as hex/base64 fall back to emitted bytes.
    const text =
      typeof chunk === 'string' &&
      (chunk.toLowerCase().includes(PREFIX) || longestPrefixSuffix(chunk) > 0)
        ? chunk
        : emittedText;
    let value = pending + text;
    pending = '';
    let output = '';

    // An overlong credential/path was already replaced. Drop every subsequent
    // chunk until its URL boundary so no query or path tail can escape merely
    // because the candidate exceeded the bounded pending buffer.
    if (discardUntilBoundary) {
      const boundary = value.search(/[\s"'`)<>\]}]/);
      if (boundary === -1) {
        if (typeof callback === 'function') queueMicrotask(callback);
        return true;
      }
      value = value.slice(boundary);
      discardUntilBoundary = false;
    }

    while (value) {
      const start = value.toLowerCase().indexOf(PREFIX);
      if (start === -1) {
        const partialLength = longestPrefixSuffix(value);
        output += value.slice(0, value.length - partialLength);
        pending = value.slice(value.length - partialLength);
        break;
      }

      output += value.slice(0, start);
      const candidate = value.slice(start);
      const boundaryOffset = candidate.slice(PREFIX.length).search(/[\s"'`)<>\]}]/);
      if (boundaryOffset === -1) {
        if (candidate.length >= MAX_PENDING_CHARS) {
          output += REDACTED_HOOK_PATH;
          discardUntilBoundary = true;
        } else {
          pending = candidate;
        }
        break;
      }

      const boundary = PREFIX.length + boundaryOffset;
      output += REDACTED_HOOK_PATH;
      value = candidate.slice(boundary);
    }

    // Fast paths without a candidate preserve normal stream behavior and the
    // caller's original Buffer/string type. A partial credential is accepted
    // into this bounded buffer and its callback is completed immediately.
    if (!pending && output === text) {
      return originalWrite(chunk, encoding, callback);
    }
    // `output` is now decoded text even when the input used hex/base64. Always
    // write transformed output as UTF-8; reusing the input encoding would
    // reinterpret the replacement and could corrupt or bypass it.
    if (output) return originalWrite(output, 'utf8', callback);
    if (typeof callback === 'function') queueMicrotask(callback);
    return true;
  };
}

function install() {
  if (globalThis[INSTALLED]) return;
  globalThis[INSTALLED] = true;
  installStreamRedaction(process.stdout);
  installStreamRedaction(process.stderr);
}

function ensurePreloadInNodeOptions(existing = '') {
  const preload = path.resolve(__dirname, 'appfueled-log-preload.cjs');
  if (existing.includes(preload) || existing.includes('appfueled-log-preload.cjs')) {
    return existing;
  }
  return `--require=${preload} ${existing}`.trim();
}

install();

module.exports = {
  ensurePreloadInNodeOptions,
  install,
  redactAppFueledHookLogText,
};