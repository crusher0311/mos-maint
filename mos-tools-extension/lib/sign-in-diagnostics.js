// Deliberately no generic object logging: auth inputs/responses contain secrets.
const providers = new Set(['autoflow', 'tekmetric', 'protractor', 'shopware', 'shopmonkey']);
const provider = value => typeof value === 'string' && providers.has(value) ? value : null;
const numericId = value => {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value);
  return /^[1-9]\d{0,14}$/.test(text) ? text : null;
};

export function signInDiagnostic(phase, requested, session, status) {
  return {
    phase: ['request', 'response', 'rejected'].includes(phase) ? phase : 'unknown',
    requestedProvider: provider(requested?.provider),
    requestedSmsShopId: numericId(requested?.shopId),
    returnedProvider: provider(session?.provider),
    returnedMosShopId: numericId(session?.shopId),
    returnedSmsShopId: numericId(session?.smsShopId),
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
  };
}
