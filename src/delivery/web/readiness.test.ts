import { describe, expect, it } from "vitest";
import {
  getMigrationReadinessFailure,
  hasCompletedMigrations,
  validateReadinessConfiguration,
  type ReadinessConfiguration,
} from "./readiness";

const configuration: ReadinessConfiguration = {
  DATABASE_URL: "postgresql://database.invalid/echohoard",
  OIDC_ISSUER: "https://auth.example.invalid/",
  OIDC_CLIENT_ID: "synthetic-client",
  OIDC_REDIRECT_URI: "https://echohoard.example.invalid/auth/callback",
  OIDC_CLIENT_SECRET_FILE: "/run/secrets/oidc",
  OIDC_ARCHIVE_ID: "00000000-0000-0000-0000-000000000000",
  ECHOHOARD_MCP_CREDENTIAL_FILE: "/run/secrets/mcp",
  ECHOHOARD_MCP_USER_ID: "synthetic-user",
  ECHOHOARD_MCP_SUBJECT: "synthetic-subject",
  ECHOHOARD_MCP_ISSUER: "https://auth.example.invalid/",
  ECHOHOARD_WACLI_WEBHOOK_SECRET_FILE: "/run/secrets/wacli",
};

describe("web readiness configuration", () => {
  it.each([
    ["OIDC_ISSUER", { OIDC_ISSUER: undefined }],
    ["OIDC_CLIENT_ID", { OIDC_CLIENT_ID: undefined }],
    ["OIDC_REDIRECT_URI", { OIDC_REDIRECT_URI: undefined }],
    ["OIDC_CLIENT_SECRET_FILE", { OIDC_CLIENT_SECRET_FILE: undefined }],
    ["DATABASE_URL", { DATABASE_URL: undefined }],
  ])("rejects missing %s", async (_, missing) => {
    const result = await validateReadinessConfiguration(
      { ...configuration, ...missing },
      async () => "synthetic-secret",
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an empty secret without exposing its contents", async () => {
    const result = await validateReadinessConfiguration(configuration, async () => "   ");
    expect(result).toEqual({ ok: false, reason: "oidc-client-secret-empty" });
  });

  it("accepts complete nonsecret configuration and readable secret files", async () => {
    const result = await validateReadinessConfiguration(
      configuration,
      async () => "synthetic-secret",
    );
    expect(result).toEqual({ ok: true });
  });

  it.each([
    ["missing User table", { user_table: false, migrations_table: true, applied_migrations: 3n }],
    [
      "missing migration table",
      { user_table: true, migrations_table: false, applied_migrations: 3n },
    ],
    ["no applied migrations", { user_table: true, migrations_table: true, applied_migrations: 0n }],
  ])("rejects incomplete migrations (%s)", (_, status) => {
    expect(hasCompletedMigrations(status)).toBe(false);
  });

  it("accepts a migrated database", () => {
    expect(
      hasCompletedMigrations({ user_table: true, migrations_table: true, applied_migrations: 3n }),
    ).toBe(true);
  });

  it.each([
    [
      "latest migration is pending",
      [{ migration_name: "001", finished_at: new Date(), rolled_back_at: null }],
      ["001", "002"],
      "migrations-pending",
    ],
    [
      "migration failed",
      [{ migration_name: "001", finished_at: null, rolled_back_at: null }],
      ["001"],
      "migrations-failed",
    ],
    [
      "database has an unknown migration",
      [
        { migration_name: "001", finished_at: new Date(), rolled_back_at: null },
        { migration_name: "foreign", finished_at: new Date(), rolled_back_at: null },
      ],
      ["001"],
      "migrations-unknown",
    ],
  ])("rejects %s", (_, migrations, shipped, reason) => {
    expect(
      getMigrationReadinessFailure(
        {
          user_table: true,
          migrations_table: true,
          applied_migrations: migrations.length,
          migrations,
        },
        shipped,
      ),
    ).toBe(reason);
  });

  it("requires every shipped migration, not merely a positive count", () => {
    expect(
      hasCompletedMigrations(
        {
          user_table: true,
          migrations_table: true,
          applied_migrations: 1n,
          migrations: [{ migration_name: "001", finished_at: new Date(), rolled_back_at: null }],
        },
        ["001", "002"],
      ),
    ).toBe(false);
  });
});
