/**
 * Deterministic first-shop acceptance image for the ZINK print bridge.
 *
 * This is intentionally generated in the cloud and queued like any other job:
 * the cloud never connects to the printer LAN. The fixed content makes it easy
 * for an operator to confirm orientation, color/contrast, cut mode, and speed
 * without depending on customer or repair-order data.
 */

import type { ZinkPrintOptions } from "./types";

export const PILOT_TEST_IMAGE_WIDTH = 640;
export const PILOT_TEST_IMAGE_HEIGHT = 800;

export function renderPilotTestJpeg(options: ZinkPrintOptions): Buffer {
  const { createCanvas } = require("canvas");
  const canvas = createCanvas(PILOT_TEST_IMAGE_WIDTH, PILOT_TEST_IMAGE_HEIGHT);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 12;
  ctx.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);

  ctx.fillStyle = "#111827";
  ctx.font = "bold 46px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("MOS ZINK PILOT TEST", canvas.width / 2, 82);

  ctx.font = "28px sans-serif";
  ctx.fillText("Cloud queue → local agent → printer", canvas.width / 2, 130);

  const bars = ["#000000", "#4b5563", "#9ca3af", "#d1d5db", "#ffffff"];
  const barWidth = 112;
  bars.forEach((color, index) => {
    const x = 40 + index * barWidth;
    ctx.fillStyle = color;
    ctx.fillRect(x, 185, barWidth, 150);
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, 185, barWidth, 150);
  });

  ctx.fillStyle = "#111827";
  ctx.font = "bold 34px sans-serif";
  ctx.fillText(
    `CUT: ${options.cut === 0 ? "HALF" : "FULL"}`,
    canvas.width / 2,
    420,
  );
  ctx.fillText(
    `MODE: ${options.speed === 1 ? "NORMAL" : "VIVID"}`,
    canvas.width / 2,
    470,
  );

  ctx.font = "28px sans-serif";
  ctx.fillText("Verify:", canvas.width / 2, 550);
  ctx.font = "25px sans-serif";
  ctx.fillText("1. Border is complete and centered", canvas.width / 2, 600);
  ctx.fillText("2. Five tone bars are distinguishable", canvas.width / 2, 642);
  ctx.fillText("3. Cut and mode match this label", canvas.width / 2, 684);

  ctx.font = "bold 25px monospace";
  ctx.fillText("TEST PATTERN v1", canvas.width / 2, 748);

  return canvas.toBuffer("image/jpeg", { quality: 0.95 });
}