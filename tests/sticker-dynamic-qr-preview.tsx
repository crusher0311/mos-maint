// Offline rendering fixture: imports only the real settings control, never app
// startup, credentials, Mongo, authentication, or provider clients.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "node:http";
import StickerScanDestinationSetting from "../components/stickers/StickerScanDestinationSetting";

const html = renderToStaticMarkup(
  <html><head><title>Sticker settings — offline fixture</title><style>{`
    body{font:14px system-ui;background:#f9fafb;color:#111827;padding:32px}
    main{max-width:540px;margin:auto;background:white;border:1px solid #e5e7eb;border-radius:12px;padding:24px}
    label{display:block;font-weight:500;margin-bottom:4px;color:#374151}
    select,input{box-sizing:border-box;width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;background:white;font:inherit}
    p{color:#6b7280;line-height:1.6}
  `}</style></head><body><main><h1>Sticker settings</h1>
    <StickerScanDestinationSetting value="vhi" onChange={() => {}} />
    <label htmlFor="booking">Appointment URL</label><input id="booking" defaultValue="https://booking.example.test" />
    <p>Offline preview of the actual settings control.</p>
  </main></body></html>,
);
createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(`<!doctype html>${html}`); })
  .listen(3003, "0.0.0.0", () => console.log("Offline sticker settings fixture on 3003"));
