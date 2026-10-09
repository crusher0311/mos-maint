import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRoNumber } from "./ro-number";

test("RO input accepts human-facing display prefixes", () => {
  for (const input of ["18427", " #18427 ", "RO 18427", "ro #18427", "RO: 18427", "RO18427"]) {
    assert.equal(normalizeRoNumber(input), "18427");
  }
});

test("RO normalization preserves leading zeroes and meaningful identifiers", () => {
  assert.equal(normalizeRoNumber("RO #00184-A"), "00184-A");
  assert.equal(normalizeRoNumber("ROAD-184"), "ROAD-184");
  assert.equal(normalizeRoNumber("  AB-184  "), "AB-184");
});

test("prefix-only input does not become a valid RO number", () => {
  for (const input of ["", "  ", "#", "RO", "RO #"]) {
    assert.equal(normalizeRoNumber(input), "");
  }
});
