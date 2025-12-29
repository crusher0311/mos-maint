import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TRIAL_VIN_LIMIT = 10;

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const db = await getDb();
    const trialSettings = await db.collection("platform_settings").findOne({ key: "trial" });

    return NextResponse.json({
      ok: true,
      settings: {
        trial: {
          vinLimit: trialSettings?.vinLimit ?? DEFAULT_TRIAL_VIN_LIMIT,
        },
      },
    });
  } catch (err: any) {
    console.error("Platform settings error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const { key, settings } = await req.json();
    const db = await getDb();

    if (key === "trial") {
      const vinLimit = Number(settings?.vinLimit);
      if (isNaN(vinLimit) || vinLimit < 1) {
        return NextResponse.json({ error: "Invalid VIN limit" }, { status: 400 });
      }

      await db.collection("platform_settings").updateOne(
        { key: "trial" },
        { 
          $set: { 
            vinLimit,
            updatedAt: new Date(),
            updatedBy: session.email,
          } 
        },
        { upsert: true }
      );

      return NextResponse.json({ 
        ok: true, 
        message: `Default trial VIN limit set to ${vinLimit}` 
      });
    }

    return NextResponse.json({ error: "Invalid settings key" }, { status: 400 });

  } catch (err: any) {
    console.error("Platform settings update error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
