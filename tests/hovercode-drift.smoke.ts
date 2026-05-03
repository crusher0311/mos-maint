/**
 * Smoke test for `lib/hovercode.ts` `verifyHovercode` (read-back drift guard).
 *
 * The two prod incidents that motivated this safety net both involved
 * HoverCode returning 200 from a create/update while silently dropping the
 * field we set (notably `logo_url`). `verifyHovercode` is the guard that
 * GETs the record back and emits a structured drift signal when fields
 * don't stick. These tests pin that behavior:
 *
 *   1. Read-back returning a record WITH a logo → no drift signal.
 *   2. Read-back returning a 200 with NO logo fields → drift signal recorded.
 *      (This is the exact failure mode that caused the logo-less HoverCode
 *      QRs incident.)
 *   3. Read-back returning a different qr_data than what we sent → drift.
 *   4. Read-back returning a non-200 → drift signal recorded.
 *
 * Run: `npx tsx tests/hovercode-drift.smoke.ts`
 */

import { verifyHovercode } from "../lib/hovercode";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type FetchSpy = {
  calls: { url: string; init?: any }[];
  restore: () => void;
};

function installFetch(handler: (url: string, init?: any) => Response): FetchSpy {
  const original = (globalThis as any).fetch;
  const calls: { url: string; init?: any }[] = [];
  (globalThis as any).fetch = async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return {
    calls,
    restore: () => {
      (globalThis as any).fetch = original;
    },
  };
}

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Capture trackApiRequest events. We do this by intercepting console.warn
// (verifyHovercode logs structured warnings on drift) since trackApiRequest
// itself writes to a Mongo collection and we'd need a fake DB to inspect.
// The console signal is what humans / log-based alerts react to anyway.
type WarnSpy = { warnings: string[]; restore: () => void };
function installWarn(): WarnSpy {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: any[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  return {
    warnings,
    restore: () => {
      console.warn = original;
    },
  };
}

async function run() {
  console.log("hovercode-drift smoke");

  // verifyHovercode is a no-op without HOVERCODE_API_TOKEN. Make sure it's set
  // for the duration of the test, then restore.
  const ORIG_TOKEN = process.env.HOVERCODE_API_TOKEN;
  process.env.HOVERCODE_API_TOKEN = "test-token";

  try {
    // (1) logo present in read-back → no drift warning, GET sent to v2 path
    {
      const fetchSpy = installFetch(() =>
        jsonResponse(200, {
          id: "hc1",
          qr_data: "https://mos.tools/sticker/redirect/1",
          logo_url: "https://hovercode.example/served-logo.png",
        }),
      );
      const warn = installWarn();
      await verifyHovercode(
        "hc1",
        {
          qr_data: "https://mos.tools/sticker/redirect/1",
          logo_url: "https://mos.tools/appointment-logo.png",
        },
        1,
        "create",
      );
      warn.restore();
      fetchSpy.restore();

      ok(
        "GET sent to v2 hovercode endpoint",
        fetchSpy.calls.length === 1 &&
          fetchSpy.calls[0].url ===
            "https://hovercode.com/api/v2/hovercode/hc1/",
      );
      ok(
        "Authorization header includes Token",
        String(fetchSpy.calls[0].init?.headers?.Authorization || "").startsWith(
          "Token ",
        ),
      );
      ok(
        "no drift warning when logo present",
        !warn.warnings.some((w) => w.includes("[HoverCode-Drift]")),
        warn.warnings.join(" | "),
      );
    }

    // (2) THE BIG ONE: 200-with-no-logo case. This is exactly the prod bug
    // the safety net is supposed to catch. The read-back returns 200 with
    // no logo_url / logo_image / logo field — drift must be reported.
    {
      const fetchSpy = installFetch(() =>
        jsonResponse(200, {
          id: "hc2",
          qr_data: "https://mos.tools/sticker/redirect/2",
          // logo_url intentionally absent
        }),
      );
      const warn = installWarn();
      await verifyHovercode(
        "hc2",
        { logo_url: "https://mos.tools/appointment-logo.png" },
        2,
        "create",
      );
      warn.restore();
      fetchSpy.restore();

      const driftLine = warn.warnings.find((w) =>
        w.includes("[HoverCode-Drift]"),
      );
      ok("drift warning emitted on 200-with-no-logo", !!driftLine, warn.warnings.join(" | "));
      ok(
        "drift warning mentions missing logo",
        !!driftLine && driftLine.toLowerCase().includes("logo"),
        driftLine,
      );
    }

    // (3) qr_data drift: read-back returns a different destination than we
    // sent. This protects the second prod incident class — silent payload
    // mutation by HoverCode.
    {
      const fetchSpy = installFetch(() =>
        jsonResponse(200, {
          id: "hc3",
          qr_data: "https://other-domain.example/other",
          logo_url: "https://hovercode.example/x.png",
        }),
      );
      const warn = installWarn();
      await verifyHovercode(
        "hc3",
        {
          qr_data: "https://mos.tools/sticker/redirect/3",
          logo_url: "https://mos.tools/appointment-logo.png",
        },
        3,
        "update-destination",
      );
      warn.restore();
      fetchSpy.restore();

      const driftLine = warn.warnings.find((w) =>
        w.includes("[HoverCode-Drift]"),
      );
      ok("drift warning emitted on qr_data mismatch", !!driftLine, warn.warnings.join(" | "));
      ok(
        "drift warning mentions qr_data",
        !!driftLine && driftLine.includes("qr_data"),
        driftLine,
      );
    }

    // (4) read-back itself fails (non-200). Should still emit a drift signal.
    {
      const fetchSpy = installFetch(() =>
        new Response("not found", { status: 404 }),
      );
      const warn = installWarn();
      await verifyHovercode(
        "hc4",
        { logo_url: "https://mos.tools/appointment-logo.png" },
        4,
        "create",
      );
      warn.restore();
      fetchSpy.restore();

      ok(
        "drift warning emitted when read-back returns non-200",
        warn.warnings.some(
          (w) => w.includes("[HoverCode-Drift]") && w.includes("read-back"),
        ),
        warn.warnings.join(" | "),
      );
    }
  } finally {
    if (ORIG_TOKEN === undefined) delete process.env.HOVERCODE_API_TOKEN;
    else process.env.HOVERCODE_API_TOKEN = ORIG_TOKEN;
  }

  if (failed > 0) {
    console.error(`\nFAILED ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(2);
});
