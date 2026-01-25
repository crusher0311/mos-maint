"use client";

import { useState, useEffect } from "react";
import { Monitor, RefreshCw, User, Building2, Ticket, ExternalLink, Play } from "lucide-react";

interface CobrowseDevice {
  id: string;
  customData?: {
    user_email?: string;
    ticket_id?: string;
    shop_id?: string;
  };
  lastActive: string;
  online: boolean;
}

export default function CobrowsePage() {
  const [devices, setDevices] = useState<CobrowseDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectCode, setConnectCode] = useState("");
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const fetchDevices = async () => {
      try {
        const res = await fetch("/api/platform-admin/cobrowse/devices");
        const data = await res.json();
        if (data.ok) {
          setDevices(data.devices || []);
        }
      } catch (error) {
        console.error("Error fetching devices:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchDevices();
    const interval = setInterval(fetchDevices, 10000);
    return () => clearInterval(interval);
  }, []);

  const refreshDevices = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-admin/cobrowse/devices");
      const data = await res.json();
      if (data.ok) {
        setDevices(data.devices || []);
      }
    } catch (error) {
      console.error("Error fetching devices:", error);
    } finally {
      setLoading(false);
    }
  };

  const connectWithCode = async () => {
    if (!connectCode.trim()) return;
    setConnecting(true);
    
    const cobrowseUrl = `https://cobrowse.io/connect?code=${connectCode.trim()}`;
    window.open(cobrowseUrl, "_blank", "width=1200,height=800");
    
    setConnecting(false);
    setConnectCode("");
  };

  const connectToDevice = (deviceId: string) => {
    const cobrowseUrl = `https://cobrowse.io/connect?filter_device_id=${deviceId}`;
    window.open(cobrowseUrl, "_blank", "width=1200,height=800");
  };

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Monitor className="w-7 h-7 text-mos-blue" />
            Remote Support
          </h1>
          <p className="text-gray-600">Connect to user screens for live support</p>
        </div>
        <button
          onClick={refreshDevices}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-mos-blue text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
        <h3 className="font-semibold text-gray-900 mb-4">Connect with Session Code</h3>
        <p className="text-sm text-gray-600 mb-4">
          Enter the 6-digit code the user shared with you to connect to their screen.
        </p>
        <div className="flex gap-3">
          <input
            type="text"
            value={connectCode}
            onChange={(e) => setConnectCode(e.target.value.toUpperCase())}
            placeholder="Enter 6-digit code"
            maxLength={6}
            className="flex-1 px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-mos-blue font-mono text-lg tracking-wider uppercase"
          />
          <button
            onClick={connectWithCode}
            disabled={connecting || connectCode.length < 6}
            className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play className="w-4 h-4" />
            Connect
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">Active Devices</h3>
          <span className="text-sm text-gray-500">
            {devices.filter(d => d.online).length} online
          </span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="w-6 h-6 text-gray-400 animate-spin" />
          </div>
        ) : devices.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <Monitor className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No active devices</p>
            <p className="text-sm mt-1">Devices will appear when users enable screen sharing</p>
          </div>
        ) : (
          <div className="space-y-3">
            {devices.map((device) => (
              <div
                key={device.id}
                className={`flex items-center justify-between p-4 rounded-lg border ${
                  device.online 
                    ? "border-green-200 bg-green-50" 
                    : "border-gray-200 bg-gray-50"
                }`}
              >
                <div className="flex items-center gap-4">
                  <div className={`w-3 h-3 rounded-full ${device.online ? "bg-green-500" : "bg-gray-300"}`} />
                  <div>
                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4 text-gray-400" />
                      <span className="font-medium text-gray-900">
                        {device.customData?.user_email || "Unknown User"}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 mt-1 text-sm text-gray-500">
                      {device.customData?.shop_id && (
                        <span className="flex items-center gap-1">
                          <Building2 className="w-3 h-3" />
                          Shop: {device.customData.shop_id}
                        </span>
                      )}
                      {device.customData?.ticket_id && device.customData.ticket_id !== "none" && (
                        <span className="flex items-center gap-1">
                          <Ticket className="w-3 h-3" />
                          Ticket: {device.customData.ticket_id.slice(0, 8)}...
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => connectToDevice(device.id)}
                  disabled={!device.online}
                  className="flex items-center gap-2 px-4 py-2 bg-mos-blue text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                >
                  <ExternalLink className="w-4 h-4" />
                  Connect
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-6">
        <h3 className="font-semibold text-blue-900 mb-2">How Remote Support Works</h3>
        <ol className="text-sm text-blue-800 space-y-2 list-decimal list-inside">
          <li>User clicks "Share My Screen" on their support ticket page</li>
          <li>They receive a 6-digit session code</li>
          <li>User shares the code with you (via chat, email, or phone)</li>
          <li>Enter the code above to connect and view/control their screen</li>
        </ol>
      </div>
    </div>
  );
}
