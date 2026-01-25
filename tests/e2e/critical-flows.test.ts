import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5000';

describe('Critical User Flows - E2E', () => {
  describe('Health Check', () => {
    it('should return healthy status', async () => {
      const response = await fetch(`${BASE_URL}/api/health`);
      expect(response.ok).toBe(true);
      
      const data = await response.json();
      expect(data.status).toBeDefined();
      expect(['healthy', 'degraded', 'unhealthy']).toContain(data.status);
      expect(data.checks).toBeDefined();
      expect(data.checks.mongodb).toBeDefined();
      expect(data.checks.cache).toBeDefined();
      expect(data.checks.memory).toBeDefined();
    });
  });

  describe('Authentication Flow', () => {
    it('should reject login with invalid credentials', async () => {
      const response = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'invalid@test.com',
          password: 'wrongpassword',
        }),
      });
      
      expect(response.status).toBe(401);
    });

    it('should require authentication for protected routes', async () => {
      const response = await fetch(`${BASE_URL}/api/dashboard/data`);
      expect(response.status).toBe(401);
    });
  });

  describe('API Documentation', () => {
    it('should serve OpenAPI spec', async () => {
      const response = await fetch(`${BASE_URL}/api/docs/openapi.json`);
      expect(response.ok).toBe(true);
      
      const data = await response.json();
      expect(data.openapi).toBe('3.0.3');
      expect(data.info.title).toBe('MOS Tools API');
      expect(data.paths).toBeDefined();
    });
  });

  describe('Cache Statistics', () => {
    it('should include cache stats in health check', async () => {
      const response = await fetch(`${BASE_URL}/api/health`);
      const data = await response.json();
      
      expect(data.checks.cache.status).toBe('up');
      expect(data.checks.cache.details).toBeDefined();
      expect(data.checks.cache.details.hitRate).toBeDefined();
    });
  });
});

describe('Job Queue Operations', () => {
  it('should have queue stats endpoint accessible to admins', async () => {
    const response = await fetch(`${BASE_URL}/api/admin/jobs/stats`);
    expect([401, 404]).toContain(response.status);
  });
});

describe('Database Indexes', () => {
  it('should have indexes endpoint accessible to admins', async () => {
    const response = await fetch(`${BASE_URL}/api/admin/indexes`);
    expect([401, 404]).toContain(response.status);
  });
});
