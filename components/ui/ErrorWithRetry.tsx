"use client";

import React from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import Button from "./Button";

interface ErrorWithRetryProps {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
  variant?: "inline" | "card" | "banner";
}

export default function ErrorWithRetry({
  message,
  onRetry,
  retrying = false,
  className = "",
  variant = "inline"
}: ErrorWithRetryProps) {
  if (variant === "card") {
    return (
      <div className={`bg-red-50 border border-red-200 rounded-lg p-4 ${className}`}>
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-red-700">{message}</p>
            {onRetry && (
              <Button
                variant="outline"
                size="sm"
                onClick={onRetry}
                loading={retrying}
                className="mt-3"
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Try Again
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (variant === "banner") {
    return (
      <div className={`bg-red-50 border-l-4 border-red-400 p-4 ${className}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-red-500" />
            <p className="text-sm text-red-700">{message}</p>
          </div>
          {onRetry && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRetry}
              loading={retrying}
              className="text-red-700 hover:bg-red-100"
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              Retry
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 text-red-600 ${className}`}>
      <AlertCircle className="h-4 w-4 flex-shrink-0" />
      <span className="text-sm">{message}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          disabled={retrying}
          className="text-red-700 hover:text-red-800 underline text-sm font-medium inline-flex items-center gap-1 disabled:opacity-50"
        >
          {retrying ? (
            <>
              <RefreshCw className="h-3 w-3 animate-spin" />
              Retrying...
            </>
          ) : (
            <>
              <RefreshCw className="h-3 w-3" />
              Retry
            </>
          )}
        </button>
      )}
    </div>
  );
}
