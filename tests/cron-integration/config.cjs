// Deliberately narrow: no SRV, remote hosts, URL options, app users, or fallback.
const MONGO_URL = "mongodb://127.0.0.1:27185/cron_lease_test";
const PG_URL = "postgres://cron_lease_test:disposable_only@127.0.0.1:55485/cron_lease_test";

function config(env) {
  if (env.CRON_LEASE_INTEGRATION !== "disposable-only") {
    throw new Error("Set CRON_LEASE_INTEGRATION=disposable-only to opt in.");
  }
  // Inspect names only; never read, compare, or print application secrets.
  const forbidden = Object.keys(env).some(key =>
    !key.startsWith("CRON_LEASE_TEST_") &&
    /MONGO|DATABASE|SUPABASE|NEON|^PG(HOST|PORT|USER|PASSWORD|DATABASE|SERVICE|PASSFILE|OPTIONS|SSLMODE)$/.test(key)
  );
  if (forbidden) throw new Error("Application database configuration is present; use a clean environment.");
  if (env.CRON_LEASE_TEST_MONGO_URL !== MONGO_URL ||
      env.CRON_LEASE_TEST_PG_URL !== PG_URL) {
    throw new Error("Only the documented disposable loopback test URLs are accepted.");
  }
  return { mongoUrl: MONGO_URL, pgUrl: PG_URL };
}

module.exports = { config, MONGO_URL, PG_URL };
