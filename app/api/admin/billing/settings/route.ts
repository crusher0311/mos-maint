import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requireSession } from "@/lib/auth";
import { getBillingSettings, sanitizeTrialReminderDays } from "@/lib/stripe";
import { logAdminAction } from "@/lib/audit-log";
import {
  DEFAULT_TRIAL_REMINDER_SUBJECT,
  DEFAULT_TRIAL_REMINDER_HTML,
  DEFAULT_TRIAL_REMINDER_TEXT,
} from "@/lib/email";

type TrialReminderField =
  | "trialReminderDays"
  | "trialReminderSubject"
  | "trialReminderHtml"
  | "trialReminderText";

const TRIAL_REMINDER_FIELDS: TrialReminderField[] = [
  "trialReminderDays",
  "trialReminderSubject",
  "trialReminderHtml",
  "trialReminderText",
];

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  return a === b;
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    
    if (session.role !== "admin" && session.role !== "platform_admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const body = await req.json();
    const db = await getDb();

    // Snapshot the current persisted (and sanitized) values so we can detect
    // which trial reminder fields were actually mutated by this admin save and
    // record an audit-log entry per change.
    const previousSettings = await getBillingSettings();

    const updateData = {
      type: "billing",
      // Tier-specific pricing
      starterProductId: body.starterProductId || "",
      starterPriceId: body.starterPriceId || "",
      starterPrice: body.starterPrice ?? 199.95,
      starterIncludedVins: body.starterIncludedVins ?? 300,
      plusProductId: body.plusProductId || "",
      plusPriceId: body.plusPriceId || "",
      plusPrice: body.plusPrice ?? 229.95,
      plusIncludedVins: body.plusIncludedVins ?? 300,
      eliteProductId: body.eliteProductId || "",
      elitePriceId: body.elitePriceId || "",
      elitePrice: body.elitePrice ?? 279.95,
      eliteIncludedVins: body.eliteIncludedVins ?? 300,
      // Detect Dog - Founder
      detectDogFounderProductId: body.detectDogFounderProductId || "prod_UPkRVM5SeF3RiT",
      detectDogFounderPriceId: body.detectDogFounderPriceId || "",
      detectDogFounderPrice: body.detectDogFounderPrice ?? 229.95,
      detectDogFounderIncludedVins: body.detectDogFounderIncludedVins ?? 300,
      // Legacy mosPro fields
      mosProProductId: body.mosProProductId || "",
      mosProPriceId: body.mosProPriceId || "",
      mosProPrice: body.mosProPrice ?? 199,
      // Onboarding
      onboardingProductId: body.onboardingProductId || "",
      onboardingPriceId: body.onboardingPriceId || "",
      onboardingPrice: body.onboardingPrice ?? 495,
      // Trial settings
      trialDays: body.trialDays ?? 14,
      foundingShopPricing: body.foundingShopPricing ?? true,
      // Trial reminder cron config (admin-tunable). Sanitize the day list
      // here so the cron always reads a clean array, and fall back to the
      // safe defaults if the admin clears a template field.
      trialReminderDays: sanitizeTrialReminderDays(body.trialReminderDays),
      trialReminderSubject:
        typeof body.trialReminderSubject === "string" && body.trialReminderSubject.trim()
          ? body.trialReminderSubject
          : DEFAULT_TRIAL_REMINDER_SUBJECT,
      trialReminderHtml:
        typeof body.trialReminderHtml === "string" && body.trialReminderHtml.trim()
          ? body.trialReminderHtml
          : DEFAULT_TRIAL_REMINDER_HTML,
      trialReminderText:
        typeof body.trialReminderText === "string" && body.trialReminderText.trim()
          ? body.trialReminderText
          : DEFAULT_TRIAL_REMINDER_TEXT,
      // Trial-conversion retry budget (see lib/trial-conversion-billing.ts).
      // Clamp to >= 1 so a typo can't suspend shops on the first failure.
      trialConversionMaxPaymentRetries: Math.max(
        1,
        Math.floor(Number(body.trialConversionMaxPaymentRetries)) || 3,
      ),
      updatedAt: new Date(),
      updatedBy: session.email,
    };

    await db.collection("platform_settings").updateOne(
      { type: "billing" },
      { $set: updateData },
      { upsert: true }
    );

    // Audit-log any trial reminder field changes so we can later answer
    // "who edited the template / schedule and when?". One entry per changed
    // field keeps the audit trail filterable and avoids burying a single
    // field change inside an opaque blob.
    //
    // We dual-write:
    //   1. `audit_logs` — the convention used by other trial-related events
    //      (see `shop_trial_reminder_sent` writes in
    //      `app/api/cron/trial-check/route.ts`). This is the system source of
    //      truth and is what shop-history / downstream tooling reads.
    //   2. `admin_audit_logs` via `logAdminAction()` — so the entry shows up
    //      in the existing platform-admin audit log view (which reads from
    //      `admin_audit_logs`).
    try {
      const headerStore = req.headers;
      const ipAddress =
        headerStore.get("x-forwarded-for") ||
        headerStore.get("x-real-ip") ||
        undefined;
      const userAgent = headerStore.get("user-agent") || undefined;
      const now = new Date();

      for (const field of TRIAL_REMINDER_FIELDS) {
        const before = previousSettings[field];
        const after = updateData[field];
        if (valuesEqual(before, after)) continue;

        await db.collection("audit_logs").insertOne({
          type: "billing_settings_change",
          adminEmail: session.email,
          field,
          before,
          after,
          ipAddress,
          userAgent,
          createdAt: now,
        });

        await logAdminAction({
          action: "billing_settings_change",
          adminEmail: session.email,
          ipAddress,
          userAgent,
          details: {
            field,
            before,
            after,
          },
        });
      }
    } catch (auditErr) {
      // Never let audit logging failures break the save itself.
      console.error("[billing/settings] Failed to write audit log:", auditErr);
    }

    // Return the persisted/sanitized values so the form can rehydrate its
    // local state — otherwise an admin who cleared (e.g.) the day list or a
    // template field would briefly see an empty input even though the
    // server stored the safe defaults.
    const { type: _type, updatedAt: _updatedAt, updatedBy: _updatedBy, ...persistedSettings } = updateData;
    return NextResponse.json({ success: true, settings: persistedSettings });
  } catch (error: any) {
    console.error("Error saving billing settings:", error);
    return NextResponse.json(
      { error: error.message || "Failed to save settings" },
      { status: 500 }
    );
  }
}
