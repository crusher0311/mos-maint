import { createRoot } from "react-dom/client";
import { useState } from "react";
import EnterpriseVehicleHistory from "../enterprise-vehicle-history";
import VehicleHistorySharingSettings from "../vehicle-history-sharing-settings";

const cases = [
  { id: "evidence", label: "Performed A / declined B", vin: "1HGCM82633A004352" },
  { id: "partial", label: "Partial completion", vin: "1HGCM82633A004353" },
  { id: "empty", label: "Covered / no records", vin: "1HGCM82633A004354" },
  { id: "off", label: "Sharing off", vin: "1HGCM82633A004355" },
  { id: "unavailable", label: "API unavailable", vin: "1HGCM82633A004356" },
  { id: "slow", label: "Loading / race", vin: "1HGCM82633A004357" },
];

function Fixture() {
  const requested = new URLSearchParams(window.location.search).get("scenario");
  const [selected, setSelected] = useState(cases.find(item => item.id === requested) ?? cases[0]);
  const [mount, setMount] = useState(0);
  const view = new URLSearchParams(window.location.search).get("view") ?? "both";
  return <main className="fixture-shell">
    <header className="fixture-header">
      <p className="fixture-eyebrow">MOS · Isolated component fixture</p>
      <h1>Vehicle evidence & sharing</h1>
      <p>Real React components. Synthetic API responses only. No app bootstrap, auth bypass, database, or production settings.</p>
    </header>
    <nav aria-label="Fixture scenarios" className="fixture-controls">
      {cases.map(item => <button type="button" key={item.id} aria-pressed={selected.id === item.id} onClick={() => { setSelected(item); setMount(value => value + 1); }}>{item.label}</button>)}
      <button type="button" onClick={() => setMount(value => value + 1)}>Remount view</button>
    </nav>
    {view !== "settings" && <div className="fixture-context"><span>Current shop: Location A · Cedar Service</span><code>VIN {selected.vin}</code></div>}
    {view !== "settings" && <EnterpriseVehicleHistory key={`${selected.id}:${mount}`} vin={selected.vin} currentShopId={101} />}
    {view !== "history" && <VehicleHistorySharingSettings key={`settings:${mount}`} />}
    <footer className="fixture-footer">Fixture server: loopback port 5010. Policy writes affect mock memory only; restarting resets sharing to off. Use <code>?view=history</code>, <code>?view=settings</code>, <code>?scenario=partial</code>, or <code>?role=viewer</code> for focused captures.</footer>
  </main>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root is missing");
createRoot(root).render(<Fixture />);
