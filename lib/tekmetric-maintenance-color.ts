/** Only an explicit yellow opt-in changes the existing maintenance guidelines. */
export type TekmetricMaintenanceColor = "red" | "yellow";

/** Match the shop inspection-settings decision-maker roles. */
export function canManageTekmetricMaintenanceColor(role: unknown): boolean {
  return role === "owner" || role === "admin" || role === "manager";
}

export function isTekmetricMaintenanceColor(value: unknown): value is TekmetricMaintenanceColor {
  return value === "red" || value === "yellow";
}

export function resolveTekmetricMaintenanceColor(value: unknown): TekmetricMaintenanceColor {
  return value === "yellow" ? "yellow" : "red";
}
