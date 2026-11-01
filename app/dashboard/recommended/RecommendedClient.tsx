"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

const MODEL_OPTIONS = [
  { id: "gpt-4.1", label: "GPT-4.1 (Balanced)" },
  { id: "gpt-4o", label: "GPT-4o (Fastest)" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini" },
];

function fmtMiles(m?: number | null) {
  if (m === 0) return "0";
  if (m == null) return "";
  return m.toLocaleString();
}

interface AnalysisResult {
  ok: boolean;
  modelUsed?: string;
  parsed?: { recommendations?: Array<any> };
  raw?: string;
  error?: string;
  vehicle?: any;
  latestRoNumber?: string;
}

export default function RecommendedClient({ 
  initialVin, 
  initialModel 
}: { 
  initialVin: string; 
  initialModel: string; 
}) {
  const [vin, setVin] = useState(initialVin);
  const [model, setModel] = useState(initialModel);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [progress, setProgress] = useState("");

  // Auto-analyze if VIN is provided on load
  useEffect(() => {
    if (initialVin && !result) {
      handleAnalyze();
    }
  }, [initialVin]);

  // Check cache first
  const checkCache = async (vinToCheck: string) => {
    try {
      const response = await fetch(`/api/recommended/cache?vin=${encodeURIComponent(vinToCheck)}`);
      if (response.ok) {
        const cached = await response.json();
        if (cached.ok && cached.cached) {
          return cached;
        }
      }
    } catch (e) {
      console.warn('Cache check failed:', e);
    }
    return null;
  };

  // Save to cache after successful analysis
  const saveToCache = async (vinToSave: string, resultToSave: any) => {
    try {
      await fetch('/api/recommended/cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vin: vinToSave, result: resultToSave }),
      });
    } catch (e) {
      console.warn('Cache save failed:', e);
    }
  };

  const handleAnalyze = async () => {
    if (!vin.trim()) return;
    
    setIsAnalyzing(true);
    setResult(null);
    setProgress("Checking for cached analysis...");

    // First check cache
    const cached = await checkCache(vin.trim());
    if (cached) {
      setResult(cached);
      setIsAnalyzing(false);
      setProgress("");
      return;
    }

    try {
      // Try streaming first
      setProgress("Connecting to analysis service...");
      
      const response = await fetch('/api/recommended/analyze-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vin: vin.trim(), model }),
      });

      if (!response.ok) {
        throw new Error('Streaming failed, trying direct analysis...');
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response stream available, trying direct analysis...');
      }

      let buffer = '';
      const decoder = new TextDecoder();
      let hasData = false;
      const timeout = setTimeout(() => {
        if (!hasData) {
          reader.cancel();
          throw new Error('Stream timeout, trying direct analysis...');
        }
      }, 10000); // 10 second timeout

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        hasData = true;
        clearTimeout(timeout);
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              if (data.progress) {
                setProgress(data.progress);
              }
              
              if (data.result) {
                setResult(data.result);
                setIsAnalyzing(false);
                setProgress("");
                // Save to cache
                await saveToCache(vin.trim(), data.result);
                return;
              }
              
              if (data.error) {
                throw new Error(data.error);
              }
            } catch (e) {
              console.warn('Failed to parse progress update:', line);
            }
          }
        }
      }

    } catch (error: any) {
      console.warn('Streaming failed, trying direct API:', error.message);
      
      // Fallback to direct API call
      try {
        setProgress("Switching to direct analysis mode...");
        
        const directResponse = await fetch('/api/recommended/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vin: vin.trim(),
            model,
            dviData: { ok: false, error: 'Direct mode' },
            carfaxData: { ok: false, error: 'Direct mode' },
            oemData: []
          }),
        });

        if (!directResponse.ok) {
          throw new Error(`Direct analysis failed: ${directResponse.statusText}`);
        }

        const directResult = await directResponse.json();
        setResult(directResult);
        setIsAnalyzing(false);
        setProgress("");
        // Save to cache
        await saveToCache(vin.trim(), directResult);

      } catch (directError: any) {
        console.error('Both streaming and direct analysis failed:', directError);
        setResult({
          ok: false,
          error: `Analysis failed: ${directError.message}. Please try again or contact support.`
        });
        setIsAnalyzing(false);
        setProgress("");
      }
    }
  };

  const handleSubmit = (e: any) => {
    e.preventDefault();
    handleAnalyze();
  };

  const renderAnalysisResult = () => {
    if (!result) return null;

    if (!result.ok) {
      return (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <h3 className="text-lg font-medium text-red-800 mb-2">Analysis Failed</h3>
          <p className="text-red-700">{result.error}</p>
        </div>
      );
    }

    const recommendations = result.parsed?.recommendations || [];

    return (
      <div className="space-y-6">
        {/* Vehicle Info */}
        {result.vehicle && (
          <div className="rounded-2xl border p-4 bg-blue-50">
            <h3 className="font-medium mb-2">Vehicle Information</h3>
            <div className="text-sm space-y-1">
              <div>
                <strong>VIN:</strong> {result.vehicle.vin}
              </div>
              <div>
                <strong>Vehicle:</strong> {[result.vehicle.year, result.vehicle.make, result.vehicle.model].filter(Boolean).join(" ")}
              </div>
              {result.vehicle.lastMileage && (
                <div>
                  <strong>Mileage:</strong> {fmtMiles(result.vehicle.lastMileage)} miles
                </div>
              )}
              {result.latestRoNumber && (
                <div>
                  <strong>Latest RO:</strong> {result.latestRoNumber}
                </div>
              )}
            </div>
            <div className="mt-3 space-x-2">
              <Link 
                href={`/dashboard/vehicles/${encodeURIComponent(vin)}`}
                className="text-blue-600 hover:underline text-sm"
              >
                Open Vehicle
              </Link>
              <Link 
                href={`/dashboard/vehicles/${encodeURIComponent(vin)}/plan`}
                className="text-blue-600 hover:underline text-sm"
              >
                Open Plan
              </Link>
            </div>
          </div>
        )}

        {/* AI Model Used */}
        {result.modelUsed && (
          <div className="text-xs text-gray-500">
            Analysis performed using: <strong>{result.modelUsed}</strong>
          </div>
        )}

        {/* Recommendations */}
        <div className="rounded-2xl border overflow-hidden">
          <div className="bg-gray-50 p-4 border-b">
            <h3 className="font-medium">AI Recommendations ({recommendations.length})</h3>
          </div>
          
          {recommendations.length === 0 ? (
            <div className="p-6 text-center text-gray-500">
              No specific recommendations generated. Vehicle appears to be in good condition.
            </div>
          ) : (
            <div className="divide-y">
              {recommendations.map((rec: any, i: number) => (
                <div key={i} className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <h4 className="font-medium text-lg">{rec.title || `Recommendation ${i + 1}`}</h4>
                    {rec.priority && (
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        rec.priority === 'Immediate' 
                          ? 'bg-red-100 text-red-800'
                          : rec.priority === 'Soon'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-green-100 text-green-800'
                      }`}>
                        Priority: {rec.priority}
                      </span>
                    )}
                  </div>
                  
                  {rec.description && (
                    <p className="text-gray-700 mb-2">{rec.description}</p>
                  )}
                  
                  {rec.timing && (
                    <p className="text-sm text-gray-600">
                      <strong>Timing:</strong> {rec.timing}
                    </p>
                  )}
                  
                  {rec.notes && (
                    <p className="text-sm text-gray-600 mt-1">
                      <strong>Notes:</strong> {rec.notes}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Raw Output (if available) */}
        {result.raw && (
          <details className="rounded-2xl border">
            <summary className="p-4 cursor-pointer font-medium bg-gray-50">
              Raw AI Output (for debugging)
            </summary>
            <div className="p-4 text-xs font-mono bg-gray-100 whitespace-pre-wrap max-h-96 overflow-auto">
              {result.raw}
            </div>
          </details>
        )}
      </div>
    );
  };

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Recommended (AI)</h1>
        <div className="text-sm">
          <Link href="/dashboard" className="underline">
            ← Back to Dashboard
          </Link>
        </div>
      </div>

      {/* Analysis Form */}
      <form onSubmit={handleSubmit} className="rounded-2xl border p-4 space-y-3">
        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">VIN</label>
            <input
              type="text"
              value={vin}
              onChange={(e: any) => setVin(e.target.value)}
              placeholder="Enter VIN"
              className="w-full border rounded p-2 text-sm"
              required
              disabled={isAnalyzing}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">AI Model</label>
            <select 
              value={model} 
              onChange={(e: any) => setModel(e.target.value)} 
              className="w-full border rounded p-2 text-sm"
              disabled={isAnalyzing}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end">
            <button
              type="submit"
              disabled={isAnalyzing || !vin.trim()}
              className={`w-full sm:w-auto rounded px-4 py-2 text-sm font-medium ${
                isAnalyzing || !vin.trim()
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-black text-white hover:bg-gray-800'
              }`}
            >
              {isAnalyzing ? 'Analyzing...' : 'Analyze'}
            </button>
          </div>
        </div>
      </form>

      {/* Progress Indicator */}
      {isAnalyzing && (
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-center space-x-3">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
            <div>
              <div className="font-medium text-blue-900">Analysis in Progress</div>
              <div className="text-sm text-blue-700">{progress}</div>
            </div>
          </div>
          <div className="mt-3 text-xs text-blue-600">
            This may take 30-60 seconds. We're fetching DVI data, CARFAX reports, OEM maintenance schedules, and running AI analysis.
          </div>
        </div>
      )}

      {/* Results */}
      {renderAnalysisResult()}

      {/* Help Text */}
      {!vin && !isAnalyzing && !result && (
        <div className="text-sm text-gray-600 bg-gray-50 rounded-2xl p-4">
          <h3 className="font-medium mb-2">How AI Recommendations Work</h3>
          <p className="mb-2">
            Our AI analyzes multiple data sources to provide prioritized maintenance recommendations:
          </p>
          <ul className="list-disc list-inside space-y-1 text-xs">
            <li><strong>DVI Data:</strong> Digital Vehicle Inspection findings</li>
            <li><strong>CARFAX:</strong> Vehicle history and service records</li>
            <li><strong>OEM Schedule:</strong> Manufacturer maintenance intervals</li>
            <li><strong>AI Analysis:</strong> Intelligent prioritization and timing</li>
          </ul>
        </div>
      )}
    </main>
  );
}