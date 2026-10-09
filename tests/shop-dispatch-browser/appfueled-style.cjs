// Generate fixture-only CSS from the actual component's Tailwind classes.
const fs = require("node:fs");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
(async () => {
  const result = await postcss([tailwind()]).process(
    '@import "tailwindcss" source(none); @source "../../app/platform-admin/partner-keys/appfueled-connections.tsx";',
    { from: "tests/shop-dispatch-browser/appfueled-input.css" },
  );
  fs.writeFileSync("tests/shop-dispatch-browser/appfueled.css", result.css);
})().catch(e => { console.error(e); process.exitCode = 1; });
