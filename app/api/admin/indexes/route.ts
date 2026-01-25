import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { ensureIndexes, indexes } from '@/lib/db-indexes';
import { createLogger } from '@/lib/logger';

const logger = createLogger('admin-indexes');

export async function GET(req: NextRequest) {
  const session = await getSession();
  
  if (!session || !session.isPlatformAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const indexList = indexes.map(i => ({
      collection: i.collection,
      name: i.name,
      keys: i.keys,
      options: i.options,
    }));

    return NextResponse.json({ 
      totalDefined: indexes.length,
      indexes: indexList,
    });
  } catch (error) {
    logger.error('Failed to list indexes', { error: String(error) });
    return NextResponse.json({ error: 'Failed to list indexes' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  
  if (!session || !session.isPlatformAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await ensureIndexes();
    
    logger.info('Index initialization triggered by admin', { 
      adminEmail: session.email,
      result,
    });

    return NextResponse.json({
      success: true,
      message: `Created ${result.created} indexes, ${result.existing} already existed`,
      ...result,
    });
  } catch (error) {
    logger.error('Failed to ensure indexes', { error: String(error) });
    return NextResponse.json({ error: 'Failed to create indexes' }, { status: 500 });
  }
}
