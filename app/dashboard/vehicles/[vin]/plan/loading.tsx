"use client";

import { useEffect, useState, useRef } from "react";

const loadingSteps = [
  { text: "Fetching vehicle information", icon: "🚗" },
  { text: "Loading OEM maintenance schedule", icon: "📋" },
  { text: "Checking service history", icon: "🔍" },
  { text: "Analyzing inspection findings", icon: "🔧" },
  { text: "Building your maintenance plan", icon: "✨" },
];

const SLOW_THRESHOLD = 25;

export default function PlanLoading() {
  const [currentStep, setCurrentStep] = useState(0);
  const [progress, setProgress] = useState(5);
  const [seconds, setSeconds] = useState(0);
  const hasLoggedSlow = useRef(false);

  useEffect(() => {
    const stepInterval = setInterval(() => {
      setCurrentStep((prev) => (prev < loadingSteps.length - 1 ? prev + 1 : prev));
    }, 700);

    const progressInterval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 90) return prev;
        return prev + Math.random() * 12 + 3;
      });
    }, 250);

    const secondsInterval = setInterval(() => {
      setSeconds((prev) => prev + 1);
    }, 1000);

    return () => {
      clearInterval(stepInterval);
      clearInterval(progressInterval);
      clearInterval(secondsInterval);
    };
  }, []);

  useEffect(() => {
    if (seconds >= SLOW_THRESHOLD && !hasLoggedSlow.current) {
      hasLoggedSlow.current = true;
      const vin = typeof window !== "undefined" ? window.location.pathname.split("/")[3] : "unknown";
      fetch("/api/logs/slow-plan-load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vin, seconds, timestamp: new Date().toISOString() }),
      }).catch(() => {});
    }
  }, [seconds]);

  const isOverThreshold = seconds >= SLOW_THRESHOLD;

  return (
    <div className="min-h-[70vh] bg-gray-50 flex items-center justify-center">
      <div className="bg-white rounded-xl shadow-lg p-8 max-w-md w-full mx-4">
        <div className="flex flex-col items-center text-center">
          <div className="relative mb-6">
            <div className={`w-20 h-20 border-4 rounded-full ${isOverThreshold ? 'border-red-200' : 'border-blue-200'}`}></div>
            <div className={`w-20 h-20 border-4 rounded-full border-t-transparent animate-spin absolute top-0 left-0 ${isOverThreshold ? 'border-red-500' : 'border-blue-600'}`}></div>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className={`text-lg font-semibold ${isOverThreshold ? 'text-red-500' : 'text-blue-600'}`}>
                {seconds}s
              </span>
            </div>
          </div>
          
          <h2 className="text-xl font-semibold text-gray-800 mb-2">
            Building Your Maintenance Plan
          </h2>
          
          <p className="text-gray-500 mb-2 text-sm">
            We're gathering all the data for your personalized report
          </p>
          
          <p className="text-orange-400 mb-4 text-xs italic">
            Initial loads may take up to 30 seconds while we load your smart plan
          </p>

          <div className="w-full bg-gray-200 rounded-full h-2 mb-6">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-300 ease-out"
              style={{ width: `${Math.min(progress, 90)}%` }}
            />
          </div>
          
          <div className="w-full space-y-3 text-left">
            {loadingSteps.map((step, index) => (
              <div
                key={step.text}
                className={`flex items-center gap-3 transition-all duration-300 ${
                  index < currentStep
                    ? "opacity-100"
                    : index === currentStep
                    ? "opacity-100"
                    : "opacity-40"
                }`}
              >
                {index < currentStep ? (
                  <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                    <svg className="w-4 h-4 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                ) : index === currentStep ? (
                  <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                    <div className="w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : (
                  <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                    <div className="w-2 h-2 rounded-full bg-gray-300" />
                  </div>
                )}
                <span className={`text-sm ${
                  index <= currentStep ? "text-gray-700" : "text-gray-400"
                }`}>
                  {step.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
