import React from "react";
import { createRoot } from "react-dom/client";
import { TireDotDashboard } from "../../app/dashboard/reporting/tire-dot-dashboard";
createRoot(document.getElementById("root")!).render(<main className="mos-reporting"><TireDotDashboard scope={{ kind: "enterprise", enterpriseId: "fixture" }} initialRange={{ start: "2024-08-14", end: "2024-08-14" }} /></main>);
