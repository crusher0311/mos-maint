#!/usr/bin/env tsx
import { sendEmail } from "../lib/email";
import { getPlatformAdminEmails } from "../lib/super-admins";

// The publish helpers live in a CommonJS .js file alongside this script.
// Using require keeps the typings simple and matches how the CLI uses them.
const {
  hasAllSecrets,
  readManifestVersion,
  getAccessToken,
  fetchLivePublishedVersion,
  compareVersions,
  runFullPublish,
} = require("./publish-extension.js") as {
  hasAllSecrets: () => boolean;
  readManifestVersion: () => string;
  getAccessToken: () => Promise<string>;
  fetchLivePublishedVersion: (
    accessToken: string | null
  ) => Promise<{ version: string | null; source: "auth" | "public" | null }>;
  compareVersions: (a: string, b: string) => number;
  runFullPublish: (opts?: { target?: "default" | "trustedTesters" }) => Promise<{
    version: string;
    uploadState: string | undefined;
    publishStatus: string;
  }>;
};

const TAG = "[ext:auto-publish]";

function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

function hasStringProp<K extends string>(
  value: unknown,
  key: K
): value is Record<K, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === "string"
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (hasStringProp(error, "message")) return error.message;
  return String(error);
}

function errorStack(error: unknown): string {
  if (error instanceof Error && error.stack) return error.stack;
  if (hasStringProp(error, "stack")) return error.stack;
  return "";
}

function errorStage(error: unknown): string | null {
  if (hasStringProp(error, "stage")) return error.stage;
  return null;
}

function errorCwsResponse(error: unknown): unknown {
  if (typeof error === "object" && error !== null && "cwsResponse" in error) {
    return (error as { cwsResponse?: unknown }).cwsResponse;
  }
  return null;
}

async function sendAlertEmail(args: {
  version: string;
  stage: string;
  error: unknown;
  raw: unknown;
}) {
  const { version, stage, error, raw } = args;
  // Reuse the same admin-email lookup the sync-health alerts use, so the
  // failure email lands in the same inbox.
  const recipients = await getPlatformAdminEmails();

  const errMsg = errorMessage(error);
  const stack = errorStack(error);
  const safeRaw = raw ? JSON.stringify(raw, null, 2) : stack || errMsg;

  const subject = `[Detect Dog] Auto-publish failed at ${stage} for v${version}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
      <h2 style="margin:0 0 8px">Detect Dog auto-publish failed</h2>
      <p>The Chrome Web Store auto-publisher could not push the latest extension build.</p>
      <table style="border-collapse:collapse">
        <tbody>
          <tr><td style="padding:6px 12px;border:1px solid #ddd"><strong>Manifest version</strong></td><td style="padding:6px 12px;border:1px solid #ddd"><code>${escapeHtml(version)}</code></td></tr>
          <tr><td style="padding:6px 12px;border:1px solid #ddd"><strong>Failure stage</strong></td><td style="padding:6px 12px;border:1px solid #ddd"><code>${escapeHtml(stage)}</code></td></tr>
          <tr><td style="padding:6px 12px;border:1px solid #ddd"><strong>Error</strong></td><td style="padding:6px 12px;border:1px solid #ddd"><code>${escapeHtml(errMsg)}</code></td></tr>
        </tbody>
      </table>
      <h3>Raw response / stack</h3>
      <pre style="background:#f6f8fa;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-word">${escapeHtml(safeRaw)}</pre>
      <p style="margin-top:16px;color:#666;font-size:13px">
        The repo's <code>mos-tools-extension/manifest.json</code> is unchanged. Fix the underlying issue
        (token, item id, store review) and re-run <code>npm run ext:publish</code> manually, or trigger
        another merge to retry. Set <code>EXT_AUTOPUBLISH_DISABLED=1</code> to silence the auto-publisher
        temporarily.
      </p>
    </div>`;
  const text = `Detect Dog auto-publish failed at stage=${stage} for v${version}.\nError: ${errMsg}\n\n${safeRaw}`;

  if (!recipients.length) {
    console.warn(`${TAG} No platform-admin recipients resolved; alert not sent`);
    return;
  }

  // Resend caps at 5 requests/sec; throttle to ~4/sec to stay safely under.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let i = 0;
  for (const to of recipients) {
    if (i++ > 0) await sleep(250);
    try {
      await sendEmail({ to, subject, html, text });
      console.log(`${TAG} Alert email sent to ${to}`);
    } catch (err: unknown) {
      console.error(`${TAG} Email send failed for ${to}: ${errorMessage(err)}`);
    }
  }
}

