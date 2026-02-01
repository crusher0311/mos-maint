export const ENV = {
  DATABASE_URL: process.env.DATABASE_URL || "postgresql://localhost:5432/mos",
  SESSION_SECRET: "development-secret-that-is-at-least-32-characters-long",
  ADMIN_TOKEN: "development-admin-token",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NODE_ENV: "development",
} as const;

export function isEmailConfigured(): boolean {
  return false;
}

export function isAIConfigured(): boolean {
  return false;
}

export function isAutoflowConfigured(): boolean {
  return false;
}

export function isCarfaxConfigured(): boolean {
  return false;
}
