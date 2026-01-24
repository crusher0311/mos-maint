"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, CheckCircle, XCircle } from "lucide-react";

export default function SetupCompleteContent() {
  const searchParams = useSearchParams();
  const pendingId = searchParams.get("pending_id");
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!pendingId) {
      setStatus("error");
      setError("Invalid setup link");
      return;
    }

    const completeSetup = async () => {
      try {
        const res = await fetch("/api/auth/setup-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pendingId }),
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || "Failed to complete setup");
        }

        setStatus("success");
        
        setTimeout(() => {
          window.location.href = "/dashboard";
        }, 1500);
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Setup failed");
      }
    };

    completeSetup();
  }, [pendingId]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full p-8 text-center">
        {status === "loading" && (
          <>
            <Loader2 className="w-12 h-12 mx-auto text-indigo-600 animate-spin" />
            <h2 className="mt-4 text-xl font-semibold text-gray-900">
              Setting up your account...
            </h2>
            <p className="mt-2 text-gray-600">
              This will only take a moment.
            </p>
          </>
        )}

        {status === "success" && (
          <>
            <CheckCircle className="w-12 h-12 mx-auto text-green-600" />
            <h2 className="mt-4 text-xl font-semibold text-gray-900">
              Account Created!
            </h2>
            <p className="mt-2 text-gray-600">
              Redirecting you to your dashboard...
            </p>
          </>
        )}

        {status === "error" && (
          <>
            <XCircle className="w-12 h-12 mx-auto text-red-600" />
            <h2 className="mt-4 text-xl font-semibold text-gray-900">
              Setup Error
            </h2>
            <p className="mt-2 text-gray-600">{error}</p>
            <button
              onClick={() => window.location.href = "/setup"}
              className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
            >
              Try Again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
