import { readFile } from "node:fs/promises";

export interface ReadinessConfiguration {
  readonly [name: string]: string | undefined;
  readonly OIDC_ISSUER?: string;
  readonly OIDC_CLIENT_ID?: string;
  readonly OIDC_REDIRECT_URI?: string;
  readonly OIDC_CLIENT_SECRET_FILE?: string;
  readonly OIDC_ARCHIVE_ID?: string;
  readonly DATABASE_URL?: string;
  readonly ECHOHOARD_MCP_CREDENTIAL_FILE?: string;
  readonly ECHOHOARD_MCP_USER_ID?: string;
  readonly ECHOHOARD_MCP_SUBJECT?: string;
  readonly ECHOHOARD_MCP_ISSUER?: string;
  readonly ECHOHOARD_WACLI_WEBHOOK_SECRET_FILE?: string;
}

export type ReadinessConfigurationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface MigrationReadiness {
  readonly user_table: boolean;
  readonly migrations_table: boolean;
  readonly applied_migrations: number | bigint;
}

export function hasCompletedMigrations(status: MigrationReadiness | undefined): boolean {
  return (
    status?.user_table === true &&
    status.migrations_table === true &&
    Number(status.applied_migrations) > 0
  );
}

export async function validateReadinessConfiguration(
  configuration: ReadinessConfiguration,
  secretReader: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<ReadinessConfigurationResult> {
  if (!configuration.DATABASE_URL) return { ok: false, reason: "database-not-configured" };

  const requiredUrls: ReadonlyArray<readonly [string, string | undefined]> = [
    ["oidc-issuer", configuration.OIDC_ISSUER],
    ["oidc-redirect-uri", configuration.OIDC_REDIRECT_URI],
    ["mcp-issuer", configuration.ECHOHOARD_MCP_ISSUER],
  ];
  for (const [name, value] of requiredUrls) {
    if (!value) return { ok: false, reason: `${name}-not-configured` };
    try {
      new URL(value);
    } catch {
      return { ok: false, reason: `${name}-invalid` };
    }
  }

  const requiredValues: ReadonlyArray<readonly [string, string | undefined]> = [
    ["oidc-client-id", configuration.OIDC_CLIENT_ID],
    ["oidc-archive", configuration.OIDC_ARCHIVE_ID],
    ["mcp-user", configuration.ECHOHOARD_MCP_USER_ID],
    ["mcp-subject", configuration.ECHOHOARD_MCP_SUBJECT],
  ];
  for (const [name, value] of requiredValues) {
    if (!value) return { ok: false, reason: `${name}-not-configured` };
  }

  const requiredFiles: ReadonlyArray<readonly [string, string | undefined]> = [
    ["oidc-client-secret", configuration.OIDC_CLIENT_SECRET_FILE],
    ["mcp-credential", configuration.ECHOHOARD_MCP_CREDENTIAL_FILE],
    ["wacli-webhook-secret", configuration.ECHOHOARD_WACLI_WEBHOOK_SECRET_FILE],
  ];
  for (const [name, path] of requiredFiles) {
    if (!path) return { ok: false, reason: `${name}-not-configured` };
    try {
      if (!(await secretReader(path)).trim()) return { ok: false, reason: `${name}-empty` };
    } catch {
      return { ok: false, reason: `${name}-unreadable` };
    }
  }

  return { ok: true };
}
