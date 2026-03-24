import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { corporateBrandingRepo, brandingThemeRepo } from "@/lib/db/repositories/crm-accounts";

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const url = new URL(req.url);
    const type = url.searchParams.get("type");

    if (type === "themes") {
      const themes = await brandingThemeRepo.list();
      return NextResponse.json({ ok: true, themes });
    }

    const branding = await corporateBrandingRepo.get();
    return NextResponse.json({ ok: true, branding });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await req.json();
    const url = new URL(req.url);
    const type = url.searchParams.get("type");

    if (type === "themes") {
      if (!body.name || !body.primaryColor || !body.secondaryColor || !body.previewPrimary || !body.previewSecondary) {
        return NextResponse.json({ ok: false, error: "Name and colors are required" }, { status: 400 });
      }
      const theme = await brandingThemeRepo.create(body);
      return NextResponse.json({ ok: true, theme });
    }

    const branding = await corporateBrandingRepo.upsert(body);
    return NextResponse.json({ ok: true, branding });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await req.json();
    const url = new URL(req.url);
    const type = url.searchParams.get("type");

    if (type === "themes") {
      if (!body.id) return NextResponse.json({ ok: false, error: "ID required" }, { status: 400 });
      const { id, ...data } = body;
      const theme = await brandingThemeRepo.update(id, data);
      return NextResponse.json({ ok: true, theme });
    }

    const branding = await corporateBrandingRepo.upsert(body);
    return NextResponse.json({ ok: true, branding });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "ID required" }, { status: 400 });
    await brandingThemeRepo.delete(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
