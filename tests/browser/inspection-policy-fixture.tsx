import React from "react";
import {createRoot} from "react-dom/client";
import {SheetManager} from "../../components/shop-dispatch/SheetManager";

createRoot(document.getElementById("root")!).render(<main>
  <p>Isolated inspection settings · synthetic shop · no live services</p>
  <SheetManager />
</main>);
