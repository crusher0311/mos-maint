---
name: Interval-import PDF/image extraction paths
description: How PDF and photo uploads behave in the AI interval-import; text layer beats model PDF OCR
---

# Interval-import PDF/image extraction

- gpt-4o chat completions DOES accept PDFs as a `type:"file"` content part with a `file_data` data-URL (no Files API upload needed). Verified against the real OpenAI API (route uses direct `OPENAI_API_KEY`, not the Replit modelfarm proxy, because the direct key takes priority in `getOpenAIConfig`).
- **Model PDF OCR is lossier than a phone photo of the same content.** An image-only PDF sent as a file part produced deterministic transcription errors (missed lines, a note attached to the wrong service) while a noisy simulated phone photo of the identical page transcribed perfectly at `detail:"high"`. OpenAI appears to render PDF pages at lower effective resolution.
- **Rule:** digital PDFs (Word exports — the common case) carry a text layer; extract it server-side (unpdf) and use the plain-text prompt path, which is exactly as reliable as .docx. Only image-only/scanned PDFs (no/tiny text layer, threshold ~200 chars) should fall back to the model file part.
- **Why:** shops upload Word-exported PDFs and phone photos constantly; the text path avoids the model's PDF-render OCR loss and is cheaper (no page images).
- unpdf's `extractText({mergePages:true})` collapses line breaks to spaces; gpt-4o still segmented services correctly on a real guide, but a denser multi-column doc might not — preserve line breaks if that ever regresses.
- Testing routes without a session: dev server has `DEV_AUTO_LOGIN=true` (gated on `NODE_ENV=development`), so unauthenticated curls to `getSession()`-protected routes succeed as shop 1 in dev. Not a prod hole — but remember side effects (AI usage tracking, unmatched-name tallies) write to the shared/prod Mongo.
