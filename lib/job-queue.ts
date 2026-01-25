import { getDb } from './mongo';
import { createLogger } from './logger';
import { ObjectId } from 'mongodb';

const logger = createLogger('job-queue');

export type JobType = 
  | 'protractor-backfill'
  | 'tekmetric-backfill'
  | 'protractor-sync'
  | 'tekmetric-sync'
  | 'email-send'
  | 'sticker-generate'
  | 'report-generate';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface Job<T = Record<string, unknown>> {
  _id?: ObjectId;
  type: JobType;
  status: JobStatus;
  priority: number;
  payload: T;
  attempts: number;
  maxAttempts: number;
  result?: unknown;
  error?: string;
  createdAt: Date;
  scheduledFor: Date;
  startedAt?: Date;
  completedAt?: Date;
  lockedUntil?: Date;
  lockedBy?: string;
}

const COLLECTION = 'job_queue';
const DEFAULT_MAX_ATTEMPTS = 3;
const LOCK_DURATION_MS = 5 * 60 * 1000;

const workerId = `worker-${process.pid}-${Date.now()}`;

export async function enqueueJob<T>(
  type: JobType,
  payload: T,
  options?: {
    priority?: number;
    scheduledFor?: Date;
    maxAttempts?: number;
  }
): Promise<string> {
  const db = await getDb();
  const now = new Date();

  const job: Job<T> = {
    type,
    status: 'pending',
    priority: options?.priority ?? 0,
    payload,
    attempts: 0,
    maxAttempts: options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    createdAt: now,
    scheduledFor: options?.scheduledFor ?? now,
  };

  const result = await db.collection(COLLECTION).insertOne(job);
  
  logger.info('Job enqueued', { 
    jobId: result.insertedId.toString(), 
    type, 
    priority: job.priority,
  });

  return result.insertedId.toString();
}

export async function dequeueJob(types?: JobType[]): Promise<Job | null> {
  const db = await getDb();
  const now = new Date();

  const filter: Record<string, unknown> = {
    status: 'pending',
    scheduledFor: { $lte: now },
    $or: [
      { lockedUntil: { $exists: false } },
      { lockedUntil: { $lt: now } },
    ],
  };

  if (types && types.length > 0) {
    filter.type = { $in: types };
  }

  const updateResult = await db.collection(COLLECTION).findOneAndUpdate(
    filter,
    {
      $set: {
        status: 'processing',
        startedAt: now,
        lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS),
        lockedBy: workerId,
      },
      $inc: { attempts: 1 },
    },
    {
      sort: { priority: -1, scheduledFor: 1 },
      returnDocument: 'after',
    }
  );

  const job = updateResult as Job | null;

  if (job) {
    logger.info('Job dequeued', { 
      jobId: job._id?.toString(), 
      type: job.type,
      attempt: job.attempts,
    });
  }

  return job;
}

export async function completeJob(jobId: string, result?: unknown): Promise<void> {
  const db = await getDb();
  
  await db.collection(COLLECTION).updateOne(
    { _id: new ObjectId(jobId) },
    {
      $set: {
        status: 'completed',
        completedAt: new Date(),
        result,
        lockedUntil: null,
        lockedBy: null,
      },
    }
  );

  logger.info('Job completed', { jobId });
}

export async function failJob(jobId: string, error: string): Promise<void> {
  const db = await getDb();
  
  const job = await db.collection(COLLECTION).findOne({ _id: new ObjectId(jobId) }) as Job | null;
  
  if (!job) {
    logger.warn('Job not found for failure update', { jobId });
    return;
  }

  const shouldRetry = job.attempts < job.maxAttempts;
  const backoffMs = Math.min(Math.pow(2, job.attempts) * 1000, 60000);

  await db.collection(COLLECTION).updateOne(
    { _id: new ObjectId(jobId) },
    {
      $set: {
        status: shouldRetry ? 'pending' : 'failed',
        error,
        scheduledFor: shouldRetry ? new Date(Date.now() + backoffMs) : job.scheduledFor,
        lockedUntil: null,
        lockedBy: null,
        completedAt: shouldRetry ? null : new Date(),
      },
    }
  );

  if (shouldRetry) {
    logger.info('Job scheduled for retry', { 
      jobId, 
      attempt: job.attempts, 
      nextRetryMs: backoffMs,
    });
  } else {
    logger.error('Job failed permanently', { jobId, attempts: job.attempts, error });
  }
}

export async function cancelJob(jobId: string): Promise<boolean> {
  const db = await getDb();
  
  const result = await db.collection(COLLECTION).updateOne(
    { _id: new ObjectId(jobId), status: { $in: ['pending', 'processing'] } },
    {
      $set: {
        status: 'cancelled',
        completedAt: new Date(),
        lockedUntil: null,
        lockedBy: null,
      },
    }
  );

  if (result.modifiedCount > 0) {
    logger.info('Job cancelled', { jobId });
    return true;
  }
  return false;
}

export async function getJobStatus(jobId: string): Promise<Job | null> {
  const db = await getDb();
  return db.collection(COLLECTION).findOne({ _id: new ObjectId(jobId) }) as Promise<Job | null>;
}

export async function getQueueStats(): Promise<Record<JobStatus, number>> {
  const db = await getDb();
  
  const pipeline = [
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ];
  
  const results = await db.collection(COLLECTION).aggregate(pipeline).toArray();
  
  const stats: Record<JobStatus, number> = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const r of results) {
    stats[r._id as JobStatus] = r.count;
  }

  return stats;
}

export async function cleanupOldJobs(olderThanDays: number = 30): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const result = await db.collection(COLLECTION).deleteMany({
    status: { $in: ['completed', 'cancelled', 'failed'] },
    completedAt: { $lt: cutoff },
  });

  logger.info('Old jobs cleaned up', { deleted: result.deletedCount, olderThanDays });
  return result.deletedCount;
}

export async function releaseStaleJobs(): Promise<number> {
  const db = await getDb();
  const now = new Date();

  const result = await db.collection(COLLECTION).updateMany(
    {
      status: 'processing',
      lockedUntil: { $lt: now },
    },
    {
      $set: {
        status: 'pending',
        lockedUntil: null,
        lockedBy: null,
      },
    }
  );

  if (result.modifiedCount > 0) {
    logger.info('Stale jobs released', { count: result.modifiedCount });
  }

  return result.modifiedCount;
}
