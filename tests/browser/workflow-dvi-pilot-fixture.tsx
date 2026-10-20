import React from "react";
import {createRoot} from "react-dom/client";
import {PilotInspectionPanel} from "../../components/shop-dispatch/PilotInspectionPanel";
createRoot(document.getElementById("root")!).render(
  <main><h1>CAR Experts synthetic inspection — isolated fixture</h1>
    <PilotInspectionPanel visitId="visit-one" shopId={66} evidenceRevision={1} blocked={false} />
  </main>);
