"use client";

import { User, Bot } from "lucide-react";

interface TranscriptTurn {
  speaker: "caller" | "agent" | "system";
  text: string;
  timestamp?: string;
}

interface TranscriptViewerProps {
  turns: TranscriptTurn[];
  maxHeight?: string;
}

export function TranscriptViewer({ turns, maxHeight = "400px" }: TranscriptViewerProps) {
  return (
    <div className="space-y-3 overflow-y-auto pr-1" style={{ maxHeight }}>
      {turns.map((turn, i) => (
        <div key={i} className={`flex gap-2.5 ${turn.speaker === "agent" ? "flex-row-reverse" : ""}`}>
          <div
            className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
              turn.speaker === "agent"
                ? "bg-blue-100 text-blue-600"
                : turn.speaker === "system"
                  ? "bg-gray-100 text-gray-500"
                  : "bg-green-100 text-green-600"
            }`}
          >
            {turn.speaker === "agent" ? (
              <Bot className="w-3.5 h-3.5" />
            ) : (
              <User className="w-3.5 h-3.5" />
            )}
          </div>
          <div
            className={`max-w-[80%] rounded-lg px-3 py-2 ${
              turn.speaker === "agent"
                ? "bg-blue-50 border border-blue-100"
                : turn.speaker === "system"
                  ? "bg-gray-50 border border-gray-100 italic"
                  : "bg-white border border-gray-200"
            }`}
          >
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xs font-medium text-gray-600 capitalize">{turn.speaker === "agent" ? "Rescue Rover" : turn.speaker}</span>
              {turn.timestamp && (
                <span className="text-[10px] text-gray-400">{turn.timestamp}</span>
              )}
            </div>
            <p className="text-sm text-gray-800 leading-relaxed">{turn.text}</p>
          </div>
        </div>
      ))}
      {turns.length === 0 && (
        <div className="text-center py-8 text-gray-400 text-sm">No transcript available</div>
      )}
    </div>
  );
}
