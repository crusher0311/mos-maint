/**
 * Static extension wiring contract for provider-session bootstrap.
 *
 * Run: npx tsx tests/extension-auto-bootstrap.smoke.ts
 */
import fs from "node:fs";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

const background = fs.readFileSync("mos-tools-extension/background.js", "utf8");
const panel = fs.readFileSync("mos-tools-extension/sidepanel.js", "utf8");
const interceptor = fs.readFileSync("mos-tools-extension/adapters/interceptor.js", "utf8");
const tekmetricContent = fs.readFileSync("mos-tools-extension/adapters/tekmetric-content.js", "utf8");
const recoveryCore = fs.readFileSync("mos-tools-extension/tekmetric-session-recovery-core.js", "utf8");
const html = fs.readFileSync("mos-tools-extension/sidepanel.html", "utf8");
const manifest = JSON.parse(fs.readFileSync("mos-tools-extension/manifest.json", "utf8"));

console.log("extension automatic bootstrap wiring");
// Minimum-version compare, not equality — a hardcoded pin fails every future
// bump and silently blocks deploys (see smoke-version-pin-blocks-deploys).
const versionAtLeast = (v: string, min: string) => {
  const a = v.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return true;
};
ok("manifest version was bumped", versionAtLeast(manifest.version, "1.33.4"));
ok("context updates trigger automatic bootstrap", /SET_SMS_CONTEXT[\s\S]+handleMosBootstrap/.test(background));
ok("provider token capture retries bootstrap", /tabTokenChanged[\s\S]+handleMosBootstrap/.test(background));
ok("bootstrap auth is session-scoped", /chrome\.storage\.session\.set\(\{\s*mosBootstrapAuth/.test(background));
ok("provider proof is not persisted", !/storage\.(?:local|session)\.set\(\{\s*tekmetricToken/.test(background));
ok(
  "same-tab Tekmetric proof recovery remains non-persistent",
  !/storage\.(?:local|session)\.set[\s\S]{0,120}latestTekmetricProof/.test(background + interceptor + tekmetricContent),
);
ok(
  "worker proof loss requests recovery from the originating tab",
  /recoverTekmetricSessionForTab[\s\S]+chrome\.tabs\.sendMessage\(tabId,[\s\S]+REQUEST_SAME_TAB_TEKMETRIC_ACTIVITY/.test(background) &&
    /REQUEST_SAME_TAB_TEKMETRIC_ACTIVITY[\s\S]+MOS_REQUEST_TEKMETRIC_ACTIVITY/.test(tekmetricContent),
);
ok(
  "MAIN-world recovery emits an authenticated read without exposing the proof",
  /var latestTekmetricProof = null[\s\S]+MOS_REQUEST_TEKMETRIC_ACTIVITY[\s\S]+origFetch\.call/.test(interceptor) &&
    !/postMessage\([\s\S]{0,150}(?:latestTekmetricProof|proof:)/.test(interceptor),
);
ok(
  "recovery is bound to active tab and current shop/RO context",
  /tabId === getActiveTabId\(\)[\s\S]+contextsMatch\(expectedContext, getCurrentContext\(tabId\)\)/.test(recoveryCore) &&
    /requireCurrentContext[\s\S]+smsContextsByTab\.get\(opts\.tabId\)/.test(background) &&
    /bindTekmetricActionToLiveContext[\s\S]+GET_PAGE_CONTEXT[\s\S]+contextsMatch\(context, liveContext\)/.test(background),
);
ok(
  "Enhanced Notes revalidates context after grants and before retries",
  /providerActionGrant = await requestProviderActionGrant[\s\S]+if \(validateContext\) await validateContext\(\)/.test(background) &&
    /tekmetricFetchWithBackoff[\s\S]+if \(validateContext\) await validateContext\(\)[\s\S]+await fetch\(url, init\)/.test(background) &&
    /assertCurrentTekmetricRequestContext[\s\S]+GET_PAGE_CONTEXT/.test(background),
);
ok(
  "live request validation rechecks active tab and exact page URL after awaits",
  /const liveContext = await getLiveContext[\s\S]+tabId !== getActiveTabId\(\)[\s\S]+const tabState = await getTabState[\s\S]+tabId !== getActiveTabId\(\)[\s\S]+liveContext\._pageUrl === tabState\.url/.test(recoveryCore),
);
ok(
  "Tekmetric proof origin stays bound to the current tab origin",
  /tekmetricProof\.origin !== nextOrigin[\s\S]+tekmetricProofsByTab\.delete\(tabId\)/.test(background) &&
    /tabState\.origin === session\?\.origin/.test(recoveryCore),
);
ok(
  "Enhanced Notes analysis and apply use bounded session recovery",
  /fetchEnhancedFindings[\s\S]+await recoverTekmetricSessionForTab\(context, tabId\)/.test(background) &&
    /applyEnhancedFindings[\s\S]+await recoverTekmetricSessionForTab\(context, tabId\)/.test(background),
);
ok(
  "terminal apply failure restores modal controls without deleting edits",
  /ENHANCE_FINDINGS_FAILED[\s\S]+applyBtn\.textContent = 'Apply Selected'/.test(tekmetricContent) &&
    !/ENHANCE_FINDINGS_FAILED[\s\S]{0,500}mos-enhance-review-modal['"]\)\?\.remove/.test(tekmetricContent),
);
ok("old persisted provider proof is removed", /storage\.session\.remove\(\['tekmetricToken'\]\)/.test(background));
ok("bootstrap results are tab/context checked", /bootstrapContextKey\(tabId,\s*latest\)\s*!==\s*key/.test(background));
ok("stale issued sessions are revoked", /revokeExtensionBearer\(data\.token,\s*apiUrl\)/.test(background));
ok("provider proof is isolated per source tab", /tekmetricProofsByTab\.get\(tabId\)/.test(background));
ok(
  "provider token capture never overwrites a global Tekmetric credential",
  !/smsTokens\.tekmetric\s*=\s*tokenHeader\.value/.test(background),
);
ok(
  "Tekmetric provider requests resolve credentials from the source tab",
  /function tekmetricSessionForContext[\s\S]+tekmetricProofsByTab\.get\(tabId\)/.test(background) &&
    /function tekBuildRequest[\s\S]+mergedHeaders\['x-auth-token'\]\s*=\s*session\.token/.test(background),
);
ok(
  "raw Tekmetric retries cancel before fetch after a tab switch",
  /async function tekmetricFetchWithBackoff[\s\S]{0,500}isCurrentTekmetricSession\(tekmetricSession\)[\s\S]{0,500}await fetch\(url, init\)/.test(background),
);
ok(
  "every raw helper call supplies its captured tab session",
  (background.match(/`build-ro-from-vhi (?:GET|POST|VERIFY)[^`]*`,\s*tekmetricSession/g) || []).length === 3 &&
    /`undo DELETE concern \$\{it\.concernId\}`,\s*tekmetricSession/.test(background),
);
ok(
  "background-tab token capture cannot trigger active-context labor work",
  /tabTokenChanged[\s\S]+details\.tabId === activeTabId[\s\S]+autoApplyLaborRate\(tabContext\)/.test(background),
);
ok(
  "provider-account changes invalidate a tab's old bootstrap principal",
  /tabTokenChanged[\s\S]+mosBootstrapContextKey\?\.startsWith/.test(background) &&
    /await clearBootstrapAuth\(true\)/.test(background),
);
ok("active context is selected per tab", /smsContextsByTab\.get\(activeTabId\)/.test(background));
const setContextBlock = background.slice(
  background.indexOf('if (message.action === "SET_SMS_CONTEXT")'),
  background.indexOf('if (message.action === "GET_SHOP_FEATURES")'),
);
ok(
  "inactive tab context cannot overwrite the active global context",
  setContextBlock.indexOf("await tabIsActive") <
    setContextBlock.indexOf("currentSmsContext = incomingContext"),
);
ok(
  "inactive tab context cannot trigger automatic helper work",
  setContextBlock.indexOf("await tabIsActive") <
    setContextBlock.indexOf("autoApplyLaborRate(incomingContext)"),
);
ok("logout invalidates in-flight bootstrap", /MOS_LOGOUT[\s\S]+authEpoch \+= 1/.test(background));
ok("explicit login invalidates in-flight bootstrap", /loginEpoch = \+\+authEpoch/.test(background));
ok("stale exchanges cannot commit after auth changes", /authEpoch !== attemptEpoch/.test(background));
ok("worker restore keeps bootstrap auth pending for fresh proof", /pendingBootstrapAuth = auth/.test(background));
ok(
  "worker restore does not directly install the bootstrap bearer",
  !/if \(!local\.mosApiToken && auth\?\.token[\s\S]{0,250}mosApiToken = auth\.token/.test(background),
);
ok("provider 401/403 invalidates tab proof", /\[401, 403\][\s\S]+tekmetricProofsByTab\.delete/.test(background));
ok("every MOS API call rechecks active-tab binding", /handleMosApiRequest[\s\S]+ensureBootstrapBoundToActiveTab/.test(background));
ok(
  "direct feature fetch rechecks active-tab binding",
  /GET_SHOP_FEATURES[\s\S]+await ensureBootstrapBoundToActiveTab/.test(background),
);
ok(
  "inactive content-script messages are rejected under bootstrap auth",
  /sender\.tab\.id !== activeTabId[\s\S]+SHOP_FORBIDDEN/.test(background),
);
ok("explicit password login remains available", /action:\s*'MOS_LOGIN'/.test(panel));
ok("side panel asks for bootstrap before showing login", /action:\s*'MOS_BOOTSTRAP'/.test(panel));
ok("Basic access has a normal sign-in step-up", html.includes('id="session-step-up-btn"'));
ok("Basic banner has an accessible capability details view", html.includes('id="session-tier-details"') && html.includes('Requires MOS.Tools sign-in'));
ok("Basic capability summary is entitlement-aware", panel.includes("shopFeatures.oil_sticker") && panel.includes("shopFeatures.keytags"));
ok("unsupported and verification-needed outcomes are visible", panel.includes("unsupported:") && panel.includes("verification_needed:"));
ok("matched MOS users are named in the panel", panel.includes("Signed in as"));

if (failed > 0) process.exit(1);
console.log("extension automatic bootstrap wiring: PASS");