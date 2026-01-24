"use client";

import { useState } from "react";
import { X, Car, Loader2, Search } from "lucide-react";

interface AddVehicleModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

export default function AddVehicleModal({ onClose, onSuccess }: AddVehicleModalProps) {
  const [vin, setVin] = useState("");
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [mileage, setMileage] = useState("");
  const [roNumber, setRoNumber] = useState("");
  const [customerFirstName, setCustomerFirstName] = useState("");
  const [customerLastName, setCustomerLastName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decodeVin = async () => {
    if (vin.length < 11) {
      setError("VIN must be at least 11 characters");
      return;
    }
    
    setDecoding(true);
    setError(null);
    
    try {
      const res = await fetch(`/api/vin/decode?vin=${encodeURIComponent(vin.toUpperCase())}`);
      const data = await res.json();
      
      if (data.error && !data.year) {
        setError("Could not decode VIN - please enter vehicle details manually");
      } else {
        if (data.year) setYear(String(data.year));
        if (data.make) setMake(data.make);
        if (data.model) setModel(data.model);
      }
    } catch {
      setError("VIN decode service unavailable - please enter vehicle details manually");
    } finally {
      setDecoding(false);
    }
  };
  
  const handleYearChange = (value: string) => {
    const cleaned = value.replace(/\D/g, "").slice(0, 4);
    setYear(cleaned);
  };
  
  const handleMileageChange = (value: string) => {
    const cleaned = value.replace(/\D/g, "");
    setMileage(cleaned);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/vehicles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vin,
          year: year || null,
          make: make || null,
          model: model || null,
          mileage: mileage || null,
          roNumber: roNumber || null,
          customerFirstName: customerFirstName || null,
          customerLastName: customerLastName || null,
          customerEmail: customerEmail || null,
          customerPhone: customerPhone || null,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to add vehicle");
      }

      onSuccess();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2">
            <Car className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold">Add Vehicle</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              VIN <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={vin}
                onChange={(e) => setVin(e.target.value.toUpperCase())}
                placeholder="Enter VIN (11-17 characters)"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
                maxLength={17}
                required
              />
              <button
                type="button"
                onClick={decodeVin}
                disabled={vin.length < 11 || decoding}
                className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-1"
              >
                {decoding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                Decode
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">Click Decode to auto-fill year/make/model</p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Year</label>
              <input
                type="text"
                inputMode="numeric"
                value={year}
                onChange={(e) => handleYearChange(e.target.value)}
                placeholder="2024"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                maxLength={4}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Make</label>
              <input
                type="text"
                value={make}
                onChange={(e) => setMake(e.target.value)}
                placeholder="Toyota"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Camry"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Mileage</label>
              <input
                type="text"
                inputMode="numeric"
                value={mileage}
                onChange={(e) => handleMileageChange(e.target.value)}
                placeholder="Current mileage"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">RO #</label>
              <input
                type="text"
                value={roNumber}
                onChange={(e) => setRoNumber(e.target.value)}
                placeholder="Optional"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>

          <div className="border-t pt-4">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Customer Information (Optional)</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">First Name</label>
                <input
                  type="text"
                  value={customerFirstName}
                  onChange={(e) => setCustomerFirstName(e.target.value)}
                  placeholder="John"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Last Name</label>
                <input
                  type="text"
                  value={customerLastName}
                  onChange={(e) => setCustomerLastName(e.target.value)}
                  placeholder="Doe"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Email</label>
                <input
                  type="email"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  placeholder="john@example.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Phone</label>
                <input
                  type="tel"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="(555) 123-4567"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || vin.length < 11}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              Add Vehicle
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
