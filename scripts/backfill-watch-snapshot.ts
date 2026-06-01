/**
 * Read-only snapshot of Tekmetric full-page reindex progress.
 * Appends one timestamped summary line (+ giant detail) per run.
 * Safe to run anytime: no writes, only counts/finds.
 */
import { getDb } from "../lib/mongo";

(async () => {
  const db = await getDb();
  const c = db.collection("tekmetric_backfill_progress");
  const now = Date.now();

  const flagged = await c
    .find({ fullPageMode: true, completed: { $ne: true } })
    .project({
      shopId: 1,
      prePassNextPage: 1,
      prePassTotalPages: 1,
      prePassDone: 1,
      fullPageNextPage: 1,
      lastPrePassRunAt: 1,
      lastFullPageRunAt: 1,
    })
    .toArray();

  const completed = await c.countDocuments({
    fullPageMode: true,
    completed: true,
  });
  const totalFullPage = await c.countDocuments({ fullPageMode: true });

  let neverStarted = 0;
  let inPrePass = 0;
  let inRoLoop = 0;
  let touched1h = 0;
  const giants: any[] = [];

  for (const d of flagged as any[]) {
    const ppRun = d.lastPrePassRunAt ? new Date(d.lastPrePassRunAt).getTime() : 0;
    const fpRun = d.lastFullPageRunAt ? new Date(d.lastFullPageRunAt).getTime() : 0;
    const touched = Math.max(ppRun, fpRun);
    if (touched && now - touched < 3600_000) touched1h++;

    if (d.prePassDone) inRoLoop++;
    else if (ppRun) inPrePass++;
    else neverStarted++;

    if ((d.prePassTotalPages || 0) >= 1500) {
      giants.push({
        shop: d.shopId,
        pp: `${d.prePassNextPage || 0}/${d.prePassTotalPages}`,
        done: !!d.prePassDone,
        lastRunMinAgo: ppRun ? Math.round((now - ppRun) / 60000) : null,
      });
    }
  }

  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(
    `[${ts}Z] fullPage total=${totalFullPage} completed=${completed} stillFlagged=${flagged.length} | neverStarted=${neverStarted} inPrePass=${inPrePass} inRoLoop(prepassDone)=${inRoLoop} | shopsTouchedLastHour=${touched1h}`,
  );
  for (const g of giants) {
    console.log(
      `    giant shop ${g.shop}: prepass page ${g.pp} done=${g.done} lastRun=${g.lastRunMinAgo}min ago`,
    );
  }
  process.exit(0);
})().catch((e: any) => {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.error(`[${ts}Z] snapshot error: ${e?.message || e}`);
  process.exit(1);
});
