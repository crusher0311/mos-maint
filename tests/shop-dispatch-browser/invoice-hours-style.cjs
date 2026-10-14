// Compile the real dashboard utility classes without starting Next or any DB.
const fs = require("node:fs/promises");
const path = require("node:path");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const { execFileSync } = require("node:child_process");
(async () => {
  const root = path.resolve(__dirname, "../..");
  execFileSync(process.execPath, ["--require", "./tests/helpers/deny-network-egress.cjs",
    "--require", "./scripts/_stubs/server-only-stub.cjs", "--import", "tsx",
    "tests/shop-dispatch-browser/invoice-population-fixtures.ts"], { cwd: root, stdio: "inherit" });
  const css = '@import "tailwindcss" source(none);\n@source "./app/dashboard/reporting";';
  const output = await postcss([tailwind({ base: root })]).process(css, { from: path.join(root, "invoice-fixture.css") });
  await fs.mkdir(path.join(root, "generated-artifacts"), { recursive: true });
  await fs.writeFile(path.join(root, "generated-artifacts/invoice-hours-fixture.css"), output.css);
})().catch(error => { console.error(error); process.exit(1); });
