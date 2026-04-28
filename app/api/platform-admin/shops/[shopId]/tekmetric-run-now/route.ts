import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { backfillShopChunk } from "@/app/api/cron/tekmetric-backfill/route";
import { runWithTekmetricApiCallTracking } from "@/lib/integrations/tekmetric/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Mirrors the cron POST handler so behaviour stays consistent: at most 25
// chunks per click, soft-stop at ~270s so we cleanly finish the in-flight
// chunk before the platform's 300s function timeout, 500ms breath between
// chunks. The difference vs the cron POST is that this endpoint streams a
// progress event per chunk so the on-call engineer sees jobs indexed climb
// in real time instead of waiting on a single popup at the very end.
const MAX_CHUNKS = 25;
const SOFT_TIMEOUT_MS = 270_000;
const INTER_CHUNK_DELAY_MS = 500;
const HEARTBEAT_INTERVAL_MS = 15_000;

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return jsonError(401, "Unauthorized");
  }

  const shopId = Number(params.shopId);
  if (isNaN(shopId)) {
    return jsonError(400, "Invalid shop ID");
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId });
  if (!shop) {
    return jsonError(404, "Shop not found");
  }
  const tekmetricShopIdRaw = shop.tekmetric?.shopId || shop.tekmetricShopId;
  if (!tekmetricShopIdRaw) {
    return jsonError(400, "Shop is not connected to Tekmetric");
  }
  const tekmetricShopId = Number(tekmetricShopIdRaw);

  console.log(
    `[Platform Admin] Tekmetric run-now (streaming) requested for shop ${shopId} by ${session.email}`
  );

  await db.collection("audit_logs").insertOne({
    type: "tekmetric_run_now",
    shopId,
    shopName: shop.name,
    adminEmail: session.email,
    createdAt: new Date(),
    streaming: true,
  });

  const encoder = new TextEncoder();
  const startTime = Date.now();
  const abortSignal = req.signal;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };
      const send = (event: string, payload: unknown) => {
        safeEnqueue(
          encoder.encode(
            `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
          )
        );
      };

      // Keep proxies (and the browser EventSource-style reader) from giving
      // up on the connection between long chunks. Some Tekmetric chunks can
      // run 60s+ when a window has thousands of ROs.
      const heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(`: ping\n\n`));
      }, HEARTBEAT_INTERVAL_MS);

      const cleanup = () => {
        clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };

      try {
        // Same AsyncLocalStorage scope the cron POST uses, so the per-run
        // tekmetricApiCalls counter we report belongs to *this* click only
        // and isn't polluted by a concurrent backfill in the same process.
        await runWithTekmetricApiCallTracking(async (apiCallCounter) => {
          let totalJobs = 0;
          let totalSkipped = 0;
          let totalNormalized = 0;
          let chunksProcessed = 0;
          let aborted = false;
          let completed = false;
          let timedOut = false;

          send("start", {
            shopId,
            shopName: shop.name || `Shop ${shopId}`,
            startedAt: new Date(startTime).toISOString(),
            maxChunks: MAX_CHUNKS,
            softTimeoutMs: SOFT_TIMEOUT_MS,
          });

          for (let i = 0; i < MAX_CHUNKS; i++) {
            if (abortSignal.aborted) {
              aborted = true;
              break;
            }

            const chunkStartedAt = Date.now();
            let result: Awaited<ReturnType<typeof backfillShopChunk>>;
            try {
              result = await backfillShopChunk(db, shopId, tekmetricShopId);
            } catch (err: any) {
              const message = err?.message ? String(err.message) : String(err);
              send("chunk_error", {
                index: chunksProcessed + 1,
                message: message.slice(0, 500),
                durationMs: Date.now() - chunkStartedAt,
                elapsedMs: Date.now() - startTime,
                tekmetricApiCalls: apiCallCounter.count,
              });
              break;
            }

            chunksProcessed++;
            totalJobs += result.jobsIndexed;
            totalSkipped += result.skipped;
            totalNormalized += result.normalizedCount;

            // Read the live progress doc so the UI can show the new cursor
            // position and any error/skip flags the chunk just persisted —
            // those aren't on the return value of backfillShopChunk.
            const progress = await db
              .collection("tekmetric_backfill_progress")
              .findOne(
                { shopId },
                {
                  projection: {
                    currentChunkEnd: 1,
                    lastError: 1,
                    lastErrorAt: 1,
                    totalJobsIndexed: 1,
                    consecutiveChunkErrors: 1,
                    lastRoSkipCount: 1,
                    lastChunkMetrics: 1,
                  },
                }
              );

            send("chunk", {
              index: chunksProcessed,
              jobsIndexed: result.jobsIndexed,
              skipped: result.skipped,
              normalizedCount: result.normalizedCount,
              complete: result.complete,
              message: result.message,
              chunkDurationMs: Date.now() - chunkStartedAt,
              cursor: progress?.currentChunkEnd
                ? new Date(progress.currentChunkEnd).toISOString()
                : null,
              lastError: progress?.lastError || null,
              lastErrorAt: progress?.lastErrorAt
                ? new Date(progress.lastErrorAt).toISOString()
                : null,
              consecutiveChunkErrors: progress?.consecutiveChunkErrors || 0,
              lastRoSkipCount: progress?.lastRoSkipCount || 0,
              cumulativeJobsIndexed: progress?.totalJobsIndexed ?? null,
              totals: {
                chunksProcessed,
                totalJobsIndexed: totalJobs,
                totalSkipped,
                totalNormalized,
              },
              tekmetricApiCalls: apiCallCounter.count,
              elapsedMs: Date.now() - startTime,
            });

            if (result.complete) {
              completed = true;
              break;
            }
            if (Date.now() - startTime > SOFT_TIMEOUT_MS) {
              timedOut = true;
              break;
            }

            // Same inter-chunk breath as the cron POST. Bail early if the
            // client has aborted so we don't sleep needlessly.
            if (abortSignal.aborted) {
              aborted = true;
              break;
            }
            await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS));
          }

          send("complete", {
            shopId,
            shopName: shop.name || `Shop ${shopId}`,
            aborted,
            completed,
            timedOut,
            chunksProcessed,
            totalJobsIndexed: totalJobs,
            totalSkipped,
            totalNormalized,
            durationMs: Date.now() - startTime,
            tekmetricApiCalls: apiCallCounter.count,
          });
        });
      } catch (err: any) {
        console.error(
          `[Platform Admin] Tekmetric run-now stream failed for shop ${shopId}:`,
          err
        );
        send("error", {
          message: err?.message || String(err),
          elapsedMs: Date.now() - startTime,
        });
      } finally {
        cleanup();
      }
    },
    cancel() {
      // The reader hung up. The interval and controller are cleaned up in
      // start()'s finally block once the chunk loop notices abortSignal.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable buffering on proxies (e.g. nginx) so each SSE frame is
      // flushed to the client as soon as it's written.
      "X-Accel-Buffering": "no",
    },
  });
}
