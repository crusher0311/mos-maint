import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { fetchStripeProducts } from "@/lib/stripe";

export async function GET() {
  try {
    const session = await requireSession();
    
    if (session.role !== "admin" && session.role !== "platform_admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const data = await fetchStripeProducts();
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("Error syncing from Stripe:", error);
    return NextResponse.json(
      { error: error.message || "Failed to sync from Stripe" },
      { status: 500 }
    );
  }
}
