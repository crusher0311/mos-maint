/**
 * Minimal structured logger.
 *
 * Emits one JSON object per line so logs are greppable / shippable, while
 * staying dependency-free. Level is controlled by the LOG_LEVEL env var
 * (debug | info | warn | error), defaulting to "info".
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function envLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function write(
  level: LogLevel,
  minLevel: LogLevel,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(fields || {}),
  };
  const line = JSON.stringify(entry, (_key, value) =>
    value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack }
      : value,
  );
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export function createLogger(minLevel: LogLevel = envLevel()): Logger {
  return {
    debug: (m, f) => write("debug", minLevel, m, f),
    info: (m, f) => write("info", minLevel, m, f),
    warn: (m, f) => write("warn", minLevel, m, f),
    error: (m, f) => write("error", minLevel, m, f),
  };
}

/** Shared default logger instance. */
export const logger = createLogger();
