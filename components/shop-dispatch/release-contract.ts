import { z } from "zod";

// Client-only contract validation. Do not import runtime staff/server models.
const words = z.string().max(2000);
export const releaseBranding = z.object({
  name: z.string().min(1).max(120), phone: z.string().max(40),
  primary: z.string().regex(/^#[a-f0-9]{6}$/i),
  logo: z.string().max(180000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).nullable(),
});
export const customerReport = z.object({
  schemaVersion: z.literal(1), kind: z.literal("findings-only"),
  branding: releaseBranding,
  progress: z.enum(["inspection-in-progress", "selected-findings"]),
  concerns: z.array(z.object({ id: z.string(), words })).max(200),
  findings: z.array(z.object({
    key: z.string(), title: z.string(), procedure: z.string(), position: z.string().nullable(),
    rating: z.enum(["green", "yellow", "red"]), customerText: words, nextStep: words,
    measurements: z.array(z.object({ label: z.string(), value: z.union([z.string(), z.number().finite()]), unit: z.string().nullable() })),
    photoIds: z.array(z.string()).max(6), concernIds: z.array(z.string()).max(20),
  })).max(120),
});
const selection = z.object({
  findings: z.array(z.object({
    sheet: z.string().min(1).max(80), item: z.string().min(1).max(80),
    includeInactive: z.boolean(), customerText: words.refine(value => value.trim().length > 0), nextStep: words,
    photoIds: z.array(z.string().regex(/^[a-f0-9]{24}$/)).max(6),
    concernIds: z.array(z.string().max(100)).max(20),
  }).strict()).min(1).max(120),
  acknowledgeExcludedHazards: z.boolean(),
}).strict();
const requestBase = { visitId: z.string().min(1) };
export const pendingRelease = z.discriminatedUnion("type", [
  z.object({ ...requestBase, type: z.literal("preview"), selection }).strict(),
  z.object({ ...requestBase, type: z.literal("publish"), requestId: z.string().uuid(), previewId: z.string().min(1), digest: z.string().min(1), acknowledgeExcludedHazards: z.boolean() }).strict(),
  z.object({ ...requestBase, type: z.literal("link"), requestId: z.string().uuid(), action: z.enum(["create", "extend", "revoke", "replace", "copy"]), linkId: z.string().optional(), expiresAt: z.string().optional() }).strict(),
]);
