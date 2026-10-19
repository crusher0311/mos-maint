/* Shared browser protocol. Storage contains hashes/IDs only, never findings.
 * A persisted target gate is intentionally independent of draft revision. */
(function (root) {
  const warning = 'Verification is required. Do not resend the inspection or create a replacement request.';
  async function hash(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }
  function key(context) {
    if (!context.scopeKey || !context.workOrderGuid || !context.vin) throw Error(warning);
    return 'mos-dvi-request-v1:' + JSON.stringify([context.scopeKey, context.workOrderGuid, context.vin]);
  }
  function read(storage, context) {
    const raw = storage.getItem(key(context));
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (!record.clientRequestId || !record.revision) throw Error(warning);
    return record;
  }
  async function prepare(storage, context, draft) {
    if (context.operation || read(storage, context)) throw Error(warning);
    const record = {clientRequestId: crypto.randomUUID(), revision: await hash(draft)};
    // Recheck after hashing; edits and double clicks never replace a target gate.
    if (read(storage, context)) throw Error(warning);
    storage.setItem(key(context), JSON.stringify(record));
    if (storage.getItem(key(context)) !== JSON.stringify(record)) throw Error(warning);
    return {...draft, workOrderGuid: context.workOrderGuid, clientScopeKey: context.scopeKey, clientRequestId: record.clientRequestId};
  }
  const api = {warning, read, prepare};
  if (typeof module === 'object') module.exports = api;
  else root.MosDviRequest = api;
})(typeof globalThis === 'object' ? globalThis : this);
