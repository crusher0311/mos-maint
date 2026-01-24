// lib/sms-adapters/autoflow-adapter.ts
// AutoFlow SMS Adapter implementation

import {
  ISMSAdapter,
  SMSProvider,
  SMSWorkOrder,
  SMSServicePackage,
  SMSCannedJob,
  SMSAdapterRegistry,
  SMSAppointment,
  SMSVehicle,
  CreateAppointmentRequest,
} from "@/lib/sms-adapter";
import { resolveAutoflowConfig } from "@/lib/integrations/autoflow";
import { getDb } from "@/lib/mongo";

function basicAuthHeader(key: string, pwd: string) {
  const token = Buffer.from(`${key}:${pwd}`).toString("base64");
  return `Basic ${token}`;
}

async function autoflowFetch<T>(
  path: string,
  config: { base: string; apiKey: string | null; apiPassword: string | null },
  options: RequestInit = {}
): Promise<{ ok: boolean; data?: T; error?: string }> {
  if (!config.base || !config.apiKey || !config.apiPassword) {
    return { ok: false, error: "AutoFlow not configured" };
  }

  const url = `${config.base}${path}`;
  
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "Authorization": basicAuthHeader(config.apiKey, config.apiPassword),
        "Content-Type": "application/json",
        "accept": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[AutoFlow] API error ${res.status}: ${text}`);
      return { ok: false, error: `HTTP ${res.status}: ${text || res.statusText}` };
    }

    const data = await res.json();
    return { ok: true, data };
  } catch (error) {
    console.error("[AutoFlow] Fetch error:", error);
    return { ok: false, error: error instanceof Error ? error.message : "Network error" };
  }
}

class AutoflowAdapter implements ISMSAdapter {
  provider: SMSProvider = "autoflow";

  async isConfigured(shopId: number): Promise<boolean> {
    const config = await resolveAutoflowConfig(shopId);
    return config.configured;
  }

  async getWorkOrders(
    shopId: number,
    options?: { status?: string[]; stages?: string[]; fromDate?: Date; toDate?: Date; limit?: number }
  ): Promise<{ ok: boolean; workOrders?: SMSWorkOrder[]; error?: string }> {
    return { ok: false, error: "AutoFlow work order listing not implemented" };
  }

  async getWorkOrderById(
    shopId: number,
    workOrderId: string
  ): Promise<{ ok: boolean; workOrder?: SMSWorkOrder; error?: string }> {
    return { ok: false, error: "AutoFlow work order fetch not implemented" };
  }

  async addServicePackageToWorkOrder(
    shopId: number,
    workOrderId: string,
    servicePackage: SMSServicePackage
  ): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "AutoFlow service package addition not implemented" };
  }

  async getCannedJobs(shopId: number): Promise<{ ok: boolean; jobs?: SMSCannedJob[]; error?: string }> {
    return { ok: false, error: "AutoFlow canned jobs not implemented" };
  }

  async getVehicle(
    shopId: number,
    vehicleId: string
  ): Promise<{ ok: boolean; vehicle?: SMSVehicle; error?: string }> {
    return { ok: false, error: "AutoFlow vehicle fetch not implemented" };
  }

  async getVehicleByVin(
    shopId: number,
    vin: string
  ): Promise<{ ok: boolean; vehicle?: SMSVehicle; error?: string }> {
    return { ok: false, error: "AutoFlow vehicle lookup by VIN not implemented" };
  }

  async createAppointment(
    shopId: number,
    request: CreateAppointmentRequest
  ): Promise<{ ok: boolean; appointment?: SMSAppointment; error?: string }> {
    const config = await resolveAutoflowConfig(shopId);
    if (!config.configured) {
      return { ok: false, error: "AutoFlow not configured" };
    }

    try {
      const db = await getDb();
      
      const vehicle = await db.collection("normalized_vehicles").findOne({
        shopId,
        $or: [
          { "smsIds.autoflow": request.vehicleId },
          { "provenance.sourceId": request.vehicleId, "provenance.source": "autoflow" },
        ],
      });

      const customer = await db.collection("normalized_customers").findOne({
        shopId,
        $or: [
          { "smsIds.autoflow": request.customerId },
          { "provenance.sourceId": request.customerId, "provenance.source": "autoflow" },
        ],
      });

      const autoflowVehicleId = vehicle?.smsIds?.autoflow || vehicle?.provenance?.sourceId || request.vehicleId;
      const autoflowCustomerId = customer?.smsIds?.autoflow || customer?.provenance?.sourceId || request.customerId;

      const scheduledDateTime = `${request.scheduledDate}T${request.scheduledTime}:00`;

      const appointmentPayload = {
        customer_id: autoflowCustomerId,
        firstname: customer?.firstName || "",
        lastname: customer?.lastName || customer?.name || "Customer",
        phonenumber: customer?.phone || customer?.phoneNumber || "",
        email: customer?.email || "",
        vehicle_id: autoflowVehicleId,
        vehicle_year: String(vehicle?.year || ""),
        vehicle_make: vehicle?.make || "",
        vehicle_model: vehicle?.model || "",
        vin: vehicle?.vin || "",
        mileage: vehicle?.mileage ? String(vehicle.mileage) : "",
        status: "",
        appointment: scheduledDateTime,
        invoice: "",
        reason: request.serviceDescription || "Oil Change Service",
      };

      console.log(`[AutoFlow] Creating appointment for customer ${autoflowCustomerId} on ${request.scheduledDate} at ${request.scheduledTime}`);

      const result = await autoflowFetch<any>(
        "/api/v1/customers",
        config,
        {
          method: "POST",
          body: JSON.stringify(appointmentPayload),
        }
      );

      if (!result.ok) {
        return { ok: false, error: result.error || "Failed to create appointment" };
      }

      const responseCode = result.data?.response_code;
      if (responseCode !== 200) {
        return { ok: false, error: result.data?.message || `AutoFlow returned code ${responseCode}` };
      }

      const appointmentId = result.data?.message?.status_id || 
                            result.data?.message?.customer_id || 
                            `autoflow-${Date.now()}`;

      console.log(`[AutoFlow] Successfully created appointment, ID: ${appointmentId}`);

      return {
        ok: true,
        appointment: {
          id: String(appointmentId),
          scheduledDate: request.scheduledDate,
          scheduledTime: request.scheduledTime,
          vehicleId: request.vehicleId,
          customerId: request.customerId,
          serviceDescription: request.serviceDescription,
          notes: request.notes,
          status: "scheduled",
        },
      };
    } catch (error) {
      console.error("[AutoFlow] Error creating appointment:", error);
      return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }
}

SMSAdapterRegistry.register(new AutoflowAdapter());
