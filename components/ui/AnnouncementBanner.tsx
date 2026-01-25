"use client";

import { useState, useEffect } from "react";
import { AlertTriangle, AlertCircle, Info, X } from "lucide-react";

interface Announcement {
  _id: string;
  title: string;
  message: string;
  priority: "info" | "warning" | "critical";
  sentAt: string;
}

const PRIORITY_STYLES = {
  info: {
    bg: "bg-blue-50 border-blue-200",
    text: "text-blue-800",
    icon: Info,
  },
  warning: {
    bg: "bg-amber-50 border-amber-200",
    text: "text-amber-800",
    icon: AlertCircle,
  },
  critical: {
    bg: "bg-red-50 border-red-200",
    text: "text-red-800",
    icon: AlertTriangle,
  },
};

export function AnnouncementBanner() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const stored = localStorage.getItem("dismissed_announcements");
    if (stored) {
      try {
        setDismissedIds(new Set(JSON.parse(stored)));
      } catch {
        // Ignore invalid JSON
      }
    }
    loadAnnouncements();
  }, []);

  const loadAnnouncements = async () => {
    try {
      const res = await fetch("/api/announcements/active");
      const data = await res.json();
      if (data.announcements) {
        setAnnouncements(data.announcements);
      }
    } catch (error) {
      console.error("Error loading announcements:", error);
    }
  };

  const handleDismiss = (id: string) => {
    const newDismissed = new Set(dismissedIds);
    newDismissed.add(id);
    setDismissedIds(newDismissed);
    localStorage.setItem("dismissed_announcements", JSON.stringify([...newDismissed]));
  };

  const visibleAnnouncements = announcements.filter(
    (a) => !dismissedIds.has(a._id)
  );

  if (visibleAnnouncements.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 mb-4">
      {visibleAnnouncements.map((announcement) => {
        const styles = PRIORITY_STYLES[announcement.priority];
        const Icon = styles.icon;
        const isCritical = announcement.priority === "critical";

        return (
          <div
            key={announcement._id}
            className={`flex items-start gap-3 p-3 rounded-lg border ${styles.bg} ${styles.text}`}
          >
            <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${isCritical ? "animate-pulse" : ""}`} />
            <div className="flex-1 min-w-0">
              <h4 className="font-semibold text-sm">{announcement.title}</h4>
              <p className="text-sm opacity-90 mt-0.5 line-clamp-2">{announcement.message}</p>
            </div>
            {!isCritical && (
              <button
                onClick={() => handleDismiss(announcement._id)}
                className="p-1 hover:bg-white/50 rounded transition-colors flex-shrink-0"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
