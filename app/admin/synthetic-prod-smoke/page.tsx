// app/admin/synthetic-prod-smoke/page.tsx — task #512 status surface.
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

async function loadData() {
  const db = await getDb();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [runs, state, dayAgg] = await Promise.all([
    db.collection("synthetic_runs").find({}).sort({ ts: -1 }).limit(50).toArray(),
    db.collection("synthetic_state").find({}).toArray(),
    db
      .collection("synthetic_runs")
      .aggregate([
        { $match: { ts: { $gte: since24h } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            passed: { $sum: { $cond: ["$ok", 1, 0] } },
          },
        },
      ])
      .toArray(),
  ]);
  const stats = dayAgg[0] || { total: 0, passed: 0 };
  return {
    runs,
    state,
    passRate: stats.total ? stats.passed / stats.total : null,
    total: stats.total,
    passed: stats.passed,
  };
}

function fmtTs(ts: any): string {
  if (!ts) return "—";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function stateVendor(s: any): string {
  if (s.provider) return s.provider;
  const id = String(s._id).replace(/^step:/, "");
  return id.includes(":") ? id.split(":").pop()! : "legacy";
}

function runVendors(r: any): any[] {
  if (Array.isArray(r.vendors) && r.vendors.length) return r.vendors;
  return [
    {
      provider: r.provider ?? "legacy",
      ok: r.ok,
      steps: r.steps || [],
    },
  ];
}

export default async function SyntheticSmokePage() {
  const { runs, state, passRate, total, passed } = await loadData();
  const pagedSteps = state.filter((s: any) => s.alertedAt);

  // Group per-(step × vendor) state by vendor for the status surface.
  const stateByVendor = new Map<string, any[]>();
  for (const s of state) {
    const v = stateVendor(s);
    if (!stateByVendor.has(v)) stateByVendor.set(v, []);
    stateByVendor.get(v)!.push(s);
  }
  const stateVendors = Array.from(stateByVendor.keys()).sort();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Synthetic Prod Smoke</h1>
        <p className="mt-1 text-sm text-gray-500">
          Task #512 / #525 — top user actions exercised against one sentinel shop
          per SMS vendor every 5 minutes. Pages on-call after 2 consecutive
          failures of the same (step × vendor).
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-sm text-gray-500">24h pass rate</div>
          <div className="text-2xl font-bold">
            {passRate == null ? "—" : `${(passRate * 100).toFixed(1)}%`}
          </div>
          <div className="text-xs text-gray-400">{passed}/{total} runs</div>
        </div>
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-sm text-gray-500">Currently paged steps</div>
          <div className={`text-2xl font-bold ${pagedSteps.length ? "text-red-600" : "text-green-600"}`}>
            {pagedSteps.length}
          </div>
          <div className="text-xs text-gray-400">
            {pagedSteps
              .map((s: any) => `${s.stepName ?? String(s._id)} (${stateVendor(s)})`)
              .join(", ") || "all clear"}
          </div>
        </div>
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-sm text-gray-500">Last run</div>
          <div className="text-sm font-mono">{fmtTs(runs[0]?.ts)}</div>
          <div className={`text-xs ${runs[0]?.ok ? "text-green-600" : "text-red-600"}`}>
            {runs[0] ? (runs[0].ok ? "ok" : "FAIL") : "no data"}
          </div>
        </div>
      </div>

      <div className="bg-white shadow rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Step state by vendor</h2>
        {state.length === 0 && (
          <p className="py-3 text-gray-400 text-sm">No state recorded yet.</p>
        )}
        {stateVendors.map((vendor) => (
          <div key={vendor} className="mb-4 last:mb-0">
            <h3 className="text-sm font-semibold text-gray-700 mb-1 capitalize">{vendor}</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="py-2">Step</th>
                  <th>Consecutive fails</th>
                  <th>Alerted at</th>
                  <th>Last failure</th>
                  <th>Last recovered</th>
                  <th>Last error</th>
                </tr>
              </thead>
              <tbody>
                {stateByVendor.get(vendor)!.map((s: any) => (
                  <tr key={String(s._id)} className="border-b">
                    <td className="py-2 font-mono">{s.stepName ?? String(s._id)}</td>
                    <td className={s.consecutiveFailures > 0 ? "text-red-600" : ""}>
                      {s.consecutiveFailures || 0}
                    </td>
                    <td>{fmtTs(s.alertedAt)}</td>
                    <td>{fmtTs(s.lastFailureAt)}</td>
                    <td>{fmtTs(s.lastRecoveredAt)}</td>
                    <td className="text-xs text-red-600 max-w-md truncate">{s.lastError || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <div className="bg-white shadow rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Recent runs (last 50)</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="py-2">When</th>
              <th>Result</th>
              <th>Duration</th>
              <th>Step latencies (ms) by vendor</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr><td colSpan={4} className="py-3 text-gray-400">No runs yet.</td></tr>
            )}
            {runs.map((r: any, i: number) => (
              <tr key={i} className="border-b align-top">
                <td className="py-2 font-mono text-xs">{fmtTs(r.ts)}</td>
                <td className={r.ok ? "text-green-600" : "text-red-600"}>{r.ok ? "ok" : "FAIL"}</td>
                <td>{r.durationMs} ms</td>
                <td className="font-mono text-xs">
                  {runVendors(r).map((v: any) => (
                    <div key={v.provider} className="mb-1">
                      <span className={`font-semibold capitalize ${v.ok ? "text-gray-700" : "text-red-600"}`}>
                        {v.provider}:
                      </span>{" "}
                      {(v.steps || []).map((s: any) => (
                        <span key={s.name} className={s.ok ? "text-gray-600" : "text-red-600 font-bold"}>
                          {s.name}={s.latencyMs}{!s.ok ? "✗" : ""}{" "}
                        </span>
                      ))}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
