import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import bcrypt from "bcryptjs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const db = await getDb();
    const usersCollection = db.collection("users");

    const user = await usersCollection.findOne({ 
      email: email.toLowerCase().trim() 
    });

    if (!user) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401, headers: corsHeaders }
      );
    }

    if (!user.password) {
      return NextResponse.json(
        { error: "Account requires password setup. Please reset your password in MOS." },
        { status: 401, headers: corsHeaders }
      );
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401, headers: corsHeaders }
      );
    }

    const extensionToken = `ext_${user._id.toString()}_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    
    await usersCollection.updateOne(
      { _id: user._id },
      { 
        $set: { 
          extensionToken,
          extensionTokenCreatedAt: new Date()
        } 
      }
    );

    return NextResponse.json({
      token: extensionToken,
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        shopId: user.shopId,
        role: user.role
      }
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Extension Auth] Error:", error);
    return NextResponse.json(
      { error: "Authentication failed" },
      { status: 500, headers: corsHeaders }
    );
  }
}
