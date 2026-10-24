import React from "react";
import { createRoot } from "react-dom/client";
import { StickerSupply } from "../../components/stickers/StickerSupply";
import Shops from "../../app/platform-admin/shops/page";
createRoot(document.getElementById("root")!).render(location.pathname === "/shops" ? <Shops /> :
  <main style={{ maxWidth: 720, margin: "40px auto", padding: 20 }}><h1>Sticker settings — isolated fixture</h1><StickerSupply manage /></main>);
