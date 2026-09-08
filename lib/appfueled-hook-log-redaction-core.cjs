'use strict';

const APPFUELED_HOOK_URL =
  /\/api\/webhooks\/appfueled\/[^\s"'`)<>\]}]+/gi;
const REDACTED_HOOK_PATH = '/api/webhooks/appfueled/[REDACTED]';

function redactAppFueledHookLogText(value) {
  return value.replace(APPFUELED_HOOK_URL, REDACTED_HOOK_PATH);
}

module.exports = {
  redactAppFueledHookLogText,
  REDACTED_HOOK_PATH,
};