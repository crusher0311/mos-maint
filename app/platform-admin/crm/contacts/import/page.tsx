"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { ArrowLeft, Upload, FileSpreadsheet, CheckCircle, AlertCircle, X } from "lucide-react";

const CONTACT_FIELDS = [
  { key: "firstName", label: "First Name", required: true },
  { key: "lastName", label: "Last Name", required: true },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "mobile", label: "Mobile" },
  { key: "title", label: "Title" },
  { key: "department", label: "Department" },
  { key: "address", label: "Address" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "Zip" },
];

export default function ImportContactsPage() {
  const [step, setStep] = useState<"upload" | "mapping" | "preview" | "result">("upload");
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; errors: { row: number; error: string }[]; total: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const parseCSV = (text: string): { headers: string[]; rows: Record<string, string>[] } => {
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) return { headers: [], rows: [] };
    const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
    const rows = lines.slice(1).map(line => {
      const values = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = values[i] || ""; });
      return row;
    });
    return { headers, rows };
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      const { headers, rows } = parseCSV(text);
      if (headers.length === 0) {
        alert("Could not parse CSV file. Ensure it has headers and data rows.");
        return;
      }
      setCsvHeaders(headers);
      setCsvRows(rows);

      const autoMapping: Record<string, string> = {};
      CONTACT_FIELDS.forEach(field => {
        const match = headers.find(h =>
          h.toLowerCase().replace(/[_\s-]/g, "") === field.key.toLowerCase() ||
          h.toLowerCase().replace(/[_\s-]/g, "") === field.label.toLowerCase().replace(/\s/g, "")
        );
        if (match) autoMapping[field.key] = match;
      });
      setColumnMapping(autoMapping);
      setStep("mapping");
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!columnMapping.firstName || !columnMapping.lastName) {
      alert("First Name and Last Name mappings are required.");
      return;
    }
    setImporting(true);
    try {
      const res = await fetch("/api/platform-admin/crm/contacts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contacts: csvRows, columnMapping }),
      });
      const data = await res.json();
      if (data.ok) {
        setResult(data);
        setStep("result");
      } else {
        alert(data.error || "Import failed");
      }
    } catch (e) { console.error(e); alert("Import failed"); }
    setImporting(false);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link href="/platform-admin/crm/contacts" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to Contacts
      </Link>
      <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2 mb-6">
        <Upload className="w-7 h-7 text-blue-600" /> Import Contacts from CSV
      </h1>

      <div className="flex items-center gap-4 mb-8">
        {["upload", "mapping", "preview", "result"].map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
              step === s ? "bg-blue-600 text-white" : i < ["upload", "mapping", "preview", "result"].indexOf(step) ? "bg-green-500 text-white" : "bg-gray-200 text-gray-500"
            }`}>{i + 1}</div>
            <span className="text-sm text-gray-600 capitalize">{s}</span>
            {i < 3 && <div className="w-8 h-px bg-gray-300" />}
          </div>
        ))}
      </div>

      {step === "upload" && (
        <div className="bg-white rounded-lg border p-8 text-center">
          <FileSpreadsheet className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Upload CSV File</h2>
          <p className="text-sm text-gray-500 mb-6">Upload a CSV file with contact data. The first row should contain column headers.</p>
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileUpload} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium">
            Select CSV File
          </button>
          <p className="text-xs text-gray-400 mt-4">Expected columns: First Name, Last Name, Email, Phone, Title, Department, etc.</p>
        </div>
      )}

      {step === "mapping" && (
        <div className="bg-white rounded-lg border p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Map Columns</h2>
          <p className="text-sm text-gray-500 mb-4">Match your CSV columns to contact fields. Fields marked with * are required.</p>
          <div className="space-y-3">
            {CONTACT_FIELDS.map(field => (
              <div key={field.key} className="flex items-center gap-4">
                <label className="w-40 text-sm font-medium text-gray-700">
                  {field.label} {field.required && <span className="text-red-500">*</span>}
                </label>
                <select value={columnMapping[field.key] || ""} onChange={(e) => setColumnMapping({ ...columnMapping, [field.key]: e.target.value })}
                  className={`flex-1 px-3 py-2 border rounded-lg text-sm ${field.required && !columnMapping[field.key] ? "border-red-300" : ""}`}>
                  <option value="">— Skip —</option>
                  {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-6 pt-4 border-t">
            <button onClick={() => { setStep("upload"); setCsvHeaders([]); setCsvRows([]); }}
              className="px-4 py-2 text-gray-700 border rounded-lg hover:bg-gray-50 text-sm">Back</button>
            <button onClick={() => setStep("preview")} disabled={!columnMapping.firstName || !columnMapping.lastName}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm disabled:opacity-50">Preview</button>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="bg-white rounded-lg border p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Preview Import</h2>
          <p className="text-sm text-gray-500 mb-4">{csvRows.length} contacts will be imported. Showing first 10 rows.</p>
          <div className="overflow-x-auto border rounded-lg mb-4">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  {CONTACT_FIELDS.filter(f => columnMapping[f.key]).map(f => (
                    <th key={f.key} className="text-left px-3 py-2 text-xs font-medium text-gray-500 uppercase">{f.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {csvRows.slice(0, 10).map((row, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    {CONTACT_FIELDS.filter(f => columnMapping[f.key]).map(f => (
                      <td key={f.key} className="px-3 py-2 text-gray-700">{row[columnMapping[f.key]] || ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep("mapping")} className="px-4 py-2 text-gray-700 border rounded-lg hover:bg-gray-50 text-sm">Back</button>
            <button onClick={handleImport} disabled={importing}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm disabled:opacity-50">
              {importing ? "Importing..." : `Import ${csvRows.length} Contacts`}
            </button>
          </div>
        </div>
      )}

      {step === "result" && result && (
        <div className="bg-white rounded-lg border p-6">
          <div className="text-center mb-6">
            <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-3" />
            <h2 className="text-lg font-semibold text-gray-900">Import Complete</h2>
          </div>
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <p className="text-2xl font-bold text-gray-900">{result.total}</p>
              <p className="text-sm text-gray-500">Total Rows</p>
            </div>
            <div className="bg-green-50 rounded-lg p-4 text-center">
              <p className="text-2xl font-bold text-green-600">{result.imported}</p>
              <p className="text-sm text-gray-500">Imported</p>
            </div>
            <div className="bg-red-50 rounded-lg p-4 text-center">
              <p className="text-2xl font-bold text-red-600">{result.errors.length}</p>
              <p className="text-sm text-gray-500">Errors</p>
            </div>
          </div>
          {result.errors.length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-medium text-gray-700 mb-2">Errors</h3>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {result.errors.map((err, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-red-600">
                    <AlertCircle className="w-4 h-4" /> Row {err.row}: {err.error}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="flex justify-center">
            <Link href="/platform-admin/crm/contacts" className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
              View Contacts
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
