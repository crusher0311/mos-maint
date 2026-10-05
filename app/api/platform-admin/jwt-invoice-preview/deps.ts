import { requirePlatformAdmin } from "@/lib/auth";
import { getEnterpriseByShopId } from "@/lib/enterprise";
import { readProtractorRelayConfig } from "@/lib/integrations/protractor/relay-config";
import { runWithProtractorInteractiveTransport } from "@/lib/integrations/protractor/interactive-context";
import { getEffectiveProtractorOutboundPolicy, resolveProtractorConfig, protractorFetch } from "@/lib/integrations/protractor/client";
import type { InvoicePreviewDeps } from "@/lib/jwt-invoice-preview";

export const deps: InvoicePreviewDeps & { requirePlatformAdmin: typeof requirePlatformAdmin } = {
  requirePlatformAdmin,
  authorize: requirePlatformAdmin,
  enterprise: () => getEnterpriseByShopId(227),
  relayMode: () => readProtractorRelayConfig().mode,
  interactive: work => runWithProtractorInteractiveTransport(227, work),
  policy: getEffectiveProtractorOutboundPolicy,
  read: async () => {
    const config = await resolveProtractorConfig(227);
    if (!config.configured || config.shopId !== 227) return { ok: false };
    return protractorFetch<{ ItemCollection?: unknown }>(
      "/Invoice/?startDate=2026-09-01&endDate=2026-09-02&take=25&skip=0",
      config, { method: "GET" }, 0, 227,
      { priority: true, maxRetries: 0, timeoutMs: 20000 },
    );
  },
};
