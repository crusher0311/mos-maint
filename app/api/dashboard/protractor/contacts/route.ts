import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { searchContacts } from "@/lib/integrations/protractor";

export async function GET(req: NextRequest) {
  try {
    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: new Date() } });
    if (!sess) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }

    const user = await db.collection("users").findOne({ _id: sess.userId });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const search = req.nextUrl.searchParams.get("q");
    if (!search || search.length < 2) {
      return NextResponse.json({ error: "Search query must be at least 2 characters" }, { status: 400 });
    }

    const shopId = Number(user.shopId);
    const result = await searchContacts(shopId, search);

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    const contacts = (result.contacts || []).map(c => ({
      id: c.ID,
      firstName: c.Name?.FirstName || "",
      lastName: c.Name?.LastName || "",
      fileAs: c.FileAs || "",
      company: c.Company || "",
      phone: c.Phone1 || c.Phone2 || "",
      email: c.Email || "",
    }));

    return NextResponse.json({ contacts });
  } catch (err: any) {
    console.error("[Contact Search] Error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
