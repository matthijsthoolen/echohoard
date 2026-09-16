import { PrismaClient } from "@prisma/client";
import {
  getMigrationReadinessFailure,
  loadShippedMigrationNames,
  validateReadinessConfiguration,
  type MigrationRecord,
} from "../../readiness";

export const dynamic = "force-dynamic";

/**
 * Deployment-neutral readiness probe. It is intentionally separate from the
 * public process health endpoint: readiness requires complete runtime
 * configuration, a reachable database, and recorded migrations.
 */
export async function GET(): Promise<Response> {
  const configuration = await validateReadinessConfiguration(process.env);
  if (configuration.ok === false)
    return Response.json({ status: "not-ready", reason: configuration.reason }, { status: 503 });
  const databaseUrl = process.env.DATABASE_URL;
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const shippedMigrations = await loadShippedMigrationNames();
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
    if (!tables[0]?.migrations_table)
      return Response.json({ status: "migrations-pending" }, { status: 503 });
    const migrations = await prisma.$queryRaw<MigrationRecord[]>`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      ORDER BY started_at, migration_name
    `;
    const failure = getMigrationReadinessFailure(
      { ...tables[0], applied_migrations: migrations.length, migrations },
      shippedMigrations,
    );
    if (failure) return Response.json({ status: failure }, { status: 503 });
    return Response.json({ status: "ready" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "not-ready" }, { status: 503 });
  } finally {
    await prisma.$disconnect();
  }
}
