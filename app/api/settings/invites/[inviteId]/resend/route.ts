import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { ObjectId } from "mongodb";
import crypto from "node:crypto";
import { sendEmail, makeInviteEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { inviteId: string } }
) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { inviteId } = params;

  const db = await getDb();
  const invites = db.collection("setup_tokens");

  const invite = await invites.findOne({ _id: new ObjectId(inviteId) });
  if (!invite) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }

  if (invite.shopId !== sess.shopId && sess.role !== "admin") {
    return NextResponse.json({ error: "Cannot resend invite from another shop" }, { status: 403 });
  }

  const token = crypto.randomBytes(16).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  await invites.updateOne(
    { _id: new ObjectId(inviteId) },
    {
      $set: {
        token,
        createdAt: now,
        expiresAt,
      },
    }
  );

  const base =
    process.env.NEXT_PUBLIC_BASE_URL ||
    `https://${req.headers.get("host") || "localhost:3000"}`;
  const setupUrl = `${base}/setup?shopId=${invite.shopId}&token=${token}`;

  let emailSent = false;
  try {
    const msg = makeInviteEmail(setupUrl, invite.shopId, invite.role);
    await sendEmail({ to: invite.emailLower, ...msg });
    emailSent = true;
  } catch (err) {
    console.error("Failed to send invite email:", err);
  }

  return NextResponse.json({ 
    ok: true, 
    emailSent, 
    email: invite.emailLower,
    expiresAt 
  });
}
