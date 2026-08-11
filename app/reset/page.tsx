// app/reset/page.tsx
import { Suspense } from "react";
import ResetPasswordForm from "./ResetPasswordForm";

export const dynamic = "force-dynamic";

export default function ResetPage() {
  return (
    <main className="mx-auto max-w-md p-6 space-y-6">
      <h1 className="text-2xl font-bold">Reset Password</h1>
      <Suspense fallback={<div className="text-sm text-gray-500">Loading…</div>}>
        <ResetPasswordForm />
      </Suspense>
    </main>
  );
}

