"use client";

import { useState, useEffect } from "react";
import { 
  Calendar, 
  Clock, 
  Check, 
  X, 
  Loader2, 
  AlertCircle, 
  Car,
  User,
  Phone,
  CheckCircle,
  XCircle,
  Send,
  RefreshCw
} from "lucide-react";
import Link from "next/link";

interface QueuedBooking {
  _id: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  vin?: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  serviceType: string;
  serviceMileage?: number;
  scheduledDate: string;
  scheduledTime: string;
  status: "pending" | "confirmed" | "sent" | "failed" | "cancelled";
  confirmationMode: "auto" | "review";
  createdAt: string;
  confirmedAt?: string;
  sentAt?: string;
  failedReason?: string;
}

export default function BookingQueuePage() {
  const [loading, setLoading] = useState(true);
  const [bookings, setBookings] = useState<QueuedBooking[]>([]);
  const [filter, setFilter] = useState<string>("pending,confirmed");
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetchBookings();
  }, [filter]);

  async function fetchBookings() {
    setLoading(true);
    try {
      const res = await fetch(`/api/settings/auto-booking/queue?status=${filter}`);
      const data = await res.json();
      setBookings(data.bookings || []);
    } catch (err) {
      setMessage({ type: "error", text: "Failed to load bookings" });
    } finally {
      setLoading(false);
    }
  }

  async function handleAction(bookingId: string, action: "confirm" | "cancel") {
    setProcessingId(bookingId);
    setMessage(null);
    
    try {
      const res = await fetch("/api/settings/auto-booking/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, bookingId }),
      });
      
      if (res.ok) {
        setMessage({ 
          type: "success", 
          text: action === "confirm" ? "Booking confirmed" : "Booking cancelled" 
        });
        fetchBookings();
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Action failed" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Action failed" });
    } finally {
      setProcessingId(null);
    }
  }

  function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", { 
      weekday: "short", 
      month: "short", 
      day: "numeric" 
    });
  }

  function formatTime(timeStr: string): string {
    const [hours, minutes] = timeStr.split(":");
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 || 12;
    return `${hour12}:${minutes} ${ampm}`;
  }

  function getStatusBadge(status: string) {
    switch (status) {
      case "pending":
        return <span className="px-2 py-1 text-xs rounded-full bg-amber-100 text-amber-700">Pending Review</span>;
      case "confirmed":
        return <span className="px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-700">Confirmed</span>;
      case "sent":
        return <span className="px-2 py-1 text-xs rounded-full bg-green-100 text-green-700">Sent to Schedule</span>;
      case "failed":
        return <span className="px-2 py-1 text-xs rounded-full bg-red-100 text-red-700">Failed</span>;
      case "cancelled":
        return <span className="px-2 py-1 text-xs rounded-full bg-gray-100 text-gray-700">Cancelled</span>;
      default:
        return null;
    }
  }

  const pendingCount = bookings.filter(b => b.status === "pending").length;
  const confirmedCount = bookings.filter(b => b.status === "confirmed").length;

  return (
    <div className="flex-1 p-8 overflow-auto bg-gray-50">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Calendar className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Booking Queue</h1>
              <p className="text-gray-500">Review and confirm auto-booked appointments</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard/settings/auto-booking"
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
            >
              Settings
            </Link>
            <button
              onClick={fetchBookings}
              className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg"
            >
              <RefreshCw className="w-5 h-5" />
            </button>
          </div>
        </div>

        {message && (
          <div className={`flex items-center gap-2 p-4 rounded-lg ${
            message.type === "success" ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"
          }`}>
            {message.type === "success" ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
            <span className="font-medium">{message.text}</span>
          </div>
        )}

        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-amber-100 rounded-lg">
                <Clock className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{pendingCount}</p>
                <p className="text-sm text-gray-500">Pending Review</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Check className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{confirmedCount}</p>
                <p className="text-sm text-gray-500">Confirmed</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <Send className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">
                  {bookings.filter(b => b.status === "sent").length}
                </p>
                <p className="text-sm text-gray-500">Sent to Schedule</p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200">
          <div className="p-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900">Queued Bookings</h2>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg"
            >
              <option value="pending">Pending Only</option>
              <option value="pending,confirmed">Pending & Confirmed</option>
              <option value="sent">Sent</option>
              <option value="failed,cancelled">Failed & Cancelled</option>
              <option value="pending,confirmed,sent,failed,cancelled">All</option>
            </select>
          </div>

          {loading ? (
            <div className="p-8 text-center">
              <Loader2 className="w-8 h-8 animate-spin text-gray-400 mx-auto" />
            </div>
          ) : bookings.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <Calendar className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p>No bookings in queue</p>
              <p className="text-sm mt-1">
                Auto-booked appointments will appear here when stickers are generated
              </p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {bookings.map((booking) => (
                <div key={booking._id} className="p-4 hover:bg-gray-50">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        {getStatusBadge(booking.status)}
                        <span className="text-sm text-gray-500">
                          {booking.serviceType}
                        </span>
                      </div>
                      
                      <div className="flex items-center gap-4 text-sm">
                        <div className="flex items-center gap-1.5">
                          <User className="w-4 h-4 text-gray-400" />
                          <span className="font-medium text-gray-900">{booking.customerName}</span>
                        </div>
                        {booking.customerPhone && (
                          <div className="flex items-center gap-1.5 text-gray-500">
                            <Phone className="w-4 h-4 text-gray-400" />
                            {booking.customerPhone}
                          </div>
                        )}
                      </div>
                      
                      {(booking.vehicleYear || booking.vehicleMake || booking.vehicleModel) && (
                        <div className="flex items-center gap-1.5 text-sm text-gray-600 mt-1">
                          <Car className="w-4 h-4 text-gray-400" />
                          {[booking.vehicleYear, booking.vehicleMake, booking.vehicleModel]
                            .filter(Boolean)
                            .join(" ")}
                          {booking.vin && (
                            <span className="text-gray-400 ml-2">({booking.vin.slice(-6)})</span>
                          )}
                        </div>
                      )}

                      {booking.failedReason && (
                        <div className="mt-2 text-sm text-red-600 flex items-center gap-1">
                          <AlertCircle className="w-4 h-4" />
                          {booking.failedReason}
                        </div>
                      )}
                    </div>

                    <div className="text-right flex-shrink-0">
                      <div className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                        <Calendar className="w-4 h-4 text-gray-400" />
                        {formatDate(booking.scheduledDate)}
                      </div>
                      <div className="flex items-center gap-1.5 text-sm text-gray-500 mt-1">
                        <Clock className="w-4 h-4 text-gray-400" />
                        {formatTime(booking.scheduledTime)}
                      </div>
                    </div>

                    {booking.status === "pending" && (
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={() => handleAction(booking._id, "confirm")}
                          disabled={processingId === booking._id}
                          className="p-2 bg-green-100 text-green-700 rounded-lg hover:bg-green-200 disabled:opacity-50"
                          title="Confirm"
                        >
                          {processingId === booking._id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Check className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          onClick={() => handleAction(booking._id, "cancel")}
                          disabled={processingId === booking._id}
                          className="p-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 disabled:opacity-50"
                          title="Cancel"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    )}

                    {booking.status === "confirmed" && (
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={() => handleAction(booking._id, "cancel")}
                          disabled={processingId === booking._id}
                          className="p-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                          title="Cancel"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
