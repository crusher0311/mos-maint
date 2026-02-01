import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { ENV } from "@/lib/env-safe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, adminToken } = body;

    if (!adminToken || adminToken !== ENV.ADMIN_TOKEN) {
      return NextResponse.json({ error: "Invalid admin token" }, { status: 401 });
    }

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const emailLower = email.toLowerCase().trim();
    const userResult = await sql`
      SELECT id, email, role FROM users WHERE LOWER(email) = ${emailLower} LIMIT 1
    `;
    const user = userResult[0];

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const result = await sql`
      UPDATE users SET role = 'admin', updated_at = ${new Date()}
      WHERE id = ${user.id}
    `;

    if (result.count === 0) {
      return NextResponse.json({ error: "Failed to promote user" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: `User ${email} has been promoted to admin`,
      user: {
        id: user.id,
        email: user.email,
        role: "admin"
      }
    });

  } catch (error) {
    console.error("Promote user error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
