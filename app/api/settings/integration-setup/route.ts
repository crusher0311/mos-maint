import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { sendEmail, makeProtractorApiRequestEmail, makeTekmetricSetupEmail } from "@/lib/email";

async function getSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get("mos_token")?.value;
  if (!token) return null;

  const db = await getDb();
  const session = await db.collection("sessions").findOne({ token });
  if (!session) return null;

  return session;
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

    const db = await getDb();
    const shopId = session.shopId;
    
    const shop = await db.collection("shops").findOne({ 
      shopId: { $in: [shopId, Number(shopId), String(shopId)] } 
    });
    
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const owner = await db.collection("users").findOne({ 
      shopId: { $in: [shopId, Number(shopId), String(shopId)] },
      role: "owner"
    });

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

      await db.collection("shops").updateOne(
        { shopId: { $in: [shopId, Number(shopId), String(shopId)] } },
        { $set: { "protractor.apiRequestSentAt": new Date() } }
      );

      return NextResponse.json({ 
        ok: true, 
        message: "API request email sent to Protractor support. The owner has been CC'd." 
      });
    }

    if (type === "tekmetric") {
      const emailData = makeTekmetricSetupEmail(shopName, ownerEmail);
      
      const tekResult = await sendEmail({
        to: emailData.to,
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text,
        shopId,
        emailKind: "tekmetric_setup",
      });
      if (!tekResult.ok) {
        return NextResponse.json(
          {
            error:
              "This shop is awaiting platform-admin review and cannot send transactional email yet. Please contact your account manager.",
          },
          { status: 403 },
        );
      }

      await db.collection("shops").updateOne(
        { shopId: { $in: [shopId, Number(shopId), String(shopId)] } },
        { $set: { "tekmetric.setupEmailSentAt": new Date() } }
      );

      return NextResponse.json({ 
        ok: true, 
        message: "Setup instructions email sent to shop owner." 
      });
    }

    return NextResponse.json({ error: "Unknown type" }, { status: 400 });
  } catch (err: any) {
    console.error("[integration-setup] Error:", err);
    return NextResponse.json({ error: err.message || "Failed to send email" }, { status: 500 });
  }
}
