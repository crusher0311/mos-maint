import React from "react";
import { createRoot } from "react-dom/client";
import IntegrationsPage from "../../app/dashboard/settings/integrations/page";

// Browser-only fake: never forwards requests to the application or CARFAX.
(window as any).carfaxMode = new URLSearchParams(location.search).get("mode") || "ok";
(window as any).maintenanceEnabled = false;
window.fetch = async (url: any, init: any = {}) => {
  if (url !== "/api/settings/carfax") return Response.json({});
  const mode = (window as any).carfaxMode;
  if (mode === "network") throw Error("private network");
  if (mode === "gateway") return new Response("<html>private proxy</html>", { status: 502 });
  if (mode === "session") return new Response("private login", { status: 401 });
  if (mode === "denied") return new Response("Feature not enabled", { status: 403 });
  if (mode === "json") return Response.json({ error: "private internals" }, { status: 500 });
  if (init.method === "POST") localStorage.setItem("carfax-location", JSON.parse(init.body).locationId.trim());
  if (init.method === "DELETE") localStorage.removeItem("carfax-location");
  return Response.json({ ok: true, locationId: localStorage.getItem("carfax-location") || "", maintenanceEnabled: (window as any).maintenanceEnabled });
};
createRoot(document.getElementById("root")!).render(<IntegrationsPage />);
