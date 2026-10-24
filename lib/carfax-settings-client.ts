export type CarfaxSettingsStatus = {
  configured: boolean;
  locationId?: string;
  maintenanceEnabled?: boolean;
  state: "loading" | "ready" | "denied" | "unavailable";
  error?: string;
};

export const MAINTENANCE_WARNING = "Maintenance features are not enabled for this shop. You can save a CARFAX Location ID, but maintenance features remain unavailable.";

const messages: Record<string, string> = {
  PASSWORD_CHANGE_REQUIRED: "Change your password before managing CARFAX settings.",
  SHOP_REQUIRED: "Select an authorized shop before managing CARFAX settings.",
  INVALID_LOCATION_ID: "Enter a CARFAX Location ID (up to 256 characters).",
};

export async function carfaxSettingsRequest(method = "GET", locationId?: string): Promise<any> {
  let response: Response;
  try {
    response = await fetch("/api/settings/carfax", {
      method, cache: "no-store",
      ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locationId }) } : {}),
    });
  } catch {
    throw { state: "unavailable", message: "Could not reach CARFAX settings. Check your connection and reload settings before trying again." };
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || response.redirected) {
    const message = response.status === 401 || response.redirected
      ? "Your session has expired. Sign in again to manage CARFAX settings."
      : messages[data?.code] || (data?.mustChangePassword
        ? messages.PASSWORD_CHANGE_REQUIRED
        : response.status === 403
          ? "You do not have permission to manage CARFAX settings for this shop."
          : "CARFAX settings could not be confirmed. Reload settings before trying again.");
    throw { state: response.status === 401 || response.status === 403 || response.redirected ? "denied" : "unavailable", message };
  }
  if (!data || (method === "GET" ? typeof data.locationId !== "string" || typeof data.maintenanceEnabled !== "boolean" : data.ok !== true)) {
    throw { state: "unavailable", message: "CARFAX settings returned an unexpected response. Reload settings before trying again." };
  }
  return data;
}

export async function loadCarfaxSettings(): Promise<CarfaxSettingsStatus> {
  try {
    const data = await carfaxSettingsRequest();
    return { state: "ready", configured: Boolean(data.locationId), locationId: data.locationId, maintenanceEnabled: data.maintenanceEnabled };
  } catch (error: any) {
    return { state: error.state || "unavailable", configured: false, error: error.message };
  }
}
