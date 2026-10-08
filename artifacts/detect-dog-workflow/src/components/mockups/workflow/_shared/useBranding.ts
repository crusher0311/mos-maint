import { useEffect, useRef, useState } from 'react';
import { BRANDING_STORAGE_KEY, createDefaultBranding, decodeRasterLogo, parseStoredBranding, validateBranding, type BrandingConfig } from './branding';

function loadBranding() {
  let raw: string | null;
  try { raw = window.localStorage.getItem(BRANDING_STORAGE_KEY); }
  catch {
    return { config: createDefaultBranding(), error: 'Browser storage is unavailable. Proposed defaults are shown; enable local storage to save branding.' };
  }
  try {
    return { config: parseStoredBranding(raw), error: '' };
  } catch (error) {
    return { config: createDefaultBranding(), error: error instanceof Error ? error.message : 'Browser storage is unavailable. Branding has not been restored.' };
  }
}

export function useBranding() {
  const [initial] = useState(loadBranding);
  const [branding, setBranding] = useState(initial.config);
  const [storageError, setStorageError] = useState(initial.error);
  const revision = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const initialRevision = revision.current;
    const logos = [initial.config.enterprise.logo, ...Object.values(initial.config.locations).map(l => l.logo)].filter((logo): logo is string => !!logo);
    Promise.all(logos.map(decodeRasterLogo)).catch(() => {
      if (!cancelled && revision.current === initialRevision) {
        setBranding(createDefaultBranding());
        setStorageError('A saved logo cannot be decoded. Proposed defaults are shown. Reset branding or apply a valid configuration.');
      }
    });
    return () => { cancelled = true; };
  }, [initial]);

  const applyBranding = (next: BrandingConfig): boolean => {
    if (!validateBranding(next)) {
      setStorageError('Branding was not applied. Names must be 1–60 characters, colors must be six-digit hex values, and logos must be valid embedded raster images.');
      return false;
    }
    try {
      const clean = parseStoredBranding(JSON.stringify(next));
      window.localStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify(clean));
      revision.current++;
      setBranding(clean);
      setStorageError('');
      return true;
    } catch {
      setStorageError('Branding was not saved or applied. Browser storage may be blocked or full. Remove the logo or enable local storage, then try again. Your draft is still here.');
      return false;
    }
  };
  return { branding, applyBranding, storageError };
}
