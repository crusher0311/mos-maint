import { randomUUID } from "node:crypto";
import { z } from "zod";
import { effectiveInspectionPermission } from "../workflow-policy";
import { writeContext, currentVisit, type StaffDependencies } from "../staff/service";
import type { StaffInspection } from "../staff/model";
import { policyAllows } from "../staff/inspection-policy";
import { requireThat, idSchema } from "../../shop-dispatch/model";
import { digest } from "../../shop-dispatch/service";
import { projectReport, selectionSchema, type ReleaseBranding, type ReleaseClip } from "./model";
import type { Preview, ReleaseStorage, ReportLink } from "./store";
import { encodeLink, decodeLink, linkId, tokenHash } from "./links";
import type { StaffMediaStorage } from "../../data/repositories/workflow-inspections";

export interface ReleaseDependencies {
  staff: StaffDependencies; store: ReleaseStorage; media: StaffMediaStorage;
  branding(shopId: number): Promise<ReleaseBranding>;
  publicEntitled(shopId: number): Promise<boolean>;
  secret(): string;
  preparedClips?(shopId: number, visitId: string): Promise<ReleaseClip[]>;
  readClip?(id: string, shopId: number, visitId: string): Promise<{bytes: Buffer; mime: string}>;
}
function permissions(access: Awaited<ReturnType<StaffDependencies["access"]>>, record: Awaited<ReturnType<StaffDependencies["repository"]["read"]>>) {
  const pinned = (record?.results.staff as StaffInspection | undefined)?.policy;
  const base = access.authority.roles.some(r => ["advisor", "owner", "manager"].includes(r)) &&
    effectiveInspectionPermission(access.authority, access.shopId, "publish").allowed;
  const canPublish = base && policyAllows("publish", access.authority.roles, pinned, access.config?.policies?.[String(access.shopId)]);
  const canDeliver = base && policyAllows("deliver", access.authority.roles, pinned, access.config?.policies?.[String(access.shopId)]);
  // Revocation reduces public access; a publishing freeze must not trap links.
  // Enterprise/local/individual restrictions and real staff authority still apply.
  return {canPublish, canDeliver, canRevoke: base, canCopy: canPublish || canDeliver};
}
type ReportAction = "publish" | "deliver" | "revoke" | "copy";
async function authority(deps: ReleaseDependencies, action: ReportAction, visitId: string) {
  const access = await deps.staff.access();
  const record = await deps.staff.repository.read(access.shopId, visitId);
  const flags = permissions(access, record);
  requireThat(flags[action === "publish" ? "canPublish" : action === "deliver" ? "canDeliver" : action === "revoke" ? "canRevoke" : "canCopy"],
    action === "publish" ? "Advisor or administrator publication permission required" : "Advisor or administrator report permission required", 403);
  if (action === "publish") requireThat(access.enabled && access.config?.release?.enabledShopIds.includes(access.shopId),
    "Customer publication is disabled", 403);
  return access;
}
async function context(visitId: string, deps: ReleaseDependencies, action: "publish" | "deliver" = "publish") {
  const access = await authority(deps, action, visitId);
  const ctx = await writeContext(visitId, deps.staff, access);
  const concerns = (currentVisit(ctx.board, visitId).intake?.details.concerns ?? [])
    .map((words, index) => ({id: `concern-${index}`, words}));
  const branding = await deps.branding(access.shopId);
  const clips = access.config?.recording?.enabledShopIds.includes(access.shopId) && deps.preparedClips ?
    (await deps.preparedClips(access.shopId, visitId)).filter(c => c.identityDigest === digest(ctx.record.identity)) : [];
  return {...ctx, concerns, branding, access, clips};
}
function projection(ctx: Awaited<ReturnType<typeof context>>, selection: unknown, inspection?: StaffInspection) {
  const projected = projectReport(inspection ?? ctx.record.results.staff as StaffInspection, selection, ctx.concerns, ctx.branding, ctx.clips);
  return {...projected, selectedDigest: digest(projected.selectedEvidence),
    contextDigest: digest({identity: ctx.record.identity, concerns: projected.report.concerns, branding: ctx.branding})};
}
/** Staff-only preview of a prepared silent derivative, never raw footage. */
export async function preparedReleaseMedia(visitId: string, mediaId: string, deps: ReleaseDependencies) {
  const ctx = await context(visitId, deps);
  requireThat(ctx.clips.some(clip => clip.id === mediaId) && deps.readClip, "Prepared clip unavailable", 404);
  const file = await deps.readClip!(mediaId, ctx.access.shopId, visitId);
  const latest = await context(visitId, deps);
  requireThat(latest.access.actor === ctx.access.actor && latest.access.shopId === ctx.access.shopId &&
    latest.clips.some(clip => clip.id === mediaId), "Prepared clip unavailable", 403);
  requireThat(file.mime === "video/mp4", "Prepared clip unavailable", 404);
  return file;
}
export async function releaseSnapshot(visitId: string, deps: ReleaseDependencies) {
  const access = await deps.staff.access();
  const record = await deps.staff.repository.read(access.shopId, visitId);
  const flags = permissions(access, record);
  if (!flags.canPublish && !flags.canDeliver && !flags.canRevoke)
    return {enabled: false, ...flags, current: null, concerns: [], links: []};
  const board = await deps.staff.board.read(access.shopId), visit = currentVisit(board, visitId);
  const state = await deps.store.read(access.shopId, visitId);
  const current = state.versions.find(v => v.version === state.latest);
  const clips = access.config?.recording?.enabledShopIds.includes(access.shopId) && deps.preparedClips ?
    (await deps.preparedClips(access.shopId, visitId)).filter(c => record && c.identityDigest === digest(record.identity)) : [];
  return {enabled: !!access.config?.release?.enabledShopIds.includes(access.shopId), ...flags,
    current: current ? {version: current.version, report: current.preview.report} : null,
    concerns: (visit.intake?.details.concerns ?? []).map((words, index) => ({id: `concern-${index}`, words})),
    branding: await deps.branding(access.shopId),
    clips: clips.map(({identityDigest: _, definitionHash: __, ...clip}) => clip),
    links: state.links.map(({id, expiresAt, revokedAt}) => ({id, expiresAt, revokedAt}))};
}
export const releaseRequestSchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("preview"), visitId: idSchema, selection: selectionSchema}).strict(),
  z.object({type: z.literal("publish"), visitId: idSchema, requestId: z.string().uuid(),
    previewId: z.string().uuid(), digest: z.string().length(64), acknowledgeExcludedHazards: z.boolean()}).strict(),
  z.object({type: z.literal("link"), visitId: idSchema, requestId: z.string().uuid(),
    action: z.enum(["create", "extend", "revoke", "replace", "copy"]), linkId: z.string().max(64).optional(),
    expiresAt: z.string().datetime().optional()}).strict(),
]);
export async function releaseCommand(raw: unknown, deps: ReleaseDependencies) {
  const req = releaseRequestSchema.parse(raw);
  if (req.type === "link") return manageLink(req, deps);
  const ctx = await context(req.visitId, deps), {access} = ctx;
  let state = await deps.store.read(access.shopId, req.visitId);
  if (req.type === "preview") {
    requireThat(!state.pending, "Recover the pending publication first", 409);
    const p = projection(ctx, req.selection);
    const preview: Preview = {id: randomUUID(), shopId: access.shopId, visitId: req.visitId, actor: access.actor,
      at: deps.staff.now(), digest: "", selectedDigest: p.selectedDigest, contextDigest: p.contextDigest,
      report: p.report, selection: p.selection, excludedHazards: p.excludedHazards,
      identity: ctx.record.identity, baseVersion: state.latest};
    preview.digest = digest({...preview, digest: ""});
    await deps.store.savePreview(preview);
    return {previewId: preview.id, digest: preview.digest, report: preview.report, excludedHazards: preview.excludedHazards,
      current: state.versions.find(v => v.version === state.latest)?.preview.report ?? null};
  }
  const requestDigest = digest(req);
  const old = state.versions.find(v => v.requestId === req.requestId);
  if (old) {
    requireThat(old.actor === access.actor && old.requestDigest === requestDigest && old.preview.id === req.previewId && old.preview.digest === req.digest,
      "Publication receipt conflicts", 409);
    return {version: old.version, report: old.preview.report, link: null};
  }
  const preview = await deps.store.preview(req.previewId, access.shopId, req.visitId);
  requireThat(preview && preview.shopId === access.shopId && preview.visitId === req.visitId &&
    preview.actor === access.actor && preview.digest === req.digest, "Exact reviewed preview required", 409);
  requireThat(!preview.excludedHazards.length || req.acknowledgeExcludedHazards, "Acknowledge excluded safety findings", 409);
  requireThat(!state.pending || (state.pending.requestId === req.requestId && state.pending.digest === requestDigest &&
    state.pending.actor === access.actor), "Recover the original pending publication", 409);
  const validate = (record = ctx.record) => {
    const p = projection(ctx, preview.selection, record.results.staff as StaffInspection);
    requireThat(p.selectedDigest === preview.selectedDigest && p.contextDigest === preview.contextDigest &&
      digest(p.excludedHazards) === digest(preview.excludedHazards), "Selected content or safety exclusions changed; preview again", 409);
  };
  const authorize = async () => {
    const latest = await context(req.visitId, deps);
    requireThat(latest.access.actor === access.actor && latest.access.shopId === access.shopId &&
      digest(latest.record.identity) === digest(preview.identity) &&
      projection(latest, preview.selection).contextDigest === preview.contextDigest, "Publication context changed", 409);
  };
  if (!state.pending) {
    requireThat(state.latest === preview.baseVersion && Date.parse(deps.staff.now()) - Date.parse(preview.at) <= 15 * 60_000,
      "Preview expired or another version was published", 409);
    validate();
    state.pending = {requestId: req.requestId, actor: access.actor, digest: requestDigest, preview, at: deps.staff.now()};
    await authorize();
    requireThat(await deps.store.cas(access.shopId, req.visitId, state), "Concurrent publication; retry exact request", 409);
  }
  // CAS against the SAME staff aggregate as evidence mutations establishes
  // selected-item admission. Exact retries recover after either store lost ack.
  try {
    await deps.staff.repository.admitRelease(access.shopId, {requestId: req.requestId, actor: access.actor,
      visitId: req.visitId, digest: requestDigest, at: deps.staff.now()}, validate, authorize);
  } catch (error) {
    const evidence = await deps.staff.repository.persistence.read(access.shopId);
    if (evidence.releaseAdmissions?.some(r => r.requestId === req.requestId && r.digest === requestDigest && r.rejected)) {
      const latest = await deps.store.read(access.shopId, req.visitId);
      if (latest.pending?.requestId === req.requestId) {
        latest.pending = null;
        requireThat(await deps.store.cas(access.shopId, req.visitId, latest), "Rejected publication cleanup pending; retry exact request", 503);
      }
    }
    const rejected = evidence.releaseAdmissions?.some(r => r.requestId === req.requestId && r.rejected);
    requireThat(rejected, "Publication outcome pending; retry the exact request. Context changes may require operator reconciliation.", 503);
    throw error;
  }
  await authorize();
  state = await deps.store.read(access.shopId, req.visitId);
  const recovered = state.versions.find(v => v.requestId === req.requestId);
  if (recovered) return {version: recovered.version, report: recovered.preview.report, link: null};
  requireThat(state.pending?.requestId === req.requestId && state.pending.digest === requestDigest, "Publication receipt unresolved", 409);
  const version = state.latest + 1;
  state.versions.push({version, requestId: req.requestId, requestDigest, actor: access.actor, at: state.pending.at, preview: state.pending.preview});
  state.latest = version; state.pending = null;
  requireThat(await deps.store.cas(access.shopId, req.visitId, state), "Publication acknowledgment pending; retry exact request", 503);
  return {version, report: preview.report, link: null};
}
async function manageLink(req: Extract<z.infer<typeof releaseRequestSchema>, {type: "link"}>, deps: ReleaseDependencies) {
  const action: ReportAction = req.action === "revoke" ? "revoke" : req.action === "copy" ? "copy" : "publish";
  const access = await authority(deps, action, req.visitId);
  const state = await deps.store.read(access.shopId, req.visitId);
  requireThat(state.latest > 0, "Publish a version before creating a link", 409);
  const hash = digest(req), prior = state.receipts.find(r => r.requestId === req.requestId);
  const result = (link: ReportLink) => ({link: {id: link.id, expiresAt: link.expiresAt, revokedAt: link.revokedAt,
    ...(!link.revokedAt ? {token: encodeLink({shopId: access.shopId, visitId: req.visitId, id: link.id}, deps.secret())} : {})}});
  if (prior) {
    requireThat(prior.actor === access.actor && prior.digest === hash, "Link request conflicts", 409);
    return result(state.links.find(l => l.id === prior.linkId)!);
  }
  let link = state.links.find(l => l.id === req.linkId);
  if (req.action !== "create") requireThat(link, "Link not found", 404);
  const at = deps.staff.now();
  if (req.action === "copy") {
    requireThat(link && !link.revokedAt && Date.parse(link.expiresAt) > Date.parse(at), "Link unavailable", 409);
    const latest = await authority(deps, "copy", req.visitId);
    requireThat(latest.actor === access.actor && latest.shopId === access.shopId, "Access changed", 403);
    return result(link);
  }
  const expiresAt = req.expiresAt ?? new Date(Date.parse(at) + (access.config?.release?.defaultExpiryDays ?? 7) * 86400000).toISOString();
  if (req.action !== "revoke") requireThat(Date.parse(expiresAt) > Date.parse(at) &&
    Date.parse(expiresAt) <= Date.parse(at) + 365 * 86400000, "Choose expiry within one year", 400);
  if (req.action === "extend") {
    requireThat(link && !link.revokedAt && expiresAt > link.expiresAt, "Revoked links cannot be restored; expiry must increase", 409);
    link.expiresAt = expiresAt;
  } else if (req.action === "revoke") {
    link!.revokedAt ??= at;
  } else {
    if (req.action === "replace") link!.revokedAt ??= at;
    const id = linkId(), token = encodeLink({shopId: access.shopId, visitId: req.visitId, id}, deps.secret());
    link = {id, hash: tokenHash(token), expiresAt, revokedAt: null}; state.links.push(link);
  }
  state.receipts.push({requestId: req.requestId, actor: access.actor, digest: hash, linkId: link!.id});
  const latest = await authority(deps, action, req.visitId);
  requireThat(latest.actor === access.actor && latest.shopId === access.shopId, "Access changed", 403);
  requireThat(await deps.store.cas(access.shopId, req.visitId, state), "Link update uncertain; retry exact request", 409);
  return result(link!);
}
export const publicRequestSchema = z.object({token: z.string().min(1).max(600),
  version: z.number().int().positive().optional(), mediaId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  check: z.boolean().optional()}).strict();
