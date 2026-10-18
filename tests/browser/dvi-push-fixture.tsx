import React from "react";
import { createRoot } from "react-dom/client";
import DviPushNotice from "../../components/auto-dvi/DviPushNotice";
import { publicDviPushOutcome, DVI_PUSH_UNCERTAIN_MESSAGE } from "../../lib/auto-dvi/push-outcome";

const scenarios = [
  ["Package acknowledged; findings unconfirmed", publicDviPushOutcome({
    packageStatus: "acknowledged", resultsStatus: "uncertain", readBackStatus: "not_performed",
  }).message],
  ["Provider acknowledged; local activity record lost", publicDviPushOutcome({
    packageStatus: "acknowledged", resultsStatus: "acknowledged", readBackStatus: "not_performed",
  }, false).message],
  ["Response lost after submission", DVI_PUSH_UNCERTAIN_MESSAGE],
];
createRoot(document.getElementById("root")!).render(<main>
  <h1>Auto DVI write-status fixtures</h1>
  <p>Offline only — no provider or database connections.</p>
  {scenarios.map(([title, message]) => <section key={title}>
    <h2>{title}</h2>
    <DviPushNotice message={message!} needsVerification />
    <button disabled>Write inspection to open RO</button>
  </section>)}
</main>);
