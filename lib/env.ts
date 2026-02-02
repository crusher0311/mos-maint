// lib/env.ts
import { z } from "zod";

const envSchema = z.object({
  // Database
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  MONGODB_DB: z.string().default("mos-maintenance-mvp"),
  
  // Authentication
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  
  // Email (optional for development)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().transform(Number).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  FROM_EMAIL: z.string().email().optional(),
  
  // Admin
  ADMIN_TOKEN: z.string().min(1, "ADMIN_TOKEN is required"),
  
  // External APIs
  OPENAI_API_KEY: z.string().optional(),
  
  // AutoFlow (optional)
  AUTOFLOW_BASE_URL: z.string().url().optional(),
  AUTOFLOW_API_KEY: z.string().optional(),
  AUTOFLOW_API_PASSWORD: z.string().optional(),
  
  // Carfax (optional)
  CARFAX_API_KEY: z.string().optional(),
  CARFAX_BASE_URL: z.string().url().optional(),
  
  // App config
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  
  // DataOne (optional)
  DATAONE_SFTP_HOST: z.string().optional(),
  DATAONE_SFTP_PORT: z.string().optional(),
  DATAONE_SFTP_USER: z.string().optional(),
  DATAONE_SFTP_PASS: z.string().optional(),
});

type Env = z.infer<typeof envSchema>;

let env: Env;

export function validateEnv(): Env {
  if (env) return env;
  
  // Provide safe defaults for build time and development
  const defaultEnv: Env = {
    MONGODB_URI: "mongodb://localhost:27017",
    MONGODB_DB: "mos-maintenance-mvp",
    SESSION_SECRET: "development-secret-that-is-at-least-32-characters-long",
    ADMIN_TOKEN: "development-admin-token",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NODE_ENV: "development",
  };
  
  // In production environments, try to validate properly
  if (typeof window === 'undefined' && typeof global !== 'undefined') {
    try {
      const processEnv = (global as any).process?.env || {};
      if (processEnv.NODE_ENV === 'production' || Object.keys(processEnv).length > 10) {
        env = envSchema.parse(processEnv);
        return env;
      }
    } catch (error) {
      console.warn("⚠️ Environment validation failed, using defaults");
    }
  }
  
  env = defaultEnv;
  return env;
}

// Safe environment export
export const ENV = validateEnv();

// Helper to check if email is configured
export function isEmailConfigured(): boolean {
  return !!(ENV.SMTP_HOST && ENV.SMTP_USER && ENV.SMTP_PASS && ENV.FROM_EMAIL);
}

// Helper to check if AI features are available
export function isAIConfigured(): boolean {
  return !!ENV.OPENAI_API_KEY;
}

// Helper to check if AutoFlow is configured
export function isAutoflowConfigured(): boolean {
  return !!(ENV.AUTOFLOW_BASE_URL && ENV.AUTOFLOW_API_KEY && ENV.AUTOFLOW_API_PASSWORD);
}

// Helper to check if Carfax is configured
export function isCarfaxConfigured(): boolean {
  return !!(ENV.CARFAX_API_KEY && ENV.CARFAX_BASE_URL);
}