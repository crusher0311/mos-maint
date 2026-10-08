"use client";
import { useState } from "react";
import { brandSchema, DEFAULT_BRAND, type Brand } from "@/lib/shop-dispatch/model";
import type { DispatchSnapshot } from "@/lib/shop-dispatch/client";
import { CommandForm } from "./CommandForm";
import { contrast } from "./helpers";
import type { WorkProps } from "./JobCard";
import styles from "./pilot.module.css";

function BrandEditor({ initial, fallback, revision, title, canEdit, busy, save, inherited, testId }: {
  initial: Brand; fallback: Brand; title: string; canEdit: boolean; busy: boolean;
  revision: number; save: (brand: Brand | null, expectedRevision?: number) => Promise<boolean>; inherited: string; testId: string;
}) {
  const [draft, setDraft] = useState(initial);
  const [baseRevision, setBaseRevision] = useState(revision);
  const [fileError, setFileError] = useState("");
  const [uploading, setUploading] = useState(false);
  async function upload(file?: File) {
    setFileError("");
    if (!file) return;
    if (file.size > 120 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setFileError("Choose a PNG, JPEG or WebP up to 120 KB. SVGs and external URLs are not allowed."); return;
    }
    setUploading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isPng = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10;
      const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const isWebp = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
      if (!(file.type === "image/png" && isPng || file.type === "image/jpeg" && isJpeg || file.type === "image/webp" && isWebp)) throw new Error("The image content does not match its raster file type.");
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Could not read the logo.")); reader.readAsDataURL(file);
      });
      const decoded = new Image(); decoded.src = data;
      await decoded.decode();
      setDraft(old => ({ ...old, logo: data }));
    } catch (error) { setFileError(error instanceof Error ? error.message : "Invalid image."); }
    finally { setUploading(false); }
  }
  return <section className={styles.panel}><h2>{title}</h2><p><small>{inherited}</small></p>
    <div className={styles.row} style={{ background: draft.primary, color: contrast(draft.primary), padding: 16, borderRadius: 8 }}>
      <div className={styles.identity}>{draft.logo && <img className={styles.logo} src={draft.logo} alt="" />}<strong>{draft.name}</strong></div>
      <span className={styles.chip} style={{ background: draft.accent, color: contrast(draft.accent) }}>Accent preview</span>
    </div>
    {canEdit ? <>
      <CommandForm testId={testId} revision={revision} pinnedRevision={baseRevision} onPinRevision={setBaseRevision}
        onReload={() => { setDraft(initial); setFileError(""); }} busy={busy || uploading} label="Save branding" submit={async (_data, expectedRevision) => {
        const parsed = brandSchema.safeParse(draft);
        if (!parsed.success) throw new Error("Use a name up to 60 characters and six-digit hex colors.");
        return save(parsed.data, expectedRevision);
      }}>
        <label>Display name<input required maxLength={60} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <div className={styles.fields}>
          <label>Primary · hex<input pattern="#[0-9a-fA-F]{6}" required value={draft.primary} onChange={e => setDraft({ ...draft, primary: e.target.value })} /></label>
          <label>Accent · hex<input pattern="#[0-9a-fA-F]{6}" required value={draft.accent} onChange={e => setDraft({ ...draft, accent: e.target.value })} /></label>
        </div>
        <label>Local raster logo · up to 120 KB<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => void upload(e.target.files?.[0])} /></label>
        {fileError && <p role="alert" className={styles.warning}>{fileError}</p>}
        <button type="button" disabled={!draft.logo} onClick={() => setDraft({ ...draft, logo: null })}>Remove logo from draft</button>
        <small>Changes above are a preview until saved. Text contrast is calculated automatically. Save to persist a removed logo.</small>
      </CommandForm>
      <button style={{ marginTop: 14 }} disabled={busy || uploading} onClick={async () => {
        if (window.confirm("Remove this brand override and restore inheritance? This change is persisted on the server.")) {
          if (await save(null, baseRevision)) {
            setDraft(fallback);
            setBaseRevision(baseRevision + 1);
          }
        }
      }}>Revert to inheritance</button>
    </> : <p><small>You do not have permission to edit this brand.</small></p>}
  </section>;
}
export function BrandSettings({ snapshot, saveEnterpriseBrand, ...work }: WorkProps & { snapshot: DispatchSnapshot; saveEnterpriseBrand: (brand: Brand | null, expectedRevision?: number) => Promise<boolean> }) {
  const effective = work.board.locationBrand ?? snapshot.enterprise?.brand ?? DEFAULT_BRAND;
  return <><div className={styles.notice}>Pilot branding is persisted through the server API. It does not change the existing mockup. Location override wins; otherwise enterprise branding, then Detect Dog defaults. Drafts remain intact on failed saves.</div>
    <div className={styles.grid}>
      <BrandEditor initial={effective} fallback={snapshot.enterprise?.brand ?? DEFAULT_BRAND} revision={work.board.revision} title={`Location ${snapshot.shopId}`} canEdit={work.actor.manager} busy={work.busy} save={(brand, expectedRevision) => work.mutate({ type: "brand", brand }, expectedRevision)} testId="location-brand-form"
        inherited={work.board.locationBrand ? "This location has its own override." : `Inheriting ${snapshot.enterprise?.brand ? "enterprise branding" : "Detect Dog defaults"}.`} />
      {snapshot.enterprise ? <BrandEditor key={snapshot.enterprise.id} initial={snapshot.enterprise.brand ?? DEFAULT_BRAND} fallback={DEFAULT_BRAND} revision={snapshot.enterprise.revision} title={snapshot.enterprise.name} canEdit={snapshot.enterprise.canEdit} busy={work.busy} save={saveEnterpriseBrand} testId="enterprise-brand-form"
        inherited="Enterprise permissions come from the server. Locations without an override inherit this brand; reverting restores Detect Dog defaults." /> : <section className={styles.panel}><h2>No enterprise context</h2><p><small>There is no enterprise brand available for this signed-in location.</small></p></section>}
    </div>
  </>;
}
