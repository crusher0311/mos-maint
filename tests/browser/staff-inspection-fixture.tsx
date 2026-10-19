import React from "react";
import {createRoot} from "react-dom/client";
import {StaffInspectionPanel} from "../../components/shop-dispatch/StaffInspectionPanel";
createRoot(document.getElementById("root")!).render(<main style={{maxWidth: 1180, margin: "24px auto"}}>
  <h1>Shop Workflow — isolated staff inspection</h1>
  <p>Synthetic visit. Local persistent test database only. No providers or customer release.</p>
  <section><h2>Customer concern</h2><p>Check tire condition before a road trip.</p></section>
  <StaffInspectionPanel shopId={1} visitId="visit-one" />
</main>);
