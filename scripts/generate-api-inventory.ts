import fs from "fs";
import path from "path";

interface ApiRoute {
  path: string;
  methods: string[];
  category: string;
  isExternal: boolean;
  description: string;
}

const CATEGORY_MAPPINGS: Record<string, { category: string; description: string }> = {
  "external/appointments": { category: "External API", description: "Create and manage appointments" },
  "external/vehicles": { category: "External API", description: "Vehicle information and maintenance schedules" },
  "external/recommendations": { category: "External API", description: "AI-powered maintenance recommendations" },
  "external/stickers": { category: "External API", description: "Generate oil change stickers" },
  "external/keytags": { category: "External API", description: "Generate keytags" },
  "customers": { category: "Customers", description: "Customer management" },
  "vehicles": { category: "Vehicles", description: "Vehicle data and operations" },
  "vehicle": { category: "Vehicles", description: "Vehicle operations" },
  "jobs": { category: "Jobs & History", description: "Job search and history" },
  "parts": { category: "Parts", description: "Parts cross-reference" },
  "shop": { category: "Shop", description: "Shop analytics and features" },
  "sticker": { category: "Stickers", description: "Sticker generation and settings" },
  "keytag": { category: "Keytags", description: "Keytag generation and settings" },
  "settings": { category: "Settings", description: "Shop settings and configuration" },
  "auth": { category: "Authentication", description: "Authentication and sessions" },
  "admin": { category: "Admin (Internal)", description: "Admin operations" },
  "platform-admin": { category: "Platform Admin (Internal)", description: "Platform admin operations" },
  "enterprise": { category: "Enterprise", description: "Enterprise management" },
  "stripe": { category: "Billing (Internal)", description: "Stripe payment processing" },
  "billing": { category: "Billing (Internal)", description: "Billing operations" },
  "tekmetric": { category: "Integrations (Internal)", description: "Tekmetric sync" },
  "protractor": { category: "Integrations (Internal)", description: "Protractor sync" },
  "autovitals": { category: "Integrations (Internal)", description: "AutoVitals DVI" },
  "webhooks": { category: "Webhooks (Internal)", description: "Incoming webhooks" },
  "cron": { category: "Cron (Internal)", description: "Scheduled tasks" },
  "dev": { category: "Development (Internal)", description: "Development utilities" },
  "debug": { category: "Development (Internal)", description: "Debugging endpoints" },
  "notifications": { category: "Notifications", description: "User notifications" },
  "support": { category: "Support", description: "Support tickets and chat" },
  "extension": { category: "Chrome Extension", description: "Chrome extension APIs" },
  "recommended": { category: "Recommendations", description: "AI recommendations" },
  "user": { category: "User", description: "User profile and settings" },
};

function getMethodsFromFile(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const methods: string[] = [];
    if (content.includes("export async function GET") || content.includes("export function GET")) methods.push("GET");
    if (content.includes("export async function POST") || content.includes("export function POST")) methods.push("POST");
    if (content.includes("export async function PUT") || content.includes("export function PUT")) methods.push("PUT");
    if (content.includes("export async function PATCH") || content.includes("export function PATCH")) methods.push("PATCH");
    if (content.includes("export async function DELETE") || content.includes("export function DELETE")) methods.push("DELETE");
    return methods;
  } catch {
    return [];
  }
}

function getCategoryInfo(apiPath: string): { category: string; description: string } {
  for (const [key, value] of Object.entries(CATEGORY_MAPPINGS)) {
    if (apiPath.startsWith(`/api/${key}`)) {
      return value;
    }
  }
  return { category: "Other", description: "" };
}

function scanApiRoutes(dir: string, basePath: string = ""): ApiRoute[] {
  const routes: ApiRoute[] = [];
  
  if (!fs.existsSync(dir)) return routes;
  
  const items = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    
    if (item.isDirectory()) {
      const newBasePath = basePath + "/" + item.name;
      routes.push(...scanApiRoutes(fullPath, newBasePath));
    } else if (item.name === "route.ts") {
      const apiPath = "/api" + basePath.replace(/\[([^\]]+)\]/g, ":$1");
      const methods = getMethodsFromFile(fullPath);
      const { category, description } = getCategoryInfo(apiPath);
      const isExternal = apiPath.startsWith("/api/external");
      
      routes.push({
        path: apiPath,
        methods,
        category,
        isExternal,
        description,
      });
    }
  }
  
  return routes;
}

