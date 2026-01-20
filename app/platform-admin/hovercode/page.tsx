"use client";

import { useState, useEffect } from "react";
import { QrCode, Save, Loader2, Search, Check, X } from "lucide-react";

interface Shop {
  shopId: string | number;
  name: string;
  hovercodeQRId?: string;
}

export default function HovercodePage() {
  const [shops, setShops] = useState<Shop[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [savingShopId, setSavingShopId] = useState<string | number | null>(null);
  const [editingShopId, setEditingShopId] = useState<string | number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    loadShops();
  }, []);

  const loadShops = async () => {
    try {
      const res = await fetch("/api/platform-admin/shops");
      const data = await res.json();
      if (data.ok) {
        const shopsWithQR = data.shops.map((shop: any) => ({
          shopId: shop.shopId,
          name: shop.name || `Shop ${shop.shopId}`,
          hovercodeQRId: shop.stickerConfig?.hovercodeQRId || "",
        }));
        setShops(shopsWithQR);
      }
    } catch (err) {
      console.error("Error loading shops:", err);
    } finally {
      setLoading(false);
    }
  };

  const startEditing = (shop: Shop) => {
    setEditingShopId(shop.shopId);
    setEditValue(shop.hovercodeQRId || "");
  };

  const cancelEditing = () => {
    setEditingShopId(null);
    setEditValue("");
  };

  const saveHovercodeId = async (shopId: string | number) => {
    setSavingShopId(shopId);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/hovercode-qrs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mappings: [{ shopId: String(shopId), hovercodeId: editValue.trim() }],
          dryRun: false,
        }),
      });

      const data = await res.json();
      if (data.results?.[0]?.status === "updated") {
        setMessage({ type: "success", text: `Updated QR ID for shop ${shopId}` });
        setShops((prev) =>
          prev.map((s) =>
            s.shopId === shopId ? { ...s, hovercodeQRId: editValue.trim() } : s
          )
        );
        setEditingShopId(null);
        setEditValue("");
      } else {
        setMessage({ type: "error", text: data.results?.[0]?.status || "Failed to update" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save" });
    } finally {
      setSavingShopId(null);
    }
  };

  const filteredShops = shops.filter(
    (shop) =>
      String(shop.shopId).includes(searchTerm) ||
      shop.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (shop.hovercodeQRId && shop.hovercodeQRId.includes(searchTerm))
  );

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="h-64 bg-gray-200 rounded-lg"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <QrCode className="w-8 h-8 text-purple-600" />
          <h1 className="text-2xl font-bold text-gray-900">HoverCode QR Management</h1>
        </div>
        <p className="text-gray-600">
          Assign HoverCode QR IDs to shops for sticker generation and scan tracking.
        </p>
      </div>

      {message && (
        <div
          className={`mb-4 p-3 rounded-lg ${
            message.type === "success"
              ? "bg-green-50 text-green-700 border border-green-200"
              : "bg-red-50 text-red-700 border border-red-200"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="p-4 border-b border-gray-200">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="Search by shop name, ID, or QR ID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Shop ID
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  HoverCode QR ID
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filteredShops.map((shop) => (
                <tr key={shop.shopId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    {shop.shopId}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">{shop.name}</td>
                  <td className="px-4 py-3">
                    {editingShopId === shop.shopId ? (
                      <input
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        placeholder="Paste HoverCode QR ID..."
                        className="w-full px-3 py-1.5 text-sm border border-purple-300 rounded focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                        autoFocus
                      />
                    ) : (
                      <span
                        className={`text-sm ${
                          shop.hovercodeQRId ? "text-gray-700 font-mono" : "text-gray-400 italic"
                        }`}
                      >
                        {shop.hovercodeQRId || "Not set"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {editingShopId === shop.shopId ? (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => saveHovercodeId(shop.shopId)}
                          disabled={savingShopId === shop.shopId}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-white bg-purple-600 rounded hover:bg-purple-700 disabled:opacity-50"
                        >
                          {savingShopId === shop.shopId ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Check className="w-4 h-4" />
                          )}
                          Save
                        </button>
                        <button
                          onClick={cancelEditing}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startEditing(shop)}
                        className="text-sm text-purple-600 hover:text-purple-800 font-medium"
                      >
                        {shop.hovercodeQRId ? "Edit" : "Set QR ID"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {filteredShops.length === 0 && (
          <div className="p-8 text-center text-gray-500">No shops found matching your search.</div>
        )}
      </div>
    </div>
  );
}
