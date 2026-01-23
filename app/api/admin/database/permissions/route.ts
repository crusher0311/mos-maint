import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { isSuperAdmin } from "@/lib/super-admins";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json({
      canRead: true,
      canWrite: isSuperAdmin(session.email),
      email: session.email
    });
  } catch (error) {
    console.error("Failed to check permissions:", error);
    return NextResponse.json({ error: "Failed to check permissions" }, { status: 500 });
  }
}
