const fs = require("node:fs");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
(async () => {
  fs.mkdirSync("generated-artifacts", { recursive: true });
  const result = await postcss([tailwind()]).process(
    '@import "tailwindcss" source(none); @source "../../components/stickers/StickerQrAppearanceSetting.tsx"; @source "./sticker-qr.tsx";',
    { from: "tests/shop-dispatch-browser/sticker-qr-input.css" },
  );
  fs.writeFileSync("generated-artifacts/sticker-qr-fixture.css", result.css);
  const QRCode = require("qrcode");
  await QRCode.toFile("generated-artifacts/sticker-qr.png", "https://offline.example.test/custom", { width: 300, margin: 4 });
})().catch(error => { console.error(error); process.exitCode = 1; });
