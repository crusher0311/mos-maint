import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { contactRepo } from "@/lib/db/repositories/crm-contacts";

export async function POST(req: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await req.json();
    const { contacts, columnMapping } = body;

    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return NextResponse.json({ ok: false, error: "No contacts to import" }, { status: 400 });
    }

    if (!columnMapping || !columnMapping.firstName || !columnMapping.lastName) {
      return NextResponse.json({ ok: false, error: "firstName and lastName column mappings are required" }, { status: 400 });
    }

    const validContacts: any[] = [];
    const errors: { row: number; error: string }[] = [];

    for (let i = 0; i < contacts.length; i++) {
      const row = contacts[i];
      const firstName = row[columnMapping.firstName]?.toString().trim();
      const lastName = row[columnMapping.lastName]?.toString().trim();

      if (!firstName || !lastName) {
        errors.push({ row: i + 1, error: "Missing first name or last name" });
        continue;
      }

      validContacts.push({
        firstName,
        lastName,
        email: columnMapping.email ? row[columnMapping.email]?.toString().trim() || null : null,
        phone: columnMapping.phone ? row[columnMapping.phone]?.toString().trim() || null : null,
        mobile: columnMapping.mobile ? row[columnMapping.mobile]?.toString().trim() || null : null,
        title: columnMapping.title ? row[columnMapping.title]?.toString().trim() || null : null,
        department: columnMapping.department ? row[columnMapping.department]?.toString().trim() || null : null,
        address: columnMapping.address ? row[columnMapping.address]?.toString().trim() || null : null,
        city: columnMapping.city ? row[columnMapping.city]?.toString().trim() || null : null,
        state: columnMapping.state ? row[columnMapping.state]?.toString().trim() || null : null,
        zip: columnMapping.zip ? row[columnMapping.zip]?.toString().trim() || null : null,
        status: "Active",
      });
    }

    let imported: any[] = [];
    if (validContacts.length > 0) {
      imported = await contactRepo.bulkCreate(validContacts);
    }

    return NextResponse.json({
      ok: true,
      imported: imported.length,
      errors,
      total: contacts.length,
    });
  } catch (e: any) {
    if (e?.message?.includes("Unauthorized")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
