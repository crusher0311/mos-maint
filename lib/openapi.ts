export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'MOS Tools API',
    description: 'API for MOS Maintenance Management Platform',
    version: '1.8.0',
    contact: {
      name: 'MOS Tools Support',
      email: 'support@mostools.com',
    },
  },
  servers: [
    {
      url: '{protocol}://{host}',
      description: 'Current server',
      variables: {
        protocol: {
          enum: ['http', 'https'],
          default: 'https',
        },
        host: {
          default: 'app.mostools.com',
        },
      },
    },
  ],
  tags: [
    { name: 'Health', description: 'Health check endpoints' },
    { name: 'Auth', description: 'Authentication endpoints' },
    { name: 'Vehicles', description: 'Vehicle management' },
    { name: 'Maintenance', description: 'Maintenance recommendations' },
    { name: 'Jobs', description: 'Canned jobs and job lookup' },
    { name: 'Stickers', description: 'Oil sticker generation' },
    { name: 'Keytags', description: 'Keytag generation' },
    { name: 'Support', description: 'Support tickets' },
    { name: 'Admin', description: 'Admin operations' },
  ],
  paths: {
    '/api/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        description: 'Returns system health status including database and cache',
        operationId: 'getHealth',
        responses: {
          '200': {
            description: 'System is healthy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthCheck' },
              },
            },
          },
          '503': {
            description: 'System is unhealthy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthCheck' },
              },
            },
          },
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'User login',
        operationId: 'login',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 8 },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Login successful',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    user: { $ref: '#/components/schemas/User' },
                  },
                },
              },
            },
          },
          '401': {
            description: 'Invalid credentials',
          },
        },
      },
    },
    '/api/vehicle/{vin}': {
      get: {
        tags: ['Vehicles'],
        summary: 'Get vehicle by VIN',
        operationId: 'getVehicleByVin',
        security: [{ sessionToken: [] }],
        parameters: [
          {
            name: 'vin',
            in: 'path',
            required: true,
            schema: { type: 'string', minLength: 17, maxLength: 17 },
            description: 'Vehicle Identification Number',
          },
        ],
        responses: {
          '200': {
            description: 'Vehicle found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Vehicle' },
              },
            },
          },
          '404': {
            description: 'Vehicle not found',
          },
        },
      },
    },
    '/api/maintenance/{vin}': {
      get: {
        tags: ['Maintenance'],
        summary: 'Get maintenance recommendations',
        operationId: 'getMaintenanceByVin',
        security: [{ sessionToken: [] }],
        parameters: [
          {
            name: 'vin',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'mileage',
            in: 'query',
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': {
            description: 'Maintenance recommendations',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    recommendations: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Recommendation' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/sticker/generate': {
      post: {
        tags: ['Stickers'],
        summary: 'Generate oil change sticker',
        operationId: 'generateSticker',
        security: [{ sessionToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/StickerRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Sticker generated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/StickerResponse' },
              },
            },
          },
        },
      },
    },
    '/api/support/tickets': {
      get: {
        tags: ['Support'],
        summary: 'List support tickets',
        operationId: 'listTickets',
        security: [{ sessionToken: [] }],
        parameters: [
          {
            name: 'status',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['open', 'in_progress', 'resolved', 'closed'],
            },
          },
        ],
        responses: {
          '200': {
            description: 'List of tickets',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    tickets: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Ticket' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Support'],
        summary: 'Create support ticket',
        operationId: 'createTicket',
        security: [{ sessionToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['subject', 'message'],
                properties: {
                  subject: { type: 'string' },
                  message: { type: 'string' },
                  priority: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                    default: 'medium',
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Ticket created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Ticket' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      sessionToken: {
        type: 'apiKey',
        in: 'cookie',
        name: 'session_token',
        description: 'Session token cookie',
      },
    },
    schemas: {
      HealthCheck: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
          timestamp: { type: 'string', format: 'date-time' },
          version: { type: 'string' },
          uptime: { type: 'number' },
          checks: {
            type: 'object',
            properties: {
              mongodb: { $ref: '#/components/schemas/ComponentHealth' },
              cache: { $ref: '#/components/schemas/ComponentHealth' },
              memory: { $ref: '#/components/schemas/ComponentHealth' },
            },
          },
        },
      },
      ComponentHealth: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['up', 'down', 'degraded'] },
          latencyMs: { type: 'number' },
          details: { type: 'object' },
          error: { type: 'string' },
        },
      },
      User: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          shopId: { type: 'integer' },
          role: { type: 'string' },
        },
      },
      Vehicle: {
        type: 'object',
        properties: {
          vin: { type: 'string' },
          year: { type: 'integer' },
          make: { type: 'string' },
          model: { type: 'string' },
          mileage: { type: 'integer' },
        },
      },
      Recommendation: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          name: { type: 'string' },
          dueMileage: { type: 'integer' },
          dueMonths: { type: 'integer' },
          severity: { type: 'string', enum: ['due', 'upcoming', 'ok'] },
        },
      },
      StickerRequest: {
        type: 'object',
        required: ['vin', 'mileage', 'nextMileage'],
        properties: {
          vin: { type: 'string' },
          mileage: { type: 'integer' },
          nextMileage: { type: 'integer' },
          nextDate: { type: 'string', format: 'date' },
        },
      },
      StickerResponse: {
        type: 'object',
        properties: {
          imageUrl: { type: 'string' },
          qrCodeUrl: { type: 'string' },
        },
      },
      Ticket: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          subject: { type: 'string' },
          status: { type: 'string' },
          priority: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
};

export function getOpenApiSpec() {
  return openApiSpec;
}
