// Mutable test seam kept outside route.ts because Next.js route modules may
// only export HTTP handlers and supported route configuration fields.
export const historyDeps: {
  getSession: () => Promise<any>;
  getDb: () => Promise<any>;
} = {
  getSession: async () => {
    throw new Error("Estimate audit history dependencies are not configured");
  },
  getDb: async () => {
    throw new Error("Estimate audit history dependencies are not configured");
  },
};

export function configureHistoryDeps(deps: Partial<typeof historyDeps>) {
  Object.assign(historyDeps, deps);
}