import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { markAsRead, deleteNotification } from "@/lib/notifications";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = params;
  
  const numId = Number(id);
  if (isNaN(numId)) {
    return NextResponse.json({ ok: false, error: "Invalid notification ID" }, { status: 400 });
  }

  const body = await req.json();
  const userId = session.email;
  
  if (body.read === true) {
    const success = await markAsRead(id, userId);
    return NextResponse.json({ ok: success });
  }

  return NextResponse.json({ ok: false, error: "Invalid update" }, { status: 400 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = params;
  
  const numId = Number(id);
  if (isNaN(numId)) {
    return NextResponse.json({ ok: false, error: "Invalid notification ID" }, { status: 400 });
  }

  const userId = session.email;
  const success = await deleteNotification(id, userId);
  return NextResponse.json({ ok: success });
}
