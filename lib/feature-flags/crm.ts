/**
 * CRM Subsystem Feature Flag
 *
 * Soft-hides the CRM, Onboarding, Sales Pipeline, Marketing, and Pricing
 * platform-admin surfaces (UI + API) without deleting any code or data.
 *
 * Default: DISABLED. Set environment variable CRM_ENABLED=true to re-enable.
 *
 * When disabled:
 *   - All gated UI routes return 404 (Next.js notFound).
 *   - All gated API routes return 404 JSON.
 *   - Sidebar nav entries for the gated sections are hidden.
 *
 * No tables are dropped and no code is removed; flipping the env var back to
 * "true" fully restores the subsystem.
 */
export function isCrmEnabled(): boolean {
  return process.env.CRM_ENABLED === "true";
}
