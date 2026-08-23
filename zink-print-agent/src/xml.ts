/**
 * ZINK XML header builder.
 *
 * The VC-500W port-9100 protocol is a two-stage exchange:
 *   1. Send this complete XML print-setup document and wait for status code 0.
 *   2. Send exactly <datasize> raw JPEG bytes and wait for status code 0.
 *
 * Protocol facts are aligned with the reverse-engineered VC-500W contract:
 * mode vivid/speed 0/lpi 317 or mode color/speed 1/lpi 264; width/height are
 * zero when autofit is enabled; cutmode is textual ("full" or "half").
 */

import type { ZinkPrintOptions } from "./contract";

export const DEFAULT_WIDTH = 640;
export const DEFAULT_CUT: 0 | 1 = 1;
export const DEFAULT_SPEED: 0 | 1 = 0;
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

function asBit(value: number | undefined, fallback: 0 | 1, name: string): 0 | 1 {
  if (value === undefined) return fallback;
  if (value !== 0 && value !== 1) {
    throw new Error(`ZINK header "${name}" must be 0 or 1, got: ${value}`);
  }
  return value;
}

/**
 * Build the ZINK XML header string for a job.
 *
 * Width defaults to 640 (the print-head width) and is validated to be a
 * positive integer. cut/speed default to full-cut / vivid and are validated
 * to be exactly 0 or 1.
 */
export function buildZinkHeader(
  options: ZinkPrintOptions = {},
  jpegByteLength: number,
): string {
  const width = options.width ?? DEFAULT_WIDTH;
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`ZINK header "width" must be a positive integer, got: ${width}`);
  }
  if (!Number.isSafeInteger(jpegByteLength) || jpegByteLength <= 0) {
    throw new Error(
      `ZINK header "jpegByteLength" must be a positive integer, got: ${jpegByteLength}`,
    );
  }
  const cut = asBit(options.cut, DEFAULT_CUT, "cut");
  const speed = asBit(options.speed, DEFAULT_SPEED, "speed");
  const mode = speed === 0 ? "vivid" : "color";
  const lpi = speed === 0 ? 317 : 264;
  const cutMode = cut === 1 ? "full" : "half";

  return [
    XML_DECLARATION,
    "<print>",
    `<mode>${mode}</mode>`,
    `<speed>${speed}</speed>`,
    `<lpi>${lpi}</lpi>`,
    "<width>0</width>",
    "<height>0</height>",
    "<dataformat>jpeg</dataformat>",
    "<autofit>1</autofit>",
    `<datasize>${jpegByteLength}</datasize>`,
    `<cutmode>${cutMode}</cutmode>`,
    "</print>",
  ].join("\n") + "\n";
}
