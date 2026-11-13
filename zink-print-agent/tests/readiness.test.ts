import test from "node:test";
import assert from "node:assert/strict";
import { printerReadiness, inspectionFailure } from "../src/ipp/readiness";
import { IppDiagnosticError } from "../src/ipp/transport";

test("readiness distinguishes identity, accepting jobs and stopped states", () => {
  const uuid = "urn:uuid:12345678-1234-1234-1234-123456789abc";
  const attrs: any = { "printer-uuid": [uuid.toUpperCase()], "printer-is-accepting-jobs": [true], "printer-state": [3] };
  assert.equal(printerReadiness(attrs, uuid), "ready");
  assert.equal(printerReadiness(attrs, "other"), "identity_mismatch");
  attrs["printer-state"] = [5];
  assert.equal(printerReadiness(attrs, uuid), "printer_stopped");
  attrs["printer-is-accepting-jobs"] = [false];
  assert.equal(printerReadiness(attrs, uuid), "not_accepting_jobs");
  delete attrs["printer-is-accepting-jobs"];
  assert.equal(printerReadiness(attrs, uuid), "accepting_jobs_missing");
  delete attrs["printer-uuid"];
  assert.equal(printerReadiness(attrs, uuid), "identity_missing");
  assert.equal(inspectionFailure(new Error("secret")), "attributes_failed");
  assert.equal(inspectionFailure(new IppDiagnosticError("secret")), "attributes_failed");
  assert.equal(inspectionFailure(new IppDiagnosticError("inspection_timeout")), "inspection_timeout");
});
