"use client";
import { useState } from "react";
import { brandSchema, DEFAULT_BRAND, type Brand } from "@/lib/shop-dispatch/model";
import type { DispatchSnapshot } from "@/lib/shop-dispatch/client";
import { CommandForm } from "./CommandForm";
import { brandSourceLabel, contrast, manualBrandDraft, resolvedBranding } from "./helpers";
import type { WorkProps } from "./JobCard";
import { prepareLogo } from "./logo-upload";
import styles from "./pilot.module.css";

function BrandEditor({ initial, fallback, revision, title, canEdit, busy, save, inherited, testId, location = false }: {
  initial: Brand; fallback: Brand; title: string; canEdit: boolean; busy: boolean;
  revision: number; save: (brand: Brand | null, expectedRevision?: number) => Promise<boolean>; inherited: string; testId: string; location?: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const [baseRevision, setBaseRevision] = useState(revision);
  const [fileError, setFileError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  async function upload(file?: File) {
    if (!file || !canEdit || busy || uploading) return;
    setFileError(""); setUploadProgress("");
    setUploading(true);
    try {
      const result = await prepareLogo(file, setUploadProgress);
      setDraft(old => ({ ...old, logo: result.dataUrl }));
      setUploadProgress(`Logo ready · ${result.width} × ${result.height} pixels · ${(result.bytes / 1024).toFixed(1)} KB. Preview updated; save branding to persist.`);
    } catch (error) { setUploadProgress(""); setFileError(`${error instanceof Error ? error.message : "Invalid image."} Your previous draft logo is unchanged.`); }
    finally { setUploading(false); }
  }
  return <section className={styles.panel}><h2>{title}</h2><p><small>{inherited}</small></p>
    <div className={styles.row} style={{ background: draft.primary, color: contrast(draft.primary), padding: 16, borderRadius: 8 }}>
      <div className={styles.identity}>{draft.logo && <img className={styles.logo} src={draft.logo} alt="Draft logo preview" />}<strong>{draft.name}</strong></div>
      <span className={styles.chip} style={{ background: draft.accent, color: contrast(draft.accent) }}>Accent preview</span>
    </div>
    {canEdit ? <>
      <CommandForm testId={testId} revision={revision} pinnedRevision={baseRevision} onPinRevision={setBaseRevision}
        onReload={() => { setDraft(initial); setFileError(""); setUploadProgress(""); }} busy={busy || uploading} label="Save branding" submit={async (_data, expectedRevision) => {
        const parsed = brandSchema.safeParse(draft);
        if (!parsed.success) throw new Error("Use a name up to 60 characters and six-digit hex colors.");
        return save(parsed.data, expectedRevision);
      }}>
        <label>Display name<input required maxLength={60} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <div className={styles.fields}>
          <label>Primary · hex<input pattern="#[0-9a-fA-F]{6}" required value={draft.primary} onChange={e => setDraft({ ...draft, primary: e.target.value })} /></label>
          <label>Accent · hex<input pattern="#[0-9a-fA-F]{6}" required value={draft.accent} onChange={e => setDraft({ ...draft, accent: e.target.value })} /></label>
        </div>
        <label>Local raster logo · PNG, JPEG or WebP up to 10 MB<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void upload(file);
        }} /></label>
        <small>Images are resized locally to fit the saved logo limit of 120 KB. Transparent PNG and WebP backgrounds are preserved. SVGs and external URLs are not allowed.</small>
        {uploadProgress && <p role="status" aria-live="polite" aria-busy={uploading}>{uploadProgress}</p>}
        {fileError && <p role="alert" className={styles.warning}>{fileError}</p>}
        <button type="button" disabled={!draft.logo} onClick={() => { setDraft({ ...draft, logo: null }); setUploadProgress(""); }}>Remove logo from draft</button>
        <small>Changes above are a preview until saved. Text contrast is calculated automatically. Save to persist a removed logo. {location && "Shared logos are not copied into this editor. A location override saves only a logo uploaded here (or its existing manual logo); without one it saves no logo."}</small>
      </CommandForm>
      <button style={{ marginTop: 14 }} disabled={busy || uploading} onClick={async () => {
        if (window.confirm(location ? "Remove this location override and restore automatic shop branding? This change is persisted on the server." : "Remove this brand override and restore inheritance? This change is persisted on the server.")) {
          if (await save(null, baseRevision)) {
            setDraft(fallback);
            setBaseRevision(baseRevision + 1);
          }
        }
      }}>{location ? "Restore automatic shop branding" : "Revert to inheritance"}</button>
    </> : <p><small>You do not have permission to edit this brand.</small></p>}
  </section>;
}
export function BrandSettings({ snapshot, saveEnterpriseBrand, ...work }: WorkProps & { snapshot: DispatchSnapshot; saveEnterpriseBrand: (brand: Brand | null, expectedRevision?: number) => Promise<boolean> }) {
  const branding = resolvedBranding(snapshot);
  const effective = work.board.locationBrand ?? manualBrandDraft(branding.brand);
  return <><div className={styles.brandingInfo}>
    <strong>Current source: {brandSourceLabel(branding.source)}</strong>
    <p>A location override replaces the entire brand. Without an override, each saved shop field and color takes precedence over enterprise branding, then Detect Dog defaults. Shared colors are resolved by the server: {branding.palette === "derived" ? "derived palette" : "fallback palette"}.</p>
    <p>Manage shared shop branding in dashboard settings. This editor saves a separate manual location override; drafts remain intact on failed saves. Restoring automatic branding removes that override and follows shared shop settings again.</p>
    <a className={styles.brandingLink} href="/dashboard/settings/branding">Open shared branding settings</a>
  </div>
    <div className={styles.grid}>
      <BrandEditor location initial={effective} fallback={manualBrandDraft(branding.inherited)} revision={work.board.revision} title={`Location ${snapshot.shopId}`} canEdit={work.actor.manager} busy={work.busy} save={(brand, expectedRevision) => work.mutate({ type: "brand", brand }, expectedRevision)} testId="location-brand-form"
        inherited={work.board.locationBrand ? "This location has a full manual override, including its saved logo." : `Following ${brandSourceLabel(branding.source).toLowerCase()}. The draft starts with resolved name and colors, but no shared logo.`} />
      {snapshot.enterprise ? <BrandEditor key={snapshot.enterprise.id} initial={snapshot.enterprise.brand ?? DEFAULT_BRAND} fallback={DEFAULT_BRAND} revision={snapshot.enterprise.revision} title={snapshot.enterprise.name} canEdit={snapshot.enterprise.canEdit} busy={work.busy} save={saveEnterpriseBrand} testId="enterprise-brand-form"
        inherited="Enterprise permissions come from the server. Without a location override, enterprise fields fill gaps in shared shop settings; reverting restores Detect Dog defaults for those gaps." /> : <section className={styles.panel}><h2>No enterprise context</h2><p><small>There is no enterprise brand available for this signed-in location. Shared shop fields still take precedence over Detect Dog defaults.</small></p></section>}
    </div>
  </>;
}
