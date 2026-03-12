// app/dashboard/vehicles/[vin]/plan/PlanUI.tsx
"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";

interface TriagedItem {
  key: string;
  title: string;
  category?: string;
  bump?: string;
}

interface ServiceCardProps {
  t: TriagedItem;
  severity: "overdue" | "soon" | "upcoming";
}

function ServiceCard({ t, severity }: ServiceCardProps) {
  const [open, setOpen] = useState(false);
  
  const badgeColor = useMemo(() => {
    switch (severity) {
      case "overdue": return "bg-red-600";
      case "soon": return "bg-amber-600";
      case "upcoming": return "bg-emerald-600";
      default: return "bg-gray-600";
    }
  }, [severity]);

  return (
    <Card className="rounded-xl border">
      <CardHeader className="py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <CardTitle className="text-sm">{t.title}</CardTitle>
            <div className="flex gap-1">
              {t.category && <Badge variant="info">{t.category}</Badge>}
              <Badge className={`${badgeColor} text-white`}>{severity.toUpperCase()}</Badge>
              {t.bump === "red" && <Badge className="bg-red-600 text-white">DVI 🔴</Badge>}
              {t.bump === "yellow" && <Badge className="bg-amber-600 text-white">DVI 🟡</Badge>}
              {t.category === "Added by Shop" && (
                <Badge variant="info">
                  Added by Shop
                </Badge>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(!open)}
            className="p-1 h-6 w-6"
          >
            {open ? "↑" : "↓"}
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="pt-0 text-sm">
          <p className="text-gray-600">Service details would appear here.</p>
        </CardContent>
      )}
    </Card>
  );
}

interface PlanUIProps {
  plan: {
    triaged: TriagedItem[];
  };
}

export default function PlanUI({ plan }: PlanUIProps) {
  const [mode, setMode] = useState("advisor");

  const buckets = useMemo(() => {
    const overdue: TriagedItem[] = [];
    const dueSoon: TriagedItem[] = [];
    const upcoming: TriagedItem[] = [];

    // For now, just split items evenly for demo
    plan.triaged.forEach((item, index) => {
      if (index % 3 === 0) overdue.push(item);
      else if (index % 3 === 1) dueSoon.push(item);
      else upcoming.push(item);
    });

    return { overdue, dueSoon, upcoming };
  }, [plan.triaged]);

  const counts = useMemo(() => ({
    o: buckets.overdue.length,
    s: buckets.dueSoon.length,
    u: buckets.upcoming.length
  }), [buckets]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Vehicle Health Indicator</h2>
          <div className="flex gap-2 mt-2">
            <Badge className="bg-red-600 text-white">Overdue {counts.o}</Badge>
            <Badge className="bg-amber-600 text-white">Due Soon {counts.s}</Badge>
            <Badge className="bg-emerald-600 text-white">Upcoming {counts.u}</Badge>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm">
            🖨️ Print
          </Button>
          <Button variant="outline" size="sm">
            📤 Share
          </Button>
          <div className="flex border rounded-md">
            <Button
              variant={mode === "advisor" ? "primary" : "ghost"}
              size="sm"
              onClick={() => setMode("advisor")}
              className="rounded-r-none"
            >
              Advisor
            </Button>
            <Button
              variant={mode === "client" ? "primary" : "ghost"}
              size="sm"
              onClick={() => setMode("client")}
              className="rounded-l-none"
            >
              Client
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="space-y-6">
        {/* Overdue Section */}
        <div>
          <h3 className="text-lg font-medium mb-3 text-red-700">Overdue ({counts.o})</h3>
          <div className="space-y-2">
            {buckets.overdue.map((t) => (
              <ServiceCard key={t.key} t={t} severity="overdue" />
            ))}
          </div>
        </div>

        {/* Due Soon Section */}
        <div>
          <h3 className="text-lg font-medium mb-3 text-amber-700">Due Soon ({counts.s})</h3>
          <div className="space-y-2">
            {buckets.dueSoon.map((t) => (
              <ServiceCard key={t.key} t={t} severity="soon" />
            ))}
          </div>
        </div>

        {/* Upcoming Section */}
        <div>
          <h3 className="text-lg font-medium mb-3 text-emerald-700">Upcoming ({counts.u})</h3>
          <div className="space-y-2">
            {buckets.upcoming.map((t) => (
              <ServiceCard key={t.key} t={t} severity="upcoming" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}