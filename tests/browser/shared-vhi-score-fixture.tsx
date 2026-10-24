import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import VehicleHealthReport, { computeScore } from "../../components/vehicle-health-report/VehicleHealthReport";
import ScoreSimulator from "../../components/vehicle-health-report/ScoreSimulator";
import { base } from "../fixtures/shared-vhi-score";

function Fixture() {
  const [sufficient, setSufficient] = useState(false);
  const data = { ...base, dataQuality: { sufficient } };
  return <>
    <button onClick={() => setSufficient(v => !v)}>Fixture: toggle history eligibility</button>
    <VehicleHealthReport data={data} score={computeScore(data)} />
    <section className="max-w-2xl mx-auto bg-white">
      <h2>Standalone simulator guard</h2>
      <ScoreSimulator data={data} currentScore={computeScore(data)} />
    </section>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
