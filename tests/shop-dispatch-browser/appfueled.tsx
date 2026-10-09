// Offline fixture only; never imports server code or contacts a real API.
import React from "react";
import { createRoot } from "react-dom/client";
import AppFueledConnections from "../../app/platform-admin/partner-keys/appfueled-connections";
const rows = new Map<number, object>();
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  if (url.pathname !== "/api/platform-admin/appfueled-connections") throw new Error("Offline fixture blocked network");
  let id = Number(url.searchParams.get("shopId"));
  if (init?.method === "PUT" || init?.method === "PATCH") {
    const body = JSON.parse(String(init.body));
    id = body.shopId;
    rows.set(id, { shopId: id, configured: true, isActive: init.method === "PUT",
      createdAt: "2026-10-09T12:00:00Z", updatedAt: "2026-10-09T12:00:00Z",
      disabledAt: init.method === "PATCH" ? "2026-10-09T12:00:00Z" : null });
  }
  return Response.json({ success: true, connection: rows.get(id) || null });
};
createRoot(document.getElementById("root")!).render(<main style={{ maxWidth: 1000, margin: "24px auto", padding: 20 }}>
  <p>Offline admin UI fixture — synthetic credentials only; no live connections</p>
  <AppFueledConnections />
</main>);
