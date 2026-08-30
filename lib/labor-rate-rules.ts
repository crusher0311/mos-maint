export interface LaborRateCondition {
  type: string;
  field: string | null;
  label: string | null;
  values: unknown[];
}

export interface LaborRateRule {
  id: string;
  name: string;
  rate: number;
  priority: number;
  conditions: LaborRateCondition[];
  matchMode: "all" | "any";
  color?: string;
  applyToAllLabor?: boolean;
  overrideCategoryRates: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class LaborRateRuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaborRateRuleValidationError";
  }
}

export function canManageEnterpriseLaborRates(session: {
  role?: string | null;
  isPlatformAdmin?: boolean;
}): boolean {
  return (
    session.role === "owner" ||
    session.role === "admin" ||
    session.role === "platform_admin" ||
    session.isPlatformAdmin === true
  );
}

export function validateEnterpriseLaborRateScope(options: {
  currentShopId: unknown;
  enterpriseShopIds: unknown[];
  sourceShopId?: unknown;
  destinationShopIds?: unknown[];
}) {
  const currentShopId = Number(options.currentShopId);
  const enterpriseShopIds = [
    ...new Set(options.enterpriseShopIds.map(Number).filter(Number.isFinite)),
  ];
  if (!Number.isFinite(currentShopId) || !enterpriseShopIds.includes(currentShopId)) {
    throw new LaborRateRuleValidationError("Current shop is not in the enterprise");
  }
  const sourceShopId =
    options.sourceShopId === undefined ? currentShopId : Number(options.sourceShopId);
  if (!Number.isFinite(sourceShopId) || !enterpriseShopIds.includes(sourceShopId)) {
    throw new LaborRateRuleValidationError("Source shop is not in the enterprise");
  }
  const destinationShopIds = (options.destinationShopIds || []).map(Number);
  if (
    destinationShopIds.some(
      (shopId) => !Number.isFinite(shopId) || !enterpriseShopIds.includes(shopId),
    )
  ) {
    throw new LaborRateRuleValidationError("Destination shop is not in the enterprise");
  }
  return { currentShopId, enterpriseShopIds, sourceShopId, destinationShopIds };
}

export interface LaborRateRuleCollection {
  findOne(query: unknown, options?: unknown): Promise<any>;
  find(query: unknown, options?: unknown): { toArray(): Promise<any[]> };
  updateOne(query: unknown, update: unknown): Promise<any>;
  updateMany(query: unknown, update: unknown): Promise<any>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LaborRateRuleValidationError(`${field} is required`);
  }
  return value.trim();
}

function finiteNumber(value: unknown, field: string): number {
  if (value === "" || value === null || value === undefined) {
    throw new LaborRateRuleValidationError(`${field} must be a finite number`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new LaborRateRuleValidationError(`${field} must be a finite number`);
  }
  return number;
}

function dateValue(value: unknown, fallback: Date, field: string): Date {
  if (value === undefined || value === null) return fallback;
  const date = value instanceof Date ? new Date(value) : new Date(value as string);
  if (Number.isNaN(date.getTime())) {
    throw new LaborRateRuleValidationError(`${field} must be a valid date`);
  }
  return date;
}

export function normalizeLaborRateRule(
  value: unknown,
  options: { now?: Date; createId?: () => string } = {},
): LaborRateRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LaborRateRuleValidationError("Each labor-rate rule must be an object");
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.conditions)) {
    throw new LaborRateRuleValidationError("conditions must be an array");
  }

  const now = options.now ? new Date(options.now) : new Date();
  const id =
    typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : options.createId?.();
  if (!id) throw new LaborRateRuleValidationError("id is required");

  const rate = finiteNumber(input.rate, "rate");
  if (rate < 0) throw new LaborRateRuleValidationError("rate cannot be negative");

  return {
    id,
    name: requiredString(input.name, "name"),
    rate,
    priority:
      input.priority === undefined || input.priority === null || input.priority === ""
        ? 0
        : finiteNumber(input.priority, "priority"),
    conditions: input.conditions.map((condition, index) => {
      if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
        throw new LaborRateRuleValidationError(`conditions[${index}] must be an object`);
      }
      const item = condition as Record<string, unknown>;
      return {
        type: requiredString(item.type, `conditions[${index}].type`),
        field: typeof item.field === "string" && item.field ? item.field : null,
        label: typeof item.label === "string" && item.label ? item.label : null,
        values: Array.isArray(item.values) ? [...item.values] : [],
      };
    }),
    matchMode: input.matchMode === "any" ? "any" : "all",
    ...(typeof input.color === "string" ? { color: input.color } : {}),
    ...(input.applyToAllLabor !== undefined
      ? { applyToAllLabor: Boolean(input.applyToAllLabor) }
      : {}),
    overrideCategoryRates: Boolean(input.overrideCategoryRates),
    createdAt: dateValue(input.createdAt, now, "createdAt"),
    updatedAt: dateValue(input.updatedAt, now, "updatedAt"),
  };
}

/** Normalize a complete set. An empty array is valid and means "clear". */
export function normalizeLaborRateRuleSet(
  value: unknown,
  options: { now?: Date; createId?: () => string } = {},
): LaborRateRule[] {
  if (!Array.isArray(value)) {
    throw new LaborRateRuleValidationError("rules must be an array");
  }
  const rules = value.map((rule) => normalizeLaborRateRule(rule, options));
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) {
      throw new LaborRateRuleValidationError(`Duplicate rule id: ${rule.id}`);
    }
    ids.add(rule.id);
  }
  return rules;
}

export async function readLaborRateRuleSet(
  shops: LaborRateRuleCollection,
  shopId: number,
): Promise<LaborRateRule[]> {
  const shop = await shops.findOne(
    { $or: [{ shopId }, { shopId: String(shopId) }] },
    { projection: { laborRateRules: 1 } },
  );
  if (!shop) throw new Error(`Shop ${shopId} not found`);
  return normalizeLaborRateRuleSet(shop.laborRateRules ?? []);
}

/** Replaces (never merges) the complete rule set for one shop. */
export async function replaceLaborRateRuleSet(
  shops: LaborRateRuleCollection,
  shopId: number,
  rules: LaborRateRule[],
) {
  return shops.updateOne(
    { $or: [{ shopId }, { shopId: String(shopId) }] },
    { $set: { laborRateRules: rules, updatedAt: new Date() } },
  );
}

/** Replaces (never merges) the complete rule set for all supplied shops. */
export async function replaceLaborRateRuleSetForShops(
  shops: LaborRateRuleCollection,
  shopIds: number[],
  rules: LaborRateRule[],
) {
  if (shopIds.length === 0) return { matchedCount: 0, modifiedCount: 0 };
  return shops.updateMany(
    {
      $or: [
        { shopId: { $in: shopIds } },
        { shopId: { $in: shopIds.map(String) } },
      ],
    },
    { $set: { laborRateRules: rules, updatedAt: new Date() } },
  );
}

function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "createdAt" && key !== "updatedAt")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, comparable(child)]),
    );
  }
  return value;
}

export function laborRateRuleSetsEqual(a: LaborRateRule[], b: LaborRateRule[]): boolean {
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}