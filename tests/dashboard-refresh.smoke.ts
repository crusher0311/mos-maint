import {
  dashboardMarkerAfterRefresh,
  dashboardMarkerChanged,
} from "../lib/dashboard-refresh";
import fs from "node:fs";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

console.log("dashboard refresh marker smoke");
ok("a changed opaque token requests one refresh", dashboardMarkerChanged("1:0:1:1", "1:0:1:2"));
ok("the initial unknown marker establishes a refresh baseline", dashboardMarkerChanged(null, "0:0:0:0"));
ok("a failed refresh keeps the pending marker for retry", dashboardMarkerAfterRefresh("1:0:1:1", "1:0:1:2", false) === "1:0:1:1");
ok("a successful refresh commits the response marker", dashboardMarkerAfterRefresh("1:0:1:1", "1:0:1:2", true, "1:0:1:3") === "1:0:1:3");

const clientSource = fs.readFileSync("app/dashboard/DashboardClient.tsx", "utf8");
ok("dashboard loader aborts superseded requests", clientSource.includes("new AbortController()") && clientSource.includes("controller.abort()"));
ok("same-query dashboard loads are deduplicated", clientSource.includes("existing?.key === key") && clientSource.includes("return existing.promise"));
ok("stale loader responses cannot commit", clientSource.includes("generation !== requestGenerationRef.current"));

if (failed > 0) process.exitCode = 1;