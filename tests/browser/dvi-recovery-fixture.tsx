import React from "react";
import { createRoot } from "react-dom/client";
import RecoveryClient from "../../app/dashboard/auto-dvi-recovery/RecoveryClient";

// Isolated visual fixture only: never imports auth, storage or provider code.
createRoot(document.getElementById("root")!).render(<main>
  <h1>Auto DVI recovery</h1>
  <p>Offline component preview. No provider connection or recovery authority.</p>
  <RecoveryClient />
</main>);
