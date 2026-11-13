import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnosePrinter } from "../src/ipp/diagnostic";
import { IppDiagnosticError } from "../src/ipp/transport";
import { wizardOperation } from "../src/ipp/wizard";
import { IppClient } from "../src/ipp/client";

test("diagnostics expose only safe failure labels and never enroll or print", async () => {
  for (const code of ["name_resolution_failed", "certificate_rejected", "connection_failed", "inspection_timeout", "unknown"]) {
    let reads = 0;
    const client = { inspect: async () => { reads++; throw new IppDiagnosticError(code); } } as unknown as IppClient;
    const result = await diagnosePrinter("ipps://happy.local:631/ipp/print", { width: 5000, height: 5000 }, client);
    assert.equal(reads, 1);
    assert.equal(result.diagnostic, code === "unknown" ? "attributes_failed" : code);
    assert(!JSON.stringify(result).includes("happy.local"));
  }
  const client = { inspect: async () => { throw Error("secret payload"); } } as unknown as IppClient;
  assert(!JSON.stringify(await diagnosePrinter("ipp://happy.local", { width: 5000, height: 5000 }, client)).includes("secret"));
  // Invalid inputs return before reading configuration, network or credentials.
  assert.equal((await wizardOperation({ action: "diagnose", uri: "invalid" }, "/nonexistent")).diagnostic, "invalid_input");
});

test("diagnostics distinguish unsupported model and missing capabilities", async () => {
  const attrs: any = { "printer-make-and-model": ["Other"] };
  const client = { inspect: async () => attrs } as unknown as IppClient;
  const run = () => diagnosePrinter("ipp://happy.local", { width: 5000, height: 5000 }, client);
  assert.equal((await run()).diagnostic, "unsupported_model");
  attrs["printer-make-and-model"] = ["ZINK Happy"];
  assert.equal((await run()).diagnostic, "identity_missing");
  attrs["printer-uuid"] = ["urn:uuid:12345678-1234-1234-1234-123456789abc"];
  assert.equal((await run()).diagnostic, "png_missing");
  attrs["document-format-supported"] = ["image/png"];
  assert.equal((await run()).diagnostic, "no_scaling_missing");
  attrs["print-scaling-supported"] = ["none"];
  assert.equal((await run()).diagnostic, "print_job_missing");
  attrs["operations-supported"] = [2];
  assert.equal((await run()).diagnostic, "media_mismatch");
  attrs["media-col-database"] = [{
    "media-size": [{ "x-dimension": [5000], "y-dimension": [{ range: [1000, 10000] }] }],
    "media-top-margin": [0], "media-bottom-margin": [0], "media-left-margin": [0], "media-right-margin": [0],
  }];
  assert.equal((await run()).diagnostic, "accepting_jobs_missing");
  attrs["printer-is-accepting-jobs"] = [false];
  assert.equal((await run()).diagnostic, "not_accepting_jobs");
  attrs["printer-is-accepting-jobs"] = [true];
  attrs["printer-state"] = [5];
  assert.equal((await run()).diagnostic, "printer_stopped");
  attrs["printer-state"] = [3];
  assert.equal((await run()).diagnostic, "ready");
});

test("real diagnostic client sends only two read-only attribute requests", async () => {
  const operations: number[] = [];
  const client = new IppClient(async (_uri, op, _groups, document) => {
    operations.push(op); assert.equal(document, undefined);
    return { status: 0, requestId: 1, groups: [{ tag: 4, values: {} }] };
  });
  await diagnosePrinter("ipps://happy.local", { width: 5000, height: 5000 }, client);
  assert.deepEqual(operations, [0x0b, 0x0b]);
});
