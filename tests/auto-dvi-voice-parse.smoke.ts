// Task #991 — Auto DVI voice parsing/matching smoke tests (pure logic, no
// server-only imports). Run: npm run test:auto-dvi-voice (tsx).

import {
  matchVoiceFindings,
  parseChecklistParam,
  normalizeVoiceName,
  voiceSlug,
  buildVoiceStructuringPrompt,
  type VoiceChecklistItem,
} from "../lib/auto-dvi/voice-parse";
import { isInspectOnlyHistoryPhrase } from "../lib/service-keys";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const checklist: VoiceChecklistItem[] = [
  { itemId: "vhi:engine_oil", name: "Engine Oil & Filter", serviceKey: "oil" },
  { itemId: "vhi:brake_fluid", name: "Brake Fluid", serviceKey: "brake_fluid" },
  { itemId: "shop:battery-1", name: "Battery & Terminals", serviceKey: null },
  { itemId: "shop:wipers", name: "Wiper Blades", serviceKey: null },
];

console.log("matchVoiceFindings — exact checklist name match");
{
  const { findings } = matchVoiceFindings(
    {
      language: "Spanish",
      findings: [
        { component: "Engine Oil & Filter", rating: "red", notes: "Very dark, overdue", recommendation: "Change soon" },
        { component: "brake fluid", rating: "yellow", notes: null, recommendation: null },
      ],
    },
    checklist,
  );
  check("both matched to existing items", findings.length === 2 && findings.every((f) => f.matched));
  check("ids preserved", findings[0].itemId === "vhi:engine_oil" && findings[1].itemId === "vhi:brake_fluid");
  check("rating/notes carried", findings[0].rating === "red" && findings[0].notes === "Very dark, overdue");
}

console.log("matchVoiceFindings — service-key match on paraphrase");
{
  const { findings } = matchVoiceFindings(
    { findings: [{ component: "oil change", rating: "yellow", notes: null, recommendation: null }] },
    checklist,
  );
  check("paraphrase resolves via service key", findings.length === 1 && findings[0].itemId === "vhi:engine_oil" && findings[0].matched);
}

console.log("matchVoiceFindings — novel component becomes ad-hoc item");
{
  const { findings } = matchVoiceFindings(
    { findings: [{ component: "Rear differential mount bushing", rating: "red", notes: "Cracked", recommendation: "Replace" }] },
    checklist,
  );
  check("unmatched", findings.length === 1 && !findings[0].matched);
  check("voice: id", findings[0].itemId.startsWith("voice:"));
  check("line title anchor-safe", isInspectOnlyHistoryPhrase(findings[0].lineTitle), findings[0].lineTitle);
  check("line title has no performed verb", !/replace|install|service/i.test(findings[0].lineTitle), findings[0].lineTitle);
  check("ad-hoc title keeps spoken name", findings[0].lineTitle.toLowerCase().includes("bushing"), findings[0].lineTitle);
}

console.log("matchVoiceFindings — duplicate dictation merges");
{
  const { findings } = matchVoiceFindings(
    {
      findings: [
        { component: "Battery & Terminals", rating: null, notes: "corrosion on positive", recommendation: null },
        { component: "battery terminals", rating: "yellow", notes: "clamp loose", recommendation: "clean terminals" },
      ],
    },
    checklist,
  );
  const battery = findings.filter((f) => f.itemId === "shop:battery-1");
  check("merged into one finding", battery.length === 1 && findings.length === 1);
  check("later rating fills empty", battery[0]?.rating === "yellow");
  check("notes concatenated", (battery[0]?.notes || "").includes("corrosion") && (battery[0]?.notes || "").includes("clamp"));
}

console.log("matchVoiceFindings — malformed model output never throws");
{
  check("null", matchVoiceFindings(null, checklist).findings.length === 0);
  check("garbage findings", matchVoiceFindings({ findings: [null, 42, { rating: "red" }, { component: "" }] }, checklist).findings.length === 0);
  check("bad rating dropped to null", matchVoiceFindings({ findings: [{ component: "Wiper Blades", rating: "purple" }] }, checklist).findings[0].rating === null);
  const many = matchVoiceFindings(
    { findings: Array.from({ length: 100 }, (_, i) => ({ component: `Unique part ${i}` })) },
    checklist,
  );
  check("finding cap enforced", many.findings.length <= 60, String(many.findings.length));
}

console.log("matchVoiceFindings — language passthrough");
{
  check("language string", matchVoiceFindings({ language: "  Portuguese ", findings: [] }, checklist).language === "Portuguese");
  check("missing language null", matchVoiceFindings({ findings: [] }, checklist).language === null);
}

console.log("parseChecklistParam");
{
  const parsed = parseChecklistParam(JSON.stringify([{ itemId: "a", name: "Air Filter", serviceKey: "engine_air_filter" }, { itemId: 5, name: "bad" }, { name: "no id" }]));
  check("valid rows kept, invalid dropped", parsed.length === 1 && parsed[0].itemId === "a");
  check("bad JSON → empty", parseChecklistParam("{nope").length === 0);
  check("array input accepted", parseChecklistParam([{ itemId: "x", name: "Cabin Filter" }]).length === 1);
}

console.log("helpers");
{
  check("normalize", normalizeVoiceName("  Brake-Fluid   (DOT 3)! ") === "brake fluid dot 3");
  check("slug", voiceSlug("Rear Diff. Mount") === "rear-diff-mount");
  const prompt = buildVoiceStructuringPrompt(["Engine Oil & Filter"]);
  check("prompt includes checklist + JSON contract", prompt.includes("Engine Oil & Filter") && prompt.includes('"findings"'));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll voice-parse checks passed.");
