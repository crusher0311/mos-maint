// lib/env-safe.ts
// Safe environment configuration that doesn't break builds

export const ENV = {
  MONGODB_URI: "mongodb://localhost:27017",
  MONGODB_DB: "mos-maintenance-mvp",
  SESSION_SECRET: "development-secret-that-is-at-least-32-characters-long",
  ADMIN_TOKEN: "development-admin-token",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NODE_ENV: "development",
} as const;

// Helper functions
export function isEmailConfigured(): boolean {
  return false; // Email not configured in basic build
}

export function isAIConfigured(): boolean {
  return false; // AI not configured in basic build
}

export function isAutoflowConfigured(): boolean {
  return false; // AutoFlow not configured in basic build
}

export function isCarfaxConfigured(): boolean {
  return false; // Carfax not configured in basic build
}