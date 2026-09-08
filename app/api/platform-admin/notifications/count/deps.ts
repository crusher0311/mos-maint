import { requirePlatformAdmin } from "@/lib/auth";
import { getAdminUnreadCount } from "@/lib/notifications";

// Keep test seams outside route.ts; Next's generated route types allow only
// HTTP handlers and route configuration exports.
export const __deps = { requirePlatformAdmin, getAdminUnreadCount };