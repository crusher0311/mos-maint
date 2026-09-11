import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Interactive transport is deliberately a request-scoped capability rather
 * than a property of a Protractor call.  Route handlers establish this scope
 * only after authenticating and resolving the requested shop; the transport
 * client never creates one from options or headers.
 *
 * Keep the maximum lifetime bounded as a second line of defence for a handler
 * that never settles.  The normal (and important) cleanup path is the
 * `finally` below: AsyncLocalStorage propagates into timers and promises that
 * a handler detaches, so the mutable `active` bit makes those inherited
 * contexts unusable once the request promise has completed.
 */
export const PROTRACTOR_INTERACTIVE_CONTEXT_MAX_DURATION_MS = 120_000;

export interface ProtractorInteractiveTransportContext {
  readonly shopId: number;
  readonly expiresAtMs: number;
  /**
   * Backed by private mutable state.  ALS children retain this same object
   * after the request promise settles, and must observe that it is closed.
   */
  readonly active: boolean;
}

const interactiveTransportStorage =
  new AsyncLocalStorage<ProtractorInteractiveTransportContext>();
const activeState = new WeakMap<
  ProtractorInteractiveTransportContext,
  { value: boolean }
>();

function closeInteractiveTransportContext(
  context: ProtractorInteractiveTransportContext,
): void {
  const state = activeState.get(context);
  if (state) state.value = false;
}

function isPositiveSafeShopId(shopId: number): boolean {
  return Number.isSafeInteger(shopId) && shopId > 0;
}

/**
 * Return the current request's interactive capability, if any.
 *
 * Callers must treat a returned context as untrusted until checking
 * `active`, its expiry, and the target shop.  Keeping this accessor separate
 * from the wrapper lets the final shared transport admission re-check all
 * three immediately before dispatch.
 */
export function getProtractorInteractiveTransportContext():
  ProtractorInteractiveTransportContext | undefined {
  const context = interactiveTransportStorage.getStore();
  if (!context) return undefined;
  if (!context.active || Date.now() >= context.expiresAtMs) {
    closeInteractiveTransportContext(context);
    return context;
  }
  return context;
}

/**
 * Establish a shop-bound interactive transport scope for one authenticated
 * request.  The scope is closed when `work` settles, including rejection, and
 * inherited detached async work observes the closed mutable context.
 */
export async function runWithProtractorInteractiveTransport<T>(
  shopId: number,
  work: () => Promise<T>,
): Promise<T> {
  if (!isPositiveSafeShopId(shopId)) {
    throw new TypeError("Protractor interactive transport requires a positive safe shop ID");
  }
  if (typeof work !== "function") {
    throw new TypeError("Protractor interactive transport requires async work");
  }

  const context: ProtractorInteractiveTransportContext = {
    shopId,
    expiresAtMs: Date.now() + PROTRACTOR_INTERACTIVE_CONTEXT_MAX_DURATION_MS,
    active: true,
  };
  const state = { value: true };
  activeState.set(context, state);
  Object.defineProperty(context, "active", {
    enumerable: true,
    configurable: false,
    get: () => state.value,
  });
  // TypeScript's `readonly` protects reviewed callers at compile time; these
  // runtime descriptors also prevent a route from retargeting a live scope
  // through an accidental cast.
  Object.defineProperties(context, {
    shopId: { writable: false, configurable: false },
    expiresAtMs: { writable: false, configurable: false },
  });
  const expirationTimer = setTimeout(() => {
    closeInteractiveTransportContext(context);
  }, PROTRACTOR_INTERACTIVE_CONTEXT_MAX_DURATION_MS);
  expirationTimer.unref?.();

  return interactiveTransportStorage.run(context, async () => {
    try {
      return await work();
    } finally {
      closeInteractiveTransportContext(context);
      clearTimeout(expirationTimer);
    }
  });
}