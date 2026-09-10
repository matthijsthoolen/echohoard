import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ECHOHOARD_ROLE: z.enum(["web", "worker"]).default("web"),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_SUBJECT: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET_FILE: z.string().min(1).optional(),
});
export const env = schema.parse({
  NODE_ENV: process.env.NODE_ENV,
  ECHOHOARD_ROLE: process.env.ECHOHOARD_ROLE,
});
