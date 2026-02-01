import { NextResponse } from "next/server";
import sql from "@/lib/db/postgres";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ vin: string }> }
) {
  const { vin } = await ctx.params;
  const url = new URL(req.url);
  const redirectTo = url.searchParams.get("redirect");

  const cleanVin = (vin || "").toUpperCase();
  if (!cleanVin || cleanVin.length < 6) {
    return NextResponse.json({ error: "Invalid VIN" }, { status: 400 });
  }

  await sql`
    INSERT INTO events (provider, type, vehicle_vin, status, created_at, payload)
    VALUES ('ui', 'manual_closed', ${cleanVin}, 'Closed', NOW(), ${JSON.stringify({ reason: "manual_close_from_dashboard" })}::jsonb)
  `;

  if (redirectTo) {
    return NextResponse.redirect(new URL(redirectTo, url), 303);
  }

  return NextResponse.json({ ok: true, vin: cleanVin });
}
