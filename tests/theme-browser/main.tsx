import React, { useState } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import LandingPage from "../../app/LandingPage";
import LoginForm from "../../app/login/LoginForm";
import PreferencesPage from "../../app/dashboard/settings/preferences/page";
import { PlatformAdminLayoutClient } from "../../components/ui/PlatformAdminLayoutClient";
import { CustomReportBuilder } from "../../app/dashboard/reporting/custom-report-builder";
import { AppearanceBar, ThemeProvider } from "../../components/theme/ThemeProvider";
import { themeBootstrap } from "../../components/theme/theme-runtime";
import "../../app/globals.css";

// This fixture imports real UI only. No server, authentication, stores or providers.
window.fetch = async (input) => {
  const url = String(input);
  if (!url.startsWith("/api/")) throw new Error(`Unexpected fixture request: ${url}`);
  const data = url === "/api/settings/preferences" ? { enterpriseShops: [] }
    : url.includes("/reports/") ? { reports: [], locations: [], status: "idle" }
    : { authenticated: true, shops: [], enabledFeatureIds: ["maintenance"], count: 0 };
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
};
// The browser suite also executes this exact bootstrap before document parsing.
if (!document.documentElement.dataset.theme) (0, eval)(themeBootstrap);

function Samples() {
  const [dialog, setDialog] = useState(false);
  return <main className="bg-gray-50 text-gray-900 p-8 space-y-4">
    <h1 className="text-2xl font-bold">Dashboard and report surfaces</h1>
    <section data-testid="card" className="bg-white border border-gray-200 rounded-xl p-6">
      <h2 className="text-gray-900">Vehicle service</h2><p className="text-gray-500">Readable supporting information</p>
      <input aria-label="Search vehicles" placeholder="Search" className="border border-gray-300 bg-white text-gray-900 p-2" />
      <table className="w-full"><thead className="bg-gray-100"><tr><th>Vehicle</th><th>Status</th></tr></thead>
        <tbody><tr className="border-b border-gray-200"><td>Fixture sedan</td><td><span className="bg-amber-50 text-amber-800 p-1">Waiting for parts</span></td></tr></tbody></table>
      <button className="bg-blue-600 text-white rounded p-2" onClick={() => setDialog(true)}>Open dialog</button>
    </section>
    <div className="bg-red-50 text-red-700 border border-red-200 p-4" role="alert">Example error state</div>
    {dialog && <div className="fixed inset-0 bg-black/50 flex items-center justify-center"><div role="dialog" aria-label="Service details" className="bg-white text-gray-900 rounded-xl p-8"><h2>Service details</h2><button onClick={() => setDialog(false)}>Close</button></div></div>}
  </main>;
}
function Fixture() {
  const view = new URLSearchParams(location.search).get("view");
  const content = view === "landing" ? <LandingPage />
    : view === "login" ? <main className="min-h-screen bg-gray-50 p-8"><div className="bg-white border border-gray-200 rounded-xl p-6 max-w-md mx-auto"><LoginForm /></div></main>
    : view === "preferences" ? <PreferencesPage />
    : view === "admin" ? <PlatformAdminLayoutClient userEmail="fixture@example.invalid"><Samples /></PlatformAdminLayoutClient>
    : view === "report" ? <main className="bg-gray-50 text-gray-900 p-8"><CustomReportBuilder scope={{ kind: "enterprise", enterpriseId: "fixture" }} /></main>
    : <Samples />;
  return <ThemeProvider><AppearanceBar />{content}</ThemeProvider>;
}
const root = document.getElementById("root")!;
if (new URLSearchParams(location.search).has("hydrate")) {
  // Server and first client markup must agree even though bootstrap chose dark.
  root.innerHTML = renderToString(<Fixture />);
  hydrateRoot(root, <Fixture />);
} else {
  createRoot(root).render(<Fixture />);
}
