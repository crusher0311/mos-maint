/**
 * Smoke test for the oil-sticker Service Label WYSIWYG invariant (task #708).
 *
 * Run: `npx tsx tests/sticker-label-wysiwyg.smoke.ts`
 *
 * The designer preview (StickerDesignerCanvas) and the node-canvas printer
 * (renderStickerDesigner) must resolve the Service Label text identically so
 * the preview always matches what prints. Both now call the single shared
 * `resolveStickerElementContent` with one shared fallback string. This test
 * locks in:
 *   (a) main Service Label wins over legacy element content,
 *   (b) only the global "Service Label" set,
 *   (c) neither set -> the shared fallback,
 * plus that the preview sample fallback and the renderer fallback are the SAME
 * source of truth (so a future edit to one can't silently drift the other).
 */

import {
  resolveStickerElementContent,
  SERVICE_LABEL_FALLBACK,
  STICKER_SAMPLE_DATA,
  STICKER_SIZES,
  createDefaultLayout,
  scaleLayoutToSize,
  type StickerContentValues,
} from "../lib/sticker-designer-types";

let failed = 0;

function eq(name: string, got: unknown, want: unknown) {
  if (got === want) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// The preview feeds only `serviceLabel` (the global Sticker Content field); the
// printer feeds the same plus formatted runtime values. For the label, both
// reduce to: nonblank serviceLabel or fallback. Model both call sites
// by resolving the same element with the same data.
function resolveLabel(content: string | undefined, serviceLabel: string | undefined): string {
  const data: StickerContentValues = { serviceLabel };
  return resolveStickerElementContent({ type: "serviceLabel", content }, data);
}

console.log("Service Label resolution — preview === print across the matrix");

eq("(a) main label wins over legacy content", resolveLabel("Next LOF", "Global Label"), "Global Label");
for (const content of ["Next Service Due", "Next Oil Service", "Custom override"]) {
  for (const label of [undefined, "", "   ", "\t"]) {
    eq("blank main ignores legacy content", resolveLabel(content, label), "Next Service Due");
  }
  eq("typed wording is preserved", resolveLabel(content, "  Next Oil Service  "), "  Next Oil Service  ");
}
eq("(b) only global Service Label set", resolveLabel(undefined, "Next Maintenance"), "Next Maintenance");
eq("(b) empty per-element falls through to global", resolveLabel("", "Next Maintenance"), "Next Maintenance");
eq("(c) neither set -> shared fallback", resolveLabel(undefined, undefined), SERVICE_LABEL_FALLBACK);
eq("(c) both empty -> shared fallback", resolveLabel("", ""), SERVICE_LABEL_FALLBACK);

console.log("Fallback is a single source of truth");

eq("preview sample === renderer fallback", STICKER_SAMPLE_DATA.serviceLabel, SERVICE_LABEL_FALLBACK);
eq("intended default wording", SERVICE_LABEL_FALLBACK, "Next Service Due");

console.log("Fresh layouts inherit global edits at every supported size");
for (const size of STICKER_SIZES) {
  const layout = createDefaultLayout(size.value);
  const element = layout.elements.find(el => el.type === "serviceLabel")!;
  eq(`${size.value}: no seeded override`, element.content, undefined);
  eq(`${size.value}: default wording`, resolveStickerElementContent(element, {}), "Next Service Due");
  for (const serviceLabel of ["Next Maintenance", "Next Tire Service"]) {
    eq(`${size.value}: global edit ${serviceLabel}`,
      resolveStickerElementContent(element, { serviceLabel }), serviceLabel);
  }
  // Model a persisted layout round trip, including an intentional old-default override.
  for (const content of ["Next LOF", "Next Service Due"]) {
    element.content = content;
    const saved = JSON.parse(JSON.stringify(layout));
    const resized = scaleLayoutToSize(saved, "2x3");
    const restored = resized.elements.find(el => el.type === "serviceLabel")!;
    eq(`${size.value}: legacy content is retained but cannot shadow main wording`,
      resolveStickerElementContent(restored, { serviceLabel: "Changed Global" }), "Changed Global");
    eq(`${size.value}: no stored layout migration`, restored.content, content);
  }
}

console.log("Other text fields resolve consistently (no regression)");

eq("phone passes through", resolveStickerElementContent({ type: "phone" }, { phone: "(555) 111-2222" }), "(555) 111-2222");
eq("phone empty -> empty (print semantics)", resolveStickerElementContent({ type: "phone" }, {}), "");
eq("tagline passes through", resolveStickerElementContent({ type: "tagline" }, { tagline: "Trusted Care" }), "Trusted Care");
eq("taglineLine2 passes through", resolveStickerElementContent({ type: "taglineLine2" }, { taglineLine2: "Since 1985" }), "Since 1985");
eq("serviceDate passes through", resolveStickerElementContent({ type: "serviceDate" }, { serviceDate: "Apr 15, 2026" }), "Apr 15, 2026");
eq("serviceMileage passes through", resolveStickerElementContent({ type: "serviceMileage" }, { serviceMileage: "165,000 mi" }), "165,000 mi");
eq("custom text element uses its own content", resolveStickerElementContent({ type: "text", content: "Thank you" }, {}), "Thank you");

if (failed === 0) {
  console.log("\nAll sticker-label-wysiwyg checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} sticker-label-wysiwyg check(s) failed.`);
  process.exit(1);
}
