"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface UseAsyncActionOptions<T> {
  onSuccess?: (result: T) => void;
  onError?: (error: Error) => void;
  dedupeKey?: string;
}

interface AsyncActionState<T> {
  loading: boolean;
  error: string | null;
  data: T | null;
  lastAttempt: (() => Promise<T>) | null;
}

interface AsyncActionResult<T> {
  loading: boolean;
  error: string | null;
  data: T | null;
  execute: (action: () => Promise<T>) => Promise<T | null>;
  retry: () => Promise<T | null>;
  reset: () => void;
}

const pendingRequests = new Map<string, Promise<unknown>>();

export function useAsyncAction<T = unknown>(
  options: UseAsyncActionOptions<T> = {}
): AsyncActionResult<T> {
  const { onSuccess, onError, dedupeKey } = options;
  
  const [state, setState] = useState<AsyncActionState<T>>({
    loading: false,
    error: null,
    data: null,
    lastAttempt: null,
  });

  const mountedRef = useRef(true);
  
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const execute = useCallback(
    async (action: () => Promise<T>): Promise<T | null> => {
      if (dedupeKey && pendingRequests.has(dedupeKey)) {
        try {
          const result = await pendingRequests.get(dedupeKey) as T;
          return result;
        } catch {
          return null;
        }
      }

      setState(prev => ({
        ...prev,
        loading: true,
        error: null,
        lastAttempt: action,
      }));

      const promise = action();
      
      if (dedupeKey) {
        pendingRequests.set(dedupeKey, promise);
      }

      try {
        const result = await promise;
        
        if (mountedRef.current) {
          setState(prev => ({
            ...prev,
            loading: false,
            data: result,
            error: null,
          }));
        }

        onSuccess?.(result);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        
        if (mountedRef.current) {
          setState(prev => ({
            ...prev,
            loading: false,
            error: error.message,
          }));
        }

        onError?.(error);
        return null;
      } finally {
        if (dedupeKey) {
          pendingRequests.delete(dedupeKey);
        }
      }
    },
    [dedupeKey, onSuccess, onError]
  );

  const retry = useCallback(async (): Promise<T | null> => {
    if (state.lastAttempt) {
      return execute(state.lastAttempt);
    }
    return null;
  }, [state.lastAttempt, execute]);

  const reset = useCallback(() => {
    setState({
      loading: false,
      error: null,
      data: null,
      lastAttempt: null,
    });
  }, []);

  return {
    loading: state.loading,
    error: state.error,
    data: state.data,
    execute,
    retry,
    reset,
  };
}

export function createDedupeKey(...parts: (string | number | undefined | null)[]): string {
  return parts.filter(Boolean).join(":");
}
