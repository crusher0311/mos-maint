import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getDb } from '@/lib/mongo';
import { shopWareRequest, isConfigured } from '@/lib/integrations/shopware/client';

const SW_EVENTS = [
  'repair_order.created',
  'repair_order.updated',
  'repair_order.deleted',
  'vehicle.updated',
  'customer.updated',
];

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

async function getStoredWebhook(shopId: string) {
  const db = await getDb();
  const shop = await db.collection('shops').findOne(
    { shopId: { $in: [shopId, Number(shopId)] } },
    { projection: { 'shopware.webhook': 1, 'shopware.tenantId': 1 } }
  );
  return {
    stored: shop?.shopware?.webhook ?? null,
    tenantId: shop?.shopware?.tenantId ?? null,
  };
}

export async function GET(req: NextRequest) {
  try {
    const shopId = await getUserShopId();
    if (!shopId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!isConfigured()) {
      return NextResponse.json({ error: 'Shop-Ware credentials not configured' }, { status: 500 });
    }

    const { stored } = await getStoredWebhook(shopId);

    let liveWebhooks: any[] = [];
    try {
      liveWebhooks = await shopWareRequest<any[]>('/webhooks');
    } catch (err: any) {
      return NextResponse.json({ error: `Failed to fetch webhooks: ${err.message}` }, { status: 502 });
    }

    const appWebhooks = liveWebhooks.filter((wh: any) =>
      typeof wh.url === 'string' && wh.url.includes('/api/webhooks/shopware')
    );

    const storedStillLive = stored?.webhookId
      ? liveWebhooks.some((wh: any) => String(wh.id) === String(stored.webhookId))
      : false;

    return NextResponse.json({
      registered: appWebhooks.length > 0,
      storedStillLive,
      webhookId: stored?.webhookId ?? appWebhooks[0]?.id ?? null,
      webhookUrl: stored?.webhookUrl ?? appWebhooks[0]?.url ?? null,
      registeredAt: stored?.registeredAt ?? null,
      allAppWebhooks: appWebhooks.map((wh: any) => ({
        id: wh.id,
        url: wh.url,
        events: wh.events,
      })),
    });
  } catch (err: any) {
    console.error('[SW Webhook Settings] GET error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const shopId = await getUserShopId();
    if (!shopId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!isConfigured()) {
      return NextResponse.json({ error: 'Shop-Ware credentials not configured' }, { status: 500 });
    }

    const body = await req.json().catch(() => ({}));
    const webhookUrl: string =
      body.url?.trim() ||
      `${req.nextUrl.origin}/api/webhooks/shopware`;

    if (!webhookUrl.startsWith('https://')) {
      return NextResponse.json(
        { error: 'Webhook URL must use HTTPS. Please provide a custom URL for local environments.' },
        { status: 400 }
      );
    }

    let liveWebhooks: any[] = [];
    try {
      liveWebhooks = await shopWareRequest<any[]>('/webhooks');
    } catch (err: any) {
      return NextResponse.json({ error: `Failed to check existing webhooks: ${err.message}` }, { status: 502 });
    }

    const existing = liveWebhooks.find((wh: any) => wh.url === webhookUrl);
    if (existing) {
      const db = await getDb();
      await db.collection('shops').updateOne(
        { shopId: { $in: [shopId, Number(shopId)] } },
        {
          $set: {
            'shopware.webhook.webhookId': String(existing.id),
            'shopware.webhook.webhookUrl': existing.url,
            'shopware.webhook.events': existing.events,
            'shopware.webhook.registeredAt': new Date(),
          },
        }
      );
      return NextResponse.json({
        success: true,
        alreadyExisted: true,
        webhookId: existing.id,
        webhookUrl: existing.url,
        events: existing.events,
      });
    }

    let created: any;
    try {
      created = await shopWareRequest('/webhooks', {
        method: 'POST',
        body: JSON.stringify({ url: webhookUrl, events: SW_EVENTS }),
      });
    } catch (err: any) {
      return NextResponse.json({ error: `Failed to register webhook: ${err.message}` }, { status: 502 });
    }

    const db = await getDb();
    await db.collection('shops').updateOne(
      { shopId: { $in: [shopId, Number(shopId)] } },
      {
        $set: {
          'shopware.webhook.webhookId': String(created.id),
          'shopware.webhook.webhookUrl': created.url ?? webhookUrl,
          'shopware.webhook.events': created.events ?? SW_EVENTS,
          'shopware.webhook.registeredAt': new Date(),
        },
      }
    );

    console.log(`[SW Webhook Settings] Registered webhook ${created.id} → ${webhookUrl}`);

    return NextResponse.json({
      success: true,
      alreadyExisted: false,
      webhookId: created.id,
      webhookUrl: created.url ?? webhookUrl,
      events: created.events ?? SW_EVENTS,
    });
  } catch (err: any) {
    console.error('[SW Webhook Settings] POST error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const shopId = await getUserShopId();
    if (!shopId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!isConfigured()) {
      return NextResponse.json({ error: 'Shop-Ware credentials not configured' }, { status: 500 });
    }

    const { stored } = await getStoredWebhook(shopId);
    const webhookId = stored?.webhookId;

    if (!webhookId) {
      return NextResponse.json({ error: 'No webhook ID on file' }, { status: 400 });
    }

    try {
      await shopWareRequest(`/webhooks/${webhookId}`, { method: 'DELETE' });
    } catch (err: any) {
      if (!err.message?.includes('404')) {
        return NextResponse.json({ error: `Failed to delete webhook: ${err.message}` }, { status: 502 });
      }
    }

    const db = await getDb();
    await db.collection('shops').updateOne(
      { shopId: { $in: [shopId, Number(shopId)] } },
      { $unset: { 'shopware.webhook': '' } }
    );

    console.log(`[SW Webhook Settings] Unregistered webhook ${webhookId}`);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[SW Webhook Settings] DELETE error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
