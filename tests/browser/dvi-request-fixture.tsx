import React from "react";
import { createRoot } from "react-dom/client";
import AutoDviPanel from "../../app/dashboard/vehicles/[vin]/plan/AutoDviPanel";
createRoot(document.getElementById("root")!).render(
  <AutoDviPanel vin="1HGCM82633A004352" mileage={100000} isProtractor />,
);
