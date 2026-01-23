import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const licenseKey = process.env.COBROWSE_LICENSE_KEY;

    return NextResponse.json({
      ok: true,
      licenseKey: licenseKey || null
    });
  } catch (error) {
    return NextResponse.json({ error: "Failed to get config" }, { status: 500 });
  }
}
