import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().transform(Number).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  FROM_EMAIL: z.string().email().optional(),
  
  ADMIN_TOKEN: z.string().min(1, "ADMIN_TOKEN is required"),
  
  OPENAI_API_KEY: z.string().optional(),
  
  AUTOFLOW_BASE_URL: z.string().url().optional(),
  AUTOFLOW_API_KEY: z.string().optional(),
  AUTOFLOW_API_PASSWORD: z.string().optional(),
  
  CARFAX_API_KEY: z.string().optional(),
  CARFAX_BASE_URL: z.string().url().optional(),
  
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  
  DATAONE_SFTP_HOST: z.string().optional(),
  DATAONE_SFTP_PORT: z.string().optional(),
  DATAONE_SFTP_USER: z.string().optional(),
  DATAONE_SFTP_PASS: z.string().optional(),
});

type Env = z.infer<typeof envSchema>;

let env: Env;

export function validateEnv(): Env {
  if (env) return env;
  
  const defaultEnv: Env = {
    DATABASE_URL: process.env.DATABASE_URL || "postgresql://localhost:5432/mos",
    SESSION_SECRET: "development-secret-that-is-at-least-32-characters-long",
    ADMIN_TOKEN: "development-admin-token",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NODE_ENV: "development",
  };
  
  if (typeof window === 'undefined' && typeof global !== 'undefined') {
    try {
      const processEnv = (global as any).process?.env || {};
      if (processEnv.NODE_ENV === 'production' || Object.keys(processEnv).length > 10) {
        env = envSchema.parse(processEnv);
        return env;
      }
    } catch (error) {
      console.warn("Environment validation failed, using defaults");
    }
  }
  
  env = defaultEnv;
  return env;
}

export const ENV = validateEnv();

export function isEmailConfigured(): boolean {
  return !!(ENV.SMTP_HOST && ENV.SMTP_USER && ENV.SMTP_PASS && ENV.FROM_EMAIL);
}

export function isAIConfigured(): boolean {
  return !!ENV.OPENAI_API_KEY;
}

export function isAutoflowConfigured(): boolean {
  return !!(ENV.AUTOFLOW_BASE_URL && ENV.AUTOFLOW_API_KEY && ENV.AUTOFLOW_API_PASSWORD);
}

export function isCarfaxConfigured(): boolean {
  return !!(ENV.CARFAX_API_KEY && ENV.CARFAX_BASE_URL);
}
