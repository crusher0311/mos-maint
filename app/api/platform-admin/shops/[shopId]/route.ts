import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  updateShopFeatures,
  updateShopBilling,
  pickValidFeatures,
  isFounderPlan,
  type BillingPlan,
  type BillingStatus
} from "@/lib/featureResolver";
import { resendCardCaptureForShop } from "@/lib/card-capture-resend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = isNaN(Number(params.shopId)) ? params.shopId : Number(params.shopId);
    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId });
    
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const vinViewCount = await db.collection("viewed_vins").countDocuments({ shopId });

    return NextResponse.json({
      ok: true,
      shop: {
        shopId: shop.shopId,
        name: shop.name,
        locationIdentifier: shop.locationIdentifier,
        enterpriseId: shop.enterpriseId,
        billing: {
          plan: shop.billing?.plan || "trial",
          status: shop.billing?.status || "trial",
          vinLimit: shop.trialVinLimit || 10,
          vinViewCount,
        },
        enabledFeatures: shop.enabledFeatures || {},
        createdAt: shop.createdAt,
        isLocked: shop.isLocked || false,
      },
    });
  } catch (err) {
    console.error("Shop get error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = isNaN(Number(params.shopId)) ? params.shopId : Number(params.shopId);
    const body = await req.json();
    const { action, billing, features, trial } = body;

    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    if (trial) {
      const MAX_TRIAL_DAYS = 365;
      const now = new Date();
      const currentEndsAt: Date | null = shop.trial?.endsAt
        ? new Date(shop.trial.endsAt)
        : (shop.trialEndsAt ? new Date(shop.trialEndsAt) : null);

      let newEndsAt: Date | null = null;
      let extendDaysApplied: number | null = null;

      if (trial.endsAt) {
        const parsed = new Date(trial.endsAt);
        if (Number.isNaN(parsed.getTime())) {
          return NextResponse.json({ error: "Invalid trial endsAt" }, { status: 400 });
        }
        newEndsAt = parsed;
      } else if (trial.extendDays !== undefined && trial.extendDays !== null) {
        const days = Number(trial.extendDays);
        if (!Number.isFinite(days) || days < 1 || days > MAX_TRIAL_DAYS) {
          return NextResponse.json(
            { error: `extendDays must be between 1 and ${MAX_TRIAL_DAYS}` },
            { status: 400 }
          );
        }
        extendDaysApplied = Math.floor(days);
        const base = currentEndsAt && currentEndsAt.getTime() > now.getTime() ? currentEndsAt : now;
        newEndsAt = new Date(base.getTime() + extendDaysApplied * 24 * 60 * 60 * 1000);
      } else {
        return NextResponse.json({ error: "Provide trial.endsAt or trial.extendDays" }, { status: 400 });
      }

      const totalDays = shop.trial?.startedAt
        ? Math.max(1, Math.round((newEndsAt.getTime() - new Date(shop.trial.startedAt).getTime()) / (24 * 60 * 60 * 1000)))
        : (shop.trial?.days ?? null);

      const updateOps: Record<string, any> = {
        $set: {
          "trial.endsAt": newEndsAt,
          "trial.mode": shop.trial?.mode || "days",
          "trial.reminderSent": {},
          ...(shop.trial?.startedAt ? {} : { "trial.startedAt": now }),
          ...(totalDays ? { "trial.days": totalDays, trialDays: totalDays } : {}),
          trialEndsAt: newEndsAt,
          "billing.status": shop.billing?.status === "suspended" ? "trial" : (shop.billing?.status || "trial"),
          updatedAt: now,
        },
      };
      const unsetFields: Record<string, ""> = {};
      // Only clear lock/suspension markers on shops that are actually
      // suspended or in a trial billing state. Never touch
      // trialConvertedAt on a paid/active shop — doing so could let the
      // trial cron re-bill or wrongly suspend a paying customer.
      const status = shop.billing?.status;
      const isSuspendedOrTrial = !status || status === "suspended" || status === "trial" || status === "trialing";
      if (shop.isLocked && isSuspendedOrTrial) {
        unsetFields.isLocked = "";
        unsetFields.lockedAt = "";
        unsetFields.lockedBy = "";
      }
      if (shop.trialSuspendedAt && isSuspendedOrTrial) {
        unsetFields.trialSuspendedAt = "";
      }
      if (Object.keys(unsetFields).length > 0) {
        updateOps.$unset = unsetFields;
      }
      await db.collection("shops").updateOne({ shopId }, updateOps);

      await db.collection("audit_logs").insertOne({
        type: "shop_trial_extended",
        shopId,
        shopName: shop.name,
        previousEndsAt: currentEndsAt,
        newEndsAt,
        extendDays: extendDaysApplied,
        adminEmail: session.email,
        createdAt: now,
      });

      return NextResponse.json({
        ok: true,
        message: `Trial extended to ${newEndsAt.toLocaleDateString()}`,
        trial: { endsAt: newEndsAt, days: totalDays },
      });
    }

    if (action === "lock") {
      await db.collection("shops").updateOne(
        { shopId },
        { $set: { isLocked: true, lockedAt: new Date(), lockedBy: session.email } }
      );
      await db.collection("audit_logs").insertOne({
        type: "shop_locked",
        shopId,
        shopName: shop.name,
        adminEmail: session.email,
        createdAt: new Date(),
      });
      return NextResponse.json({ ok: true, message: "Shop locked" });
    }

    if (action === "resend_card_capture") {
      const result = await resendCardCaptureForShop({
        db,
        shopId,
        adminEmail: session.email,
      });
      if (!result.ok) {
        const status =
          result.error === "Shop not found"
            ? 404
            : result.error?.includes("owner") || result.error?.includes("numeric")
              ? 400
              : 500;
        return NextResponse.json({ error: result.error }, { status });
      }
      return NextResponse.json({
        ok: true,
        message: `Card-capture email sent to ${result.ownerEmail}`,
      });
    }

    if (action === "unlock") {
      await db.collection("shops").updateOne(
        { shopId },
        { $unset: { isLocked: "", lockedAt: "", lockedBy: "" } }
      );
      await db.collection("audit_logs").insertOne({
        type: "shop_unlocked",
        shopId,
        shopName: shop.name,
        adminEmail: session.email,
        createdAt: new Date(),
      });
      return NextResponse.json({ ok: true, message: "Shop unlocked" });
    }

    if (billing) {
      const billingUpdate: any = {};
      if (billing.plan !== undefined) billingUpdate.plan = billing.plan as BillingPlan;
      if (billing.status !== undefined) billingUpdate.status = billing.status as BillingStatus;
      if (billing.vinLimit !== undefined) billingUpdate.vinLimit = billing.vinLimit;
      
      await updateShopBilling(shopId as number, billingUpdate);
      
      await db.collection("audit_logs").insertOne({
        type: "shop_billing_updated",
        shopId,
        shopName: shop.name,
        changes: billingUpdate,
        adminEmail: session.email,
        createdAt: new Date(),
      });
    }

    // The effective plan after this PATCH (incoming change wins over the
    // stored value) — used to decide whether to skip writing per-feature
    // overrides for founder shops.
    const effectivePlan: string = (billing?.plan as string | undefined)
      ?? (shop.billing?.plan as string | undefined)
      ?? "trial";

    if (features) {
      if (isFounderPlan(effectivePlan)) {
        // Founder plan is a wildcard — every feature is on regardless of
        // per-shop overrides. Skip writing overrides so changing the plan
        // later doesn't leave stale `enabledFeatures` toggles behind.
        await db.collection("audit_logs").insertOne({
          type: "shop_features_skipped_founder",
          shopId,
          shopName: shop.name,
          adminEmail: session.email,
          createdAt: new Date(),
        });
      } else {
        const featureUpdate = pickValidFeatures(features);

        await updateShopFeatures(shopId as number, featureUpdate);

        await db.collection("audit_logs").insertOne({
          type: "shop_features_updated",
          shopId,
          shopName: shop.name,
          changes: featureUpdate,
          adminEmail: session.email,
          createdAt: new Date(),
        });
      }
    }

    if (billing || features) {
      const updatedShop = await db.collection("shops").findOne({ shopId });
      return NextResponse.json({
        ok: true,
        shop: {
          shopId: updatedShop?.shopId,
          name: updatedShop?.name,
          billing: {
            plan: updatedShop?.billing?.plan || "trial",
            status: updatedShop?.billing?.status || "trial",
            vinLimit: updatedShop?.trialVinLimit || 10,
          },
          enabledFeatures: updatedShop?.enabledFeatures || {},
        },
      });
    }

    return NextResponse.json({ error: "Invalid action or no changes provided" }, { status: 400 });
  } catch (err) {
    console.error("Shop action error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = isNaN(Number(params.shopId)) ? params.shopId : Number(params.shopId);

    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    await db.collection("shops").deleteOne({ shopId });
    await db.collection("users").deleteMany({ shopId });
    await db.collection("sessions").deleteMany({ shopId });

    await db.collection("audit_logs").insertOne({
      type: "shop_deleted",
      shopId,
      shopName: shop.name,
      adminEmail: session.email,
      createdAt: new Date(),
    });

    return NextResponse.json({ ok: true, message: "Shop deleted permanently" });
  } catch (err) {
    console.error("Shop delete error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
