const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
fs.mkdirSync(path.resolve(root, "../generated-artifacts/mos-print-installer"), { recursive: true });
execFileSync("npm", ["run", "package:win:pilot"], { cwd: root, stdio: "inherit" });
execFileSync("makensis", ["installer.nsi"], { cwd: path.join(root, "installer"), stdio: "inherit" });
const crypto = require("node:crypto");
const output = path.resolve(root, "../generated-artifacts/mos-print-installer");
const bytes = fs.readFileSync(path.join(output, "MOS-Print-Setup-pilot.exe"));
fs.writeFileSync(path.join(output, "pairing-release.json"), JSON.stringify({
  release: "windows-x64-pairing-v1",
  sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  createdAt: new Date().toISOString(), signed: false,
}, null, 2));
console.log("Unsigned pilot installer built. Windows/hardware validation and signing are required before production distribution.");
