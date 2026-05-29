/**
 * ZINK XML header builder.
 *
 * Per the (unverified-against-hardware) ZINK protocol, a print job is sent
 * over the socket as an XML header string followed by the raw JPEG bytes:
 *
 *     <print><width>640</width><cut>0|1</cut><speed>0|1</speed></print>
 *
 *   - width: print-head width, always 640.
 *   - cut:   1 = full cut, 0 = kiss cut.
 *   - speed: 0 = vivid, 1 = draft.
 */

import type { ZinkPrintOptions } from "./contract";

export const DEFAULT_WIDTH = 640;
export const DEFAULT_CUT: 0 | 1 = 1;
export const DEFAULT_SPEED: 0 | 1 = 0;

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
export function buildZinkHeader(options: ZinkPrintOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`ZINK header "width" must be a positive integer, got: ${width}`);
  }
  const cut = asBit(options.cut, DEFAULT_CUT, "cut");
  const speed = asBit(options.speed, DEFAULT_SPEED, "speed");
  return `<print><width>${width}</width><cut>${cut}</cut><speed>${speed}</speed></print>`;
}
