import { requirePlatformAdmin } from "@/lib/auth";
import { logAdminAction } from "@/lib/audit-log";
import { sendOpsAlert } from "@/lib/alerts/notify";
import {
  activateProtractorOperatorStop,
  clearProtractorOperatorStop,
  getProtractorOperatorStop,
  startProtractorTimedTrial,
} from "@/lib/data/repositories/api-usage";

export const deps = {
  requirePlatformAdmin,
  activateProtractorOperatorStop,
  clearProtractorOperatorStop,
  getProtractorOperatorStop,
  startProtractorTimedTrial,
  logAdminAction,
  sendOpsAlert,
};