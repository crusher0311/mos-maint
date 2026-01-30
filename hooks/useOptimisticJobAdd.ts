"use client";

import { useState, useCallback, useRef } from "react";

type JobPayload = {
  title: string;
  description?: string;
  code?: string;
  lines: Array<{
    lineType: "labor" | "part" | "sublet" | "other";
    description: string;
    partNumber?: string;
    manufacturer?: string;
    quantity: number;
    unitPrice: number;
    extendedPrice: number;
  }>;
};

type JobRequest = {
  job: JobPayload;
  source?: "plan" | "failures" | "lookup" | "canned" | "autocomplete";
  vehicle?: { vin?: string; year?: number; make?: string; model?: string };
};

type PendingJob = {
  id: string;
  job: JobPayload;
  status: "pending" | "success" | "error";
  error?: string;
};

export function useOptimisticJobAdd(workOrderGuid: string | undefined) {
  const [addedJobs, setAddedJobs] = useState<Map<string, PendingJob>>(new Map());
  const [isProcessing, setIsProcessing] = useState(false);
  const pendingQueue = useRef<JobRequest[]>([]);
  const flushTimeout = useRef<NodeJS.Timeout | null>(null);

  const addJobOptimistically = useCallback((jobRequest: JobRequest): string => {
    const jobId = `${jobRequest.job.title}-${Date.now()}`;
    
    setAddedJobs(prev => {
      const next = new Map(prev);
      next.set(jobId, {
        id: jobId,
        job: jobRequest.job,
        status: "pending",
      });
      return next;
    });

    pendingQueue.current.push(jobRequest);

    if (flushTimeout.current) {
      clearTimeout(flushTimeout.current);
    }
    flushTimeout.current = setTimeout(() => flushQueue(), 100);

    return jobId;
  }, []);

  const flushQueue = useCallback(async () => {
    if (!workOrderGuid || pendingQueue.current.length === 0 || isProcessing) {
      return;
    }

    setIsProcessing(true);
    const jobsToProcess = [...pendingQueue.current];
    pendingQueue.current = [];

    try {
      let response: Response;
      
      if (jobsToProcess.length === 1) {
        response = await fetch("/api/jobs/add-to-ro", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            workOrderGuid,
            job: jobsToProcess[0].job,
            source: jobsToProcess[0].source,
            vehicle: jobsToProcess[0].vehicle,
          }),
        });
      } else {
        response = await fetch("/api/jobs/add-to-ro-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            workOrderGuid,
            jobs: jobsToProcess,
          }),
        });
      }

      const data = await response.json();

      if (!response.ok || !data.ok) {
        setAddedJobs(prev => {
          const next = new Map(prev);
          for (const jobReq of jobsToProcess) {
            const key = [...next.keys()].find(k => 
              next.get(k)?.job.title === jobReq.job.title && 
              next.get(k)?.status === "pending"
            );
            if (key) {
              next.set(key, {
                ...next.get(key)!,
                status: "error",
                error: data.error || "Failed to add job",
              });
            }
          }
          return next;
        });
        return;
      }

      setAddedJobs(prev => {
        const next = new Map(prev);
        for (const jobReq of jobsToProcess) {
          const key = [...next.keys()].find(k => 
            next.get(k)?.job.title === jobReq.job.title && 
            next.get(k)?.status === "pending"
          );
          if (key) {
            next.set(key, {
              ...next.get(key)!,
              status: "success",
            });
          }
        }
        return next;
      });
    } catch (err) {
      setAddedJobs(prev => {
        const next = new Map(prev);
        for (const jobReq of jobsToProcess) {
          const key = [...next.keys()].find(k => 
            next.get(k)?.job.title === jobReq.job.title && 
            next.get(k)?.status === "pending"
          );
          if (key) {
            next.set(key, {
              ...next.get(key)!,
              status: "error",
              error: "Network error",
            });
          }
        }
        return next;
      });
    } finally {
      setIsProcessing(false);
    }
  }, [workOrderGuid, isProcessing]);

  const isJobAdded = useCallback((jobTitle: string): boolean => {
    for (const [, job] of addedJobs) {
      if (job.job.title === jobTitle && (job.status === "pending" || job.status === "success")) {
        return true;
      }
    }
    return false;
  }, [addedJobs]);

  const getJobStatus = useCallback((jobTitle: string): PendingJob | undefined => {
    for (const [, job] of addedJobs) {
      if (job.job.title === jobTitle) {
        return job;
      }
    }
    return undefined;
  }, [addedJobs]);

  const clearError = useCallback((jobTitle: string) => {
    setAddedJobs(prev => {
      const next = new Map(prev);
      for (const [key, job] of next) {
        if (job.job.title === jobTitle && job.status === "error") {
          next.delete(key);
        }
      }
      return next;
    });
  }, []);

  return {
    addJobOptimistically,
    isJobAdded,
    getJobStatus,
    clearError,
    addedJobs,
    isProcessing,
  };
}
