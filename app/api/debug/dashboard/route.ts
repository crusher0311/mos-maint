import { NextRequest, NextResponse } from "next/server";
import type { Filter } from "mongodb";
import {
  countCustomers,
  findCustomers,
  type CustomerDoc,
} from "@/lib/data/repositories/customers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const shopParam = url.searchParams.get("shop") ?? "";
  if (!shopParam) {
    return NextResponse.json({ ok: false, error: "missing ?shop" }, { status: 400 });
  }

  const shopIdNum = Number(shopParam);
  const shopIdStr = String(shopParam);

  const filter: Filter<CustomerDoc> = {
    $and: [
      { $or: [{ shopId: shopIdNum }, { shopId: shopIdStr }] },
      { status: { $nin: ["closed", "Close", "CLOSED", "Appointment"] } },
      {
        $or: [
          { "vehicle.vin": { $exists: true, $ne: "" } },
          { lastVin: { $exists: true, $ne: "" } },
        ],
      },
    ],
  };

  const projection: Record<string, 0 | 1> = {
    name: 1,
    status: 1,
    lastStatus: 1,
    lastTicketId: 1,
    updatedAt: 1,
    lastVin: 1,
    vehicle: 1,
  };

  const count = await countCustomers(filter);
  const sample = await findCustomers(filter, {
    sort: { updatedAt: -1 },
    limit: 10,
    projection,
  });

  return NextResponse.json({
    ok: true,
    shop: shopIdStr,
    count,
    sample,
  });
}
