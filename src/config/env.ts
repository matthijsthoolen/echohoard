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

export type EchohoardEnv = z.infer<typeof schema>;

/**
 * Parse only the environment variables owned by EchoHoard.
 *
 * Keeping this as a function makes the composition root explicit and lets
 * tests exercise production-like configuration without mutating process.env.
 * Unknown process variables are deliberately not forwarded to the schema.
 */
export function parseEnv(input: NodeJS.ProcessEnv = process.env): EchohoardEnv {
  return schema.parse({
    NODE_ENV: input.NODE_ENV,
    ECHOHOARD_ROLE: input.ECHOHOARD_ROLE,
    OIDC_ISSUER: input.OIDC_ISSUER,
    OIDC_CLIENT_ID: input.OIDC_CLIENT_ID,
    OIDC_REDIRECT_URI: input.OIDC_REDIRECT_URI,
    OIDC_SUBJECT: input.OIDC_SUBJECT,
    OIDC_CLIENT_SECRET_FILE: input.OIDC_CLIENT_SECRET_FILE,
  });
}

export const env = parseEnv();
