import { NextRequest, NextResponse } from "next/server";
import { getSession, isPasswordChangeRequiredError, passwordChangeRequiredResponse } from "@/lib/auth";
import { validateExtensionToken, buildAuthErrorBody, getAuthErrorStatus } from "@/lib/extension-auth";
import { personalTutorialPreferences } from "@/lib/tutorial-preference-store";
import { parseTutorialAction, tutorialState } from "@/lib/tutorial-preferences";

export const tutorialRouteDeps = { getSession, validateExtensionToken, personalTutorialPreferences };
export const tutorialCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store",
};

export async function handleTutorialRequest(request: NextRequest, extension: boolean) {
  const headers = extension ? tutorialCors : { "Cache-Control": "no-store" };
  const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
  try {
    let personId: string | null = null;
    let canSave = true;
    if (extension) {
      const auth = await tutorialRouteDeps.validateExtensionToken(request);
      if (!auth.authorized || !auth.user) return reply(buildAuthErrorBody(auth), getAuthErrorStatus(auth));
      const principal = auth.principal;
      if (principal?.assurance === "verified" && principal.userId) personId = principal.userId;
      canSave = Boolean(personId && principal?.capabilities.includes("write"));
    } else {
      const session = await tutorialRouteDeps.getSession();
      if (!session) return reply({ error: "Sign in required" }, 401);
      // Test/dev identities and impersonation must never create personal choices.
      if (!session.isTestAuth && !session.isImpersonation) personId = session.userId || null;
      canSave = Boolean(personId);
      if (request.method === "PUT") {
        const origin = request.headers.get("origin");
        if (!origin || origin !== request.nextUrl.origin) return reply({ error: "Same-origin request required" }, 403);
      }
    }
    if (request.method === "PUT" && !canSave) return reply({ error: "Verified personal write access required" }, 403);
    let action;
    if (request.method === "PUT") {
      const text = await request.text();
      if (text.length > 256) return reply({ error: "Tutorial preference is too large" }, 400);
      let body;
      try { body = JSON.parse(text); } catch { return reply({ error: "Invalid tutorial preference" }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "Invalid tutorial preference" }, 400);
      const { expectedPersonId, ...choice } = body;
      // A stale tab may submit after another tab changes the cookie/account.
      // This is a precondition only; it never selects the record to update.
      if (typeof expectedPersonId !== "string" || expectedPersonId !== personId) {
        return reply({ error: "Tutorial identity changed; reopen help" }, 409);
      }
      action = parseTutorialAction(choice);
      if (!action) return reply({ error: "Invalid tutorial preference" }, 400);
    }
    const result = personId
      ? await tutorialRouteDeps.personalTutorialPreferences(personId, action || undefined)
      : { state: tutorialState(null) };
    return reply({ personId, persistent: Boolean(personId), canSave, ...result });
  } catch (error) {
    if (isPasswordChangeRequiredError(error)) return passwordChangeRequiredResponse();
    return reply({ error: "Tutorial preferences unavailable" }, 503);
  }
}
