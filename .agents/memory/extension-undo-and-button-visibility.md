---
name: Extension undo & injected-button visibility
description: How per-user button hiding and AI-write undo snapshots work in the extension; AutoFlow delete_rvh is unverified.
---

- Per-user injected-button visibility is resolved SERVER-side (features route) via pure `lib/extension-button-visibility.ts`: entitlement AND user pref; stored sparse (only `false` entries) on the users doc as `injectedButtonVisibility`. Content scripts fail OPEN when the map is absent.
- **Why:** hiding must layer under shop entitlements (never un-gate); one authoritative map avoids per-adapter drift.
- Undo snapshots for AI writes (DVI pre-fill, Enhance Notes, VHI recommendations) live in `chrome.storage.local` key `mosUndoSnapshots` (newest 20, 24h TTL), pure logic in `mos-tools-extension/undo-core.js` (UMD: content scripts via manifest, background via side-effect ESM import, tsx tests via createRequire — a plain `module.exports` file cannot be imported by the MV3 module worker any other way).
- Tekmetric reverts run in the background (PUT back the captured original task object / DELETE technician-concerns); AutoFlow reverts run in the content script through the same bridge write paths.
- **Caution:** AutoFlow `request_type: 'delete_rvh'` for removing added recommendations is UNVERIFIED against real request.php — treated as best-effort (snapshot kept on failure). v4 has no rvh write at all (`rvh_unsupported_v4`).
- AutoFlow `update_sheet` revert must OMIT `inspec_status` when the original status was empty — empty string coerces to 0 (RED).
- Repo gate: any commit touching `mos-tools-extension/` must bump manifest.json version (prebuild smoke test `extension-manifest-version-bump`), and auto-publish only fires on a version change.
