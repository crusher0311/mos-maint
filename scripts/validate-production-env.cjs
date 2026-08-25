#!/usr/bin/env node
"use strict";

const REQUIRED_PRODUCTION_SECRETS = ["REPORT_SHARE_SECRET"];

function validateProductionEnv(env = process.env) {
  const missing = REQUIRED_PRODUCTION_SECRETS.filter((key) => {
    const value = env[key];
    return typeof value !== "string" || value.trim().length === 0;
  });

  if (missing.length > 0) {
    throw new Error(
      `[Startup preflight] Missing required production secret${missing.length === 1 ? "" : "s"}: ` +
        `${missing.join(", ")}. Refusing to start the production web runtime.`,
    );
  }
}

if (require.main === module) {
  try {
    validateProductionEnv();
    console.log("[Startup preflight] Required production secrets are configured.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  REQUIRED_PRODUCTION_SECRETS,
  validateProductionEnv,
};