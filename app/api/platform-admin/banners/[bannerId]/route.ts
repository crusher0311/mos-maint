import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { BannersRepository } from "@/lib/repositories/onboarding-repository";

const repo = new BannersRepository();

export async function GET(req: NextRequest, { params }: { params: { bannerId: string } }) {
  try {
    await requirePlatformAdmin();
    const { bannerId } = await params;
    const banner = await repo.get(bannerId);
    if (!banner) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, banner });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { bannerId: string } }) {
  try {
    await requirePlatformAdmin();
    const { bannerId } = await params;
    const data = await req.json();
    const banner = await repo.update(bannerId, data);
    return NextResponse.json({ ok: true, banner });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { bannerId: string } }) {
  try {
    await requirePlatformAdmin();
    const { bannerId } = await params;
    await repo.delete(bannerId);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: error.message === "Unauthorized" ? 401 : 500 });
  }
}
