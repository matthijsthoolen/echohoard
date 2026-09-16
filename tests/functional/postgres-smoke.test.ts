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
      SELECT migration_name, started_at, finished_at, rolled_back_at
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
              started_at: new Date(),
              finished_at: new Date(),
              rolled_back_at: null,
            },
          ],
        },
        shipped,
      ),
    ).toBe("migrations-unknown");
  });

  it("accepts a later completed Prisma attempt after rollback", async () => {
    const shipped = await loadShippedMigrationNames();
    const migrationName = shipped[0];
    if (migrationName === undefined) throw new Error("expected a shipped migration");
    const rollbackId = crypto.randomUUID();
    const successId = crypto.randomUUID();
    const firstStarted = new Date("2099-01-01T00:00:00.000Z");
    const secondStarted = new Date("2099-01-01T00:02:00.000Z");
    try {
      await prisma.$executeRaw`
        INSERT INTO "_prisma_migrations"
          (id, checksum, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
        VALUES
          (${rollbackId}, ${"synthetic-checksum-rollback"}, ${migrationName}, ${"synthetic rollback"}, ${new Date("2099-01-01T00:01:00.000Z")}, ${firstStarted}, ${0})
      `;
      await prisma.$executeRaw`
        INSERT INTO "_prisma_migrations"
          (id, checksum, migration_name, finished_at, started_at, applied_steps_count)
        VALUES
          (${successId}, ${"synthetic-checksum-success"}, ${migrationName}, ${new Date("2099-01-01T00:03:00.000Z")}, ${secondStarted}, ${1})
      `;
      const rows = await prisma.$queryRaw<MigrationRecord[]>`
        SELECT migration_name, started_at, finished_at, rolled_back_at
        FROM "_prisma_migrations"
        ORDER BY started_at, migration_name
      `;
      const tables = { user_table: true, migrations_table: true };
      expect(
        getMigrationReadinessFailure(
          { ...tables, applied_migrations: rows.length, migrations: rows },
          shipped,
        ),
      ).toBeUndefined();
    } finally {
      await prisma.$executeRaw`DELETE FROM "_prisma_migrations" WHERE id IN (${rollbackId}, ${successId})`;
    }
  });

  it("rejects the latest unresolved Prisma attempt after a completed attempt", async () => {
    const shipped = await loadShippedMigrationNames();
    const migrationName = shipped[0];
    if (migrationName === undefined) throw new Error("expected a shipped migration");
    const successId = crypto.randomUUID();
    const failedId = crypto.randomUUID();
    try {
      await prisma.$executeRaw`
        INSERT INTO "_prisma_migrations"
          (id, checksum, migration_name, finished_at, started_at, applied_steps_count)
        VALUES
          (${successId}, ${"synthetic-checksum-success"}, ${migrationName}, ${new Date("2099-01-01T00:01:00.000Z")}, ${new Date("2099-01-01T00:00:00.000Z")}, ${1})
      `;
      await prisma.$executeRaw`
        INSERT INTO "_prisma_migrations"
          (id, checksum, migration_name, logs, started_at, applied_steps_count)
        VALUES
          (${failedId}, ${"synthetic-checksum-failed"}, ${migrationName}, ${"synthetic failure"}, ${new Date("2099-01-01T00:02:00.000Z")}, ${0})
      `;
      const rows = await prisma.$queryRaw<MigrationRecord[]>`
        SELECT migration_name, started_at, finished_at, rolled_back_at
        FROM "_prisma_migrations"
        ORDER BY started_at, migration_name
      `;
      expect(
        getMigrationReadinessFailure(
          {
            user_table: true,
            migrations_table: true,
            applied_migrations: rows.length,
            migrations: rows,
          },
          shipped,
        ),
      ).toBe("migrations-failed");
    } finally {
      await prisma.$executeRaw`DELETE FROM "_prisma_migrations" WHERE id IN (${successId}, ${failedId})`;
    }
  });
});
