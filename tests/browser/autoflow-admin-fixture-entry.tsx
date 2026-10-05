import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AutoflowNumbersPage from "../../app/platform-admin/autoflow-numbers/page";

const root = document.getElementById("root");
if (!root) throw new Error("fixture root missing");
createRoot(root).render(
  <StrictMode>
    <AutoflowNumbersPage />
  </StrictMode>,
);