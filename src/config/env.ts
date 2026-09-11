import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ECHOHOARD_ROLE: z.enum(["web", "worker"]).default("web"),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_SUBJECT: z.string().min(1).optional(),
  OIDC_ARCHIVE_ID: z.string().uuid().optional(),
  OIDC_CLIENT_SECRET_FILE: z.string().min(1).optional(),
  ECHOHOARD_DATA_DIR: z.string().min(1).default("/data"),
  ECHOHOARD_WORK_DIR: z.string().min(1).default("/work"),
  ECHOHOARD_SECRET_DIR: z.string().min(1).default("/run/echohoard/secrets"),
  ECHOHOARD_WORKER_KEY_FILE: z.string().min(1).optional(),
  ECHOHOARD_WADECRYPT_EXECUTABLE: z.string().min(1).default("wadecrypt"),
  ECHOHOARD_WORKER_OWNER: z.string().min(1).default("echohoard-worker"),
  ECHOHOARD_WORKER_POLL_MS: z.coerce.number().int().min(50).max(300_000).default(1_000),
  ECHOHOARD_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(4),
  ECHOHOARD_WORKER_LEASE_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(300_000),
  ECHOHOARD_WORKER_HEARTBEAT_MS: z.coerce.number().int().min(100).max(86_400_000).default(30_000),
  ECHOHOARD_WORKER_DECRYPT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(86_400_000)
    .default(120_000),
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
    OIDC_ISSUER: input.OIDC_ISSUER ?? input.ECHOHOARD_OIDC_ISSUER,
    OIDC_CLIENT_ID: input.OIDC_CLIENT_ID ?? input.ECHOHOARD_OIDC_CLIENT_ID,
    OIDC_REDIRECT_URI: input.OIDC_REDIRECT_URI ?? input.ECHOHOARD_OIDC_REDIRECT_URI,
    OIDC_SUBJECT: input.OIDC_SUBJECT ?? input.ECHOHOARD_OIDC_SUBJECT,
    OIDC_ARCHIVE_ID: input.OIDC_ARCHIVE_ID ?? input.ECHOHOARD_OIDC_ARCHIVE_ID,
    OIDC_CLIENT_SECRET_FILE:
      input.OIDC_CLIENT_SECRET_FILE ?? input.ECHOHOARD_OIDC_CLIENT_SECRET_FILE,
    ECHOHOARD_DATA_DIR: input.ECHOHOARD_DATA_DIR,
    ECHOHOARD_WORK_DIR: input.ECHOHOARD_WORK_DIR,
    ECHOHOARD_SECRET_DIR: input.ECHOHOARD_SECRET_DIR,
    ECHOHOARD_WORKER_KEY_FILE: input.ECHOHOARD_WORKER_KEY_FILE,
    ECHOHOARD_WADECRYPT_EXECUTABLE: input.ECHOHOARD_WADECRYPT_EXECUTABLE,
    ECHOHOARD_WORKER_OWNER: input.ECHOHOARD_WORKER_OWNER,
    ECHOHOARD_WORKER_POLL_MS: input.ECHOHOARD_WORKER_POLL_MS,
    ECHOHOARD_WORKER_BATCH_SIZE: input.ECHOHOARD_WORKER_BATCH_SIZE,
    ECHOHOARD_WORKER_LEASE_MS: input.ECHOHOARD_WORKER_LEASE_MS,
    ECHOHOARD_WORKER_HEARTBEAT_MS: input.ECHOHOARD_WORKER_HEARTBEAT_MS,
    ECHOHOARD_WORKER_DECRYPT_TIMEOUT_MS: input.ECHOHOARD_WORKER_DECRYPT_TIMEOUT_MS,
  });
}

export const env = parseEnv();
