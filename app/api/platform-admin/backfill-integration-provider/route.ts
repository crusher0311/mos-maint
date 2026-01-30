import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { SUPER_ADMIN_EMAILS } from '@/lib/super-admins';
import { backfillIntegrationProvider } from '@/lib/scripts/backfill-integration-provider';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.email || !SUPER_ADMIN_EMAILS.includes(session.email)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const result = await backfillIntegrationProvider();
    
    return NextResponse.json({
      success: true,
      message: `Backfill complete: ${result.updated} shops updated`,
      ...result
    });
  } catch (error: any) {
    console.error('[Backfill Integration Provider] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Backfill failed' },
      { status: 500 }
    );
  }
}