export async function publicReport(raw: unknown, deps: ReleaseDependencies) {
  const req = publicRequestSchema.parse(raw), scope = decodeLink(req.token, deps.secret());
  const inspect = async () => {
    requireThat(await deps.publicEntitled(scope.shopId), "Report unavailable", 404);
    const state = await deps.store.read(scope.shopId, scope.visitId);
    const link = state.links.find(l => l.id === scope.id);
    requireThat(link && link.hash === tokenHash(req.token) && !link.revokedAt &&
      Date.parse(link.expiresAt) > Date.parse(deps.staff.now()), "Report unavailable", 404);
    const release = state.versions.find(v => v.version === (req.version ?? state.latest));
    requireThat(release, "Report unavailable", 404);
    return {state, release};
  };
  const {state, release} = await inspect();
  if (req.check) return {version: state.latest};
  if (req.mediaId) {
    const isClip = release.preview.report.findings.some(f => f.clips?.some(c => c.id === req.mediaId));
    requireThat(isClip || release.preview.report.findings.some(f => f.photoIds.includes(req.mediaId!)), "Report unavailable", 404);
    requireThat(!isClip || deps.readClip, "Report clip unavailable", 404);
    const file = isClip ? await deps.readClip!(req.mediaId, scope.shopId, scope.visitId) :
      await deps.media.read(req.mediaId, scope.shopId, scope.visitId);
    await inspect();
    return file;
  }
  await inspect();
  return {version: release.version, report: release.preview.report};
}

