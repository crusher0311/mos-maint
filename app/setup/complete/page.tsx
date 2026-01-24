import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

function LoadingFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full p-8 text-center">
        <Loader2 className="w-12 h-12 mx-auto text-indigo-600 animate-spin" />
        <h2 className="mt-4 text-xl font-semibold text-gray-900">
          Loading...
        </h2>
      </div>
    </div>
  );
}

const SetupCompleteContent = dynamic(
  () => import("./SetupCompleteContent"),
  { 
    ssr: false,
    loading: LoadingFallback 
  }
);

export default function SetupCompletePage() {
  return <SetupCompleteContent />;
}
