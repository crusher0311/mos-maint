import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialSyncPresentation,
  shouldPollInitialSync,
  MAX_STATUS_POLLS,
  STATUS_POLL_INTERVAL_MS,
} from "../app/dashboard/settings/protractor/initial-sync-status";

test("a saved connection is not described as ready while history is pending or running", () => {
  const pending = initialSyncPresentation({ configured: true, initialSyncState: "pending" });
  assert.equal(pending.title, "Connected — history import pending");
  assert.match(pending.detail, /queued and has not started/);
  assert.equal(initialSyncPresentation({ configured: true, initialSyncState: "running" }).tone, "progress");
  assert.match(initialSyncPresentation({ configured: true, initialSyncState: "running" }).detail, /in progress/);
  assert.match(initialSyncPresentation({ configured: true, initialSyncState: null }).detail, /not been confirmed complete/);
});

test("finished and failed states report only confirmed outcomes", () => {
  const complete = initialSyncPresentation({ configured: true, initialSyncState: "complete", initialSyncVehicles: 0 });
  assert.match(complete.detail, /0 service items cached/);
  assert.equal(complete.tone, "success");
  const failed = initialSyncPresentation({ configured: true, initialSyncState: "failed", initialSyncError: "Import was interrupted" });
  assert.equal(failed.tone, "error");
  assert.equal(failed.detail, "Import was interrupted");
  assert.equal(initialSyncPresentation({ configured: false, initialSyncState: "complete" }).title, "Not connected");
});

test("only active configured imports qualify for finite polling", () => {
  assert.equal(shouldPollInitialSync({ configured: true, initialSyncState: "pending" }), true);
  assert.equal(shouldPollInitialSync({ configured: true, initialSyncState: "running" }), true);
  for (const state of ["complete", "failed", null] as const) {
    assert.equal(shouldPollInitialSync({ configured: true, initialSyncState: state }), false);
  }
  assert.equal(shouldPollInitialSync({ configured: false, initialSyncState: "running" }), false);
  assert.equal(shouldPollInitialSync(null), false);
  assert.ok(MAX_STATUS_POLLS > 0 && MAX_STATUS_POLLS <= 60);
  assert.ok(STATUS_POLL_INTERVAL_MS >= 1000);
});