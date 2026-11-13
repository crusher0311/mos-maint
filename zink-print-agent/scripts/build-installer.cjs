const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
fs.mkdirSync(path.resolve(root, "../generated-artifacts/mos-print-installer"), { recursive: true });
execFileSync("npm", ["run", "package:win:pilot"], { cwd: root, stdio: "inherit" });
execFileSync("makensis", ["installer.nsi"], { cwd: path.join(root, "installer"), stdio: "inherit" });
console.log("Unsigned pilot installer built. Windows/hardware validation and signing are required before production distribution.");
