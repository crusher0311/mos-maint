import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildZinkHeader,
  DEFAULT_WIDTH,
  DEFAULT_CUT,
  DEFAULT_SPEED,
} from "../src/xml";

test("buildZinkHeader applies defaults (width 640, full cut, vivid)", () => {
  assert.equal(
    buildZinkHeader(),
    `<print><width>${DEFAULT_WIDTH}</width><cut>${DEFAULT_CUT}</cut><speed>${DEFAULT_SPEED}</speed></print>`,
  );
  assert.equal(
    buildZinkHeader(),
    "<print><width>640</width><cut>1</cut><speed>0</speed></print>",
  );
});

test("buildZinkHeader honors kiss cut + draft speed", () => {
  assert.equal(
    buildZinkHeader({ cut: 0, speed: 1 }),
    "<print><width>640</width><cut>0</cut><speed>1</speed></print>",
  );
});

test("buildZinkHeader allows width override", () => {
  assert.equal(
    buildZinkHeader({ width: 320 }),
    "<print><width>320</width><cut>1</cut><speed>0</speed></print>",
  );
});

test("buildZinkHeader rejects non-bit cut/speed", () => {
  assert.throws(() => buildZinkHeader({ cut: 2 as 0 | 1 }), /cut.*must be 0 or 1/);
  assert.throws(() => buildZinkHeader({ speed: -1 as 0 | 1 }), /speed.*must be 0 or 1/);
});

test("buildZinkHeader rejects invalid width", () => {
  assert.throws(() => buildZinkHeader({ width: 0 }), /width.*positive integer/);
  assert.throws(() => buildZinkHeader({ width: 12.5 }), /width.*positive integer/);
  assert.throws(() => buildZinkHeader({ width: -640 }), /width.*positive integer/);
});
