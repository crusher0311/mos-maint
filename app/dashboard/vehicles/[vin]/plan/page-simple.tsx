// app/dashboard/vehicles/[vin]/plan/page-simple.tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";

export default function PlanPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Vehicle Health Indicator</h1>
        <p className="text-gray-600">Vehicle maintenance schedule and recommendations</p>
      </div>
      
      <Card>
        <CardHeader>
          <CardTitle>VHI Coming Soon</CardTitle>
        </CardHeader>
        <CardContent>
          <p>The Vehicle Health Indicator feature is being updated and will be available shortly.</p>
        </CardContent>
      </Card>
    </div>
  );
}