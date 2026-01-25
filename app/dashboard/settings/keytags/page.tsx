"use client";

import { useState, useEffect, useCallback } from "react";
import { Tag, Loader2 } from "lucide-react";
import { KeytagDesigner } from "@/components/keytag-designer";
import { DesignerLayout, DEFAULT_LAYOUT, SAMPLE_DATA, DYMO_30252 } from "@/lib/keytag-designer-types";
import CopyFromLocationDropdown from "@/components/ui/CopyFromLocationDropdown";

interface KeytagConfig {
  enabled: boolean;
  designerLayout?: DesignerLayout;
  fontStyles?: Record<string, unknown>;
  colors?: {
    text: string;
    background: string;
  };
  defaultSize: string;
}

export default function KeytagSettingsPage() {
  const [layout, setLayout] = useState<DesignerLayout | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadSettings() {
      try {
        const res = await fetch("/api/keytag/settings");
        if (res.ok) {
          const data = await res.json();
          if (data.config?.designerLayout) {
            setLayout(data.config.designerLayout);
          } else if (data.config?.colors) {
            const migratedLayout = {
              ...DEFAULT_LAYOUT,
              textColor: data.config.colors.text || DEFAULT_LAYOUT.textColor,
              backgroundColor: data.config.colors.background || DEFAULT_LAYOUT.backgroundColor,
            };
            setLayout(migratedLayout);
          } else {
            setLayout(DEFAULT_LAYOUT);
          }
        } else {
          setLayout(DEFAULT_LAYOUT);
        }
      } catch (err) {
        console.error("Failed to load keytag settings:", err);
        setError("Failed to load settings");
        setLayout(DEFAULT_LAYOUT);
      } finally {
        setLoading(false);
      }
    }
    loadSettings();
  }, []);

  const handleSave = useCallback(async (newLayout: DesignerLayout) => {
    setError(null);
    try {
      const config: KeytagConfig = {
        enabled: true,
        designerLayout: newLayout,
        colors: {
          text: newLayout.textColor,
          background: newLayout.backgroundColor,
        },
        defaultSize: "dymo30252",
      };
      
      const res = await fetch("/api/keytag/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });

      if (!res.ok) {
        throw new Error("Failed to save settings");
      }
    } catch (err) {
      setError("Failed to save settings");
      console.error(err);
      throw err;
    }
  }, []);

  const handleDownload = useCallback(async (currentLayout: DesignerLayout) => {
    try {
      const res = await fetch("/api/keytag/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...SAMPLE_DATA,
          designerLayout: currentLayout,
        }),
      });

      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "keytag-sample.png";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error("Failed to download:", err);
    }
  }, []);

  if (loading || !layout) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  const handleCopyComplete = useCallback(() => {
    window.location.reload();
  }, []);

  return (
    <div className="h-[calc(100vh-120px)] flex flex-col">
      <div className="flex items-center justify-between p-4 border-b bg-white">
        <div className="flex items-center gap-3">
          <Tag className="w-6 h-6 text-blue-600" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">Keytag Designer</h1>
            <p className="text-sm text-gray-500">Design your keytag layout with drag and drop</p>
          </div>
        </div>
        <CopyFromLocationDropdown 
          settingType="keytags" 
          onCopyComplete={handleCopyComplete}
        />
      </div>

      {error && (
        <div className="mx-4 mt-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        <KeytagDesigner
          initialLayout={layout}
          onSave={handleSave}
          onDownload={handleDownload}
        />
      </div>
    </div>
  );
}
