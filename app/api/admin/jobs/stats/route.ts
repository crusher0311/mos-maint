import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getQueueStats, releaseStaleJobs, cleanupOldJobs } from '@/lib/job-queue';
import { createLogger } from '@/lib/logger';

const logger = createLogger('admin-jobs');

export async function GET(req: NextRequest) {
  const session = await getSession();
  
  if (!session || !session.isPlatformAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const stats = await getQueueStats();
    
    return NextResponse.json({
      stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get queue stats', { error: String(error) });
    return NextResponse.json({ error: 'Failed to get queue stats' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  
  if (!session || !session.isPlatformAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const action = body.action;

    if (action === 'release-stale') {
      const released = await releaseStaleJobs();
      logger.info('Stale jobs released by admin', { 
        adminEmail: session.email, 
        count: released,
      });
      return NextResponse.json({ released });
    }

    if (action === 'cleanup-old') {
      const days = body.days || 30;
      const deleted = await cleanupOldJobs(days);
      logger.info('Old jobs cleaned up by admin', { 
        adminEmail: session.email, 
        count: deleted, 
        days,
      });
      return NextResponse.json({ deleted, days });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    logger.error('Failed to perform job action', { error: String(error) });
    return NextResponse.json({ error: 'Failed to perform action' }, { status: 500 });
  }
}
