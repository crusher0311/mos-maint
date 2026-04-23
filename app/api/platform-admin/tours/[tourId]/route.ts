import { NextRequest, NextResponse } from "next/server";
import { crmDisabledResponse } from "@/lib/feature-flags/gate";
import { requirePlatformAdmin } from "@/lib/auth";
import { ToursRepository } from "@/lib/repositories/onboarding-repository";

const repo = new ToursRepository();

export async function GET(req: NextRequest, { params }: { params: { tourId: string } }) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const { tourId } = await params;
    const tour = await repo.get(tourId);
    if (!tour) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, tour });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { tourId: string } }) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const { tourId } = await params;
    const data = await req.json();
    const tour = await repo.update(tourId, data);
    return NextResponse.json({ ok: true, tour });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { tourId: string } }) {
  const __gated = crmDisabledResponse();
  if (__gated) return __gated;

  try {
    await requirePlatformAdmin();
    const { tourId } = await params;
    await repo.delete(tourId);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}
