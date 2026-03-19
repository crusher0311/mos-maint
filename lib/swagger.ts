import swaggerJsdoc from "swagger-jsdoc";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "MOS Maintenance External API",
      version: "1.0.0",
      description: `
External API for CRM and third-party integrations with the MOS Maintenance platform.

## Authentication

All API requests require authentication using an API key. You can pass the key in two ways:

- **Authorization Header**: \`Authorization: Bearer mos_your_api_key\`
- **X-API-Key Header**: \`X-API-Key: mos_your_api_key\`

API keys are generated from the Settings > API Keys page in your dashboard.

## Rate Limiting

Each API key has a configured rate limit (requests per minute). Rate limit headers are included in all responses:

- \`X-RateLimit-Limit\`: Maximum requests per minute
- \`X-RateLimit-Remaining\`: Remaining requests in current window
- \`X-RateLimit-Reset\`: When the rate limit resets (ISO 8601)

## Permissions

API keys are scoped to specific permissions:

- \`appointments:create\` - Create appointments
- \`appointments:read\` - List appointments
- \`stickers:generate\` - Generate oil stickers
- \`keytags:generate\` - Generate keytags
- \`vehicles:read\` - Get vehicle information
- \`maintenance:read\` - Get maintenance schedules
- \`recommendations:read\` - Get maintenance recommendations
- \`*\` - Full access (all permissions)

## API Key Types

**Shop Keys** (\`mos_...\`) — Scoped to a single shop. Generated from the shop dashboard under Settings > API Keys.

**Partner Keys** (\`mos_partner_...\`) — Global keys for integration partners (e.g., AppFueled). Not bound to a specific shop — the shop is resolved from the \`sms\` + \`smsShopId\` parameters passed with each request. Partner keys are issued by MOS platform administrators.
      `,
      contact: {
        name: "MOS Support",
      },
    },
    servers: [
      {
        url: "/api/external",
        description: "External API",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "API key with mos_ prefix",
        },
        apiKeyHeader: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description: "API key with mos_ prefix",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "string",
              description: "Error type",
            },
            message: {
              type: "string",
              description: "Detailed error message",
            },
          },
        },
        Appointment: {
          type: "object",
          properties: {
            id: { type: "string", description: "Appointment ID" },
            vin: { type: "string", description: "Vehicle VIN" },
            customerName: { type: "string" },
            customerPhone: { type: "string" },
            customerEmail: { type: "string" },
            scheduledDate: { type: "string", format: "date-time" },
            duration: { type: "integer", description: "Duration in minutes" },
            serviceType: { type: "string" },
            notes: { type: "string" },
            status: { type: "string", enum: ["pending", "confirmed", "completed", "cancelled"] },
          },
        },
        CreateAppointmentRequest: {
          type: "object",
          required: ["vin", "customerName", "customerPhone", "scheduledDate"],
          properties: {
            vin: { type: "string", description: "Vehicle VIN (17 characters)" },
            customerName: { type: "string" },
            customerPhone: { type: "string" },
            customerEmail: { type: "string" },
            scheduledDate: { type: "string", format: "date-time", description: "ISO 8601 date-time" },
            duration: { type: "integer", default: 60, description: "Duration in minutes" },
            serviceType: { type: "string", default: "Oil Change" },
            notes: { type: "string" },
          },
        },
        Vehicle: {
          type: "object",
          properties: {
            vin: { type: "string" },
            year: { type: "integer" },
            make: { type: "string" },
            model: { type: "string" },
            trim: { type: "string" },
            engine: { type: "string" },
            transmission: { type: "string" },
            driveType: { type: "string" },
          },
        },
        MaintenanceSchedule: {
          type: "object",
          properties: {
            vin: { type: "string" },
            services: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  intervalMiles: { type: "integer" },
                  intervalMonths: { type: "integer" },
                  description: { type: "string" },
                },
              },
            },
          },
        },
        Recommendation: {
          type: "object",
          properties: {
            id: { type: "string" },
            service: { type: "string" },
            priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
            reason: { type: "string" },
            estimatedCost: { type: "number" },
            source: { type: "string" },
          },
        },
        StickerRequest: {
          type: "object",
          required: ["vin", "currentMileage", "serviceDate"],
          properties: {
            vin: { type: "string" },
            currentMileage: { type: "integer" },
            serviceDate: { type: "string", format: "date" },
            nextServiceMiles: { type: "integer" },
            nextServiceMonths: { type: "integer" },
            oilType: { type: "string" },
          },
        },
        KeytagRequest: {
          type: "object",
          required: ["vin"],
          properties: {
            vin: { type: "string" },
            customerName: { type: "string" },
            vehicleInfo: { type: "string" },
          },
        },
        VHIItem: {
          type: "object",
          properties: {
            key: { type: "string", description: "Unique item identifier" },
            serviceKey: { type: "string", nullable: true, description: "Normalized service key (e.g., oil, brake_fluid)" },
            title: { type: "string", description: "Display name of the service" },
            category: { type: "string", nullable: true, description: "Service category (e.g., Brakes, Engine)" },
            intervalMiles: { type: "integer", nullable: true, description: "OEM interval in miles" },
            intervalMonths: { type: "integer", nullable: true, description: "OEM interval in months" },
            last: {
              type: "object",
              nullable: true,
              properties: {
                miles: { type: "integer", nullable: true },
                date: { type: "string", nullable: true },
                source: { type: "string", nullable: true, description: "Where last service was recorded (carfax, shop, protractor)" },
              },
            },
            dueAtMiles: { type: "integer", nullable: true },
            dueAtDate: { type: "string", nullable: true },
            milesToGo: { type: "integer", nullable: true, description: "Miles until due (negative = overdue)" },
            daysToGo: { type: "integer", nullable: true, description: "Days until due (negative = overdue)" },
            bump: { type: "string", nullable: true, enum: ["red", "yellow"], description: "DVI urgency flag" },
            source: { type: "string", nullable: true, description: "Data source (oem, dvi, protractor)" },
            dviSource: { type: "string", nullable: true, enum: ["autoflow", "autovitals", "tekmetric"], description: "Which DVI provider flagged this item" },
            declined: { type: "boolean", description: "Whether customer previously declined this service" },
          },
        },
        VHIResponse: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            vin: { type: "string" },
            vehicle: {
              type: "object",
              properties: {
                year: { type: "integer", nullable: true },
                make: { type: "string", nullable: true },
                model: { type: "string", nullable: true },
                engine: { type: "string", nullable: true },
              },
            },
            currentMiles: { type: "integer", nullable: true },
            distanceUnit: { type: "string", enum: ["miles", "kilometers"] },
            customerName: { type: "string", nullable: true },
            score: {
              type: "object",
              properties: {
                value: { type: "integer", description: "Health score 0-100" },
                tier: { type: "string", enum: ["Excellent", "Good", "Needs Attention", "Poor", "Critical"] },
                color: { type: "string", enum: ["green", "lime", "amber", "orange", "red"] },
              },
            },
            summary: {
              type: "object",
              properties: {
                overdue: { type: "integer" },
                dueSoon: { type: "integer" },
                upcoming: { type: "integer" },
                complimentary: { type: "integer" },
              },
            },
            buckets: {
              type: "object",
              properties: {
                overdue: { type: "array", items: { $ref: "#/components/schemas/VHIItem" } },
                dueSoon: { type: "array", items: { $ref: "#/components/schemas/VHIItem" } },
                upcoming: { type: "array", items: { $ref: "#/components/schemas/VHIItem" } },
                complimentary: { type: "array", items: { $ref: "#/components/schemas/VHIItem" } },
              },
            },
            reportUrl: { type: "string", format: "uri", description: "Shareable Vehicle Health Report URL (expires in 15 days)" },
            cachedAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
    paths: {
      "/appointments": {
        post: {
          summary: "Create Appointment",
          description: "Create a new appointment for a vehicle",
          tags: ["Appointments"],
          security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateAppointmentRequest" },
              },
            },
          },
          responses: {
            "201": {
              description: "Appointment created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      appointment: { $ref: "#/components/schemas/Appointment" },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "403": { description: "Permission denied", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "429": { description: "Rate limit exceeded", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
        get: {
          summary: "List Appointments",
          description: "List appointments with optional filters",
          tags: ["Appointments"],
          security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["pending", "confirmed", "completed", "cancelled"] } },
            { name: "from", in: "query", schema: { type: "string", format: "date" }, description: "Start date filter" },
            { name: "to", in: "query", schema: { type: "string", format: "date" }, description: "End date filter" },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: {
            "200": {
              description: "List of appointments",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      appointments: { type: "array", items: { $ref: "#/components/schemas/Appointment" } },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Permission denied" },
          },
        },
      },
      "/vehicles/{vin}": {
        get: {
          summary: "Get Vehicle Info",
          description: "Get vehicle information by VIN",
          tags: ["Vehicles"],
          security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
          parameters: [
            { name: "vin", in: "path", required: true, schema: { type: "string" }, description: "Vehicle VIN (17 characters)" },
          ],
          responses: {
            "200": {
              description: "Vehicle information",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Vehicle" },
                },
              },
            },
            "404": { description: "Vehicle not found" },
          },
        },
      },
      "/vehicles/{vin}/maintenance": {
        get: {
          summary: "Get Maintenance Schedule",
          description: "Get OEM maintenance schedule for a vehicle",
          tags: ["Vehicles"],
          security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
          parameters: [
            { name: "vin", in: "path", required: true, schema: { type: "string" } },
            { name: "mileage", in: "query", schema: { type: "integer" }, description: "Current mileage for relevant services" },
          ],
          responses: {
            "200": {
              description: "Maintenance schedule",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/MaintenanceSchedule" },
                },
              },
            },
          },
        },
      },
      "/recommendations/{vin}": {
        get: {
          summary: "Get Recommendations",
          description: "Get AI-powered maintenance recommendations for a vehicle",
          tags: ["Recommendations"],
          security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
          parameters: [
            { name: "vin", in: "path", required: true, schema: { type: "string" } },
            { name: "mileage", in: "query", schema: { type: "integer" } },
          ],
          responses: {
            "200": {
              description: "Maintenance recommendations",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      recommendations: { type: "array", items: { $ref: "#/components/schemas/Recommendation" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/stickers": {
        post: {
          summary: "Generate Sticker",
          description: "Generate an oil change sticker",
          tags: ["Stickers"],
          security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/StickerRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Sticker generated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      stickerId: { type: "string" },
                      qrCodeUrl: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/vehicles/{vin}/vhi": {
        get: {
          summary: "Get Vehicle Health Indicator",
          description: "Returns the Vehicle Health Indicator (VHI) data for a vehicle, including a 0-100 health score, vehicle details, and bucketed maintenance items (overdue, due soon, upcoming). Data is sourced from the cached maintenance plan, which is built when a vehicle is viewed in the dashboard or Chrome extension. Items include OEM maintenance schedules, DVI findings, deferred work, and service history. Partner keys must include shopId or smsShopId+sms query parameters to identify the shop.",
          tags: ["Vehicle Health"],
          security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
          parameters: [
            { name: "vin", in: "path", required: true, schema: { type: "string" }, description: "Vehicle VIN (17 characters)" },
            { name: "shopId", in: "query", required: false, schema: { type: "number" }, description: "MOS shop ID (required for partner keys)" },
            { name: "smsShopId", in: "query", required: false, schema: { type: "string" }, description: "SMS shop ID — alternative to shopId for partner keys" },
            { name: "sms", in: "query", required: false, schema: { type: "string", enum: ["tekmetric", "shopware", "protractor", "autoflow"] }, description: "SMS type — used with smsShopId for partner keys" },
          ],
          responses: {
            "200": {
              description: "VHI data with health score and maintenance buckets",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/VHIResponse" },
                },
              },
            },
            "400": { description: "Invalid VIN", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "401": { description: "Unauthorized — missing or invalid API key", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "403": { description: "Permission denied — API key lacks vehicles:read permission", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "404": { description: "No VHI data available — maintenance plan not yet built for this vehicle", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "429": { description: "Rate limit exceeded", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/vhi/analyze": {
        post: {
          summary: "Analyze Vehicle Health (On-Demand)",
          description: "Triggers a full Vehicle Health Indicator (VHI) analysis for a vehicle. Resolves the shop via SMS type and SMS shop ID, pulls mileage from the most recent work order (or uses provided mileage), invalidates any stale cache, builds a fresh maintenance plan, and returns the scored result. Ideal for post-RO-close workflows — pass the VIN and RO details after a work order posts to get an updated health assessment that reflects authorized work. Supports both shop-scoped API keys and partner API keys.",
          tags: ["Vehicle Health"],
          security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["vin", "sms", "smsShopId"],
                  properties: {
                    vin: { type: "string", description: "17-character Vehicle Identification Number", example: "1FT8W3BT0BEA08647" },
                    sms: { type: "string", enum: ["tekmetric", "shopware", "protractor", "autoflow"], description: "Shop management system name" },
                    smsShopId: { type: "string", description: "Shop ID within the SMS platform", example: "12345" },
                    roNumber: { type: "string", description: "Repair order number (optional — used to locate mileage from a specific RO)", example: "WO-9876" },
                    mileage: { type: "number", description: "Override mileage (optional — auto-resolved from the RO if not provided)", example: 105388 },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "VHI analysis result with health score and maintenance buckets",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      vin: { type: "string" },
                      shopId: { type: "number" },
                      sms: { type: "string" },
                      roNumber: { type: "string", nullable: true },
                      vehicle: {
                        type: "object",
                        properties: {
                          year: { type: "number", nullable: true },
                          make: { type: "string", nullable: true },
                          model: { type: "string", nullable: true },
                          engine: { type: "string", nullable: true },
                        },
                      },
                      currentMiles: { type: "number", nullable: true },
                      distanceUnit: { type: "string" },
                      customerName: { type: "string", nullable: true },
                      score: {
                        type: "object",
                        properties: {
                          value: { type: "number", minimum: 0, maximum: 100 },
                          tier: { type: "string", enum: ["Excellent", "Good", "Needs Attention", "Poor", "Critical"] },
                          color: { type: "string" },
                        },
                      },
                      summary: {
                        type: "object",
                        properties: {
                          overdue: { type: "number" },
                          dueSoon: { type: "number" },
                          upcoming: { type: "number" },
                          complimentary: { type: "number" },
                        },
                      },
                      buckets: {
                        type: "object",
                        properties: {
                          overdue: { type: "array", items: { $ref: "#/components/schemas/VHIItem" } },
                          dueSoon: { type: "array", items: { $ref: "#/components/schemas/VHIItem" } },
                          upcoming: { type: "array", items: { $ref: "#/components/schemas/VHIItem" } },
                          complimentary: { type: "array", items: { $ref: "#/components/schemas/VHIItem" } },
                        },
                      },
                      reportUrl: { type: "string", format: "uri", description: "Shareable Vehicle Health Report URL (expires in 15 days)" },
                      analyzedAt: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid request — missing VIN, SMS, or mileage could not be resolved", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "401": { description: "Unauthorized — missing or invalid API key", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "403": { description: "Permission denied — API key not authorized for this shop", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "404": { description: "Shop not found for the given SMS and SMS shop ID", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "429": { description: "Rate limit exceeded", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/shops": {
        get: {
          summary: "List Shops",
          description: "Returns a list of shops accessible to the API key. For shop-scoped keys, returns only the key's shop. For partner keys, returns all active shops on the platform with pagination, search, and SMS provider filtering. Each shop includes its MOS shop ID, name, integration provider, and relevant SMS IDs for use in other API calls.",
          tags: ["Shops"],
          security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
          parameters: [
            { name: "page", in: "query", required: false, schema: { type: "integer", default: 1 }, description: "Page number (default: 1)" },
            { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50, maximum: 100 }, description: "Results per page (default: 50, max: 100)" },
            { name: "search", in: "query", required: false, schema: { type: "string" }, description: "Search by shop name or location identifier" },
            { name: "sms", in: "query", required: false, schema: { type: "string", enum: ["tekmetric", "shopware", "protractor", "autoflow"] }, description: "Filter by integration provider" },
          ],
          responses: {
            "200": {
              description: "List of shops",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      shops: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            shopId: { type: "number", description: "MOS shop ID — use this as the shopId parameter in other API calls" },
                            name: { type: "string", nullable: true },
                            status: { type: "string" },
                            integrationProvider: { type: "string", nullable: true, description: "Active SMS integration (tekmetric, shopware, protractor, autoflow)" },
                            locationIdentifier: { type: "string", nullable: true },
                            smsIds: {
                              type: "object",
                              description: "SMS-specific IDs for the shop's integration provider",
                              properties: {
                                tekmetricShopId: { type: "number" },
                                shopwareShopId: { type: "number" },
                                shopwareTenantId: { type: "number" },
                                protractorConnectionId: { type: "string" },
                                autoflowDomain: { type: "string" },
                              },
                            },
                          },
                        },
                      },
                      total: { type: "integer" },
                      page: { type: "integer" },
                      limit: { type: "integer" },
                      totalPages: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "403": { description: "Permission denied — API key lacks shops:read permission", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "429": { description: "Rate limit exceeded", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/keytags": {
        post: {
          summary: "Generate Keytag",
          description: "Generate a keytag for a vehicle",
          tags: ["Keytags"],
          security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/KeytagRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Keytag generated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      keytagId: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  apis: [],
};

export const swaggerSpec = swaggerJsdoc(options);
