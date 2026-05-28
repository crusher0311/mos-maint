import assert from "node:assert/strict";
import { NextResponse } from "next/server";
import { withExtensionErrorMarker } from "../lib/extension-route-wrapper";

type Captured = {
  level: "log" | "warn" | "error";
  args: any[];
};

function captureConsole(): { entries: Captured[]; restore: () => void } {
  const entries: Captured[] = [];
  const orig = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...args: any[]) => {
    entries.push({ level: "log", args });
  };
  console.warn = (...args: any[]) => {
    entries.push({ level: "warn", args });
  };
  console.error = (...args: any[]) => {
    entries.push({ level: "error", args });
  };
  return {
    entries,
    restore: () => {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    },
  };
}

function findMarker(entries: Captured[]): Record<string, any> | null {
  for (const e of entries) {
    const line = e.args[0];
    if (typeof line === "string" && line.startsWith("[ShopErrorRate] ")) {
      return JSON.parse(line.slice("[ShopErrorRate] ".length));
    }
  }
  return null;
}

function makeReq(url: string, init?: RequestInit): any {
  const req: any = new Request(url, init);
  // Simulate Next's NextRequest enough for the wrapper: it only reads
  // nextUrl.pathname, nextUrl.searchParams, headers, and method.
  const u = new URL(url);
  req.nextUrl = {
    pathname: u.pathname,
    searchParams: u.searchParams,
  };
  return req;
}

async function caseThrownErrorEmitsAndReturns500() {
  const cap = captureConsole();
  try {
    const wrapped = withExtensionErrorMarker(async () => {
      throw new Error("boom from handler");
    });
    const res = await wrapped(
      makeReq("https://x.example/api/extension/plan?shopId=42", {
        method: "POST",
      }),
    );
    assert.equal(res.status, 500, "thrown handler should return 500");
    const marker = findMarker(cap.entries);
    assert.ok(marker, "marker must be emitted on throw");
    assert.equal(marker.group, "EXT_5XX");
    assert.equal(marker.shopId, 42);
    assert.equal(marker.status, 500);
    assert.equal(marker.path, "/api/extension/plan");
    assert.equal(marker.method, "POST");
    assert.match(marker.message, /boom from handler/);
  } finally {
    cap.restore();
  }
  console.log("OK: thrown error emits EXT_5XX and returns 500");
}

async function caseReturned500EmitsMarkerAndPassesThrough() {
  const cap = captureConsole();
  try {
    const wrapped = withExtensionErrorMarker(async () => {
      return NextResponse.json({ error: "downstream" }, { status: 503 });
    });
    const res = await wrapped(
      makeReq("https://x.example/api/extension/jobs/search?shopId=7", {
        method: "GET",
      }),
    );
    assert.equal(res.status, 503, "returned 503 should pass through");
    const body = await res.json();
    assert.equal(body.error, "downstream", "body must not be mutated");
    const marker = findMarker(cap.entries);
    assert.ok(marker, "marker must be emitted on 5xx response");
    assert.equal(marker.group, "EXT_5XX");
    assert.equal(marker.shopId, 7);
    assert.equal(marker.status, 503);
    assert.equal(marker.path, "/api/extension/jobs/search");
    assert.equal(marker.method, "GET");
  } finally {
    cap.restore();
  }
  console.log("OK: 5xx response emits EXT_5XX and passes through unchanged");
}

async function caseSuccessfulResponseEmitsNothing() {
  const cap = captureConsole();
  try {
    const wrapped = withExtensionErrorMarker(async () => {
      return NextResponse.json({ ok: true }, { status: 200 });
    });
    const res = await wrapped(
      makeReq("https://x.example/api/extension/features?shopId=9"),
    );
    assert.equal(res.status, 200);
    assert.equal(
      findMarker(cap.entries),
      null,
      "no marker on 2xx responses",
    );
  } finally {
    cap.restore();
  }
  console.log("OK: 2xx response does not emit marker");
}

async function caseClient4xxEmitsNothing() {
  const cap = captureConsole();
  try {
    const wrapped = withExtensionErrorMarker(async () => {
      return NextResponse.json({ error: "bad input" }, { status: 400 });
    });
    const res = await wrapped(
      makeReq("https://x.example/api/extension/features?shopId=9"),
    );
    assert.equal(res.status, 400);
    assert.equal(
      findMarker(cap.entries),
      null,
      "no marker on 4xx — those are caller errors, not shop-error-rate signal",
    );
  } finally {
    cap.restore();
  }
  console.log("OK: 4xx response does not emit marker");
}

async function caseShopIdFromHeaderWhenQueryMissing() {
  const cap = captureConsole();
  try {
    const wrapped = withExtensionErrorMarker(async () => {
      return NextResponse.json({ error: "boom" }, { status: 500 });
    });
    const res = await wrapped(
      makeReq("https://x.example/api/extension/plan", {
        method: "POST",
        headers: { "x-shop-id": "123" },
      }),
    );
    assert.equal(res.status, 500);
    const marker = findMarker(cap.entries);
    assert.ok(marker);
    assert.equal(marker.shopId, 123, "shopId must come from x-shop-id header");
  } finally {
    cap.restore();
  }
  console.log("OK: shopId resolved from x-shop-id header");
}

async function caseShopIdNullWhenUnresolvable() {
  const cap = captureConsole();
  try {
    const wrapped = withExtensionErrorMarker(async () => {
      return NextResponse.json({ error: "boom" }, { status: 500 });
    });
    const res = await wrapped(
      makeReq("https://x.example/api/extension/version"),
    );
    assert.equal(res.status, 500);
    const marker = findMarker(cap.entries);
    assert.ok(marker);
    assert.equal(
      marker.shopId,
      null,
      "shopId must be null when neither query nor header carry one",
    );
  } finally {
    cap.restore();
  }
  console.log("OK: unresolvable shopId emits as null (still alertable)");
}

async function caseAllExtensionRoutesAreWrapped() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { execSync } = await import("node:child_process");
  const files = execSync(
    "find app/api/extension -name route.ts",
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
  const unwrapped: string[] = [];

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const present = METHODS.filter((m) =>
      new RegExp(`^(export )?async function _?${m}\\b`, "m").test(src),
    );
    if (present.length === 0) continue;
    const hasImport = src.includes(
      'from "@/lib/extension-route-wrapper"',
    );
    const allExported = present.every((m) =>
      new RegExp(
        `export const ${m}\\s*=\\s*withExtensionErrorMarker\\(`,
      ).test(src),
    );
    if (!hasImport || !allExported) {
      unwrapped.push(`${file} [methods: ${present.join(",")}]`);
    }
  }
  assert.deepEqual(
    unwrapped,
    [],
    `every /api/extension/* route must wrap its handlers with withExtensionErrorMarker — unwrapped:\n  ${unwrapped.join(
      "\n  ",
    )}`,
  );
  console.log(
    `OK: all ${files.length} extension route files wrap their handlers`,
  );
}

async function main() {
  await caseThrownErrorEmitsAndReturns500();
  await caseReturned500EmitsMarkerAndPassesThrough();
  await caseSuccessfulResponseEmitsNothing();
  await caseClient4xxEmitsNothing();
  await caseShopIdFromHeaderWhenQueryMissing();
  await caseShopIdNullWhenUnresolvable();
  await caseAllExtensionRoutesAreWrapped();
  console.log("\nAll extension-route-wrapper smoke cases passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
