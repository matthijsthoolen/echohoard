import { PrismaClient } from "@prisma/client";
import { hasCompletedMigrations, validateReadinessConfiguration } from "../../readiness";

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
    const rows = await prisma.$queryRaw<
      Array<{ user_table: boolean; migrations_table: boolean; applied_migrations: bigint }>
    >`
      SELECT
        EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'User'
        ) AS user_table,
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
        ) AS migrations_table,
        COALESCE((
          SELECT COUNT(*) FROM "_prisma_migrations"
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ), 0) AS applied_migrations
    `;
    if (!hasCompletedMigrations(rows[0]))
      return Response.json({ status: "migrations-pending" }, { status: 503 });
    return Response.json({ status: "ready" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "not-ready" }, { status: 503 });
  } finally {
    await prisma.$disconnect();
  }
}