/** Resolve an already-published, pinned report at the provider write boundary.
 * Never create a link, publish evidence or guess an origin as a side effect. */
export async function publishedInspectionDelivery(visitId: string, reference: {version: number; linkId: string},
  selected: {sheet: string; item: string}[], deps: ReleaseDependencies) {
  const ctx = await context(visitId, deps, "deliver");
  const origin = ctx.access.config?.release?.publicReportOrigin;
  requireThat(origin && new URL(origin).protocol === "https:" && new URL(origin).origin === origin,
    "An approved customer-report origin must be configured before provider delivery", 409);
  const state = await deps.store.read(ctx.access.shopId, visitId);
  const release = state.versions.find(v => v.version === reference.version);
  const link = state.links.find(l => l.id === reference.linkId);
  requireThat(release && link && !link.revokedAt && Date.parse(link.expiresAt) > Date.parse(deps.staff.now()),
    "Choose an active link to a published report version", 409);
  const key = (s: {sheet: string; item: string}) => JSON.stringify([s.sheet, s.item]);
  requireThat(digest(selected.map(key).sort()) === digest(release.preview.selection.findings.map(key).sort()),
    "Provider delivery must match exactly the published report findings", 409);
  const current = projection(ctx, release.preview.selection);
  requireThat(current.selectedDigest === release.preview.selectedDigest &&
    current.contextDigest === release.preview.contextDigest, "Published evidence changed; publish a reviewed version before delivery", 409);
  requireThat(await deps.publicEntitled(ctx.access.shopId), "Customer report access is unavailable", 403);
  const token = encodeLink({shopId: ctx.access.shopId, visitId, id: link.id}, deps.secret());
  requireThat(tokenHash(token) === link.hash, "Published link could not be verified", 409);
  const url = new URL("/workflow-report", origin);
  url.searchParams.set("version", String(release.version)); url.hash = encodeURIComponent(token);
  return {version: release.version, linkId: link.id, url: url.toString(),
    reportDigest: digest(release.preview.report), expiresAt: link.expiresAt,
    destination: "inspection-line-notes" as const, clickability: "unverified" as const};
}
