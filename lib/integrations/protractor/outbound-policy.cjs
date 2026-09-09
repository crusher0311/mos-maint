"use strict";

const crypto = require("node:crypto");

const DENY_ENV = "PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS";
const CALLBACK_CANARY_UNTIL_ENV = "PROTRACTOR_CALLBACK_CANARY_UNTIL";
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Pure evaluation of the local Protractor outbound policy.  Callers pass an
 * env-shaped object so tests and boot-time code do not need to mutate globals.
 *
 * A configured policy fails closed when it cannot be parsed or this process
 * has no stable identity.  The service-wide stop always wins.
 */
function evaluateProtractorOutboundPolicy(env, nowMs = Date.now()) {
  if (env.PROTRACTOR_OUTBOUND_DISABLED === "true") {
    return { allowed: false, reason: "service_disabled", identity: null };
  }

  let callbackOnly = false;
  const rawCanaryUntil = env[CALLBACK_CANARY_UNTIL_ENV];
  if (rawCanaryUntil != null) {
    if (
      typeof rawCanaryUntil !== "string" ||
      rawCanaryUntil !== rawCanaryUntil.trim() ||
      !CANONICAL_UTC_TIMESTAMP.test(rawCanaryUntil)
    ) {
      return { allowed: false, reason: "malformed_callback_canary", identity: resolveInstanceIdentity(env) };
    }
    const canaryUntilMs = Date.parse(rawCanaryUntil);
    if (
      !Number.isFinite(canaryUntilMs) ||
      new Date(canaryUntilMs).toISOString() !== rawCanaryUntil
    ) {
      return { allowed: false, reason: "malformed_callback_canary", identity: resolveInstanceIdentity(env) };
    }
    if (canaryUntilMs <= nowMs) {
      return { allowed: false, reason: "callback_canary_expired", identity: resolveInstanceIdentity(env) };
    }
    callbackOnly = true;
  }

  const raw = env[DENY_ENV];
  if (raw == null || raw.trim() === "") {
    return {
      allowed: true,
      reason: "allowed",
      identity: resolveInstanceIdentity(env),
      callbackOnly,
    };
  }

  let values;
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
        throw new Error("deny policy must be a string array");
      }
      values = parsed.map((v) => v.trim());
    } else {
      values = trimmed.split(",").map((v) => v.trim());
    }
    if (
      values.length === 0 ||
      values.some((v) => !v || !TOKEN.test(v)) ||
      new Set(values).size !== values.length
    ) {
      throw new Error("invalid or duplicate instance identity");
    }
  } catch {
    return { allowed: false, reason: "malformed_policy", identity: resolveInstanceIdentity(env) };
  }

  const identity = resolveInstanceIdentity(env);
  if (!identity) return { allowed: false, reason: "missing_identity", identity: null };
  if (values.includes(identity)) return { allowed: false, reason: "denied_instance", identity };
  return { allowed: true, reason: "allowed", identity, callbackOnly };
}

function resolveInstanceIdentity(env) {
  // Render assigns this per replica. Do not substitute HOSTNAME: a hostname
  // can be recycled or represent a different process after a deploy.
  const value = env.RENDER_INSTANCE_ID;
  if (typeof value === "string" && TOKEN.test(value.trim())) return value.trim();
  return null;
}

function fingerprintInstance(identity) {
  if (!identity) return "unavailable";
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

function logProtractorPolicyDenial(decision, context) {
  console.warn(JSON.stringify({
    event: "protractor_outbound_policy_denied",
    reason: decision.reason,
    context,
    instanceFingerprint: fingerprintInstance(decision.identity),
  }));
}

module.exports = {
  CALLBACK_CANARY_UNTIL_ENV,
  DENY_ENV,
  evaluateProtractorOutboundPolicy,
  fingerprintInstance,
  logProtractorPolicyDenial,
  resolveInstanceIdentity,
};