function generateMarkdown(routes: ApiRoute[]): string {
  const grouped = routes.reduce((acc, route) => {
    if (!acc[route.category]) acc[route.category] = [];
    acc[route.category].push(route);
    return acc;
  }, {} as Record<string, ApiRoute[]>);

  const externalRoutes = routes.filter(r => r.isExternal);
  const internalCategories = ["Admin (Internal)", "Platform Admin (Internal)", "Billing (Internal)", "Integrations (Internal)", "Cron (Internal)", "Development (Internal)", "Webhooks (Internal)"];
  
  let md = `# MOS Tools API Inventory

Generated: ${new Date().toISOString().split("T")[0]}

## Summary
- **Total Endpoints:** ${routes.length}
- **External API Endpoints:** ${externalRoutes.length}
- **Internal Endpoints:** ${routes.length - externalRoutes.length}

---

## External API (Partner Available)

These endpoints are available to partners via API keys.

| Endpoint | Methods | Description |
|----------|---------|-------------|
`;

  for (const route of externalRoutes.sort((a, b) => a.path.localeCompare(b.path))) {
    md += `| \`${route.path}\` | ${route.methods.join(", ")} | ${route.description} |\n`;
  }

  md += `\n---\n\n## Internal APIs by Category\n\n`;

  const sortedCategories = Object.keys(grouped)
    .filter(c => c !== "External API")
    .sort((a, b) => {
      const aInternal = internalCategories.includes(a);
      const bInternal = internalCategories.includes(b);
      if (aInternal && !bInternal) return 1;
      if (!aInternal && bInternal) return -1;
      return a.localeCompare(b);
    });

  for (const category of sortedCategories) {
    const categoryRoutes = grouped[category];
    if (!categoryRoutes || categoryRoutes.length === 0) continue;

    const isInternalOnly = internalCategories.includes(category);
    md += `### ${category}${isInternalOnly ? " (Not recommended for external)" : ""}\n\n`;
    md += `| Endpoint | Methods |\n`;
    md += `|----------|----------|\n`;

    for (const route of categoryRoutes.sort((a, b) => a.path.localeCompare(b.path))) {
      md += `| \`${route.path}\` | ${route.methods.join(", ")} |\n`;
    }
    md += `\n`;
  }

  md += `---\n\n## Recommended Additions to External API\n\n`;
  md += `Based on partner needs, consider adding:\n\n`;
  md += `1. **Customers API** - \`/api/customers\` - CRM integrations need customer data\n`;
  md += `2. **Jobs Search** - \`/api/jobs/search\` - Service history lookup\n`;
  md += `3. **Common Failures** - \`/api/vehicle/common-failures\` - Predictive maintenance\n`;
  md += `4. **Declined Services** - \`/api/vehicles/:vin/declined\` - Follow-up opportunities\n`;
  md += `5. **Parts Search** - \`/api/parts/search\` - Parts ordering integrations\n`;

  return md;
}

function generateJSON(routes: ApiRoute[]): object {
  return {
    generated: new Date().toISOString(),
    summary: {
      total: routes.length,
      external: routes.filter(r => r.isExternal).length,
      internal: routes.filter(r => !r.isExternal).length,
    },
    routes: routes.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

const apiDir = path.join(process.cwd(), "app/api");
const routes = scanApiRoutes(apiDir);

const markdown = generateMarkdown(routes);
const json = generateJSON(routes);

fs.writeFileSync("public/api-inventory.md", markdown);
fs.writeFileSync("public/api-inventory.json", JSON.stringify(json, null, 2));

console.log(`Generated API inventory: ${routes.length} endpoints`);
console.log("Files written:");
console.log("  - public/api-inventory.md");
console.log("  - public/api-inventory.json");
