const { test } = require("node:test");
const assert = require("node:assert/strict");
const { config, MONGO_URL, PG_URL } = require("./config.cjs");
const valid = {
  CRON_LEASE_INTEGRATION: "disposable-only",
  CRON_LEASE_TEST_MONGO_URL: MONGO_URL,
  CRON_LEASE_TEST_PG_URL: PG_URL,
};

test("integration configuration requires opt-in and both explicit URLs", () => {
  assert.throws(() => config({}));
  for (const key of Object.keys(valid)) {
    const env = { ...valid };
    delete env[key];
    assert.throws(() => config(env));
  }
  assert.deepEqual(config(valid), { mongoUrl: MONGO_URL, pgUrl: PG_URL });
});

test("refuses application credentials by name, without reading their values", () => {
  for (const key of ["MONGODB_USERNAME", "MONGODB_PASSWORD", "DATABASE_URL",
    "DATAONE_DATABASE_URL", "NEON_DATABASE_URL", "SUPABASE_PROD_DATABASE_URL",
    "PGPASSWORD", "PGHOST"]) {
    const env = { ...valid };
    Object.defineProperty(env, key, { enumerable: true, get() { throw new Error("secret read"); } });
    assert.throws(() => config(env), /Application database configuration/);
  }
});

test("refuses remote, application, credential, and URL-option substitutions", () => {
  for (const value of [
    MONGO_URL.replace("127.0.0.1", "cluster.mongodb.net"),
    MONGO_URL.replace("mongodb:", "mongodb+srv:"),
    MONGO_URL.replace("cron_lease_test", "mos"),
    MONGO_URL + "?replicaSet=app",
    MONGO_URL.replace("127.0.0.1", "app:secret@127.0.0.1"),
  ]) assert.throws(() => config({ ...valid, CRON_LEASE_TEST_MONGO_URL: value }));
  for (const value of [
    PG_URL.replace("127.0.0.1", "db.example.com"),
    PG_URL.replace("disposable_only", "application-password"),
    PG_URL.replace(/cron_lease_test$/, "postgres"),
    PG_URL + "?host=db.example.com",
  ]) assert.throws(() => config({ ...valid, CRON_LEASE_TEST_PG_URL: value }));
});
