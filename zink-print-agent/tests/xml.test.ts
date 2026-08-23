import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildZinkHeader,
  DEFAULT_WIDTH,
  DEFAULT_CUT,
  DEFAULT_SPEED,
} from "../src/xml";

test("buildZinkHeader emits the documented vivid/full-cut print setup", () => {
  assert.equal(
    buildZinkHeader({}, 347),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<print>",
      "<mode>vivid</mode>",
      "<speed>0</speed>",
      "<lpi>317</lpi>",
      "<width>0</width>",
      "<height>0</height>",
      "<dataformat>jpeg</dataformat>",
      "<autofit>1</autofit>",
      "<datasize>347</datasize>",
      "<cutmode>full</cutmode>",
      "</print>",
    ].join("\n") + "\n",
  );
  assert.equal(DEFAULT_WIDTH, 640);
  assert.equal(DEFAULT_CUT, 1);
  assert.equal(DEFAULT_SPEED, 0);
});

test("buildZinkHeader maps half cut + normal speed to protocol values", () => {
  const xml = buildZinkHeader({ cut: 0, speed: 1 }, 99);
  assert.match(xml, /<mode>color<\/mode>/);
  assert.match(xml, /<speed>1<\/speed>/);
  assert.match(xml, /<lpi>264<\/lpi>/);
  assert.match(xml, /<cutmode>half<\/cutmode>/);
  assert.match(xml, /<datasize>99<\/datasize>/);
});

test("buildZinkHeader validates the image width hint but uses protocol autofit", () => {
  const xml = buildZinkHeader({ width: 320 }, 5);
  assert.match(xml, /<width>0<\/width>/);
  assert.match(xml, /<autofit>1<\/autofit>/);
});

test("buildZinkHeader rejects non-bit cut/speed", () => {
  assert.throws(() => buildZinkHeader({ cut: 2 as 0 | 1 }, 1), /cut.*must be 0 or 1/);
  assert.throws(() => buildZinkHeader({ speed: -1 as 0 | 1 }, 1), /speed.*must be 0 or 1/);
});

test("buildZinkHeader rejects invalid width", () => {
  assert.throws(() => buildZinkHeader({ width: 0 }, 1), /width.*positive integer/);
  assert.throws(() => buildZinkHeader({ width: 12.5 }, 1), /width.*positive integer/);
  assert.throws(() => buildZinkHeader({ width: -640 }, 1), /width.*positive integer/);
});

test("buildZinkHeader rejects an invalid JPEG byte count", () => {
  assert.throws(() => buildZinkHeader({}, 0), /jpegByteLength.*positive integer/);
  assert.throws(() => buildZinkHeader({}, 1.5), /jpegByteLength.*positive integer/);
});
