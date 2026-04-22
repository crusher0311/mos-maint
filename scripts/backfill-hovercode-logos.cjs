#!/usr/bin/env node
/**
 * One-shot backfill: walk every HoverCode QR in the workspace and update its
 * logo_url to the canonical brand logo. Fixes the historical bug where QRs
 * created via /api/sticker/generate, /api/sticker/regenerate-qr, and
 * /api/sticker/qr-cache pointed HoverCode at the ephemeral REPLIT_DEV_DOMAIN
 * /api/assets/appointment-logo.png URL, which silently failed to fetch and
 * produced logo-less QRs.
 *
 * Usage:
 *   node scripts/backfill-hovercode-logos.cjs --dry-run
 *   node scripts/backfill-hovercode-logos.cjs
 *   node scripts/backfill-hovercode-logos.cjs --logo-url=https://mos.tools/appointment-logo.png
 *   node scripts/backfill-hovercode-logos.cjs --filter=sticker/redirect
 *
 * Required env: HOVERCODE_API_TOKEN, HOVERCODE_WORKSPACE_ID
 * Optional env: NEXT_PUBLIC_BASE_URL (default https://mos.tools)
 */

const HOVERCODE_API_BASE = "https://hovercode.com/api/v2";

function parseArgs(argv) {
  const args = { dryRun: false, logoUrl: null, filter: null, concurrency: 4, all: false };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--all") args.all = true;
    else if (a.startsWith("--logo-url=")) args.logoUrl = a.split("=", 2)[1];
    else if (a.startsWith("--filter=")) args.filter = a.split("=", 2)[1];
    else if (a.startsWith("--concurrency=")) args.concurrency = parseInt(a.split("=", 2)[1], 10) || 4;
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "Backfill HoverCode logos.",
          "",
          "Safety: you must pass either --filter=<substring> or --all to write.",
          "Recommended first run: --filter=sticker/redirect --dry-run",
          "",
          "Flags:",
          "  --dry-run, -n            list QRs that would be updated, do not write",
          "  --logo-url=<url>         override the logo URL (default: <NEXT_PUBLIC_BASE_URL>/appointment-logo.png)",
          "  --filter=<substring>     only update QRs whose qr_data/destination contains this substring",
          "  --all                    update every QR in the workspace (no filter, explicit opt-in)",
          "  --concurrency=<n>        parallel update workers (default: 4)",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return args;
}

async function listAllHovercodes(apiToken, workspaceId) {
  const out = [];
  let nextUrl = `${HOVERCODE_API_BASE}/workspace/${workspaceId}/hovercodes/?page_size=200`;
  while (nextUrl) {
    const res = await fetch(nextUrl, { headers: { Authorization: `Token ${apiToken}` } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`List failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    out.push(...(data.results || []));
    nextUrl = data.next || null;
  }
  return out;
}

async function updateLogo(apiToken, id, logoUrl) {
  const res = await fetch(`${HOVERCODE_API_BASE}/hovercode/${id}/update/`, {
    method: "PUT",
    headers: {
      Authorization: `Token ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ logo_url: logoUrl }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i).catch((e) => ({ error: e.message }));
    }
  });
  await Promise.all(workers);
  return results;
}

(async () => {
  const args = parseArgs(process.argv);
  const apiToken = process.env.HOVERCODE_API_TOKEN;
  const workspaceId = process.env.HOVERCODE_WORKSPACE_ID;
  if (!apiToken || !workspaceId) {
    console.error("ERROR: HOVERCODE_API_TOKEN and HOVERCODE_WORKSPACE_ID must be set.");
    process.exit(1);
  }

  if (!args.dryRun && !args.filter && !args.all) {
    console.error(
      "ERROR: refusing to update every QR in the workspace without explicit opt-in.\n" +
        "       Pass --filter=<substring> (e.g. --filter=sticker/redirect) or --all.",
    );
    process.exit(2);
  }

  const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools").replace(/\/$/, "");
  const logoUrl = args.logoUrl || `${baseUrl}/appointment-logo.png`;

  console.log(`[Backfill] Workspace: ${workspaceId}`);
  console.log(`[Backfill] Target logo URL: ${logoUrl}`);
  console.log(`[Backfill] Mode: ${args.dryRun ? "DRY RUN (no writes)" : "LIVE"}`);
  if (args.filter) console.log(`[Backfill] Filter: destination contains "${args.filter}"`);

  console.log("[Backfill] Listing all HoverCode QRs...");
  const all = await listAllHovercodes(apiToken, workspaceId);
  console.log(`[Backfill] Found ${all.length} total QRs in workspace.`);

  const targets = args.filter
    ? all.filter((qr) => {
        const dest = qr.qr_data || qr.destination || "";
        return dest.includes(args.filter);
      })
    : all;

  console.log(`[Backfill] ${targets.length} will be updated.`);

  if (args.dryRun) {
    for (const qr of targets) {
      const dest = qr.qr_data || qr.destination || "(no destination)";
      console.log(`  [dry] ${qr.id}  ${qr.display_name || ""}  -> ${dest}`);
    }
    console.log("[Backfill] Dry run complete. Re-run without --dry-run to apply.");
    return;
  }

  let ok = 0;
  let fail = 0;
  await runWithConcurrency(targets, args.concurrency, async (qr, i) => {
    try {
      await updateLogo(apiToken, qr.id, logoUrl);
      ok++;
      if ((i + 1) % 10 === 0 || i === targets.length - 1) {
        console.log(`[Backfill] Progress: ${i + 1}/${targets.length} (ok=${ok}, fail=${fail})`);
      }
    } catch (e) {
      fail++;
      console.error(`[Backfill] FAIL ${qr.id}: ${e.message}`);
    }
  });

  console.log(`[Backfill] Done. Updated ${ok} QRs, ${fail} failed.`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("[Backfill] Fatal:", e);
  process.exit(1);
});
