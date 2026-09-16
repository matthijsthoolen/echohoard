import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getMigrationReadinessFailure,
  loadShippedMigrationNames,
  type MigrationRecord,
} from "../../src/delivery/web/readiness";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
}

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

describe("PostgreSQL migration smoke", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("connects to the migrated database and cleans up its client", async () => {
    await expect(prisma.$queryRaw<[{ result: number }]>`SELECT 1 AS result`).resolves.toEqual([
      { result: 1 },
    ]);
    await expect(prisma.$queryRaw<[{ table_name: string }]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
    `).resolves.toEqual([{ table_name: "_prisma_migrations" }]);
  });

  it("does not confuse a positive migration count with the current schema", async () => {
    const tables = await prisma.$queryRaw<
      Array<{ user_table: boolean; migrations_table: boolean }>
    >`
      SELECT
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'User'
        ) AS user_table,
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
        ) AS migrations_table
    `;
    const migrations = await prisma.$queryRaw<MigrationRecord[]>`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      ORDER BY started_at, migration_name
    `;
    const shipped = await loadShippedMigrationNames();
    const status = { ...tables[0], applied_migrations: migrations.length, migrations };
    expect(getMigrationReadinessFailure(status, shipped)).toBeUndefined();

    const latestPending = [...shipped, "synthetic-latest"];
    expect(getMigrationReadinessFailure(status, latestPending)).toBe("migrations-pending");
    expect(
      getMigrationReadinessFailure(
        {
          ...status,
          migrations: migrations.map((migration, index) =>
            index === 0 ? { ...migration, finished_at: null } : migration,
          ),
        },
        shipped,
      ),
    ).toBe("migrations-failed");
    expect(
      getMigrationReadinessFailure(
        {
          ...status,
          migrations: [
            ...migrations,
            {
              migration_name: "synthetic-unknown",
              finished_at: new Date(),
              rolled_back_at: null,
            },
          ],
        },
        shipped,
      ),
    ).toBe("migrations-unknown");
  });
});
