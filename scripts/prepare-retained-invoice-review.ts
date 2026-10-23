/**
 * Offline only; no database or provider connections. See the operator runbook.
 * The output contains private source-derived data: keep it under ignored storage.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { prepareRetainedInvoiceReview } from "../lib/invoice-repair/retained-invoice-review";

try {
  const [planPath, retainedPath, targetPath, outputPath, ...extra] = process.argv.slice(2);
  if (!planPath || !retainedPath || !targetPath || !outputPath || extra.length)
    throw Error("Expected plan, retained document, target projection, output");
  const output = resolve(outputPath);
  if (!output.startsWith(resolve("generated-artifacts/reporting-snapshots") + sep))
    throw Error("Output must remain in private ignored snapshot storage");
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const review = prepareRetainedInvoiceReview(read(planPath), read(retainedPath), read(targetPath));
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, JSON.stringify(review, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ prepared: true, executionReady: false, counts: review.counts }));
} catch {
  // Parse/adapter errors can contain source data. Never print raw exceptions.
  console.error("Review preparation rejected; verify private input evidence. No writes to databases performed.");
  process.exitCode = 1;
}
