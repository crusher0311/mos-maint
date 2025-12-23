import { Suspense } from "react";
import SetupWizard from "./SetupWizard";
import SetupForm from "./SetupForm";
import { Wrench } from "lucide-react";

export const dynamic = "force-dynamic";

function SetupContent({ hasToken }: { hasToken: boolean }) {
  if (hasToken) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <div className="flex justify-center">
            <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center">
              <Wrench className="w-7 h-7 text-white" />
            </div>
          </div>
          <h1 className="mt-6 text-center text-3xl font-bold text-gray-900">
            Complete Your Account
          </h1>
          <p className="mt-2 text-center text-sm text-gray-600">
            Set up your password to finish joining MOS Maintenance
          </p>
        </div>

        <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
          <div className="bg-white py-8 px-6 shadow-sm rounded-xl border border-gray-200">
            <SetupForm />
          </div>
        </div>
      </div>
    );
  }

  return <SetupWizard />;
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;
  const hasToken = Boolean(params.token);

  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
      <SetupContent hasToken={hasToken} />
    </Suspense>
  );
}

