// Pure labor-rate UI/background contracts shared by the side panel, service
// worker, and executable smoke tests. This file is loaded as a classic script
// by the side panel and as a side-effect import by the service worker.
/**
 * @typedef {Object} LaborRateContext
 * @property {string} provider
 * @property {string|number} shopId
 * @property {string|number} [roId]
 * @property {string|number} [tabId]
 * @property {string|number} [_tabId]
 * @property {string} [laborRateSessionDiscriminator]
 */

/**
 * @typedef {Object} LaborRateOutcome
 * @property {boolean} success
 * @property {boolean} [noChange]
 * @property {string} [ruleName]
 * @property {number} [rate]
 * @property {number} [previousRate]
 * @property {boolean} [perJob]
 * @property {number} [updatedCount]
 * @property {string[]} [jobNames]
 * @property {string} [error]
 * @property {string} [code]
 */

/**
 * @typedef {Object} LaborRateFailedOutcome
 * @property {string|null} ruleName
 * @property {number|null} rate
 * @property {string} error
 * @property {string|null} code
 */

/**
 * @typedef {Object} LaborRateApplySummary
 * @property {boolean} success
 * @property {boolean} noMatch
 * @property {boolean} noChange
 * @property {string|null} ruleName
 * @property {number|null} rate
 * @property {number|undefined} previousRate
 * @property {boolean|undefined} perJob
 * @property {number} updatedCount
 * @property {string[]} jobNames
 * @property {LaborRateContext|null} context
 * @property {boolean} [partialFailure]
 * @property {LaborRateFailedOutcome[]} [failedOutcomes]
 * @property {string} [error]
 * @property {string|null} [code]
 */

(function (root, factory) {
  const api = factory();
  root.MosLaborRateCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function normalizeProvider(provider) {
    return String(provider || '')
      .trim()
      .toLowerCase()
      .replace(/^shop[-_]ware$/, 'shopware');
  }

  function contextScopeKey(context) {
    if (!context || typeof context !== 'object') return null;
    const tabId = context._tabId ?? context.tabId ?? null;
    return JSON.stringify({
      provider: normalizeProvider(context.provider),
      shopId: context.shopId == null ? null : String(context.shopId),
      tabId: tabId == null ? null : String(tabId),
    });
  }

  function contextMatches(left, right) {
    if (!left || !right) return false;
    if (contextScopeKey(left) !== contextScopeKey(right)) return false;
    if (left.roId == null || right.roId == null) return false;
    return String(left.roId) === String(right.roId);
  }

  // Broadcasts are only useful when they still describe the visible
  // provider tab/RO and the same MOS/provider session. Missing discriminators
  // fail closed so an old worker cannot toast into a newly authenticated tab.
  function appliedBroadcastMatchesCurrent(message, currentContext, sessionDiscriminator) {
    if (!message || !message.context || !currentContext) return false;
    const expectedTabId = currentContext._tabId ?? currentContext.tabId;
    const messageTabId = message.tabId ?? message.context._tabId ?? message.context.tabId;
    if (expectedTabId == null || messageTabId == null ||
        String(expectedTabId) !== String(messageTabId)) {
      return false;
    }
    if (!contextMatches(message.context, currentContext)) return false;
    return Boolean(
      message.sessionDiscriminator &&
      sessionDiscriminator &&
      message.sessionDiscriminator === sessionDiscriminator
    );
  }

  function effectiveMutationPermission(roleCanWrite, sessionCanMutate) {
    // Explicit true values are required while auth is being resolved.
    return roleCanWrite === true && sessionCanMutate === true;
  }

  // Keep the browser/provider proof out of broadcast payloads while still
  // giving the side panel a stable discriminator for the current session.
  function sessionDiscriminator(identity) {
    const value = String(identity || '');
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `lr-${(hash >>> 0).toString(36)}`;
  }

  /**
   * @param {LaborRateOutcome[]} [outcomes]
   * @param {{perJobRuleCount?: number, context?: LaborRateContext|null}} [options]
   * @returns {LaborRateApplySummary}
   */
  function summarizeLaborRateOutcomes(outcomes = [], {
    perJobRuleCount = 0,
    context = null,
  } = {}) {
    const confirmedOutcomes = outcomes.filter((outcome) => outcome?.success === true);
    const failedOutcomes = outcomes.filter((outcome) => outcome?.success === false);
    const representative = confirmedOutcomes.find((outcome) => !outcome.noChange) ||
      confirmedOutcomes[0] ||
      outcomes[0] ||
      null;
    const result = {
      success: confirmedOutcomes.length > 0,
      noMatch: confirmedOutcomes.length === 0 &&
        failedOutcomes.length === 0 &&
        outcomes.length === 0 &&
        perJobRuleCount === 0,
      noChange: confirmedOutcomes.length > 0 &&
        confirmedOutcomes.every((outcome) => outcome.noChange),
      ruleName: representative?.ruleName || null,
      rate: representative?.rate ?? null,
      previousRate: representative?.previousRate,
      perJob: representative?.perJob,
      updatedCount: confirmedOutcomes.reduce(
        (total, outcome) => total + Number(outcome.updatedCount || 0),
        0,
      ),
      jobNames: [...new Set(
        confirmedOutcomes.flatMap((outcome) =>
          Array.isArray(outcome.jobNames) ? outcome.jobNames : []),
      )],
      context,
    };
    if (failedOutcomes.length > 0) {
      result.partialFailure = result.success;
      result.failedOutcomes = failedOutcomes.map((outcome) => ({
        ruleName: outcome.ruleName || null,
        rate: outcome.rate ?? null,
        error: outcome.error || 'Labor rate operation failed',
        code: outcome.code || null,
      }));
      result.error = result.success
        ? 'One or more labor-rate operations failed after another operation succeeded'
        : (failedOutcomes[0].error || 'Labor-rate operation failed');
      result.code = failedOutcomes[0].code || null;
    }
    if (!result.success && outcomes.length === 0) {
      result.error = perJobRuleCount > 0
        ? 'No matching jobs/labor found for category'
        : 'No matching rules found';
    }
    return result;
  }

  return {
    normalizeProvider,
    contextScopeKey,
    contextMatches,
    appliedBroadcastMatchesCurrent,
    effectiveMutationPermission,
    sessionDiscriminator,
    summarizeLaborRateOutcomes,
  };
});