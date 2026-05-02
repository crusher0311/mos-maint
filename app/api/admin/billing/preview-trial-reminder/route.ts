import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { sendEmail, makeTrialReminderEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();

    if (
      session.role !== "admin" &&
      session.role !== "platform_admin" &&
      !session.isPlatformAdmin
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    if (!session.email) {
      return NextResponse.json(
        { error: "Your session has no email address; cannot send a test email." },
        { status: 400 },
      );
    }

    const parsed: unknown = await req.json().catch(() => ({}));
    const body: Record<string, unknown> =
      parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

    const subject = typeof body.subject === "string" ? body.subject : undefined;
    const html = typeof body.html === "string" ? body.html : undefined;
    const text = typeof body.text === "string" ? body.text : undefined;

    const rawDays =
      typeof body.daysLeft === "number" || typeof body.daysLeft === "string"
        ? Number(body.daysLeft)
        : NaN;
    const daysLeft =
      Number.isFinite(rawDays) && rawDays > 0 ? Math.trunc(rawDays) : 3;

    const sampleShopName =
      typeof body.shopName === "string" && body.shopName.trim()
        ? body.shopName.trim()
        : "Sample Auto Shop";

    const trialEndsAt = new Date(Date.now() + daysLeft * 24 * 60 * 60 * 1000);
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.APP_BASE_URL ||
      req.nextUrl.origin;
    const addCardUrl = `${baseUrl.replace(/\/$/, "")}/dashboard/settings/billing`;

    const rendered = makeTrialReminderEmail(
      sampleShopName,
      daysLeft,
      trialEndsAt,
      addCardUrl,
      { subject, html, text },
    );

    // Render-only mode lets the UI grab the rendered HTML/text/subject for
    // an inline preview without actually sending an email.
    const renderOnly = body.mode === "render";

    if (!renderOnly) {
      await sendEmail({
        to: session.email,
        subject: `[TEST] ${rendered.subject}`,
        html: rendered.html,
        text: rendered.text,
      });
    }

    return NextResponse.json({
      ok: true,
      sent: !renderOnly,
      sentTo: renderOnly ? null : session.email,
      rendered: {
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      },
      sampleValues: {
        shopName: sampleShopName,
        daysLeft,
        dayWord: daysLeft === 1 ? "day" : "days",
        trialEndsAt: trialEndsAt.toISOString(),
        addCardUrl,
      },
    });
  } catch (err: any) {
    console.error("[preview-trial-reminder] error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to preview trial reminder" },
      { status: 500 },
    );
  }
}
