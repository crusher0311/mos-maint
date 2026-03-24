import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { contactRepo } from "@/lib/db/repositories/crm-contacts";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;
    const body = await req.json();
    const { type, entityId, roleTypeId, isPrimary } = body;
    if (!type || !entityId) {
      return NextResponse.json({ ok: false, error: "type and entityId are required" }, { status: 400 });
    }
    let assignment;
    switch (type) {
      case "agency":
        assignment = await contactRepo.addAgencyAssignment({ contactId: id, agencyId: entityId, roleTypeId, isPrimary });
        break;
      case "parentOrg":
        assignment = await contactRepo.addParentOrgAssignment({ contactId: id, parentOrgId: entityId, roleTypeId, isPrimary });
        break;
      case "account":
        assignment = await contactRepo.addAccountAssignment({ contactId: id, accountId: entityId, roleTypeId, isPrimary });
        break;
      case "location":
        assignment = await contactRepo.addLocationAssignment({ contactId: id, locationId: entityId, roleTypeId, isPrimary });
        break;
      default:
        return NextResponse.json({ ok: false, error: "Invalid type" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, assignment });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const url = new URL(req.url);
    const type = url.searchParams.get("type");
    const assignmentId = url.searchParams.get("assignmentId");
    if (!type || !assignmentId) {
      return NextResponse.json({ ok: false, error: "type and assignmentId are required" }, { status: 400 });
    }
    await contactRepo.removeAssignment(type, assignmentId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
