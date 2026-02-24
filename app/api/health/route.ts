import { NextResponse } from 'next/server';

export async function GET() {
  const checks: Record<string, string> = {};
  
  try {
    const { pingDataOneDb } = await import("@/lib/integrations/dataone-local");
    const pingOk = await pingDataOneDb();
    checks.dataone_db = pingOk ? 'ok' : 'error';
  } catch {
    checks.dataone_db = 'error';
  }

  const allOk = Object.values(checks).every(v => v === 'ok');

  return NextResponse.json({ 
    status: allOk ? 'ok' : 'degraded', 
    checks,
    timestamp: Date.now() 
  }, { status: 200 });
}
