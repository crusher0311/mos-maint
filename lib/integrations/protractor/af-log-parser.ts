/**
 * Parser for AppFueled's public Protractor callback log.
 *
 * URL: https://cron.instantautosite.org/autosoftware_cron/primary/protractor/request_log.txt
 *
 * Format: PHP `print_r` style blocks separated by blank lines. Each block:
 *
 *   Timestamp: 2026-05-22 07:43:58
 *   method: GET
 *   Array
 *   (
 *       [connectionId] => 8f223ccd57e24eb8ad975422855f6860
 *       [apiKey]       => 8d23f8f7abd84b76916c4daaebf29b64
 *       [type]         => WorkOrder
 *       [id]           => 053e30c6-8e1b-404f-ae58-a6afbf9f1e5d
 *       [operation]    => Update
 *   )
 *
 * Each real Protractor delivery appears TWICE: once with `method: GET PRE CHECK`
 * (HEAD-style probe) and once with `method: GET` (the real delivery). We only
 * count the latter so a single WO update doesn't trigger two of our fetches.
 *
 * AF's log timestamps have no timezone marker. Empirically they line up with
 * UTC delivery times in our own historical callback events for the same
 * connectionIds (cross-checked 2026-05-22), so we treat them as UTC.
 *
 * Background: AF (instantautosite.org) is a separate vendor sharing many of
 * the same Protractor shops as us. After Protractor's webhook delivery to our
 * endpoint broke on 2026-05-15 00:42 UTC, this log became our only real-time
 * signal for the ~10 shops we share with AF. See app/api/cron/protractor-af-log-tail/.
 */

export interface AfLogEvent {
  /** UTC Date parsed from the `Timestamp:` header. */
  timestamp: Date;
  connectionId: string;
  apiKey: string;
  type: string;
  objectId: string;
  operation: string;
}

/**
 * Parse the raw AF log body into events.
 *
 * - Skips `PRE CHECK` blocks (the HEAD-style probe Protractor sends ~1ms
 *   before the real delivery; we only want one event per real WO change).
 * - Skips blocks missing any required field.
 * - Events are returned in file order (oldest first).
 */
export function parseAfLog(body: string): AfLogEvent[] {
  const events: AfLogEvent[] = [];
  // Blocks are separated by one or more blank lines.
  const blocks = body.split(/\n\s*\n/);

  for (const block of blocks) {
    const tsMatch = block.match(/Timestamp:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
    const methodMatch = block.match(/method:\s*(.+)/);
    if (!tsMatch || !methodMatch) continue;

    const method = methodMatch[1].trim();
    if (method.includes("PRE CHECK")) continue; // skip probe, keep only real delivery

    const cidMatch = block.match(/\[connectionId\]\s*=>\s*(\S+)/);
    const apiKeyMatch = block.match(/\[apiKey\]\s*=>\s*(\S+)/);
    const typeMatch = block.match(/\[type\]\s*=>\s*(\S+)/);
    const idMatch = block.match(/\[id\]\s*=>\s*(\S+)/);
    const opMatch = block.match(/\[operation\]\s*=>\s*(\S+)/);
    if (!cidMatch || !apiKeyMatch || !typeMatch || !idMatch || !opMatch) continue;

    // Treat AF timestamps as UTC — see file header note.
    const timestamp = new Date(`${tsMatch[1]}T${tsMatch[2]}Z`);
    if (Number.isNaN(timestamp.getTime())) continue;

    events.push({
      timestamp,
      connectionId: cidMatch[1],
      apiKey: apiKeyMatch[1],
      type: typeMatch[1],
      objectId: idMatch[1],
      operation: opMatch[1],
    });
  }

  return events;
}
