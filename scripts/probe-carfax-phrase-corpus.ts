/**
 * Task #819 — read-only corpus analysis of cached CARFAX reports.
 *
 * Samples the most recent cached `carfax_reports` docs and tallies every
 * distinct standardized CARFAX service phrase (per-record display lines,
 * split on "; " exactly like the matcher does, plus serviceCategories
 * names). For each phrase it reports:
 *   - corpus frequency,
 *   - whether `toKeyFromFreeText` resolves it today (and to which keys),
 *   - whether `findImpliesResetMatches` catches it,
 *   - whether the verb-guard classifies it inspect-only.
 *
 * Output: ranked list written to docs/carfax-phrase-corpus.md (misses
 * first) so the vocabulary mapping pass is data-driven.
 *
 * READ-ONLY. Run: `npx tsx scripts/probe-carfax-phrase-corpus.ts [sampleSize]`
 */

import fs from "fs";
import { getDb } from "../lib/mongo";
import {
  toKeyFromFreeText,
  findImpliesResetMatches,
  splitServicePhrases,
  isInspectOnlyHistoryPhrase,
} from "../lib/service-keys";
import { normalizeCarfaxDescription } from "../lib/carfax-match-log";

interface Tally {
  norm: string;
  sample: string;
  count: number;
  sources: Set<"record" | "category">;
  keys: string[];
  implied: string[];
  inspectOnly: boolean;
}

async function main() {
  const sampleSize = Number(process.argv[2]) || 400;
  const db = await getDb();

  const docs = await db
    .collection("carfax_reports")
    .find(
      { ok: true },
      {
        projection: {
          "raw.serviceHistory.displayRecords.text": 1,
          "raw.serviceHistory.displayRecords.type": 1,
          "raw.serviceHistory.serviceCategories.serviceName": 1,
          serviceRecords: 1,
          serviceCategories: 1,
        },
      },
    )
    .sort({ _id: -1 })
    .limit(sampleSize)
    .toArray();

  console.log(`Analyzed ${docs.length} cached CARFAX reports.`);

  const tally = new Map<string, Tally>();

  const add = (raw: string, source: "record" | "category") => {
    for (const phrase of splitServicePhrases(raw)) {
      const norm = normalizeCarfaxDescription(phrase);
      if (!norm) continue;
      let t = tally.get(norm);
      if (!t) {
        t = {
          norm,
          sample: phrase,
          count: 0,
          sources: new Set(),
          keys: toKeyFromFreeText(phrase),
          implied: Array.from(
            new Set(findImpliesResetMatches(phrase).map((m) => m.childKey)),
          ),
          inspectOnly: isInspectOnlyHistoryPhrase(phrase),
        };
        tally.set(norm, t);
      }
      t.count += 1;
      t.sources.add(source);
    }
  };

  for (const doc of docs as any[]) {
    // Per-record display lines (raw payload first, normalized fallback).
    const disp = doc?.raw?.serviceHistory?.displayRecords;
    if (Array.isArray(disp)) {
      for (const r of disp) {
        if (String(r?.type || "").toLowerCase() !== "service") continue;
        const texts = Array.isArray(r?.text) ? r.text : [r?.text];
        for (const t of texts) if (t) add(String(t), "record");
      }
    } else if (Array.isArray(doc?.serviceRecords)) {
      for (const r of doc.serviceRecords) {
        if (r?.description) add(String(r.description), "record");
      }
    }
    // Category rollup names.
    const cats = doc?.raw?.serviceHistory?.serviceCategories ?? doc?.serviceCategories;
    if (Array.isArray(cats)) {
      for (const c of cats) {
        const name = c?.serviceName;
        if (name) add(String(name), "category");
      }
    }
  }

  const all = Array.from(tally.values()).sort((a, b) => b.count - a.count);
  const misses = all.filter((t) => t.keys.length === 0 && t.implied.length === 0);
  const hits = all.filter((t) => t.keys.length > 0 || t.implied.length > 0);
  const missVolume = misses.reduce((s, t) => s + t.count, 0);
  const totalVolume = all.reduce((s, t) => s + t.count, 0);

  const lines: string[] = [];
  lines.push(`# CARFAX standardized-phrase corpus analysis`);
  lines.push(``);
  lines.push(`Generated ${new Date().toISOString()} from the ${docs.length} most recent cached CARFAX reports.`);
  lines.push(``);
  lines.push(`- Distinct phrases: **${all.length}**`);
  lines.push(`- Phrases resolving to a key (or implied reset) today: **${hits.length}**`);
  lines.push(`- Unmatched phrases: **${misses.length}** (${missVolume} of ${totalVolume} total occurrences, ${((100 * missVolume) / Math.max(1, totalVolume)).toFixed(1)}%)`);
  lines.push(``);
  lines.push(`## Unmatched phrases (ranked by frequency)`);
  lines.push(``);
  lines.push(`| # | Phrase | Count | Sources | Inspect-only |`);
  lines.push(`|---|--------|-------|---------|--------------|`);
  misses.forEach((t, i) => {
    lines.push(
      `| ${i + 1} | ${t.sample.replace(/\|/g, "\\|")} | ${t.count} | ${Array.from(t.sources).join(",")} | ${t.inspectOnly ? "yes" : ""} |`,
    );
  });
  lines.push(``);
  lines.push(`## Matched phrases (ranked by frequency)`);
  lines.push(``);
  lines.push(`| # | Phrase | Count | Keys | Implied | Inspect-only |`);
  lines.push(`|---|--------|-------|------|---------|--------------|`);
  hits.forEach((t, i) => {
    lines.push(
      `| ${i + 1} | ${t.sample.replace(/\|/g, "\\|")} | ${t.count} | ${t.keys.join(", ")} | ${t.implied.join(", ")} | ${t.inspectOnly ? "yes" : ""} |`,
    );
  });

  const outPath = "docs/carfax-phrase-corpus.md";
  fs.writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(`Wrote ${outPath}`);
  console.log(`Distinct: ${all.length}; matched: ${hits.length}; unmatched: ${misses.length} (${missVolume}/${totalVolume} occurrences).`);
  console.log(`Top 40 unmatched:`);
  for (const t of misses.slice(0, 40)) {
    console.log(`  ${String(t.count).padStart(6)}  ${t.sample}${t.inspectOnly ? "  [inspect-only]" : ""}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
