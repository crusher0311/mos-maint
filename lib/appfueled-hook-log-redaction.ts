/**
 * Process-local last line of defence for AppFueled URL webhook credentials.
 *
 * This intentionally patches only Node's global console. It must be installed
 * before Next begins writing access logs; logs emitted by a proxy or platform
 * before they reach this process are outside of its control.
 */

const { redactAppFueledHookLogText: redactText } = require(
  "./appfueled-hook-log-redaction-core.cjs"
) as {
  redactAppFueledHookLogText: (value: string) => string;
};
const INSTALLED_FLAG = Symbol.for("mos.appFueledHookLogRedactionInstalled");
const CUSTOM_INSPECT = Symbol.for("nodejs.util.inspect.custom");
const MAX_VISITED_OBJECTS = 1_000;
const MAX_DEPTH = 12;
const OMITTED_VALUE = "[Log value omitted by bounded redaction]";

function disableCustomInspect(value: object): void {
  try {
    Object.defineProperty(value, CUSTOM_INSPECT, {
      value: undefined,
      configurable: true,
    });
  } catch {
    // A fresh clone is normally extensible; continue safely if an exotic
    // runtime disagrees.
  }
}

export function redactAppFueledHookLogText(value: string): string {
  return redactText(value);
}

/**
 * Copy values used in console calls instead of changing a caller-owned Error
 * or object. Descriptor reads avoid invoking arbitrary getters while retaining
 * normal object/error inspection, including Error.message and Error.stack.
 */
function redactValue(
  value: unknown,
  state: { seen: WeakMap<object, unknown>; remaining: number },
  depth: number,
): unknown {
  if (depth > MAX_DEPTH || state.remaining <= 0) return OMITTED_VALUE;
  state.remaining--;
  if (typeof value === "string") return redactAppFueledHookLogText(value);
  if (value === null || typeof value !== "object") return value;

  const objectValue = value as object;
  const prior = state.seen.get(objectValue);
  if (prior) return prior;

  // URL's visible fields are accessors backed by internal slots. Converting a
  // URL to its redacted href is safer than cloning an object with invalid slots.
  if (typeof URL !== "undefined" && value instanceof URL) {
    return redactAppFueledHookLogText(value.href);
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    disableCustomInspect(copy);
    state.seen.set(objectValue, copy);
    for (const item of value) {
      if (state.remaining <= 0) {
        copy.push(OMITTED_VALUE);
        break;
      }
      copy.push(redactValue(item, state, depth + 1));
    }
    return copy;
  }

  if (value instanceof Map) {
    const copy = new Map();
    disableCustomInspect(copy);
    state.seen.set(objectValue, copy);
    for (const [key, item] of value) {
      if (state.remaining <= 0) {
        copy.set(OMITTED_VALUE, OMITTED_VALUE);
        break;
      }
      copy.set(
        redactValue(key, state, depth + 1),
        redactValue(item, state, depth + 1),
      );
    }
    return copy;
  }

  if (value instanceof Set) {
    const copy = new Set();
    disableCustomInspect(copy);
    state.seen.set(objectValue, copy);
    for (const item of value) {
      if (state.remaining <= 0) {
        copy.add(OMITTED_VALUE);
        break;
      }
      copy.add(redactValue(item, state, depth + 1));
    }
    return copy;
  }

  // Buffers can be logged directly and may contain a textual request URL.
  // Preserve their type/content when no URL is present.
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    const text = value.toString("utf8");
    const redacted = redactAppFueledHookLogText(text);
    return redacted === text ? value : Buffer.from(redacted, "utf8");
  }

  // Built-ins with internal slots do not expose loggable custom fields. Keep
  // them intact rather than creating a look-alike object with broken slots.
  if (value instanceof Date || value instanceof RegExp) return value;

  const copy = Object.create(Object.getPrototypeOf(value));
  disableCustomInspect(copy);
  state.seen.set(objectValue, copy);
  try {
    for (const key of Reflect.ownKeys(value)) {
      // Never execute caller-controlled custom inspection while handling a
      // console call. Normal own fields still retain their familiar prototype.
      if (key === CUSTOM_INSPECT) continue;
      if (state.remaining <= 0) {
        Object.defineProperty(copy, "__redactionLimit", {
          value: OMITTED_VALUE,
          enumerable: true,
        });
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if ("value" in descriptor) {
        descriptor.value = redactValue(descriptor.value, state, depth + 1);
      }
      Object.defineProperty(copy, key, descriptor);
    }
  } catch {
    // Do not let redaction itself suppress the original console call. The
    // partially copied value contains only descriptor-backed data processed so
    // far; accessors remain uninvoked.
  }
  return copy;
}

export function redactAppFueledHookLogValue(value: unknown): unknown {
  return redactValue(
    value,
    { seen: new WeakMap<object, unknown>(), remaining: MAX_VISITED_OBJECTS },
    0,
  );
}

export function redactAppFueledHookConsoleArguments(args: readonly unknown[]): unknown[] {
  const state = {
    seen: new WeakMap<object, unknown>(),
    remaining: MAX_VISITED_OBJECTS,
  };
  return args.map((arg) => redactValue(arg, state, 0));
}

/** Install once, before request handling and Next's access-log output. */
export function installAppFueledHookLogRedaction(): boolean {
  const target: any = console;
  if (target[INSTALLED_FLAG]) return true;

  // These are the callable output methods provided by Node's global console.
  // Patch every output shape (not just error/log) because Next may choose any
  // one for an access log depending on runtime and severity.
  const methods = [
    "log", "info", "debug", "warn", "error", "trace", "dir", "dirxml",
    "table", "assert", "group", "groupCollapsed", "groupEnd", "time",
    "timeLog", "timeEnd", "timeStamp", "count", "countReset", "clear",
    "profile", "profileEnd",
  ] as const;

  for (const method of methods) {
    const original = target[method];
    if (typeof original !== "function") continue;
    try {
      target[method] = function redactedConsoleMethod(...args: unknown[]) {
        return original.apply(target, redactAppFueledHookConsoleArguments(args));
      };
    } catch {
      // Some embedders may expose a non-writable console method. Continue
      // patching the methods they do permit rather than breaking startup.
    }
  }

  try {
    Object.defineProperty(target, INSTALLED_FLAG, { value: true });
  } catch {
    // Re-installing wrappers is harmlessly avoided in normal Node runtimes;
    // an unusual frozen console is still allowed to finish startup.
  }
  return true;
}