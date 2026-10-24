// Fixture-only browser verification. No server modules, secrets, databases or provider calls.
const http = require("node:http");
const esbuild = require("esbuild");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
async function main() {
  const files = ["components/vehicle-health-report/VehicleHealthReport.tsx", "components/vehicle-health-report/MileageUpdateForm.tsx"];
  const bundle = await esbuild.build({
    stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client";
      import Report from "./components/vehicle-health-report/VehicleHealthReport";
      function Fixture() {
        const [mileage,setMileage] = React.useState(50230);
        return <Report data={{vehicle:{year:2020,make:null,model:"Offline test vehicle",engine:null},
          vin:"1HGCM82633A004352",customerName:"Fixture",currentMiles:mileage,
          mileageEstimated:mileage===50230,distanceUnit:"miles",
          buckets:{overdue:[],dueSoon:[],upcoming:[]}}}
          score={100} shopName="Offline Shop" onUpdateMileage={async n=>{if(n<mileage)throw Error("Mileage cannot go backwards.");setMileage(n)}} />;
      } createRoot(document.getElementById("root")).render(<Fixture/>);`,
      resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
  });
  const css = await postcss([tailwind()]).process('@import "tailwindcss" source(none);' + files.map(f => `@source "./${f}";`).join(""), { from: `${process.cwd()}/offline-preview.css` });
  http.createServer((req, res) => {
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); return res.end(bundle.outputFiles[0].text); }
    if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); return res.end(css.css); }
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  }).listen(5102, "0.0.0.0", () => console.log("Offline public report preview listening on 5102"));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
