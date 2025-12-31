import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import bcrypt from "bcryptjs";

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
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
        { status: 401 }
      );
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    // Generate a simple extension token (in production, use JWT)
    const extensionToken = `ext_${user._id.toString()}_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    
    // Store the extension token
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
    });
  } catch (error: any) {
    console.error("[Extension Auth] Error:", error);
    return NextResponse.json(
      { error: "Authentication failed" },
      { status: 500 }
    );
  }
}
