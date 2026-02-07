"use client";

import { useState } from "react";
import { X, Loader2, Plus, Car } from "lucide-react";

interface AddVehicleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onVehicleAdded: (row: any) => void;
}

export default function AddVehicleModal({ isOpen, onClose, onVehicleAdded }: AddVehicleModalProps) {
  const [customerName, setCustomerName] = useState("");
  const [roNumber, setRoNumber] = useState("");
  const [vin, setVin] = useState("");
  const [mileage, setMileage] = useState("");
  const [vehicleYear, setVehicleYear] = useState("");
  const [vehicleMake, setVehicleMake] = useState("");
  const [vehicleModel, setVehicleModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vinDecoding, setVinDecoding] = useState(false);

  function resetForm() {
    setCustomerName("");
    setRoNumber("");
    setVin("");
    setMileage("");
    setVehicleYear("");
    setVehicleMake("");
    setVehicleModel("");
    setError(null);
  }

  function formatMileageInput(value: string): string {
    const numericValue = value.replace(/[^\d]/g, "");
    if (!numericValue) return "";
    return parseInt(numericValue, 10).toLocaleString();
  }

  async function handleVinBlur() {
    const cleanVin = vin.toUpperCase().trim();
    if (cleanVin.length !== 17) return;
    
    setVinDecoding(true);
    try {
      const res = await fetch(`/api/vin/decode?vin=${encodeURIComponent(cleanVin)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.year && !vehicleYear) setVehicleYear(String(data.year));
        if (data.make && !vehicleMake) setVehicleMake(data.make);
        if (data.model && !vehicleModel) setVehicleModel(data.model);
      }
    } catch {
    } finally {
      setVinDecoding(false);
    }
  }

  async function handleSubmit() {
    const cleanVin = vin.toUpperCase().trim();
    const numericMileage = parseInt(mileage.replace(/,/g, ""), 10);

    if (!customerName.trim()) {
      setError("Customer name is required");
      return;
    }
    if (cleanVin.length !== 17) {
      setError("VIN must be exactly 17 characters");
      return;
    }
    if (!numericMileage || numericMileage <= 0) {
      setError("Please enter a valid mileage");
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch("/api/vehicles/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: customerName.trim(),
          roNumber: roNumber.trim() || null,
          vin: cleanVin,
          mileage: numericMileage,
          vehicleYear: vehicleYear ? parseInt(vehicleYear, 10) : null,
          vehicleMake: vehicleMake.trim() || null,
          vehicleModel: vehicleModel.trim() || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to add vehicle");
      }

      const data = await res.json();
      onVehicleAdded(data.row);
      resetForm();
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to add vehicle");
    } finally {
      setSubmitting(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
              <Car className="w-4 h-4 text-blue-600" />
            </div>
            <h2 className="text-lg font-semibold text-gray-900">Add Vehicle</h2>
          </div>
          <button
            onClick={() => { resetForm(); onClose(); }}
            className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Customer Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="e.g. John Smith"
                className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                autoFocus
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                RO #
              </label>
              <input
                type="text"
                value={roNumber}
                onChange={(e) => setRoNumber(e.target.value)}
                placeholder="e.g. 4271"
                className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Mileage <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={mileage}
                onChange={(e) => setMileage(formatMileageInput(e.target.value))}
                placeholder="e.g. 114,224"
                className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              VIN <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <input
                type="text"
                value={vin}
                onChange={(e) => setVin(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17))}
                onBlur={handleVinBlur}
                placeholder="17-character VIN"
                maxLength={17}
                className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono tracking-wider"
              />
              {vinDecoding && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                </div>
              )}
              <p className="mt-1 text-xs text-gray-400">{vin.length}/17 characters</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Year</label>
              <input
                type="text"
                value={vehicleYear}
                onChange={(e) => setVehicleYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="2024"
                maxLength={4}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Make</label>
              <input
                type="text"
                value={vehicleMake}
                onChange={(e) => setVehicleMake(e.target.value)}
                placeholder="Ford"
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
              <input
                type="text"
                value={vehicleModel}
                onChange={(e) => setVehicleModel(e.target.value)}
                placeholder="Fusion"
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
          </div>

          <p className="text-xs text-gray-400">
            Year, Make, and Model will auto-fill when you enter a valid VIN.
          </p>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t bg-gray-50 flex justify-end gap-3">
          <button
            onClick={() => { resetForm(); onClose(); }}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !customerName.trim() || vin.length !== 17 || !mileage}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Adding...
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" />
                Add Vehicle
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
