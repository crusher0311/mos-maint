import { getSession } from "@/lib/auth";
import { assertRecoveryOperator } from "@/lib/auto-dvi/durable/access";
import RecoveryClient from "./RecoveryClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

export default async function AutoDviRecoveryPage() {
  const session = await getSession();
  let permitted = false;
  if (session && !session.isImpersonation && !session.impersonatedBy && !session.mustChangePassword) {
    try {
      await assertRecoveryOperator({ shopId: Number(session.shopId), actor: session.email });
      permitted = true;
    } catch {
      // Fail closed, including membership, feature-gate, and capability failures.
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">Auto DVI recovery</h1>
        <p className="text-sm text-slate-600">Operator tools for a tracked push. Never retry the whole inspection.</p>
      </header>
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Historical uncertain pushes are manual only. A dashboard role alone is not enough:
        live shop membership and an explicit, unexpired operator capability are required.
        An empty operator allowlist means no live recovery is enabled.
      </div>
      {!permitted || !session ? (
        <section aria-labelledby="access-denied" className="rounded-lg border border-slate-200 bg-slate-50 p-5">
          <h2 id="access-denied" className="font-semibold text-slate-900">Access denied</h2>
          <p className="mt-2 text-sm text-slate-600">
            Recovery requires an authorized operator signed in to this shop. Impersonation
            and accounts requiring a password change cannot use this page. Contact your
            administrator to verify access; no recovery action has been taken.
          </p>
        </section>
      ) : (
        <RecoveryClient key={`${session.shopId}:${session.email}`} />
      )}
    </main>
  );
}
