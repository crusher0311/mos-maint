import { staffDependencies } from "../staff/runtime";
import { staffAccess } from "../staff/access";
import { StaffMediaStorage } from "../../data/repositories/workflow-inspections";
import { MongoReleaseStorage } from "./store";
import type { ReleaseDependencies } from "./service";
import { readShopBranding } from "../../data/repositories/shops";
import { readDispatchEnterpriseBrand } from "../../data/repositories/shop-dispatch";
import { getEnterpriseByShopId } from "../../enterprise";
import { getFeatureEntitlements } from "../../featureResolver";
import { readLogoPalette } from "../../shop-dispatch/logo-palette";
import { resolveWorkflowBranding } from "../../shop-dispatch/branding";
import { brandingSchema } from "./model";
import { requireThat } from "../../shop-dispatch/model";

export const releaseDependencies: ReleaseDependencies = {
  staff: staffDependencies, store: new MongoReleaseStorage(), media: new StaffMediaStorage(),
  secret: () => process.env.WORKFLOW_REPORT_LINK_SECRET ?? "",
  publicEntitled: async shopId => {
    const entitlements = await getFeatureEntitlements(shopId);
    return entitlements.isFeatureEnabled("shop_workflow") && entitlements.isFeatureEnabled("auto_dvi");
  },
  branding: async shopId => {
    const access = await staffAccess();
    requireThat(access.shopId === shopId, "Current shop changed", 403);
    const [board, saved, enterprise] = await Promise.all([
      staffDependencies.board.read(shopId), readShopBranding(shopId), getEnterpriseByShopId(shopId),
    ]);
    const inherited = enterprise?._id ? await readDispatchEnterpriseBrand(String(enterprise._id)) : null;
    const logo = await readLogoPalette(saved.logo);
    const brand = resolveWorkflowBranding(board.locationBrand, {name: saved.displayName, ...logo}, inherited?.brand ?? null).brand;
    return brandingSchema.parse({name: brand.name, primary: brand.primary, logo: brand.logo,
      phone: access.config?.release?.publicPhone ?? ""});
  },
};
