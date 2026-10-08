import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Dog, Paintbrush, RotateCcw } from 'lucide-react';
import { Dialog } from './_shared/Dialog';
import { LOCATION_IDS, LOCATION_LABELS, brandingTheme, contrastForeground, createDefaultBranding, isHexColor, readRasterLogo, resolveBranding, validateBranding, type BrandingConfig, type BrandStyle, type LocationId } from './_shared/branding';

type BrandSettingsProps = {
  branding: BrandingConfig;
  applyBranding: (config: BrandingConfig) => boolean;
  storageError: string;
};

export function BrandSettings({ branding, applyBranding, storageError }: BrandSettingsProps) {
  const [draft, setDraft] = useState<BrandingConfig>(() => structuredClone(branding));
  const [scope, setScope] = useState<'enterprise' | 'location'>('enterprise');
  const [resetOpen, setResetOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const uploadRequest = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setDraft(structuredClone(branding));
    uploadRequest.current++;
    setUploading(false);
    setUploadError('');
    return () => { uploadRequest.current++; };
  }, [branding]);
  const location = draft.activeLocation;
  const target = scope === 'enterprise' ? draft.enterprise : draft.locations[location];
  const inheriting = scope === 'location' && draft.locations[location].inherit;
  const effective = resolveBranding(draft);
  const visibleStyle = inheriting ? draft.enterprise : target;
  const dirty = JSON.stringify(draft) !== JSON.stringify(branding);
  const valid = validateBranding(draft);
  const safeDraft = {
    ...draft,
    enterprise: { ...draft.enterprise, primary: isHexColor(draft.enterprise.primary) ? draft.enterprise.primary : branding.enterprise.primary, accent: isHexColor(draft.enterprise.accent) ? draft.enterprise.accent : branding.enterprise.accent },
    locations: Object.fromEntries(LOCATION_IDS.map(id => [id, { ...draft.locations[id], primary: isHexColor(draft.locations[id].primary) ? draft.locations[id].primary : branding.locations[id].primary, accent: isHexColor(draft.locations[id].accent) ? draft.locations[id].accent : branding.locations[id].accent }])) as BrandingConfig['locations'],
  };
  const preview = resolveBranding(safeDraft);
  const updateTarget = (patch: Partial<BrandStyle & { name: string }>) => {
    setMessage('');
    setDraft(previous => scope === 'enterprise' ? { ...previous, enterprise: { ...previous.enterprise, ...patch } } :
      { ...previous, locations: { ...previous.locations, [location]: { ...previous.locations[location], ...patch } } });
  };
  const clearUpload = () => { uploadRequest.current++; setUploading(false); setUploadError(''); if (fileInput.current) fileInput.current.value = ''; };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || uploading) { setMessage('Check the name and six-digit hex colors before applying.'); return; }
    if (applyBranding(draft)) {
      // Match the trimmed, canonical saved names.
      setDraft(previous => ({
        ...previous, enterprise: { ...previous.enterprise, name: previous.enterprise.name.trim() },
        locations: Object.fromEntries(LOCATION_IDS.map(id => [id, { ...previous.locations[id], name: previous.locations[id].name.trim() }])) as BrandingConfig['locations'],
      }));
      setMessage('Branding applied and saved in this browser. Workflow data was not changed.');
    }
  };
  return <section className="page" data-testid="branding-view">
    <div className="page-heading"><div><div className="eyebrow muted">Enterprise identity / local expression</div><h1>Your shop. Your workspace.</h1><p className="muted">Proposed presentation theme—not official Burnett branding. No official visual assets were supplied.</p></div><Paintbrush className="icon"/></div>
    <div className="section-heading"><span className="save-status" data-testid="branding-status" aria-live="polite">{dirty ? 'Draft changes · not applied' : 'Applied configuration · no draft changes'}</span><span className="muted" style={{fontSize:12}}>Only branding is stored locally. No shop or technician data is persisted.</span></div>
    {storageError && <p className="form-error" role="alert" data-testid="branding-storage-error">{storageError}</p>}
    <div className="editor-grid">
      <form className="settings-panel" onSubmit={submit} data-testid="branding-form">
        <h2>Brand controls</h2>
        <div className="form-pair"><div className="field"><label htmlFor="brand-scope">Editing scope</label><select id="brand-scope" data-testid="brand-scope" value={scope} onChange={event => { clearUpload(); setScope(event.target.value as typeof scope); setMessage(''); }}><option value="enterprise">Enterprise defaults</option><option value="location">Location identity</option></select></div>
          <div className="field"><label htmlFor="brand-location">Presentation location</label><select id="brand-location" data-testid="brand-location" value={location} onChange={event => { clearUpload(); setDraft(previous => ({ ...previous, activeLocation: event.target.value as LocationId })); setMessage(''); }}>{LOCATION_IDS.map(id => <option value={id} key={id}>{LOCATION_LABELS[id]}</option>)}</select></div></div>
        <p className="muted" style={{fontSize:12}}>Switching location is presentation scope only: the same simulated schedule is shown. Apply to update the active workspace.</p>
        <div className="field"><label htmlFor="brand-name">{scope === 'enterprise' ? 'Enterprise display name' : 'Location display name'}</label><input id="brand-name" data-testid="brand-name" value={target.name} maxLength={60} required onChange={event => updateTarget({ name: event.target.value })}/><small className="muted">{target.name.length}/60 characters</small></div>
        {scope === 'location' && <div className="field"><label className="checkbox-label" htmlFor="brand-inherit"><input id="brand-inherit" data-testid="brand-inherit" type="checkbox" checked={inheriting} onChange={event => {
          clearUpload();
          const inherit = event.target.checked;
          setDraft(previous => ({ ...previous, locations: { ...previous.locations, [location]: { ...previous.locations[location], inherit } } }));
          setMessage('');
        }}/>Inherit enterprise colors and logo</label><p className="muted" style={{fontSize:12}}>{inheriting ? 'Enterprise edits automatically propagate here. Turn off inheritance to edit an isolated local theme.' : 'This location owns its colors and logo. Enterprise edits will not change this override. Turn on inheritance to return to enterprise style.'}</p></div>}
        <fieldset disabled={inheriting}><legend className="sr-only">Colors and local raster logo</legend>
          <div className="form-pair">{(['primary', 'accent'] as const).map(key => <div className="field" key={key}><label htmlFor={`brand-${key}`}>{key === 'primary' ? 'Primary color' : 'Accent color'} <span className="color-swatch" style={{background:isHexColor(visibleStyle[key]) ? visibleStyle[key] : 'transparent'}}/></label><input id={`brand-${key}`} data-testid={`brand-${key}`} value={visibleStyle[key]} pattern="#[0-9A-Fa-f]{6}" maxLength={7} required spellCheck={false} onChange={event => updateTarget({ [key]: event.target.value })} aria-describedby={`brand-${key}-help`}/><small className="muted" id={`brand-${key}-help`}>Six-digit hex, e.g. #285746{!isHexColor(visibleStyle[key]) ? ' · invalid color' : ''}</small></div>)}</div>
          <div className="field"><label htmlFor="brand-logo">{scope === 'enterprise' ? 'Enterprise logo' : 'Location logo'}</label><input ref={fileInput} id="brand-logo" data-testid="brand-logo" type="file" accept="image/png,image/jpeg,image/webp" aria-describedby="brand-logo-help" disabled={uploading || inheriting} onChange={async event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            const request = ++uploadRequest.current;
            setUploading(true); setUploadError(''); setMessage('');
            try {
              const logo = await readRasterLogo(file);
              if (request === uploadRequest.current) updateTarget({ logo });
            } catch (error) {
              if (request === uploadRequest.current) setUploadError(error instanceof Error ? error.message : 'Could not read logo. Try another raster image.');
            } finally { if (request === uploadRequest.current) setUploading(false); }
          }}/><small id="brand-logo-help" className="muted">Local PNG, JPEG, or WebP only · maximum 256 KB · no URLs or SVG. The image stays in this browser.</small>
          {uploading && <div className="logo-skeleton" role="status">Checking local image…</div>}
          {uploadError && <p className="form-error" role="alert" data-testid="brand-logo-error">{uploadError}</p>}
          {visibleStyle.logo && <div className="actions"><img className="brand-logo" src={visibleStyle.logo} alt="Current draft logo"/><button type="button" className="btn" disabled={uploading} data-testid="remove-brand-logo" onClick={() => { clearUpload(); updateTarget({ logo: null }); }}>Remove logo</button></div>}
          </div>
        </fieldset>
        <div className="form-pair"><div className="field"><label htmlFor="brand-typography">Workspace typography</label><select id="brand-typography" data-testid="brand-typography" value={draft.typography} onChange={event => { setMessage(''); setDraft(previous => ({ ...previous, typography: event.target.value as BrandingConfig['typography'] })); }}><option value="sans">System sans</option><option value="serif">System serif</option></select></div>
          <div className="field"><label htmlFor="brand-density">Workspace density</label><select id="brand-density" data-testid="brand-density" value={draft.density} onChange={event => { setMessage(''); setDraft(previous => ({ ...previous, density: event.target.value as BrandingConfig['density'] })); }}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></div></div>
        <p className="muted" style={{fontSize:12}}>Typography and density are enterprise-wide. Both density options keep controls at least 44px. Warning and blocked colors stay semantic, not branded.</p>
        <div className="actions"><button type="submit" className="btn primary" data-testid="apply-branding" disabled={!valid || uploading}>Apply branding</button><button type="button" className="btn" disabled={!dirty || uploading} data-testid="discard-branding" onClick={() => { clearUpload(); setDraft(structuredClone(branding)); setMessage('Draft discarded. Applied branding is unchanged.'); }}>Discard draft</button><button type="button" className="btn quiet" data-testid="reset-branding" onClick={() => setResetOpen(true)}><RotateCcw className="icon"/>Reset branding</button></div>
        {message && <p role="status" className="prediction-note">{message}</p>}
      </form>
      <aside className="preview-panel" style={brandingTheme(safeDraft)} aria-label="Live draft preview"><div className="eyebrow muted">Live preview / draft only</div><div className="preview-header" style={{background:preview.primary,color:contrastForeground(preview.primary)}}>{preview.logo ? <img className="brand-logo" src={preview.logo} alt="Draft workspace logo"/> : <Dog className="icon"/>}<div><strong>{draft.enterprise.name || 'Enterprise name'}</strong><small>Powered by Detect Dog</small></div></div><h2>{effective.locationName || 'Location name'}</h2><p className="muted">{LOCATION_LABELS[location]}</p>
        <div className="preview-sample" style={{background:preview.accent,color:contrastForeground(preview.accent)}}>Brand accent · automatically contrasted text</div>
        <div className="preview-work-row"><span className="tag active">Active work</span><span className="tag blocked">Blocked</span><span className="tag risk">Promise risk</span></div>
        <p className="prediction-note">Apply changes to update navigation and the simulated schedule. The preview does not change workflow state.</p>
        <ul className="scope-list">{LOCATION_IDS.map(id => { const resolved = resolveBranding(safeDraft, id); return <li key={id}><strong>{draft.locations[id].name || LOCATION_LABELS[id]}</strong><span>{draft.locations[id].inherit ? 'Inherits enterprise style' : 'Isolated local override'}</span><span><i className="color-swatch" style={{background:resolved.primary}}/> {resolved.primary} <i className="color-swatch" style={{background:resolved.accent}}/> {resolved.accent}</span></li>; })}</ul>
        <p className="muted" style={{fontSize:12}}>Change enterprise colors to see inheritance here. Local overrides stay untouched. Proposed palette only; this is not an official brand guide.</p>
      </aside>
    </div>
    {resetOpen && <Dialog compact title="Reset branding?" subtitle="Branding only · workflow unchanged" onClose={() => setResetOpen(false)}><p>Replace enterprise and both location styles, logos, typography, density, and presentation location with the proposed defaults?</p><p className="muted">The applied branding and current draft will be replaced. Simulated assignments and timers are not reset.</p><div className="actions"><button className="btn" onClick={() => setResetOpen(false)}>Cancel</button><button className="btn primary" data-testid="confirm-reset-branding" onClick={() => { const defaults = createDefaultBranding(); if (applyBranding(defaults)) { clearUpload(); setDraft(defaults); setMessage('Branding reset and saved. Workflow unchanged.'); setResetOpen(false); } }}>Reset branding</button></div>{storageError && <p role="alert" className="form-error">{storageError}</p>}</Dialog>}
  </section>;
}
