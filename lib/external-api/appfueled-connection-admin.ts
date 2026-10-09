import { NextRequest, NextResponse } from "next/server";
import { AppFueledInputError, parseConnectionShopId } from "./appfueled-credentials";
import { BodyError, readBoundedJson } from "./bounded-json";

export function createAppFueledConnectionAdmin(deps: {
  getSession: () => Promise<{ isPlatformAdmin?: boolean; email?: string } | null>;
  get: (id: number) => Promise<unknown>;
  replace: (body: unknown, actor: string) => Promise<unknown>;
  disable: (id: number, actor: string) => Promise<unknown>;
}) {
  const respond = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  return async (req: NextRequest, action: "get" | "replace" | "disable") => {
    try {
      const session = await deps.getSession();
      if (!session?.isPlatformAdmin) return respond({ error: "Forbidden" }, 403);
      const actor = session.email || "platform_admin";
      let connection;
      if (action === "get") {
        connection = await deps.get(parseConnectionShopId(Number(req.nextUrl.searchParams.get("shopId"))));
      } else {
        const body: any = await readBoundedJson(req);
        if (action === "replace") connection = await deps.replace(body, actor);
        else {
          if (body?.isActive !== false) return respond({ error: "Only disabling is supported; replace credentials to enable" }, 400);
          connection = await deps.disable(parseConnectionShopId(body?.shopId), actor);
          if (!connection) return respond({ error: "Connection not found" }, 404);
        }
      }
      return respond({ success: true, connection });
    } catch (error: any) {
      if (error instanceof AppFueledInputError) return respond({ error: error.message }, 400);
      if (error instanceof BodyError) return respond({ error: error.message }, error.status);
      if (error?.code === "23505" || error?.cause?.code === "23505")
        return respond({ error: "Connection is already assigned to another MOS shop" }, 409);
      return respond({ error: "Credential management unavailable" }, 503);
    }
  };
}
