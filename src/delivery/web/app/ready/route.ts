import { PrismaClient } from "@prisma/client";

/**
 * Deployment-neutral readiness probe. It is intentionally separate from the
 * public process health endpoint: readiness requires a configured database and
 * the first application table, which means migrations have completed.
 */
export async function GET(): Promise<Response> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return Response.json({ status: "not-ready" }, { status: 503 });
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'User'
      ) AS exists
    `;
    if (rows[0]?.exists !== true)
      return Response.json({ status: "migrations-pending" }, { status: 503 });
    return Response.json({ status: "ready" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "not-ready" }, { status: 503 });
  } finally {
    await prisma.$disconnect();
  }
}
