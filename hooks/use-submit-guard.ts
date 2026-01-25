"use client";

import { useState, useRef, useCallback } from "react";

interface SubmitGuardResult<T> {
  isSubmitting: boolean;
  guard: (action: () => Promise<T>) => Promise<T | null>;
}

export function useSubmitGuard<T = void>(): SubmitGuardResult<T> {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const guard = useCallback(async (action: () => Promise<T>): Promise<T | null> => {
    if (submittingRef.current) {
      return null;
    }
    
    submittingRef.current = true;
    setIsSubmitting(true);
    
    try {
      return await action();
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, []);

  return { isSubmitting, guard };
}

const globalPendingRequests = new Map<string, Promise<unknown>>();

export function dedupeRequest<T>(
  key: string,
  requestFn: () => Promise<T>
): Promise<T> {
  const existing = globalPendingRequests.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = requestFn().finally(() => {
    globalPendingRequests.delete(key);
  });

  globalPendingRequests.set(key, promise);
  return promise;
}
