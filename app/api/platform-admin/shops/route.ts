import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import bcrypt from "bcryptjs";
import { sendEmail, makeCredentialsWelcomeEmail } from "@/lib/email";
import { getStripe, getBillingSettings } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TRIAL_VIN_LIMIT = 10;
const DEFAULT_TRIAL_DAYS = 14;
const MAX_TRIAL_DAYS = 365;

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const db = await getDb();
    
    const [shops, platformSettings, billingSettings, enterprises] = await Promise.all([
      db.collection("shops").find().toArray(),
      db.collection("platform_settings").findOne({ key: "trial" }),
      getBillingSettings(),
      db.collection("enterprise_accounts").find().toArray(),
    ]);
    
    // Build enterprise lookup map
    const enterpriseMap = new Map(enterprises.map(e => [e._id.toString(), e]));
    
    const defaultVinLimit = platformSettings?.vinLimit ?? DEFAULT_TRIAL_VIN_LIMIT;
    const defaultTrialDays = billingSettings?.trialDays ?? DEFAULT_TRIAL_DAYS;
    const shopIds = shops.map(s => s.shopId);
    
    const allShopIdVariants = shopIds.flatMap(id => [id, String(id), Number(id)]).filter(id => id !== null && !isNaN(id as number));
    
    // Get first day of current month for monthly sticker counts
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    
    const [userCounts, vehicleCounts, vinViewCounts, backfillProgress, tekmetricBackfillProgress, jobHistoryCounts, jobIndexCounts, stickerCounts, stickerCountsThisMonth] = await Promise.all([
      db.collection("users").aggregate([
        { $match: { shopId: { $in: shopIds } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("vehicles").aggregate([
        { $match: { shopId: { $in: allShopIdVariants } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("viewed_vins").aggregate([
        { $match: { shopId: { $in: shopIds } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("backfill_progress").find({ shopId: { $in: shopIds.map(Number) } }).toArray(),
      db.collection("tekmetric_backfill_progress").find({ shopId: { $in: shopIds.map(Number) } }).toArray(),
      db.collection("job_history").aggregate([
        { $match: { shopId: { $in: allShopIdVariants } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("job_index").aggregate([
        { $match: { shopId: { $in: allShopIdVariants } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("sticker_generations").aggregate([
        { $match: { shopId: { $in: allShopIdVariants } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray(),
      db.collection("sticker_generations").aggregate([
        { $match: { shopId: { $in: allShopIdVariants }, generatedAt: { $gte: monthStart } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } }
      ]).toArray()
    ]);
    
    const userCountMap = new Map(userCounts.map(u => [String(u._id), u.count]));
    const vinViewCountMap = new Map(vinViewCounts.map(v => [String(v._id), v.count]));
    const backfillMap = new Map(backfillProgress.map(b => [String(b.shopId), b]));
    const tekmetricBackfillMap = new Map(tekmetricBackfillProgress.map(b => [String(b.shopId), b]));
    
    const jobHistoryCountMap = new Map<string, number>();
    for (const j of jobHistoryCounts) {
      const key = String(j._id);
      jobHistoryCountMap.set(key, (jobHistoryCountMap.get(key) || 0) + j.count);
    }
    
    const jobIndexCountMap = new Map<string, number>();
    for (const j of jobIndexCounts) {
      const key = String(j._id);
      jobIndexCountMap.set(key, (jobIndexCountMap.get(key) || 0) + j.count);
    }
    
    const stickerCountMap = new Map<string, number>();
    for (const s of stickerCounts) {
      const key = String(s._id);
      stickerCountMap.set(key, (stickerCountMap.get(key) || 0) + s.count);
    }
    
    const stickerCountThisMonthMap = new Map<string, number>();
    for (const s of stickerCountsThisMonth) {
      const key = String(s._id);
      stickerCountThisMonthMap.set(key, (stickerCountThisMonthMap.get(key) || 0) + s.count);
    }
    
    const vehicleCountMap = new Map<string, number>();
    for (const v of vehicleCounts) {
      const key = String(v._id);
      vehicleCountMap.set(key, (vehicleCountMap.get(key) || 0) + v.count);
    }
    
    const enrichedShops = shops.map(shop => {
      const integrations: string[] = [];
      if (shop.protractor?.configured || shop.protractor?.apiKey || shop.protractorApiKey || shop.protractorConnectionId) integrations.push("Protractor");
      if (shop.tekmetric?.shopId || shop.tekmetricShopId) integrations.push("Tekmetric");
      if (shop.autoflow?.apiKey || shop.autoflow?.configured || shop.autoflowApiKey) integrations.push("AutoFlow");
      if (shop.carfax?.locationId || shop.carfax?.serviceId || shop.carfaxLocationId) integrations.push("CARFAX");
      if (shop.autovitals?.apiKey || shop.autovitals?.configured || shop.autovitalsApiKey) integrations.push("AutoVitals");
      if (shop.shopware?.tenantId) integrations.push("Shop-Ware");
      
      const isPaid = shop.billing?.plan === "professional" || shop.billing?.plan === "enterprise" || shop.billing?.plan === "pro" || shop.billing?.plan === "demo" || shop.billing?.plan === "detect_dog_founder";
      const vinLimit = shop.billing?.vinLimit ?? shop.trialVinLimit ?? defaultVinLimit;
      const vinViewCount = vinViewCountMap.get(String(shop.shopId)) || 0;
      const hasProtractor = !!(shop.protractor?.configured || shop.protractor?.apiKey || shop.protractorApiKey || shop.protractorConnectionId);
      const hasTekmetric = !!(shop.tekmetric?.shopId || shop.tekmetricShopId);
      const activeIntegration = shop.integrationProvider === "tekmetric" ? "tekmetric" 
        : shop.integrationProvider === "protractor" ? "protractor"
        : hasTekmetric ? "tekmetric" : hasProtractor ? "protractor" : null;
      const backfill = backfillMap.get(String(shop.shopId));
      const tekmetricBackfill = tekmetricBackfillMap.get(String(shop.shopId));
      const jobHistoryCount = jobHistoryCountMap.get(String(shop.shopId)) || 0;
      const jobIndexCount = jobIndexCountMap.get(String(shop.shopId)) || 0;
      
      const protractorLocation = shop.protractor?.locations?.[0];
      
      // Get enterprise info if this shop belongs to one
      const enterprise = shop.enterpriseId ? enterpriseMap.get(shop.enterpriseId.toString()) : null;
      
      const trialEndsAtRaw = shop.trial?.endsAt || shop.trialEndsAt || null;
      const trialEndsAt = trialEndsAtRaw ? new Date(trialEndsAtRaw) : null;
      const trialStartedAtRaw = shop.trial?.startedAt || shop.trialStartedAt || null;
      const trialStartedAt = trialStartedAtRaw ? new Date(trialStartedAtRaw) : null;
      const trialDaysLength = shop.trial?.days ?? shop.trialDays ?? null;
      const trialDaysLeft = trialEndsAt
        ? Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
        : null;
      const cardOnFile = shop.cardOnFile === true || shop.billing?.cardOnFile === true;

      return {
        _id: shop._id,
        shopId: shop.shopId,
        name: shop.name || `Shop ${shop.shopId}`,
        locationIdentifier: shop.locationIdentifier || null,
        enterpriseId: shop.enterpriseId?.toString() || null,
        enterpriseName: enterprise?.name || null,
        createdAt: shop.createdAt || shop._id.getTimestamp?.() || new Date(),
        userCount: userCountMap.get(String(shop.shopId)) || 0,
        vehicleCount: vehicleCountMap.get(String(shop.shopId)) || 0,
        integrations,
        isLocked: shop.isLocked || false,
        cardOnFile,
        trial: trialEndsAt ? {
          startedAt: trialStartedAt,
          endsAt: trialEndsAt,
          days: trialDaysLength,
          daysLeft: trialDaysLeft,
          cardOnFile,
        } : null,
        billing: {
          plan: shop.billing?.plan || "trial",
          status: shop.billing?.status || "trial",
          isPaid,
          vinLimit,
          vinViewCount,
          cardOnFile,
          stripeSubscriptionAmount: (typeof shop.stripeSubscriptionAmount === "number" ? shop.stripeSubscriptionAmount : null)
            ?? (typeof shop.billing?.stripeSubscriptionAmount === "number" ? shop.billing.stripeSubscriptionAmount : null),
          stripeProductName: shop.billing?.stripeProductName || null,
        },
        stickerCount: stickerCountMap.get(String(shop.shopId)) || 0,
        stickerCountThisMonth: stickerCountThisMonthMap.get(String(shop.shopId)) || 0,
        stickerConfig: shop.stickerConfig || {},
        enabledFeatures: shop.enabledFeatures || {},
        backfill: activeIntegration ? (() => {
          const bf = activeIntegration === "protractor" ? backfill : tekmetricBackfill;
          const completed = bf?.completed || false;
          const inProgress = bf?.inProgress === true;
          const lastActivityAt = bf?.lastActivityAt || bf?.lastAttemptedAt || bf?.lastRunAt || null;
          const lastError = bf?.lastError || null;
          const lastErrorAt = bf?.lastErrorAt || null;
          
          const STALE_THRESHOLD_MS = 10 * 60 * 1000;
          const lastActiveTime = lastActivityAt ? new Date(lastActivityAt).getTime() : 0;
          
          const tekLastRun = bf?.lastRunAt ? new Date(bf.lastRunAt).getTime() : 0;
          const tekQueued = bf?.queuedAt ? new Date(bf.queuedAt).getTime() : 0;
          const tekMostRecent = Math.max(tekLastRun, tekQueued);
          
          const isTekmetricActive = activeIntegration === "tekmetric" && !completed && 
            tekMostRecent > 0 && (Date.now() - tekMostRecent < STALE_THRESHOLD_MS);
          
          const isStale = !completed && !isTekmetricActive && (
            (activeIntegration === "protractor" && inProgress && lastActiveTime && (Date.now() - lastActiveTime > STALE_THRESHOLD_MS)) ||
            (activeIntegration === "tekmetric" && tekMostRecent > 0 && (Date.now() - tekMostRecent > STALE_THRESHOLD_MS))
          );
          
          let status: "completed" | "active" | "stale" | "error" | "pending" = "pending";
          if (completed) {
            status = "completed";
          } else if (lastError && lastErrorAt) {
            status = "error";
          } else if (inProgress || isTekmetricActive) {
            status = "active";
          } else if (isStale) {
            status = "stale";
          } else if (bf?.queuedAt || bf?.currentChunkEnd) {
            status = "active";
          }
          
          return {
            completed,
            inProgress: inProgress || isTekmetricActive || false,
            status,
            isStale,
            totalJobsIndexed: jobIndexCount || bf?.totalJobsIndexed || 0,
            currentChunkDate: bf?.currentChunkEnd || bf?.currentChunkStart || null,
            source: activeIntegration,
            lastAttemptedAt: bf?.lastAttemptedAt || bf?.lastRunAt || null,
            lastActivityAt: lastActivityAt || bf?.lastRunAt || null,
            lastError,
            lastErrorAt,
            processedCount: bf?.processedCount || 0,
          };
        })() : null,
        integrationDetails: {
          protractor: shop.protractor?.configured ? {
            configuredAt: shop.protractor.configuredAt,
            locationName: protractorLocation?.Name || null,
            shortName: protractorLocation?.ShortName || null,
            address: protractorLocation?.Address ? 
              `${protractorLocation.Address.Street}, ${protractorLocation.Address.City}, ${protractorLocation.Address.Province} ${protractorLocation.Address.PostalCode}` : null,
            phone: protractorLocation?.PhoneNumber || null,
            timeZone: protractorLocation?.TimeZone || null,
          } : null,
          carfax: shop.carfax?.locationId ? {
            locationId: shop.carfax.locationId,
          } : null,
          tekmetric: shop.tekmetric?.shopId ? {
            shopId: shop.tekmetric.shopId,
          } : null,
        },
      };
    });
    
    return NextResponse.json({
      ok: true,
      shops: enrichedShops.sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
      defaultVinLimit,
      defaultTrialDays,
    });
  } catch (err: any) {
    console.error("Platform shops error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { shopName, ownerEmail, ownerPassword, ownerName, plan, status, vinLimit, features, trialDays } = body;

    if (!shopName || !ownerEmail || !ownerPassword) {
      return NextResponse.json({ error: "Shop name, owner email, and password are required" }, { status: 400 });
    }

    const db = await getDb();
    const billingSettings = await getBillingSettings();
    const defaultTrialDays = billingSettings?.trialDays ?? DEFAULT_TRIAL_DAYS;

    let trialDaysParsed: number | null = null;
    if (trialDays !== undefined && trialDays !== null && trialDays !== "") {
      const parsed = Number(trialDays);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_TRIAL_DAYS) {
        return NextResponse.json(
          { error: `Trial days must be between 1 and ${MAX_TRIAL_DAYS}` },
          { status: 400 }
        );
      }
      trialDaysParsed = Math.floor(parsed);
    } else {
      trialDaysParsed = defaultTrialDays;
    }

    const existingUser = await db.collection("users").findOne({ email: ownerEmail.toLowerCase().trim() });
    if (existingUser) {
      return NextResponse.json({ error: "A user with this email already exists" }, { status: 409 });
    }

    const counter = await db.collection("counters").findOneAndUpdate(
      { _id: "shopId" as any },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );
    let newShopId = counter?.seq || counter?.value?.seq;
    if (!newShopId || newShopId < 1001) {
      const lastShop = await db.collection("shops")
        .find({}, { projection: { shopId: 1 } })
        .sort({ shopId: -1 })
        .limit(1)
        .toArray();
      const maxId = (lastShop.length > 0 && typeof lastShop[0].shopId === 'number') 
        ? lastShop[0].shopId : 1000;
      newShopId = maxId + 1;
      await db.collection("counters").updateOne(
        { _id: "shopId" as any },
        { $set: { seq: newShopId } },
        { upsert: true }
      );
    }

    const now = new Date();
    const normalizedOwnerEmail = ownerEmail.toLowerCase().trim();
    const useDayBasedTrial = (status || "trial") === "trial" && trialDaysParsed && trialDaysParsed > 0;
    const trialEndsAt = useDayBasedTrial
      ? new Date(now.getTime() + trialDaysParsed * 24 * 60 * 60 * 1000)
      : null;

    let stripeCustomerId: string | null = null;
    try {
      const stripeClient = getStripe();
      const customer = await stripeClient.customers.create({
        email: normalizedOwnerEmail,
        name: shopName.trim(),
        metadata: {
          shopId: String(newShopId),
          createdVia: "platform_admin_create_shop",
          createdBy: session.email,
        },
      });
      stripeCustomerId = customer.id;
    } catch (stripeErr: any) {
      console.error(`[Platform Admin] Failed to create Stripe customer for shop ${newShopId}:`, stripeErr?.message);
    }

    const shopDoc: Record<string, any> = {
      shopId: newShopId,
      name: shopName.trim(),
      status: "active",
      billing: {
        plan: plan || "trial",
        status: status || "trial",
        cardOnFile: false,
        ...(stripeCustomerId ? { stripeCustomerId } : {}),
      },
      trialVinLimit: vinLimit ? Number(vinLimit) : 10,
      enabledFeatures: features || { maintenance: true },
      cardOnFile: false,
      ...(stripeCustomerId ? { stripeCustomerId } : {}),
      createdAt: now,
      updatedAt: now,
      createdBy: session.email,
    };

    if (useDayBasedTrial && trialEndsAt) {
      shopDoc.trial = {
        mode: "days",
        days: trialDaysParsed,
        startedAt: now,
        endsAt: trialEndsAt,
        reminderSent: {},
      };
      shopDoc.trialDays = trialDaysParsed;
      shopDoc.trialStartedAt = now;
      shopDoc.trialEndsAt = trialEndsAt;
    }

    await db.collection("shops").insertOne(shopDoc);

    const hashedPassword = await bcrypt.hash(ownerPassword, 12);
    const normalizedEmail = ownerEmail.toLowerCase().trim();
    const userDoc = {
      email: normalizedEmail,
      emailLower: normalizedEmail,
      passwordHash: hashedPassword,
      name: ownerName?.trim() || ownerEmail.split("@")[0],
      shopId: newShopId,
      role: "admin",
      mustChangePassword: true,
      createdAt: now,
      updatedAt: now,
    };

    await db.collection("users").insertOne(userDoc);

    await db.collection("audit_logs").insertOne({
      type: "shop_created",
      shopId: newShopId,
      shopName: shopName.trim(),
      ownerEmail: normalizedOwnerEmail,
      plan: plan || "trial",
      trialDays: useDayBasedTrial ? trialDaysParsed : null,
      trialEndsAt: trialEndsAt,
      stripeCustomerId,
      adminEmail: session.email,
      createdAt: now,
    });

    const emailLower = normalizedOwnerEmail;
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools";
    const loginUrl = `${baseUrl}/login`;
    let emailSent = false;

    try {
      const emailContent = makeCredentialsWelcomeEmail(
        shopName.trim(),
        emailLower,
        ownerPassword,
        loginUrl,
        undefined,
        useDayBasedTrial && trialEndsAt
          ? { trialDays: trialDaysParsed!, trialEndsAt }
          : undefined,
      );
      await sendEmail({ to: emailLower, ...emailContent });
      emailSent = true;
      console.log(`[Platform Admin] Welcome email sent to ${emailLower} for shop ${newShopId}`);
    } catch (emailErr: any) {
      console.error(`[Platform Admin] Failed to send welcome email to ${emailLower}:`, emailErr?.message);
    }

    return NextResponse.json({ 
      ok: true, 
      shop: { 
        shopId: newShopId, 
        name: shopName.trim(),
        trialEndsAt,
        trialDays: useDayBasedTrial ? trialDaysParsed : null,
        stripeCustomerId,
      },
      emailSent,
      message: `Shop "${shopName.trim()}" created with ID ${newShopId}${useDayBasedTrial ? ` (${trialDaysParsed}-day trial ends ${trialEndsAt!.toLocaleDateString()})` : ""}${emailSent ? ". Welcome email sent." : ". Note: Welcome email could not be sent."}`
    });
  } catch (err: any) {
    console.error("Create shop error:", err);
    return NextResponse.json({ error: err?.message || "Failed to create shop" }, { status: 500 });
  }
}
