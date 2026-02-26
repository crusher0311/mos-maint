import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getDb } from '@/lib/mongo';
import { testConnection, getShop, isConfigured } from '@/lib/integrations/shopware/client';

async function getUserShopId(): Promise<string | null> {
  const store = await cookies();
  const sid = store.get('sid')?.value ?? store.get('session_token')?.value;
  if (!sid) return null;

  const db = await getDb();
  const now = new Date();
  const sess = await db.collection('sessions').findOne({ token: sid, expiresAt: { $gt: now } });
  if (!sess) return null;

  const user = await db.collection('users').findOne({ _id: sess.userId });
  return user?.shopId ? String(user.shopId) : null;
}

export async function GET(_request: NextRequest) {
  try {
    const shopId = await getUserShopId();
    if (!shopId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const db = await getDb();
    const shop = await db.collection('shops').findOne(
      { shopId: { $in: [shopId, Number(shopId)] } },
      { projection: { shopware: 1 } }
    );

    if (!shop?.shopware?.tenantId) {
      return NextResponse.json({ configured: false });
    }

    return NextResponse.json({
      configured: true,
      tenantId: shop.shopware.tenantId,
      swShopId: shop.shopware.swShopId,
      shopName: shop.shopware.shopName ?? null,
      connectedAt: shop.shopware.connectedAt ?? null,
      lastSyncAt: shop.shopware.lastSyncAt ?? null,
    });
  } catch (err: any) {
    console.error('[Shop-Ware Settings] GET error:', err.message);
    return NextResponse.json({ error: err.message || 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const userShopId = await getUserShopId();
    if (!userShopId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!isConfigured()) {
      return NextResponse.json(
        { error: 'Shop-Ware partner credentials not configured. Please contact support.' },
        { status: 500 }
      );
    }

    const body = await request.json();
    const { tenantId, swShopId, tenantSubdomain } = body;

    if (!swShopId) {
      return NextResponse.json({ error: 'swShopId is required' }, { status: 400 });
    }

    const swShopIdNum = parseInt(String(swShopId), 10);
    const tenantIdNum = tenantId ? parseInt(String(tenantId), 10) : swShopIdNum;

    if (isNaN(swShopIdNum) || isNaN(tenantIdNum)) {
      return NextResponse.json({ error: 'Shop ID must be a number' }, { status: 400 });
    }

    const connTest = await testConnection(tenantIdNum);
    if (!connTest.ok) {
      return NextResponse.json(
        { error: connTest.error || 'Could not connect to Shop-Ware. Check your Tenant ID.' },
        { status: 400 }
      );
    }

    let shopName: string | undefined;
    try {
      const swShop = await getShop(tenantIdNum, swShopIdNum);
      shopName = swShop.name;
    } catch {
      return NextResponse.json(
        { error: `Shop ID ${swShopIdNum} not found in tenant ${tenantIdNum}. Check your Shop ID.` },
        { status: 400 }
      );
    }

    const db = await getDb();
    await db.collection('shops').updateOne(
      { shopId: { $in: [userShopId, Number(userShopId)] } },
      {
        $set: {
          'shopware.tenantId': tenantIdNum,
          'shopware.swShopId': swShopIdNum,
          'shopware.shopName': shopName,
          'shopware.connectedAt': new Date(),
          'shopware.lastSyncAt': null,
          ...(tenantSubdomain ? { 'shopware.tenantSubdomain': tenantSubdomain } : {}),
        },
      },
      { upsert: true }
    );

    console.log(`[Shop-Ware Settings] Connected shop ${userShopId} → tenant ${tenantIdNum} / shop ${swShopIdNum} (${shopName})`);

    return NextResponse.json({
      success: true,
      tenantId: tenantIdNum,
      swShopId: swShopIdNum,
      shopName,
    });
  } catch (err: any) {
    console.error('[Shop-Ware Settings] POST error:', err.message);
    return NextResponse.json({ error: err.message || 'Failed to save settings' }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest) {
  try {
    const userShopId = await getUserShopId();
    if (!userShopId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const db = await getDb();
    await db.collection('shops').updateOne(
      { shopId: { $in: [userShopId, Number(userShopId)] } },
      { $unset: { shopware: '' } }
    );

    console.log(`[Shop-Ware Settings] Disconnected shop ${userShopId}`);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[Shop-Ware Settings] DELETE error:', err.message);
    return NextResponse.json({ error: err.message || 'Failed to disconnect' }, { status: 500 });
  }
}
