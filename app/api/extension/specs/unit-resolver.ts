/**
 * Task #491 — pure helpers for /api/extension/specs.
 *
 * Lives in its own module (no `server-only`, no Mongo, no DataOne) so
 * smoke tests can import the resolvers and the retry helper without
 * dragging in the full server runtime.
 */

export type UnitDisplay = "imperial" | "metric" | "both";

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export type SpecsUnitResolution = {
  distanceUnit: "miles" | "kilometers";
  unitDisplay: UnitDisplay;
};

/**
 * Decide which units the extension Specs tab should render in, given a
 * shop document. Precedence:
 *   1. Explicit shop-level `preferences.specsUnitDisplay` (the same
 *      "imperial" | "metric" | "both" knob task #331 introduced on the
 *      dashboard — read here so a shop can pin dual-unit output even
 *      when their main distance preference is one or the other).
 *   2. Derived from `preferences.distanceUnit` (with the legacy
 *      `settings.distanceUnit` fallback): km shops → metric, miles
 *      shops → imperial.
 *   3. Default to imperial when nothing is set.
 */
export function resolveSpecsUnitDisplayFromShop(shopDoc: any): SpecsUnitResolution {
  const rawDistance =
    shopDoc?.preferences?.distanceUnit ?? shopDoc?.settings?.distanceUnit;
  const distanceUnit: "miles" | "kilometers" =
    rawDistance === "kilometers" ? "kilometers" : "miles";

  const explicit = shopDoc?.preferences?.specsUnitDisplay;
  if (explicit === "imperial" || explicit === "metric" || explicit === "both") {
    return { distanceUnit, unitDisplay: explicit };
  }

  const unitDisplay: UnitDisplay = distanceUnit === "kilometers" ? "metric" : "imperial";
  return { distanceUnit, unitDisplay };
}

// ---- DataOne timeout + retry helper -----------------------------------------

export const DATAONE_CALL_TIMEOUT_MS = 8000;
export const DATAONE_BACKOFF_MS = 400;

export class DataOneCallError extends Error {
  readonly which: "specs" | "decode" | "both";
  readonly elapsedMs: number;
  readonly cause: unknown;
  constructor(which: "specs" | "decode" | "both", elapsedMs: number, cause: unknown) {
    super(
      `DataOne call failed (${which}, ${elapsedMs}ms): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "DataOneCallError";
    this.which = which;
    this.elapsedMs = elapsedMs;
    this.cause = cause;
  }
}

export type DataOneCallers<S, D, H> = {
  getSpecs: (vin: string, hint?: H) => Promise<S>;
  decode: (vin: string, hint?: H) => Promise<D>;
};

export type DataOnePair<S, D> = { specsResult: S; decodeResult: D; elapsedMs: number };

async function callOnce<S, D, H>(
  vin: string,
  hint: H | undefined,
  callers: DataOneCallers<S, D, H>,
): Promise<DataOnePair<S, D>> {
  const started = Date.now();
  try {
    const [specsResult, decodeResult] = await Promise.all([
      withTimeout(callers.getSpecs(vin, hint), DATAONE_CALL_TIMEOUT_MS, "getVehicleSpecsLocal"),
      withTimeout(callers.decode(vin, hint), DATAONE_CALL_TIMEOUT_MS, "decodeVinLocal"),
    ]);
    return { specsResult, decodeResult, elapsedMs: Date.now() - started };
  } catch (err) {
    const elapsed = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    const which: "specs" | "decode" | "both" = msg.includes("getVehicleSpecsLocal")
      ? "specs"
      : msg.includes("decodeVinLocal")
      ? "decode"
      : "both";
    throw new DataOneCallError(which, elapsed, err);
  }
}

/**
 * Single retry with short backoff. Exposed so the smoke test can drive
 * it with mock callers and assert exactly one retry happens.
 */
export async function callDataOneWithRetry<S, D, H>(
  vin: string,
  hint: H | undefined,
  logCtx: { vin: string; hasHint: boolean },
  options: { callers: DataOneCallers<S, D, H>; backoffMs?: number },
): Promise<DataOnePair<S, D>> {
  const callers = options.callers;
  const backoffMs = options.backoffMs ?? DATAONE_BACKOFF_MS;
  try {
    return await callOnce(vin, hint, callers);
  } catch (firstErr) {
    if (firstErr instanceof DataOneCallError) {
      console.warn(
        `[Extension specs] DataOne first attempt failed (vin=${logCtx.vin}, hasHint=${logCtx.hasHint}, which=${firstErr.which}, elapsedMs=${firstErr.elapsedMs}): ${firstErr.cause instanceof Error ? firstErr.cause.message : String(firstErr.cause)} — retrying once`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      try {
        return await callOnce(vin, hint, callers);
      } catch (secondErr) {
        const e2 =
          secondErr instanceof DataOneCallError
            ? secondErr
            : new DataOneCallError("both", 0, secondErr);
        console.error(
          `[Extension specs] DataOne retry also failed (vin=${logCtx.vin}, hasHint=${logCtx.hasHint}, which=${e2.which}, elapsedMs=${e2.elapsedMs}): ${e2.cause instanceof Error ? e2.cause.message : String(e2.cause)}`,
        );
        throw e2;
      }
    }
    throw firstErr;
  }
}
