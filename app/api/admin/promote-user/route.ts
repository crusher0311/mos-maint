// app/api/admin/promote-user/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { ENV } from "@/lib/env-safe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/promote-user
 * Body: { email: string, adminToken: string }
 * 
 * Promotes a user to admin role using the admin token from environment
 * This is useful for initial setup when you need to create the first admin
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, adminToken } = body;

    // Verify admin token
    if (!adminToken || adminToken !== ENV.ADMIN_TOKEN) {
      return NextResponse.json({ error: "Invalid admin token" }, { status: 401 });
    }

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const db = await getDb();
    
    // Find user by email
    const user = await db.collection("users").findOne({
      email: email.toLowerCase().trim()
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Update user role to admin
    const result = await db.collection("users").updateOne(
      { _id: user._id },
      { 
        $set: { 
          role: "admin",
          updatedAt: new Date()
        } 
      }
    );

    if (result.modifiedCount === 0) {
      return NextResponse.json({ error: "Failed to promote user" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: `User ${email} has been promoted to admin`,
      user: {
        _id: user._id,
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