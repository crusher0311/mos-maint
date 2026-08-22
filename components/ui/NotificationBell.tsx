"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Bell, X, Check, ExternalLink } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";

interface Notification {
  _id: string;
  type: string;
  title: string;
  message: string;
  link?: string;
  read: boolean;
  createdAt: string;
}

interface NotificationBellProps {
  isPlatformAdmin?: boolean;
}

export function NotificationBell({ isPlatformAdmin = false }: NotificationBellProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const apiBase = isPlatformAdmin ? "/api/platform-admin/notifications" : "/api/notifications";

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}?limit=10`);
      const data = await res.json();
      if (data.ok) {
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
      }
    } catch (error) {
      console.error("Error fetching notifications:", error);
    }
  }, [apiBase]);

  const fetchCount = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/count`);
      const data = await res.json();
      if (data.ok) {
        setUnreadCount(data.unreadCount || 0);
      }
    } catch (error) {
      console.error("Error fetching notification count:", error);
    }
  }, [apiBase]);

  useEffect(() => {
    // Pause the unread-count poll while the tab is hidden, and refresh
    // immediately when the user comes back.
    const tick = () => {
      if (!document.hidden) fetchCount();
    };
    fetchCount();
    const interval = setInterval(tick, 30000);
    const handleVisibility = () => {
      if (!document.hidden) fetchCount();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchCount]);

  useEffect(() => {
    if (isOpen) {
      fetchNotifications();
    }
  }, [isOpen, fetchNotifications]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const markAsRead = async (id: string) => {
    try {
      const endpoint = isPlatformAdmin 
        ? `/api/platform-admin/notifications/${id}`
        : `/api/notifications/${id}`;
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ read: true }),
      });
      if (res.ok) {
        setNotifications(prev =>
          prev.map(n => (n._id === id ? { ...n, read: true } : n))
        );
        setUnreadCount(prev => Math.max(0, prev - 1));
      }
    } catch (error) {
      console.error("Error marking notification as read:", error);
    }
  };

  const markAllAsRead = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "markAllRead" }),
      });
      if (res.ok) {
        setNotifications(prev => prev.map(n => ({ ...n, read: true })));
        setUnreadCount(0);
      }
    } catch (error) {
      console.error("Error marking all as read:", error);
    } finally {
      setLoading(false);
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "ticket_created":
        return <span className="w-2 h-2 rounded-full bg-blue-500" />;
      case "ticket_updated":
        return <span className="w-2 h-2 rounded-full bg-purple-500" />;
      case "ticket_message":
        return <span className="w-2 h-2 rounded-full bg-green-500" />;
      case "ticket_resolved":
        return <span className="w-2 h-2 rounded-full bg-emerald-500" />;
      default:
        return <span className="w-2 h-2 rounded-full bg-gray-500" />;
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`relative p-2 rounded-lg transition-colors ${
          isPlatformAdmin
            ? "text-slate-300 hover:bg-slate-700 hover:text-white"
            : "text-slate-600 hover:bg-slate-100"
        }`}
        aria-label="Notifications"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold bg-red-500 text-white rounded-full">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label={isPlatformAdmin ? "Shared admin notifications" : "Notifications"}
          className={`absolute top-[calc(100%+0.5rem)] w-[min(24rem,calc(100vw-1rem))] max-h-[calc(100dvh-5rem)] overflow-hidden rounded-xl border shadow-2xl z-[100] ${
            isPlatformAdmin ? "right-0 sm:left-0 sm:right-auto" : "right-0"
          } ${
            isPlatformAdmin
              ? "bg-white border-slate-300 text-slate-950"
              : "bg-white border-slate-200"
          }`}
        >
          <div
            className={`flex items-center justify-between px-4 py-3 border-b ${
              isPlatformAdmin ? "border-slate-200 bg-slate-50" : "border-slate-200"
            }`}
          >
            <h3
              className={`font-semibold ${
                isPlatformAdmin ? "text-slate-950" : "text-slate-900"
              }`}
            >
              Notifications
            </h3>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={markAllAsRead}
                  disabled={loading}
                  className={`text-xs px-2 py-1 rounded transition-colors ${
                    isPlatformAdmin
                      ? "text-blue-700 hover:text-blue-900 hover:bg-blue-100 disabled:opacity-50"
                      : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  Mark all read
                </button>
              )}
              <button
                onClick={() => setIsOpen(false)}
                className={`p-1 rounded transition-colors ${
                  isPlatformAdmin
                    ? "text-slate-600 hover:text-slate-950 hover:bg-slate-200"
                    : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                }`}
              >
                <X className="w-4 h-4" />
                <span className="sr-only">Close notifications</span>
              </button>
            </div>
          </div>

          <div className="overflow-y-auto max-h-[calc(100dvh-12rem)] overscroll-contain">
            {notifications.length === 0 ? (
              <div
                className={`px-4 py-8 text-center ${
                  isPlatformAdmin ? "text-slate-600" : "text-slate-500"
                }`}
              >
                <Bell className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No notifications yet</p>
              </div>
            ) : (
              <div className={isPlatformAdmin ? "divide-y divide-slate-200" : "divide-y divide-slate-200"}>
                {notifications.map((notification) => (
                  <div
                    key={notification._id}
                    className={`px-4 py-3 transition-colors border-l-4 ${
                      !notification.read
                        ? isPlatformAdmin
                          ? "bg-blue-50 border-blue-600"
                          : "bg-blue-50 border-blue-500"
                        : "border-transparent"
                    } ${
                      isPlatformAdmin
                        ? "hover:bg-slate-50"
                        : "hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-1.5">
                        {getTypeIcon(notification.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p
                           className={`text-sm font-semibold whitespace-normal break-words ${
                             isPlatformAdmin ? "text-slate-950" : "text-slate-900"
                          }`}
                        >
                          {notification.title}
                        </p>
                        <p
                           className={`text-sm leading-5 mt-1 whitespace-normal break-words ${
                             isPlatformAdmin ? "text-slate-700" : "text-slate-500"
                          }`}
                        >
                          {notification.message}
                        </p>
                        <p
                           className={`text-xs mt-2 ${
                             isPlatformAdmin ? "text-slate-600" : "text-slate-400"
                          }`}
                          title={new Date(notification.createdAt).toLocaleString()}
                        >
                          {formatDistanceToNow(new Date(notification.createdAt), {
                            addSuffix: true,
                          })}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {!notification.read && isPlatformAdmin && (
                          <span className="sr-only">Unread notification</span>
                        )}
                        {notification.link && (
                          <Link
                            href={notification.link}
                            onClick={() => {
                              if (!notification.read) {
                                markAsRead(notification._id);
                              }
                              setIsOpen(false);
                            }}
                            className={`p-1 rounded transition-colors ${
                              isPlatformAdmin
                                ? "text-blue-700 hover:text-blue-950 hover:bg-blue-100"
                                : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                            }`}
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            <span className="sr-only">Open notification</span>
                          </Link>
                        )}
                        {!notification.read && (
                          <button
                            onClick={() => markAsRead(notification._id)}
                            className={`p-1 rounded transition-colors ${
                              isPlatformAdmin
                                ? "text-blue-700 hover:text-blue-950 hover:bg-blue-100"
                                : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                            }`}
                            title="Mark as read"
                            aria-label="Mark notification as read"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div
            className={`px-4 py-2 border-t text-center ${
              isPlatformAdmin ? "border-slate-200 bg-slate-50" : "border-slate-200"
            }`}
          >
            <Link
              href={isPlatformAdmin ? "/platform-admin/tickets" : "/dashboard/support"}
              onClick={() => setIsOpen(false)}
              className={`text-xs font-medium ${
                isPlatformAdmin
                  ? "text-blue-700 hover:text-blue-900"
                  : "text-blue-600 hover:text-blue-700"
              }`}
            >
              View all tickets
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
