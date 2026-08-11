import { Suspense } from "react";
import ForgotForm from "./ForgotForm";

export const dynamic = "force-dynamic";

export default function ForgotPage() {
  return (
    <main className="mx-auto max-w-md p-6 space-y-6">
      <h1 className="text-2xl font-bold">Forgot Password</h1>
      <p className="text-sm text-gray-600">Enter your email (and Shop ID if needed).</p>
      <Suspense fallback={<div className="text-sm text-gray-500">Loading…</div>}>
        <ForgotForm />
      </Suspense>
    </main>
  );
}

