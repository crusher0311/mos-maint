import pino from 'pino';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

const isDev = process.env.NODE_ENV !== 'production';

const baseLogger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: isDev ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
    },
  } : undefined,
});

export interface RequestContext {
  correlationId: string;
  shopId?: number;
  userId?: string;
  endpoint?: string;
  method?: string;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

export function createCorrelationId(): string {
  return randomUUID().slice(0, 8);
}

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return asyncLocalStorage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}

export function getCurrentCorrelationId(): string | undefined {
  return asyncLocalStorage.getStore()?.correlationId;
}

export interface Logger {
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
  child: (bindings: Record<string, unknown>) => Logger;
}

function createLogMethod(
  level: 'debug' | 'info' | 'warn' | 'error',
  bindings: Record<string, unknown> = {}
) {
  return (msg: string, data?: Record<string, unknown>) => {
    const ctx = getRequestContext();
    const contextBindings = ctx ? { correlationId: ctx.correlationId } : {};
    baseLogger[level]({ ...contextBindings, ...bindings, ...data }, msg);
  };
}

export function createLogger(name: string, context?: Partial<RequestContext>): Logger {
  const bindings: Record<string, unknown> = { name };
  if (context?.correlationId) bindings.correlationId = context.correlationId;
  if (context?.shopId) bindings.shopId = context.shopId;
  if (context?.userId) bindings.userId = context.userId;

  return {
    debug: createLogMethod('debug', bindings),
    info: createLogMethod('info', bindings),
    warn: createLogMethod('warn', bindings),
    error: createLogMethod('error', bindings),
    child: (childBindings: Record<string, unknown>) => {
      const newBindings = { ...bindings, ...childBindings };
      return {
        debug: createLogMethod('debug', newBindings),
        info: createLogMethod('info', newBindings),
        warn: createLogMethod('warn', newBindings),
        error: createLogMethod('error', newBindings),
        child: (b: Record<string, unknown>) => createLogger(name, { 
          ...context, 
          ...Object.fromEntries(
            Object.entries({ ...newBindings, ...b })
              .filter(([k]) => ['correlationId', 'shopId', 'userId'].includes(k))
          ) as Partial<RequestContext>
        }),
      };
    },
  };
}

export const logger = createLogger('app');

export const integrationLogger = createLogger('integration');
export const syncLogger = createLogger('sync');
export const apiLogger = createLogger('api');
export const dbLogger = createLogger('db');

export default logger;
