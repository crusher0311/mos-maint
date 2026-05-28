import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getDb } from '@/lib/mongo';
import { shopWareRequest, isConfigured } from '@/lib/integrations/shopware/client';

function isBadHost(host: string): boolean {
  const h = host.toLowerCase().split(':')[0];
  if (!h) return true;
  if (h === '0.0.0.0' || h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  // IPv4 private / link-local ranges
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o1 = Number(m[1]);
    const o2 = Number(m[2]);
    if (o1 === 10) return true;
    if (o1 === 127) return true;
    if (o1 === 169 && o2 === 254) return true;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 === 192 && o2 === 168) return true;
  }
  return false;
}

function resolvePublicWebhookUrl(
  req: NextRequest,
  bodyUrl?: string
): { url?: string; error?: string } {
  const candidates: string[] = [];
  if (bodyUrl?.trim()) candidates.push(bodyUrl.trim());

  const envBase =
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL;
  if (envBase) {
    candidates.push(`${envBase.replace(/\/$/, '')}/api/webhooks/shopware`);
  }

  const fwdHost = req.headers.get('x-forwarded-host');
  const fwdProto = req.headers.get('x-forwarded-proto') || 'https';
  if (fwdHost) {
    candidates.push(`${fwdProto}://${fwdHost}/api/webhooks/shopware`);
  }

  for (const raw of candidates) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:') continue;
    if (isBadHost(parsed.hostname)) continue;
    return { url: parsed.toString().replace(/\/$/, '') };
  }

  return {
    error:
      'Could not determine a public HTTPS webhook URL. Configure NEXT_PUBLIC_BASE_URL (or APP_BASE_URL) to your public domain, or pass a custom HTTPS URL in the request body.',
  };
}

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
    const resolved = resolvePublicWebhookUrl(req, body.url);
    if (!resolved.url) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }
    const webhookUrl = resolved.url;

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
      try {
        const { emitShopErrorEvent } = await import("@/lib/alerts/shop-error-marker");
        emitShopErrorEvent({
          group: "SHOPWARE_WRITE_FAIL",
          shopId,
          status: 502,
          path: "/webhooks",
          method: "POST",
          message: err?.message,
        });
      } catch {}
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
        try {
          const { emitShopErrorEvent } = await import("@/lib/alerts/shop-error-marker");
          emitShopErrorEvent({
            group: "SHOPWARE_WRITE_FAIL",
            shopId,
            status: 502,
            path: `/webhooks/${webhookId}`,
            method: "DELETE",
            message: err?.message,
          });
        } catch {}
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
