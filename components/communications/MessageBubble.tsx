"use client";

import { Phone, MessageSquare, Mail, Voicemail } from "lucide-react";

type Channel = "call" | "sms" | "email" | "voicemail";

interface MessageBubbleProps {
  content: string;
  channel: Channel;
  timestamp: string;
  isOutbound?: boolean;
  senderName?: string;
}

const channelConfig: Record<Channel, { icon: typeof Phone; label: string; color: string }> = {
  call: { icon: Phone, label: "Call", color: "text-green-600 bg-green-50" },
  sms: { icon: MessageSquare, label: "SMS", color: "text-blue-600 bg-blue-50" },
  email: { icon: Mail, label: "Email", color: "text-purple-600 bg-purple-50" },
  voicemail: { icon: Voicemail, label: "Voicemail", color: "text-orange-600 bg-orange-50" },
};

export function MessageBubble({ content, channel, timestamp, isOutbound = false, senderName }: MessageBubbleProps) {
  const config = channelConfig[channel];
  const Icon = config.icon;

  return (
    <div className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[75%] ${isOutbound ? "items-end" : "items-start"}`}>
        <div className="flex items-center gap-1.5 mb-1">
          {senderName && (
            <span className="text-xs font-medium text-gray-600">{senderName}</span>
          )}
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${config.color}`}>
            <Icon className="w-2.5 h-2.5" />
            {config.label}
          </span>
        </div>
        <div
          className={`rounded-xl px-3.5 py-2.5 ${
            isOutbound
              ? "bg-blue-600 text-white rounded-br-sm"
              : "bg-white border border-gray-200 text-gray-800 rounded-bl-sm"
          }`}
        >
          <p className="text-sm leading-relaxed">{content}</p>
        </div>
        <span className="text-[10px] text-gray-400 mt-1 block">
          {new Date(timestamp).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      </div>
    </div>
  );
}

export function ChannelBadge({ channel }: { channel: Channel }) {
  const config = channelConfig[channel];
  const Icon = config.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${config.color}`}>
      <Icon className="w-3 h-3" />
      {config.label}
    </span>
  );
}
