// Re-export shim — types live alongside the canonical client.
// Kept so the per-provider module shape (client / transform / sync /
// adapter / types / index) matches the documented contract.
export type { DviItem, DviCategory, DviResult, AutoflowConfig } from './client';
