// Generate CSS only for the offline fixture from real shared-modal classes.
const fs = require("node:fs");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
(async () => {
  const result = await postcss([tailwind()]).process(
    '@import "tailwindcss" source(none); @source "../../components/NewWorkOrderModal.tsx"; @source "../../components/RORecoveryPanel.tsx";',
    { from: "tests/shop-dispatch-browser/new-ro-input.css" },
  );
  fs.writeFileSync("tests/shop-dispatch-browser/new-ro.css", result.css);
})().catch(error => { console.error(error); process.exitCode = 1; });
