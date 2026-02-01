import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import sql from "@/lib/db/postgres";
import { sendEmail, makeProtractorApiRequestEmail, makeTekmetricSetupEmail } from "@/lib/email";

async function getSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get("mos_token")?.value;
  if (!token) return null;

  const sessionResult = await sql`SELECT * FROM sessions WHERE token = ${token} LIMIT 1`;
  if (!sessionResult[0]) return null;

  return sessionResult[0];
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { type } = await req.json();
    
    if (!type || !["protractor", "tekmetric"].includes(type)) {
      return NextResponse.json({ error: "Invalid integration type" }, { status: 400 });
    }

    const shopId = String(session.shop_id);
    
    const shopResult = await sql`
      SELECT * FROM shops WHERE shop_id = ${shopId} LIMIT 1
    `;
    const shop = shopResult[0];
    
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const ownerResult = await sql`
      SELECT email FROM users WHERE shop_id = ${shopId} AND role = 'owner' LIMIT 1
    `;
    const owner = ownerResult[0];

    if (!owner?.email) {
      return NextResponse.json({ error: "Shop owner email not found" }, { status: 400 });
    }

    const shopName = shop.name || `Shop #${shopId}`;
    const shopLocation = [shop.city, shop.state || shop.province].filter(Boolean).join(", ") || "Location not specified";
    const ownerEmail = owner.email;

    if (type === "protractor") {
      const emailData = makeProtractorApiRequestEmail(shopName, shopLocation, ownerEmail);
      
      await sendEmail({
        to: emailData.to,
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text,
        cc: emailData.cc,
        replyTo: ownerEmail,
      });

      const protractorConfig = (shop.protractor_config as Record<string, unknown>) || {};
      const updatedConfig = {
        ...protractorConfig,
        apiRequestSentAt: new Date().toISOString()
      };

      await sql`
        UPDATE shops SET protractor_config = ${JSON.stringify(updatedConfig)}::jsonb
        WHERE shop_id = ${shopId}
      `;

      return NextResponse.json({ 
        ok: true, 
        message: "API request email sent to Protractor support. The owner has been CC'd." 
      });
    }

    if (type === "tekmetric") {
      const emailData = makeTekmetricSetupEmail(shopName, ownerEmail);
      
      await sendEmail({
        to: emailData.to,
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text,
      });

      const tekmetricConfig = (shop.tekmetric_config as Record<string, unknown>) || {};
      const updatedConfig = {
        ...tekmetricConfig,
        setupEmailSentAt: new Date().toISOString()
      };

      await sql`
        UPDATE shops SET tekmetric_config = ${JSON.stringify(updatedConfig)}::jsonb
        WHERE shop_id = ${shopId}
      `;

      return NextResponse.json({ 
        ok: true, 
        message: "Setup instructions email sent to shop owner." 
      });
    }

    return NextResponse.json({ error: "Unknown type" }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[integration-setup] Error:", err);
    return NextResponse.json({ error: message || "Failed to send email" }, { status: 500 });
  }
}
