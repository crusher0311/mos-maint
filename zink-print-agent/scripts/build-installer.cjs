const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
if (process.argv.slice(2).some(arg => arg !== "--diagnostic")) throw Error("Unsupported installer build argument");
const diagnostic = process.argv.includes("--diagnostic");
const output = path.resolve(root, diagnostic ? "../generated-artifacts/mos-print-diagnostic-installer" : "../generated-artifacts/mos-print-installer");
fs.mkdirSync(output, { recursive: true });
execFileSync("npm", ["run", "package:win:pilot"], { cwd: root, stdio: "inherit" });
execFileSync("makensis", [`-DMOS_INSTALLER_OUTPUT=${path.join(output, "MOS-Print-Setup-pilot.exe")}`, "installer.nsi"], { cwd: path.join(root, "installer"), stdio: "inherit" });
const crypto = require("node:crypto");
const bytes = fs.readFileSync(path.join(output, "MOS-Print-Setup-pilot.exe"));
fs.writeFileSync(path.join(output, "pairing-release.json"), JSON.stringify({
  release: diagnostic ? "windows-x64-pairing-diagnostic-v1" : "windows-x64-pairing-v1",
  sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  createdAt: new Date().toISOString(), signed: false,
}, null, 2));
console.log("Unsigned pilot installer built. Windows/hardware validation and signing are required before production distribution.");
