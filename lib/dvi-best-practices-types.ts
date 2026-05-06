// Pure types/constants for shop DVI best-practice blurbs. Kept in a
// dedicated file so the repository (lib/data/repositories/shop-dvi-best-practices.ts)
// can import them without creating a circular dependency back through
// lib/dvi-best-practices.ts (which itself re-exports from the repo).

export const SHOP_DVI_BEST_PRACTICES_COLLECTION = "shop_dvi_best_practices";
export const DVI_BEST_PRACTICE_MAX_CHARS = 140;

export interface ShopDviBestPractice {
  shopId: number;
  serviceKey: string;
  serviceName: string;
  blurb: string;
  updatedAt: Date;
  updatedBy?: string | null;
  createdAt?: Date;
}
