"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

function LoadingFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full p-8 text-center">
        <Loader2 className="w-8 h-8 mx-auto text-indigo-600 animate-spin" />
      </div>
    </div>
  );
}

const SetupWizardContent = dynamic(
  () => import("./SetupWizardContent"),
  { 
    ssr: false,
    loading: LoadingFallback 
  }
);

export default function SetupWizard() {
  return <SetupWizardContent />;
}