async function main() {
  if (process.env.EXT_AUTOPUBLISH_DISABLED === "1") {
    console.log(`${TAG} EXT_AUTOPUBLISH_DISABLED=1 — skipping auto-publish.`);
    return;
  }

  // When invoked by `npm run build`'s postbuild hook, only proceed if we're
  // actually in a deploy-like environment. This prevents a developer's local
  // `npm run build` from accidentally auto-publishing if they happen to have
  // CWS secrets in their shell. Direct `npm run ext:auto-publish` calls and
  // the post-merge hook do NOT set this flag, so they always run.
  if (process.env.EXT_AUTOPUBLISH_TRIGGER === "postbuild") {
    // Allow only known *deploy* environments (not generic CI test runners,
    // which may also set CI=true and could have CWS secrets in scope).
    const isDeploy =
      process.env.REPLIT_DEPLOYMENT === "1" ||
      process.env.VERCEL === "1" ||
      process.env.RENDER === "true";
    if (!isDeploy) {
      console.log(
        `${TAG} postbuild trigger detected but not in a known deploy environment ` +
          `(set REPLIT_DEPLOYMENT=1, VERCEL=1, or RENDER=true to enable, ` +
          `or run \`npm run ext:auto-publish\` directly). Skipping.`
      );
      return;
    }
  }

  const repoVersion = readManifestVersion();

  if (!hasAllSecrets()) {
    console.warn(
      `${TAG} CWS secrets not configured (CWS_CLIENT_ID/SECRET/REFRESH_TOKEN/ITEM_ID). Skipping auto-publish for v${repoVersion}.`
    );
    return;
  }

  // Look up the live store version. Tries the authenticated CWS API first
  // (preferred source of truth), falls back to scraping the public detail
  // page. If both fail we alert and exit non-zero — task requires the live
  // version to be the source of truth, so we never blind-publish.
  let liveVersion: string | null = null;
  let liveSource: "auth" | "public" | null = null;
  try {
    const accessToken = await getAccessToken();
    const looked = await fetchLivePublishedVersion(accessToken);
    liveVersion = looked.version;
    liveSource = looked.source;
  } catch (err: unknown) {
    console.error(`${TAG} Failed to refresh CWS access token: ${errorMessage(err)}`);
    await sendAlertEmail({ version: repoVersion, stage: "token", error: err, raw: null });
    process.exit(1);
  }

  if (!liveVersion) {
    const err = new Error(
      "Could not determine live Chrome Web Store version: authenticated API " +
        "returned nothing (likely chromewebstore.googleapis.com not enabled " +
        "for the OAuth project) AND the public detail-page scrape returned " +
        "no version. Refusing to publish without a source of truth."
    );
    console.error(`${TAG} ${err.message}`);
    await sendAlertEmail({ version: repoVersion, stage: "lookup", error: err, raw: null });
    process.exit(1);
  }

  const cmp = compareVersions(repoVersion, liveVersion);
  if (cmp === 0) {
    console.log(`${TAG} no-op (store already at v${liveVersion}, source=${liveSource})`);
    return;
  }
  if (cmp < 0) {
    console.log(
      `${TAG} no-op (repo v${repoVersion} is behind store v${liveVersion}, source=${liveSource}; refusing to downgrade)`
    );
    return;
  }
  console.log(
    `${TAG} repo v${repoVersion} > store v${liveVersion} (source=${liveSource}) — publishing...`
  );

  try {
    const result = await runFullPublish({ target: "default" });
    console.log(
      `${TAG} published v${result.version} (uploadState=${result.uploadState}, publishStatus=${result.publishStatus})`
    );
  } catch (err: unknown) {
    const stageLabel = errorStage(err) || "publish";
    console.error(`${TAG} Auto-publish failed at stage=${stageLabel}: ${errorMessage(err)}`);
    await sendAlertEmail({
      version: repoVersion,
      stage: stageLabel,
      error: err,
      raw: errorCwsResponse(err),
    });
    process.exit(1);
  }
}

main().catch(async (err: unknown) => {
  const stack = errorStack(err);
  console.error(`${TAG} Unexpected fatal error:`, stack || errorMessage(err));
  try {
    let v = "unknown";
    try {
      v = readManifestVersion();
    } catch {
      // best-effort; fall back to "unknown"
    }
    await sendAlertEmail({ version: v, stage: "fatal", error: err, raw: null });
  } catch (alertErr: unknown) {
    console.error(`${TAG} Alert email also failed: ${errorMessage(alertErr)}`);
  }
  process.exit(1);
});
