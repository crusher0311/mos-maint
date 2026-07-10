import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ObjectId } from "mongodb";
import {
  findUserById,
  deleteUserByObjectId,
  approvePendingUser,
  findShopNameByShopId,
} from "@/lib/data/repositories/enrollment";
import { dualWritePgIdentity } from "@/lib/db/wave4-write-mode";
import { updateUserFields, deleteUserById } from "@/lib/data/repositories/pg/identity";
import { sendEmail, makeEnrollmentApprovedEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/app-host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Approve or reject a pending (enrollment-code) signup.
 * Body: { action: "approve" | "reject" }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { userId: string } },
) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const action = String(body?.action || "");
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
  }

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(params.userId);
  } catch {
    return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
  }

  const user = await findUserById(objectId);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  if (String(user.shopId) !== String(sess.shopId)) {
    return NextResponse.json({ error: "Cannot manage user from another shop" }, { status: 403 });
  }
  if (user.status !== "pending") {
    return NextResponse.json({ error: "User is not pending approval" }, { status: 400 });
  }

  if (action === "reject") {
    await deleteUserByObjectId(objectId);
    await dualWritePgIdentity(`users.delete(reject:${params.userId})`, () =>
      deleteUserById(params.userId),
    );
    console.log(`[Enrollment] ${sess.email} rejected pending user ${user.email} (shop ${sess.shopId})`);
    return NextResponse.json({ ok: true, action: "rejected" });
  }

  // Approve
  const now = new Date();
  await approvePendingUser(objectId, sess.email);
  // PG mirror: status lives in the profile jsonb (see join route insert);
  // rewrite the whole profile blob with pending markers removed.
  await dualWritePgIdentity(`users.approve(${params.userId})`, () =>
    updateUserFields(params.userId, {
      profile: {
        ...(user.name ? { name: user.name } : {}),
        ...(user.enrolledVia ? { enrolledVia: user.enrolledVia } : {}),
        approvedAt: now,
        approvedBy: sess.email,
      },
    }),
  );

  console.log(`[Enrollment] ${sess.email} approved pending user ${user.email} (shop ${sess.shopId})`);

  let emailSent = false;
  try {
    const shop = await findShopNameByShopId(Number(sess.shopId));
    const shopName = shop?.name || `Shop #${sess.shopId}`;
    const msg = makeEnrollmentApprovedEmail(shopName, `${getAppBaseUrl()}/login`);
    const result = await sendEmail({
      to: user.email,
      ...msg,
      shopId: sess.shopId,
      emailKind: "credentials_welcome",
    });
    emailSent = result.ok;
  } catch (err) {
    console.error("Failed to send approval email:", err);
  }

  return NextResponse.json({ ok: true, action: "approved", emailSent });
}
